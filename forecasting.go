package main

import (
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// =============================================================================
// Phase 1 — Forecasting Engine
//
// Uses the polynomial model already stored in HeadCache to project a metric's
// value forward in time.  Because every chunk is fit as y = f(t - t_base),
// forecasting is just evaluating the model at t_base + horizon.
//
// Confidence intervals widen with the square-root of lookahead / window size,
// scaled by the series' rolling RMSE.  This gives tighter bands for stable
// metrics and honest wide bands for volatile ones.
// =============================================================================

// ForecastResult is the response payload for a single metric forecast.
type ForecastResult struct {
	Metric          string  `json:"metric"`
	CurrentValue    float64 `json:"current_value"`
	PredictedValue  float64 `json:"predicted_value"`
	ConfidenceLow   float64 `json:"confidence_low"`
	ConfidenceHigh  float64 `json:"confidence_high"`
	HorizonSeconds  float64 `json:"horizon_seconds"`
	ModelID         int     `json:"model_id"`
	ModelName       string  `json:"model_name"`
	RollingRMSE     float64 `json:"rolling_rmse"`
	ForecastQuality string  `json:"forecast_quality"` // "HIGH", "MEDIUM", "LOW"
	TBase           float64 `json:"t_base"`
	GeneratedAt     int64   `json:"generated_at"`
}

// BatchForecastRequest is the body for /forecast_batch
type BatchForecastRequest struct {
	Metrics []string `json:"metrics"`
	Horizon float64  `json:"horizon_seconds"`
}

// BatchForecastResponse wraps multiple forecasts
type BatchForecastResponse struct {
	Status    string           `json:"status"`
	Count     int              `json:"count"`
	Forecasts []ForecastResult `json:"forecasts"`
	Errors    []string         `json:"errors,omitempty"`
}

// modelIDToName returns a human-readable model name
func modelIDToName(id int) string {
	switch id {
	case 0:
		return "Constant"
	case 1:
		return "Linear"
	case 2:
		return "Quadratic"
	default:
		return "Unknown"
	}
}

// evaluateModel evaluates y = f(tRel) for the given model ID and params.
// tRel is time relative to t_base (already shifted by caller).
func evaluateModel(modelID int, params []float64, tRel float64) float64 {
	switch modelID {
	case 0: // Constant: y = c
		if len(params) >= 1 {
			return params[0]
		}
	case 1: // Linear: y = m*t + c
		if len(params) >= 2 {
			return params[0]*tRel + params[1]
		}
	case 2: // Quadratic: y = a*t^2 + b*t + c
		if len(params) >= 3 {
			return params[0]*tRel*tRel + params[1]*tRel + params[2]
		}
	}
	return 0
}

// forecastQualityRating returns a quality label based on RMSE and model type.
// Lower RMSE and simpler models = higher confidence.
func forecastQualityRating(rollingRMSE float64, modelID int, horizonSeconds float64) string {
	// Confidence degrades with horizon: double the horizon ~= sqrt(2) wider band
	effectiveRMSE := rollingRMSE * math.Sqrt(horizonSeconds/100.0)
	switch {
	case effectiveRMSE < 5.0 && modelID <= 1:
		return "HIGH"
	case effectiveRMSE < 20.0 || modelID <= 1:
		return "MEDIUM"
	default:
		return "LOW"
	}
}

// ForecastSeries produces a ForecastResult for a single metric string.
// Returns (result, true) if the series exists in HeadCache, (zero, false) otherwise.
func ForecastSeries(metricString string, horizonSeconds float64) (ForecastResult, bool) {
	sid := globalSymbols.GetOrCreate(metricString)
	shard := state.GetShard(sid)

	shard.mu.RLock()
	entry, exists := shard.HeadCache[sid]
	rollingRMSE := shard.RollingRMSE[sid]
	shard.mu.RUnlock()

	if !exists {
		return ForecastResult{}, false
	}

	// Current value: evaluate model at t = 0 relative (i.e., at t_base)
	currentValue := evaluateModel(entry.ModelID, entry.Params, 0)

	// Predicted value: evaluate model at t = horizon relative to t_base
	predictedValue := evaluateModel(entry.ModelID, entry.Params, horizonSeconds)

	// Confidence interval: ±rmse * sqrt(horizon / window_size)
	// Cfg.Ingestion.SamplesPerSegment is the nominal window size
	windowSecs := float64(Cfg.Ingestion.SamplesPerSegment) // approximate: 1 sample/sec baseline
	confidence := rollingRMSE * math.Sqrt(horizonSeconds/windowSecs)
	if confidence < Cfg.Forecasting.ConfidenceFloor {
		confidence = Cfg.Forecasting.ConfidenceFloor
	}

	quality := forecastQualityRating(rollingRMSE, entry.ModelID, horizonSeconds)

	return ForecastResult{
		Metric:         metricString,
		CurrentValue:   currentValue,
		PredictedValue: predictedValue,
		ConfidenceLow:  predictedValue - confidence,
		ConfidenceHigh: predictedValue + confidence,
		HorizonSeconds: horizonSeconds,
		ModelID:        entry.ModelID,
		ModelName:      modelIDToName(entry.ModelID),
		RollingRMSE:    rollingRMSE,
		ForecastQuality: quality,
		TBase:          entry.TBase,
		GeneratedAt:    time.Now().Unix(),
	}, true
}

// =============================================================================
// HTTP Handlers
// =============================================================================

// handleForecast serves GET /forecast?metric=<name>&horizon=<seconds>
//
// Example: GET /forecast?metric=cpu_usage{host="web01"}&horizon=600
func handleForecast(w http.ResponseWriter, r *http.Request) {
	setCORSHeaders(w)
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	metricString := r.URL.Query().Get("metric")
	horizonStr := r.URL.Query().Get("horizon")

	if metricString == "" {
		http.Error(w, `{"error":"missing 'metric' parameter"}`, http.StatusBadRequest)
		return
	}

	horizonSeconds := Cfg.Forecasting.DefaultHorizonS
	if horizonStr != "" {
		if h, err := strconv.ParseFloat(horizonStr, 64); err == nil && h > 0 {
			horizonSeconds = h
		}
	}

	result, found := ForecastSeries(metricString, horizonSeconds)
	if !found {
		// Try prefix-matching: if metric has no labels, search for any series
		// whose __name__ matches — return the first hit
		result, found = forecastByPrefix(metricString, horizonSeconds)
	}

	if !found {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusNotFound)
		json.NewEncoder(w).Encode(map[string]string{
			"status": "error",
			"error":  fmt.Sprintf("no series found for metric '%s'", metricString),
		})
		return
	}

	w.Header().Set("Content-Type", "application/json")
	resp := map[string]interface{}{
		"status": "success",
		"data":   result,
	}
	json.NewEncoder(w).Encode(resp)
}

// handleForecastBatch serves POST /forecast_batch
// Body: {"metrics": ["cpu_usage", "mem_used"], "horizon_seconds": 600}
func handleForecastBatch(w http.ResponseWriter, r *http.Request) {
	setCORSHeaders(w)
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var req BatchForecastRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, fmt.Sprintf(`{"error":"%v"}`, err), http.StatusBadRequest)
		return
	}
	if req.Horizon <= 0 {
		req.Horizon = Cfg.Forecasting.DefaultHorizonS
	}
	if len(req.Metrics) == 0 {
		http.Error(w, `{"error":"metrics list is empty"}`, http.StatusBadRequest)
		return
	}

	var forecasts []ForecastResult
	var errors []string

	for _, m := range req.Metrics {
		result, found := ForecastSeries(m, req.Horizon)
		if !found {
			result, found = forecastByPrefix(m, req.Horizon)
		}
		if found {
			forecasts = append(forecasts, result)
		} else {
			errors = append(errors, fmt.Sprintf("no series found for '%s'", m))
		}
	}

	resp := BatchForecastResponse{
		Status:    "success",
		Count:     len(forecasts),
		Forecasts: forecasts,
		Errors:    errors,
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(resp)
}

// forecastByPrefix searches for the first series whose metric name starts with
// the given prefix (for queries that omit labels).
func forecastByPrefix(prefix string, horizonSeconds float64) (ForecastResult, bool) {
	// Walk all shards to find a matching series in HeadCache
	for i := 0; i < Cfg.Ingestion.NumShards; i++ {
		shard := &state.Shards[i]
		shard.mu.RLock()
		for sid, entry := range shard.HeadCache {
			ms := globalSymbols.Lookup(sid)
			if strings.HasPrefix(ms, prefix) {
				rollingRMSE := shard.RollingRMSE[sid]
				shard.mu.RUnlock()

				currentValue := evaluateModel(entry.ModelID, entry.Params, 0)
				predictedValue := evaluateModel(entry.ModelID, entry.Params, horizonSeconds)
				windowSecs := float64(Cfg.Ingestion.SamplesPerSegment)
				confidence := rollingRMSE * math.Sqrt(horizonSeconds/windowSecs)
				if confidence < Cfg.Forecasting.ConfidenceFloor {
					confidence = Cfg.Forecasting.ConfidenceFloor
				}

				return ForecastResult{
					Metric:          ms,
					CurrentValue:    currentValue,
					PredictedValue:  predictedValue,
					ConfidenceLow:   predictedValue - confidence,
					ConfidenceHigh:  predictedValue + confidence,
					HorizonSeconds:  horizonSeconds,
					ModelID:         entry.ModelID,
					ModelName:       modelIDToName(entry.ModelID),
					RollingRMSE:     rollingRMSE,
					ForecastQuality: forecastQualityRating(rollingRMSE, entry.ModelID, horizonSeconds),
					TBase:           entry.TBase,
					GeneratedAt:     time.Now().Unix(),
				}, true
			}
		}
		shard.mu.RUnlock()
	}
	return ForecastResult{}, false
}

// handleForecastAll serves GET /forecast_all?horizon=<seconds>
// Returns forecasts for every series currently in HeadCache.
// Useful for dashboard population and health scans.
func handleForecastAll(w http.ResponseWriter, r *http.Request) {
	setCORSHeaders(w)
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	horizonSeconds := Cfg.Forecasting.DefaultHorizonS
	if h, err := strconv.ParseFloat(r.URL.Query().Get("horizon"), 64); err == nil && h > 0 {
		horizonSeconds = h
	}

	var forecasts []ForecastResult

	for i := 0; i < Cfg.Ingestion.NumShards; i++ {
		shard := &state.Shards[i]
		shard.mu.RLock()
		for sid, entry := range shard.HeadCache {
			ms := globalSymbols.Lookup(sid)
			rollingRMSE := shard.RollingRMSE[sid]

			currentValue := evaluateModel(entry.ModelID, entry.Params, 0)
			predictedValue := evaluateModel(entry.ModelID, entry.Params, horizonSeconds)
			windowSecs := float64(Cfg.Ingestion.SamplesPerSegment)
			confidence := rollingRMSE * math.Sqrt(horizonSeconds/windowSecs)
			if confidence < Cfg.Forecasting.ConfidenceFloor {
				confidence = Cfg.Forecasting.ConfidenceFloor
			}

			forecasts = append(forecasts, ForecastResult{
				Metric:          ms,
				CurrentValue:    currentValue,
				PredictedValue:  predictedValue,
				ConfidenceLow:   predictedValue - confidence,
				ConfidenceHigh:  predictedValue + confidence,
				HorizonSeconds:  horizonSeconds,
				ModelID:         entry.ModelID,
				ModelName:       modelIDToName(entry.ModelID),
				RollingRMSE:     rollingRMSE,
				ForecastQuality: forecastQualityRating(rollingRMSE, entry.ModelID, horizonSeconds),
				TBase:           entry.TBase,
				GeneratedAt:     time.Now().Unix(),
			})
		}
		shard.mu.RUnlock()
	}

	resp := BatchForecastResponse{
		Status:    "success",
		Count:     len(forecasts),
		Forecasts: forecasts,
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(resp)
}
