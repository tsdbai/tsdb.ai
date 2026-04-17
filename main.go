package main

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"io/ioutil"
	"math"
	"math/rand"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"
	"runtime"
)

// =============================================================================
// Core Data Structures
// =============================================================================
// NOTE: IndexUpdate and CompressedChunk are defined in model_compressor.go

type MetricSample struct {
	MetricString string  `json:"metric_string"`
	Value        float64 `json:"value"`
	Timestamp    float64 `json:"timestamp"`
}

type ChunkBuffer struct {
	Timestamps []float64 `json:"timestamps"`
	Values     []float64 `json:"values"`
}

type ModelEntry struct {
	Params  []float64         `json:"params"`
	ModelID int               `json:"model_id"`
	TBase   float64           `json:"t_base"`
	Labels  map[string]string `json:"labels"`
}

type QueryResultEntry struct {
	Metric map[string]string `json:"metric"`
	Values [][]interface{}   `json:"values"`
}

type HeadQueryResponse struct {
	Models    []ModelEntry       `json:"models"`
	RawSeries []QueryResultEntry `json:"raw_series"`
}

type MetricHistory struct {
	Rmses    []float64 `json:"rmses"`
	ModelIDs []int     `json:"model_ids"`
}

// =============================================================================
// Feature: Integer Symbol Table
// Maps every metric string to a compact uint32 ID.
// =============================================================================

type SymbolTable struct {
	mu         sync.RWMutex
	stringToID map[string]uint32
	idToString map[uint32]string
	nextID     uint32
}

func (st *SymbolTable) GetOrCreate(s string) uint32 {
	st.mu.RLock()
	if id, ok := st.stringToID[s]; ok {
		st.mu.RUnlock()
		return id
	}
	st.mu.RUnlock()
	st.mu.Lock()
	defer st.mu.Unlock()
	if id, ok := st.stringToID[s]; ok {
		return id
	}
	id := st.nextID
	st.nextID++
	st.stringToID[s] = id
	st.idToString[id] = s
	return id
}

func (st *SymbolTable) Lookup(id uint32) string {
	st.mu.RLock()
	defer st.mu.RUnlock()
	return st.idToString[id]
}

var globalSymbols = &SymbolTable{
	stringToID: make(map[string]uint32),
	idToString: make(map[uint32]string),
}

// =============================================================================
// Feature: Inverted Label Index
// Secondary index: labelKey → labelValue → []seriesID for O(k) HEAD queries.
// =============================================================================

type InvertedIndex struct {
	mu    sync.RWMutex
	index map[string]map[string][]uint32
}

func (idx *InvertedIndex) Add(labels map[string]string, seriesID uint32) {
	idx.mu.Lock()
	defer idx.mu.Unlock()
	for k, v := range labels {
		if idx.index[k] == nil {
			idx.index[k] = make(map[string][]uint32)
		}
		for _, existing := range idx.index[k][v] {
			if existing == seriesID {
				return // already registered
			}
		}
		idx.index[k][v] = append(idx.index[k][v], seriesID)
	}
}

func (idx *InvertedIndex) MatchName(prefix string) []uint32 {
	idx.mu.RLock()
	defer idx.mu.RUnlock()
	nameMap, ok := idx.index["__name__"]
	if !ok {
		return nil
	}
	seen := make(map[uint32]bool)
	var results []uint32
	for name, ids := range nameMap {
		if strings.Contains(name, prefix) {
			for _, id := range ids {
				if !seen[id] {
					seen[id] = true
					results = append(results, id)
				}
			}
		}
	}
	return results
}

func (idx *InvertedIndex) Rebuild(headCache map[uint32]ModelEntry) {
	idx.mu.Lock()
	defer idx.mu.Unlock()
	idx.index = make(map[string]map[string][]uint32)
	for sid, entry := range headCache {
		for k, v := range entry.Labels {
			if idx.index[k] == nil {
				idx.index[k] = make(map[string][]uint32)
			}
			idx.index[k][v] = append(idx.index[k][v], sid)
		}
	}
}

var headIndex = &InvertedIndex{
	index: make(map[string]map[string][]uint32),
}

// =============================================================================
// Feature: Lock Sharding
//
// IngestionState is split into 256 independent shards, each with its own maps
// and RWMutex.  A series always lands on shard = seriesID % 256.  Concurrent
// ingestion goroutines working on different series hit different shards and
// almost never contend.  Global counters are updated atomically.
// =============================================================================

// SeasonalHistory stores per-time-slot RMSE history for a single series.
// Index = (weekday * 24) + hour_of_day  →  0..167
type SeasonalHistory [seasonalSlots]MetricHistory

type Shard struct {
	mu             sync.RWMutex
	Buffers        map[uint32]*ChunkBuffer  // seriesID -> in-flight samples
	LastValueCache map[uint32]float64       // seriesID -> last raw value (counters)
	HeadCache      map[uint32]ModelEntry    // seriesID -> latest compressed model
	AnomalyHistory map[uint32]MetricHistory // seriesID -> global rolling RMSE history (kept for compatibility)
	AdaptiveSizes  map[uint32]int           // seriesID -> current buffer threshold
	// Phase 1: rolling mean RMSE per series — used by forecasting confidence bands
	RollingRMSE    map[uint32]float64       // seriesID -> EMA of RMSE
	// Phase 2: seasonal anomaly — 168 per-slot RMSE histories
	SeasonalHistory  map[uint32]*SeasonalHistory // seriesID -> [168]MetricHistory
	// Phase 2: change point — ring buffer of last N model IDs
	RegimeHistory    map[uint32][]int            // seriesID -> []modelID (capped at Cfg.Anomaly.RegimeHistoryLen)
	// Phase 2: per-series auto-tuned RMSE tolerance
	SeriesRmseTolerance map[uint32]float64        // seriesID -> current tolerance (default: Cfg.Ingestion.RmseTolerance)
}

type IngestionState struct {
	Shards [numShards]Shard

	// Global counters — updated with sync/atomic for zero-contention reads/writes
	TotalSamples         int64
	TotalChunksModeled   int64
	TotalIndexEntries    int64
	TotalShippedBytes    int64
	TotalCanonicalBytes  int64
	HeadCacheMemoryBytes int64
	SymbolMetadataBytes  int64

	// Non-atomic stats protected by StatsMu
	StatsMu              sync.Mutex
	TotalRMSEAccumulated float64
	LastCompactionLatency time.Duration

	IndexQueue chan IndexUpdate
	IndexDB    interface{}
}

func (s *IngestionState) GetShard(sid uint32) *Shard {
	return &s.Shards[sid%uint32(Cfg.Ingestion.NumShards)]
}

var state = &IngestionState{
	IndexQueue: make(chan IndexUpdate, 10000),
}

// =============================================================================
// Feature: Bounded Compression Worker Pool
//
// Limits concurrent AdaptiveFit goroutines to max(4, NumCPU).  Prevents
// scheduler thrash when hundreds of series hit their buffer threshold
// simultaneously.
// =============================================================================

var compressionSem chan struct{}

// =============================================================================
// Feature: Batch WAL Writer + Binary WAL Format
//
// writeChunkToDisk now pushes onto walWriteQueue (non-blocking).
// A background goroutine batches chunks and writes compact binary .bin files
// — roughly 5x smaller than JSON and ~10x faster to serialise.
//
// Binary batch file layout:
//   [4]  magic  (uint32 LE) = 0x54534442
//   [4]  count  (uint32 LE)
//   per chunk:
//     [4]    metric string length (uint32 LE)
//     [N]    metric string bytes
//     [1]    model ID (uint8)
//     [8]    t_base  (float64 LE)
//     [8×3]  params  (3 × float64 LE)
// =============================================================================

var walWriteQueue = make(chan CompressedChunk, 50000)

// Checkpoint schema (unchanged from v2; sharding is purely in-memory)
type CheckpointStruct struct {
	Version              int                      `json:"version"`
	SymbolStringToID     map[string]uint32        `json:"symbol_str_to_id,omitempty"`
	SymbolNextID         uint32                   `json:"symbol_next_id,omitempty"`
	Buffers              map[uint32]*ChunkBuffer  `json:"buffers"`
	LastValueCache       map[uint32]float64       `json:"last_value_cache"`
	HeadCache            map[uint32]ModelEntry    `json:"head_cache"`
	AnomalyHistory       map[uint32]MetricHistory `json:"anomaly_history"`
	TotalSamples         int64                    `json:"total_samples"`
	TotalChunksModeled   int64                    `json:"total_chunks_modeled"`
	TotalIndexEntries    int64                    `json:"total_index_entries"`
	TotalRMSEAccumulated float64                  `json:"total_rmse_accumulated"`
}

// init runs before main: initialise all shard maps and the compression semaphore.
func init() {
	for i := 0; i < Cfg.Ingestion.NumShards; i++ {
		state.Shards[i] = Shard{
			Buffers:             make(map[uint32]*ChunkBuffer),
			LastValueCache:      make(map[uint32]float64),
			HeadCache:           make(map[uint32]ModelEntry),
			AnomalyHistory:      make(map[uint32]MetricHistory),
			AdaptiveSizes:       make(map[uint32]int),
			RollingRMSE:         make(map[uint32]float64),
			SeasonalHistory:     make(map[uint32]*SeasonalHistory),
			RegimeHistory:       make(map[uint32][]int),
			SeriesRmseTolerance: make(map[uint32]float64),
		}
	}
	workers := runtime.NumCPU()
	if workers < 4 {
		workers = 4
	}
	compressionSem = make(chan struct{}, workers)
}

// =============================================================================
// Helper: label extraction
// =============================================================================

func extractLabels(metricString string) map[string]string {
	start := strings.Index(metricString, "{")
	end := strings.LastIndex(metricString, "}")
	labels := make(map[string]string)
	name := metricString
	if start != -1 {
		name = metricString[:start]
	}
	labels["__name__"] = name
	if start == -1 || end == -1 || start >= end {
		return labels
	}
	content := metricString[start+1 : end]
	for _, pair := range strings.Split(content, ",") {
		parts := strings.SplitN(pair, "=", 2)
		if len(parts) == 2 {
			key := strings.TrimSpace(parts[0])
			value := strings.Trim(strings.TrimSpace(parts[1]), "\"")
			labels[key] = value
		}
	}
	return labels
}

// =============================================================================
// Phase 2 — Anomaly Detection (season-aware, change-point, per-series tolerance)
// =============================================================================

// getTimeSlot returns the 0-167 seasonal slot for the current wall-clock time.
// slot = (weekday * 24) + hour_of_day
func getTimeSlot() int {
	now := time.Now()
	return int(now.Weekday())*24 + now.Hour()
}

// getSeriesRmseTolerance returns the per-series tolerance, falling back to the
// global Cfg.Ingestion.RmseTolerance constant.  Caller must hold shard.mu in read or write mode.
func getSeriesRmseTolerance(shard *Shard, sid uint32) float64 {
	if tol, ok := shard.SeriesRmseTolerance[sid]; ok && tol > 0 {
		return tol
	}
	return Cfg.Ingestion.RmseTolerance
}

// updateSeriesRmseTolerance auto-tunes per-series tolerance after each chunk.
// Stable series (constant/linear, low RMSE) tighten; volatile series loosen.
// Caller must hold shard.mu in write mode.
func updateSeriesRmseTolerance(shard *Shard, sid uint32, rmse float64, modelID int) {
	const tightenFactor = 0.95
	const loosenFactor  = 1.10
	const floorTol      = 1.0
	const ceilTol       = 50.0

	tol := getSeriesRmseTolerance(shard, sid)
	if modelID <= 1 && rmse < tol*0.20 {
		tol = math.Max(tol*tightenFactor, floorTol)
	} else if modelID == 2 && rmse > tol*0.80 {
		tol = math.Min(tol*loosenFactor, ceilTol)
	}
	shard.SeriesRmseTolerance[sid] = tol
}

// check_for_anomaly scores the current RMSE against:
//  1. The seasonal slot's history (same hour-of-week) — avoids false positives
//     from predictable daily/weekly patterns.
//  2. The global AnomalyHistory as fallback when the seasonal slot is cold.
//  3. A model complexity jump (constant → quadratic) as a hard signal.
// Caller must hold shard.mu in at least read mode.
func check_for_anomaly(shard *Shard, seriesID uint32, current_rmse float64, model_id int) (bool, string) {
	tol := getSeriesRmseTolerance(shard, seriesID)

	// --- Seasonal check (primary) ---
	slot := getTimeSlot()
	if sh, ok := shard.SeasonalHistory[seriesID]; ok {
		slotHistory := (*sh)[slot]
		if len(slotHistory.Rmses) >= Cfg.Anomaly.MinChunksForHistory {
			var sum float64
			for _, v := range slotHistory.Rmses {
				sum += v
			}
			mean := sum / float64(len(slotHistory.Rmses))
			var sd float64
			for _, v := range slotHistory.Rmses {
				sd += math.Pow(v-mean, 2)
			}
			sd = math.Sqrt(sd / float64(len(slotHistory.Rmses)))
			threshold := mean + (Cfg.Anomaly.RmseMultiplier * sd)
			if current_rmse > threshold && current_rmse > tol {
				return true, fmt.Sprintf("Seasonal RMSE Deviation: %.2f > %.2f (slot %d)", current_rmse, threshold, slot)
			}
			// Seasonal slot is warm — skip global check (avoid double-fire)
			goto checkComplexityJump
		}
	}

	// --- Global fallback (cold seasonal slot) ---
	{
		history, exists := shard.AnomalyHistory[seriesID]
		if exists {
			rmses := history.Rmses
			if len(rmses) >= Cfg.Anomaly.MinChunksForHistory {
				var sum, mean, sd float64
				for _, v := range rmses {
					sum += v
				}
				mean = sum / float64(len(rmses))
				for _, v := range rmses {
					sd += math.Pow(v-mean, 2)
				}
				sd = math.Sqrt(sd / float64(len(rmses)))
				threshold := mean + (Cfg.Anomaly.RmseMultiplier * sd)
				if current_rmse > threshold && current_rmse > tol {
					return true, fmt.Sprintf("RMSE Deviation: %.2f > %.2f", current_rmse, threshold)
				}
			}
			model_ids := history.ModelIDs
			if len(model_ids) > 0 && model_ids[len(model_ids)-1] == 0 && model_id == 2 {
				return true, "Model Complexity Jump: 0 -> 2"
			}
		}
	}

checkComplexityJump:
	// Hard signal regardless of seasonal warmth
	if history, ok := shard.AnomalyHistory[seriesID]; ok {
		ids := history.ModelIDs
		if len(ids) > 0 && ids[len(ids)-1] == 0 && model_id == 2 {
			return true, "Model Complexity Jump: 0 -> 2"
		}
	}
	return false, ""
}

// update_history_cache updates both the global and seasonal RMSE histories.
// Caller must hold shard.mu in write mode.
func update_history_cache(shard *Shard, seriesID uint32, current_rmse float64, model_id int) {
	// Global history (unchanged — used as fallback and for checkpoint)
	history, exists := shard.AnomalyHistory[seriesID]
	if !exists {
		history = MetricHistory{Rmses: []float64{}, ModelIDs: []int{}}
	}
	history.Rmses = append(history.Rmses, current_rmse)
	history.ModelIDs = append(history.ModelIDs, model_id)
	if len(history.Rmses) > 50 {
		history.Rmses = history.Rmses[1:]
		history.ModelIDs = history.ModelIDs[1:]
	}
	shard.AnomalyHistory[seriesID] = history

	// Seasonal history — route to the correct hour-of-week slot
	slot := getTimeSlot()
	sh, ok := shard.SeasonalHistory[seriesID]
	if !ok {
		newSH := &SeasonalHistory{}
		shard.SeasonalHistory[seriesID] = newSH
		sh = newSH
	}
	slotHist := (*sh)[slot]
	slotHist.Rmses = append(slotHist.Rmses, current_rmse)
	slotHist.ModelIDs = append(slotHist.ModelIDs, model_id)
	if len(slotHist.Rmses) > 20 { // keep last 20 readings per time slot
		slotHist.Rmses = slotHist.Rmses[1:]
		slotHist.ModelIDs = slotHist.ModelIDs[1:]
	}
	(*sh)[slot] = slotHist
}

// =============================================================================
// Phase 2 — Change Point Detection
// =============================================================================

// updateRegimeHistory appends the latest model ID to the per-series ring buffer
// and checks for a sustained regime shift.  Returns (shifted, fromModel, toModel).
// Caller must hold shard.mu in write mode.
func updateRegimeHistory(shard *Shard, seriesID uint32, modelID int) (bool, int, int) {
	hist := shard.RegimeHistory[seriesID]
	hist = append(hist, modelID)
	if len(hist) > Cfg.Anomaly.RegimeHistoryLen {
		hist = hist[1:]
	}
	shard.RegimeHistory[seriesID] = hist

	if len(hist) < Cfg.Anomaly.RegimeHistoryLen {
		return false, 0, 0
	}

	half := Cfg.Anomaly.RegimeHistoryLen / 2
	first := hist[:half]
	second := hist[half:]

	// Dominant model in each half
	dominant := func(ids []int) int {
		counts := make(map[int]int)
		for _, id := range ids {
			counts[id]++
		}
		best, bestCount := 0, 0
		for id, c := range counts {
			if c > bestCount {
				best, bestCount = id, c
			}
		}
		return best
	}

	fromModel := dominant(first)
	toModel   := dominant(second)

	if fromModel != toModel {
		return true, fromModel, toModel
	}
	return false, 0, 0
}

// logRegimeChange writes a regime-shift event to tsdb.ai-data/events/regimes/
func logRegimeChange(metricString string, fromModel, toModel int, tBase float64) {
	os.MkdirAll(REGIME_CHANGE_DIR, 0755)
	event := map[string]interface{}{
		"metric_string": metricString,
		"from_model":    fromModel,
		"to_model":      toModel,
		"timestamp_start": tBase,
		"detected_at":   time.Now().Unix(),
	}
	safe := metricString
	if len(safe) > 20 {
		safe = safe[:20]
	}
	safe = strings.ReplaceAll(safe, "/", "_")
	path := filepath.Join(REGIME_CHANGE_DIR, fmt.Sprintf("%d_%s_%d.json", time.Now().UnixNano(), safe, rand.Intn(10000)))
	data, _ := json.MarshalIndent(event, "", "  ")
	ioutil.WriteFile(path, data, 0644)
}

// updateRollingRMSE maintains an exponential moving average of RMSE per series.
// α=0.1 means new readings contribute 10% and history 90% — smooth, stable baseline
// used by the forecasting confidence band.  Caller must hold shard.mu in write mode.
func updateRollingRMSE(shard *Shard, seriesID uint32, currentRMSE float64) {
	const alpha = 0.1
	prev, exists := shard.RollingRMSE[seriesID]
	if !exists {
		shard.RollingRMSE[seriesID] = currentRMSE
		return
	}
	shard.RollingRMSE[seriesID] = alpha*currentRMSE + (1-alpha)*prev
}

func anomalySeverity(current_rmse float64) string {
	tol := Cfg.Ingestion.RmseTolerance
	mult := Cfg.Anomaly.RmseMultiplier
	ratio := current_rmse / (tol * mult)
	switch {
	case ratio >= 5.0:
		return "HIGH"
	case ratio >= 2.0:
		return "MEDIUM"
	default:
		return "LOW"
	}
}

func log_anomaly(metric_string string, reason string, current_rmse float64, model_id int, t_base float64) {
	os.MkdirAll(ANOMALY_DIR, 0755)
	event := map[string]interface{}{
		"timestamp_start": t_base, "metric_string": metric_string, "reason": reason,
		"detected_model": model_id, "rmse": current_rmse, "log_time": time.Now().Unix(),
		"severity": anomalySeverity(current_rmse),
	}
	safe := metric_string
	if len(safe) > 20 {
		safe = safe[:20]
	}
	safe = strings.ReplaceAll(safe, "/", "_")
	path := filepath.Join(ANOMALY_DIR, fmt.Sprintf("%d_%s_%d.json", int64(t_base), safe, rand.Intn(1000)))
	data, _ := json.MarshalIndent(event, "", "  ")
	ioutil.WriteFile(path, data, 0644)
}

// =============================================================================
// Feature: Adaptive Buffer Sizing
//
// Series that consistently produce simple models (constant/linear) have their
// buffer threshold doubled up to Cfg.Ingestion.MaxSamplesPerSegment.  This halves or
// quarters the number of AdaptiveFit calls for stable signals, freeing CPU
// for higher-throughput ingestion without reducing compression quality.
// =============================================================================

func getAdaptiveBufferSize(shard *Shard, sid uint32) int {
	if size, ok := shard.AdaptiveSizes[sid]; ok && size > 0 {
		return size
	}
	return Cfg.Ingestion.SamplesPerSegment
}

func updateAdaptiveBufferSize(shard *Shard, sid uint32) {
	// Caller must hold shard.mu in write mode
	history, exists := shard.AnomalyHistory[sid]
	if !exists || len(history.ModelIDs) < 3 {
		return
	}
	n := len(history.ModelIDs)
	last3 := history.ModelIDs[n-3:]
	allSimple := true
	for _, id := range last3 {
		if id > 1 {
			allSimple = false
			break
		}
	}
	current := shard.AdaptiveSizes[sid]
	if current == 0 {
		current = Cfg.Ingestion.SamplesPerSegment
	}
	if allSimple {
		next := current * 2
		if next > Cfg.Ingestion.MaxSamplesPerSegment {
			next = Cfg.Ingestion.MaxSamplesPerSegment
		}
		shard.AdaptiveSizes[sid] = next
	} else {
		shard.AdaptiveSizes[sid] = Cfg.Ingestion.SamplesPerSegment // reset on volatility
	}
}

// =============================================================================
// Storage Calculations
// =============================================================================

func estimateHeadCacheMemoryBytes() int64 {
	var m runtime.MemStats
	runtime.ReadMemStats(&m)
	return int64(m.Alloc)
}
func calculateTotalShippedBytes() int64 {
	var total int64
	files, err := ioutil.ReadDir(ShippedDir)
	if err != nil {
		return 0
	}
	for _, f := range files {
		if !f.IsDir() {
			total += f.Size()
		}
	}
	return total
}
func calculateCanonicalStorageBytes() int64 {
	var total int64
	files, err := ioutil.ReadDir(CanonicalBlocksDir)
	if err != nil {
		return 0
	}
	for _, f := range files {
		if !f.IsDir() && strings.HasSuffix(f.Name(), ".json") {
			total += f.Size()
		}
	}
	return total
}
func calculateSymbolMetadataSizeBytes() int64 {
	var size int64
	globalSymbols.mu.RLock()
	defer globalSymbols.mu.RUnlock()
	for k := range globalSymbols.stringToID {
		size += int64(len(k))
	}
	return size
}

// =============================================================================
// Operational Metrics — aggregates across all 256 shards
// =============================================================================

// dirBytes walks a directory recursively and sums all file sizes.
// Returns 0 silently if the directory doesn't exist or can't be read.
func dirBytes(dir string) int64 {
	if dir == "" {
		return 0
	}
	var total int64
	_ = filepath.Walk(dir, func(_ string, info os.FileInfo, err error) error {
		if err == nil && !info.IsDir() {
			total += info.Size()
		}
		return nil
	})
	return total
}

// dataDirBytes returns the total size of the entire DataRoot tree.
func dataDirBytes() int64 { return dirBytes(DataRoot) }

// countRecentEvents returns how many JSON files in dir have a mod-time within window.
func countRecentEvents(dir string, window time.Duration) int {
	cutoff := time.Now().Add(-window)
	entries, err := os.ReadDir(dir)
	if err != nil {
		return 0
	}
	n := 0
	for _, e := range entries {
		if e.IsDir() || filepath.Ext(e.Name()) != ".json" {
			continue
		}
		info, err := e.Info()
		if err != nil {
			continue
		}
		if info.ModTime().After(cutoff) {
			n++
		}
	}
	return n
}

func getOperationalMetrics() map[string]interface{} {
	var totalSeries, totalHeadCache int
	for i := 0; i < Cfg.Ingestion.NumShards; i++ {
		shard := &state.Shards[i]
		shard.mu.RLock()
		totalSeries += len(shard.Buffers)
		totalHeadCache += len(shard.HeadCache)
		shard.mu.RUnlock()
	}
	globalSymbols.mu.RLock()
	totalSymbols := len(globalSymbols.stringToID)
	globalSymbols.mu.RUnlock()

	state.StatsMu.Lock()
	avgRMSE := 0.0
	if tc := atomic.LoadInt64(&state.TotalChunksModeled); tc > 0 {
		avgRMSE = state.TotalRMSEAccumulated / float64(tc)
	}
	lastLatencyMs := state.LastCompactionLatency.Seconds() * 1000
	state.StatsMu.Unlock()

	return map[string]interface{}{
		"total_samples_ingested":     atomic.LoadInt64(&state.TotalSamples),
		"total_chunks_modeled":       atomic.LoadInt64(&state.TotalChunksModeled),
		"head_cache_size":            totalHeadCache,
		"avg_rmse":                   avgRMSE,
		"last_compaction_latency_ms": lastLatencyMs,
		"index_queue_size":           len(state.IndexQueue),
		"lts_index_size_entries":     atomic.LoadInt64(&state.TotalIndexEntries),
		"total_shipped_bytes":        float64(atomic.LoadInt64(&state.TotalShippedBytes)),
		"total_canonical_bytes":      float64(atomic.LoadInt64(&state.TotalCanonicalBytes)),
		"head_cache_memory_bytes":    float64(atomic.LoadInt64(&state.HeadCacheMemoryBytes)),
		"symbol_metadata_size_bytes": float64(atomic.LoadInt64(&state.SymbolMetadataBytes)),
		"unique_series_active":       totalSeries,
		"total_symbols_registered":   totalSymbols,
		"wal_queue_depth":            len(walWriteQueue),
		"compression_slots_free":     cap(compressionSem) - len(compressionSem),
		// ── Storage breakdown ──────────────────────────────────────────────
		"data_dir_bytes":             dataDirBytes(),
		"wal_bytes":                  dirBytes(WALChunksDir),
		"staging_bytes":              dirBytes(ShippedDir),
		"canonical_bytes":            dirBytes(CanonicalBlocksDir),
		"index_bytes":                dirBytes(LTSIndexStoragePath),
		"events_bytes":               dirBytes(ANOMALY_DIR) + dirBytes(REGIME_CHANGE_DIR),
		"registry_bytes":             dirBytes(DataRoot + "/registry"),
		// ── Anomaly count (files written in last 30 min) ────────────────────
		"active_anomalies_count":     countRecentEvents(ANOMALY_DIR, 30*time.Minute),
	}
}

// =============================================================================
// HTTP Handlers
// =============================================================================

func handleInternalMetrics(w http.ResponseWriter, r *http.Request) {
	setCORSHeaders(w)
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(getOperationalMetrics())
}

func handleInternalMetadata(w http.ResponseWriter, r *http.Request) {
	setCORSHeaders(w)
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	uniqueSeries := make(map[string]map[string]string)
	for i := 0; i < Cfg.Ingestion.NumShards; i++ {
		shard := &state.Shards[i]
		shard.mu.RLock()
		for sid, entry := range shard.HeadCache {
			ms := globalSymbols.Lookup(sid)
			if _, exists := uniqueSeries[ms]; !exists {
				uniqueSeries[ms] = entry.Labels
			}
		}
		for sid := range shard.Buffers {
			ms := globalSymbols.Lookup(sid)
			if _, exists := uniqueSeries[ms]; !exists {
				uniqueSeries[ms] = extractLabels(ms)
			}
		}
		shard.mu.RUnlock()
	}
	var seriesList []map[string]string
	for _, labels := range uniqueSeries {
		seriesList = append(seriesList, labels)
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(seriesList)
}

// handleInternalAnomalies reads all anomaly event files and returns them
// sorted newest-first, limited to the 500 most recent.
func handleInternalAnomalies(w http.ResponseWriter, r *http.Request) {
	setCORSHeaders(w)
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	events := readEventDir(ANOMALY_DIR, 500)
	json.NewEncoder(w).Encode(map[string]interface{}{"anomalies": events, "count": len(events)})
}

// handleInternalRegimeChanges reads all regime-change event files and returns
// them sorted newest-first, limited to the 500 most recent.
func handleInternalRegimeChanges(w http.ResponseWriter, r *http.Request) {
	setCORSHeaders(w)
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	events := readEventDir(REGIME_CHANGE_DIR, 500)
	json.NewEncoder(w).Encode(map[string]interface{}{"changes": events, "count": len(events)})
}

// readEventDir reads all *.json files from dir, parses each as a
// map[string]interface{}, and returns them newest-first (by file mod-time).
// At most maxN entries are returned.
func readEventDir(dir string, maxN int) []map[string]interface{} {
	type stamped struct {
		t    int64
		data map[string]interface{}
	}

	entries, err := os.ReadDir(dir)
	if err != nil {
		return []map[string]interface{}{}
	}

	var items []stamped
	for _, e := range entries {
		if e.IsDir() || filepath.Ext(e.Name()) != ".json" {
			continue
		}
		info, err := e.Info()
		if err != nil {
			continue
		}
		data, err := os.ReadFile(filepath.Join(dir, e.Name()))
		if err != nil {
			continue
		}
		var m map[string]interface{}
		if json.Unmarshal(data, &m) != nil {
			continue
		}
		items = append(items, stamped{t: info.ModTime().UnixNano(), data: m})
	}

	// Sort newest first
	for i := 0; i < len(items)-1; i++ {
		for j := i + 1; j < len(items); j++ {
			if items[j].t > items[i].t {
				items[i], items[j] = items[j], items[i]
			}
		}
	}

	// Cap at maxN
	if len(items) > maxN {
		items = items[:maxN]
	}

	out := make([]map[string]interface{}, len(items))
	for i, it := range items {
		out[i] = it.data
	}
	return out
}

// =============================================================================
// Persistence
// =============================================================================

func initializePersistence() {
	Logf("INGESTOR", "Initializing storage under %s", DataRoot)
	// Create the full directory tree in one pass.
	// All sub-paths are vars defined in config.go, derived from Cfg.Data.Root.
	for _, dir := range []string{
		DataRoot,
		WALChunksDir,            // tsdb.ai-data/wal
		ShippedDir,              // tsdb.ai-data/blocks/staging
		CanonicalBlocksDir,      // tsdb.ai-data/blocks/canonical
		LTSIndexStoragePath,     // tsdb.ai-data/index
		ANOMALY_DIR,              // tsdb.ai-data/events/anomalies
		REGIME_CHANGE_DIR,        // tsdb.ai-data/events/regimes
		DataRoot + "/registry",   // tsdb.ai-data/registry  (patterns, causal, relationships)
		DataRoot + "/alerts",     // tsdb.ai-data/alerts    (rules.json, events.json)
	} {
		if err := os.MkdirAll(dir, 0755); err != nil {
			Logf("INGESTOR", "WARNING: could not create %s: %v", dir, err)
		}
	}
	state.IndexDB = struct{}{}

	// Fire a one-time install analytics ping the very first time this data
	// directory is initialised.  A sentinel file prevents it from ever firing
	// again, even across restarts or re-deployments.
	go fireInstallAnalyticsOnce()

	// Start the alert evaluation engine.
	initAlerts()
}

// fireInstallAnalyticsOnce posts {"install":"new","timestamp":"..."} to the
// TSDB.ai analytics endpoint exactly once per fresh data directory.
//
// Design constraints — this function MUST be:
//   - Non-blocking  (always called via `go fireInstallAnalyticsOnce()`)
//   - Fail-silent   (any network error, timeout, or panic is swallowed)
//   - One-shot      (sentinel file prevents re-firing on every restart)
func fireInstallAnalyticsOnce() {
	// Swallow any unexpected panic so this goroutine can never crash the server.
	defer func() { recover() }() //nolint:errcheck

	sentinel := filepath.Join(DataRoot, ".installed")

	// Sentinel exists → already installed, nothing to do.
	if _, err := os.Stat(sentinel); err == nil {
		return
	}

	payload := []byte(`{"install":"new","timestamp":"` + time.Now().UTC().Format(time.RFC3339) + `"}`)

	// 10-second timeout — if tsdb.ai is unreachable for any reason (firewall,
	// air-gapped network, DNS failure) we give up cleanly and move on.
	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := client.Post(
		"https://tsdb.ai/install-analytics",
		"application/json",
		bytes.NewReader(payload),
	)
	if err == nil {
		resp.Body.Close() // drain and discard — we don't inspect the response
	}
	// err != nil → silently ignored; we never retry

	// Write sentinel regardless of POST outcome.
	// This guarantees we never fire twice, even on repeated network failures.
	_ = os.WriteFile(sentinel, []byte("1"), 0644)
}

func writeIndexEntryToLocalDB(entry IndexUpdate) error {
	if entry.Action == "CREATE" {
		atomic.AddInt64(&state.TotalIndexEntries, 1)
	} else if entry.Action == "DELETE" {
		atomic.AddInt64(&state.TotalIndexEntries, -1)
	}
	return nil
}

// saveCheckpoint merges all 256 shards into a single map for serialisation.
func saveCheckpoint() {
	mergedBuffers := make(map[uint32]*ChunkBuffer)
	mergedLastValue := make(map[uint32]float64)
	mergedHead := make(map[uint32]ModelEntry)
	mergedAnomaly := make(map[uint32]MetricHistory)

	for i := 0; i < Cfg.Ingestion.NumShards; i++ {
		shard := &state.Shards[i]
		shard.mu.RLock()
		for k, v := range shard.Buffers {
			mergedBuffers[k] = v
		}
		for k, v := range shard.LastValueCache {
			mergedLastValue[k] = v
		}
		for k, v := range shard.HeadCache {
			mergedHead[k] = v
		}
		for k, v := range shard.AnomalyHistory {
			mergedAnomaly[k] = v
		}
		shard.mu.RUnlock()
	}

	globalSymbols.mu.RLock()
	symCopy := make(map[string]uint32, len(globalSymbols.stringToID))
	for k, v := range globalSymbols.stringToID {
		symCopy[k] = v
	}
	nextID := globalSymbols.nextID
	globalSymbols.mu.RUnlock()

	state.StatsMu.Lock()
	rmseAccum := state.TotalRMSEAccumulated
	state.StatsMu.Unlock()

	checkpoint := CheckpointStruct{
		Version:              CheckpointVersion,
		SymbolStringToID:     symCopy,
		SymbolNextID:         nextID,
		Buffers:              mergedBuffers,
		LastValueCache:       mergedLastValue,
		HeadCache:            mergedHead,
		AnomalyHistory:       mergedAnomaly,
		TotalSamples:         atomic.LoadInt64(&state.TotalSamples),
		TotalChunksModeled:   atomic.LoadInt64(&state.TotalChunksModeled),
		TotalIndexEntries:    atomic.LoadInt64(&state.TotalIndexEntries),
		TotalRMSEAccumulated: rmseAccum,
	}
	data, err := json.MarshalIndent(checkpoint, "", "  ")
	if err != nil {
		return
	}
	ioutil.WriteFile(CheckpointFile, data, 0644)
	Logf("INGESTOR", "[CHECKPOINT] Saved (v%d): %d series, %d chunks.",
		CheckpointVersion, len(mergedBuffers), checkpoint.TotalChunksModeled)
}

// loadCheckpoint restores state and distributes entries to the correct shards.
func loadCheckpoint() {
	if _, err := os.Stat(CheckpointFile); os.IsNotExist(err) {
		return
	}
	data, err := ioutil.ReadFile(CheckpointFile)
	if err != nil {
		return
	}
	var versionProbe struct {
		Version int `json:"version"`
	}
	json.Unmarshal(data, &versionProbe)
	if versionProbe.Version < CheckpointVersion {
		Logf("INGESTOR", "[CHECKPOINT] Old format (v%d, need v%d) — starting fresh.",
			versionProbe.Version, CheckpointVersion)
		return
	}
	var cp CheckpointStruct
	if err := json.Unmarshal(data, &cp); err != nil {
		Logf("INGESTOR", "[CHECKPOINT] Parse error: %v — starting fresh.", err)
		return
	}

	// Restore symbol table first
	if cp.SymbolStringToID != nil {
		globalSymbols.mu.Lock()
		globalSymbols.stringToID = cp.SymbolStringToID
		globalSymbols.nextID = cp.SymbolNextID
		for k, v := range cp.SymbolStringToID {
			globalSymbols.idToString[v] = k
		}
		globalSymbols.mu.Unlock()
	}

	// Distribute into shards
	for k, v := range cp.Buffers {
		shard := state.GetShard(k)
		shard.mu.Lock()
		shard.Buffers[k] = v
		shard.mu.Unlock()
	}
	for k, v := range cp.LastValueCache {
		shard := state.GetShard(k)
		shard.mu.Lock()
		shard.LastValueCache[k] = v
		shard.mu.Unlock()
	}
	for k, v := range cp.HeadCache {
		shard := state.GetShard(k)
		shard.mu.Lock()
		shard.HeadCache[k] = v
		shard.mu.Unlock()
	}
	for k, v := range cp.AnomalyHistory {
		shard := state.GetShard(k)
		shard.mu.Lock()
		shard.AnomalyHistory[k] = v
		shard.mu.Unlock()
	}

	atomic.StoreInt64(&state.TotalSamples, cp.TotalSamples)
	atomic.StoreInt64(&state.TotalChunksModeled, cp.TotalChunksModeled)
	atomic.StoreInt64(&state.TotalIndexEntries, cp.TotalIndexEntries)
	state.StatsMu.Lock()
	state.TotalRMSEAccumulated = cp.TotalRMSEAccumulated
	state.StatsMu.Unlock()

	Logf("INGESTOR", "[CHECKPOINT] Restored (v%d): %d series, %d chunks.",
		cp.Version, len(cp.Buffers), cp.TotalChunksModeled)
}

// =============================================================================
// Vector DB Push (unchanged — AI moat preserved)
// =============================================================================

// pushToVectorDB pushes an enriched 8D embedding for non-constant chunks.
// Phase 3: vector is now 8D (params + RMSE + direction + complexity + stability)
// instead of the original 3D [a,b,c].  Constant model (ID=0) is still skipped
// — flat lines carry no useful shape information.
func pushToVectorDB(chunk CompressedChunk) {
	if chunk.ModelID == 0 {
		return
	}

	sid := globalSymbols.GetOrCreate(chunk.MetricString)
	shard := state.GetShard(sid)

	shard.mu.RLock()
	entry := shard.HeadCache[sid]
	rollingRMSE := shard.RollingRMSE[sid]
	shard.mu.RUnlock()

	// Build enriched 8D embedding
	enrichedVector := buildEnrichedEmbedding(entry, rollingRMSE, shard, sid)

	labels := extractLabels(chunk.MetricString)
	metadata := map[string]string{
		"metric":   chunk.MetricString,
		"model_id": fmt.Sprintf("%d", chunk.ModelID),
		"t_base":   fmt.Sprintf("%f", chunk.TBase),
	}
	for k, v := range labels {
		metadata[k] = v
	}

	// Check pattern registry — annotate if a known pattern matches
	if matches := MatchPatterns(enrichedVector); len(matches) > 0 {
		metadata["matched_patterns"] = fmt.Sprintf("%v", matches)
	}

	payload := map[string]interface{}{
		"id":        fmt.Sprintf("%s_%d", chunk.MetricString, int64(chunk.TBase)),
		"vector":    enrichedVector,
		"metadata":  metadata,
	}
	jsonData, _ := json.Marshal(payload)
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		req, err := http.NewRequestWithContext(ctx, "POST", Cfg.Server.VectorDBEndpoint, bytes.NewBuffer(jsonData))
		if err != nil {
			return
		}
		req.Header.Set("Content-Type", "application/json")
		resp, err := http.DefaultClient.Do(req)
		if err == nil {
			resp.Body.Close()
		}
	}()
}

// =============================================================================
// Feature: Batch WAL Writer + Binary WAL Format
// =============================================================================

// writeChunkToDisk is now a non-blocking push to the batch WAL queue.
// The actual I/O is handled by startBatchWALWriter in the background.
func writeChunkToDisk(chunk CompressedChunk) {
	select {
	case walWriteQueue <- chunk:
	default:
		// Queue full — write a single-chunk binary file as fallback
		writeBinaryWALBatch([]CompressedChunk{chunk})
	}
}

// startBatchWALWriter drains walWriteQueue in batches, writing compact binary
// .bin files.  One file per batch instead of one file per chunk — eliminates
// the syscall-per-chunk bottleneck.
func startBatchWALWriter() {
	go func() {
		ticker := time.NewTicker(Cfg.Ingestion.WALBatchInterval())
		defer ticker.Stop()
		pending := make([]CompressedChunk, 0, Cfg.Ingestion.WALBatchSize)

		flush := func() {
			if len(pending) == 0 {
				return
			}
			writeBinaryWALBatch(pending)
			pending = pending[:0]
		}

		for {
			select {
			case chunk := <-walWriteQueue:
				pending = append(pending, chunk)
				if len(pending) >= Cfg.Ingestion.WALBatchSize {
					flush()
				}
			case <-ticker.C:
				flush()
			}
		}
	}()
}

// writeBinaryWALBatch serialises a slice of chunks into a single binary .bin
// file.  Average ~67 bytes/chunk vs ~200 bytes/chunk for JSON.
func writeBinaryWALBatch(chunks []CompressedChunk) {
	if len(chunks) == 0 {
		return
	}
	var buf bytes.Buffer
	// Header
	binary.Write(&buf, binary.LittleEndian, WALMagic)
	binary.Write(&buf, binary.LittleEndian, uint32(len(chunks)))
	// Chunks
	for _, c := range chunks {
		metricBytes := []byte(c.MetricString)
		binary.Write(&buf, binary.LittleEndian, uint32(len(metricBytes)))
		buf.Write(metricBytes)
		binary.Write(&buf, binary.LittleEndian, uint8(c.ModelID))
		binary.Write(&buf, binary.LittleEndian, c.TBase)
		// Always write exactly 3 params (AdaptiveFit guarantees padding)
		for i := 0; i < 3; i++ {
			p := 0.0
			if i < len(c.Params) {
				p = c.Params[i]
			}
			binary.Write(&buf, binary.LittleEndian, p)
		}
	}
	filename := fmt.Sprintf("%d_batch_%d.bin", int64(chunks[0].TBase), rand.Intn(100000))
	ioutil.WriteFile(filepath.Join(WALChunksDir, filename), buf.Bytes(), 0644)
}

// =============================================================================
// Ingestion — ties all features together
// =============================================================================

// sampleWithID carries a resolved symbol ID alongside the raw sample so we
// only call globalSymbols.GetOrCreate once per sample.
type sampleWithID struct {
	sample MetricSample
	sid    uint32
}

func ingestAndProcess(rawSamples []MetricSample) {
	startTime := time.Now()
	compressionChannel := make(chan CompressedChunk, len(rawSamples))
	var compressionWG sync.WaitGroup

	// ── Phase 1: Resolve all symbol IDs outside any lock ─────────────────────
	enriched := make([]sampleWithID, 0, len(rawSamples))
	for _, s := range rawSamples {
		enriched = append(enriched, sampleWithID{s, globalSymbols.GetOrCreate(s.MetricString)})
	}

	// ── Phase 2: Group by shard index ─────────────────────────────────────────
	// Each shard is processed under its own fine-grained lock.
	type shardGroup struct {
		idx     uint32
		samples []sampleWithID
	}
	shardMap := make(map[uint32][]sampleWithID, Cfg.Ingestion.NumShards)
	for _, e := range enriched {
		idx := e.sid % uint32(Cfg.Ingestion.NumShards)
		shardMap[idx] = append(shardMap[idx], e)
	}

	// ── Phase 3: Per-shard buffer accumulation (fine-grained locking) ─────────
	for shardIdx, samples := range shardMap {
		shard := &state.Shards[shardIdx]
		// local delta map for counter first-seen tracking (per shard)
		deltaUpdates := make(map[uint32]float64)

		shard.mu.Lock()
		for _, e := range samples {
			sid := e.sid
			s := e.sample
			lastValue, ok := shard.LastValueCache[sid]
			isCounter := strings.HasSuffix(s.MetricString, "_total")
			var processedValue float64
			var shouldProcess bool

			if isCounter {
				if ok && s.Value >= lastValue {
					processedValue = s.Value - lastValue
					shouldProcess = true
				} else if !ok {
					deltaUpdates[sid] = s.Value
					continue
				}
				deltaUpdates[sid] = s.Value
			} else {
				processedValue = s.Value
				shouldProcess = true
			}

			if shouldProcess {
				if _, exists := shard.Buffers[sid]; !exists {
					shard.Buffers[sid] = &ChunkBuffer{}
				}
				buf := shard.Buffers[sid]
				buf.Timestamps = append(buf.Timestamps, s.Timestamp)
				buf.Values = append(buf.Values, processedValue)
				atomic.AddInt64(&state.TotalSamples, 1)

				threshold := getAdaptiveBufferSize(shard, sid)
				if len(buf.Values) >= threshold {
					compressionWG.Add(1)
					// Acquire a semaphore slot before spawning — bounds concurrency
					compressionSem <- struct{}{}
					go func(metric string, t, v []float64) {
						defer compressionWG.Done()
						defer func() { <-compressionSem }()
						compressionChannel <- AdaptiveFit(t, v, metric, Cfg.Ingestion.RmseTolerance)
					}(s.MetricString, buf.Timestamps, buf.Values)
					shard.Buffers[sid] = &ChunkBuffer{}
				}
			}
		}
		for k, v := range deltaUpdates {
			shard.LastValueCache[k] = v
		}
		shard.mu.Unlock()
	}

	compressionWG.Wait()
	close(compressionChannel)

	// ── Phase 4: Process compressed chunks ───────────────────────────────────
	var anomalyChunks []CompressedChunk
	var chunksShipped int

	shippedBytes := calculateTotalShippedBytes()
	canonicalBytes := calculateCanonicalStorageBytes()
	memBytes := estimateHeadCacheMemoryBytes()

	for chunk := range compressionChannel {
		writeChunkToDisk(chunk)   // non-blocking push to WAL queue
		pushToVectorDB(chunk)     // async HTTP — AI moat preserved

		sid := globalSymbols.GetOrCreate(chunk.MetricString)
		labels := extractLabels(chunk.MetricString)
		shard := state.GetShard(sid)

		shard.mu.Lock()
		shard.HeadCache[sid] = ModelEntry{
			Params: chunk.Params, ModelID: chunk.ModelID,
			TBase: chunk.TBase, Labels: labels,
		}
		atomic.AddInt64(&state.TotalChunksModeled, 1)
		state.StatsMu.Lock()
		state.TotalRMSEAccumulated += chunk.RMSE
		state.StatsMu.Unlock()
		chunksShipped++

		isAnomaly, reason := check_for_anomaly(shard, sid, chunk.RMSE, chunk.ModelID)
		if isAnomaly {
			log_anomaly(chunk.MetricString, reason, chunk.RMSE, chunk.ModelID, chunk.TBase)
			anomalyName := chunk.MetricString + "_anomaly"
			if idx := strings.Index(chunk.MetricString, "{"); idx != -1 {
				anomalyName = chunk.MetricString[:idx] + "_anomaly" + chunk.MetricString[idx:]
			}
			anomalyChunks = append(anomalyChunks, CompressedChunk{
				MetricString: anomalyName, ModelID: 0,
				Params: []float64{chunk.RMSE, 0.0, 0.0}, TBase: chunk.TBase,
			})
		}
		update_history_cache(shard, sid, chunk.RMSE, chunk.ModelID)
		updateAdaptiveBufferSize(shard, sid)           // Feature: adaptive buffers
		updateRollingRMSE(shard, sid, chunk.RMSE)      // Phase 1: forecasting baseline
		updateSeriesRmseTolerance(shard, sid, chunk.RMSE, chunk.ModelID) // Phase 2: auto-tune tolerance
		// Phase 2: change point detection
		if shifted, fromM, toM := updateRegimeHistory(shard, sid, chunk.ModelID); shifted {
			go logRegimeChange(chunk.MetricString, fromM, toM, chunk.TBase)
		}

		select {
		case state.IndexQueue <- IndexUpdate{
			S3Key:   fmt.Sprintf("%d_%s_head", int64(chunk.TBase), chunk.MetricString),
			Action:  "CREATE",
			Version: time.Now().UnixNano(),
		}:
		default:
		}
		shard.mu.Unlock()

		headIndex.Add(labels, sid) // inverted index — outside shard lock
	}

	// Anomaly synthetic chunks
	for _, ac := range anomalyChunks {
		writeChunkToDisk(ac)
		aSID := globalSymbols.GetOrCreate(ac.MetricString)
		aLabels := extractLabels(ac.MetricString)
		aShard := state.GetShard(aSID)
		aShard.mu.Lock()
		aShard.HeadCache[aSID] = ModelEntry{
			Params: ac.Params, ModelID: ac.ModelID,
			TBase: ac.TBase, Labels: aLabels,
		}
		aShard.mu.Unlock()
		headIndex.Add(aLabels, aSID)
	}

	// Update global storage stats atomically
	atomic.StoreInt64(&state.TotalShippedBytes, shippedBytes)
	atomic.StoreInt64(&state.TotalCanonicalBytes, canonicalBytes)
	atomic.StoreInt64(&state.HeadCacheMemoryBytes, memBytes)
	atomic.StoreInt64(&state.SymbolMetadataBytes, calculateSymbolMetadataSizeBytes())
	state.StatsMu.Lock()
	state.LastCompactionLatency = time.Since(startTime)
	state.StatsMu.Unlock()

	metrics := getOperationalMetrics()
	anomalyNote := ""
	if len(anomalyChunks) > 0 {
		anomalyNote = fmt.Sprintf("  ⚠  ANOMALIES: %d", len(anomalyChunks))
	}
	Logf("INGESTOR", "── Ingest cycle: %d samples → %d chunks modeled  latency:%v%s",
		len(rawSamples), chunksShipped, state.LastCompactionLatency.Round(time.Millisecond), anomalyNote)
	Logf("INGESTOR", "   series:%d  head:%d  WAL-q:%d  compress-free:%d/%d",
		metrics["unique_series_active"], metrics["head_cache_size"],
		metrics["wal_queue_depth"], metrics["compression_slots_free"], cap(compressionSem))
	Logf("INGESTOR", "   shipped:%.1fKB  canonical:%.1fKB  symbols:%d  meta:%.1fKB",
		metrics["total_shipped_bytes"].(float64)/1024,
		metrics["total_canonical_bytes"].(float64)/1024,
		metrics["total_symbols_registered"],
		metrics["symbol_metadata_size_bytes"].(float64)/1024)
}

func handleIngest(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	body, err := ioutil.ReadAll(r.Body)
	if err != nil {
		http.Error(w, "Error reading body", http.StatusBadRequest)
		return
	}
	var rawSamples []MetricSample
	if err := json.Unmarshal(body, &rawSamples); err != nil {
		http.Error(w, "Invalid JSON", http.StatusBadRequest)
		return
	}
	go ingestAndProcess(rawSamples)
	w.WriteHeader(http.StatusOK)
	w.Write([]byte("Samples accepted."))
}

// handleQueryHead uses the inverted index for HeadCache (O(k)) and falls back
// to a shard-aware scan for in-flight buffers.
func handleQueryHead(w http.ResponseWriter, r *http.Request) {
	r.ParseForm()
	metricPrefix := r.FormValue("query")
	if r.Method != http.MethodGet || metricPrefix == "" {
		http.Error(w, "Invalid", http.StatusBadRequest)
		return
	}

	matchingIDs := headIndex.MatchName(metricPrefix)

	response := HeadQueryResponse{
		Models:    make([]ModelEntry, 0),
		RawSeries: make([]QueryResultEntry, 0),
	}

	// HeadCache lookup — one shard lock per matching ID
	for _, sid := range matchingIDs {
		shard := state.GetShard(sid)
		shard.mu.RLock()
		if entry, ok := shard.HeadCache[sid]; ok {
			response.Models = append(response.Models, entry)
		}
		shard.mu.RUnlock()
	}

	// In-flight buffer scan — iterate all shards
	for i := 0; i < Cfg.Ingestion.NumShards; i++ {
		shard := &state.Shards[i]
		shard.mu.RLock()
		for sid, buffer := range shard.Buffers {
			if len(buffer.Values) == 0 {
				continue
			}
			ms := globalSymbols.Lookup(sid)
			if strings.Contains(ms, metricPrefix) {
				var values [][]interface{}
				for i, t := range buffer.Timestamps {
					values = append(values, []interface{}{t, fmt.Sprintf("%f", buffer.Values[i])})
				}
				response.RawSeries = append(response.RawSeries, QueryResultEntry{
					Metric: extractLabels(ms),
					Values: values,
				})
			}
		}
		shard.mu.RUnlock()
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(response)
}

func startIndexSynchronization() {
	go func() {
		for entry := range state.IndexQueue {
			writeIndexEntryToLocalDB(entry)
		}
	}()
}

func rebuildInvertedIndex() {
	combined := make(map[uint32]ModelEntry)
	for i := 0; i < Cfg.Ingestion.NumShards; i++ {
		shard := &state.Shards[i]
		shard.mu.RLock()
		for k, v := range shard.HeadCache {
			combined[k] = v
		}
		shard.mu.RUnlock()
	}
	headIndex.Rebuild(combined)
	headIndex.mu.RLock()
	keys := len(headIndex.index)
	headIndex.mu.RUnlock()
	Logf("INGESTOR", "Inverted index rebuilt: %d label keys from checkpoint.", keys)
}

// checkInstall warns the user if tsdb.yaml is missing or the data directory
// has not been set up yet. This catches the common "just cloned the repo and
// ran the binary" case on bare Linux without Docker.
func checkInstall() {
	// If running inside Docker the env var is set; skip the interactive hint.
	if _, inDocker := os.LookupEnv("TSDB_IN_DOCKER"); inDocker {
		return
	}

	configMissing := false
	if _, err := os.Stat("tsdb.yaml"); os.IsNotExist(err) {
		configMissing = true
	}

	dataRootMissing := false
	if _, err := os.Stat(DataRoot); os.IsNotExist(err) {
		dataRootMissing = true
	}

	if !configMissing && !dataRootMissing {
		return // everything looks good
	}

	fmt.Println()
	fmt.Println("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
	fmt.Println("  tsdb.ai — setup required")
	fmt.Println("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
	if configMissing {
		fmt.Println("  tsdb.yaml not found.")
		fmt.Println("  The config file tells every service where to store data,")
		fmt.Println("  which ports to listen on, and how to reach S3 (if enabled).")
	}
	if dataRootMissing {
		fmt.Printf("  Data directory not found: %s\n", DataRoot)
		fmt.Println("  This directory holds the WAL, canonical blocks, index,")
		fmt.Println("  event logs, and registry files.")
	}
	fmt.Println()
	fmt.Println("  Run the setup script to configure your install:")
	fmt.Println("    chmod +x setup.sh && ./setup.sh")
	fmt.Println()
	fmt.Println("  The script will:")
	fmt.Println("    • Ask where you want to store runtime data")
	fmt.Println("    • Write tsdb.yaml with your chosen data.root")
	fmt.Println("    • Create the full directory tree")
	fmt.Println("    • Optionally build all service binaries")
	fmt.Println()
	if configMissing {
		// Config is mandatory — cannot proceed with defaults alone.
		fmt.Println("  Exiting. Re-run after ./setup.sh completes.")
		fmt.Println("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
		fmt.Println()
		os.Exit(1)
	}
	// Data root is missing but config exists — MkdirAll in initializePersistence
	// will create it; just warn and continue.
	fmt.Println("  Continuing with defaults — data directory will be created.")
	fmt.Println("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
	fmt.Println()
}

// startIngestorHeartbeat logs a concise stats summary every 60 s so operators
// can see throughput and storage growth without querying /internal/metrics.
func startIngestorHeartbeat() {
	startTime := time.Now()
	var lastSampleCount int64

	ticker := time.NewTicker(60 * time.Second)
	defer ticker.Stop()
	for range ticker.C {
		m := getOperationalMetrics()
		now := atomic.LoadInt64(&state.TotalSamples)
		rate := float64(now-lastSampleCount) / 60.0
		lastSampleCount = now

		shippedMB := m["total_shipped_bytes"].(float64) / (1024 * 1024)
		canonicalMB := m["total_canonical_bytes"].(float64) / (1024 * 1024)
		memMB := m["head_cache_memory_bytes"].(float64) / (1024 * 1024)
		uptime := time.Since(startTime).Round(time.Second)

		sep := strings.Repeat("─", 52)
		Logf("INGESTOR", sep)
		Logf("INGESTOR", "Heartbeat  (uptime: %s)", uptime)
		Logf("INGESTOR", "  Throughput      : %.1f samples/sec (last 60s)", rate)
		Logf("INGESTOR", "  Active series   : %d", m["unique_series_active"])
		Logf("INGESTOR", "  Head cache      : %d chunks / %.1f MB", m["head_cache_size"], memMB)
		Logf("INGESTOR", "  WAL queue       : %d pending", m["wal_queue_depth"])
		Logf("INGESTOR", "  Shipped blocks  : %.2f MB", shippedMB)
		Logf("INGESTOR", "  Canonical store : %.2f MB", canonicalMB)
		Logf("INGESTOR", "  Total ingested  : %d samples", now)
		if Cfg.S3.Enabled {
			Logf("INGESTOR", "  S3 LTS          : enabled  bucket=%s", Cfg.S3.Bucket)
		}
		Logf("INGESTOR", sep)
	}
}

func main() {
	LoadConfig("tsdb.yaml")
	checkInstall()
	PrintBanner("Ingestor")
	initializePersistence()
	loadCheckpoint()
	rebuildInvertedIndex()

	c := make(chan os.Signal, 1)
	signal.Notify(c, os.Interrupt, syscall.SIGTERM)
	go func() {
		<-c
		Logf("INGESTOR", "Shutdown signal received — saving checkpoint...")
		saveCheckpoint()
		Logf("INGESTOR", "Checkpoint saved. Goodbye.")
		os.Exit(0)
	}()

	startIndexSynchronization()
	startBatchWALWriter()            // batch binary WAL writer
	loadPatternRegistry()            // named pattern fingerprints
	loadCausalGraph()                // causal lag analysis
	loadRelationshipGraph()          // structural similarity graph
	startCausalAnalysisWorker()      // background causal worker
	startRelationshipGraphWorker()   // background relationship worker
	go startIngestorHeartbeat()      // periodic stats log

	Logf("INGESTOR", "Shards: %d  |  Compression workers: %d  |  WAL batch: %d samples",
		Cfg.Ingestion.NumShards, cap(compressionSem), Cfg.Ingestion.WALBatchSize)
	Logf("INGESTOR", "Listening on 0.0.0.0:%d", Cfg.Server.IngestPort)

	http.HandleFunc("/ingest_samples", handleIngest)
	http.HandleFunc("/api/v1/query", handleQueryHead)
	http.HandleFunc("/internal/metrics", handleInternalMetrics)
	http.HandleFunc("/internal/metadata", handleInternalMetadata)
	http.HandleFunc("/internal/anomalies", handleInternalAnomalies)
	http.HandleFunc("/internal/regime_changes", handleInternalRegimeChanges)
	// Phase 1: Forecasting endpoints
	http.HandleFunc("/forecast", handleForecast)
	http.HandleFunc("/forecast_batch", handleForecastBatch)
	http.HandleFunc("/forecast_all", handleForecastAll)
	// Phase 3: Pattern registry endpoints
	http.HandleFunc("/patterns/label", handleLabelPattern)
	http.HandleFunc("/patterns", handleListPatterns)
	// Phase 4: Causal graph endpoints
	http.HandleFunc("/causal/graph", handleCausalGraph)
	http.HandleFunc("/causal/upstream", handleCausalUpstream)
	http.HandleFunc("/causal/downstream", handleCausalDownstream)
	// Phase 4: Relationship graph endpoint
	http.HandleFunc("/relationships", handleRelationships)
	// Alert engine endpoints
	http.HandleFunc("/api/alert_rules",  handleAlertRules)
	http.HandleFunc("/api/alert_events", handleAlertEvents)

	// License status endpoint — used by the admin panel for expiry banners
	http.HandleFunc("/internal/license", func(w http.ResponseWriter, r *http.Request) {
		setCORSHeaders(w)
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		status := ValidateLicense(Cfg.LicenseKey)
		w.Header().Set("Content-Type", "application/json")
		if err := json.NewEncoder(w).Encode(status); err != nil {
			http.Error(w, "encode error", http.StatusInternalServerError)
		}
	})

	// Live config endpoint — returns the running Cfg as JSON for the admin panel
	http.HandleFunc("/internal/config", func(w http.ResponseWriter, r *http.Request) {
		setCORSHeaders(w)
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		w.Header().Set("Content-Type", "application/json")

		switch r.Method {
		case http.MethodGet:
			json.NewEncoder(w).Encode(Cfg)

		case http.MethodPost:
			// Accept YAML text body and write it to tsdb.yaml on disk.
			// Changes take effect on next restart — the running process is not hot-reloaded.
			body, err := io.ReadAll(io.LimitReader(r.Body, 512*1024))
			if err != nil || len(body) == 0 {
				http.Error(w, `{"error":"empty or unreadable body"}`, http.StatusBadRequest)
				return
			}
			if err := os.WriteFile("tsdb.yaml", body, 0644); err != nil {
				http.Error(w, `{"error":"could not write tsdb.yaml: `+err.Error()+`"}`, http.StatusInternalServerError)
				return
			}
			Logf("CONFIG", "tsdb.yaml updated via admin panel — restart required for changes to take effect")
			w.WriteHeader(http.StatusOK)
			w.Write([]byte(`{"ok":true,"restart_required":true}`))

		default:
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		}
	})
	// UI state persistence
	http.HandleFunc("/internal/ui_state", func(w http.ResponseWriter, r *http.Request) {
		setCORSHeaders(w)
		switch r.Method {
		case http.MethodGet:
			handleGetUIState(w, r)
		case http.MethodPost:
			handlePostUIState(w, r)
		case http.MethodOptions:
			w.WriteHeader(http.StatusNoContent)
		default:
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		}
	})

	if err := http.ListenAndServe(fmt.Sprintf("0.0.0.0:%d", Cfg.Server.IngestPort), nil); err != nil {
		Logf("INGESTOR", "FATAL: %v", err)
	}
}
