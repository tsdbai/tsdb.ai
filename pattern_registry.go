package main

import (
	"encoding/json"
	"fmt"
	"io/ioutil"
	"math"
	"net/http"
	"sync"
	"time"
)

// =============================================================================
// Phase 3 — Pattern Fingerprint Registry
//
// Operators can tag the current behavioral shape of any metric with a human
// readable name (e.g., "memory_leak", "DDoS_spike", "expected_deploy_ramp").
// These named patterns are persisted to disk and automatically matched against
// every newly ingested vector — turning institutional knowledge into searchable
// semantic fingerprints.
// =============================================================================

// NOTE: PatternRegistryFile is declared in config.go (initPaths, under DataRoot).
// NOTE: PatternMatchThreshold, MaxPatternRegistrySize, PatternMaxAgeDays have
//       moved to tsdb.yaml / config.go as Cfg.Patterns.{MatchThreshold,MaxRegistrySize,MaxAgeDays}.

// PatternLabel is a named fingerprint.
type PatternLabel struct {
	ID           string    `json:"id"`
	Name         string    `json:"name"`
	Description  string    `json:"description"`
	Vector       []float64 `json:"vector"`
	Dimension    int       `json:"dimension"`
	TaggedBy     string    `json:"tagged_by"`
	TaggedAt     int64     `json:"tagged_at"`      // unix epoch when registered (preserved for compat)
	RegisteredAt int64     `json:"registered_at"`  // same as TaggedAt — explicit alias for clarity
	LastMatchedAt int64    `json:"last_matched_at"` // unix epoch of most recent cosine match; 0 = never matched
	MatchCount   int       `json:"match_count"`
}

// PatternRegistry is a thread-safe store of named patterns.
type PatternRegistry struct {
	mu       sync.RWMutex
	Patterns map[string]*PatternLabel `json:"patterns"`
}

var globalPatterns = &PatternRegistry{
	Patterns: make(map[string]*PatternLabel),
}

// --- Persistence ---

func loadPatternRegistry() {
	data, err := ioutil.ReadFile(PatternRegistryFile)
	if err != nil {
		seedMockPatternsIfEmpty()
		return
	}
	globalPatterns.mu.Lock()
	json.Unmarshal(data, globalPatterns)
	count := len(globalPatterns.Patterns)
	globalPatterns.mu.Unlock()
	fmt.Printf("[PATTERNS] Loaded %d named patterns from registry.\n", count)
	if count == 0 {
		seedMockPatternsIfEmpty()
	}
}

// seedMockPatternsIfEmpty pre-populates the pattern registry with named
// behavioral fingerprints for the mock metrics so MatchPatterns has something
// to compare against from the first ingested chunk.
// The background ingestion pipeline calls MatchPatterns on every compressed
// chunk — but with an empty registry every call is a no-op.
func seedMockPatternsIfEmpty() {
	now := time.Now().Unix()
	type seed struct {
		id     string
		name   string
		desc   string
		vector []float64
		by     string
	}
	seeds := []seed{
		{
			"pattern_steady_baseline_seed",
			"steady_baseline",
			"Normal operating state — constant model, minimal noise, fully stable regime",
			[]float64{0.0, 0.0, 50.2, 2.4, 2.5, 0.0, 0.0, 1.0},
			"system",
		},
		{
			"pattern_cpu_spike_seed",
			"cpu_spike",
			"Sudden quadratic surge in CPU — traffic burst or runaway process",
			[]float64{0.42, 0.18, 52.1, 14.2, 9.8, 1.0, 1.0, 0.3},
			"system",
		},
		{
			"pattern_memory_leak_seed",
			"memory_leak",
			"Steady linear memory growth — flat noise, stable regime, consistently climbing",
			[]float64{0.31, 0.0, 64.5, 3.1, 3.0, 1.0, 0.5, 0.9},
			"system",
		},
		{
			"pattern_traffic_surge_seed",
			"traffic_surge",
			"Fast-rising HTTP request rate — linear growth, moderate noise, regime shifting",
			[]float64{0.68, 0.22, 120.0, 18.5, 12.1, 1.0, 0.5, 0.5},
			"system",
		},
		{
			"pattern_error_storm_seed",
			"error_storm",
			"5xx error spike — high noise, quadratic complexity, unstable regime",
			[]float64{0.55, 0.31, 8.2, 42.7, 28.3, 1.0, 1.0, 0.2},
			"system",
		},
		{
			"pattern_queue_saturation_seed",
			"queue_saturation",
			"Queue depth approaching capacity — quadratic growth, increasingly noisy",
			[]float64{0.38, 0.12, 48.0, 11.4, 8.2, 1.0, 1.0, 0.4},
			"system",
		},
		{
			"pattern_request_drain_seed",
			"request_drain",
			"Declining request volume — possible upstream outage or routing change",
			[]float64{-0.29, 0.0, 95.0, 5.8, 5.5, -1.0, 0.5, 0.8},
			"system",
		},
	}

	globalPatterns.mu.Lock()
	defer globalPatterns.mu.Unlock()
	for _, s := range seeds {
		globalPatterns.Patterns[s.id] = &PatternLabel{
			ID:            s.id,
			Name:          s.name,
			Description:   s.desc,
			Vector:        s.vector,
			Dimension:     len(s.vector),
			TaggedBy:      s.by,
			TaggedAt:      now - 86400,
			RegisteredAt:  now - 86400,
			LastMatchedAt: 0,
			MatchCount:    0,
		}
	}
	fmt.Printf("[PATTERNS] Seeded %d mock patterns for initial matching.\n", len(seeds))
	// Persist immediately so the file exists for the next restart
	go func() {
		data, _ := json.MarshalIndent(globalPatterns, "", "  ")
		ioutil.WriteFile(PatternRegistryFile, data, 0644)
	}()
}

// prunePatternRegistry evicts patterns from globalPatterns.Patterns according
// to two independent rules (both can fire in the same pass):
//
//  1. Age-based: any pattern whose LastMatchedAt (or RegisteredAt if never
//     matched) is older than PatternMaxAgeDays is unconditionally removed.
//
//  2. Size-based: if the registry still exceeds MaxPatternRegistrySize after
//     the age pass, patterns are sorted by LastMatchedAt ascending (LRU) and
//     the oldest ones are removed until the registry fits within the cap.
//
// Must be called with globalPatterns.mu write-lock already held.
func prunePatternRegistry() {
	now := time.Now().Unix()
	ageCutoff := now - int64(Cfg.Patterns.MaxAgeDays*24*3600)

	// Pass 1 — age-based eviction
	removed := 0
	for id, p := range globalPatterns.Patterns {
		// Use LastMatchedAt if the pattern has ever been matched, otherwise
		// fall back to RegisteredAt so brand-new patterns aren't immediately
		// culled by the age rule.
		activity := p.LastMatchedAt
		if activity == 0 {
			activity = p.RegisteredAt
		}
		if activity > 0 && activity < ageCutoff {
			delete(globalPatterns.Patterns, id)
			removed++
		}
	}

	// Pass 2 — size cap (LRU eviction)
	if len(globalPatterns.Patterns) > Cfg.Patterns.MaxRegistrySize {
		// Build a slice of (id, activity) pairs, sorted oldest-first.
		type entry struct {
			id       string
			activity int64
		}
		entries := make([]entry, 0, len(globalPatterns.Patterns))
		for id, p := range globalPatterns.Patterns {
			act := p.LastMatchedAt
			if act == 0 {
				act = p.RegisteredAt
			}
			entries = append(entries, entry{id, act})
		}
		// Sort ascending by activity (oldest = lowest unix timestamp first)
		for i := 0; i < len(entries)-1; i++ {
			for j := i + 1; j < len(entries); j++ {
				if entries[j].activity < entries[i].activity {
					entries[i], entries[j] = entries[j], entries[i]
				}
			}
		}
		// Evict from the front until we're within the cap
		excess := len(globalPatterns.Patterns) - Cfg.Patterns.MaxRegistrySize
		for i := 0; i < excess; i++ {
			delete(globalPatterns.Patterns, entries[i].id)
			removed++
		}
	}

	if removed > 0 {
		fmt.Printf("[PATTERNS] Pruned %d pattern(s) — registry now has %d entries (max=%d, maxAgeDays=%d)\n",
			removed, len(globalPatterns.Patterns), Cfg.Patterns.MaxRegistrySize, Cfg.Patterns.MaxAgeDays)
	}
}

func savePatternRegistry() {
	globalPatterns.mu.Lock() // write lock — prunePatternRegistry mutates the map
	prunePatternRegistry()
	data, err := json.MarshalIndent(globalPatterns, "", "  ")
	globalPatterns.mu.Unlock()
	if err != nil {
		return
	}
	ioutil.WriteFile(PatternRegistryFile, data, 0644)
}

// --- Core Operations ---

// RegisterPattern stores a named pattern from the current enriched vector of
// a given metric.  Returns an error string if the metric has no HeadCache entry.
func RegisterPattern(metricString, name, description, taggedBy string) (string, error) {
	sid := globalSymbols.GetOrCreate(metricString)
	shard := state.GetShard(sid)

	shard.mu.RLock()
	entry, exists := shard.HeadCache[sid]
	rollingRMSE := shard.RollingRMSE[sid]
	shard.mu.RUnlock()

	if !exists {
		return "", fmt.Errorf("metric '%s' not found in HeadCache — ingest some data first", metricString)
	}

	// Build the enriched 8D vector (same logic as buildEnrichedEmbedding in main.go)
	vector := buildEnrichedEmbedding(entry, rollingRMSE, shard, sid)
	dim := len(vector)

	now := time.Now().Unix()
	patternID := fmt.Sprintf("pattern_%s_%d", name, time.Now().UnixNano())
	pattern := &PatternLabel{
		ID:            patternID,
		Name:          name,
		Description:   description,
		Vector:        vector,
		Dimension:     dim,
		TaggedBy:      taggedBy,
		TaggedAt:      now,
		RegisteredAt:  now,
		LastMatchedAt: 0, // never matched yet
		MatchCount:    0,
	}

	globalPatterns.mu.Lock()
	globalPatterns.Patterns[patternID] = pattern
	globalPatterns.mu.Unlock()

	go savePatternRegistry()

	return fmt.Sprintf("Pattern '%s' registered (id=%s, dim=%d)", name, patternID, dim), nil
}

// MatchPatterns checks a vector against all registered patterns and returns
// the names of any patterns that exceed the match threshold.
// Called by pushEnrichedVectorToVectorDB for every new chunk.
func MatchPatterns(vector []float64) []string {
	globalPatterns.mu.Lock()
	defer globalPatterns.mu.Unlock()

	now := time.Now().Unix()
	dim := len(vector)
	var matches []string

	for _, p := range globalPatterns.Patterns {
		if p.Dimension != dim {
			continue
		}
		score, err := CosineSimilarity(vector, p.Vector)
		if err != nil {
			continue
		}
		if score >= Cfg.Patterns.MatchThreshold {
			p.MatchCount++
			p.LastMatchedAt = now
			matches = append(matches, fmt.Sprintf("%s (%.3f)", p.Name, score))
		}
	}
	return matches
}

// ListPatterns returns all registered patterns sorted by match count.
func ListPatterns() []*PatternLabel {
	globalPatterns.mu.RLock()
	defer globalPatterns.mu.RUnlock()

	list := make([]*PatternLabel, 0, len(globalPatterns.Patterns))
	for _, p := range globalPatterns.Patterns {
		copy := *p
		list = append(list, &copy)
	}
	// Sort by match count descending (most-triggered patterns first)
	for i := 0; i < len(list)-1; i++ {
		for j := i + 1; j < len(list); j++ {
			if list[j].MatchCount > list[i].MatchCount {
				list[i], list[j] = list[j], list[i]
			}
		}
	}
	return list
}

// =============================================================================
// buildEnrichedEmbedding constructs the 8-dimensional vector used by Phase 3.
//
// Dimensions:
//   [0-2] polynomial params [a, b, c]
//   [3]   current RMSE
//   [4]   rolling RMSE (noise baseline)
//   [5]   direction flag: +1.0 growing, -1.0 declining, 0.0 flat
//   [6]   model complexity score: 0.0 / 0.5 / 1.0 for constant/linear/quadratic
//   [7]   regime stability: fraction of last N regime history entries matching
//         the current model (1.0 = fully stable, 0.0 = constantly changing)
//
// Exported so forecasting.go and main.go can both call it.
// =============================================================================

func buildEnrichedEmbedding(entry ModelEntry, rollingRMSE float64, shard *Shard, sid uint32) []float64 {
	params := entry.Params
	for len(params) < 3 {
		params = append(params, 0.0)
	}

	// Direction: evaluate model at t=100 vs t=0 to get sign of slope
	futureVal := evaluateModel(entry.ModelID, params, 100.0)
	currentVal := evaluateModel(entry.ModelID, params, 0.0)
	direction := 0.0
	delta := futureVal - currentVal
	if math.Abs(delta) > 0.001 {
		if delta > 0 {
			direction = 1.0
		} else {
			direction = -1.0
		}
	}

	// Model complexity score
	complexityScore := []float64{0.0, 0.5, 1.0}
	complexity := 0.0
	if entry.ModelID >= 0 && entry.ModelID < len(complexityScore) {
		complexity = complexityScore[entry.ModelID]
	}

	// Regime stability: fraction of recent history matching current model
	stability := 1.0 // default: fully stable (no history yet)
	if shard != nil {
		// shard.mu must NOT be held by caller — we take RLock ourselves only
		// if called outside of a locked context.  Since this is called from
		// RegisterPattern (no lock held) we read safely.
		shard.mu.RLock()
		hist := shard.RegimeHistory[sid]
		shard.mu.RUnlock()
		if len(hist) > 0 {
			matches := 0
			for _, id := range hist {
				if id == entry.ModelID {
					matches++
				}
			}
			stability = float64(matches) / float64(len(hist))
		}
	}

	return []float64{
		params[0],    // [0] a / slope
		params[1],    // [1] b / intercept
		params[2],    // [2] c / constant offset
		rollingRMSE, // [3] noise baseline
		rollingRMSE, // [4] same — split in future for instantaneous vs rolling
		direction,   // [5] +1 / 0 / -1
		complexity,  // [6] model complexity
		stability,   // [7] regime stability
	}
}

// =============================================================================
// HTTP Handlers
// =============================================================================

// handleLabelPattern serves POST /patterns/label
// Body: {"metric": "cpu_usage", "name": "memory_leak", "description": "...", "tagged_by": "alice"}
func handleLabelPattern(w http.ResponseWriter, r *http.Request) {
	setCORSHeaders(w)
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var req struct {
		Metric      string `json:"metric"`
		Name        string `json:"name"`
		Description string `json:"description"`
		TaggedBy    string `json:"tagged_by"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	if req.Metric == "" || req.Name == "" {
		http.Error(w, "metric and name are required", http.StatusBadRequest)
		return
	}
	if req.TaggedBy == "" {
		req.TaggedBy = "anonymous"
	}

	msg, err := RegisterPattern(req.Metric, req.Name, req.Description, req.TaggedBy)
	if err != nil {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusNotFound)
		json.NewEncoder(w).Encode(map[string]string{"status": "error", "error": err.Error()})
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"status": "success", "message": msg})
}

// handleListPatterns serves GET /patterns
func handleListPatterns(w http.ResponseWriter, r *http.Request) {
	setCORSHeaders(w)
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	patterns := ListPatterns()
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"status":  "success",
		"count":   len(patterns),
		"patterns": patterns,
	})
}
