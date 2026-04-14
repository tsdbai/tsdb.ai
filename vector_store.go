package main

import (
	"fmt"
	"math"
	"sort"
	"strconv"
	"sync"
	"time"
)

// --- Core Data Structures ---

type VectorEntry struct {
	ID        string            `json:"id"`
	Vector    []float64         `json:"vector"` // Model parameters — 3D legacy or 8D enriched
	Metadata  map[string]string `json:"metadata"`
	LastSeen  int64             `json:"last_seen"`
	Frequency int               `json:"frequency"`
	// Phase 3: dimension tag prevents comparing 3D legacy vs 8D enriched vectors.
	// 0 means unset (treated as len(Vector) for backward compat).
	Dimension int               `json:"dimension"`
}

type SearchResult struct {
	ID        string            `json:"id"`
	Score     float64           `json:"score"` // 1.0 = identical, -1.0 = opposite
	Metadata  map[string]string `json:"metadata"`
}

// VectorStore is a thread-safe, in-memory vector database
type VectorStore struct {
	entries map[string]*VectorEntry // Changed to pointer to allow in-place updates
	mutex   sync.RWMutex
}

// NewVectorStore initializes the store
func NewVectorStore() *VectorStore {
	return &VectorStore{
		entries: make(map[string]*VectorEntry),
	}
}

// --- Math Engine ---

// CosineSimilarity calculates the cosine similarity between two vectors.
func CosineSimilarity(a, b []float64) (float64, error) {
	if len(a) != len(b) {
		return 0, fmt.Errorf("vector dimensions mismatch: %d vs %d", len(a), len(b))
	}

	var dotProduct, normA, normB float64
	for i := range a {
		dotProduct += a[i] * b[i]
		normA += a[i] * a[i]
		normB += b[i] * b[i]
	}

	if normA == 0 || normB == 0 {
		// If one vector is zero-magnitude (flat line at 0), cosine similarity is undefined/0
		return 0, nil 
	}

	return dotProduct / (math.Sqrt(normA) * math.Sqrt(normB)), nil
}

// IsInteresting checks if a vector represents significant behavior.
// Returns false if the vector is "boring" (e.g., flat line or near-zero slope).
func IsInteresting(vector []float64) bool {
	// Heuristic: If magnitude (norm) is very small, it's likely noise or a flat line at 0.
	// For Linear [m, c], if m is near 0, it's a constant line.
	// For Quadratic [a, b, c], if a and b are near 0, it's constant.
	
	// Calculate magnitude of the "shape" parameters (ignoring the offset 'c' usually at end/start depending on model)
	// Assuming params are [a, b, c] for quadratic, or [m, c, 0] for linear.
	// We care about the rate of change (a, b).
	
	// Simple check: sum of absolute values of first N-1 parameters
	var changeMagnitude float64
	for i := 0; i < len(vector)-1; i++ {
		changeMagnitude += math.Abs(vector[i])
	}
	
	// Threshold for "interestingness" — see tsdb.yaml vectors.interesting_threshold
	return changeMagnitude > Cfg.Vectors.InterestingThreshold
}

// --- Store Operations ---

// entryDimension returns the effective dimension of an entry, handling the
// legacy case where Dimension was not set (defaults to len(Vector)).
func entryDimension(e *VectorEntry) int {
	if e.Dimension > 0 {
		return e.Dimension
	}
	return len(e.Vector)
}

// SmartInsert adds a vector only if it's unique and interesting.
// Returns status string: "STORED", "MERGED", "IGNORED"
func (s *VectorStore) SmartInsert(id string, vector []float64, meta map[string]string) (string, error) {
	// 1. Filter Boring Vectors
	if !IsInteresting(vector) {
		return "IGNORED (Low Interest)", nil
	}

	dim := len(vector)
	s.mutex.Lock()
	defer s.mutex.Unlock()

	// 2. Semantic Deduplication — only compare same-dimension entries
	// (threshold: tsdb.yaml vectors.match_threshold)
	for _, entry := range s.entries {
		if entryDimension(entry) != dim {
			continue // Phase 3: never compare 3D legacy vs 8D enriched
		}
		score, _ := CosineSimilarity(vector, entry.Vector)
		if score > Cfg.Vectors.MatchThreshold {
			entry.LastSeen = time.Now().Unix()
			entry.Frequency++
			return fmt.Sprintf("MERGED with %s (Score: %.4f)", entry.ID, score), nil
		}
	}

	// 3. Store New Unique Vector
	s.entries[id] = &VectorEntry{
		ID:        id,
		Vector:    vector,
		Metadata:  meta,
		LastSeen:  time.Now().Unix(),
		Frequency: 1,
		Dimension: dim,
	}
	return "STORED (New Pattern)", nil
}

// Search performs a brute-force k-NN search using Cosine Similarity.
// Only compares entries whose dimension matches the query vector.
func (s *VectorStore) Search(queryVector []float64, topK int) ([]SearchResult, error) {
	return s.SearchByDimension(queryVector, topK, len(queryVector))
}

// SearchByDimension is like Search but explicitly specifies which dimension
// bucket to search.  Pass -1 to search across ALL dimensions (legacy behaviour).
func (s *VectorStore) SearchByDimension(queryVector []float64, topK int, dimension int) ([]SearchResult, error) {
	s.mutex.RLock()
	defer s.mutex.RUnlock()

	var results []SearchResult

	for _, entry := range s.entries {
		// Phase 3: dimension isolation
		if dimension != -1 && entryDimension(entry) != dimension {
			continue
		}
		if len(entry.Vector) != len(queryVector) {
			continue // guard against residual mismatches
		}

		score, err := CosineSimilarity(queryVector, entry.Vector)
		if err != nil {
			continue
		}

		metaCopy := make(map[string]string)
		for k, v := range entry.Metadata {
			metaCopy[k] = v
		}
		metaCopy["frequency"] = strconv.Itoa(entry.Frequency)
		metaCopy["dimension"] = strconv.Itoa(entryDimension(entry))

		results = append(results, SearchResult{
			ID:       entry.ID,
			Score:    score,
			Metadata: metaCopy,
		})
	}

	sort.Slice(results, func(i, j int) bool {
		return results[i].Score > results[j].Score
	})

	if len(results) > topK {
		return results[:topK], nil
	}
	return results, nil
}

// List returns all vectors in the store, optionally filtered by model type
// filterModelID: -1 for all, or specific ID (e.g., 2 for Quadratic)
func (s *VectorStore) List(filterModelID int) []VectorEntry {
	s.mutex.RLock()
	defer s.mutex.RUnlock()

	var allEntries []VectorEntry
	
	for _, entry := range s.entries {
		// Filter Logic
		if filterModelID != -1 {
			// Check if metadata has "model_id" and if it matches
			if val, ok := entry.Metadata["model_id"]; ok {
				// Convert string metadata to int for comparison
				if id, err := strconv.Atoi(val); err == nil {
					if id != filterModelID {
						continue // Skip if ID doesn't match
					}
				}
			} else {
				// If filtering is requested but entry has no model_id, skip it
				continue 
			}
		}
		
		// Copy entry to return safe slice
		allEntries = append(allEntries, *entry)
	}
	return allEntries
}
