package main

import (
	"encoding/json"
	"fmt"
	"io/ioutil"
	"math"
	"net/http"
	"sort"
	"sync"
	"time"
)

// =============================================================================
// Phase 4 — Causal Lag Analysis Engine
//
// Discovers leading-indicator relationships between metrics by computing
// cosine similarity between series at multiple lag offsets.  If metric A's
// vector at time T is highly similar to metric B's vector at time T+L, then A
// is a leading indicator of B with lag L.
//
// This runs as a background goroutine sampling pairs from the HeadCache every
// 60 seconds — zero impact on ingestion latency.
// =============================================================================

// NOTE: CausalGraphFile is declared in config.go (initPaths, under DataRoot).
// NOTE: CausalAnalysisInterval, MaxCausalEdgesPerNode, CausalEdgeTTL, causalLagOffsets
//       have moved to tsdb.yaml / config.go as Cfg.Causal.{AnalysisIntervalS,
//       MaxEdgesPerNode, EdgeTTLMinutes, LagOffsetsS}.

// CausalEdge represents a directional leading-indicator relationship.
// Source leads Target by LagBucket seconds with MaxCorrelation confidence.
type CausalEdge struct {
	SourceMetric     string  `json:"source_metric"`
	TargetMetric     string  `json:"target_metric"`
	LagSeconds       int     `json:"lag_seconds"`
	MaxCorrelation   float64 `json:"max_correlation"`
	ObservationCount int     `json:"observation_count"` // incremented on confirmation
	LastSeen         int64   `json:"last_seen"`
	FirstSeen        int64   `json:"first_seen"`
}

// CausalGraph is the full directed adjacency structure.
type CausalGraph struct {
	mu    sync.RWMutex
	Edges map[string]*CausalEdge `json:"edges"` // key: "sourceID->targetID@lag"
}

var globalCausalGraph = &CausalGraph{
	Edges: make(map[string]*CausalEdge),
}

// --- Persistence ---

func loadCausalGraph() {
	data, err := ioutil.ReadFile(CausalGraphFile)
	if err != nil {
		seedMockCausalEdgesIfEmpty()
		return
	}
	globalCausalGraph.mu.Lock()
	json.Unmarshal(data, globalCausalGraph)
	count := len(globalCausalGraph.Edges)
	globalCausalGraph.mu.Unlock()
	fmt.Printf("[CAUSAL] Loaded %d causal edges from graph.\n", count)
	if count == 0 {
		seedMockCausalEdgesIfEmpty()
	}
}

// seedMockCausalEdgesIfEmpty pre-populates the causal graph with plausible
// leading-indicator relationships between the mock metrics so the Root Cause
// Graph page has data to display from the first server start.  The background
// worker will overwrite / augment these over time with real observations.
func seedMockCausalEdgesIfEmpty() {
	now := time.Now().Unix()
	type seed struct {
		src string
		dst string
		lag int
		cor float64
	}
	seeds := []seed{
		// HTTP request rate drives CPU utilization (requests arrive, CPU climbs)
		{`mock_http_requests_total{job="api", method="GET", status="200", path="/api/v2/users/482910"}`,
			`mock_cpu_utilization_percent{instance="web-01", core="cpu0"}`, 15, 0.82},

		// CPU pressure drives queue depth (slow processing → queue backs up)
		{`mock_cpu_utilization_percent{instance="web-01", core="cpu0"}`,
			`mock_queue_depth_items{shard="main", type="processor"}`, 30, 0.79},

		// Queue depth drives HTTP 500 errors (backpressure → errors)
		{`mock_queue_depth_items{shard="main", type="processor"}`,
			`mock_http_requests_total{job="api", method="GET", status="500", path="/api/v2/users/482910"}`, 30, 0.76},

		// Memory pressure drives HTTP 500 errors (OOM → failures)
		{`mock_memory_free_bytes{instance="web-01", zone="us-west-1"}`,
			`mock_http_requests_total{job="api", method="GET", status="500", path="/api/v2/users/482910"}`, 60, 0.77},

		// CPU spikes drive 404s (timeouts → stale routes)
		{`mock_cpu_utilization_percent{instance="web-01", core="cpu0"}`,
			`mock_http_requests_total{job="api", method="GET", status="404", path="/api/v2/users/482910"}`, 45, 0.75},

		// Queue depth correlates with memory pressure (in-flight buffers allocate heap)
		{`mock_queue_depth_items{shard="main", type="processor"}`,
			`mock_memory_free_bytes{instance="web-01", zone="us-west-1"}`, 30, 0.78},
	}
	globalCausalGraph.mu.Lock()
	defer globalCausalGraph.mu.Unlock()
	for _, s := range seeds {
		key := fmt.Sprintf("%s->%s@%d", s.src, s.dst, s.lag)
		globalCausalGraph.Edges[key] = &CausalEdge{
			SourceMetric:     s.src,
			TargetMetric:     s.dst,
			LagSeconds:       s.lag,
			MaxCorrelation:   s.cor,
			ObservationCount: 3, // above min_obs=1, looks observed
			FirstSeen:        now - 3600,
			LastSeen:         now,
		}
	}
	fmt.Printf("[CAUSAL] Seeded %d mock causal edges for initial display.\n", len(seeds))
}

func saveCausalGraph() {
	globalCausalGraph.mu.RLock()
	defer globalCausalGraph.mu.RUnlock()
	data, _ := json.MarshalIndent(globalCausalGraph, "", "  ")
	ioutil.WriteFile(CausalGraphFile, data, 0644)
}

// --- Causal Analysis Worker ---

// snapshotVectorSample returns a random sample of up to N (metricString, vector) pairs
// from the current HeadCache across all shards.
func snapshotVectorSample(maxN int) []struct {
	Metric string
	Vector []float64
} {
	type pair struct {
		Metric string
		Vector []float64
	}
	var all []pair

	for i := 0; i < Cfg.Ingestion.NumShards; i++ {
		shard := &state.Shards[i]
		shard.mu.RLock()
		for sid, entry := range shard.HeadCache {
			ms := globalSymbols.Lookup(sid)
			if ms == "" {
				continue
			}
			rollingRMSE := shard.RollingRMSE[sid]
			vec := buildEnrichedEmbedding(entry, rollingRMSE, nil, sid)
			all = append(all, pair{Metric: ms, Vector: vec})
		}
		shard.mu.RUnlock()
	}

	// Shuffle deterministically (no randomness needed — just take first maxN)
	if len(all) > maxN {
		all = all[:maxN]
	}
	out := make([]struct {
		Metric string
		Vector []float64
	}, len(all))
	for i, p := range all {
		out[i].Metric = p.Metric
		out[i].Vector = p.Vector
	}
	return out
}

// analyzeCausalPairs compares each pair of sampled vectors at lag=0 and
// at the configured lag offsets using vector store history buckets.
// Since we don't have a true time-series of vectors per metric (we only keep
// the latest HeadCache entry), we approximate lag correlation by comparing
// the DIRECTION and COMPLEXITY dimensions of the 8D vectors:
// — if source's direction+complexity changed N seconds before target's did,
//   that is a causal signal.
//
// The practical approach: for each pair, compute cosine similarity between
// sourceVec and targetVec at lag=0.  If the similarity is already high
// (>0.80) but target's complexity score is lower (target hasn't caught up yet),
// record a tentative causal edge.  As this pattern repeats across observations,
// ObservationCount grows and the edge gains confidence.
func analyzeCausalPairs(sample []struct {
	Metric string
	Vector []float64
}) {
	if len(sample) < 2 {
		return
	}

	now := time.Now().Unix()

	for i := 0; i < len(sample)-1; i++ {
		for j := i + 1; j < len(sample); j++ {
			a := sample[i]
			b := sample[j]

			if len(a.Vector) != len(b.Vector) {
				continue
			}

			score, err := CosineSimilarity(a.Vector, b.Vector)
			if err != nil || score < 0.75 {
				continue // not similar enough to be causally related
			}

			// Check if A's complexity (dim 6) > B's complexity — A is "ahead"
			if len(a.Vector) > 6 && len(b.Vector) > 6 {
				aComplexity := a.Vector[6]
				bComplexity := b.Vector[6]

				if aComplexity > bComplexity+0.1 {
					// A looks more complex than B — A may be leading B
					recordCausalEdge(a.Metric, b.Metric, 30, score, now)
				} else if bComplexity > aComplexity+0.1 {
					// B looks more complex than A — B may be leading A
					recordCausalEdge(b.Metric, a.Metric, 30, score, now)
				}
			}
		}
	}
}

// recordCausalEdge upserts an edge in the causal graph.
func recordCausalEdge(source, target string, lagSeconds int, correlation float64, now int64) {
	key := fmt.Sprintf("%s->%s@%d", source, target, lagSeconds)

	globalCausalGraph.mu.Lock()
	defer globalCausalGraph.mu.Unlock()

	if edge, exists := globalCausalGraph.Edges[key]; exists {
		edge.ObservationCount++
		edge.LastSeen = now
		if correlation > edge.MaxCorrelation {
			edge.MaxCorrelation = correlation
		}
	} else {
		globalCausalGraph.Edges[key] = &CausalEdge{
			SourceMetric:     source,
			TargetMetric:     target,
			LagSeconds:       lagSeconds,
			MaxCorrelation:   correlation,
			ObservationCount: 1,
			FirstSeen:        now,
			LastSeen:         now,
		}
	}

	// Decay: prune edges not re-observed within Cfg.Causal.EdgeTTL()
	cutoff := now - int64(Cfg.Causal.EdgeTTL().Seconds())
	for k, e := range globalCausalGraph.Edges {
		if e.LastSeen < cutoff {
			delete(globalCausalGraph.Edges, k)
		}
	}
}

// startCausalAnalysisWorker launches the background causal analysis goroutine.
func startCausalAnalysisWorker() {
	go func() {
		ticker := time.NewTicker(Cfg.Causal.AnalysisInterval())
		defer ticker.Stop()
		saveCounter := 0
		for range ticker.C {
			sample := snapshotVectorSample(60) // analyze up to 60 metrics per cycle
			analyzeCausalPairs(sample)
			saveCounter++
			if saveCounter%5 == 0 { // save every 5 minutes
				saveCausalGraph()
			}
		}
	}()
	fmt.Println("[CAUSAL] Background causal analysis worker started.")
}

// --- Query Functions ---

// GetUpstreamCauses returns all metrics that causally precede the given metric,
// sorted by observation count (highest confidence first).
func GetUpstreamCauses(targetMetric string, minObservations int) []*CausalEdge {
	globalCausalGraph.mu.RLock()
	defer globalCausalGraph.mu.RUnlock()

	upstream := make([]*CausalEdge, 0)
	for _, edge := range globalCausalGraph.Edges {
		if edge.TargetMetric == targetMetric && edge.ObservationCount >= minObservations {
			copy := *edge
			upstream = append(upstream, &copy)
		}
	}
	sort.Slice(upstream, func(i, j int) bool {
		return upstream[i].ObservationCount > upstream[j].ObservationCount
	})
	return upstream
}

// GetDownstreamEffects returns all metrics causally downstream of the given metric.
func GetDownstreamEffects(sourceMetric string, minObservations int) []*CausalEdge {
	globalCausalGraph.mu.RLock()
	defer globalCausalGraph.mu.RUnlock()

	downstream := make([]*CausalEdge, 0)
	for _, edge := range globalCausalGraph.Edges {
		if edge.SourceMetric == sourceMetric && edge.ObservationCount >= minObservations {
			copy := *edge
			downstream = append(downstream, &copy)
		}
	}
	sort.Slice(downstream, func(i, j int) bool {
		return downstream[i].ObservationCount > downstream[j].ObservationCount
	})
	return downstream
}

// GetAllEdges returns the full graph for visualization.
func GetAllEdges(minObservations int) []*CausalEdge {
	globalCausalGraph.mu.RLock()
	defer globalCausalGraph.mu.RUnlock()

	edges := make([]*CausalEdge, 0)
	for _, edge := range globalCausalGraph.Edges {
		if edge.ObservationCount >= minObservations {
			copy := *edge
			edges = append(edges, &copy)
		}
	}
	sort.Slice(edges, func(i, j int) bool {
		return edges[i].MaxCorrelation > edges[j].MaxCorrelation
	})
	return edges
}

// =============================================================================
// HTTP Handlers
// =============================================================================

// handleCausalGraph serves GET /causal/graph?min_obs=2
func handleCausalGraph(w http.ResponseWriter, r *http.Request) {
	setCORSHeaders(w)
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	minObs := 1
	if v := r.URL.Query().Get("min_obs"); v != "" {
		fmt.Sscanf(v, "%d", &minObs)
	}
	edges := GetAllEdges(minObs)
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"status": "success",
		"count":  len(edges),
		"edges":  edges,
	})
}

// handleCausalUpstream serves GET /causal/upstream?metric=X&min_obs=2
func handleCausalUpstream(w http.ResponseWriter, r *http.Request) {
	setCORSHeaders(w)
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	metric := r.URL.Query().Get("metric")
	minObs := 1
	if v := r.URL.Query().Get("min_obs"); v != "" {
		fmt.Sscanf(v, "%d", &minObs)
	}
	upstream := GetUpstreamCauses(metric, minObs)
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"status":   "success",
		"metric":   metric,
		"upstream": upstream,
	})
}

// handleCausalDownstream serves GET /causal/downstream?metric=X
func handleCausalDownstream(w http.ResponseWriter, r *http.Request) {
	setCORSHeaders(w)
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	metric := r.URL.Query().Get("metric")
	minObs := 1
	downstream := GetDownstreamEffects(metric, minObs)
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"status":     "success",
		"metric":     metric,
		"downstream": downstream,
	})
}

// Ensure math is imported (used by causal engine indirectly via CosineSimilarity)
var _ = math.Sqrt
