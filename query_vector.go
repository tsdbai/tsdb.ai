package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
)

// NOTE: VectorPort has moved to tsdb.yaml / config.go as Cfg.Server.VectorPort.

// --- API Request/Response Structures ---

type IngestVectorRequest struct {
	ID       string            `json:"id"`
	Vector   []float64         `json:"vector"`
	Metadata map[string]string `json:"metadata"`
}

type SearchVectorRequest struct {
	Vector []float64 `json:"vector"`
	TopK   int       `json:"top_k"`
}

type SearchResponse struct {
	Status  string         `json:"status"`
	Results []SearchResult `json:"results"`
}

// Global Store Instance
var store = NewVectorStore()

// --- Handlers ---

func handleIngestVector(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var req IngestVectorRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "Invalid JSON", http.StatusBadRequest)
		return
	}

	if len(req.Vector) == 0 || req.ID == "" {
		http.Error(w, "Missing ID or Vector data", http.StatusBadRequest)
		return
	}

	// Use SmartInsert for AI-Native Deduplication
	status, err := store.SmartInsert(req.ID, req.Vector, req.Metadata)
	if err != nil {
		http.Error(w, fmt.Sprintf("Ingest error: %v", err), http.StatusInternalServerError)
		return
	}
	
	w.WriteHeader(http.StatusOK)
	w.Write([]byte(fmt.Sprintf("Vector processed: %s", status)))
	
	fmt.Printf("[VECTOR] Ingest Request %s: %s\n", req.ID, status)
}

func handleSearchVector(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var req SearchVectorRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "Invalid JSON", http.StatusBadRequest)
		return
	}

	if req.TopK <= 0 {
		req.TopK = 5 // Default to top 5
	}

	results, err := store.Search(req.Vector, req.TopK)
	if err != nil {
		http.Error(w, fmt.Sprintf("Search failed: %v", err), http.StatusInternalServerError)
		return
	}

	resp := SearchResponse{
		Status:  "success",
		Results: results,
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(resp)
	
	fmt.Printf("[VECTOR] Search executed. Found %d matches.\n", len(results))
}

// handleListVectors returns all vectors, optionally filtered by 'model' query param
func handleListVectors(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	
	// Parse optional 'model' filter
	filterID := -1
	modelParam := r.URL.Query().Get("model")
	if modelParam != "" {
		if id, err := strconv.Atoi(modelParam); err == nil {
			filterID = id
		} else {
			http.Error(w, "Invalid model ID parameter (must be integer)", http.StatusBadRequest)
			return
		}
	}

	vectors := store.List(filterID)
	
	resp := map[string]interface{}{
		"status": "success",
		"count":  len(vectors),
		"filter_model_id": filterID,
		"data":   vectors,
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(resp)
	
	fmt.Printf("[VECTOR] List executed (Filter: %d). Returned %d vectors.\n", filterID, len(vectors))
}


func main() {
	LoadConfig("tsdb.yaml")
	fmt.Println("--- Vector Database Service (AI-Native Layer) ---")
	fmt.Printf("Listening on :%d\n", Cfg.Server.VectorPort)
	fmt.Println("Endpoints: /ingest (Smart Dedupe), /search, /vectors (List)")
	fmt.Println("-------------------------------------------------")

	http.HandleFunc("/ingest", handleIngestVector)
	http.HandleFunc("/search", handleSearchVector)
	http.HandleFunc("/vectors", handleListVectors) // NEW Endpoint

	if err := http.ListenAndServe(fmt.Sprintf(":%d", Cfg.Server.VectorPort), nil); err != nil {
		fmt.Printf("FATAL ERROR: %v\n", err)
	}
}
