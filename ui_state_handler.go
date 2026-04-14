package main

import (
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// uiStateMu guards concurrent reads/writes to ui_state.json.
// The file is small (chat history + chart specs) so a single mutex is fine.
var uiStateMu sync.RWMutex

// uiStatePath returns the path to ui_state.json inside the TSDB data root.
// If DataRoot is not yet set it falls back to the current directory.
func uiStatePath() string {
	root := DataRoot
	if root == "" {
		root = "."
	}
	return filepath.Join(root, "ui_state.json")
}

// handleGetUIState serves the persisted admin-panel state.
//
//	GET /internal/ui_state
//
// Returns the raw JSON from ui_state.json, or an empty skeleton if the file
// does not exist yet.
func handleGetUIState(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	setCORSHeaders(w)

	uiStateMu.RLock()
	data, err := os.ReadFile(uiStatePath())
	uiStateMu.RUnlock()

	w.Header().Set("Content-Type", "application/json")

	if os.IsNotExist(err) {
		// First run — return empty skeleton so the UI knows the endpoint works.
		w.Write([]byte(`{"version":1,"sessions":[],"dashboards":[],"currentSessionId":null}`))
		return
	}
	if err != nil {
		http.Error(w, "could not read ui_state.json: "+err.Error(), http.StatusInternalServerError)
		return
	}

	w.Write(data)
}

// handlePostUIState persists the admin-panel state sent from the browser.
//
//	POST /internal/ui_state
//	Content-Type: application/json
//	Body: full UI state JSON
//
// The handler validates that the body is valid JSON, then writes it
// atomically (temp file + rename) to avoid corruption on crash.
func handlePostUIState(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	setCORSHeaders(w)

	// 10 MB cap — chat history + chart specs should never get anywhere near this.
	body, err := io.ReadAll(io.LimitReader(r.Body, 10<<20))
	if err != nil {
		http.Error(w, "could not read body: "+err.Error(), http.StatusBadRequest)
		return
	}

	// Reject invalid JSON before touching the file.
	var probe interface{}
	if err := json.Unmarshal(body, &probe); err != nil {
		http.Error(w, "invalid JSON: "+err.Error(), http.StatusBadRequest)
		return
	}

	// Atomic write: write to a temp file then rename into place so a crash
	// during write never leaves a corrupted ui_state.json.
	path := uiStatePath()
	tmp := path + ".tmp"

	uiStateMu.Lock()
	defer uiStateMu.Unlock()

	if err := os.WriteFile(tmp, body, 0644); err != nil {
		http.Error(w, "could not write temp file: "+err.Error(), http.StatusInternalServerError)
		return
	}
	if err := os.Rename(tmp, path); err != nil {
		http.Error(w, "could not rename temp file: "+err.Error(), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"ok":      true,
		"savedAt": time.Now().UTC().Format(time.RFC3339),
		"bytes":   len(body),
	})
}
