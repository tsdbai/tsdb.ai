package main

import "net/http"

// setCORSHeaders sets permissive CORS headers so the React admin panel
// (running on any dev port) can call the backend APIs without browser errors.
// Must be called at the top of every HTTP handler before writing any response.
func setCORSHeaders(w http.ResponseWriter) {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization")
}
