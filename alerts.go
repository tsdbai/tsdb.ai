package main

// =============================================================================
// TSDB.ai Alert Engine
//
// Evaluates user-defined alert rules against live metric data every
// Cfg.Alerts.EvalIntervalS seconds.  Fired events are stored in a FIFO
// ring-buffer capped at Cfg.Alerts.MaxEvents and persisted to disk at
// AlertEventsFile.  Rules are persisted at AlertRulesFile.
//
// Condition types (match AlertBuilder.jsx):
//   threshold_above  — latest value > threshold
//   threshold_below  — latest value < threshold
//   rmse_above       — most recent RMSE > threshold
//   pct_change       — |now - Nmin_ago| / Nmin_ago * 100 > threshold
//   forecast_breach  — predicted value at horizon > threshold
//   regime_change    — a new model regime was detected recently
//   anomaly          — an anomaly event file exists for this metric in last N min
// =============================================================================

import (
	"bytes"
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// ---------------------------------------------------------------------------
// Data structures
// ---------------------------------------------------------------------------

type AlertRule struct {
	ID            string   `json:"id"`
	Name          string   `json:"name"`
	Metric        string   `json:"metric"`
	Condition     string   `json:"condition"`
	Threshold     float64  `json:"threshold"`
	WindowMinutes int      `json:"window_minutes"`
	Severity      string   `json:"severity"`
	Channels      []string `json:"channels"`
	Enabled       bool     `json:"enabled"`
}

type AlertEvent struct {
	ID        string    `json:"id"`
	RuleID    string    `json:"rule_id"`
	RuleName  string    `json:"rule_name"`
	Metric    string    `json:"metric"`
	Condition string    `json:"condition"`
	Severity  string    `json:"severity"`
	Value     float64   `json:"value"`
	Threshold float64   `json:"threshold"`
	Message   string    `json:"message"`
	FiredAt   time.Time `json:"fired_at"`
}

// ---------------------------------------------------------------------------
// Engine state
// ---------------------------------------------------------------------------

type alertEngine struct {
	mu       sync.RWMutex
	rules    []AlertRule
	events   []AlertEvent            // FIFO ring — oldest at index 0
	cooldown map[string]time.Time    // key: ruleID+":"+metric → last fired
}

var alerts = &alertEngine{
	cooldown: make(map[string]time.Time),
}

// ---------------------------------------------------------------------------
// Init — called from main startup
// ---------------------------------------------------------------------------

func initAlerts() {
	if err := os.MkdirAll(filepath.Dir(AlertRulesFile), 0755); err != nil {
		fmt.Printf("[ALERTS] could not create alerts dir: %v\n", err)
	}

	// Load persisted rules
	if data, err := os.ReadFile(AlertRulesFile); err == nil {
		var rules []AlertRule
		if json.Unmarshal(data, &rules) == nil {
			alerts.rules = rules
			fmt.Printf("[ALERTS] loaded %d alert rules\n", len(rules))
		}
	}

	// Load persisted events
	if data, err := os.ReadFile(AlertEventsFile); err == nil {
		var events []AlertEvent
		if json.Unmarshal(data, &events) == nil {
			alerts.events = events
			fmt.Printf("[ALERTS] loaded %d alert events\n", len(events))
		}
	}

	go runAlertEvaluator()
}

// ---------------------------------------------------------------------------
// Evaluator loop
// ---------------------------------------------------------------------------

func runAlertEvaluator() {
	interval := time.Duration(Cfg.Alerts.EvalIntervalS) * time.Second
	if interval <= 0 {
		interval = 30 * time.Second
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for range ticker.C {
		evaluateAllRules()
	}
}

func evaluateAllRules() {
	alerts.mu.RLock()
	rules := make([]AlertRule, len(alerts.rules))
	copy(rules, alerts.rules)
	alerts.mu.RUnlock()

	now := time.Now()
	cooldownDur := time.Duration(Cfg.Alerts.CooldownMinutes) * time.Minute

	for _, rule := range rules {
		if !rule.Enabled || rule.Metric == "" {
			continue
		}

		// Cooldown check
		ck := rule.ID + ":" + rule.Metric
		alerts.mu.RLock()
		lastFired, hasCooldown := alerts.cooldown[ck]
		alerts.mu.RUnlock()
		if hasCooldown && now.Sub(lastFired) < cooldownDur {
			continue
		}

		fired, val, msg := checkRule(rule, now)
		if !fired {
			continue
		}

		// Record the event
		ev := AlertEvent{
			ID:        fmt.Sprintf("%d", now.UnixNano()),
			RuleID:    rule.ID,
			RuleName:  rule.Name,
			Metric:    rule.Metric,
			Condition: rule.Condition,
			Severity:  rule.Severity,
			Value:     val,
			Threshold: rule.Threshold,
			Message:   msg,
			FiredAt:   now,
		}
		appendAlertEvent(ev)

		alerts.mu.Lock()
		alerts.cooldown[ck] = now
		alerts.mu.Unlock()

		fmt.Printf("[ALERTS] fired %s — %s — %s\n", rule.Severity, rule.Name, msg)
	}
}

// ---------------------------------------------------------------------------
// Rule checker — returns (fired, currentValue, humanMessage)
// ---------------------------------------------------------------------------

func checkRule(rule AlertRule, now time.Time) (bool, float64, string) {
	switch rule.Condition {
	case "threshold_above", "threshold_below":
		val, ok := currentMetricValue(rule.Metric, now)
		if !ok {
			return false, 0, ""
		}
		if rule.Condition == "threshold_above" && val > rule.Threshold {
			return true, val, fmt.Sprintf("%s = %.4g exceeds threshold %.4g", rule.Metric, val, rule.Threshold)
		}
		if rule.Condition == "threshold_below" && val < rule.Threshold {
			return true, val, fmt.Sprintf("%s = %.4g dropped below threshold %.4g", rule.Metric, val, rule.Threshold)
		}

	case "rmse_above":
		rmse, ok := currentMetricRMSE(rule.Metric)
		if !ok {
			return false, 0, ""
		}
		if rmse > rule.Threshold {
			return true, rmse, fmt.Sprintf("%s RMSE = %.4g exceeds limit %.4g", rule.Metric, rmse, rule.Threshold)
		}

	case "pct_change":
		win := rule.WindowMinutes
		if win <= 0 {
			win = 5
		}
		valNow, ok1 := currentMetricValue(rule.Metric, now)
		valOld, ok2 := currentMetricValue(rule.Metric, now.Add(-time.Duration(win)*time.Minute))
		if !ok1 || !ok2 || valOld == 0 {
			return false, 0, ""
		}
		pct := math.Abs((valNow-valOld)/valOld) * 100
		if pct > rule.Threshold {
			return true, pct, fmt.Sprintf("%s changed %.2f%% in %d min (threshold %.2f%%)", rule.Metric, pct, win, rule.Threshold)
		}

	case "forecast_breach":
		horizon := 300.0
		if rule.WindowMinutes > 0 {
			horizon = float64(rule.WindowMinutes) * 60
		}
		predicted, ok := forecastMetricValue(rule.Metric, horizon)
		if !ok {
			return false, 0, ""
		}
		if predicted > rule.Threshold {
			return true, predicted, fmt.Sprintf("%s forecast %.4g will exceed %.4g in %.0fs", rule.Metric, predicted, rule.Threshold, horizon)
		}

	case "regime_change":
		win := rule.WindowMinutes
		if win <= 0 {
			win = 15
		}
		if recentRegimeChange(rule.Metric, now, time.Duration(win)*time.Minute) {
			return true, 0, fmt.Sprintf("%s had a behavioral regime shift in the last %d min", rule.Metric, win)
		}

	case "anomaly":
		win := rule.WindowMinutes
		if win <= 0 {
			win = 15
		}
		if recentAnomaly(rule.Metric, now, time.Duration(win)*time.Minute) {
			return true, 0, fmt.Sprintf("%s anomaly detected in the last %d min", rule.Metric, win)
		}
	}

	return false, 0, ""
}

// ---------------------------------------------------------------------------
// Metric value helpers — evaluate polynomial model at a given time
// ---------------------------------------------------------------------------

// currentMetricValue finds the series matching metricName in the head cache
// and evaluates its polynomial at time t.
func currentMetricValue(metricName string, t time.Time) (float64, bool) {
	ts := float64(t.Unix())

	// Walk all shards looking for a series whose metric string contains metricName.
	// We do a prefix/substring match on the full metric label string.
	for i := 0; i < Cfg.Ingestion.NumShards; i++ {
		shard := &state.Shards[i]
		shard.mu.RLock()
		for sid, entry := range shard.HeadCache {
			fullName := globalSymbols.Lookup(sid)
			if !metricMatchesName(fullName, metricName) {
				continue
			}
			val := evalPolyAt(entry, ts)
			shard.mu.RUnlock()
			return val, true
		}
		shard.mu.RUnlock()
	}
	return 0, false
}

// currentMetricRMSE returns the most recent RMSE value for a metric.
func currentMetricRMSE(metricName string) (float64, bool) {
	for i := 0; i < Cfg.Ingestion.NumShards; i++ {
		shard := &state.Shards[i]
		shard.mu.RLock()
		for sid, hist := range shard.AnomalyHistory {
			fullName := globalSymbols.Lookup(sid)
			if !metricMatchesName(fullName, metricName) {
				continue
			}
			if len(hist.Rmses) == 0 {
				shard.mu.RUnlock()
				return 0, false
			}
			rmse := hist.Rmses[len(hist.Rmses)-1]
			shard.mu.RUnlock()
			return rmse, true
		}
		shard.mu.RUnlock()
	}
	return 0, false
}

// forecastMetricValue evaluates the polynomial model at now+horizonSeconds.
func forecastMetricValue(metricName string, horizonSeconds float64) (float64, bool) {
	t := float64(time.Now().Unix()) + horizonSeconds
	for i := 0; i < Cfg.Ingestion.NumShards; i++ {
		shard := &state.Shards[i]
		shard.mu.RLock()
		for sid, entry := range shard.HeadCache {
			fullName := globalSymbols.Lookup(sid)
			if !metricMatchesName(fullName, metricName) {
				continue
			}
			val := evalPolyAt(entry, t)
			shard.mu.RUnlock()
			return val, true
		}
		shard.mu.RUnlock()
	}
	return 0, false
}

// recentRegimeChange checks the regime event files for a recent shift.
func recentRegimeChange(metricName string, now time.Time, window time.Duration) bool {
	cutoff := now.Add(-window)
	entries, err := os.ReadDir(REGIME_CHANGE_DIR)
	if err != nil {
		return false
	}
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		info, err := e.Info()
		if err != nil {
			continue
		}
		if info.ModTime().Before(cutoff) {
			continue
		}
		if strings.Contains(e.Name(), sanitizeMetricForFilename(metricName)) {
			return true
		}
		// Also check file contents for metric name
		data, err := os.ReadFile(filepath.Join(REGIME_CHANGE_DIR, e.Name()))
		if err == nil && strings.Contains(string(data), metricName) {
			return true
		}
	}
	return false
}

// recentAnomaly checks the anomaly event files for a recent detection.
func recentAnomaly(metricName string, now time.Time, window time.Duration) bool {
	cutoff := now.Add(-window)
	entries, err := os.ReadDir(ANOMALY_DIR)
	if err != nil {
		return false
	}
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		info, err := e.Info()
		if err != nil {
			continue
		}
		if info.ModTime().Before(cutoff) {
			continue
		}
		data, err := os.ReadFile(filepath.Join(ANOMALY_DIR, e.Name()))
		if err == nil && strings.Contains(string(data), metricName) {
			return true
		}
	}
	return false
}

// ---------------------------------------------------------------------------
// Polynomial evaluation helper
// ---------------------------------------------------------------------------

// evalPolyAt evaluates a ModelEntry's polynomial at absolute Unix time t.
func evalPolyAt(entry ModelEntry, tAbs float64) float64 {
	tRel := tAbs - entry.TBase
	p := entry.Params
	switch len(p) {
	case 1: // constant
		return p[0]
	case 2: // linear: m*t + c
		return p[0]*tRel + p[1]
	case 3: // quadratic: a*t^2 + b*t + c
		return p[0]*tRel*tRel + p[1]*tRel + p[2]
	default:
		if len(p) == 0 {
			return 0
		}
		// Higher-order: evaluate as polynomial
		val := 0.0
		for i, coef := range p {
			val += coef * math.Pow(tRel, float64(len(p)-1-i))
		}
		return val
	}
}

// metricMatchesName returns true if the full metric string (e.g.
// `cpu_usage{instance="web-01"}`) matches the user-supplied name.
// Supports exact match, prefix match, and substring match on metric name only.
func metricMatchesName(full, name string) bool {
	if full == name {
		return true
	}
	// Extract bare metric name (before first `{`)
	bare := full
	if idx := strings.IndexByte(full, '{'); idx >= 0 {
		bare = full[:idx]
	}
	return bare == name || strings.HasPrefix(bare, name)
}

// sanitizeMetricForFilename removes characters not safe in filenames.
func sanitizeMetricForFilename(s string) string {
	var b bytes.Buffer
	for _, r := range s {
		if r == '{' || r == '}' || r == '"' || r == ',' || r == ' ' {
			b.WriteByte('_')
		} else {
			b.WriteRune(r)
		}
	}
	return b.String()
}

// ---------------------------------------------------------------------------
// FIFO event ring
// ---------------------------------------------------------------------------

func appendAlertEvent(ev AlertEvent) {
	alerts.mu.Lock()
	defer alerts.mu.Unlock()

	max := Cfg.Alerts.MaxEvents
	if max <= 0 {
		max = 500
	}

	alerts.events = append(alerts.events, ev)
	// Trim oldest entries when over cap (FIFO)
	if len(alerts.events) > max {
		trim := len(alerts.events) - max
		alerts.events = alerts.events[trim:]
	}

	persistAlertEventsLocked()
}

// ---------------------------------------------------------------------------
// Persistence (must be called with mu held for writes)
// ---------------------------------------------------------------------------

func persistAlertEventsLocked() {
	data, err := json.MarshalIndent(alerts.events, "", "  ")
	if err != nil {
		return
	}
	_ = os.WriteFile(AlertEventsFile, data, 0644)
}

func persistAlertRules() {
	alerts.mu.RLock()
	data, err := json.MarshalIndent(alerts.rules, "", "  ")
	alerts.mu.RUnlock()
	if err != nil {
		return
	}
	_ = os.WriteFile(AlertRulesFile, data, 0644)
}

// ---------------------------------------------------------------------------
// HTTP handlers
// ---------------------------------------------------------------------------

// GET /api/alert_rules  — return current rules
// POST /api/alert_rules — replace rules
func handleAlertRules(w http.ResponseWriter, r *http.Request) {
	setCORSHeaders(w)
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	w.Header().Set("Content-Type", "application/json")

	switch r.Method {
	case http.MethodGet:
		alerts.mu.RLock()
		rules := alerts.rules
		if rules == nil {
			rules = []AlertRule{}
		}
		alerts.mu.RUnlock()
		_ = json.NewEncoder(w).Encode(rules)

	case http.MethodPost:
		var incoming []AlertRule
		if err := json.NewDecoder(r.Body).Decode(&incoming); err != nil {
			http.Error(w, "invalid JSON", http.StatusBadRequest)
			return
		}
		alerts.mu.Lock()
		alerts.rules = incoming
		alerts.mu.Unlock()
		persistAlertRules()
		w.WriteHeader(http.StatusNoContent)

	default:
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}

// GET    /api/alert_events          — return events (newest first)
// DELETE /api/alert_events          — clear all events
func handleAlertEvents(w http.ResponseWriter, r *http.Request) {
	setCORSHeaders(w)
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	w.Header().Set("Content-Type", "application/json")

	switch r.Method {
	case http.MethodGet:
		alerts.mu.RLock()
		// Return newest first
		evs := make([]AlertEvent, len(alerts.events))
		for i, ev := range alerts.events {
			evs[len(alerts.events)-1-i] = ev
		}
		alerts.mu.RUnlock()
		if evs == nil {
			evs = []AlertEvent{}
		}
		_ = json.NewEncoder(w).Encode(evs)

	case http.MethodDelete:
		alerts.mu.Lock()
		alerts.events = []AlertEvent{}
		persistAlertEventsLocked()
		alerts.mu.Unlock()
		w.WriteHeader(http.StatusNoContent)

	default:
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}

// GetString is needed by the alert engine to resolve uint32 sid → metric string.
// It's a thin wrapper around the global symbol table.
func (st *SymbolTable) GetString(id uint32) string {
	st.mu.RLock()
	defer st.mu.RUnlock()
	return st.idToString[id]
}
