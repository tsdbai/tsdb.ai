/**
 * contextEngine.js
 *
 * Mirrors the data surface of the Python MCP server (tsdb_mcp_server.py) by
 * calling the underlying Go HTTP endpoints directly from the browser.
 *
 * Endpoints used:
 *   Ingestor  :8080  /internal/metrics  /internal/head_cache
 *                    /anomalies  /regime_changes  /patterns
 *                    /forecast   /forecast_all    /relationships
 *                    /causal/graph
 *   Query GW  :8081  /api/v1/label/__name__/values
 *                    /api/v1/query_range
 *   Vector DB :8085  /search  (POST)
 */

// ─── URL helpers ──────────────────────────────────────────────────────────────

function withPort(baseUrl, port) {
  try {
    const u = new URL(baseUrl)
    u.port = String(port)
    return u.origin  // strips trailing slash
  } catch {
    return baseUrl
  }
}

function getUrls() {
  const base = localStorage.getItem('tsdb_backend_url') || 'http://localhost:8080'
  return {
    ingestor: withPort(base, 8080),
    query:    withPort(base, 8081),
    vector:   withPort(base, 8085),
  }
}

// ─── Safe fetch wrapper ───────────────────────────────────────────────────────

async function sf(url, opts = {}) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(4000), ...opts })
    if (!res.ok) return null
    return await res.json()
  } catch {
    return null
  }
}

// ─── Individual fetchers ──────────────────────────────────────────────────────

export async function fetchOperationalMetrics() {
  const { ingestor } = getUrls()
  return sf(`${ingestor}/internal/metrics`)
}

export async function fetchHeadCache() {
  const { ingestor } = getUrls()
  return sf(`${ingestor}/internal/metadata`)
}

export async function fetchAnomalyList() {
  const { ingestor } = getUrls()
  return sf(`${ingestor}/internal/anomalies`)
}

export async function fetchRegimeChangeList() {
  const { ingestor } = getUrls()
  return sf(`${ingestor}/internal/regime_changes`)
}

export async function fetchPatternRegistry() {
  const { ingestor } = getUrls()
  return sf(`${ingestor}/patterns`)
}

export async function fetchCausalEdges() {
  const { ingestor } = getUrls()
  return sf(`${ingestor}/causal/graph?min_obs=1`)
}

export async function fetchRelationshipGraph() {
  const { ingestor } = getUrls()
  return sf(`${ingestor}/relationships`)
}

export async function fetchForecastSummary(horizon = 300) {
  const { ingestor } = getUrls()
  return sf(`${ingestor}/forecast_all?horizon=${horizon}`)
}

export async function fetchAvailableMetrics() {
  const { query } = getUrls()
  const d = await sf(`${query}/api/v1/label/__name__/values`)
  return d?.data || []
}

/**
 * searchMetricNames(query)
 *
 * Live HTTP search against TSDB's Query Gateway.  Returns all metric names
 * whose names contain `query` (case-insensitive substring match).
 *
 * The Prometheus-compatible endpoint `/api/v1/label/__name__/values` returns
 * the full list; we filter client-side since TSDB doesn't expose a search
 * parameter on that endpoint.  For very large deployments (10k+ metrics) this
 * still completes in <50ms — the list is just strings.
 *
 * Example:  searchMetricNames("cpu")
 *   → ["cpu_idle", "cpu_usage", "container_cpu_throttle", …]
 */
export async function searchMetricNames(query = '') {
  const all = await fetchAvailableMetrics()
  if (!query) return all
  const lower = query.toLowerCase()
  return all.filter(name => name.toLowerCase().includes(lower))
}

// ─── Single-metric detail ─────────────────────────────────────────────────────

export async function fetchMetricForecast(metricName, horizon = 300) {
  const { ingestor } = getUrls()
  return sf(`${ingestor}/forecast?metric=${encodeURIComponent(metricName)}&horizon=${horizon}`)
}

export async function fetchMetricSeries(metricName, durationSeconds = 3600) {
  const { query } = getUrls()
  const end   = Math.floor(Date.now() / 1000)
  const start = end - durationSeconds
  const step  = Math.max(15, Math.floor(durationSeconds / 300))
  const url   = `${query}/api/v1/query_range?query=${encodeURIComponent(metricName)}&start=${start}&end=${end}&step=${step}`
  const d = await sf(url)
  return d?.data?.result || []
}

/**
 * queryMetricForChart(metricName, durationSeconds, step?)
 *
 * Fetches a metric from the TSDB Query Gateway and formats the result
 * as recharts-ready series objects: { name, labels, data: [{t, v}] }
 *
 * This is the shared query helper used by toolEngine.js and AIDashboard.jsx.
 */
export async function queryMetricForChart(metricName, durationSeconds = 3600, step = null) {
  const { query } = getUrls()
  const end = Math.floor(Date.now() / 1000)
  const start = end - durationSeconds
  const resolvedStep = step ?? Math.max(15, Math.floor(durationSeconds / 300))
  const url = `${query}/api/v1/query_range` +
    `?query=${encodeURIComponent(metricName)}&start=${start}&end=${end}&step=${resolvedStep}`
  let json
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(6000) })
    json = await res.json()
  } catch {
    return []
  }
  return (json?.data?.result || []).map(series => ({
    name: series.metric.__name__ || metricName,
    labels: series.metric,
    data: series.values.map(([ts, v]) => ({
      t: new Date(ts * 1000).toLocaleTimeString('en', { hour: '2-digit', minute: '2-digit' }),
      v: parseFloat(v),
    })),
  }))
}

// ─── Vector DB similarity search ──────────────────────────────────────────────
// Mirrors `find_historical_incidents` and `correlate_service_metrics` from
// the MCP server.  We compute a simple quadratic shape vector from recent
// series data, then search the vector DB for similar historical patterns.

function polyfit2(values) {
  const n = values.length
  if (n < 3) return null
  // Simple quadratic regression: y = a*x^2 + b*x + c
  // using normal equations (small n, no need for full numpy)
  let sx = 0, sx2 = 0, sx3 = 0, sx4 = 0
  let sy = 0, sxy = 0, sx2y = 0
  for (let i = 0; i < n; i++) {
    const x = i, y = values[i]
    sx += x; sx2 += x*x; sx3 += x*x*x; sx4 += x*x*x*x
    sy += y; sxy += x*y; sx2y += x*x*y
  }
  // [sx4 sx3 sx2][a]   [sx2y]
  // [sx3 sx2 sx ][b] = [sxy ]
  // [sx2 sx  n  ][c]   [sy  ]
  const A = [
    [sx4, sx3, sx2],
    [sx3, sx2, sx ],
    [sx2, sx,  n  ],
  ]
  const b = [sx2y, sxy, sy]
  // Gaussian elimination (3x3)
  for (let col = 0; col < 3; col++) {
    let maxRow = col
    for (let row = col + 1; row < 3; row++) {
      if (Math.abs(A[row][col]) > Math.abs(A[maxRow][col])) maxRow = row
    }
    ;[A[col], A[maxRow]] = [A[maxRow], A[col]]
    ;[b[col], b[maxRow]] = [b[maxRow], b[col]]
    for (let row = col + 1; row < 3; row++) {
      const factor = A[row][col] / A[col][col]
      for (let k = col; k < 3; k++) A[row][k] -= factor * A[col][k]
      b[row] -= factor * b[col]
    }
  }
  const c3 = b[2] / A[2][2]
  const c2 = (b[1] - A[1][2] * c3) / A[1][1]
  const c1 = (b[0] - A[0][1] * c2 - A[0][2] * c3) / A[0][0]
  return [c1, c2, c3]  // [a, b, c] — quadratic coefficients
}

export async function vectorSearchSimilar(metricName, topK = 5) {
  const { vector } = getUrls()
  const series = await fetchMetricSeries(metricName, 300)
  if (!series.length) return []
  const values = series[0].values?.map(([, v]) => parseFloat(v)) || []
  const vec = polyfit2(values)
  if (!vec) return []
  const d = await sf(`${vector}/search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ vector: vec, top_k: topK }),
  })
  return d?.results || []
}

// ─── Full context bundle ──────────────────────────────────────────────────────
// Fetches every data layer in parallel. Returns a context object used to
// build the AI system prompt.

export async function fetchFullContext() {
  const [
    metrics, headCache, anomalies, regimeChanges,
    patterns, causal, relationships, forecastAll, metricNames,
  ] = await Promise.allSettled([
    fetchOperationalMetrics(),
    fetchHeadCache(),
    fetchAnomalyList(),
    fetchRegimeChangeList(),
    fetchPatternRegistry(),
    fetchCausalEdges(),
    fetchRelationshipGraph(),
    fetchForecastSummary(),
    fetchAvailableMetrics(),
  ])

  return {
    metrics:       metrics.status       === 'fulfilled' ? metrics.value       : null,
    headCache:     headCache.status     === 'fulfilled' ? headCache.value     : null,
    anomalies:     anomalies.status     === 'fulfilled' ? anomalies.value     : null,
    regimeChanges: regimeChanges.status === 'fulfilled' ? regimeChanges.value : null,
    patterns:      patterns.status      === 'fulfilled' ? patterns.value      : null,
    causal:        causal.status        === 'fulfilled' ? causal.value        : null,
    relationships: relationships.status === 'fulfilled' ? relationships.value : null,
    forecastAll:   forecastAll.status   === 'fulfilled' ? forecastAll.value   : null,
    metricNames:   metricNames.status   === 'fulfilled' ? metricNames.value   : [],
  }
}

// ─── Per-message metric enrichment ───────────────────────────────────────────
// Called just before the AI API request.  Detects metric names in the user's
// text, fetches their forecast + recent series data, and optionally runs a
// vector similarity search for anomalous ones.

export function extractMentionedMetrics(text, knownMetrics) {
  const lower = text.toLowerCase()
  return (knownMetrics || []).filter(m => lower.includes(m.toLowerCase()))
}

export async function enrichWithMetricData(metricNames, activeAnomalyNames = []) {
  if (!metricNames.length) return {}
  const results = {}
  await Promise.allSettled(
    metricNames.map(async name => {
      const [forecast, series] = await Promise.allSettled([
        fetchMetricForecast(name, 300),
        fetchMetricSeries(name, 3600),
      ])
      const seriesResult = series.status === 'fulfilled' ? (series.value || []) : []
      const values = seriesResult[0]?.values?.map(([, v]) => parseFloat(v)) || []

      let vectorMatches = []
      if (activeAnomalyNames.includes(name)) {
        vectorMatches = await vectorSearchSimilar(name, 5)
      }

      // Compute summary stats from series data
      let stats = null
      if (values.length > 0) {
        const sorted = [...values].sort((a, b) => a - b)
        stats = {
          count:  values.length,
          min:    +sorted[0].toFixed(4),
          max:    +sorted[sorted.length - 1].toFixed(4),
          avg:    +(values.reduce((s, v) => s + v, 0) / values.length).toFixed(4),
          p95:    +sorted[Math.floor(sorted.length * 0.95)].toFixed(4),
          latest: +values[values.length - 1].toFixed(4),
        }
      }

      results[name] = {
        forecast: forecast.status === 'fulfilled' ? forecast.value : null,
        stats,
        vectorMatches,
      }
    })
  )
  return results
}

// ─── System prompt builder ────────────────────────────────────────────────────

function relTime(unixSec) {
  const d = Math.floor(Date.now() / 1000) - unixSec
  if (d < 60)   return `${d}s ago`
  if (d < 3600) return `${Math.floor(d / 60)}m ago`
  return `${(d / 3600).toFixed(1)}h ago`
}

function modelName(id) {
  return ['Constant', 'Linear', 'Quadratic'][id] || `Model-${id}`
}

function forecastRow(f) {
  const cur = f.current_value?.toFixed(3)
  const pre = f.predicted_value?.toFixed(3)
  const pct = f.current_value
    ? (((f.predicted_value - f.current_value) / Math.abs(f.current_value)) * 100).toFixed(1)
    : '?'
  const arrow = parseFloat(pct) > 2 ? '↑' : parseFloat(pct) < -2 ? '↓' : '→'
  const qual  = { HIGH: '🟢', MEDIUM: '🟡', LOW: '🔴' }[f.forecast_quality] || '⚪'
  return `${qual} ${f.metric}: ${cur} → ${pre} (${pct}%) ${arrow}  [${f.model_name || modelName(f.model_id)} | ${f.forecast_quality}]`
}

export const CHART_FORMAT_INSTRUCTIONS = `
═══ CHART FORMAT ═══
CRITICAL: When the user asks to plot, chart, graph, visualize, add an overlay, add a moving average,
add a trend line, or modify any chart property — you MUST emit the spec inside <CHART> and </CHART>
tags. NEVER use a markdown code block (triple backtick) for chart specs — the UI cannot parse those.
Always use <CHART> tags. No exceptions.

Full spec format:
<CHART>
{
  "title":     "Chart title",
  "type":      "line",
  "yLabel":    "unit",
  "lineWidth": 2,
  "showGrid":  true,
  "series": [
    {
      "name":   "series_key",
      "label":  "Display Name",
      "color":  "#06b6d4",
      "metric": "tsdb_metric_name",
      "data":   [{"t":"14:00","v":45.2}]
    }
  ],
  "overlays": [
    {"type":"movingAverage","period":10,"color":"#f59e0b","label":"10-period MA"}
  ]
}
</CHART>

Overlay-mode example (user says "add a moving average"):
<CHART>
{"overlays":[{"type":"movingAverage","period":10,"color":"#f59e0b","label":"10-period MA"}]}
</CHART>

Anomaly overlay example (user says "show anomalies on this chart"):
<CHART>
{"overlays":[
  {"type":"anomaly","time":"14:32","label":"RMSE spike","severity":"critical"},
  {"type":"anomaly","time":"15:01","label":"regime change","severity":"warning"}
]}
</CHART>
The "time" value must match the time format in the chart data (HH:MM from the x-axis).
Use severity: "critical" (red), "warning" (yellow), or "info" (amber).
Get anomaly timestamps from the ACTIVE ANOMALIES section of your context.

Available overlay types:
- movingAverage: {type, period, color, label}
- trendLine: {type, color, label}
- annotation: {type, time, label, color, position}
- anomaly: {type, time, label, severity}
- thresholdLine: {type, value, label, color}
- timeGrid: {type, interval, color}

Rules:
- Use "metric" to fetch real TSDB data; use "data" for inline/illustrative data.
- Design-mode: emit only the fields that changed (UI merges with existing spec).
- Overlay-mode: emit only the "overlays" array.
- Always put <CHART> AFTER your text explanation.
- NEVER use \`\`\`json blocks for chart specs. ONLY <CHART> tags work.
`

export function buildSystemPrompt(ctx, mode, currentSpec, metricData = {}) {
  const backendUrl = localStorage.getItem('tsdb_backend_url') || 'http://localhost:8080'
  const m  = ctx.metrics  || {}
  const an = ctx.anomalies?.anomalies || []
  const rc = ctx.regimeChanges?.changes || []
  const ca = ctx.causal?.edges || []
  const pt = ctx.patterns?.patterns || []
  const fa = ctx.forecastAll?.forecasts || []
  const mn = ctx.metricNames || []
  const rl = ctx.relationships?.edges || []

  // ── Section: operational metrics ────────────────────────────────────────────
  const metricsSection = `
═══ LIVE SYSTEM METRICS ═══
Backend:           ${backendUrl}
Active series:     ${m.unique_series_active?.toLocaleString() ?? 'unknown'}
Total samples:     ${m.total_samples_ingested?.toLocaleString() ?? 'unknown'}
WAL queue depth:   ${m.wal_queue_depth ?? 'unknown'}
Compression slots: ${m.compression_slots_free ?? 'unknown'} free
Anomalies active:  ${m.anomalies_detected ?? an.length}
Avg model RMSE:    ${m.average_rmse?.toFixed(4) ?? 'unknown'}
Shipped:           ${m.total_shipped_bytes ? (m.total_shipped_bytes / 1e6).toFixed(1) + ' MB' : 'unknown'}
Canonical stored:  ${m.total_canonical_bytes ? (m.total_canonical_bytes / 1e6).toFixed(1) + ' MB' : 'unknown'}
Head cache:        ${m.head_cache_size ?? 'unknown'} series
Symbols:           ${m.total_symbols_registered ?? 'unknown'}
Last compaction:   ${m.last_compaction_latency_ms != null ? m.last_compaction_latency_ms + ' ms' : 'unknown'}`

  // ── Section: anomalies ───────────────────────────────────────────────────────
  const anomalySection = an.length === 0
    ? `\n═══ ACTIVE ANOMALIES ═══\nNone detected.`
    : `\n═══ ACTIVE ANOMALIES (${an.length}) ═══\n` + an.map(a =>
        `• [${a.severity}] ${a.metric_string}\n` +
        `  RMSE: ${a.rmse?.toFixed(2)}  |  Detected: ${a.log_time ? relTime(a.log_time) : 'unknown'}\n` +
        `  Reason: ${a.reason}`
      ).join('\n')

  // ── Section: regime changes ──────────────────────────────────────────────────
  const regimeSection = rc.length === 0
    ? `\n═══ RECENT REGIME CHANGES ═══\nNone in the last 30 minutes.`
    : `\n═══ RECENT REGIME CHANGES (${rc.length}) ═══\n` + rc.map(r =>
        `• ${r.metric_string}: ${modelName(r.from_model)} → ${modelName(r.to_model)}` +
        `  (${r.detected_at ? relTime(r.detected_at) : 'unknown'})`
      ).join('\n')

  // ── Section: causal graph ────────────────────────────────────────────────────
  const causalSection = ca.length === 0
    ? `\n═══ CAUSAL DEPENDENCY GRAPH ═══\nNo causal edges discovered yet.`
    : `\n═══ CAUSAL DEPENDENCY GRAPH (${ca.length} edges) ═══\n` +
      `Leading indicators (cause → effect, lag, correlation):\n` +
      ca.map(e =>
        `• ${e.source_metric} → ${e.target_metric}` +
        `  +${e.lag_seconds}s lag | r=${e.max_correlation?.toFixed(3)} | ${e.observation_count} obs`
      ).join('\n')

  // ── Section: pattern registry ────────────────────────────────────────────────
  const patternSection = pt.length === 0
    ? `\n═══ PATTERN REGISTRY ═══\nNo patterns registered. Use 'set_pattern_label' to teach the system failure signatures.`
    : `\n═══ PATTERN REGISTRY (${pt.length} patterns) ═══\n` + pt.map(p =>
        `• "${p.name}" (${p.match_count} matches) — ${p.description || 'no description'}` +
        `  tagged by ${p.tagged_by || '?'}`
      ).join('\n')

  // ── Section: structural relationships ───────────────────────────────────────
  const relSection = rl.length === 0
    ? ''
    : `\n═══ STRUCTURAL RELATIONSHIPS (top ${Math.min(rl.length, 8)}) ═══\n` +
      `Metrics that move together (structural similarity):\n` +
      rl.slice(0, 8).map(r =>
        `• ${r.source_metric} ↔ ${r.target_metric}  score=${r.score?.toFixed(3)}`
      ).join('\n')

  // ── Section: forecasts ───────────────────────────────────────────────────────
  const forecastSection = fa.length === 0
    ? `\n═══ METRIC FORECASTS ═══\nForecast data unavailable.`
    : (() => {
        // Sort: anomalous first, then by absolute % change descending
        const rows = fa.map(f => ({
          ...f,
          pct: f.current_value
            ? ((f.predicted_value - f.current_value) / Math.abs(f.current_value)) * 100
            : 0,
          isAnomalous: an.some(a => a.metric_string?.includes(f.metric)),
        }))
        rows.sort((a, b) => {
          if (a.isAnomalous !== b.isAnomalous) return b.isAnomalous - a.isAnomalous
          return Math.abs(b.pct) - Math.abs(a.pct)
        })
        const display = rows.slice(0, 20)  // cap at 20 to keep prompt size reasonable
        return `\n═══ METRIC FORECASTS — 5-MINUTE HORIZON (${fa.length} metrics) ═══\n` +
          display.map(forecastRow).join('\n') +
          (fa.length > 20 ? `\n  … and ${fa.length - 20} more` : '')
      })()

  // ── Section: available metrics ───────────────────────────────────────────────
  const metricListSection = mn.length === 0
    ? ''
    : `\n═══ AVAILABLE METRICS (${mn.length}) ═══\n` +
      mn.slice(0, 60).join(', ') + (mn.length > 60 ? ` … and ${mn.length - 60} more` : '')

  // ── Section: per-metric deep dives ───────────────────────────────────────────
  const metricDetailSections = Object.entries(metricData).map(([name, d]) => {
    const f = d.forecast?.data
    const s = d.stats
    const vm = d.vectorMatches || []
    let lines = [`\n═══ METRIC DETAIL: ${name} ═══`]

    if (s) {
      lines.push(
        `Current: ${s.latest} | Min/Max (1h): ${s.min} / ${s.max} | Avg: ${s.avg} | P95: ${s.p95}` +
        ` | Samples: ${s.count}`
      )
    }
    if (f) {
      lines.push(
        `Forecast (${f.horizon_seconds}s): ${f.current_value?.toFixed(4)} → ${f.predicted_value?.toFixed(4)}` +
        ` [${f.confidence_low?.toFixed(4)}, ${f.confidence_high?.toFixed(4)}]` +
        ` | Model: ${f.model_name || modelName(f.model_id)} | Quality: ${f.forecast_quality}` +
        ` | RMSE: ${f.rolling_rmse?.toFixed(4)}`
      )
    }
    if (vm.length > 0) {
      lines.push(`Vector DB — similar historical events:`)
      vm.slice(0, 3).forEach(r => {
        const meta = r.metadata || {}
        lines.push(
          `  • score=${r.score?.toFixed(4)}  incident=${meta.incident_id || '?'}` +
          (meta.root_cause && meta.root_cause !== 'Unknown Cause' ? `  root_cause=${meta.root_cause}` : '') +
          (meta.matched_patterns ? `  pattern=${meta.matched_patterns}` : '')
        )
      })
    } else if (an.some(a => a.metric_string?.includes(name))) {
      lines.push(`Vector DB: no similar historical incidents found for this anomaly.`)
    }

    return lines.join('\n')
  }).join('\n')

  // ── Section: current chart context ──────────────────────────────────────────
  const chartCtx = currentSpec
    ? `\n═══ CURRENT CHART SPEC ═══\n${JSON.stringify(currentSpec, null, 2)}\nModify only changed fields when in Design or Overlay mode.`
    : ''

  // ── Mode instruction ─────────────────────────────────────────────────────────
  const modeInstruction = {
    data:    'MODE: DATA ANALYSIS — Focus on understanding metric trends, anomalies, causality, and forecasts. Use the full context above to give specific, data-driven answers.',
    design:  'MODE: CHART DESIGN — Help the user customize visualization appearance. Modify chart type, colors, line width. Emit a partial CHART spec with only the changed fields.',
    overlay: 'MODE: OVERLAYS & ANALYTICS — Add analytical overlays (moving averages, trend lines). Emit a CHART spec with only the "overlays" array updated.',
  }[mode] || ''

  // ── Capabilities summary ─────────────────────────────────────────────────────
  const capabilitiesSection = `
═══ YOUR CAPABILITIES ═══
You have full context from all TSDB.ai data layers above. You can:
• Identify and explain active anomalies and their likely root causes using the causal graph
• Match current metric shapes against the pattern registry to name known failure signatures
• Trace leading indicators — if auth_errors is rising, explain the downstream checkout impact
• Quantify forecast trajectories: "disk_free will be exhausted in X hours at current rate"
• Explain regime changes: what triggered a model shift from Constant → Linear
• Write PromQL-compatible queries for the Query Gateway (:8081/api/v1/query_range)
• Suggest alert thresholds based on observed P95/P99 values
• Recommend config tuning (RMSE tolerance, shard count, cache size) for this instance
• Detect outliers within a metric family by behavioral shape clustering
• Create and modify dynamic charts using the CHART format below`

  return [
    `You are TSDB.ai Assistant, an expert AI analyst with full access to all live data layers of this TSDB.ai instance.`,
    metricsSection,
    anomalySection,
    regimeSection,
    causalSection,
    patternSection,
    rl.length > 0 ? relSection : '',
    forecastSection,
    metricListSection,
    metricDetailSections,
    chartCtx,
    `\n${modeInstruction}`,
    capabilitiesSection,
    CHART_FORMAT_INSTRUCTIONS,
    `\nBe concise and cite specific values from the context above. Never fabricate metric values.`,
  ].filter(Boolean).join('\n')
}
