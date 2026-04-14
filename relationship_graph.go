package main

import (
	"encoding/json"
	"fmt"
	"io/ioutil"
	"net/http"
	"sort"
	"sync"
	"time"
)

// =============================================================================
// Phase 4 — Metric Relationship Graph
//
// Builds an undirected similarity graph where nodes are metrics and edges
// connect pairs whose 8D enriched vectors exceed a cosine similarity threshold.
// Unlike the CausalGraph (which is directional and lag-based), this graph
// captures structural behavioral coupling — metrics that tend to look alike.
//
// A background worker scans a sample of HeadCache vectors every 90 seconds.
// =============================================================================

// NOTE: RelationshipGraphFile is declared in config.go (initPaths, under DataRoot).
// NOTE: RelationshipScanInterval, RelationshipMinScore, RelationshipMaxEdgesTotal,
//       RelationshipEdgeTTL have moved to tsdb.yaml / config.go as
//       Cfg.Relationships.{ScanIntervalS, MinScore, MaxEdgesTotal, EdgeTTLMinutes}.

// RelationshipEdge is an undirected edge between two behaviorally similar metrics.
type RelationshipEdge struct {
	MetricA      string  `json:"metric_a"`
	MetricB      string  `json:"metric_b"`
	PeakScore    float64 `json:"peak_score"`
	LatestScore  float64 `json:"latest_score"`
	FirstSeen    int64   `json:"first_seen"`
	LastSeen     int64   `json:"last_seen"`
	SeenCount    int     `json:"seen_count"`
}

// RelationshipGraph stores all structural similarity edges.
type RelationshipGraph struct {
	mu    sync.RWMutex
	Edges map[string]*RelationshipEdge `json:"edges"` // key: "metricA||metricB" (sorted)
}

var globalRelGraph = &RelationshipGraph{
	Edges: make(map[string]*RelationshipEdge),
}

// edgeKey returns a canonical, order-independent key for an edge between two metrics.
func edgeKey(a, b string) string {
	if a < b {
		return a + "||" + b
	}
	return b + "||" + a
}

// --- Persistence ---

func loadRelationshipGraph() {
	data, err := ioutil.ReadFile(RelationshipGraphFile)
	if err != nil {
		return
	}
	globalRelGraph.mu.Lock()
	defer globalRelGraph.mu.Unlock()
	json.Unmarshal(data, globalRelGraph)
	fmt.Printf("[RELGRAPH] Loaded %d relationship edges.\n", len(globalRelGraph.Edges))
}

func saveRelationshipGraph() {
	globalRelGraph.mu.RLock()
	defer globalRelGraph.mu.RUnlock()
	data, _ := json.MarshalIndent(globalRelGraph, "", "  ")
	ioutil.WriteFile(RelationshipGraphFile, data, 0644)
}

// --- Background Scanner ---

func startRelationshipGraphWorker() {
	go func() {
		ticker := time.NewTicker(Cfg.Relationships.ScanInterval())
		defer ticker.Stop()
		saveCounter := 0
		for range ticker.C {
			scanRelationships()
			saveCounter++
			if saveCounter%4 == 0 { // save every ~6 minutes
				saveRelationshipGraph()
			}
		}
	}()
	fmt.Println("[RELGRAPH] Background relationship graph worker started.")
}

func scanRelationships() {
	sample := snapshotVectorSample(80) // reuse causal engine's sampler
	now := time.Now().Unix()

	for i := 0; i < len(sample)-1; i++ {
		for j := i + 1; j < len(sample); j++ {
			a := sample[i]
			b := sample[j]
			if len(a.Vector) != len(b.Vector) {
				continue
			}
			score, err := CosineSimilarity(a.Vector, b.Vector)
			if err != nil || score < Cfg.Relationships.MinScore {
				continue
			}
			upsertRelationshipEdge(a.Metric, b.Metric, score, now)
		}
	}

	// Prune edges not re-confirmed within RelationshipEdgeTTL and enforce cap
	globalRelGraph.mu.Lock()
	cutoff := now - int64(Cfg.Relationships.EdgeTTL().Seconds())
	for k, e := range globalRelGraph.Edges {
		if e.LastSeen < cutoff {
			delete(globalRelGraph.Edges, k)
		}
	}
	// Enforce cap: delete lowest-scoring edges if over limit
	if len(globalRelGraph.Edges) > Cfg.Relationships.MaxEdgesTotal {
		type kv struct {
			k     string
			score float64
		}
		var pairs []kv
		for k, e := range globalRelGraph.Edges {
			pairs = append(pairs, kv{k, e.LatestScore})
		}
		sort.Slice(pairs, func(i, j int) bool { return pairs[i].score < pairs[j].score })
		for _, p := range pairs[:len(pairs)-Cfg.Relationships.MaxEdgesTotal] {
			delete(globalRelGraph.Edges, p.k)
		}
	}
	globalRelGraph.mu.Unlock()
}

func upsertRelationshipEdge(a, b string, score float64, now int64) {
	key := edgeKey(a, b)
	globalRelGraph.mu.Lock()
	defer globalRelGraph.mu.Unlock()

	if edge, exists := globalRelGraph.Edges[key]; exists {
		edge.LatestScore = score
		edge.LastSeen = now
		edge.SeenCount++
		if score > edge.PeakScore {
			edge.PeakScore = score
		}
	} else {
		globalRelGraph.Edges[key] = &RelationshipEdge{
			MetricA:     a,
			MetricB:     b,
			PeakScore:   score,
			LatestScore: score,
			FirstSeen:   now,
			LastSeen:    now,
			SeenCount:   1,
		}
	}
}

// --- Query Functions ---

// GetRelatedMetrics returns all metrics structurally similar to the given one.
func GetRelatedMetrics(metric string, minScore float64) []*RelationshipEdge {
	globalRelGraph.mu.RLock()
	defer globalRelGraph.mu.RUnlock()

	var results []*RelationshipEdge
	for _, edge := range globalRelGraph.Edges {
		if (edge.MetricA == metric || edge.MetricB == metric) && edge.LatestScore >= minScore {
			copy := *edge
			results = append(results, &copy)
		}
	}
	sort.Slice(results, func(i, j int) bool {
		return results[i].LatestScore > results[j].LatestScore
	})
	return results
}

// =============================================================================
// HTTP Handlers
// =============================================================================

// handleRelationships serves GET /relationships?metric=X&min_score=0.85
func handleRelationships(w http.ResponseWriter, r *http.Request) {
	setCORSHeaders(w)
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	metric   := r.URL.Query().Get("metric")
	minScore := Cfg.Relationships.MinScore
	if v := r.URL.Query().Get("min_score"); v != "" {
		fmt.Sscanf(v, "%f", &minScore)
	}

	if metric == "" {
		// Return all edges
		globalRelGraph.mu.RLock()
		edges := make([]*RelationshipEdge, 0, len(globalRelGraph.Edges))
		for _, e := range globalRelGraph.Edges {
			if e.LatestScore >= minScore {
				copy := *e
				edges = append(edges, &copy)
			}
		}
		globalRelGraph.mu.RUnlock()
		sort.Slice(edges, func(i, j int) bool { return edges[i].LatestScore > edges[j].LatestScore })
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{
			"status": "success",
			"count":  len(edges),
			"edges":  edges,
		})
		return
	}

	related := GetRelatedMetrics(metric, minScore)
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"status":  "success",
		"metric":  metric,
		"count":   len(related),
		"related": related,
	})
}
