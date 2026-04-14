import { useState, useEffect, useRef, useCallback } from 'react'
import {
  ResponsiveContainer, LineChart, BarChart, AreaChart,
  Line, Bar, Area, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
  ReferenceArea, ReferenceLine,
} from 'recharts'
import {
  Bot, Send, User, Database, Palette, Layers,
  RefreshCw, X, Plus, Eye, EyeOff, Key,
  BarChart3, TrendingUp, AlertTriangle, ChevronDown, Check,
  Zap, GitBranch, Search, Wrench, Activity, Save, Clock, BookOpen,
  Maximize2, ChevronLeft, ChevronRight, Download,
} from 'lucide-react'
import { useTheme } from '../context/ThemeContext'
import { getAICredentials, saveAICredentials } from '../api'
import {
  fetchFullContext,
  extractMentionedMetrics,
  enrichWithMetricData,
  buildSystemPrompt as buildRichPrompt,
  searchMetricNames,
} from '../contextEngine'
import {
  parseToolBlocks,
  executeToolCall,
  buildToolInstructions,
} from '../toolEngine'
import {
  loadUIState,
  saveUIState,
  newSessionId,
  defaultSessionLabel,
} from '../uiStorage'

// ─── Bulk-plot detection ──────────────────────────────────────────────────────
// Returns { query: string, isBulk: true } when the user asks to plot ALL metrics
// matching a keyword ("plot all cpu metrics", "chart everything about memory", …).
// Returns null for normal single-chart requests.

// Qualifier words that precede the real keyword — strip these from the captured group
// so "available mock" → "mock", "currently active cpu" → "cpu", etc.
const BULK_QUALIFIER_RE = /\b(available|existing|new|current|currently|active|related|real|live|all|the|our|my|every|each|these|those|any)\b\s*/gi

function detectBulkRemoveRequest(text) {
  const t = text.trim()
  const del  = '(?:remove|delete|clear|close|dismiss|drop|hide)'
  // Allow compound nouns: "graphs", "charts or graphs", "metrics and charts", etc.
  const sn   = '(?:metrics?|series?|graphs?|charts?|panels?|cards?)'
  const noun = `${sn}(?:\\s+(?:or|and)\\s+${sn})*`

  const patterns = [
    // WITH "all" + keyword before noun: "remove all mock charts" / "delete all cpu related charts or graphs"
    new RegExp(`^${del}\\s+all\\s+(.+?)\\s+${noun}\\s*$`, 'i'),
    // WITH "all" + relation after noun: "remove all charts related to mock"
    new RegExp(`^${del}\\s+all\\s+${noun}\\s+(?:related\\s+to|about|for|containing|matching|like|with)\\s+(.+?)\\s*$`, 'i'),
    // WITH "all", no keyword — clear entire tab: "remove all charts" / "clear all graphs"
    new RegExp(`^${del}\\s+all\\s+${noun}\\s*$`, 'i'),
    // "clear the tab" / "clear this dashboard"
    /^(?:clear|reset)\s+(?:the\s+)?(?:tab|dashboard|canvas|this\s+tab)\s*$/i,
    // WITHOUT "all" + keyword before noun: "remove mock charts" / "delete cpu graphs or charts"
    new RegExp(`^${del}\\s+(.+?)\\s+${noun}\\s*$`, 'i'),
    // WITHOUT "all" + relation after noun: "remove charts related to mock"
    new RegExp(`^${del}\\s+${noun}\\s+(?:related\\s+to|about|for|containing|matching|like|with)\\s+(.+?)\\s*$`, 'i'),
  ]

  const vague = new Set(['', 'them', 'it', 'this', 'that', 'these', 'those', 'charts', 'metrics', 'series', 'graphs', 'panels'])

  for (let i = 0; i < patterns.length; i++) {
    const m = t.match(patterns[i])
    if (m) {
      // Patterns 2 and 3 have no keyword group → remove all on tab
      if (i === 2 || i === 3) return { query: '', isBulk: true }

      let query = m[1].trim().replace(/["'`]/g, '')                     // strip ALL quotes
      query = query.replace(/\s+related\s+(?:metrics?|series?|charts?|graphs?)?$/i, '').trim()
      query = query.replace(BULK_QUALIFIER_RE, '').replace(/\s+/g, ' ').trim()

      if (vague.has(query.toLowerCase())) query = ''

      // For no-"all" patterns (4 & 5), require a real keyword to avoid accidentally clearing the tab
      if ((i === 4 || i === 5) && !query) return null

      return { query, isBulk: true }
    }
  }
  return null
}

// ─── Overlay-remove detection ─────────────────────────────────────────────────
// Intercepts "remove all anomalies", "clear moving averages from all charts", etc.
// Returns { overlayType: string|null, fromAll: boolean } or null.
// overlayType null = remove every overlay type.

function detectOverlayRemoveRequest(text) {
  const t = text.trim()

  // Map natural-language keywords → recharts overlay type strings.
  // Each pattern must fully consume the word(s) so \s*$ can match end-of-string.
  const TYPE_MAP = [
    // ── anomaly ──────────────────────────────────────────────────────────────
    // "anomalies", "outliers", "spikes", "aberrations", "irregularities"
    [/anomal(?:ies?|y)?|outliers?|spikes?|aberrations?|irregularit(?:ies|y)/i,
      'anomaly'],

    // ── movingAverage ────────────────────────────────────────────────────────
    // "moving average", "rolling average", "running average", "smoothing line",
    // "moving mean", "rolling mean", "MA"
    [/moving.?averages?|rolling.?averages?|running.?averages?|mov(?:ing)?.?avgs?|moving.?means?|rolling.?means?|smoothing(?:.?lines?)?|\bma\b/i,
      'movingAverage'],

    // ── trendLine ────────────────────────────────────────────────────────────
    // "trend line", "trend", "regression line", "linear regression",
    // "best fit", "best fit line", "slope line", "fit line",
    // "plot line", "graph line" (overlaid fit lines — not the metric series)
    [/trend.?lines?|trends?|regression.?lines?|linear.?regressions?|best.?fit(?:.?lines?)?|fit.?lines?|slope.?lines?|plot.?lines?|graph.?lines?/i,
      'trendLine'],

    // ── annotation ───────────────────────────────────────────────────────────
    // "annotation", "marker", "event marker", "label", "tag", "note",
    // "callout", "mark", "flag", "pin", "pointer", "event"
    [/annotations?|event.?markers?|markers?|callouts?|labels?|flags?|pins?|pointers?|tags?|notes?|marks?|events?/i,
      'annotation'],

    // ── thresholdLine ────────────────────────────────────────────────────────
    // "threshold", "limit", "SLA line", "SLO line", "alert line",
    // "warning line", "critical line", "baseline", "reference line",
    // "boundary", "target line", "goal line"
    [/threshold.?lines?|thresholds?|limit.?lines?|limits?|sla.?lines?|slo.?lines?|alert.?lines?|warning.?lines?|critical.?lines?|baselines?|reference.?lines?|boundar(?:ies|y)|target.?lines?|goal.?lines?/i,
      'thresholdLine'],

    // ── timeGrid ─────────────────────────────────────────────────────────────
    // "time grid", "grid lines", "vertical lines", "interval lines",
    // "time markers", "time dividers", "time separators", "tick marks"
    [/time.?grids?|vertical.?lines?|vertical.?grid(?:.?lines?)?|grid.?lines?|interval.?lines?|time.?markers?|time.?dividers?|time.?separators?|tick.?marks?/i,
      'timeGrid'],
  ]

  const del   = '(?:remove|delete|clear|dismiss|drop|hide|clean\s+up)'
  const scope = '(?:from\\s+)?(?:all\\s+)?(?:charts?|graphs?|panels?|tabs?|dashboard)?'
  const allRe = /\ball\s+charts?\b|\beverywhere\b|\bfrom\s+all\b|\ball\s+graphs?\b/i

  // Generic "remove all overlays / clear all overlays"
  if (/^(?:remove|delete|clear|clean\s+up)\s+all\s+overlays?\s*(from\s+all\s+charts?)?\s*$/i.test(t)) {
    return { overlayType: null, fromAll: true }
  }
  if (/^(?:remove|delete|clear)\s+overlays?\s*(from\s+all\s+charts?)?\s*$/i.test(t)) {
    return { overlayType: null, fromAll: allRe.test(t) }
  }

  // Specific type: "remove all anomalies", "clear moving averages from all charts", etc.
  for (const [keyRe, ovType] of TYPE_MAP) {
    // "remove (all) <type> (overlays?) (from all charts?)"
    // Wrap keyRe.source in (?:...) so its internal | alternations don't leak
    // out and match unintended parts of the surrounding pattern
    const m = t.match(new RegExp(
      `^(?:remove|delete|clear|dismiss|drop)\\s+(?:all\\s+)?(?:${keyRe.source})(?:\\s+overlays?)?(?:\\s+from\\s+(?:all\\s+)?(?:charts?|graphs?|panels?))?\\s*$`,
      'i'
    ))
    if (m) {
      return { overlayType: ovType, fromAll: allRe.test(t) || /\ball\b/i.test(t) }
    }
  }

  return null
}

function detectBulkPlotRequest(text) {
  const t = text.trim()
  const viz  = '(?:plot|chart|graph|show|display|visualize|draw)'
  const noun = '(?:metrics?|series?|graphs?|charts?|measurements?|signals?)'

  const patterns = [
    // "plot all cpu metrics" / "chart all available mock metrics"
    new RegExp(`^${viz}\\s+all\\s+(.+?)\\s+${noun}\\s*$`, 'i'),
    // "plot all metrics related to cpu" / "show all series containing disk"
    new RegExp(`^${viz}\\s+all\\s+${noun}\\s+(?:related\\s+to|about|for|containing|matching|like|with)\\s+(.+?)\\s*$`, 'i'),
    // "plot all cpu" (single keyword: no trailing noun required)
    new RegExp(`^${viz}\\s+all\\s+([\\w][\\w._-]*)\\s*$`, 'i'),
    // "plot everything related to memory"
    new RegExp(`^${viz}\\s+everything\\s+(?:related\\s+to|about|for|containing|with)\\s+(.+?)\\s*$`, 'i'),
  ]

  for (const pattern of patterns) {
    const m = t.match(pattern)
    if (m) {
      let query = m[1].trim().replace(/["'`]/g, '')                               // strip ALL quotes anywhere
      query = query.replace(/\s+related\s+(?:metrics?|series?)?$/i, '').trim()   // "cpu related" → "cpu"
      query = query.replace(BULK_QUALIFIER_RE, '').replace(/\s+/g, ' ').trim()   // "available mock" → "mock"
      const vague = new Set(['', 'them', 'it', 'this', 'charts', 'metrics', 'series'])
      if (vague.has(query.toLowerCase())) query = ''
      return { query, isBulk: true }
    }
  }
  return null
}

// ─── Time range detection ─────────────────────────────────────────────────────
// Parses natural language time range commands like "show last 6 hours", "set to 30m", etc.
// Returns { durationSeconds: number } or null.

function detectTimeRangeCommand(text) {
  const t = text.trim()

  function toSeconds(num, unit) {
    const n = parseFloat(num)
    const u = unit.toLowerCase()
    if (u.startsWith('s')) return n
    if (u.startsWith('m')) return n * 60
    if (u.startsWith('h')) return n * 3600
    if (u.startsWith('d')) return n * 86400
    if (u.startsWith('w')) return n * 604800
    return null
  }

  // "last 6 hours" / "past 30 minutes" / "show last 1 day" / "last 3h" etc.
  const m1 = t.match(
    /^(?:show|set|use|view|display)?\s*(?:last|past|(?:the\s+)?last|(?:the\s+)?past)\s+(\d+(?:\.\d+)?)\s*(s(?:ec(?:ond)?s?)?|m(?:in(?:ute)?s?)?|h(?:r?s?|our?s?)?|d(?:ay?s?)?|w(?:k?s?|eek?s?)?)\s*(?:of\s+(?:data|metrics?|history))?$/i
  )
  if (m1) { const s = toSeconds(m1[1], m1[2]); if (s) return { durationSeconds: s } }

  // "set time range to 3h" / "time range: 24h" / "window 30m" / "zoom to 1h"
  const m2 = t.match(
    /^(?:set\s+)?(?:time\s+range|timerange|time\s+window|range|window|interval|period|zoom(?:\s+to)?)\s*(?:to|:)?\s*(\d+(?:\.\d+)?)\s*(s(?:ec(?:ond)?s?)?|m(?:in(?:ute)?s?)?|h(?:r?s?|our?s?)?|d(?:ay?s?)?|w(?:k?s?|eek?s?)?)\s*$/i
  )
  if (m2) { const s = toSeconds(m2[1], m2[2]); if (s) return { durationSeconds: s } }

  // "set to 3h" / "use 30m" / "switch to 24h" / "go to 7d"
  const m3 = t.match(
    /^(?:set\s+(?:to|time(?:\s+range)?\s+to)|use|switch\s+to|change\s+to|go\s+to|show)\s+(\d+(?:\.\d+)?)\s*(s(?:ec(?:ond)?s?)?|m(?:in(?:ute)?s?)?|h(?:r?s?|our?s?)?|d(?:ay?s?)?|w(?:k?s?|eek?s?)?)\s*$/i
  )
  if (m3) { const s = toSeconds(m3[1], m3[2]); if (s) return { durationSeconds: s } }

  // "plot/show in minutes/hours/days" shorthand — "show in 3 hours", "plot in last 6 hours"
  const m4 = t.match(
    /^(?:plot|show|chart|view|display|refresh)\s+(?:in\s+)?(?:the\s+)?(?:last\s+)?(\d+(?:\.\d+)?)\s*(s(?:ec(?:ond)?s?)?|m(?:in(?:ute)?s?)?|h(?:r?s?|our?s?)?|d(?:ay?s?)?|w(?:k?s?|eek?s?)?)\s*$/i
  )
  if (m4) { const s = toSeconds(m4[1], m4[2]); if (s) return { durationSeconds: s } }

  return null
}

// Human-readable label for a duration in seconds
function formatDuration(seconds) {
  if (seconds < 60)   return `${seconds}s`
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`
  if (seconds < 86400) {
    const h = seconds / 3600
    return h === Math.floor(h) ? `${h}h` : `${h.toFixed(1)}h`
  }
  const d = seconds / 86400
  return d === Math.floor(d) ? `${d}d` : `${d.toFixed(1)}d`
}

// ─── Providers ────────────────────────────────────────────────────────────────

const PROVIDERS = {
  openai: {
    name: 'OpenAI', icon: '🟢', color: '#10a37f',
    models: ['gpt-4o', 'gpt-4-turbo', 'gpt-4o-mini', 'gpt-3.5-turbo'],
    placeholder: 'sk-…',
  },
  anthropic: {
    name: 'Anthropic', icon: '🔶', color: '#d97706',
    models: ['claude-sonnet-4-6', 'claude-opus-4-6', 'claude-haiku-4-5-20251001'],
    placeholder: 'sk-ant-…',
  },
  local: {
    name: 'Local LLM', icon: '🖥️', color: '#22c55e',
    models: [],
    placeholder: '',
  },
}

// ─── TSDB data fetching ───────────────────────────────────────────────────────

function getQueryUrl() {
  const base = localStorage.getItem('tsdb_backend_url') || 'http://localhost:8080'
  try {
    const u = new URL(base)
    u.port = '8081'
    return u.origin
  } catch {
    return 'http://localhost:8081'
  }
}

// rangeOpts: optional { start: epochSeconds, end: epochSeconds } for custom absolute ranges
async function queryMetricRange(metricName, durationSeconds = 3600, rangeOpts = {}) {
  const end   = rangeOpts.end   ?? Math.floor(Date.now() / 1000)
  const start = rangeOpts.start ?? (end - durationSeconds)
  const rangeSeconds = end - start
  const step = Math.max(15, Math.floor(rangeSeconds / 300))
  const url =
    `${getQueryUrl()}/api/v1/query_range` +
    `?query=${encodeURIComponent(metricName)}&start=${start}&end=${end}&step=${step}`
  let res
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(8000) })
  } catch (err) {
    throw new Error(`Network error fetching ${metricName}: ${err.message}`)
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Query gateway returned ${res.status} for ${metricName}${text ? ': ' + text : ''}`)
  }
  const json = await res.json()
  return (json.data?.result || []).map(series => ({
    name: series.metric.__name__ || metricName,
    labels: series.metric,
    data: series.values.map(([ts, v]) => ({
      t: new Date(ts * 1000).toLocaleTimeString('en', { hour: '2-digit', minute: '2-digit' }),
      v: parseFloat(v),
    })),
  }))
}

// ─── LLM API calls ────────────────────────────────────────────────────────────

async function callLocal(baseUrl, model, messages, apiKey) {
  const url = (baseUrl || 'http://localhost:11434').replace(/\/$/, '') + '/v1/chat/completions'
  const headers = { 'Content-Type': 'application/json' }
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`
  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ model, messages, temperature: 0.6, stream: false }),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(err?.error?.message || `Local LLM error ${res.status} — is ${baseUrl} running?`)
  }
  const data = await res.json()
  return data.choices?.[0]?.message?.content || ''
}

async function callOpenAI(apiKey, model, messages) {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model, messages, temperature: 0.6, max_tokens: 2048 }),
  })
  if (!res.ok) {
    const e = await res.json().catch(() => ({}))
    throw new Error(e?.error?.message || `OpenAI error ${res.status}`)
  }
  return (await res.json()).choices?.[0]?.message?.content || ''
}

async function callAnthropic(apiKey, model, messages) {
  const sys = messages.find(m => m.role === 'system')
  const chat = messages.filter(m => m.role !== 'system')
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({ model, max_tokens: 2048, system: sys?.content || '', messages: chat }),
  })
  if (!res.ok) {
    const e = await res.json().catch(() => ({}))
    throw new Error(e?.error?.message || `Anthropic error ${res.status}`)
  }
  return (await res.json()).content?.[0]?.text || ''
}

// ─── CHART block parsing ──────────────────────────────────────────────────────
// The AI may embed a JSON block between <CHART> … </CHART> tags.
// The spec format:
// {
//   title:     string,
//   type:      "line" | "bar" | "area",
//   yLabel:    string,
//   lineWidth: number,
//   showGrid:  boolean,
//   series: [{
//     name:   string,   // key used in recharts data rows
//     label:  string,   // display name
//     color:  string,   // hex color
//     metric: string,   // optional — fetch from TSDB if provided & no data[]
//     data:   [{t:string, v:number}]   // optional inline data
//   }],
//   overlays: [{type:"movingAverage", period:number, color:string, label:string}]
// }

function parseChartBlock(text) {
  // Primary: collect ALL <CHART>...</CHART> blocks (AI may emit multiple for bulk plots)
  const allMatches = [...text.matchAll(/<CHART>([\s\S]*?)<\/CHART>/g)]
  if (allMatches.length > 0) {
    const specs = []
    let clean = text
    for (const m of allMatches) {
      try {
        specs.push(JSON.parse(m[1].trim()))
        clean = clean.replace(m[0], '')
      } catch { /* skip malformed block */ }
    }
    if (specs.length > 0) {
      return { clean: clean.trim(), spec: specs[0], specs }
    }
    return { clean: text, spec: null, specs: [] }
  }

  // Fallback: catch JSON code blocks that look like chart specs
  // (AI sometimes emits ```json {...} ``` instead of <CHART> tags)
  const codeBlockRe = /```(?:json)?\s*(\{[\s\S]*?\})\s*```/g
  let cbMatch
  while ((cbMatch = codeBlockRe.exec(text)) !== null) {
    try {
      const candidate = JSON.parse(cbMatch[1].trim())
      // Only treat as chart spec if it has chart-like top-level keys
      if (candidate.series || candidate.overlays || candidate.type === 'line'
          || candidate.type === 'bar' || candidate.type === 'area') {
        const clean = text.replace(cbMatch[0], '').trim()
        return { clean, spec: candidate, specs: [candidate] }
      }
    } catch { /* not valid JSON, skip */ }
  }

  return { clean: text, spec: null, specs: [] }
}

// ─── Overlay computation (moving average + trend line) ───────────────────────

function applyOverlays(data, overlays, primaryKey) {
  if (!overlays?.length || !data?.length) return data
  const rows = data.map(r => ({ ...r }))
  overlays.forEach(ov => {
    // Moving average
    if (ov.type === 'movingAverage' && ov.period > 1) {
      const key = ov.seriesName || primaryKey
      rows.forEach((row, i) => {
        if (i >= ov.period - 1) {
          const slice = rows.slice(i - ov.period + 1, i + 1)
          row[`ma_${ov.period}`] = +(slice.reduce((s, r) => s + (r[key] ?? 0), 0) / ov.period).toFixed(3)
        }
      })
    }
    // Trend line (linear regression on target series)
    if (ov.type === 'trendLine') {
      const key = ov.seriesName || primaryKey
      const pts = rows.map((r, i) => [i, r[key] ?? null]).filter(([, v]) => v != null)
      if (pts.length >= 2) {
        const n = pts.length
        const sumX  = pts.reduce((s, [x]) => s + x, 0)
        const sumY  = pts.reduce((s, [, y]) => s + y, 0)
        const sumXY = pts.reduce((s, [x, y]) => s + x * y, 0)
        const sumXX = pts.reduce((s, [x]) => s + x * x, 0)
        const slope = (n * sumXY - sumX * sumY) / (n * sumXX - sumX * sumX)
        const intercept = (sumY - slope * sumX) / n
        const trendKey = `trend_${ov.id || key}`
        rows.forEach((row, i) => {
          row[trendKey] = +(slope * i + intercept).toFixed(4)
        })
        // Store computed key on the overlay object for rendering
        ov._trendKey = trendKey
      }
    }
  })
  return rows
}

// ─── Chart renderer ───────────────────────────────────────────────────────────

const CHART_COLORS = ['#06b6d4','#7c3aed','#10b981','#f59e0b','#ef4444','#3b82f6','#ec4899','#84cc16']

// Map dash-style name → recharts strokeDasharray string
const DASH_ARRAYS = { solid: '0', dashed: '8 4', dotted: '2 3' }

function ChartRenderer({ spec, height = 260 }) {
  const { T, glow } = useTheme()
  if (!spec?.series?.length) return null

  // Detect when ALL series have no data — show a useful error instead of blank axes
  const seriesWithData = spec.series.filter(s => s.data?.length)
  if (!seriesWithData.length) {
    const errors = spec.series.map(s => s.fetchError).filter(Boolean)
    const metricNames = spec.series.map(s => s.metric || s.name).filter(Boolean)
    return (
      <div style={{
        height: '100%', display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center', gap: 12, padding: '0 32px',
      }}>
        <div style={{
          width: 48, height: 48, borderRadius: '50%',
          background: `${T.yellow}18`, border: `1px solid ${T.yellow}44`,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <BarChart3 size={22} color={T.yellow} />
        </div>
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: T.textPri, marginBottom: 6 }}>
            No data available
          </div>
          {metricNames.length > 0 && (
            <div style={{ fontSize: 12, color: T.textSec, marginBottom: 8, fontFamily: T.mono }}>
              {metricNames.join(', ')}
            </div>
          )}
          {errors.length > 0 ? (
            <div style={{ fontSize: 11, color: T.textMut, maxWidth: 380 }}>
              {errors[0]}
            </div>
          ) : (
            <div style={{ fontSize: 11, color: T.textMut }}>
              No matching series found in the last hour. Make sure mock data is running and the metric name is correct.
            </div>
          )}
        </div>
      </div>
    )
  }

  // Build unified time-indexed rows for recharts
  const allTimes = [...new Set(spec.series.flatMap(s => (s.data || []).map(d => d.t)))]
  let rows = allTimes.map(t => {
    const row = { time: t }
    spec.series.forEach(s => {
      const pt = (s.data || []).find(d => d.t === t)
      if (pt != null) row[s.name] = pt.v
    })
    return row
  })

  const primaryKey = spec.series[0]?.name
  rows = applyOverlays(rows, spec.overlays, primaryKey)

  // ── Snap an overlay timestamp to the nearest row time string ─────────────────
  // ReferenceLine x= on a categorical XAxis only renders when the value exactly
  // matches one of the data keys. AI-generated overlays may provide epoch seconds,
  // ISO strings, or differently-formatted times — this converts them to the closest
  // matching "HH:MM AM/PM" string that actually exists in the data.
  const snapToRows = (() => {
    if (!rows.length) return t => t

    // Parse a "HH:MM AM/PM" time string → minutes-of-day (returns -1 if unparseable)
    const toMinutes = str => {
      const m = str && str.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i)
      if (!m) return -1
      let h = parseInt(m[1], 10)
      const min = parseInt(m[2], 10)
      const isPM = m[3].toUpperCase() === 'PM'
      if (isPM  && h !== 12) h += 12
      if (!isPM && h === 12) h = 0
      return h * 60 + min
    }

    const rowMinutes = rows.map(r => toMinutes(r.time))
    const rowTimeSet = new Set(rows.map(r => r.time))
    const CHART_FMT  = { hour: '2-digit', minute: '2-digit' }

    return rawTime => {
      if (!rawTime) return rawTime

      // 1. Already an exact match
      if (rowTimeSet.has(rawTime)) return rawTime

      // 2. Try to parse as a Date from various formats
      let d = null
      const n = Number(rawTime)
      if (!isNaN(n) && n > 0) {
        // Treat as epoch — if < 1e10 it's seconds, otherwise milliseconds
        d = new Date(n > 1e10 ? n : n * 1000)
      } else if (typeof rawTime === 'string') {
        d = new Date(rawTime)   // ISO, RFC, etc.
      }

      if (d && !isNaN(d.getTime())) {
        const formatted = d.toLocaleTimeString('en', CHART_FMT)
        if (rowTimeSet.has(formatted)) return formatted

        // 3. Snap to nearest row by minutes-of-day
        const target = toMinutes(formatted)
        if (target >= 0) {
          let closest = rows[0].time, minDist = Infinity
          rowMinutes.forEach((rm, i) => {
            if (rm < 0) return
            const dist = Math.abs(rm - target)
            if (dist < minDist) { minDist = dist; closest = rows[i].time }
          })
          return closest
        }
      }

      // 4. Last resort: try direct minutes-of-day match on the raw string
      const target = toMinutes(rawTime)
      if (target >= 0) {
        let closest = rows[0].time, minDist = Infinity
        rowMinutes.forEach((rm, i) => {
          if (rm < 0) return
          const dist = Math.abs(rm - target)
          if (dist < minDist) { minDist = dist; closest = rows[i].time }
        })
        return closest
      }

      return rawTime  // give up — return as-is
    }
  })()

  const lw = spec.lineWidth ?? 2
  const grid = spec.showGrid !== false
  const type = spec.type || 'line'
  const isScatter = type === 'scatter'
  // smooth: true → bezier curves (monotone), false/undefined → straight segments (linear)
  const curveType = spec.smooth ? 'monotone' : 'linear'

  const axisStyle = { fontSize: 11, fill: T.textMut }
  const tooltipStyle = {
    contentStyle: { background: T.bgCard, border: `1px solid ${T.border}`, borderRadius: 8, fontSize: 12 },
    labelStyle: { color: T.textSec }, itemStyle: { color: T.textPri },
  }

  const sharedProps = {
    data: rows,
    margin: { top: 10, right: 24, left: 0, bottom: 0 },
  }

  // Threshold reference areas (colored zones above/below a value)
  const thresholdZones = (spec.thresholds || []).map((th, i) => {
    // above: true  → fill from th.value to top  (y1=value, no y2)
    // above: false → fill from bottom to th.value (y2=value, no y1)
    return (
      <ReferenceArea
        key={`th_${i}`}
        y1={th.above !== false ? th.value : undefined}
        y2={th.above !== false ? undefined : th.value}
        fill={th.color || T.red}
        fillOpacity={0.08}
        stroke={th.color || T.red}
        strokeOpacity={0.25}
        strokeDasharray="4 3"
        label={th.label ? {
          value: th.label, position: 'insideTopRight',
          fill: th.color || T.red, fontSize: 9, opacity: 0.7,
        } : undefined}
        ifOverflow="visible"
      />
    )
  })

  // ── Time-grid vertical reference lines ──────────────────────────────────────
  const timeGridLines = (() => {
    const tg = (spec.overlays || []).find(ov => ov.type === 'timeGrid')
    if (!tg || !rows.length) return []
    const lines = []
    for (let i = tg.interval; i < rows.length; i += tg.interval) {
      const t = rows[i]?.time
      if (t) {
        lines.push(
          <ReferenceLine
            key={`tg_${i}`}
            x={t}
            stroke={tg.color || '#64748b'}
            strokeOpacity={0.45}
            strokeDasharray="3 4"
            strokeWidth={1}
          />
        )
      }
    }
    return lines
  })()

  // ── Annotation vertical lines ────────────────────────────────────────────────
  const annotationLines = (spec.overlays || [])
    .filter(ov => ov.type === 'annotation')
    .map(ov => (
      <ReferenceLine
        key={ov.id || `ann_${ov.time}`}
        x={snapToRows(ov.time)}
        stroke={ov.color || T.cyan}
        strokeWidth={1.5}
        strokeDasharray="5 3"
        label={{
          value: ov.label,
          position: ov.position || 'insideTop',
          fill: ov.color || T.cyan,
          fontSize: 9,
          fontWeight: 600,
        }}
        ifOverflow="visible"
      />
    ))

  // ── Threshold reference lines ────────────────────────────────────────────────
  const thresholdLines = (spec.overlays || [])
    .filter(ov => ov.type === 'thresholdLine')
    .map(ov => (
      <ReferenceLine
        key={ov.id || `thl_${ov.value}`}
        y={ov.value}
        stroke={ov.color || T.red}
        strokeWidth={1.5}
        strokeDasharray={ov.strokeDasharray || '6 3'}
        label={{
          value: ov.label,
          position: 'insideTopRight',
          fill: ov.color || T.red,
          fontSize: 9,
          fontWeight: 600,
        }}
        ifOverflow="visible"
      />
    ))

  const axes = (
    <>
      {grid && <CartesianGrid strokeDasharray="3 3" stroke={T.border} />}
      <XAxis dataKey="time" tick={axisStyle} tickLine={false} axisLine={false} />
      <YAxis
        tick={axisStyle} tickLine={false} axisLine={false}
        label={spec.yLabel ? { value: spec.yLabel, angle: -90, position: 'insideLeft', fill: T.textMut, fontSize: 11 } : undefined}
      />
      <Tooltip {...tooltipStyle} />
      <Legend wrapperStyle={{ fontSize: 11, color: T.textSec }} />
      {thresholdZones}
      {timeGridLines}
      {annotationLines}
      {thresholdLines}
    </>
  )

  const seriesElements = spec.series.map((s, i) => {
    const color = s.color || CHART_COLORS[i % CHART_COLORS.length]
    // Resolve dashArray: series-level dashArray overrides spec-level style
    const dash = s.dashArray != null ? s.dashArray : '0'
    const strokeDash = DASH_ARRAYS[dash] ?? dash  // accept both names and raw strings

    if (type === 'bar') {
      return <Bar key={s.name} dataKey={s.name} name={s.label || s.name} fill={color} opacity={s.opacity ?? 0.85} />
    }
    if (type === 'area') {
      return (
        <Area key={s.name} dataKey={s.name} name={s.label || s.name}
          stroke={color} fill={color + '33'} strokeWidth={lw}
          strokeDasharray={strokeDash !== '0' ? strokeDash : undefined}
          dot={false} type={curveType} opacity={s.opacity ?? 1}
        />
      )
    }
    if (isScatter) {
      // Scatter: dots only, no connecting line
      return (
        <Line key={s.name} dataKey={s.name} name={s.label || s.name}
          stroke={color} strokeWidth={0}
          dot={{ r: 3, fill: color, strokeWidth: 0 }}
          activeDot={{ r: 4, fill: color }}
          type="linear" legendType="circle"
        />
      )
    }
    return (
      <Line key={s.name} dataKey={s.name} name={s.label || s.name}
        stroke={color} strokeWidth={lw}
        strokeDasharray={strokeDash !== '0' ? strokeDash : undefined}
        dot={false} type={curveType} opacity={s.opacity ?? 1}
      />
    )
  })

  const overlayElements = (spec.overlays || []).map(ov => {
    if (ov.type === 'movingAverage') {
      return (
        <Line key={ov.id || `ma_${ov.period}`} dataKey={`ma_${ov.period}`}
          name={ov.label || `MA(${ov.period})`}
          stroke={ov.color || T.amber} strokeWidth={1.5}
          strokeDasharray="5 4" dot={false} type={curveType}
        />
      )
    }
    if (ov.type === 'trendLine' && ov._trendKey) {
      return (
        <Line key={ov.id || ov._trendKey} dataKey={ov._trendKey}
          name={ov.label || 'Trend'}
          stroke={ov.color || '#10b981'} strokeWidth={1.5}
          strokeDasharray="9 4" dot={false} type="linear"
        />
      )
    }
    // anomaly: vertical marker with severity color
    if (ov.type === 'anomaly') {
      const severityColor = ov.severity === 'critical' ? T.red : ov.severity === 'warning' ? T.yellow : T.amber
      return (
        <ReferenceLine
          key={ov.id || `anom_${ov.time}`}
          x={snapToRows(ov.time)}
          stroke={severityColor}
          strokeWidth={2}
          strokeDasharray="4 2"
          label={{
            value: ov.label || '⚠',
            position: ov.position || 'insideTopLeft',
            fill: severityColor,
            fontSize: 9,
            fontWeight: 700,
          }}
          ifOverflow="visible"
        />
      )
    }
    // annotation, thresholdLine, timeGrid rendered as ReferenceLine above
    return null
  })

  return (
    // Use a fixed pixel height — height="100%" breaks in CSS-grid / flex contexts
    // where the parent has no explicit height (only minHeight), giving recharts a
    // measured offsetHeight of 0 and an invisible SVG.
    <ResponsiveContainer width="100%" height={height}>
      {type === 'bar' ? (
        <BarChart {...sharedProps}>{axes}{seriesElements}</BarChart>
      ) : type === 'area' ? (
        <AreaChart {...sharedProps}>{axes}{seriesElements}{overlayElements}</AreaChart>
      ) : (
        <LineChart {...sharedProps}>{axes}{seriesElements}{overlayElements}</LineChart>
      )}
    </ResponsiveContainer>
  )
}

// ─── Mini calendar picker ─────────────────────────────────────────────────────

const CAL_DAYS   = ['Su','Mo','Tu','We','Th','Fr','Sa']
const CAL_MONTHS = ['January','February','March','April','May','June',
                    'July','August','September','October','November','December']

function MiniCalendar({ selectedEpoch, onSelect, viewYear, viewMonth, onViewChange, accentColor }) {
  const { T } = useTheme()
  const firstDow   = new Date(viewYear, viewMonth - 1, 1).getDay()   // 0=Sun
  const daysInMonth = new Date(viewYear, viewMonth, 0).getDate()

  const selDate = selectedEpoch ? new Date(selectedEpoch * 1000) : null
  const today   = new Date()

  const prev = () => viewMonth === 1  ? onViewChange(viewYear - 1, 12)        : onViewChange(viewYear, viewMonth - 1)
  const next = () => viewMonth === 12 ? onViewChange(viewYear + 1,  1)        : onViewChange(viewYear, viewMonth + 1)

  const pickDay = day => {
    // Preserve existing time; default 00:00 if nothing selected yet
    const h = selDate ? selDate.getHours()   : 0
    const m = selDate ? selDate.getMinutes() : 0
    const d = new Date(viewYear, viewMonth - 1, day, h, m)
    onSelect(Math.floor(d.getTime() / 1000))
  }

  // Leading blank cells + day numbers
  const cells = [
    ...Array(firstDow).fill(null),
    ...Array.from({ length: daysInMonth }, (_, i) => i + 1),
  ]
  // Pad to complete last row
  while (cells.length % 7 !== 0) cells.push(null)

  const btnBase = {
    width: 26, height: 26, borderRadius: '50%', border: 'none',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    fontSize: 11, cursor: 'pointer', transition: 'background 0.12s',
  }

  return (
    <div style={{ width: 196, userSelect: 'none' }}>
      {/* Month / year nav */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
        <button onClick={prev} style={{
          background: 'none', border: 'none', cursor: 'pointer',
          color: T.textMut, padding: '2px 6px', borderRadius: 4, fontSize: 13, lineHeight: 1,
        }}>‹</button>
        <span style={{ fontSize: 12, fontWeight: 600, color: T.textPri }}>
          {CAL_MONTHS[viewMonth - 1]} {viewYear}
        </span>
        <button onClick={next} style={{
          background: 'none', border: 'none', cursor: 'pointer',
          color: T.textMut, padding: '2px 6px', borderRadius: 4, fontSize: 13, lineHeight: 1,
        }}>›</button>
      </div>

      {/* Day-of-week headers */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 1, marginBottom: 2 }}>
        {CAL_DAYS.map(d => (
          <div key={d} style={{ textAlign: 'center', fontSize: 9, fontWeight: 600, color: T.textMut, padding: '0 0 2px' }}>{d}</div>
        ))}
      </div>

      {/* Day grid */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 1 }}>
        {cells.map((day, i) => {
          if (!day) return <div key={`_${i}`} />
          const isSelected = selDate &&
            selDate.getFullYear() === viewYear &&
            selDate.getMonth() + 1 === viewMonth &&
            selDate.getDate() === day
          const isToday = today.getFullYear() === viewYear &&
            today.getMonth() + 1 === viewMonth &&
            today.getDate() === day
          return (
            <div key={day} style={{ display: 'flex', justifyContent: 'center' }}>
              <button
                onClick={() => pickDay(day)}
                style={{
                  ...btnBase,
                  background: isSelected ? accentColor : 'transparent',
                  color: isSelected ? '#fff' : isToday ? accentColor : T.textPri,
                  fontWeight: isSelected ? 700 : isToday ? 600 : 400,
                  outline: isToday && !isSelected ? `1px solid ${accentColor}55` : 'none',
                }}
              >{day}</button>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ─── Tool result cards ────────────────────────────────────────────────────────

const TOOL_ICONS = {
  // Phase 1 — Data tools
  'fetch_timeseries':          Activity,
  'list_available_metrics':    Search,
  'create_graph':              BarChart3,
  'predict_timeseries':        TrendingUp,
  'find_historical_incidents': Search,
  'suggest_alert_thresholds':  Zap,
  'hunt_outliers':             AlertTriangle,
  'correlate_service_metrics': GitBranch,
  // Phase 2 — Design tools
  'set_graph_color':           Palette,
  'set_line_style':            Palette,
  'set_all_line_styles':       Palette,
  'set_graph_type':            BarChart3,
  'set_threshold_colors':      Zap,
  'set_graph_title':           Palette,
  'apply_style_preset':        Palette,
  'style_all_graphs':          Palette,
  // Phase 3 — Overlay tools
  'add_annotation':            Layers,
  'add_moving_average':        Activity,
  'add_threshold_line':        Zap,
  'add_trend_line':            TrendingUp,
  'add_time_grid':             Layers,
  'remove_overlay':            X,
}

const TOOL_COLORS = {
  // Phase 1
  'fetch_timeseries':          '#06b6d4',
  'list_available_metrics':    '#3b82f6',
  'create_graph':              '#7c3aed',
  'predict_timeseries':        '#f59e0b',
  'find_historical_incidents': '#10b981',
  'suggest_alert_thresholds':  '#ef4444',
  'hunt_outliers':             '#f59e0b',
  'correlate_service_metrics': '#7c3aed',
  // Phase 2
  'set_graph_color':           '#7c3aed',
  'set_line_style':            '#7c3aed',
  'set_all_line_styles':       '#7c3aed',
  'set_graph_type':            '#7c3aed',
  'set_threshold_colors':      '#ef4444',
  'set_graph_title':           '#7c3aed',
  'apply_style_preset':        '#7c3aed',
  'style_all_graphs':          '#7c3aed',
  // Phase 3
  'add_annotation':            '#f59e0b',
  'add_moving_average':        '#f59e0b',
  'add_threshold_line':        '#ef4444',
  'add_trend_line':            '#10b981',
  'add_time_grid':             '#64748b',
  'remove_overlay':            '#64748b',
}

function ToolResultCard({ toolName, result, onChartMetric }) {
  const { T } = useTheme()
  const [expanded, setExpanded] = useState(false)
  const Icon = TOOL_ICONS[toolName] || Wrench
  const accent = TOOL_COLORS[toolName] || T.cyan

  if (!result) return null

  const headerStyle = {
    display: 'flex', alignItems: 'center', gap: 7,
    padding: '8px 12px',
    background: `${accent}12`,
    borderBottom: `1px solid ${accent}22`,
    borderRadius: result.type === 'error' ? '8px' : '8px 8px 0 0',
    cursor: 'pointer',
  }

  const wrapStyle = {
    marginBottom: 12, borderRadius: 8,
    border: `1px solid ${result.type === 'error' ? T.red + '44' : accent + '33'}`,
    background: T.bgCard, fontSize: 12,
    overflow: 'hidden',
  }

  // ── error ────────────────────────────────────────────────────────────────
  if (result.type === 'error') {
    return (
      <div style={{ ...wrapStyle, border: `1px solid ${T.red}44` }}>
        <div style={{ ...headerStyle, background: `${T.red}12`, borderRadius: 8, borderBottom: 'none' }}>
          <AlertTriangle size={12} color={T.red} />
          <span style={{ fontSize: 11, fontWeight: 600, color: T.red, fontFamily: T.mono }}>{toolName}</span>
          <span style={{ marginLeft: 4, color: T.red, fontSize: 11 }}>failed</span>
        </div>
        <div style={{ padding: '6px 12px 10px', color: T.red, lineHeight: 1.55 }}>{result.message}</div>
      </div>
    )
  }

  // ── chart-update ─────────────────────────────────────────────────────────
  if (result.type === 'chart-update') {
    return (
      <div style={wrapStyle}>
        <div style={{ ...headerStyle, cursor: 'default', borderRadius: 8, borderBottom: 'none' }}>
          <Activity size={12} color={accent} />
          <span style={{ fontSize: 11, fontWeight: 600, color: accent, fontFamily: T.mono }}>{toolName}</span>
          <span style={{ marginLeft: 4, color: T.textSec, fontSize: 11 }}>
            {result.tabCreated ? '→ new tab' : '→ chart updated'}
          </span>
          <span style={{
            marginLeft: 'auto', fontSize: 9, fontWeight: 700, padding: '1px 7px', borderRadius: 10,
            background: `${T.green}18`, border: `1px solid ${T.green}44`, color: T.green,
          }}>
            {result.points} pts · {result.metric}
          </span>
        </div>
      </div>
    )
  }

  // ── graph-created ─────────────────────────────────────────────────────────
  if (result.type === 'graph-created') {
    return (
      <div style={wrapStyle}>
        <div style={{ ...headerStyle, cursor: 'default', borderRadius: 8, borderBottom: 'none' }}>
          <BarChart3 size={12} color={accent} />
          <span style={{ fontSize: 11, fontWeight: 600, color: accent, fontFamily: T.mono }}>{toolName}</span>
          <span style={{ marginLeft: 4, color: T.textSec, fontSize: 11 }}>
            "{result.title}" · {result.seriesCount} series
          </span>
          <span style={{
            marginLeft: 'auto', fontSize: 9, fontWeight: 700, padding: '1px 7px', borderRadius: 10,
            background: `${T.green}18`, border: `1px solid ${T.green}44`, color: T.green,
          }}>new tab</span>
        </div>
      </div>
    )
  }

  // ── metric-list ───────────────────────────────────────────────────────────
  if (result.type === 'metric-list') {
    const display = expanded ? result.metrics : result.metrics.slice(0, 12)
    return (
      <div style={wrapStyle}>
        <div style={headerStyle} onClick={() => setExpanded(e => !e)}>
          <Search size={12} color={accent} />
          <span style={{ fontSize: 11, fontWeight: 600, color: accent, fontFamily: T.mono }}>{toolName}</span>
          {result.query && <span style={{ color: T.textMut, fontSize: 11 }}>"{result.query}"</span>}
          <span style={{
            marginLeft: 'auto', fontSize: 9, fontWeight: 700, padding: '1px 7px', borderRadius: 10,
            background: `${accent}18`, border: `1px solid ${accent}44`, color: accent,
          }}>{result.total} metrics</span>
          <ChevronDown size={11} color={T.textMut}
            style={{ transform: expanded ? 'rotate(180deg)' : 'none', transition: 'transform 0.2s' }} />
        </div>
        <div style={{ padding: '8px 12px 10px', display: 'flex', flexWrap: 'wrap', gap: 5 }}>
          {display.map(name => (
            <button
              key={name}
              onClick={() => onChartMetric && onChartMetric(name)}
              title={`Chart ${name}`}
              style={{
                padding: '3px 9px', borderRadius: 10,
                border: `1px solid #28284a`, background: T.bgPanel,
                color: T.textSec, fontSize: 10, cursor: 'pointer', fontFamily: T.mono,
              }}
            >{name}</button>
          ))}
          {!expanded && result.total > 12 && (
            <button
              onClick={() => setExpanded(true)}
              style={{
                padding: '3px 9px', borderRadius: 10,
                border: `1px solid ${accent}44`, background: `${accent}12`,
                color: accent, fontSize: 10, cursor: 'pointer',
              }}
            >+{result.total - 12} more</button>
          )}
        </div>
      </div>
    )
  }

  // ── forecast-result ───────────────────────────────────────────────────────
  if (result.type === 'forecast-result') {
    const pctChange = result.current && result.predicted
      ? (((result.predicted - result.current) / Math.abs(result.current)) * 100).toFixed(1)
      : null
    return (
      <div style={wrapStyle}>
        <div style={headerStyle} onClick={() => setExpanded(e => !e)}>
          <TrendingUp size={12} color={accent} />
          <span style={{ fontSize: 11, fontWeight: 600, color: accent, fontFamily: T.mono }}>{toolName}</span>
          <span style={{ color: T.textMut, fontSize: 11 }}>{result.metric}</span>
          {pctChange && (
            <span style={{
              marginLeft: 'auto', fontSize: 9, fontWeight: 700, padding: '1px 7px', borderRadius: 10,
              background: `${parseFloat(pctChange) > 0 ? T.red : T.green}18`,
              border: `1px solid ${parseFloat(pctChange) > 0 ? T.red : T.green}44`,
              color: parseFloat(pctChange) > 0 ? T.red : T.green,
            }}>{pctChange > 0 ? '+' : ''}{pctChange}%</span>
          )}
          <ChevronDown size={11} color={T.textMut}
            style={{ transform: expanded ? 'rotate(180deg)' : 'none', transition: 'transform 0.2s' }} />
        </div>
        {expanded && (
          <div style={{ padding: '8px 12px 10px', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '4px 16px' }}>
            {[
              ['Metric', result.metric],
              ['Horizon', `${result.horizon}s`],
              ['Current', result.current?.toPrecision(5)],
              ['Predicted', result.predicted?.toPrecision(5)],
              ['Confidence', result.confLow != null ? `[${result.confLow?.toPrecision(4)}, ${result.confHigh?.toPrecision(4)}]` : '—'],
              ['Quality', result.quality],
              ['Model', result.model],
              ['RMSE', result.rmse?.toFixed(4)],
            ].filter(([, v]) => v != null).map(([k, v]) => (
              <div key={k} style={{ fontSize: 11, color: T.textMut }}>
                {k}: <span style={{ color: T.textSec, fontFamily: T.mono }}>{v}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    )
  }

  // ── outlier-list ──────────────────────────────────────────────────────────
  if (result.type === 'outlier-list') {
    const display = expanded ? result.anomalies : result.anomalies.slice(0, 5)
    const severityColor = s => s?.toLowerCase() === 'critical' ? T.red : s?.toLowerCase() === 'high' ? '#f59e0b' : T.textMut
    return (
      <div style={wrapStyle}>
        <div style={headerStyle} onClick={() => setExpanded(e => !e)}>
          <AlertTriangle size={12} color={accent} />
          <span style={{ fontSize: 11, fontWeight: 600, color: accent, fontFamily: T.mono }}>{toolName}</span>
          <span style={{
            marginLeft: 'auto', fontSize: 9, fontWeight: 700, padding: '1px 7px', borderRadius: 10,
            background: result.total > 0 ? `${T.red}18` : `${T.green}18`,
            border: `1px solid ${result.total > 0 ? T.red : T.green}44`,
            color: result.total > 0 ? T.red : T.green,
          }}>{result.total} outlier{result.total !== 1 ? 's' : ''}</span>
          <ChevronDown size={11} color={T.textMut}
            style={{ transform: expanded ? 'rotate(180deg)' : 'none', transition: 'transform 0.2s' }} />
        </div>
        {result.total === 0 ? (
          <div style={{ padding: '8px 12px', color: T.green, fontSize: 11 }}>No anomalies matching the filter.</div>
        ) : (
          <div style={{ padding: '6px 12px 10px' }}>
            {display.map((a, i) => (
              <div key={i} style={{
                display: 'flex', alignItems: 'flex-start', gap: 8, padding: '5px 0',
                borderBottom: i < display.length - 1 ? `1px solid ${T.border}` : 'none',
              }}>
                <span style={{
                  fontSize: 9, fontWeight: 700, padding: '1px 5px', borderRadius: 4, marginTop: 1, flexShrink: 0,
                  background: `${severityColor(a.severity)}22`,
                  border: `1px solid ${severityColor(a.severity)}44`,
                  color: severityColor(a.severity),
                  textTransform: 'uppercase',
                }}>{a.severity || 'warn'}</span>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 11, color: T.textSec, fontFamily: T.mono }}>{a.metric_string}</div>
                  <div style={{ fontSize: 10, color: T.textMut, marginTop: 2 }}>
                    RMSE: {a.rmse?.toFixed(2)} · {a.reason}
                  </div>
                </div>
                <button
                  onClick={() => onChartMetric && onChartMetric(a.metric_string)}
                  style={{
                    padding: '2px 8px', borderRadius: 6, fontSize: 9, cursor: 'pointer',
                    border: `1px solid ${T.cyan}44`, background: `${T.cyan}12`,
                    color: T.cyan, flexShrink: 0,
                  }}
                >Chart</button>
              </div>
            ))}
            {!expanded && result.total > 5 && (
              <button
                onClick={() => setExpanded(true)}
                style={{
                  marginTop: 5, padding: '3px 9px', borderRadius: 8, fontSize: 10, cursor: 'pointer',
                  border: `1px solid ${accent}44`, background: `${accent}12`, color: accent,
                }}
              >Show {result.total - 5} more</button>
            )}
          </div>
        )}
      </div>
    )
  }

  // ── threshold-suggestions ─────────────────────────────────────────────────
  if (result.type === 'threshold-suggestions') {
    return (
      <div style={wrapStyle}>
        <div style={{ ...headerStyle, cursor: 'default' }} onClick={() => setExpanded(e => !e)}>
          <Zap size={12} color={accent} />
          <span style={{ fontSize: 11, fontWeight: 600, color: accent, fontFamily: T.mono }}>{toolName}</span>
          <span style={{ color: T.textMut, fontSize: 11 }}>{result.metrics.join(', ')}</span>
          <ChevronDown size={11} color={T.textMut} style={{ marginLeft: 'auto',
            transform: expanded ? 'rotate(180deg)' : 'none', transition: 'transform 0.2s' }} />
        </div>
        <div style={{ padding: '6px 12px 10px' }}>
          {result.metrics.map(name => {
            const s = result.suggestions[name]
            if (!s) return null
            if (s.error) return (
              <div key={name} style={{ fontSize: 11, color: T.red, padding: '4px 0' }}>
                {name}: {s.error}
              </div>
            )
            return (
              <div key={name} style={{ marginBottom: 10 }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: T.textSec, marginBottom: 4, fontFamily: T.mono }}>
                  {name} <span style={{ fontWeight: 400, color: T.textMut }}>({s.samples} samples, 24h)</span>
                </div>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  {[
                    ['P50', s.p50, T.textMut],
                    ['P90', s.p90, '#f59e0b'],
                    ['P95', s.p95, T.red],
                    ['P99', s.p99, T.red],
                  ].map(([label, val, color]) => (
                    <div key={label} style={{
                      padding: '3px 8px', borderRadius: 6, fontSize: 10,
                      background: `${color}12`, border: `1px solid ${color}33`, color,
                    }}>
                      {label}: <strong style={{ fontFamily: T.mono }}>{val}</strong>
                    </div>
                  ))}
                </div>
                <div style={{ marginTop: 5, fontSize: 10, color: T.textMut }}>
                  Suggested: Warning ≥ <span style={{ color: '#f59e0b', fontFamily: T.mono }}>{s.warning}</span>
                  {' '}· Critical ≥ <span style={{ color: T.red, fontFamily: T.mono }}>{s.critical}</span>
                </div>
              </div>
            )
          })}
        </div>
      </div>
    )
  }

  // ── incident-list (vector DB) ─────────────────────────────────────────────
  if (result.type === 'incident-list') {
    return (
      <div style={wrapStyle}>
        <div style={headerStyle} onClick={() => setExpanded(e => !e)}>
          <Search size={12} color={accent} />
          <span style={{ fontSize: 11, fontWeight: 600, color: accent, fontFamily: T.mono }}>{toolName}</span>
          <span style={{ color: T.textMut, fontSize: 11 }}>{result.metric}</span>
          <span style={{
            marginLeft: 'auto', fontSize: 9, fontWeight: 700, padding: '1px 7px', borderRadius: 10,
            background: `${accent}18`, border: `1px solid ${accent}44`, color: accent,
          }}>{result.total} match{result.total !== 1 ? 'es' : ''}</span>
          <ChevronDown size={11} color={T.textMut}
            style={{ transform: expanded ? 'rotate(180deg)' : 'none', transition: 'transform 0.2s' }} />
        </div>
        {result.total === 0 ? (
          <div style={{ padding: '8px 12px', color: T.textMut, fontSize: 11 }}>No similar historical incidents found in the vector DB.</div>
        ) : (
          <div style={{ padding: '6px 12px 10px' }}>
            {(expanded ? result.matches : result.matches.slice(0, 3)).map((m, i) => {
              const meta = m.metadata || {}
              return (
                <div key={i} style={{
                  padding: '5px 0',
                  borderBottom: i < result.matches.length - 1 ? `1px solid ${T.border}` : 'none',
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{
                      fontSize: 9, padding: '1px 5px', borderRadius: 4,
                      background: `${accent}18`, border: `1px solid ${accent}44`, color: accent, flexShrink: 0,
                    }}>score {m.score?.toFixed(3)}</span>
                    <span style={{ fontSize: 11, color: T.textSec, fontFamily: T.mono }}>
                      {meta.incident_id || `match_${i + 1}`}
                    </span>
                  </div>
                  {meta.root_cause && meta.root_cause !== 'Unknown Cause' && (
                    <div style={{ fontSize: 10, color: T.textMut, marginTop: 2 }}>
                      Root cause: {meta.root_cause}
                    </div>
                  )}
                  {meta.matched_patterns && (
                    <div style={{ fontSize: 10, color: T.amber, marginTop: 1 }}>
                      Pattern: {meta.matched_patterns}
                    </div>
                  )}
                </div>
              )
            })}
            {!expanded && result.total > 3 && (
              <button onClick={() => setExpanded(true)} style={{
                marginTop: 5, padding: '3px 9px', borderRadius: 8, fontSize: 10, cursor: 'pointer',
                border: `1px solid ${accent}44`, background: `${accent}12`, color: accent,
              }}>Show {result.total - 3} more</button>
            )}
          </div>
        )}
      </div>
    )
  }

  // ── correlation-graph ─────────────────────────────────────────────────────
  if (result.type === 'correlation-graph') {
    const allEdges = result.causalEdges
    return (
      <div style={wrapStyle}>
        <div style={headerStyle} onClick={() => setExpanded(e => !e)}>
          <GitBranch size={12} color={accent} />
          <span style={{ fontSize: 11, fontWeight: 600, color: accent, fontFamily: T.mono }}>{toolName}</span>
          {result.metric && <span style={{ color: T.textMut, fontSize: 11 }}>{result.metric}</span>}
          <span style={{
            marginLeft: 'auto', fontSize: 9, fontWeight: 700, padding: '1px 7px', borderRadius: 10,
            background: `${accent}18`, border: `1px solid ${accent}44`, color: accent,
          }}>{result.totalCausal} causal · {result.totalStructural} structural</span>
          <ChevronDown size={11} color={T.textMut}
            style={{ transform: expanded ? 'rotate(180deg)' : 'none', transition: 'transform 0.2s' }} />
        </div>
        {allEdges.length === 0 ? (
          <div style={{ padding: '8px 12px', color: T.textMut, fontSize: 11 }}>No causal edges found for this filter.</div>
        ) : (
          <div style={{ padding: '6px 12px 10px' }}>
            {(expanded ? allEdges : allEdges.slice(0, 4)).map((e, i) => (
              <div key={i} style={{
                display: 'flex', alignItems: 'center', gap: 6, padding: '4px 0', fontSize: 11,
                borderBottom: i < allEdges.length - 1 ? `1px solid ${T.border}` : 'none',
              }}>
                <span style={{ color: T.textSec, fontFamily: T.mono, fontSize: 10 }}>{e.source_metric}</span>
                <span style={{ color: T.textMut, fontSize: 10 }}>→</span>
                <span style={{ color: T.textSec, fontFamily: T.mono, fontSize: 10 }}>{e.target_metric}</span>
                <span style={{ marginLeft: 'auto', color: T.textMut, fontSize: 10, whiteSpace: 'nowrap' }}>
                  +{e.lag_seconds}s · r={e.max_correlation?.toFixed(3)}
                </span>
              </div>
            ))}
            {!expanded && allEdges.length > 4 && (
              <button onClick={() => setExpanded(true)} style={{
                marginTop: 5, padding: '3px 9px', borderRadius: 8, fontSize: 10, cursor: 'pointer',
                border: `1px solid ${accent}44`, background: `${accent}12`, color: accent,
              }}>Show {allEdges.length - 4} more</button>
            )}
          </div>
        )}
      </div>
    )
  }

  // ── design-update ─────────────────────────────────────────────────────────
  if (result.type === 'design-update') {
    // Compact one-line confirmation — design tools are low-noise
    const swatchColor = result.color || (result.thresholds?.[0]?.color) || accent
    return (
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8,
        padding: '6px 12px', marginBottom: 8, borderRadius: 7,
        border: `1px solid ${accent}22`,
        background: `${accent}08`,
      }}>
        <Palette size={11} color={accent} style={{ flexShrink: 0 }} />
        <span style={{ fontSize: 10, fontWeight: 600, color: accent, fontFamily: T.mono }}>{result.tool}</span>
        <span style={{ fontSize: 11, color: T.textSec, flex: 1 }}>{result.summary}</span>
        {/* Swatch for color changes */}
        {result.color && (
          <div style={{
            width: 14, height: 14, borderRadius: 3,
            background: result.color,
            border: `1px solid ${T.border}`,
            flexShrink: 0,
          }} />
        )}
        {/* Threshold pills */}
        {result.thresholds && (
          <div style={{ display: 'flex', gap: 4 }}>
            {result.thresholds.map((th, i) => (
              <div key={i} style={{
                width: 14, height: 14, borderRadius: 3,
                background: th.color, border: `1px solid ${T.border}`, flexShrink: 0,
              }} title={`${th.label}: ${th.above !== false ? '≥' : '≤'} ${th.value}`} />
            ))}
          </div>
        )}
        {/* Preset description */}
        {result.presetDescription && (
          <span style={{ fontSize: 9, color: T.textMut, fontStyle: 'italic', maxWidth: 120, textAlign: 'right' }}>
            {result.presetDescription}
          </span>
        )}
      </div>
    )
  }

  // ── overlay-added ─────────────────────────────────────────────────────────
  if (result.type === 'overlay-added') {
    const typeLabel = {
      movingAverage: 'MA',
      annotation:    'Annotation',
      thresholdLine: 'Threshold line',
      trendLine:     'Trend line',
      timeGrid:      'Time grid',
    }[result.overlayType] || result.overlayType

    return (
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8,
        padding: '6px 12px', marginBottom: 8, borderRadius: 7,
        border: `1px solid ${accent}22`,
        background: `${accent}08`,
      }}>
        <Icon size={11} color={accent} style={{ flexShrink: 0 }} />
        <span style={{ fontSize: 10, fontWeight: 600, color: accent, fontFamily: T.mono }}>{toolName}</span>
        <span style={{ fontSize: 11, color: T.textSec, flex: 1 }}>{result.summary}</span>
        <span style={{
          fontSize: 9, fontWeight: 700, padding: '1px 6px', borderRadius: 8,
          background: `${accent}18`, border: `1px solid ${accent}44`, color: accent, flexShrink: 0,
        }}>{typeLabel}</span>
        {result.color && (
          <div style={{
            width: 12, height: 12, borderRadius: 3, background: result.color,
            border: `1px solid ${T.border}`, flexShrink: 0,
          }} />
        )}
      </div>
    )
  }

  // ── overlay-removed ───────────────────────────────────────────────────────
  if (result.type === 'overlay-removed') {
    return (
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8,
        padding: '6px 12px', marginBottom: 8, borderRadius: 7,
        border: `1px solid ${T.border}`,
        background: T.bgCard,
      }}>
        <X size={11} color={T.textMut} style={{ flexShrink: 0 }} />
        <span style={{ fontSize: 10, fontWeight: 600, color: T.textMut, fontFamily: T.mono }}>{toolName}</span>
        <span style={{ fontSize: 11, color: T.textSec, flex: 1 }}>{result.summary}</span>
      </div>
    )
  }

  // Fallback for unknown result types
  return null
}

// ─── Suggestion sets per mode ─────────────────────────────────────────────────

const MODE_CONFIG = {
  data: {
    label: 'Data', icon: Database, color: T.cyan,
    desc: 'Explore and query your metrics',
    chips: [
      'Show me all available metrics',
      'Chart cpu_usage for the last hour',
      'Find outliers with RMSE above 1.0',
      'Predict disk_free for the next 5 minutes',
      'Suggest alert thresholds for cpu_usage',
      'Show causal correlations for error_rate',
    ],
  },
  design: {
    label: 'Design', icon: Palette, color: T.purple,
    desc: 'Customize chart appearance',
    chips: [
      'Apply the aurora-neon preset',
      'Apply dark-executive preset to all charts',
      'Switch to an area chart',
      'Make the lines dashed and thinner',
      'Color the first series red',
      'Add a critical threshold at 80 and a healthy zone below 20',
      'Apply the vivid preset',
      'Apply the terminal preset',
    ],
  },
  overlay: {
    label: 'Overlay', icon: Layers, color: T.amber,
    desc: 'Add analytical overlays to your charts',
    chips: [
      'Add a 7-period moving average',
      'Add a trend line',
      'Add a threshold line at 80 labeled "SLA"',
      'Mark 02:30 PM as "Deploy v2.1"',
      'Add a time grid every 10 points',
      'Remove all overlays',
    ],
  },
}

// ─── Small UI helpers ─────────────────────────────────────────────────────────

function ModeTab({ id, mode, active, onClick }) {
  const { T } = useTheme()
  const cfg = MODE_CONFIG[id]
  const Icon = cfg.icon
  return (
    <button
      onClick={() => onClick(id)}
      style={{
        flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5,
        padding: '9px 4px', fontSize: 13, fontWeight: 600, border: 'none', cursor: 'pointer',
        borderBottom: active ? `2px solid ${cfg.color}` : '2px solid transparent',
        background: active ? `${cfg.color}12` : 'transparent',
        color: active ? cfg.color : T.textSec,
        transition: 'all 0.15s',
      }}
    >
      <Icon size={13} />
      {cfg.label}
    </button>
  )
}

function ChatMessage({ msg, onChartMetric }) {
  const { T } = useTheme()
  const isUser = msg.role === 'user'
  const isError = msg.role === 'error'

  // Tool result cards are rendered inline in the message list
  if (msg.role === 'tool-result') {
    return <ToolResultCard toolName={msg.toolName} result={msg.result} onChartMetric={onChartMetric} />
  }
  return (
    <div style={{
      display: 'flex', gap: 9, marginBottom: 14,
      justifyContent: isUser ? 'flex-end' : 'flex-start', alignItems: 'flex-start',
    }}>
      {!isUser && (
        <div style={{
          width: 26, height: 26, borderRadius: '50%', flexShrink: 0, marginTop: 1,
          background: isError ? `${T.red}22` : `linear-gradient(135deg, ${T.purple}, ${T.cyan})`,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          {isError ? <AlertTriangle size={12} color={T.red} /> : <Bot size={12} color="#fff" />}
        </div>
      )}
      <div style={{
        maxWidth: '82%',
        padding: '9px 13px',
        borderRadius: isUser ? '14px 14px 4px 14px' : '4px 14px 14px 14px',
        background: isUser ? `linear-gradient(135deg, ${T.purple}dd, ${T.cyan}bb)` : isError ? `${T.red}14` : T.bgCard,
        border: isUser ? 'none' : `1px solid ${isError ? T.red + '55' : '#28284a'}`,
        color: isUser ? '#fff' : isError ? T.red : T.textPri,
        fontSize: 13.5, lineHeight: 1.7, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
      }}>
        {msg.content}
        {msg.chartFetching && (
          <div style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 6, color: T.cyan, fontSize: 11 }}>
            <RefreshCw size={11} style={{ animation: 'spin 1s linear infinite' }} />
            Fetching metric data…
          </div>
        )}
      </div>
      {isUser && (
        <div style={{
          width: 26, height: 26, borderRadius: '50%', flexShrink: 0, marginTop: 1,
          background: '#28284a', display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <User size={12} color={T.textSec} />
        </div>
      )}
    </div>
  )
}

function ThinkingIndicator() {
  const { T } = useTheme()
  return (
    <div style={{ display: 'flex', gap: 9, marginBottom: 14, alignItems: 'flex-start' }}>
      <div style={{
        width: 26, height: 26, borderRadius: '50%',
        background: `linear-gradient(135deg, ${T.purple}, ${T.cyan})`,
        display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
      }}>
        <Bot size={12} color="#fff" />
      </div>
      <div style={{
        padding: '10px 14px', borderRadius: '4px 14px 14px 14px',
        background: T.bgCard, border: `1px solid #28284a`,
        display: 'flex', alignItems: 'center', gap: 5,
      }}>
        {[0, 1, 2].map(i => (
          <div key={i} style={{
            width: 6, height: 6, borderRadius: '50%', background: T.textMut,
            animation: `bounce 1.2s infinite ${i * 0.2}s`,
          }} />
        ))}
      </div>
    </div>
  )
}

// ─── Main page ────────────────────────────────────────────────────────────────

let tabIdCounter = 2

export default function AIDashboard() {
  const { T, glow } = useTheme()
  // Credentials
  const [creds, setCreds] = useState(() => getAICredentials())
  const [provider, setProvider] = useState(creds.provider || 'openai')
  const [model, setModel] = useState(
    creds.model || PROVIDERS[creds.provider || 'openai']?.models?.[0] || ''
  )
  const [apiKey, setApiKey] = useState(creds.apiKey || '')
  const [localUrl, setLocalUrl] = useState(creds.local_url || 'http://localhost:11434')
  const [localModel, setLocalModel] = useState(creds.local_model || 'llama3')
  const [showKey, setShowKey] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(
    !creds.apiKey && creds.provider !== 'local'
  )
  const [credsSaved, setCredsSaved] = useState(false)

  // Chat
  const [messages, setMessages] = useState([])
  const [input, setInput] = useState('')
  const [thinking, setThinking] = useState(false)
  const [mode, setMode] = useState('data')

  // Charts / tabs
  // Tab shape: { id, label, color, charts: [{id, spec, loading}], timeRange: number (seconds) }
  const TAB_COLORS = ['#06b6d4','#7c3aed','#10b981','#f59e0b','#ef4444','#3b82f6','#ec4899','#84cc16','#f97316','#a855f7']
  const [tabs, setTabs] = useState([{ id: 'main', label: 'Dashboard 1', color: '#06b6d4', charts: [], timeRange: 3600 }])
  const [activeTabId, setActiveTabId] = useState('main')
  // Which specific chart card is focused (for overlay/modify operations)
  const [selectedChartId, setSelectedChartId] = useState(null)
  // Tab rename state
  const [renamingTabId, setRenamingTabId] = useState(null)
  const [renameValue, setRenameValue] = useState('')
  // Drag-to-reorder state
  const [dragChartId, setDragChartId] = useState(null)
  const [dragOverChartId, setDragOverChartId] = useState(null)
  // Presentation mode
  const [presentationIdx, setPresentationIdx] = useState(null) // null = off, number = slide index

  // Context — fetched from all TSDB data layers via contextEngine
  const [context, setContext] = useState(null)

  // Persistence
  const [savedSessions, setSavedSessions] = useState([])
  const [currentSessionId, setCurrentSessionId] = useState(() => newSessionId())
  const [saveIndicator, setSaveIndicator] = useState(null) // null | 'saving' | 'saved' | 'error'
  const [sessionDropdownOpen, setSessionDropdownOpen] = useState(false)
  const autoSaveTimerRef = useRef(null)

  const messagesEndRef = useRef(null)
  const inputRef = useRef(null)
  // Map of chartId → chart body DOM node, used for PNG export
  const chartBodyRefs = useRef({})
  // Always-current tabs ref (avoids stale closure in time-range handler)
  const tabsRef = useRef(tabs)
  useEffect(() => { tabsRef.current = tabs }, [tabs])

  // Custom date/time range picker state
  const [customRangeOpen, setCustomRangeOpen] = useState(false)
  const [customStart, setCustomStart] = useState('')  // datetime-local string "YYYY-MM-DDTHH:mm"
  const [customEnd,   setCustomEnd]   = useState('')  // datetime-local string "YYYY-MM-DDTHH:mm"
  // Calendar view months (which month is displayed in each calendar)
  const nowY = new Date().getFullYear(), nowM = new Date().getMonth() + 1
  const [calStartView, setCalStartView] = useState({ year: nowY, month: nowM })
  const [calEndView,   setCalEndView]   = useState({ year: nowY, month: nowM })
  // Ref for the chart area inside presentation mode
  const presentationChartRef = useRef(null)

  // Load full context on mount + restore last persisted session
  useEffect(() => {
    fetchFullContext().then(setContext)

    loadUIState().then(state => {
      if (state.sessions?.length > 0) {
        setSavedSessions(state.sessions)
        // Restore the most recent session automatically
        const last = state.sessions[state.sessions.length - 1]
        if (last) {
          setCurrentSessionId(last.id)
          if (last.messages?.length > 0) setMessages(last.messages)
          if (last.tabs?.length > 0) {
            // Migrate old model (tab.spec) → new model (tab.charts[])
            setTabs(last.tabs.map(t => {
              const base = t.charts
                ? { ...t, charts: t.charts.map(c => ({ ...c, loading: false })) }
                : { ...t, charts: t.spec ? [{ id: `chart_legacy_${t.id}`, spec: t.spec, loading: false }] : [], spec: undefined, loading: undefined }
              return { ...base, timeRange: t.timeRange ?? 3600 }
            }))
            setActiveTabId(last.tabs[0]?.id || 'main')
          }
        }
      }
    })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Debounced auto-save whenever messages or tabs change
  const autoSave = useCallback((msgs, tbls, sessId, sessions) => {
    if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current)
    autoSaveTimerRef.current = setTimeout(async () => {
      // Only save if there's something meaningful in the session
      const userMessages = msgs.filter(m => m.role === 'user' || m.role === 'assistant')
      if (userMessages.length === 0) return

      setSaveIndicator('saving')
      const sessionEntry = {
        id: sessId,
        label: defaultSessionLabel(),
        savedAt: new Date().toISOString(),
        tabs: tbls,
        messages: msgs.filter(m => m.role === 'user' || m.role === 'assistant'),
      }

      const nextSessions = sessions.some(s => s.id === sessId)
        ? sessions.map(s => s.id === sessId ? sessionEntry : s)
        : [...sessions, sessionEntry]

      // Keep at most 20 sessions
      const trimmed = nextSessions.slice(-20)

      const state = {
        version: 1,
        sessions: trimmed,
        dashboards: [],
        currentSessionId: sessId,
      }

      const ok = await saveUIState(state)
      setSavedSessions(trimmed)
      setSaveIndicator(ok ? 'saved' : 'error')
      setTimeout(() => setSaveIndicator(null), 2200)
    }, 1500)
  }, [])

  // Trigger auto-save when messages or tabs change
  useEffect(() => {
    autoSave(messages, tabs, currentSessionId, savedSessions)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, tabs])

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, thinking])

  // Keyboard navigation for presentation mode
  useEffect(() => {
    if (presentationIdx === null) return
    const handler = (e) => {
      const charts = tabs.find(t => t.id === activeTabId)?.charts || []
      if (!charts.length) return
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
        e.preventDefault()
        setPresentationIdx(i => Math.min(i + 1, charts.length - 1))
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
        e.preventDefault()
        setPresentationIdx(i => Math.max(i - 1, 0))
      } else if (e.key === 'Escape') {
        setPresentationIdx(null)
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [presentationIdx, activeTabId, tabs])

  const activeTab = tabs.find(t => t.id === activeTabId) || tabs[0]
  // Selected chart (may be in any tab, but UI only acts on active tab's selection)
  const activeTabCharts = activeTab?.charts || []
  const selectedChart = activeTabCharts.find(c => c.id === selectedChartId) || null
  const currentSpec = selectedChart?.spec || null

  // ── Save credentials ────────────────────────────────────────────────────────

  const saveCreds = () => {
    const c = { provider, model, apiKey, local_url: localUrl, local_model: localModel }
    saveAICredentials(c)
    setCreds(c)
    setCredsSaved(true)
    setTimeout(() => setCredsSaved(false), 2000)
    if (apiKey || provider === 'local') setSettingsOpen(false)
  }

  // ── Add a new dashboard tab (used by tool engine) ──────────────────────────

  const addTab = useCallback((spec) => {
    const id = `tab_${tabIdCounter++}`
    const firstChart = spec ? [{ id: `chart_${Date.now()}`, spec, loading: false }] : []
    const color = TAB_COLORS[(tabIdCounter - 2) % TAB_COLORS.length]
    setTabs(prev => [...prev, { id, label: spec?.title || `Dashboard ${tabIdCounter - 1}`, color, charts: firstChart, timeRange: 3600 }])
    setActiveTabId(id)
    return id
  }, [TAB_COLORS])

  // ── Chart CRUD helpers ──────────────────────────────────────────────────────

  // Add a brand-new chart card to a tab, return its id
  const addChartToTab = useCallback((tabId, spec) => {
    const chartId = `chart_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
    setTabs(prev => prev.map(t => t.id !== tabId ? t : {
      ...t,
      charts: [...t.charts, { id: chartId, spec, loading: false }],
    }))
    setSelectedChartId(chartId)
    return chartId
  }, [])

  // Update an existing chart's spec in place
  const updateChartSpec = useCallback((tabId, chartId, specOrUpdater) => {
    setTabs(prev => prev.map(t => t.id !== tabId ? t : {
      ...t,
      charts: t.charts.map(c => {
        if (c.id !== chartId) return c
        const next = typeof specOrUpdater === 'function' ? specOrUpdater(c.spec) : specOrUpdater
        return { ...c, spec: next, loading: false }
      }),
    }))
  }, [])

  const setChartLoading = useCallback((tabId, chartId, loading) => {
    setTabs(prev => prev.map(t => t.id !== tabId ? t : {
      ...t,
      charts: t.charts.map(c => c.id !== chartId ? c : { ...c, loading }),
    }))
  }, [])

  // ── Post-process AI spec: fetch metric data if needed ───────────────────────
  // chartId = null → create a new chart in the tab
  // chartId = string → update that existing chart

  const resolveChartSpec = useCallback(async (spec, tabId, chartId, durationSeconds) => {
    if (!spec) return

    // Decide target chart: use existing one or create a placeholder
    let targetChartId = chartId
    if (!targetChartId) {
      targetChartId = addChartToTab(tabId, { ...spec, series: spec.series?.map(s => ({ ...s, data: [] })) })
    }

    // Fall back to this tab's current timeRange, then to 3600
    const tabTimeRange = durationSeconds != null ? durationSeconds
      : (tabsRef.current.find(t => t.id === tabId)?.timeRange ?? 3600)
    const isCustomRange = typeof tabTimeRange === 'object' && tabTimeRange !== null
    const duration  = isCustomRange ? (tabTimeRange.end - tabTimeRange.start) : tabTimeRange
    const fetchOpts = isCustomRange ? { start: tabTimeRange.start, end: tabTimeRange.end } : {}

    const needsFetch = spec.series?.some(s => s.metric && !s.data?.length)
    if (!needsFetch) {
      updateChartSpec(tabId, targetChartId, spec)
      return
    }

    setChartLoading(tabId, targetChartId, true)
    const resolved = {
      ...spec,
      series: await Promise.all(spec.series.map(async s => {
        if (!s.metric) return s
        try {
          const results = await queryMetricRange(s.metric, duration, fetchOpts)
          if (!results.length) {
            return { ...s, data: [], fetchError: `No data found for metric "${s.metric}" in the selected time range` }
          }
          const best = results.find(r => r.name === s.metric) || results[0]
          if (!best?.data?.length) {
            return { ...s, data: [], fetchError: `Metric "${s.metric}" returned empty time series` }
          }
          return { ...s, data: best.data, fetchError: null }
        } catch (err) {
          return { ...s, data: [], fetchError: err.message }
        }
      })),
    }
    updateChartSpec(tabId, targetChartId, resolved)
  }, [addChartToTab, updateChartSpec, setChartLoading])

  // Legacy alias used by the tool engine (phase 2 tools still call updateTabSpec)
  const updateTabSpec = useCallback((tabId, specOrUpdater) => {
    // For tool engine compatibility: update the selected chart or the first chart on the tab
    setTabs(prev => {
      const tab = prev.find(t => t.id === tabId)
      if (!tab) return prev
      const targetChart = tab.charts.find(c => c.id === selectedChartId) || tab.charts[0]
      if (!targetChart) {
        // No charts yet — add one
        const chartId = `chart_${Date.now()}`
        const spec = typeof specOrUpdater === 'function' ? specOrUpdater(null) : specOrUpdater
        return prev.map(t => t.id !== tabId ? t : { ...t, charts: [...t.charts, { id: chartId, spec, loading: false }] })
      }
      return prev.map(t => t.id !== tabId ? t : {
        ...t,
        charts: t.charts.map(c => {
          if (c.id !== targetChart.id) return c
          const next = typeof specOrUpdater === 'function' ? specOrUpdater(c.spec) : specOrUpdater
          return { ...c, spec: next, loading: false }
        }),
      })
    })
  }, [selectedChartId])

  const setTabLoading = useCallback((tabId, loading) => {
    // Legacy: apply loading state to first chart on tab
    setTabs(prev => prev.map(t => t.id !== tabId ? t : {
      ...t,
      charts: t.charts.map((c, i) => i === 0 ? { ...c, loading } : c),
    }))
  }, [])

  // ── Merge design/overlay update into existing spec ──────────────────────────

  const mergeSpec = useCallback((existing, incoming) => {
    if (!existing) return incoming
    return {
      ...existing,
      ...incoming,
      series: incoming.series
        ? incoming.series.map((s, i) => ({ ...(existing.series?.[i] || {}), ...s }))
        : existing.series,
      overlays: incoming.overlays !== undefined ? incoming.overlays : existing.overlays,
    }
  }, [])

  // ── Global time range change ─────────────────────────────────────────────────
  // Re-fetches all metric-backed charts on the active tab with the new duration.
  // Preserves every spec property (overlays, colors, titles, AI tweaks, dashArrays, …).

  // durationOrRange: number (preset seconds) OR { start: epochSec, end: epochSec } (custom)
  const handleTimeRangeChange = useCallback(async (durationOrRange, tabId) => {
    const targetTabId = tabId || activeTabId
    const isCustom    = typeof durationOrRange === 'object' && durationOrRange !== null
    const duration    = isCustom
      ? (durationOrRange.end - durationOrRange.start)
      : durationOrRange
    const fetchOpts   = isCustom
      ? { start: durationOrRange.start, end: durationOrRange.end }
      : {}

    // 1. Persist the new timeRange on this tab
    setTabs(prev => prev.map(t => t.id !== targetTabId ? t : { ...t, timeRange: durationOrRange }))

    // 2. Snapshot current charts (fresh from ref — not stale closure)
    const currentTab = tabsRef.current.find(t => t.id === targetTabId)
    const chartsToRefresh = (currentTab?.charts || []).filter(c =>
      c.spec?.series?.some(s => s.metric)
    )
    if (!chartsToRefresh.length) return

    // 3. Mark all target charts as loading
    setTabs(prev => prev.map(t => t.id !== targetTabId ? t : {
      ...t,
      charts: t.charts.map(c =>
        chartsToRefresh.some(r => r.id === c.id) ? { ...c, loading: true } : c
      ),
    }))

    // 4. Fetch all in parallel, preserving the full spec (overlays, colors, etc.)
    await Promise.all(chartsToRefresh.map(async chart => {
      const spec = chart.spec
      const resolvedSeries = await Promise.all((spec.series || []).map(async s => {
        if (!s.metric) return s
        try {
          const results = await queryMetricRange(s.metric, duration, fetchOpts)
          if (!results.length) return { ...s, data: [], fetchError: `No data for "${s.metric}" in this range` }
          const best = results.find(r => r.name === s.metric) || results[0]
          return { ...s, data: best?.data || [], fetchError: null }
        } catch (err) {
          return { ...s, data: [], fetchError: err.message }
        }
      }))
      // Preserve entire spec — only update series data
      updateChartSpec(targetTabId, chart.id, { ...spec, series: resolvedSeries })
    }))
  }, [activeTabId, updateChartSpec])

  // ── Send message ────────────────────────────────────────────────────────────

  const sendMessage = async (text) => {
    const userText = (text || input).trim()
    if (!userText || thinking) return
    if (provider !== 'local' && !apiKey) { setSettingsOpen(true); return }

    // Snapshot tab + chart state NOW (before any awaits) to avoid stale closures
    const sendTabId    = activeTabId
    const sendTabLabel = activeTab?.label || 'Dashboard'
    const sendChartId  = selectedChartId  // null if no chart is selected
    const sendChartSpec = selectedChart?.spec || null  // spec of selected chart, or null

    setInput('')
    const userMsg = { role: 'user', content: userText }
    const history = [...messages, userMsg]
    setMessages(history)
    setThinking(true)

    // ── Time range command shortcut ─────────────────────────────────────────
    // Intercepts "show last 6 hours", "set to 30m", "last 1 day", etc.
    // Re-fetches all metric-backed charts on this tab with the new duration.
    const timeRangeCmd = detectTimeRangeCommand(userText)
    if (timeRangeCmd) {
      const dur = timeRangeCmd.durationSeconds
      const label = formatDuration(dur)
      const chartCount = activeTab?.charts?.filter(c => c.spec?.series?.some(s => s.metric)).length || 0
      const refreshNote = chartCount > 0 ? ` and refreshing **${chartCount}** chart${chartCount !== 1 ? 's' : ''}` : ''
      setMessages(prev => [...prev, { role: 'assistant', content: `Setting time range to **${label}**${refreshNote}…` }])
      await handleTimeRangeChange(dur, sendTabId)
      setMessages(prev => {
        const list = [...prev]
        const doneMsg = chartCount > 0
          ? `Time range set to **${label}**. ${chartCount} chart${chartCount !== 1 ? 's' : ''} refreshed.`
          : `Time range set to **${label}** for this tab. New charts will use this range.`
        list[list.length - 1] = { role: 'assistant', content: doneMsg }
        return list
      })
      setThinking(false)
      inputRef.current?.focus()
      return
    }

    // ── Overlay-remove shortcut ─────────────────────────────────────────────
    // Intercepts "remove all anomalies", "clear moving averages from all charts", etc.
    // Works in any mode — no AI call needed.
    const ovRemoveReq = detectOverlayRemoveRequest(userText)
    if (ovRemoveReq) {
      const { overlayType, fromAll } = ovRemoveReq
      let removed = 0
      setTabs(prev => prev.map(t => {
        // fromAll = apply to every tab; otherwise only active tab
        if (!fromAll && t.id !== sendTabId) return t
        return {
          ...t,
          charts: t.charts.map(c => {
            if (!c.spec?.overlays?.length) return c
            const before = c.spec.overlays.length
            const after = overlayType
              ? c.spec.overlays.filter(ov => ov.type !== overlayType)
              : []
            removed += before - after.length
            return after.length === before ? c : { ...c, spec: { ...c.spec, overlays: after } }
          }),
        }
      }))
      const typeLabel = overlayType
        ? overlayType.replace(/([A-Z])/g, ' $1').toLowerCase()  // camelCase → words
        : 'overlay'
      const scopeLabel = fromAll ? 'all charts' : 'this tab'
      // Use a setTimeout so removed count reflects the state update
      setTimeout(() => {
        setMessages(prev => [...prev, {
          role: 'assistant',
          content: removed > 0
            ? `Removed **${removed}** ${typeLabel} overlay${removed !== 1 ? 's' : ''} from ${scopeLabel}.`
            : `No ${typeLabel} overlays found on ${scopeLabel}.`,
        }])
      }, 0)
      setThinking(false)
      inputRef.current?.focus()
      return
    }

    // ── Bulk-remove shortcut ────────────────────────────────────────────────
    // Intercepts "remove all mock charts", "clear all cpu graphs", etc.
    // Matches chart titles/metric names against the keyword, removes in one update.
    const removeReq = detectBulkRemoveRequest(userText)
    if (removeReq) {
      const kw = removeReq.query.toLowerCase()
      setTabs(prev => prev.map(t => {
        if (t.id !== sendTabId) return t
        const before = t.charts.length
        const kept = kw
          ? t.charts.filter(c => {
              const title  = (c.spec?.title  || '').toLowerCase()
              const metric = (c.spec?.series?.[0]?.metric || '').toLowerCase()
              return !title.includes(kw) && !metric.includes(kw)
            })
          : []   // no keyword = clear entire tab
        const removed = before - kept.length
        return { ...t, charts: kept }
      }))

      // Build the reply outside setTabs (we don't have "before" count there easily)
      // Use a functional read from the current tabs snapshot instead
      const currentTab = tabs.find(t => t.id === sendTabId)
      const before = currentTab?.charts?.length ?? 0
      const keptCount = kw
        ? (currentTab?.charts || []).filter(c => {
            const title  = (c.spec?.title  || '').toLowerCase()
            const metric = (c.spec?.series?.[0]?.metric || '').toLowerCase()
            return !title.includes(kw) && !metric.includes(kw)
          }).length
        : 0
      const removedCount = before - keptCount
      const label = removeReq.query ? `matching "${removeReq.query}"` : 'on this tab'
      const replyMsg = removedCount > 0
        ? `Removed **${removedCount}** chart${removedCount !== 1 ? 's' : ''} ${label}.`
        : `No charts found ${label}.`
      setMessages(prev => [...prev, { role: 'assistant', content: replyMsg }])
      setSelectedChartId(null)
      setThinking(false)
      inputRef.current?.focus()
      return
    }

    // ── Bulk-plot shortcut ──────────────────────────────────────────────────
    // Intercepts requests like "plot all cpu metrics" before hitting the AI.
    // Searches TSDB for matching metric names, then creates one chart card per
    // match — all in parallel. Skips AI entirely for speed + reliability.
    const bulkReq = detectBulkPlotRequest(userText)
    if (bulkReq) {
      try {
        const MAX_BULK = 20
        const matches = await searchMetricNames(bulkReq.query)

        if (matches.length > 0) {
          const toPlot    = matches.slice(0, MAX_BULK)
          const truncated = matches.length > MAX_BULK
          const label     = bulkReq.query ? `"${bulkReq.query}"` : 'all'

          const SERIES_COLORS = ['#22d3ee','#a78bfa','#34d399','#f59e0b','#f87171','#60a5fa','#fb923c','#e879f9','#4ade80','#38bdf8']

          // Step 1: Add all placeholder cards in ONE setTabs so they appear immediately
          const now = Date.now()
          const chartEntries = toPlot.map((metricName, idx) => ({
            id:    `chart_${now + idx}_${Math.random().toString(36).slice(2, 8)}`,
            color: SERIES_COLORS[idx % SERIES_COLORS.length],
            metricName,
          }))
          setTabs(prev => prev.map(t => t.id !== sendTabId ? t : {
            ...t,
            charts: [...t.charts, ...chartEntries.map(({ id, metricName, color }) => ({
              id,
              loading: false,   // resolveChartSpec will flip to true then false
              wide: false,
              spec: {
                title:  metricName,
                type:   'line',
                // no data[] here — resolveChartSpec sees s.metric+no data → fetches
                series: [{ metric: metricName, name: metricName, label: metricName, color }],
                xAxis:  { type: 'time', label: 'Time' },
                yAxis:  { label: 'Value', auto: true },
              },
            }))],
          }))

          // Announce immediately
          const headLine = truncated
            ? `Found **${matches.length}** metrics matching ${label}. Showing first ${MAX_BULK}:`
            : `Found **${toPlot.length}** metric${toPlot.length !== 1 ? 's' : ''} matching ${label}:`
          setMessages(prev => [...prev, { role: 'assistant', content: headLine }])

          // Step 2: Resolve each chart via the exact same code path as single AI charts.
          // Passing the pre-assigned chartId skips addChartToTab → no race conditions.
          // Each resolveChartSpec call: setChartLoading(true) → fetch → updateChartSpec(data).
          await Promise.all(chartEntries.map(({ id, metricName, color }) =>
            resolveChartSpec({
              title:  metricName,
              type:   'line',
              series: [{ metric: metricName, name: metricName, label: metricName, color }],
              xAxis:  { type: 'time', label: 'Time' },
              yAxis:  { label: 'Value', auto: true },
            }, sendTabId, id)
          ))

          setThinking(false)
          inputRef.current?.focus()
          return   // ← skip AI entirely
        }
        // 0 matches — fall through to AI, but flag it so the AI emits CHART blocks
      } catch {
        // Search failed — fall through to AI
      }
    }

    // ── Enrich system prompt with per-metric detail ─────────────────────────
    const knownMetrics = context?.metricNames || []
    const mentioned = extractMentionedMetrics(userText, knownMetrics)
    const anomalyList = context?.anomalies?.anomalies || context?.anomalies || []
    const activeAnomalyNames = Array.isArray(anomalyList)
      ? anomalyList.map(a => a.metric_string).filter(Boolean)
      : []
    const metricData = mentioned.length
      ? await enrichWithMetricData(mentioned, activeAnomalyNames)
      : {}

    // ── Live metric search: detect "metrics related to / containing X" queries ─
    // Pattern: user asks for metrics matching a keyword — do a live TSDB search
    // and inject the results so the AI can give an accurate, real answer.
    let metricSearchInjection = ''
    const searchMatch = userText.match(
      /(?:metrics?|series)\s+(?:related\s+to|containing|matching|with|about|for|named?|like)\s+["']?(\w[\w._-]*)["']?/i
    ) || userText.match(/what\s+metrics?\s+(?:contain|include|have|match)\s+["']?(\w[\w._-]*)["']?/i)
    if (searchMatch) {
      const keyword = searchMatch[1]
      try {
        const results = await searchMetricNames(keyword)
        if (results.length > 0) {
          metricSearchInjection = `\n\n[LIVE METRIC SEARCH: "${keyword}" → ${results.length} result(s)]\n` +
            results.slice(0, 40).join(', ') +
            (results.length > 40 ? ` … and ${results.length - 40} more` : '')
        } else {
          metricSearchInjection = `\n\n[LIVE METRIC SEARCH: "${keyword}" → no matching metrics found in this TSDB instance]`
        }
      } catch {
        // Ignore search errors — AI will fall back to the static list
      }
    }

    // Tab/chart context injected into every prompt so the AI knows where charts will go
    const chartCount = activeTab?.charts?.length || 0
    const tabCtxNote = `\n═══ ACTIVE DASHBOARD TAB ═══\n` +
      `Tab: "${sendTabLabel}" · ${chartCount} chart${chartCount !== 1 ? 's' : ''} · ${tabs.length} tab${tabs.length !== 1 ? 's' : ''} total\n` +
      (sendChartId && sendChartSpec
        ? `Selected chart: "${sendChartSpec.title || 'Untitled'}" (click another chart or canvas to deselect)\n` +
          `  → Overlay/design requests modify THIS chart. A new plot request adds a SECOND chart alongside it.`
        : chartCount > 0
          ? `No chart selected. A plot request will ADD a new chart to this tab (alongside the ${chartCount} existing).`
          : `Tab is empty. If the user asks to plot or visualize anything, you MUST emit a <CHART> block.`)

    const systemPrompt = buildRichPrompt(context || {}, mode, sendChartSpec, metricData)
    const toolInstructions = buildToolInstructions(mode)

    // If the user clearly asked to "plot all X" but our metric search returned nothing,
    // inject a hard override so the AI emits <CHART> blocks instead of just describing.
    const bulkPlotFallbackNote = (bulkReq && bulkReq.isBulk)
      ? `\n\n⚠ BULK PLOT OVERRIDE: The user is asking you to plot MULTIPLE metrics at once.\n` +
        `You MUST emit a separate <CHART>...</CHART> block for EVERY matching metric.\n` +
        `Do NOT describe what you will do. Do NOT list metrics in text. Just emit the <CHART> blocks immediately.\n` +
        `Each <CHART> block must have a "series" array with ONE entry whose "metric" field is the exact metric name.`
      : ''

    // Combine: system prompt + tool instructions + tab context + live metric search injection
    const finalSystemPrompt = systemPrompt
      + (toolInstructions  ? '\n' + toolInstructions  : '')
      + tabCtxNote
      + (metricSearchInjection ? metricSearchInjection : '')
      + bulkPlotFallbackNote

    // Filter out tool-result messages from the conversation history sent to the AI
    // (they are UI artifacts, not real turns)
    const apiMessages = [
      { role: 'system', content: finalSystemPrompt },
      ...history
        .filter(m => m.role !== 'tool-result')
        .map(m => ({ role: m.role === 'error' ? 'assistant' : m.role, content: m.content })),
    ]

    // Build execution deps for tool engine (all phases)
    const executionDeps = {
      context,
      activeTabId: sendTabId,
      updateTabSpec,
      setTabLoading,
      addTab,
      // Phase 2: apply a spec-transform function to all charts across all tabs
      setAllTabs: (updater) => {
        setTabs(prev => prev.map(t => ({
          ...t,
          charts: t.charts.map(c => ({ ...c, spec: c.spec ? updater(c.spec) : c.spec })),
        })))
      },
      // Phase 2: rename a tab's label when set_graph_title fires
      setTabLabel: (tabId, label) => {
        setTabs(prev => prev.map(t => t.id === tabId ? { ...t, label } : t))
      },
    }

    try {
      let raw = ''
      if (provider === 'openai') {
        raw = await callOpenAI(apiKey, model, apiMessages)
      } else if (provider === 'anthropic') {
        raw = await callAnthropic(apiKey, model, apiMessages)
      } else {
        raw = await callLocal(localUrl, localModel, apiMessages, apiKey)
      }

      // 1. Strip <TOOL> blocks — execute them separately
      const { clean: afterTools, tools } = parseToolBlocks(raw)

      // 2. Strip ALL <CHART> blocks (may be multiple for bulk-plot AI responses)
      const { clean, specs: newSpecs } = parseChartBlock(afterTools)

      // 3. Add the AI's text message
      setMessages(prev => [...prev, { role: 'assistant', content: clean }])

      // 4. Execute each tool call and add result cards
      for (const { name, params, parseError } of tools) {
        if (parseError) {
          setMessages(prev => [...prev, {
            role: 'tool-result', toolName: name,
            result: { type: 'error', message: `Could not parse tool parameters — malformed JSON.` },
          }])
          continue
        }
        const result = await executeToolCall(name, params, executionDeps)
        setMessages(prev => [...prev, { role: 'tool-result', toolName: name, result }])
      }

      // 5. Apply all <CHART> blocks (parallel for multiple, sequential-safe for one)
      if (newSpecs?.length > 0) {
        // Multiple specs (bulk AI response): always create a new card per spec
        if (newSpecs.length > 1) {
          await Promise.all(newSpecs.map(spec => resolveChartSpec(spec, sendTabId, null)))
        } else {
          // Single spec: honour the design/overlay/new-chart logic
          const newSpec = newSpecs[0]
          const isPartialSpec = !newSpec.series?.length

          if (isPartialSpec && sendChartId && sendChartSpec) {
            // Overlay / design change on the selected chart → merge in place, no new card
            await resolveChartSpec(mergeSpec(sendChartSpec, newSpec), sendTabId, sendChartId)
          } else if (!isPartialSpec && sendChartId && sendChartSpec && (mode === 'design' || mode === 'overlay')) {
            // In design/overlay mode with a selected chart: replace that chart's data
            await resolveChartSpec(mergeSpec(sendChartSpec, newSpec), sendTabId, sendChartId)
          } else {
            // New plot request (or no chart selected) → always add a new chart card
            await resolveChartSpec(newSpec, sendTabId, null)
          }
        }
      }
    } catch (err) {
      setMessages(prev => [...prev, {
        role: 'error',
        content: `API error: ${err.message}\n\nCheck your API key and model in the settings panel above.`,
      }])
    } finally {
      setThinking(false)
      inputRef.current?.focus()
    }
  }

  const handleKeyDown = e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage() }
  }

  // ── Tab management ──────────────────────────────────────────────────────────

  const addTabEmpty = () => {
    const id = `tab_${tabIdCounter++}`
    const color = TAB_COLORS[(tabIdCounter - 2) % TAB_COLORS.length]
    setTabs(prev => [...prev, { id, label: `Dashboard ${tabIdCounter - 1}`, color, charts: [], timeRange: 3600 }])
    setActiveTabId(id)
    setSelectedChartId(null)
  }

  const closeTab = (id, e) => {
    e.stopPropagation()
    setTabs(prev => {
      const next = prev.filter(t => t.id !== id)
      if (next.length === 0) return prev
      return next
    })
    setSelectedChartId(null)
    if (activeTabId === id) {
      const idx = tabs.findIndex(t => t.id === id)
      setActiveTabId(tabs[Math.max(0, idx - 1)]?.id)
    }
  }

  const refreshContext = async () => {
    const ctx = await fetchFullContext()
    setContext(ctx)
  }

  // ── New session ─────────────────────────────────────────────────────────────

  const startNewSession = useCallback(() => {
    setMessages([])
    setTabs([{ id: 'main', label: 'Dashboard 1', charts: [], timeRange: 3600 }])
    setActiveTabId('main')
    setSelectedChartId(null)
    setCurrentSessionId(newSessionId())
    setSessionDropdownOpen(false)
  }, [])

  // ── Restore a saved session ─────────────────────────────────────────────────

  const restoreSession = useCallback((session) => {
    setCurrentSessionId(session.id)
    if (session.messages?.length > 0) setMessages(session.messages)
    if (session.tabs?.length > 0) {
      setTabs(session.tabs.map(t => {
        const base = t.charts
          ? { ...t, charts: t.charts.map(c => ({ ...c, loading: false })) }
          : { ...t, charts: t.spec ? [{ id: `chart_legacy_${t.id}`, spec: t.spec, loading: false }] : [], spec: undefined, loading: undefined }
        return { ...base, timeRange: t.timeRange ?? 3600 }
      }))
      setActiveTabId(session.tabs[0]?.id || 'main')
    }
    setSelectedChartId(null)
    setSessionDropdownOpen(false)
  }, [])

  // ── Delete a saved session ──────────────────────────────────────────────────

  const deleteSession = useCallback(async (sessId, e) => {
    e.stopPropagation()
    const next = savedSessions.filter(s => s.id !== sessId)
    setSavedSessions(next)
    const state = { version: 1, sessions: next, dashboards: [], currentSessionId }
    await saveUIState(state)
  }, [savedSessions, currentSessionId])

  const p = PROVIDERS[provider]

  // ─── PNG Export ──────────────────────────────────────────────────────────────
  function exportChartPng(containerEl, title) {
    if (!containerEl) return
    const svg = containerEl.querySelector('svg')
    if (!svg) return

    const rect = svg.getBoundingClientRect()
    const w = rect.width || svg.clientWidth || 800
    const h = rect.height || svg.clientHeight || 400

    // Clone and stamp the SVG with required namespace + explicit dimensions
    const clone = svg.cloneNode(true)
    clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
    clone.setAttribute('width', w)
    clone.setAttribute('height', h)

    const svgData = new XMLSerializer().serializeToString(clone)
    const svgBlob = new Blob([svgData], { type: 'image/svg+xml;charset=utf-8' })
    const svgUrl = URL.createObjectURL(svgBlob)

    const img = new Image()
    img.onload = () => {
      const scale = 2  // 2× retina quality
      const canvas = document.createElement('canvas')
      canvas.width = w * scale
      canvas.height = h * scale
      const ctx = canvas.getContext('2d')
      ctx.scale(scale, scale)
      // Fill dark background (recharts SVGs are transparent)
      ctx.fillStyle = '#0a0a14'
      ctx.fillRect(0, 0, w, h)
      ctx.drawImage(img, 0, 0, w, h)
      URL.revokeObjectURL(svgUrl)

      canvas.toBlob(blob => {
        const link = document.createElement('a')
        link.href = URL.createObjectURL(blob)
        link.download = `${(title || 'chart').replace(/[^a-z0-9\-_]/gi, '_')}.png`
        link.click()
        setTimeout(() => URL.revokeObjectURL(link.href), 2000)
      }, 'image/png')
    }
    img.onerror = () => URL.revokeObjectURL(svgUrl)
    img.src = svgUrl
  }

  return (
    <>
    <div style={{ display: 'flex', height: '100%', overflow: 'hidden' }}>
      <style>{`
        @keyframes bounce { 0%,80%,100%{transform:translateY(0);opacity:.4} 40%{transform:translateY(-6px);opacity:1} }
        @keyframes spin { 100%{transform:rotate(360deg)} }
        .chip-btn:hover { background: ${T.bgCardHov} !important; border-color: ${T.borderBri} !important; color: ${T.textPri} !important; }
        .ai-textarea::placeholder { color: ${T.textSec}; opacity: 1; }
      `}</style>

      {/* ── LEFT PANEL: AI Chat ─────────────────────────────────────────────── */}
      <div style={{
        width: 370, minWidth: 320, maxWidth: 420,
        display: 'flex', flexDirection: 'column',
        borderRight: `1px solid #28284a`,
        background: T.bgPanel,
        overflow: 'hidden',
      }}>
        {/* Header */}
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '12px 16px', borderBottom: `1px solid #28284a`, flexShrink: 0,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <div style={{
              width: 28, height: 28, borderRadius: '50%',
              background: `linear-gradient(135deg, ${T.purple}, ${T.cyan})`,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              boxShadow: glow.purple, flexShrink: 0,
            }}>
              <Bot size={14} color="#fff" />
            </div>
            <span style={{ fontSize: 14, fontWeight: 700, color: T.textPri }}>AI Assistant</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <button
              onClick={refreshContext}
              title="Refresh live context"
              style={{
                display: 'flex', alignItems: 'center', gap: 4,
                padding: '4px 9px', borderRadius: 6, border: `1px solid #28284a`,
                background: T.bgCard, color: T.textSec, fontSize: 11, cursor: 'pointer',
              }}
            >
              <RefreshCw size={10} /> Context
            </button>
            <button
              onClick={() => setSettingsOpen(o => !o)}
              title="API key settings"
              style={{
                display: 'flex', alignItems: 'center', gap: 4,
                padding: '4px 9px', borderRadius: 6,
                border: `1px solid ${settingsOpen ? T.purple + '88' : '#28284a'}`,
                background: settingsOpen ? `${T.purple}22` : T.bgCard,
                color: settingsOpen ? T.purpleL : T.textSec, fontSize: 11, cursor: 'pointer',
              }}
            >
              <Key size={10} /> Key
            </button>
          </div>
        </div>

        {/* Instance indicator */}
        <div style={{
          padding: '7px 16px', borderBottom: `1px solid #28284a`,
          background: `${T.bgCard}88`, flexShrink: 0,
          display: 'flex', alignItems: 'center', gap: 7,
        }}>
          <Database size={12} color={T.textSec} />
          <span style={{ fontSize: 11, color: T.textSec, fontFamily: T.mono }}>
            {(localStorage.getItem('tsdb_backend_url') || 'localhost:8080').replace('http://', '')}
          </span>
          <span style={{
            fontSize: 9, fontWeight: 700, padding: '1px 7px', borderRadius: 10,
            background: context?.metrics ? `${T.green}18` : `${T.textMut}18`,
            border: `1px solid ${context?.metrics ? T.green + '55' : '#28284a'}`,
            color: context?.metrics ? T.green : T.textSec,
          }}>
            {context?.metrics ? `${context.metrics.unique_series_active?.toLocaleString()} series` : 'offline'}
          </span>
          {(creds.apiKey || creds.provider === 'local') && (
            <span style={{
              marginLeft: 'auto', fontSize: 9, fontWeight: 700, padding: '1px 7px', borderRadius: 10,
              background: `${p.color}18`, border: `1px solid ${p.color}44`, color: p.color,
            }}>
              {p.icon} {model.split('-').slice(0, 2).join('-')}
            </span>
          )}
        </div>

        {/* API Key panel */}
        {settingsOpen && (
          <div style={{ padding: '12px 16px', borderBottom: `1px solid #28284a`, background: T.bgCard, flexShrink: 0 }}>
            {/* Provider tabs */}
            <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
              {Object.entries(PROVIDERS).map(([id, pv]) => (
                <button
                  key={id}
                  onClick={() => { setProvider(id); if (id !== 'local') setModel(pv.models[0]) }}
                  style={{
                    flex: 1, padding: '6px', borderRadius: 7, cursor: 'pointer', fontSize: 12,
                    border: provider === id ? `1px solid ${pv.color}88` : `1px solid #28284a`,
                    background: provider === id ? `${pv.color}22` : T.bgPanel,
                    color: provider === id ? T.textPri : T.textSec, fontWeight: provider === id ? 700 : 500,
                  }}
                >{pv.icon} {pv.name}</button>
              ))}
            </div>

            {provider === 'local' ? (<>
              {/* Base URL */}
              <input
                value={localUrl}
                onChange={e => setLocalUrl(e.target.value)}
                placeholder="http://localhost:11434"
                style={{
                  width: '100%', boxSizing: 'border-box', marginBottom: 6,
                  padding: '7px 10px', borderRadius: 7, border: `1px solid #2e2e58`,
                  background: T.bgInput, color: T.textPri, fontSize: 12, fontFamily: T.mono, outline: 'none',
                }}
              />
              <div style={{ fontSize: 10, color: T.textMut, marginBottom: 8 }}>
                Ollama :11434 · LM Studio :1234 · llama.cpp :8000
              </div>
              {/* Model name */}
              <input
                value={localModel}
                onChange={e => setLocalModel(e.target.value)}
                placeholder="llama3, mistral, phi3…"
                style={{
                  width: '100%', boxSizing: 'border-box', marginBottom: 6,
                  padding: '7px 10px', borderRadius: 7, border: `1px solid #2e2e58`,
                  background: T.bgInput, color: T.textPri, fontSize: 12, fontFamily: T.mono, outline: 'none',
                }}
              />
              {/* Optional key + save */}
              <div style={{ display: 'flex', gap: 6 }}>
                <input
                  type={showKey ? 'text' : 'password'}
                  value={apiKey}
                  onChange={e => setApiKey(e.target.value)}
                  placeholder="API key (optional)"
                  style={{
                    flex: 1, boxSizing: 'border-box', padding: '7px 10px', borderRadius: 7,
                    border: `1px solid #2e2e58`, background: T.bgInput,
                    color: T.textPri, fontSize: 12, fontFamily: T.mono, outline: 'none',
                  }}
                />
                <button onClick={saveCreds} style={{ padding: '7px 14px', borderRadius: 7, border: 'none', cursor: 'pointer', background: credsSaved ? T.green : `linear-gradient(135deg, ${T.purple}, ${T.cyan})`, color: '#fff', fontSize: 11, fontWeight: 600, flexShrink: 0, transition: 'background 0.3s' }}>
                  {credsSaved ? <Check size={12} /> : 'Save'}
                </button>
              </div>
            </>) : (<>
              {/* Cloud: model select */}
              <select
                value={model}
                onChange={e => setModel(e.target.value)}
                style={{
                  width: '100%', marginBottom: 8, padding: '7px 10px', borderRadius: 7,
                  border: `1px solid #2e2e58`, background: T.bgInput,
                  color: T.textPri, fontSize: 12, fontFamily: T.mono, outline: 'none',
                }}
              >
                {PROVIDERS[provider].models.map(m => <option key={m} value={m}>{m}</option>)}
              </select>
              {/* API Key */}
              <div style={{ display: 'flex', gap: 6 }}>
                <div style={{ flex: 1, position: 'relative' }}>
                  <input
                    type={showKey ? 'text' : 'password'}
                    value={apiKey}
                    onChange={e => setApiKey(e.target.value)}
                    placeholder={PROVIDERS[provider].placeholder}
                    style={{
                      width: '100%', boxSizing: 'border-box', padding: '7px 32px 7px 10px',
                      background: T.bgInput, border: `1px solid #2e2e58`, borderRadius: 7,
                      color: T.textPri, fontSize: 12, fontFamily: T.mono, outline: 'none',
                    }}
                  />
                  <button
                    onClick={() => setShowKey(s => !s)}
                    style={{ position: 'absolute', right: 7, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', color: T.textMut, padding: 2 }}
                  >
                    {showKey ? <EyeOff size={12} /> : <Eye size={12} />}
                  </button>
                </div>
                <button
                  onClick={saveCreds}
                  style={{
                    padding: '7px 14px', borderRadius: 7, border: 'none', cursor: 'pointer',
                    background: credsSaved ? T.green : `linear-gradient(135deg, ${T.purple}, ${T.cyan})`,
                    color: '#fff', fontSize: 11, fontWeight: 600, flexShrink: 0,
                    transition: 'background 0.3s',
                  }}
                >
                  {credsSaved ? <Check size={12} /> : 'Save'}
                </button>
              </div>
            </>)}
          </div>
        )}

        {/* Mode tabs */}
        <div style={{ display: 'flex', borderBottom: `1px solid #28284a`, flexShrink: 0 }}>
          {['data', 'design', 'overlay'].map(id => (
            <ModeTab key={id} id={id} mode={mode} active={mode === id} onClick={setMode} />
          ))}
        </div>

        {/* Messages */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '16px' }}>
          {messages.length === 0 ? (
            <div style={{ textAlign: 'center', paddingTop: 20 }}>
              <div style={{
                width: 44, height: 44, borderRadius: '50%', margin: '0 auto 14px',
                background: `${MODE_CONFIG[mode].color}18`, border: `1px solid ${MODE_CONFIG[mode].color}44`,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}>
                {(() => { const Icon = MODE_CONFIG[mode].icon; return <Icon size={18} color={MODE_CONFIG[mode].color} /> })()}
              </div>
              <p style={{ fontSize: 13, color: T.textSec, marginBottom: 12, lineHeight: 1.5 }}>
                {MODE_CONFIG[mode].desc}
              </p>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {MODE_CONFIG[mode].chips.map(s => (
                  <button
                    key={s}
                    className="chip-btn"
                    onClick={() => sendMessage(s)}
                    disabled={provider !== 'local' && !apiKey}
                    style={{
                      textAlign: 'left', padding: '9px 13px', borderRadius: 8,
                      cursor: (apiKey || provider === 'local') ? 'pointer' : 'default',
                      background: T.bgCard, border: `1px solid #28284a`,
                      color: T.textPri, fontSize: 13,
                      opacity: (apiKey || provider === 'local') ? 1 : 0.65,
                      transition: 'all 0.15s',
                    }}
                  >{s}</button>
                ))}
              </div>
              {provider !== 'local' && !apiKey && (
                <p style={{ marginTop: 12, fontSize: 12, color: T.textPri }}>
                  Enter an API key above to start
                </p>
              )}
            </div>
          ) : (
            <>
              {messages.map((msg, i) => (
                <ChatMessage
                  key={i}
                  msg={msg}
                  onChartMetric={name => sendMessage(`Chart ${name} for the last hour`)}
                />
              ))}
              {thinking && <ThinkingIndicator />}
            </>
          )}
          <div ref={messagesEndRef} />
        </div>

        {/* Quick chips (after first message) */}
        {messages.length > 0 && !thinking && (
          <div style={{ padding: '6px 12px', borderTop: `1px solid #28284a`, display: 'flex', gap: 5, flexWrap: 'wrap', flexShrink: 0 }}>
            {MODE_CONFIG[mode].chips.slice(0, 3).map(s => (
              <button
                key={s}
                onClick={() => sendMessage(s)}
                disabled={thinking || !apiKey}
                style={{
                  padding: '4px 11px', borderRadius: 12, border: `1px solid #28284a`,
                  background: T.bgCard, color: T.textSec, fontSize: 11, cursor: 'pointer',
                  transition: 'all 0.15s',
                }}
              >{s}</button>
            ))}
          </div>
        )}

        {/* Input */}
        <div style={{ padding: '10px 12px', borderTop: `1px solid #28284a`, flexShrink: 0 }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
            <textarea
              ref={inputRef}
              className="ai-textarea"
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              disabled={(provider !== 'local' && !apiKey) || thinking}
              placeholder={(apiKey || provider === 'local') ? `Ask in ${MODE_CONFIG[mode].label} mode… (Enter to send)` : 'Enter an API key to start'}
              rows={2}
              style={{
                flex: 1, padding: '9px 12px', resize: 'none',
                borderRadius: 9, border: `1px solid #2e2e58`,
                background: T.bgInput, color: T.textPri, fontSize: 13,
                fontFamily: 'inherit', outline: 'none', lineHeight: 1.5,
                maxHeight: 100, opacity: (provider !== 'local' && !apiKey) ? 0.75 : 1,
              }}
            />
            <button
              onClick={() => sendMessage()}
              disabled={!input.trim() || (provider !== 'local' && !apiKey) || thinking}
              style={{
                width: 38, height: 38, borderRadius: 9, border: 'none', cursor: 'pointer', flexShrink: 0,
                background: input.trim() && (apiKey || provider === 'local') && !thinking
                  ? `linear-gradient(135deg, ${T.purple}, ${T.cyan})`
                  : T.bgCard,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                boxShadow: input.trim() && (apiKey || provider === 'local') ? glow.purple : 'none',
                transition: 'all 0.2s',
              }}
            >
              {thinking
                ? <RefreshCw size={14} color={T.textMut} style={{ animation: 'spin 1s linear infinite' }} />
                : <Send size={14} color={input.trim() && (apiKey || provider === 'local') ? '#fff' : T.textMut} />}
            </button>
          </div>
        </div>
      </div>

      {/* ── RIGHT PANEL: Charts ─────────────────────────────────────────────── */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', background: T.bgRoot }}>
        {/* Top nav */}
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '0 20px', height: 46, borderBottom: `1px solid ${T.border}`,
          background: T.bgPanel, flexShrink: 0,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <div style={{
              width: 22, height: 22, borderRadius: 6,
              background: `linear-gradient(135deg, ${T.purple}, ${T.cyan})`,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>⬡</div>
            <span style={{ fontSize: 14, fontWeight: 700, color: T.textPri }}>
              TSDB<span style={{ color: T.cyan }}>.ai</span>
            </span>
            <span style={{ fontSize: 11, color: T.textMut }}>
              Interactive Analytics
            </span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {context?.metrics && (
              <div style={{ display: 'flex', gap: 10, fontSize: 11, color: T.textMut }}>
                <span><span style={{ color: T.textSec }}>{context.metrics.unique_series_active?.toLocaleString()}</span> series</span>
                <span>·</span>
                <span><span style={{ color: context.metrics.anomalies_detected > 0 ? T.red : T.green }}>{context.metrics.anomalies_detected}</span> anomalies</span>
              </div>
            )}

            {/* Save indicator */}
            {saveIndicator && (
              <div style={{
                display: 'flex', alignItems: 'center', gap: 4,
                fontSize: 10, color: saveIndicator === 'error' ? T.red : saveIndicator === 'saving' ? T.textMut : T.green,
                padding: '2px 8px', borderRadius: 6,
                border: `1px solid ${saveIndicator === 'error' ? T.red + '33' : saveIndicator === 'saving' ? T.border : T.green + '33'}`,
                background: saveIndicator === 'error' ? `${T.red}0a` : saveIndicator === 'saving' ? T.bgCard : `${T.green}0a`,
              }}>
                {saveIndicator === 'saving'
                  ? <><RefreshCw size={9} style={{ animation: 'spin 1s linear infinite' }} /> Saving…</>
                  : saveIndicator === 'saved'
                  ? <><Check size={9} /> Saved</>
                  : <>! Save failed</>
                }
              </div>
            )}

            {/* Session history dropdown */}
            <div style={{ position: 'relative' }}>
              <button
                onClick={() => setSessionDropdownOpen(o => !o)}
                title="Session history"
                style={{
                  display: 'flex', alignItems: 'center', gap: 4,
                  padding: '4px 9px', borderRadius: 6,
                  border: `1px solid ${sessionDropdownOpen ? T.purple + '66' : T.border}`,
                  background: sessionDropdownOpen ? `${T.purple}18` : T.bgCard,
                  color: sessionDropdownOpen ? T.purpleL : T.textMut,
                  fontSize: 10, cursor: 'pointer',
                }}
              >
                <Clock size={10} />
                Sessions
                {savedSessions.length > 0 && (
                  <span style={{
                    marginLeft: 2, fontSize: 9, fontWeight: 700,
                    padding: '0px 5px', borderRadius: 8,
                    background: `${T.purple}28`, color: T.purple,
                  }}>{savedSessions.length}</span>
                )}
                <ChevronDown size={9} style={{ transform: sessionDropdownOpen ? 'rotate(180deg)' : 'none', transition: 'transform 0.2s' }} />
              </button>

              {sessionDropdownOpen && (
                <div style={{
                  position: 'absolute', top: '100%', right: 0, marginTop: 4,
                  width: 280, borderRadius: 9,
                  border: `1px solid ${T.border}`, background: T.bgPanel,
                  boxShadow: '0 8px 24px rgba(0,0,0,0.35)',
                  zIndex: 100, overflow: 'hidden',
                }}>
                  {/* New session */}
                  <button
                    onClick={startNewSession}
                    style={{
                      width: '100%', display: 'flex', alignItems: 'center', gap: 8,
                      padding: '10px 12px', border: 'none', cursor: 'pointer',
                      background: 'transparent', color: T.cyan, fontSize: 12, fontWeight: 600,
                      borderBottom: `1px solid ${T.border}`, textAlign: 'left',
                    }}
                  >
                    <Plus size={13} color={T.cyan} />
                    New session
                  </button>

                  {/* Saved sessions list */}
                  {savedSessions.length === 0 ? (
                    <div style={{ padding: '12px', fontSize: 11, color: T.textMut, textAlign: 'center' }}>
                      No saved sessions yet
                    </div>
                  ) : (
                    <div style={{ maxHeight: 260, overflowY: 'auto' }}>
                      {[...savedSessions].reverse().map(sess => (
                        <div
                          key={sess.id}
                          onClick={() => restoreSession(sess)}
                          style={{
                            display: 'flex', alignItems: 'center', gap: 8,
                            padding: '9px 12px', cursor: 'pointer',
                            borderBottom: `1px solid ${T.border}`,
                            background: sess.id === currentSessionId ? `${T.purple}12` : 'transparent',
                            transition: 'background 0.1s',
                          }}
                          onMouseEnter={e => e.currentTarget.style.background = `${T.bgCardHov}`}
                          onMouseLeave={e => e.currentTarget.style.background = sess.id === currentSessionId ? `${T.purple}12` : 'transparent'}
                        >
                          <BookOpen size={11} color={sess.id === currentSessionId ? T.purple : T.textMut} style={{ flexShrink: 0 }} />
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ fontSize: 11, fontWeight: 600, color: T.textSec, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                              {sess.label}
                            </div>
                            <div style={{ fontSize: 10, color: T.textMut }}>
                              {sess.messages?.length || 0} messages · {sess.tabs?.length || 0} tabs
                            </div>
                          </div>
                          {sess.id === currentSessionId && (
                            <span style={{ fontSize: 9, color: T.purple, fontWeight: 700, flexShrink: 0 }}>active</span>
                          )}
                          <button
                            onClick={e => deleteSession(sess.id, e)}
                            style={{
                              background: 'none', border: 'none', cursor: 'pointer',
                              color: T.textMut, padding: 2, flexShrink: 0,
                            }}
                            title="Delete session"
                          >
                            <X size={10} />
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>

            <a
              href="https://tsdb.ai"
              target="_blank"
              rel="noopener noreferrer"
              style={{ fontSize: 11, color: T.cyan, textDecoration: 'none' }}
            >
              tsdb.ai →
            </a>
          </div>
        </div>

        {/* Tab bar */}
        <div style={{
          display: 'flex', alignItems: 'center',
          borderBottom: `1px solid ${T.border}`,
          background: `${T.bgPanel}cc`, padding: '0 8px', flexShrink: 0, overflowX: 'auto',
        }}>
          {tabs.map(tab => {
            const isActive = tab.id === activeTabId
            const tabColor = tab.color || T.cyan
            const isRenaming = renamingTabId === tab.id
            return (
              <div
                key={tab.id}
                onClick={() => { setActiveTabId(tab.id); setSelectedChartId(null) }}
                style={{
                  display: 'flex', alignItems: 'center', gap: 6,
                  padding: '7px 12px', cursor: 'pointer', position: 'relative', flexShrink: 0,
                  borderBottom: isActive ? `2px solid ${tabColor}` : '2px solid transparent',
                  background: isActive ? T.bgRoot : 'transparent',
                  borderTop: isActive ? `1px solid ${T.border}` : '1px solid transparent',
                  borderLeft: isActive ? `1px solid ${T.border}` : '1px solid transparent',
                  borderRight: isActive ? `1px solid ${T.border}` : '1px solid transparent',
                  borderRadius: '6px 6px 0 0', marginBottom: -1,
                }}
              >
                {/* Color swatch — click to cycle color */}
                <div
                  onClick={e => {
                    e.stopPropagation()
                    const idx = TAB_COLORS.indexOf(tabColor)
                    const next = TAB_COLORS[(idx + 1) % TAB_COLORS.length]
                    setTabs(prev => prev.map(t => t.id === tab.id ? { ...t, color: next } : t))
                  }}
                  title="Click to change tab color"
                  style={{
                    width: 9, height: 9, borderRadius: '50%', background: tabColor,
                    flexShrink: 0, cursor: 'pointer', border: `1px solid ${tabColor}88`,
                  }}
                />
                {/* Tab label — double-click to rename */}
                {isRenaming ? (
                  <input
                    autoFocus
                    value={renameValue}
                    onChange={e => setRenameValue(e.target.value)}
                    onBlur={() => {
                      const v = renameValue.trim()
                      if (v) setTabs(prev => prev.map(t => t.id === tab.id ? { ...t, label: v } : t))
                      setRenamingTabId(null)
                    }}
                    onKeyDown={e => {
                      if (e.key === 'Enter') e.target.blur()
                      if (e.key === 'Escape') { setRenamingTabId(null) }
                    }}
                    onClick={e => e.stopPropagation()}
                    style={{
                      background: 'transparent', border: 'none', outline: `1px solid ${tabColor}`,
                      color: T.textPri, fontSize: 12, fontWeight: 600,
                      width: Math.max(60, renameValue.length * 8), padding: '0 2px', borderRadius: 3,
                    }}
                  />
                ) : (
                  <span
                    onDoubleClick={e => { e.stopPropagation(); setRenamingTabId(tab.id); setRenameValue(tab.label) }}
                    title="Double-click to rename"
                    style={{ fontSize: 12, fontWeight: isActive ? 600 : 400, color: isActive ? T.textPri : T.textMut, whiteSpace: 'nowrap', userSelect: 'none' }}
                  >
                    {tab.label}
                  </span>
                )}
                {tab.charts?.some(c => c.loading) && (
                  <RefreshCw size={10} color={T.textMut} style={{ animation: 'spin 1s linear infinite' }} />
                )}
                {tab.charts?.length > 0 && (
                  <div style={{
                    fontSize: 9, fontWeight: 700, padding: '1px 5px', borderRadius: 8,
                    background: `${tabColor}22`, color: tabColor, border: `1px solid ${tabColor}44`,
                    flexShrink: 0,
                  }}>{tab.charts.length}</div>
                )}
                {tabs.length > 1 && (
                  <button
                    onClick={e => closeTab(tab.id, e)}
                    style={{ background: 'none', border: 'none', cursor: 'pointer', color: T.textMut, padding: 1, display: 'flex', marginLeft: 1 }}
                  >
                    <X size={10} />
                  </button>
                )}
              </div>
            )
          })}
          <button
            onClick={addTabEmpty}
            style={{
              display: 'flex', alignItems: 'center', gap: 5,
              padding: '7px 12px', marginLeft: 4, borderRadius: 6, border: 'none',
              background: 'transparent', color: T.textMut, fontSize: 12, cursor: 'pointer',
              flexShrink: 0,
            }}
          >
            <Plus size={13} />
            New Tab
          </button>
        </div>

        {/* ── Time range bar + canvas toolbar ─────────────────────────────── */}
        {(() => {
          const presets = [
            { label: '15m', secs: 900 },
            { label: '30m', secs: 1800 },
            { label: '1h',  secs: 3600 },
            { label: '3h',  secs: 10800 },
            { label: '6h',  secs: 21600 },
            { label: '12h', secs: 43200 },
            { label: '24h', secs: 86400 },
            { label: '3d',  secs: 259200 },
            { label: '7d',  secs: 604800 },
          ]
          const tabTimeRange  = activeTab?.timeRange ?? 3600
          const isCustomActive = typeof tabTimeRange === 'object' && tabTimeRange !== null
          const activePresetSecs = isCustomActive ? null : tabTimeRange
          const tabColor = activeTab?.color || T.cyan

          // Label for the Custom button
          const customBtnLabel = isCustomActive
            ? (() => {
                const s = new Date(tabTimeRange.start * 1000)
                const e = new Date(tabTimeRange.end   * 1000)
                const fmt = d => `${d.getMonth()+1}/${d.getDate()} ${d.getHours().toString().padStart(2,'0')}:${d.getMinutes().toString().padStart(2,'0')}`
                return `${fmt(s)} – ${fmt(e)}`
              })()
            : 'Custom'

          // Helper: format datetime-local string → epoch seconds
          const dtLocalToEpoch = str => str ? Math.floor(new Date(str).getTime() / 1000) : null

          // Helper: epoch seconds → datetime-local string
          const epochToDtLocal = ep => {
            if (!ep) return ''
            const d = new Date(ep * 1000)
            return d.getFullYear() + '-' +
              String(d.getMonth()+1).padStart(2,'0') + '-' +
              String(d.getDate()).padStart(2,'0') + 'T' +
              String(d.getHours()).padStart(2,'0') + ':' +
              String(d.getMinutes()).padStart(2,'0')
          }

          const applyCustomRange = () => {
            const start = dtLocalToEpoch(customStart)
            const end   = dtLocalToEpoch(customEnd)
            if (!start || !end || start >= end) return
            handleTimeRangeChange({ start, end }, activeTabId)
            setCustomRangeOpen(false)
          }

          const openCustomPicker = () => {
            // Pre-fill from current active custom range, or last 1h
            if (isCustomActive) {
              setCustomStart(epochToDtLocal(tabTimeRange.start))
              setCustomEnd(epochToDtLocal(tabTimeRange.end))
              const sd = new Date(tabTimeRange.start * 1000)
              const ed = new Date(tabTimeRange.end   * 1000)
              setCalStartView({ year: sd.getFullYear(), month: sd.getMonth() + 1 })
              setCalEndView  ({ year: ed.getFullYear(), month: ed.getMonth() + 1 })
            } else {
              const now = Math.floor(Date.now() / 1000)
              setCustomEnd(epochToDtLocal(now))
              setCustomStart(epochToDtLocal(now - (activePresetSecs || 3600)))
              const n = new Date()
              setCalStartView({ year: n.getFullYear(), month: n.getMonth() + 1 })
              setCalEndView  ({ year: n.getFullYear(), month: n.getMonth() + 1 })
            }
            setCustomRangeOpen(v => !v)
          }

          return (
            <div style={{ flexShrink: 0 }}>
              {/* Main time range bar */}
              <div style={{
                display: 'flex', alignItems: 'center', gap: 6,
                padding: '5px 12px', borderBottom: customRangeOpen ? 'none' : `1px solid ${T.border}`,
                background: `${T.bgPanel}88`, flexWrap: 'wrap',
              }}>
                <Clock size={11} color={T.textMut} style={{ flexShrink: 0 }} />
                <div style={{ display: 'flex', gap: 2, flexWrap: 'nowrap' }}>
                  {presets.map(p => {
                    const isActive = activePresetSecs === p.secs
                    return (
                      <button
                        key={p.label}
                        onClick={() => { handleTimeRangeChange(p.secs, activeTabId); setCustomRangeOpen(false) }}
                        title={`Set time range to ${p.label}`}
                        style={{
                          padding: '3px 8px', borderRadius: 5, fontSize: 11, cursor: 'pointer',
                          border: isActive ? `1px solid ${tabColor}88` : `1px solid ${T.border}`,
                          background: isActive ? `${tabColor}22` : 'transparent',
                          color: isActive ? tabColor : T.textMut,
                          fontWeight: isActive ? 700 : 400,
                          transition: 'background 0.15s, color 0.15s',
                        }}
                      >{p.label}</button>
                    )
                  })}

                  {/* Custom range button */}
                  <button
                    onClick={openCustomPicker}
                    title="Set a custom date/time range"
                    style={{
                      padding: '3px 8px', borderRadius: 5, fontSize: 11, cursor: 'pointer',
                      border: (isCustomActive || customRangeOpen) ? `1px solid ${tabColor}88` : `1px solid ${T.border}`,
                      background: (isCustomActive || customRangeOpen) ? `${tabColor}22` : 'transparent',
                      color: (isCustomActive || customRangeOpen) ? tabColor : T.textMut,
                      fontWeight: (isCustomActive || customRangeOpen) ? 700 : 400,
                      maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                      transition: 'background 0.15s, color 0.15s',
                    }}
                  >{customBtnLabel}</button>
                </div>

                {/* Refresh button */}
                {activeTabCharts.some(c => c.spec?.series?.some(s => s.metric)) && (
                  <button
                    onClick={() => handleTimeRangeChange(tabTimeRange, activeTabId)}
                    title="Refresh all charts"
                    style={{
                      display: 'flex', alignItems: 'center', gap: 4,
                      padding: '3px 8px', borderRadius: 5, fontSize: 11, cursor: 'pointer',
                      border: `1px solid ${T.border}`, background: 'transparent',
                      color: T.textMut,
                    }}
                  >
                    <RefreshCw size={10} /> Refresh
                  </button>
                )}

                {/* Right side */}
                <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
                  {selectedChart && (
                    <span style={{ fontSize: 11, color: T.cyan }}>
                      Selected: <strong>{selectedChart.spec?.title || 'Chart'}</strong>
                    </span>
                  )}
                  {activeTabCharts.length > 0 && (
                    <button
                      onClick={() => setPresentationIdx(0)}
                      style={{
                        display: 'flex', alignItems: 'center', gap: 6,
                        padding: '4px 10px', borderRadius: 7,
                        border: `1px solid ${T.border}`, background: T.bgCard,
                        color: T.textSec, fontSize: 11, cursor: 'pointer',
                      }}
                      title="Enter presentation mode"
                    >
                      <Maximize2 size={12} /> Present
                    </button>
                  )}
                </div>
              </div>

              {/* Custom date/time range picker — calendar */}
              {customRangeOpen && (() => {
                // Parse "YYYY-MM-DDTHH:mm" → epoch seconds
                const startEpoch = dtLocalToEpoch(customStart)
                const endEpoch   = dtLocalToEpoch(customEnd)
                const isInvalid  = customStart && customEnd && startEpoch >= endEpoch

                // Update the time portion of a stored datetime-local string
                const patchTime = (current, setter, key, val) => {
                  const [d, t] = (current || '1970-01-01T00:00').split('T')
                  const [h, m] = (t || '00:00').split(':').map(Number)
                  const nh = key === 'h' ? val : h
                  const nm = key === 'm' ? val : m
                  setter(`${d}T${String(nh).padStart(2,'0')}:${String(nm).padStart(2,'0')}`)
                }

                // When a calendar day is selected, preserve the existing time
                const onSelectStartDay = epoch => {
                  const d = new Date(epoch * 1000)
                  const existing = customStart ? new Date(dtLocalToEpoch(customStart) * 1000) : d
                  d.setHours(existing.getHours(), existing.getMinutes())
                  setCustomStart(epochToDtLocal(Math.floor(d.getTime() / 1000)))
                }
                const onSelectEndDay = epoch => {
                  const d = new Date(epoch * 1000)
                  const existing = customEnd ? new Date(dtLocalToEpoch(customEnd) * 1000) : d
                  d.setHours(existing.getHours(), existing.getMinutes())
                  setCustomEnd(epochToDtLocal(Math.floor(d.getTime() / 1000)))
                }

                const timeSelStyle = {
                  padding: '4px 8px', borderRadius: 5, fontSize: 13, cursor: 'pointer',
                  border: `1px solid ${T.border}`, background: T.bgPanel, color: T.textPri,
                }

                const sh = customStart ? parseInt(customStart.slice(11, 13), 10) : 0
                const sm = customStart ? parseInt(customStart.slice(14, 16), 10) : 0
                const eh = customEnd   ? parseInt(customEnd.slice(11, 13), 10)   : 0
                const em = customEnd   ? parseInt(customEnd.slice(14, 16), 10)   : 0

                return (
                  <div style={{
                    borderBottom: `1px solid ${T.border}`,
                    background: `${T.bgCard}f4`,
                    padding: '12px 16px 14px',
                  }}>
                    {/* Two calendars side by side */}
                    <div style={{ display: 'flex', gap: 28, flexWrap: 'wrap', marginBottom: 14 }}>
                      {/* Start calendar */}
                      <div>
                        <div style={{ fontSize: 10, fontWeight: 700, color: T.textMut, letterSpacing: '0.07em', marginBottom: 8, textTransform: 'uppercase' }}>From</div>
                        <MiniCalendar
                          selectedEpoch={startEpoch || null}
                          onSelect={onSelectStartDay}
                          viewYear={calStartView.year}
                          viewMonth={calStartView.month}
                          onViewChange={(y, m) => setCalStartView({ year: y, month: m })}
                          accentColor={tabColor}
                        />
                        {/* Time row */}
                        <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginTop: 10 }}>
                          <span style={{ fontSize: 10, color: T.textMut }}>Time</span>
                          <select value={sh} onChange={e => patchTime(customStart, setCustomStart, 'h', +e.target.value)} style={{ ...timeSelStyle, width: 62 }}>
                            {Array.from({ length: 24 }, (_, i) => i).map(h => <option key={h} value={h}>{String(h).padStart(2,'0')}</option>)}
                          </select>
                          <span style={{ color: T.textMut, fontSize: 12, fontWeight: 700 }}>:</span>
                          <select value={sm} onChange={e => patchTime(customStart, setCustomStart, 'm', +e.target.value)} style={{ ...timeSelStyle, width: 62 }}>
                            {Array.from({ length: 60 }, (_, i) => i).map(m => <option key={m} value={m}>{String(m).padStart(2,'0')}</option>)}
                          </select>
                        </div>
                      </div>

                      {/* Divider */}
                      <div style={{ width: 1, background: T.border, alignSelf: 'stretch', flexShrink: 0 }} />

                      {/* End calendar */}
                      <div>
                        <div style={{ fontSize: 10, fontWeight: 700, color: T.textMut, letterSpacing: '0.07em', marginBottom: 8, textTransform: 'uppercase' }}>To</div>
                        <MiniCalendar
                          selectedEpoch={endEpoch || null}
                          onSelect={onSelectEndDay}
                          viewYear={calEndView.year}
                          viewMonth={calEndView.month}
                          onViewChange={(y, m) => setCalEndView({ year: y, month: m })}
                          accentColor={tabColor}
                        />
                        {/* Time row */}
                        <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginTop: 10 }}>
                          <span style={{ fontSize: 10, color: T.textMut }}>Time</span>
                          <select value={eh} onChange={e => patchTime(customEnd, setCustomEnd, 'h', +e.target.value)} style={{ ...timeSelStyle, width: 62 }}>
                            {Array.from({ length: 24 }, (_, i) => i).map(h => <option key={h} value={h}>{String(h).padStart(2,'0')}</option>)}
                          </select>
                          <span style={{ color: T.textMut, fontSize: 12, fontWeight: 700 }}>:</span>
                          <select value={em} onChange={e => patchTime(customEnd, setCustomEnd, 'm', +e.target.value)} style={{ ...timeSelStyle, width: 62 }}>
                            {Array.from({ length: 60 }, (_, i) => i).map(m => <option key={m} value={m}>{String(m).padStart(2,'0')}</option>)}
                          </select>
                        </div>
                      </div>
                    </div>

                    {/* Footer actions */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      {isInvalid && (
                        <span style={{ fontSize: 11, color: T.red }}>End must be after start</span>
                      )}
                      {customStart && customEnd && !isInvalid && (
                        <span style={{ fontSize: 11, color: T.textMut }}>
                          {Math.round((endEpoch - startEpoch) / 3600 * 10) / 10}h selected
                        </span>
                      )}
                      <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
                        <button
                          onClick={() => setCustomRangeOpen(false)}
                          style={{
                            padding: '5px 14px', borderRadius: 7, fontSize: 12, cursor: 'pointer',
                            border: `1px solid ${T.border}`, background: 'transparent', color: T.textMut,
                          }}
                        >Cancel</button>
                        <button
                          onClick={applyCustomRange}
                          disabled={!!isInvalid || !customStart || !customEnd}
                          style={{
                            padding: '5px 18px', borderRadius: 7, fontSize: 12, cursor: 'pointer',
                            border: `1px solid ${tabColor}88`, background: tabColor,
                            color: '#fff', fontWeight: 600,
                            opacity: (isInvalid || !customStart || !customEnd) ? 0.4 : 1,
                          }}
                        >Apply range</button>
                      </div>
                    </div>
                  </div>
                )
              })()}
            </div>
          )
        })()}

        {/* Chart canvas — click background to deselect */}
        <div
          style={{ flex: 1, overflowY: 'auto', padding: '16px', display: 'flex', flexDirection: 'column' }}
          onClick={e => { if (e.target === e.currentTarget) setSelectedChartId(null) }}
        >
          {activeTabCharts.length > 0 ? (
            <div style={{
              display: 'grid',
              gridTemplateColumns: activeTabCharts.length === 1 ? '1fr' : 'repeat(2, 1fr)',
              gap: 14,
              alignItems: 'start',
            }}>
              {activeTabCharts.map(chart => {
                const isSelected = chart.id === selectedChartId
                const isDragging = chart.id === dragChartId
                const isDragOver = chart.id === dragOverChartId
                const isWide = chart.wide || activeTabCharts.length === 1

                return (
                  <div
                    key={chart.id}
                    draggable
                    onDragStart={() => setDragChartId(chart.id)}
                    onDragEnd={() => { setDragChartId(null); setDragOverChartId(null) }}
                    onDragOver={e => { e.preventDefault(); setDragOverChartId(chart.id) }}
                    onDrop={e => {
                      e.preventDefault()
                      if (!dragChartId || dragChartId === chart.id) return
                      setTabs(prev => prev.map(t => {
                        if (t.id !== activeTab.id) return t
                        const charts = [...t.charts]
                        const fromIdx = charts.findIndex(c => c.id === dragChartId)
                        const toIdx = charts.findIndex(c => c.id === chart.id)
                        if (fromIdx < 0 || toIdx < 0) return t
                        const [moved] = charts.splice(fromIdx, 1)
                        charts.splice(toIdx, 0, moved)
                        return { ...t, charts }
                      }))
                      setDragChartId(null)
                      setDragOverChartId(null)
                    }}
                    onClick={e => { e.stopPropagation(); setSelectedChartId(isSelected ? null : chart.id) }}
                    style={{
                      gridColumn: isWide ? 'span 2' : 'span 1',
                      borderRadius: 10,
                      border: isSelected ? `2px solid ${T.cyan}` : isDragOver ? `2px dashed ${T.cyan}88` : `1px solid ${T.border}`,
                      background: T.bgCard,
                      boxShadow: isSelected ? `0 0 0 3px ${T.cyan}22` : 'none',
                      opacity: isDragging ? 0.5 : 1,
                      cursor: 'pointer',
                      transition: 'border 0.15s, box-shadow 0.15s, opacity 0.15s',
                      display: 'flex', flexDirection: 'column',
                      minHeight: 280,
                    }}
                  >
                    {/* Chart card header */}
                    <div style={{
                      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                      padding: '9px 12px 8px',
                      borderBottom: `1px solid ${T.border}`,
                      cursor: 'grab',
                    }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 7, minWidth: 0 }}>
                        {/* Drag handle */}
                        <div style={{ color: T.textMut, fontSize: 12, lineHeight: 1, letterSpacing: -1, flexShrink: 0, userSelect: 'none' }}>⣿</div>
                        {isSelected && (
                          <div style={{
                            fontSize: 9, fontWeight: 700, padding: '2px 6px', borderRadius: 4,
                            background: `${T.cyan}22`, color: T.cyan, border: `1px solid ${T.cyan}55`,
                            flexShrink: 0,
                          }}>SELECTED</div>
                        )}
                        <span style={{ fontSize: 13, fontWeight: 600, color: T.textPri, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {chart.spec?.title || 'Chart'}
                        </span>
                        <span style={{ fontSize: 10, color: T.textMut, flexShrink: 0 }}>
                          {chart.spec?.type || 'line'} · {chart.spec?.series?.length || 0}s
                          {chart.spec?.overlays?.length > 0 && ` · ${chart.spec.overlays.length}ov`}
                        </span>
                      </div>
                      <div style={{ display: 'flex', gap: 5, flexShrink: 0 }}>
                        {/* Smooth / hard line toggle */}
                        {(chart.spec?.type !== 'bar') && (
                          <button
                            onClick={e => {
                              e.stopPropagation()
                              updateChartSpec(activeTab.id, chart.id, s => ({ ...s, smooth: !s?.smooth }))
                            }}
                            title={chart.spec?.smooth ? 'Switch to hard lines' : 'Switch to smooth curves'}
                            style={{
                              display: 'flex', alignItems: 'center',
                              padding: '3px 7px', borderRadius: 5, border: `1px solid ${T.border}`,
                              background: chart.spec?.smooth ? `${T.cyan}18` : T.bgPanel,
                              color: chart.spec?.smooth ? T.cyan : T.textMut, fontSize: 10, cursor: 'pointer',
                              fontFamily: 'monospace', letterSpacing: '-1px',
                            }}
                          >
                            {chart.spec?.smooth ? '∿' : '⌇'}
                          </button>
                        )}
                        {/* Wide toggle */}
                        {activeTabCharts.length > 1 && (
                          <button
                            onClick={e => {
                              e.stopPropagation()
                              setTabs(prev => prev.map(t => t.id !== activeTab.id ? t : {
                                ...t, charts: t.charts.map(c => c.id !== chart.id ? c : { ...c, wide: !c.wide }),
                              }))
                            }}
                            title={chart.wide ? 'Shrink to half width' : 'Expand to full width'}
                            style={{
                              display: 'flex', alignItems: 'center',
                              padding: '3px 7px', borderRadius: 5, border: `1px solid ${T.border}`,
                              background: chart.wide ? `${T.cyan}18` : T.bgPanel,
                              color: chart.wide ? T.cyan : T.textMut, fontSize: 10, cursor: 'pointer',
                            }}
                          >
                            {chart.wide ? '⊟' : '⊞'}
                          </button>
                        )}
                        {chart.spec?.series?.some(s => s.metric) && (
                          <button
                            onClick={e => { e.stopPropagation(); resolveChartSpec(chart.spec, activeTab.id, chart.id) }}
                            title="Re-fetch data from TSDB"
                            style={{
                              display: 'flex', alignItems: 'center', gap: 4,
                              padding: '3px 7px', borderRadius: 5, border: `1px solid ${T.border}`,
                              background: T.bgPanel, color: T.textSec, fontSize: 10, cursor: 'pointer',
                            }}
                          >
                            <RefreshCw size={10} />
                          </button>
                        )}
                        <button
                          onClick={e => {
                            e.stopPropagation()
                            exportChartPng(chartBodyRefs.current[chart.id], chart.spec?.title)
                          }}
                          title="Export chart as PNG"
                          style={{
                            display: 'flex', alignItems: 'center',
                            padding: '3px 7px', borderRadius: 5, border: `1px solid ${T.border}`,
                            background: T.bgPanel, color: T.textMut, fontSize: 10, cursor: 'pointer',
                          }}
                        >
                          <Download size={10} />
                        </button>
                        <button
                          onClick={e => {
                            e.stopPropagation()
                            setTabs(prev => prev.map(t => t.id !== activeTab.id ? t : {
                              ...t, charts: t.charts.filter(c => c.id !== chart.id),
                            }))
                            if (selectedChartId === chart.id) setSelectedChartId(null)
                          }}
                          title="Remove chart"
                          style={{
                            display: 'flex', alignItems: 'center',
                            padding: '3px 6px', borderRadius: 5, border: `1px solid ${T.border}`,
                            background: T.bgPanel, color: T.textMut, fontSize: 10, cursor: 'pointer',
                          }}
                        >
                          <X size={10} />
                        </button>
                      </div>
                    </div>

                    {/* Chart body */}
                    <div
                      ref={el => { if (el) chartBodyRefs.current[chart.id] = el; else delete chartBodyRefs.current[chart.id] }}
                      style={{ height: 268, flexShrink: 0, padding: '8px 4px 4px' }}
                    >
                      {chart.loading ? (
                        <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 10 }}>
                          <RefreshCw size={20} color={T.cyan} style={{ animation: 'spin 1s linear infinite' }} />
                          <span style={{ fontSize: 12, color: T.textMut }}>Fetching data…</span>
                        </div>
                      ) : (
                        <ChartRenderer spec={chart.spec} />
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          ) : (
            /* Empty tab welcome state */
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', textAlign: 'center' }}>
              <div style={{
                width: 60, height: 60, borderRadius: '50%', marginBottom: 20,
                background: `${T.border}55`,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}>
                <BarChart3 size={26} color={T.textMut} />
              </div>
              <h2 style={{ fontSize: 18, fontWeight: 700, color: T.textPri, marginBottom: 8 }}>
                {tabs.findIndex(t => t.id === activeTabId) === 0 ? 'Welcome to TSDB.ai' : 'Empty Dashboard'}
              </h2>
              <p style={{ fontSize: 13, color: T.textMut, maxWidth: 380, lineHeight: 1.7, marginBottom: 20 }}>
                Use the AI assistant on the left to explore your metrics.
                Try <em style={{ color: T.cyan }}>"plot mock_cpu_utilization_percent"</em> to get started.
              </p>
              {context?.metrics && (
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'center', marginBottom: 20 }}>
                  {[
                    { label: 'Active series', val: context.metrics.unique_series_active?.toLocaleString() },
                    { label: 'Anomalies', val: context.metrics.anomalies_detected, warn: context.metrics.anomalies_detected > 0 },
                    { label: 'Avg RMSE', val: context.metrics.average_rmse?.toFixed(3) },
                  ].filter(p => p.val !== undefined).map(pill => (
                    <div key={pill.label} style={{
                      padding: '5px 12px', borderRadius: 20,
                      background: T.bgCard, border: `1px solid ${T.border}`,
                      fontSize: 11, color: T.textMut,
                    }}>
                      {pill.label}: <strong style={{ color: pill.warn ? T.red : T.textSec }}>{pill.val}</strong>
                    </div>
                  ))}
                </div>
              )}
              {(context?.metricNames?.length > 0) && (
                <div style={{ maxWidth: 500 }}>
                  <div style={{ fontSize: 11, color: T.textMut, marginBottom: 8, letterSpacing: '0.07em' }}>AVAILABLE METRICS</div>
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', justifyContent: 'center' }}>
                    {context.metricNames.slice(0, 12).map(name => (
                      <button
                        key={name}
                        onClick={() => sendMessage(`Plot ${name}`)}
                        disabled={provider !== 'local' && !apiKey}
                        style={{
                          padding: '4px 11px', borderRadius: 12,
                          border: `1px solid ${T.border}`, background: T.bgCard,
                          color: apiKey ? T.textSec : T.textMut, fontSize: 11, cursor: apiKey ? 'pointer' : 'not-allowed',
                          fontFamily: T.mono, opacity: apiKey ? 1 : 0.5,
                        }}
                      >{name}</button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>

    {/* ── Presentation Mode Overlay ─────────────────────────────────────────── */}
    {presentationIdx !== null && (() => {
      const charts = activeTabCharts
      const chart = charts[presentationIdx]
      if (!chart) return null
      const total = charts.length
      const tabColor = activeTab?.color || T.cyan
      return (
        <div
          style={{
            position: 'fixed', inset: 0, zIndex: 9999,
            background: '#0a0a14',
            display: 'flex', flexDirection: 'column',
          }}
          onKeyDown={e => e.stopPropagation()}
        >
          {/* Presentation top bar */}
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            padding: '10px 20px', borderBottom: `1px solid ${T.border}`,
            background: `${T.bgPanel}ee`, flexShrink: 0,
          }}>
            {/* Left: tab breadcrumb only — title is shown large on the chart */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <div style={{ width: 8, height: 8, borderRadius: '50%', background: tabColor, flexShrink: 0 }} />
              <span style={{ fontSize: 12, color: T.textMut }}>{activeTab?.label}</span>
              <span style={{ fontSize: 11, color: `${T.textMut}66` }}>
                {chart.spec?.type || 'line'} · {chart.spec?.series?.length || 0} series
                {chart.spec?.overlays?.length > 0 && ` · ${chart.spec.overlays.length} overlays`}
              </span>
            </div>

            {/* Center: slide counter + dot navigation */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              {charts.map((c, i) => (
                <button
                  key={c.id}
                  onClick={() => setPresentationIdx(i)}
                  style={{
                    width: i === presentationIdx ? 24 : 8,
                    height: 8, borderRadius: 4, border: 'none', cursor: 'pointer',
                    background: i === presentationIdx ? tabColor : `${T.textMut}55`,
                    transition: 'all 0.2s',
                    padding: 0,
                  }}
                />
              ))}
              <span style={{ fontSize: 12, color: T.textMut, marginLeft: 4, fontVariantNumeric: 'tabular-nums' }}>
                {presentationIdx + 1} / {total}
              </span>
            </div>

            {/* Right: export + exit */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span style={{ fontSize: 11, color: T.textMut }}>← → to navigate · Esc to exit</span>
              <button
                onClick={() => exportChartPng(presentationChartRef.current, chart.spec?.title)}
                title="Export current chart as PNG"
                style={{
                  display: 'flex', alignItems: 'center', gap: 6,
                  padding: '6px 14px', borderRadius: 8,
                  border: `1px solid ${T.border}`, background: T.bgCard,
                  color: T.textSec, fontSize: 12, cursor: 'pointer',
                }}
              >
                <Download size={13} /> Export PNG
              </button>
              <button
                onClick={() => setPresentationIdx(null)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 6,
                  padding: '6px 14px', borderRadius: 8,
                  border: `1px solid ${T.border}`, background: T.bgCard,
                  color: T.textSec, fontSize: 12, cursor: 'pointer',
                }}
              >
                <X size={13} /> Exit
              </button>
            </div>
          </div>

          {/* Chart area with prev/next arrows */}
          <div style={{ flex: 1, display: 'flex', alignItems: 'stretch', minHeight: 0 }}>
            {/* Prev arrow */}
            <button
              onClick={() => setPresentationIdx(i => Math.max(i - 1, 0))}
              disabled={presentationIdx === 0}
              style={{
                width: 56, flexShrink: 0, background: 'transparent',
                border: 'none', cursor: presentationIdx > 0 ? 'pointer' : 'default',
                color: presentationIdx > 0 ? T.textSec : `${T.textMut}33`,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                transition: 'color 0.15s',
              }}
            >
              <ChevronLeft size={32} />
            </button>

            {/* The chart itself */}
            <div
              ref={presentationChartRef}
              style={{ flex: 1, minWidth: 0, minHeight: 0, position: 'relative' }}
            >
              {chart.loading ? (
                <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 14 }}>
                  <RefreshCw size={28} color={T.cyan} style={{ animation: 'spin 1s linear infinite' }} />
                  <span style={{ fontSize: 14, color: T.textMut }}>Fetching data…</span>
                </div>
              ) : (
                /* Absolute-position wrapper gives ResponsiveContainer a definite
                   pixel height so height="100%" works correctly in flex context */
                <div style={{ position: 'absolute', inset: '20px 0' }}>
                  {/* Large metric title — presentation mode only */}
                  <div style={{
                    position: 'absolute', top: 0, left: 24, right: 24, zIndex: 10,
                    pointerEvents: 'none',
                  }}>
                    <div style={{
                      fontSize: 28, fontWeight: 800, color: T.textPri,
                      letterSpacing: '-0.02em', lineHeight: 1.15,
                      fontFamily: 'Inter, sans-serif',
                      textShadow: `0 2px 20px #00000099`,
                    }}>
                      {chart.spec?.title || 'Chart'}
                    </div>
                    {chart.spec?.series?.length > 0 && (
                      <div style={{
                        marginTop: 4, fontSize: 12, color: T.textMut,
                        fontFamily: 'JetBrains Mono, monospace', letterSpacing: '0.01em',
                      }}>
                        {chart.spec.series.map(s => s.metric || s.name).filter(Boolean).join(' · ')}
                      </div>
                    )}
                  </div>
                  <ChartRenderer spec={chart.spec} height="100%" />
                </div>
              )}
            </div>

            {/* Next arrow */}
            <button
              onClick={() => setPresentationIdx(i => Math.min(i + 1, total - 1))}
              disabled={presentationIdx === total - 1}
              style={{
                width: 56, flexShrink: 0, background: 'transparent',
                border: 'none', cursor: presentationIdx < total - 1 ? 'pointer' : 'default',
                color: presentationIdx < total - 1 ? T.textSec : `${T.textMut}33`,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                transition: 'color 0.15s',
              }}
            >
              <ChevronRight size={32} />
            </button>
          </div>

          {/* Bottom: thumbnail strip when 3+ charts */}
          {total >= 3 && (
            <div style={{
              display: 'flex', gap: 8, padding: '10px 20px',
              borderTop: `1px solid ${T.border}`, background: `${T.bgPanel}cc`,
              overflowX: 'auto', flexShrink: 0,
            }}>
              {charts.map((c, i) => (
                <button
                  key={c.id}
                  onClick={() => setPresentationIdx(i)}
                  style={{
                    flexShrink: 0, padding: '6px 14px', borderRadius: 7, cursor: 'pointer',
                    border: i === presentationIdx ? `1px solid ${tabColor}` : `1px solid ${T.border}`,
                    background: i === presentationIdx ? `${tabColor}18` : T.bgCard,
                    color: i === presentationIdx ? tabColor : T.textMut,
                    fontSize: 11, fontWeight: i === presentationIdx ? 600 : 400,
                    whiteSpace: 'nowrap',
                  }}
                >
                  {c.spec?.title || `Chart ${i + 1}`}
                </button>
              ))}
            </div>
          )}
        </div>
      )
    })()}
    </>
  )
}
