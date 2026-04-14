// TSDB.ai API layer — returns null on all failures (no mock fallbacks).
// Pages must handle null themselves and show appropriate empty/offline states.

const BASE = import.meta.env.VITE_TSDB_URL || ''

async function get(path) {
  try {
    const r = await fetch(BASE + path, { signal: AbortSignal.timeout(4000) })
    if (!r.ok) throw new Error(r.status)
    return await r.json()
  } catch {
    return null
  }
}

async function post(path, body) {
  try {
    const r = await fetch(BASE + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(4000),
    })
    if (!r.ok) throw new Error(r.status)
    return await r.json()
  } catch {
    return null
  }
}

// ─── Backend health check ─────────────────────────────────────────────────────
// Returns true if the ingestor/query server is reachable.
export async function checkBackendOnline() {
  try {
    const r = await fetch(BASE + '/internal/metrics', { signal: AbortSignal.timeout(3000) })
    return r.ok
  } catch {
    return false
  }
}

// ─── Operational Metrics ──────────────────────────────────────────────────────
export async function fetchSystemMetrics() {
  return get('/internal/metrics')
}

// ─── Metric Names ─────────────────────────────────────────────────────────────
// NOTE: /api/v1/label/__name__/values lives on the Query Gateway (port 8081),
// not the Ingestor (port 8080). The Vite proxy routes /qgw/* → 8081 with the
// /qgw prefix stripped, so we use that path in dev. In production the reverse
// proxy must expose the query gateway under the same /qgw prefix.
export async function fetchMetricNames() {
  return get('/qgw/api/v1/label/__name__/values')
}

// ─── Forecast ────────────────────────────────────────────────────────────────
export async function fetchForecast(metric, horizon = 300) {
  return get(`/forecast?metric=${encodeURIComponent(metric)}&horizon=${horizon}`)
}

export async function fetchForecastAll(horizon = 300) {
  return get(`/forecast_all?horizon=${horizon}`)
}

// ─── Anomalies ───────────────────────────────────────────────────────────────
export async function fetchAnomalies() {
  return get('/internal/anomalies')
}

// ─── Regime Changes ───────────────────────────────────────────────────────────
export async function fetchRegimeChanges() {
  return get('/internal/regime_changes')
}

// ─── Patterns ─────────────────────────────────────────────────────────────────
export async function fetchPatterns() {
  return get('/patterns')
}

export async function registerPattern(metric, name, description, taggedBy = 'admin') {
  return post('/patterns/label', { metric, name, description, tagged_by: taggedBy })
}

// ─── Causal Graph ─────────────────────────────────────────────────────────────
export async function fetchCausalGraph() {
  return get('/causal/graph?min_obs=1')
}

// ─── Live Config ──────────────────────────────────────────────────────────────
export async function fetchLiveConfig() {
  return get('/internal/config')
}

// Save a tsdb.yaml string to disk via the backend.
// Returns { ok: true, restart_required: true } on success, null on failure.
export async function saveConfig(yamlText) {
  try {
    const r = await fetch('/internal/config', {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: yamlText,
      signal: AbortSignal.timeout(8000),
    })
    if (!r.ok) throw new Error(r.status)
    return await r.json()
  } catch {
    return null
  }
}

// ─── Notification Configs (stored in localStorage) ────────────────────────────
export function getNotificationConfigs() {
  try { return JSON.parse(localStorage.getItem('tsdb_notif_configs') || '[]') }
  catch { return [] }
}
export function saveNotificationConfigs(configs) {
  localStorage.setItem('tsdb_notif_configs', JSON.stringify(configs))
}

// ─── Alert Rules (persisted on backend) ───────────────────────────────────────
export async function getAlertRules() {
  try {
    const r = await fetch('/api/alert_rules')
    return r.ok ? r.json() : []
  } catch { return [] }
}
export async function saveAlertRules(rules) {
  try {
    await fetch('/api/alert_rules', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(rules),
    })
  } catch { /* best-effort */ }
}

// ─── Alert Events (read from backend, clearable) ──────────────────────────────
export async function getAlertEvents() {
  try {
    const r = await fetch('/api/alert_events')
    return r.ok ? r.json() : []
  } catch { return [] }
}
export async function clearAlertEvents() {
  try {
    await fetch('/api/alert_events', { method: 'DELETE' })
  } catch { /* best-effort */ }
}

// ─── AI / LLM Credentials ─────────────────────────────────────────────────────
export function getAICredentials() {
  try { return JSON.parse(localStorage.getItem('tsdb_ai_creds') || '{}') }
  catch { return {} }
}
export function saveAICredentials(creds) {
  localStorage.setItem('tsdb_ai_creds', JSON.stringify(creds))
}

// ─── License ──────────────────────────────────────────────────────────────────

// Fetch the live license status from the backend (validated offline by the binary).
export async function fetchLicenseStatus() {
  return get('/internal/license')
}

// These are kept for Settings.jsx — the key field there is informational.
// Real license validation is done by the Go binary reading tsdb.yaml.
export function getLicenseKey() {
  return localStorage.getItem('tsdb_license_key') || ''
}
export function setLicenseKey(key) {
  localStorage.setItem('tsdb_license_key', key)
}

// Legacy shim — real license state comes from useLicense() / LicenseContext.
export function isPro() { return false }
