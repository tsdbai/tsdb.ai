package main

import (
	"container/list"
	"context"
	"encoding/gob"
	"encoding/json"
	"fmt"
	"io/ioutil"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
	"unicode"
)

// NOTE: All tunable constants have moved to tsdb.yaml / config.go (Cfg.Query.*, Cfg.Server.*).
// NOTE: CanonicalBlocksDir is declared in config.go (under DataRoot).

// storageNodes is initialised at startup (after config is loaded) in runQueryGateway().
var storageNodes map[string]StorageNodeConfig

// --- Structures ---
type StorageNodeConfig struct {
	URL         string
	MetadataURL string
	Mode        string
}

type ModelEntry struct {
	Params  []float64         `json:"params"`
	ModelID int               `json:"model_id"`
	TBase   float64           `json:"t_base"`
	Labels  map[string]string `json:"labels"`
}

type DiskBlock struct {
	ChunksData []ModelEntry `json:"chunks_data"`
}

type QueryResultEntry struct {
	Metric map[string]string `json:"metric"`
	Values [][]interface{}   `json:"values"`
}

type HeadQueryResponse struct {
	Models    []ModelEntry       `json:"models"`
	RawSeries []QueryResultEntry `json:"raw_series"`
}

type NodeResult struct {
	Source string
	Series []QueryResultEntry
	Stats  QueryStats
	Err    error
}

type QueryStats struct {
	HeadHits  int
	CacheHits int
	DiskHits  int
}

// ltsWorkerResult carries the output of a single parallel LTS block scan worker.
type ltsWorkerResult struct {
	entries  []QueryResultEntry
	cacheHit bool // true if the block was served from LRU cache
	diskHit  bool // true if we had to read the file from disk
	s3Hit    bool // true if the block was fetched from S3
	matched  bool // true if at least one chunk matched the prefix
}

// --- File Catalog (In-Memory Index) ---

// FileEntry represents one canonical block, which may live locally, on S3, or both.
type FileEntry struct {
	Path      string // absolute local path; empty if block has been evicted to S3-only
	StartTime int64
	EndTime   int64
	// S3Key is non-empty for blocks that have been uploaded to S3.
	S3Key   string
	IsLocal bool // true if the local file still exists
}

var fileCatalog = struct {
	sync.RWMutex
	Files []FileEntry
}{
	Files: make([]FileEntry, 0),
}

func runFileIndexer() {
	Logf("GATEWAY", "Starting background file indexer")
	ticker := time.NewTicker(Cfg.Query.FileIndexInterval())
	defer ticker.Stop()

	refreshFileCatalog() // Initial run

	for range ticker.C {
		refreshFileCatalog()
	}
}

func refreshFileCatalog() {
	// Build a map so we can de-duplicate by basename across local + S3 sources.
	entries := make(map[string]*FileEntry)

	// --- Source 1: local canonical_blocks directory ---
	if _, err := os.Stat(CanonicalBlocksDir); err == nil {
		if dirFiles, err := ioutil.ReadDir(CanonicalBlocksDir); err == nil {
			for _, file := range dirFiles {
				if file.IsDir() || !strings.HasSuffix(file.Name(), ".json") {
					continue
				}
				start, end := parseBlockTimes(file.Name())
				if start == 0 {
					continue
				}
				entries[file.Name()] = &FileEntry{
					Path:      filepath.Join(CanonicalBlocksDir, file.Name()),
					StartTime: start,
					EndTime:   end,
					IsLocal:   true,
				}
			}
		}
	}

	// --- Source 2: S3 manifest (evicted blocks that live only on S3) ---
	if Cfg.S3.Enabled {
		for _, s3entry := range S3OnlyBlocks() {
			basename := s3entry.LocalFile
			if _, ok := entries[basename]; ok {
				// Block still exists locally too — just annotate the S3 key
				entries[basename].S3Key = s3entry.S3Key
				continue
			}
			// Block has been evicted — S3 only
			start, end := parseBlockTimes(basename)
			if start == 0 {
				continue
			}
			entries[basename] = &FileEntry{
				Path:      "", // no local copy
				StartTime: start,
				EndTime:   end,
				S3Key:     s3entry.S3Key,
				IsLocal:   false,
			}
		}
	}

	// Flatten to slice and sort newest-first.
	newCatalog := make([]FileEntry, 0, len(entries))
	for _, e := range entries {
		newCatalog = append(newCatalog, *e)
	}
	sort.Slice(newCatalog, func(i, j int) bool {
		return newCatalog[i].StartTime > newCatalog[j].StartTime
	})

	fileCatalog.Lock()
	fileCatalog.Files = newCatalog
	fileCatalog.Unlock()
}

// parseBlockTimes extracts StartTime and EndTime from a canonical block filename.
// Format: <start>_<end>_[...].json  — returns (0, 0) on parse failure.
func parseBlockTimes(name string) (int64, int64) {
	parts := strings.Split(name, "_")
	if len(parts) < 1 {
		return 0, 0
	}
	start, err := strconv.ParseInt(parts[0], 10, 64)
	if err != nil {
		return 0, 0
	}
	end := int64(0)
	if len(parts) > 1 {
		if v, err := strconv.ParseInt(parts[1], 10, 64); err == nil {
			end = v
		}
	}
	if end == 0 {
		end = start + 7200 // default 2-hour window
	}
	return start, end
}

// --- Utility Functions ---
func parseSize(sizeStr string) (int64, error) {
	sizeStr = strings.TrimSpace(strings.ToUpper(sizeStr))
	if sizeStr == "" {
		return 0, fmt.Errorf("empty size string")
	}
	endIndex := strings.IndexFunc(sizeStr, func(r rune) bool { return !unicode.IsDigit(r) && r != '.' })
	var numberStr string
	var unit string
	if endIndex == -1 {
		numberStr = sizeStr
		unit = ""
	} else {
		numberStr = sizeStr[:endIndex]
		unit = strings.TrimSpace(sizeStr[endIndex:])
	}
	val, err := strconv.ParseFloat(numberStr, 64)
	if err != nil {
		return 0, fmt.Errorf("invalid number format: %v", err)
	}
	switch unit {
	case "B", "":
		return int64(val), nil
	case "KB", "K":
		return int64(val * 1024), nil
	case "MB", "M":
		return int64(val * 1024 * 1024), nil
	case "GB", "G":
		return int64(val * 1024 * 1024 * 1024), nil
	case "TB", "T":
		return int64(val * 1024 * 1024 * 1024 * 1024), nil
	default:
		return 0, fmt.Errorf("unknown unit: %s", unit)
	}
}

// --- LRU Cache ---
type CacheItem struct {
	Key     string
	Value   *DiskBlock
	Size    int64
	Element *list.Element
}
type BlockCache struct {
	CapacityBytes int64
	CurrentBytes  int64
	items         map[string]*CacheItem
	evictList     *list.List
	mutex         sync.RWMutex
	ingestQueue   chan *CacheIngestRequest
}
type CacheIngestRequest struct {
	Key   string
	Block *DiskBlock
	Size  int64
}

func NewBlockCache(maxBytes int64) *BlockCache {
	cache := &BlockCache{CapacityBytes: maxBytes, items: make(map[string]*CacheItem), evictList: list.New(), ingestQueue: make(chan *CacheIngestRequest, 1000)}
	go cache.runCacheWorker()
	return cache
}
func (c *BlockCache) Get(key string) (*DiskBlock, bool) {
	c.mutex.Lock()
	defer c.mutex.Unlock()
	if item, ok := c.items[key]; ok {
		c.evictList.MoveToFront(item.Element)
		return item.Value, true
	}
	return nil, false
}
func (c *BlockCache) PutAsync(key string, block *DiskBlock, size int64) {
	select {
	case c.ingestQueue <- &CacheIngestRequest{Key: key, Block: block, Size: size}:
	default:
	}
}
func (c *BlockCache) runCacheWorker() {
	for req := range c.ingestQueue {
		c.mutex.Lock()
		if item, ok := c.items[req.Key]; ok {
			c.CurrentBytes -= item.Size
			c.CurrentBytes += req.Size
			item.Value = req.Block
			item.Size = req.Size
			c.evictList.MoveToFront(item.Element)
			c.prune(0)
			c.mutex.Unlock()
			continue
		}
		if c.CurrentBytes+req.Size > c.CapacityBytes {
			needed := (c.CurrentBytes + req.Size) - c.CapacityBytes
			c.prune(needed + req.Size)
		}
		if c.CurrentBytes+req.Size <= c.CapacityBytes {
			entry := &CacheItem{Key: req.Key, Value: req.Block, Size: req.Size}
			element := c.evictList.PushFront(entry)
			entry.Element = element
			c.items[req.Key] = entry
			c.CurrentBytes += req.Size
		}
		c.mutex.Unlock()
	}
}
func (c *BlockCache) prune(neededBytes int64) {
	freed := int64(0)
	for (c.CurrentBytes > c.CapacityBytes) || (neededBytes > 0 && freed < neededBytes) {
		ent := c.evictList.Back()
		if ent != nil {
			c.evictList.Remove(ent)
			item := ent.Value.(*CacheItem)
			delete(c.items, item.Key)
			c.CurrentBytes -= item.Size
			freed += item.Size
		} else {
			break
		}
	}
}
func (c *BlockCache) Stats() (int, int64) {
	c.mutex.RLock()
	defer c.mutex.RUnlock()
	return len(c.items), c.CurrentBytes
}

var ltsCache *BlockCache

func init() {
	// Register types for Gob encoding (must happen before any gob usage).
	gob.Register(map[string]interface{}{})
	gob.Register([]interface{}{})
}

// initQueryCache creates the LRU block cache from config.  Called from
// runQueryGateway() after LoadConfig() so Cfg.Query.MaxCacheSize is set.
func initQueryCache() {
	size, err := parseSize(Cfg.Query.MaxCacheSize)
	if err != nil {
		size = 1024 * 1024 * 1024 // 1 GB fallback
	}
	ltsCache = NewBlockCache(size)
}

// --- Symbol Metadata Cache ---
var symbolCache = struct {
	sync.RWMutex
	MetricNames map[string]bool
	LastUpdated time.Time
}{
	MetricNames: make(map[string]bool),
}

func runSymbolIndexer() {
	Logf("GATEWAY", "Starting background symbol indexer")
	ticker := time.NewTicker(Cfg.Query.SymbolRefreshInterval())
	defer ticker.Stop()
	refreshSymbolIndex()
	for range ticker.C {
		refreshSymbolIndex()
	}
}

func refreshSymbolIndex() {
	liveMetadata := fetchNodeMetadata()

	// Use the catalog now instead of scanning disk again
	fileCatalog.RLock()
	limit := 20
	if len(fileCatalog.Files) < limit {
		limit = len(fileCatalog.Files)
	}
	catalogSubset := fileCatalog.Files[:limit]
	fileCatalog.RUnlock()

	symbolCache.Lock()
	countNew := 0
	for _, meta := range liveMetadata {
		if name, ok := meta["__name__"]; ok {
			if !symbolCache.MetricNames[name] {
				symbolCache.MetricNames[name] = true
				countNew++
			}
		}
	}

	for _, entry := range catalogSubset {
		path := entry.Path
		content, err := ioutil.ReadFile(path)
		if err == nil {
			var block DiskBlock
			if json.Unmarshal(content, &block) == nil {
				for _, chunk := range block.ChunksData {
					if name, ok := chunk.Labels["__name__"]; ok {
						if !symbolCache.MetricNames[name] {
							symbolCache.MetricNames[name] = true
							countNew++
						}
					}
				}
			}
		}
	}
	symbolCache.LastUpdated = time.Now()
	symbolCache.Unlock()
	if countNew > 0 {
		Logf("GATEWAY", "Symbol indexer: +%d new metrics  total:%d unique", countNew, len(symbolCache.MetricNames))
	}
}

// --- Wasm Runtime (Unchanged) ---
type WasmWrapper struct{}

func InitializeWasm(modulePath string) (*WasmWrapper, error) {
	if _, err := os.Stat(modulePath); os.IsNotExist(err) {
		return nil, fmt.Errorf("Wasm module not found at %s", modulePath)
	}
	return &WasmWrapper{}, nil
}
func (w *WasmWrapper) CallWasmReconstruct(modelID int, t_reconstruct []float64, params []float64) ([]float64, error) {
	resultLen := len(t_reconstruct)
	result := make([]float64, resultLen)
	switch modelID {
	case 0:
		c := params[0]
		for i := 0; i < resultLen; i++ {
			result[i] = c
		}
	case 1:
		m, c := params[0], params[1]
		for i := 0; i < resultLen; i++ {
			result[i] = m*t_reconstruct[i] + c
		}
	case 2:
		a, b, c := params[0], params[1], params[2]
		for i := 0; i < resultLen; i++ {
			t_val := t_reconstruct[i]
			result[i] = a*t_val*t_val + b*t_val + c
		}
	default:
		return nil, fmt.Errorf("unknown model ID: %d", modelID)
	}
	return result, nil
}

var wasmInstance *WasmWrapper

// --- Reconstruction Logic ---
func synthesizeSeries(modelData ModelEntry) QueryResultEntry {
	n := Cfg.Query.SynthesizePoints
	tReconstruct := make([]float64, n)
	for i := 0; i < n; i++ {
		tReconstruct[i] = float64(i) * 5.0
	}
	reconstructedValues, _ := wasmInstance.CallWasmReconstruct(modelData.ModelID, tReconstruct, modelData.Params)
	seriesOutput := QueryResultEntry{Metric: modelData.Labels, Values: make([][]interface{}, n)}
	for i := 0; i < n; i++ {
		timestamp := modelData.TBase + tReconstruct[i]
		seriesOutput.Values[i] = []interface{}{timestamp, fmt.Sprintf("%.3f", reconstructedValues[i])}
	}
	return seriesOutput
}

// --- LTS File Scanning Logic (PARALLEL WORKER POOL) ---
func scanLTSBlocks(metricPrefix string, startTime int64, endTime int64) ([]QueryResultEntry, QueryStats) {
	// 1. Filter candidates from in-memory catalog (local + S3-resident)
	fileCatalog.RLock()
	var candidates []FileEntry
	for _, entry := range fileCatalog.Files {
		if endTime > 0 && entry.StartTime > endTime {
			continue
		}
		if startTime > 0 && entry.EndTime < startTime {
			continue
		}
		candidates = append(candidates, entry)
	}
	fileCatalog.RUnlock()

	if len(candidates) == 0 {
		return nil, QueryStats{}
	}

	// 2. Build a shared S3 client once (only if S3 is enabled)
	var s3c *S3Client
	if Cfg.S3.Enabled {
		if c, err := NewS3Client(); err == nil {
			s3c = c
		}
	}

	// 3. Spin up bounded worker pool
	numWorkers := Cfg.Query.LTSScanWorkers
	if numWorkers > len(candidates) {
		numWorkers = len(candidates)
	}

	jobs := make(chan FileEntry, len(candidates))
	resultsCh := make(chan ltsWorkerResult, len(candidates))

	var wg sync.WaitGroup
	for i := 0; i < numWorkers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for fe := range jobs {
				// Key for the LRU cache is always the block basename.
				var cacheKey string
				if fe.Path != "" {
					cacheKey = filepath.Base(fe.Path)
				} else {
					cacheKey = filepath.Base(fe.S3Key)
				}

				var block *DiskBlock
				wasCacheHit := false
				wasS3Hit := false

				// --- Tier 1: LRU memory cache ---
				if cachedBlock, hit := ltsCache.Get(cacheKey); hit {
					block = cachedBlock
					wasCacheHit = true
				}

				// --- Tier 2: local disk ---
				if block == nil && fe.IsLocal && fe.Path != "" {
					content, err := ioutil.ReadFile(fe.Path)
					if err == nil {
						var newBlock DiskBlock
						if json.Unmarshal(content, &newBlock) == nil {
							block = &newBlock
							ltsCache.PutAsync(cacheKey, block, int64(len(content)))
						}
					}
				}

				// --- Tier 3: S3 fetch (evicted blocks or S3-only) ---
				if block == nil && fe.S3Key != "" && s3c != nil {
					content, err := s3c.GetObject(fe.S3Key)
					if err == nil {
						var newBlock DiskBlock
						if json.Unmarshal(content, &newBlock) == nil {
							block = &newBlock
							wasS3Hit = true
							ltsCache.PutAsync(cacheKey, block, int64(len(content)))
						}
					} else {
						Logf("GATEWAY", "LTS S3 fetch failed for %s: %v", fe.S3Key, err)
					}
				}

				if block == nil {
					continue // block not available in any tier
				}

				var chunkResults []QueryResultEntry
				for _, chunk := range block.ChunksData {
					name, ok := chunk.Labels["__name__"]
					isMatch := false
					if ok {
						if strings.Contains(name, metricPrefix) {
							isMatch = true
						}
					} else {
						for _, v := range chunk.Labels {
							if strings.Contains(v, metricPrefix) {
								isMatch = true
								break
							}
						}
					}
					if isMatch {
						chunkResults = append(chunkResults, synthesizeSeries(chunk))
					}
				}

				resultsCh <- ltsWorkerResult{
					entries:  chunkResults,
					cacheHit: wasCacheHit,
					diskHit:  !wasCacheHit && !wasS3Hit,
					s3Hit:    wasS3Hit,
					matched:  len(chunkResults) > 0,
				}
			}
		}()
	}

	// 4. Feed jobs
	for _, fe := range candidates {
		jobs <- fe
	}
	close(jobs)

	// 5. Close results channel once all workers finish
	go func() {
		wg.Wait()
		close(resultsCh)
	}()

	// 6. Collect and aggregate results
	var allResults []QueryResultEntry
	stats := QueryStats{}
	matched := 0
	s3Hits  := 0

	for res := range resultsCh {
		if res.cacheHit {
			stats.CacheHits++
		}
		if res.diskHit {
			stats.DiskHits++
		}
		if res.s3Hit {
			s3Hits++
		}
		if res.matched {
			matched++
		}
		allResults = append(allResults, res.entries...)
	}

	Logf("GATEWAY", "LTS scan: %d blocks  workers:%d  cache:%d disk:%d s3:%d  matched:%d",
		len(candidates), numWorkers, stats.CacheHits, stats.DiskHits, s3Hits, matched)

	return allResults, stats
}

// --- Data Fetching Logic ---
func fetchNodeMetadata() []map[string]string {
	var allSeries []map[string]string
	var mu sync.Mutex
	var wg sync.WaitGroup
	client := http.Client{Timeout: 5 * time.Second}
	for _, cfg := range storageNodes {
		if cfg.Mode == "HEAD" && cfg.MetadataURL != "" {
			wg.Add(1)
			go func(url string) {
				defer wg.Done()
				resp, err := client.Get(url)
				if err != nil {
					return
				}
				defer resp.Body.Close()
				var nodeSeries []map[string]string
				if err := json.NewDecoder(resp.Body).Decode(&nodeSeries); err == nil {
					mu.Lock()
					allSeries = append(allSeries, nodeSeries...)
					mu.Unlock()
				}
			}(cfg.MetadataURL)
		}
	}
	wg.Wait()
	return allSeries
}

func fetchNodeData(ctx context.Context, nodeURL string, metric string, resultChan chan<- NodeResult) {
	queryURL := fmt.Sprintf("%s?query=%s", nodeURL, metric)
	client := http.Client{}
	req, err := http.NewRequestWithContext(ctx, "GET", queryURL, nil)
	if err != nil {
		resultChan <- NodeResult{Source: nodeURL, Err: fmt.Errorf("req error: %w", err)}
		return
	}

	resp, err := client.Do(req)
	if err != nil {
		resultChan <- NodeResult{Source: nodeURL, Err: fmt.Errorf("do error: %w", err)}
		return
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		resultChan <- NodeResult{Source: nodeURL, Err: fmt.Errorf("status %d", resp.StatusCode)}
		return
	}

	body, err := ioutil.ReadAll(resp.Body)

	var response HeadQueryResponse
	if err := json.Unmarshal(body, &response); err != nil {
		resultChan <- NodeResult{Source: nodeURL, Err: fmt.Errorf("json error: %w", err)}
		return
	}

	var finalSeries []QueryResultEntry
	for _, model := range response.Models {
		finalSeries = append(finalSeries, synthesizeSeries(model))
	}
	finalSeries = append(finalSeries, response.RawSeries...)
	stats := QueryStats{HeadHits: len(finalSeries)}
	resultChan <- NodeResult{Source: nodeURL, Series: finalSeries, Stats: stats}
}

func deduplicateAndMerge(results []NodeResult) ([]QueryResultEntry, QueryStats) {
	samplesByMetricKey := make(map[string]map[float64]float64)
	totalStats := QueryStats{}
	for _, nodeResult := range results {
		if nodeResult.Err != nil {
			continue
		}
		totalStats.HeadHits += nodeResult.Stats.HeadHits
		totalStats.CacheHits += nodeResult.Stats.CacheHits
		totalStats.DiskHits += nodeResult.Stats.DiskHits
		for _, series := range nodeResult.Series {
			labelsJSON, _ := json.Marshal(series.Metric)
			metricKey := string(labelsJSON)
			if _, ok := samplesByMetricKey[metricKey]; !ok {
				samplesByMetricKey[metricKey] = make(map[float64]float64)
			}
			for _, sample := range series.Values {
				if len(sample) != 2 {
					continue
				}
				timestamp, okT := sample[0].(float64)
				valueStr, okV := sample[1].(string)
				if okT && okV {
					value, _ := strconv.ParseFloat(valueStr, 64)
					samplesByMetricKey[metricKey][timestamp] = value
				}
			}
		}
	}
	finalResult := []QueryResultEntry{}
	for metricKey, samplesMap := range samplesByMetricKey {
		var sortedSamples [][]interface{}
		for t, v := range samplesMap {
			sortedSamples = append(sortedSamples, []interface{}{t, fmt.Sprintf("%.3f", v)})
		}
		sort.Slice(sortedSamples, func(i, j int) bool { return sortedSamples[i][0].(float64) < sortedSamples[j][0].(float64) })
		var metricLabels map[string]string
		json.Unmarshal([]byte(metricKey), &metricLabels)
		finalResult = append(finalResult, QueryResultEntry{Metric: metricLabels, Values: sortedSamples})
	}
	return finalResult, totalStats
}

// --- HTTP Handlers ---
func handleLabels(w http.ResponseWriter, r *http.Request) {
	setCORSHeaders(w)
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	symbolCache.RLock()
	defer symbolCache.RUnlock()
	json.NewEncoder(w).Encode(map[string]interface{}{"status": "success", "data": []string{"__name__"}})
}

func handleLabelValues(w http.ResponseWriter, r *http.Request) {
	setCORSHeaders(w)
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	parts := strings.Split(r.URL.Path, "/")
	if len(parts) < 5 {
		http.Error(w, "Invalid path", 400)
		return
	}
	label := parts[4]

	// Log the request for debugging
	Logf("GATEWAY", "Label-values request: %s", label)

	symbolCache.RLock()
	defer symbolCache.RUnlock()
	var res []string

	if label == "__name__" {
		for k := range symbolCache.MetricNames {
			res = append(res, k)
		}
		sort.Strings(res)

		// Force refresh if cache is empty and user asks for names
		if len(res) == 0 {
			go func() {
				// Trigger background refresh
			}()
			// Sync fetch for this request
			allSeries := fetchNodeMetadata()
			uniqueValues := make(map[string]bool)
			for _, labels := range allSeries {
				if v, ok := labels[label]; ok {
					uniqueValues[v] = true
				}
			}
			for k := range uniqueValues {
				res = append(res, k)
			}
		}
		json.NewEncoder(w).Encode(map[string]interface{}{"status": "success", "data": res})
		return
	}

	// Fallback for other labels
	allSeries := fetchNodeMetadata()
	uniqueValues := make(map[string]bool)
	for _, labels := range allSeries {
		if v, ok := labels[label]; ok {
			uniqueValues[v] = true
		}
	}
	for k := range uniqueValues {
		res = append(res, k)
	}
	json.NewEncoder(w).Encode(map[string]interface{}{"status": "success", "data": res})
}

func handleSeries(w http.ResponseWriter, r *http.Request) {
	setCORSHeaders(w)
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	json.NewEncoder(w).Encode(map[string]interface{}{"status": "success", "data": []string{}})
}
func handleMetadata(w http.ResponseWriter, r *http.Request) {
	setCORSHeaders(w)
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	json.NewEncoder(w).Encode(map[string]interface{}{"status": "success", "data": map[string]string{}})
}

func handleQuery(w http.ResponseWriter, r *http.Request) {
	setCORSHeaders(w)
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if r.Method != http.MethodGet && r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var rawQuery string
	if r.Method == http.MethodGet {
		rawQuery = r.URL.Query().Get("query")
	} else {
		if err := r.ParseForm(); err != nil {
			http.Error(w, "Failed to parse form", http.StatusBadRequest)
			return
		}
		rawQuery = r.FormValue("query")
	}

	if rawQuery == "" {
		// Allow empty queries to return empty success (Grafana heartbeat/check)
		json.NewEncoder(w).Encode(map[string]interface{}{"status": "success", "data": map[string]interface{}{"resultType": "matrix", "result": []interface{}{}}})
		return
	}

	if rawQuery == "1+1" {
		json.NewEncoder(w).Encode(map[string]interface{}{"status": "success", "data": map[string]interface{}{"resultType": "scalar", "result": []interface{}{time.Now().Unix(), "2"}}})
		return
	}

	cleanQuery := rawQuery
	cleanQuery = strings.ReplaceAll(cleanQuery, "sum(", "")
	cleanQuery = strings.ReplaceAll(cleanQuery, "rate(", "")
	cleanQuery = strings.ReplaceAll(cleanQuery, "irate(", "")
	cleanQuery = strings.ReplaceAll(cleanQuery, "avg(", "")
	cleanQuery = strings.ReplaceAll(cleanQuery, "min(", "")
	cleanQuery = strings.ReplaceAll(cleanQuery, "max(", "")
	cleanQuery = strings.ReplaceAll(cleanQuery, ")", "")
	reTime := regexp.MustCompile(`\[[0-9]+[smhd]\]`)
	cleanQuery = reTime.ReplaceAllString(cleanQuery, "")
	reLabels := regexp.MustCompile(`\{.*?\}`)
	cleanQuery = reLabels.ReplaceAllString(cleanQuery, "")
	metricPrefix := strings.TrimSpace(cleanQuery)

	var startTimeTS, endTimeTS int64
	if startStr := r.FormValue("start"); startStr != "" {
		if val, err := strconv.ParseFloat(startStr, 64); err == nil {
			startTimeTS = int64(val)
		}
	}
	if endStr := r.FormValue("end"); endStr != "" {
		if val, err := strconv.ParseFloat(endStr, 64); err == nil {
			endTimeTS = int64(val)
		}
	}

	// Log parsed query for debugging
	// fmt.Printf("[%s] PARSED QUERY: '%s' -> '%s' (Range: %d to %d)\n", time.Now().Format("15:04:05"), rawQuery, metricPrefix, startTimeTS, endTimeTS)

	startTime := time.Now()
	ctx, cancel := context.WithTimeout(context.Background(), time.Duration(Cfg.Query.TimeoutS)*time.Second)
	defer cancel()

	resultChan := make(chan NodeResult, len(storageNodes)+1)
	var wg sync.WaitGroup

	for _, cfg := range storageNodes {
		if cfg.Mode == "HEAD" {
			wg.Add(1)
			go func(url string) {
				defer wg.Done()
				fetchNodeData(ctx, url, metricPrefix, resultChan)
			}(cfg.URL)
		}
	}

	wg.Add(1)
	go func() {
		defer wg.Done()
		series, stats := scanLTSBlocks(metricPrefix, startTimeTS, endTimeTS)
		resultChan <- NodeResult{Source: "LTS_DISK", Series: series, Stats: stats}
	}()

	wg.Wait()
	close(resultChan)

	var allNodeResults []NodeResult
	for res := range resultChan {
		if res.Err != nil {
			Logf("GATEWAY", "Worker error [%s]: %v", res.Source, res.Err)
		}
		allNodeResults = append(allNodeResults, res)
	}

	finalSeries, totalStats := deduplicateAndMerge(allNodeResults)

	responseBody := map[string]interface{}{"status": "success", "data": map[string]interface{}{"resultType": "matrix", "result": finalSeries}}

	// Check Accept header for Gob or JSON
	accept := r.Header.Get("Accept")
	if strings.Contains(accept, "application/x-gob") {
		w.Header().Set("Content-Type", "application/x-gob")
		gob.NewEncoder(w).Encode(responseBody)
	} else {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(responseBody)
	}

	cacheCount, cacheSize := ltsCache.Stats()
	Logf("GATEWAY", "Query '%s' → %d series in %v  (head:%d cache:%d disk:%d  cache-items:%d %.1fMB/%s)",
		metricPrefix, len(finalSeries), time.Since(startTime).Round(time.Millisecond),
		totalStats.HeadHits, totalStats.CacheHits, totalStats.DiskHits,
		cacheCount, float64(cacheSize)/(1024*1024), Cfg.Query.MaxCacheSize)
}

func runQueryGateway() {
	// Build storage node map from config (requires config to be loaded first).
	storageNodes = map[string]StorageNodeConfig{
		"node_a_head":       {URL: Cfg.Query.HeadNodeURL + "/api/v1/query", MetadataURL: Cfg.Query.HeadNodeURL + "/internal/metadata", Mode: "HEAD"},
		"lts_index_service": {URL: Cfg.Query.IndexNodeURL + "/api/v1/index", Mode: "INDEX"},
	}

	// Initialise LRU block cache from config.
	initQueryCache()

	var err error
	wasmInstance, err = InitializeWasm(Cfg.Query.WasmModulePath)
	if err != nil {
		Logf("GATEWAY", "FATAL: %v", err)
		return
	}

	go runFileIndexer()
	go runSymbolIndexer()

	Logf("GATEWAY", "Wasm module: ready")
	Logf("GATEWAY", "Listening on 0.0.0.0:%d", Cfg.Server.QueryPort)
	http.HandleFunc("/api/v1/query", handleQuery)
	http.HandleFunc("/api/v1/query_range", handleQuery)
	http.HandleFunc("/api/v1/label/", handleLabelValues)
	http.HandleFunc("/api/v1/labels", handleLabels)
	http.HandleFunc("/api/v1/series", handleSeries)
	http.HandleFunc("/api/v1/metadata", handleMetadata)

	c := make(chan os.Signal, 1)
	signal.Notify(c, os.Interrupt, syscall.SIGTERM)
	go func() { <-c; Logf("GATEWAY", "Shutdown signal — stopping."); os.Exit(0) }()

	if err := http.ListenAndServe(fmt.Sprintf(":%d", Cfg.Server.QueryPort), nil); err != nil {
		Logf("GATEWAY", "ERROR: %v", err)
	}
}

func main() {
	LoadConfig("tsdb.yaml")
	PrintBanner("Query Gateway")
	runQueryGateway()
}
