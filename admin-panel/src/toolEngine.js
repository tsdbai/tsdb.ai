/**
 * toolEngine.js
 *
 * Phase 1 — Data Mode tools
 * Phase 2 — Design Mode tools
 * Phase 3 — Overlay Mode tools (planned)
 *
 * The AI embeds tool calls in its responses using the format:
 *   <TOOL name="fetch_timeseries">{"metric":"cpu_usage","duration":3600}</TOOL>
 *
 * Multiple tool blocks are allowed per response.  They are parsed, executed
 * in sequence, and rendered as ToolResultCard components in the chat.
 *
 * The existing <CHART> block protocol is preserved for inline/example data.
 * Tools that need real TSDB data should use <TOOL> blocks, not <CHART> blocks.
 */

import {
  queryMetricForChart,
  fetchMetricForecast,
  vectorSearchSimilar,
  searchMetricNames,
} from './contextEngine'

// ─── Chart color palette (matches AIDashboard) ────────────────────────────────

const CHART_COLORS = ['#06b6d4','#7c3aed','#10b981','#f59e0b','#ef4444','#3b82f6','#ec4899','#84cc16']

// ─── Tool definitions ─────────────────────────────────────────────────────────
// Used to inject available-tool documentation into the AI system prompt.

export const TOOL_DEFINITIONS = {
  data: [
    {
      name: 'fetch_timeseries',
      description: 'Fetches real time series data from the TSDB Query Gateway for one metric and renders it on the active chart tab.',
      params: {
        metric:   'string  — exact metric name (required)',
        duration: 'number  — time window in seconds (default: 3600)',
        step:     'number  — resolution in seconds (default: auto)',
        label:    'string  — display name override',
        color:    'string  — hex color for the series',
        tab:      '"current" | "new"  — target tab (default: "current")',
      },
      example: { metric: 'cpu_usage', duration: 3600, color: '#06b6d4' },
    },
    {
      name: 'list_available_metrics',
      description: 'Lists metrics in TSDB, filtered by an optional keyword.  Use this when the user asks which metrics exist or match a pattern.',
      params: {
        query: 'string  — optional keyword filter (e.g. "cpu", "error", "disk")',
      },
      example: { query: 'cpu' },
    },
    {
      name: 'create_graph',
      description: 'Creates a new chart tab on the dashboard and fetches data for one or more metrics.',
      params: {
        title:    'string  — chart title',
        type:     '"line" | "bar" | "area"  — chart type (default: "line")',
        metrics:  'array of {metric, label?, color?} objects to fetch and plot',
        duration: 'number  — time window in seconds (default: 3600)',
      },
      example: {
        title: 'CPU vs Memory', type: 'line', duration: 3600,
        metrics: [{ metric: 'cpu_usage', label: 'CPU %', color: '#06b6d4' },
                  { metric: 'mem_used',  label: 'Memory', color: '#7c3aed' }],
      },
    },
    {
      name: 'predict_timeseries',
      description: 'Runs TSDB polynomial forecast for a metric and renders historical data + forecast extension with confidence bands on a new tab.',
      params: {
        metric:  'string  — metric to forecast (required)',
        horizon: 'number  — forecast horizon in seconds (default: 300)',
        tab:     '"current" | "new"  — target tab (default: "new")',
      },
      example: { metric: 'disk_free', horizon: 900 },
    },
    {
      name: 'find_historical_incidents',
      description: 'Searches the TSDB vector DB for historical incidents whose shape is similar to the current behaviour of a metric.',
      params: {
        metric: 'string  — metric to match (required)',
        top_k:  'number  — number of matches to return (default: 5)',
      },
      example: { metric: 'cpu_usage', top_k: 5 },
    },
    {
      name: 'suggest_alert_thresholds',
      description: 'Computes P50/P90/P95/P99 percentiles from 24 h of data and recommends warning/critical alert thresholds for each metric.',
      params: {
        metrics: 'array of metric name strings (required)',
      },
      example: { metrics: ['cpu_usage', 'error_rate'] },
    },
    {
      name: 'hunt_outliers',
      description: 'Returns active TSDB anomalies.  Optionally filter by minimum RMSE or severity.',
      params: {
        min_rmse: 'number  — minimum RMSE to include (default: 0 = all)',
        severity: '"any" | "high" | "critical"  — severity filter (default: "any")',
      },
      example: { min_rmse: 1.0, severity: 'high' },
    },
    {
      name: 'correlate_service_metrics',
      description: 'Returns causal edges and structural similarity relationships from the TSDB causal graph, optionally filtered to a specific metric.',
      params: {
        metric:   'string  — filter edges involving this metric (optional, omit for full graph)',
        min_obs:  'number  — minimum observation count for causal edges (default: 1)',
      },
      example: { metric: 'auth_errors', min_obs: 3 },
    },
  ],

  design: [
    {
      name: 'set_graph_color',
      description: 'Changes the color of one or all series on the active chart.',
      params: {
        color:        'string  — hex color (required, e.g. "#ef4444")',
        series_index: 'number  — 0-based series index to target (omit to apply to all series)',
        series_name:  'string  — series name to target (alternative to series_index)',
      },
      example: { series_index: 0, color: '#ef4444' },
    },
    {
      name: 'set_line_style',
      description: 'Changes the line style (solid, dashed, dotted) and/or width for one or all series on the active chart.',
      params: {
        style:        '"solid" | "dashed" | "dotted"  — stroke dash pattern',
        width:        'number  — stroke width in pixels (default: unchanged)',
        series_index: 'number  — 0-based series index (omit for all series)',
        series_name:  'string  — series name (alternative to series_index)',
      },
      example: { style: 'dashed', width: 1.5, series_index: 0 },
    },
    {
      name: 'set_all_line_styles',
      description: 'Applies the same line style and/or width to ALL series across ALL chart tabs at once.',
      params: {
        style: '"solid" | "dashed" | "dotted"',
        width: 'number  — stroke width (optional)',
      },
      example: { style: 'solid', width: 2 },
    },
    {
      name: 'set_graph_type',
      description: 'Switches the active chart between line, area, bar, or scatter.',
      params: {
        type: '"line" | "area" | "bar" | "scatter"',
      },
      example: { type: 'area' },
    },
    {
      name: 'set_threshold_colors',
      description: 'Adds colored reference zones to the active chart (e.g. red above 80%, green below 20%).',
      params: {
        thresholds: 'array of { value: number, color: string, label: string, above: boolean }',
      },
      example: {
        thresholds: [
          { value: 80, color: '#ef4444', label: 'Critical', above: true },
          { value: 20, color: '#10b981', label: 'Healthy',  above: false },
        ],
      },
    },
    {
      name: 'set_graph_title',
      description: 'Renames the active chart tab.',
      params: {
        title: 'string  — new chart title',
      },
      example: { title: 'CPU Usage — Last Hour' },
    },
    {
      name: 'apply_style_preset',
      description: `Applies a named style preset to the current chart or all charts.
Available presets: aurora-neon, dark-executive, minimal, vivid, terminal, blueprint.`,
      params: {
        preset: '"aurora-neon" | "dark-executive" | "minimal" | "vivid" | "terminal" | "blueprint"',
        target: '"current" | "all"  — which charts to update (default: "current")',
      },
      example: { preset: 'aurora-neon', target: 'current' },
    },
    {
      name: 'style_all_graphs',
      description: 'Applies consistent styling properties to ALL chart tabs at once.',
      params: {
        type:      '"line" | "area" | "bar"  — optional chart type override',
        lineWidth: 'number  — stroke width for all series',
        showGrid:  'boolean — show/hide grid lines',
        colors:    'array of hex strings — color rotation applied to series in order',
      },
      example: { lineWidth: 2, showGrid: true, colors: ['#06b6d4', '#7c3aed', '#10b981'] },
    },
  ],

  overlay: [
    {
      name: 'add_annotation',
      description: 'Adds a vertical annotation marker at a specific time label on the active chart (e.g. to mark a deploy, incident, or event).',
      params: {
        time:  'string  — time label matching the X axis (e.g. "02:30 PM") (required)',
        label: 'string  — annotation text (required)',
        color: 'string  — hex color (default: "#06b6d4")',
        position: '"top" | "bottom" | "insideTop" | "insideBottom"  — label position (default: "insideTop")',
      },
      example: { time: '02:30 PM', label: 'Deploy v2.1', color: '#06b6d4' },
    },
    {
      name: 'add_moving_average',
      description: 'Adds a moving average overlay line on the active chart for the primary (first) series.',
      params: {
        period: 'number  — rolling window size in data points (required)',
        color:  'string  — hex color for the MA line (default: "#f59e0b")',
        label:  'string  — legend label (default: "MA(N)")',
      },
      example: { period: 7, color: '#f59e0b' },
    },
    {
      name: 'add_threshold_line',
      description: 'Adds a single horizontal reference line at a fixed Y value on the active chart.',
      params: {
        value: 'number  — Y axis value (required)',
        label: 'string  — display label (required)',
        color: 'string  — hex color (default: "#ef4444")',
        style: '"solid" | "dashed" | "dotted"  — line style (default: "dashed")',
      },
      example: { value: 85, label: 'SLA limit', color: '#ef4444', style: 'dashed' },
    },
    {
      name: 'add_trend_line',
      description: 'Adds a linear regression trend line over the data of one series on the active chart.',
      params: {
        series_name:  'string  — target series name or label (default: first series)',
        series_index: 'number  — 0-based target series index (alternative to series_name)',
        color:        'string  — hex color for the trend line (default: "#10b981")',
        label:        'string  — legend label (default: "Trend")',
      },
      example: { series_index: 0, color: '#10b981', label: 'Trend' },
    },
    {
      name: 'add_time_grid',
      description: 'Adds evenly-spaced vertical grid lines at every N data points on the active chart (useful for marking periods).',
      params: {
        interval: 'number  — number of data-point steps between each vertical line (required)',
        color:    'string  — hex color (default: "#64748b")',
        label:    '"index" | "time" | ""  — whether to show step labels (default: "")',
      },
      example: { interval: 10, color: '#64748b' },
    },
    {
      name: 'remove_overlay',
      description: 'Removes overlays from the selected chart, or from ALL charts when all=true.',
      params: {
        type: 'string  — overlay type to remove (e.g. "movingAverage", "thresholdLine", "annotation", "anomaly", "trendLine", "timeGrid") — omit to remove ALL overlay types',
        id:   'string  — specific overlay id to remove (optional)',
        all:  'boolean — when true, removes the overlay from EVERY chart on the tab (not just the selected one)',
      },
      example: { type: 'anomaly', all: true },
    },
  ],
}

// ─── Style presets ────────────────────────────────────────────────────────────

export const STYLE_PRESETS = {
  'aurora-neon': {
    description: 'Vibrant neon cyan/purple — glowing thin lines',
    lineWidth: 1.5,
    showGrid: true,
    colors: ['#06b6d4', '#7c3aed', '#ec4899', '#10b981', '#f59e0b', '#3b82f6'],
    type: null,
  },
  'dark-executive': {
    description: 'Thick neutral/slate lines, no grid, serious dark look',
    lineWidth: 3,
    showGrid: false,
    colors: ['#94a3b8', '#64748b', '#7c3aed', '#475569', '#334155'],
    type: null,
  },
  'minimal': {
    description: 'Hairline strokes, subtle grid, maximum data-ink ratio',
    lineWidth: 1,
    showGrid: true,
    colors: ['#e2e8f0', '#94a3b8', '#64748b', '#475569'],
    type: 'line',
  },
  'vivid': {
    description: 'Bold saturated palette rendered as area chart',
    lineWidth: 2,
    showGrid: true,
    colors: ['#ef4444', '#f97316', '#eab308', '#22c55e', '#3b82f6', '#a855f7'],
    type: 'area',
  },
  'terminal': {
    description: 'Retro phosphor-green on dark, mono-color CRT feel',
    lineWidth: 1.5,
    showGrid: true,
    colors: ['#22c55e', '#86efac', '#4ade80', '#15803d'],
    type: 'line',
  },
  'blueprint': {
    description: 'Engineering blue tones with area fills',
    lineWidth: 2,
    showGrid: true,
    colors: ['#3b82f6', '#60a5fa', '#93c5fd', '#1d4ed8', '#2563eb'],
    type: 'area',
  },
}

// ─── Build tool instructions for system prompt ────────────────────────────────

export function buildToolInstructions(mode) {
  const tools = TOOL_DEFINITIONS[mode]
  if (!tools || tools.length === 0) return ''

  const toolDocs = tools.map(t => {
    const paramLines = Object.entries(t.params || {})
      .map(([k, v]) => `        "${k}": ${v}`)
      .join('\n')
    return `  ▸ ${t.name}\n    ${t.description}\n    Params:\n${paramLines}\n    Example: ${JSON.stringify(t.example)}`
  }).join('\n\n')

  return `
═══ TOOL PROTOCOL ═══
Embed tool calls using <TOOL name="...">JSON params</TOOL> blocks.
Multiple tool calls are allowed in a single response.
Place tool blocks AFTER your explanation text.

Available tools in ${mode.toUpperCase()} mode:

${toolDocs}

Critical rules:
${mode === 'data' ? `\
• Use <TOOL name="fetch_timeseries"> when the user asks to see/chart/plot a real TSDB metric.
  Do NOT use a <CHART> block with "metric" field for this — use <TOOL> instead.
• Use <CHART> blocks ONLY when providing inline example/illustrative data[] arrays.
• Use <TOOL name="create_graph"> to open a new dashboard tab with multiple metrics.
• Use <TOOL name="predict_timeseries"> for any forecast request.
• Use <TOOL name="hunt_outliers"> when asked about anomalies or outliers.
• Use <TOOL name="suggest_alert_thresholds"> when asked to recommend alert thresholds.
• Use <TOOL name="correlate_service_metrics"> for causal/correlation analysis.` : ''}
${mode === 'design' ? `\
• Never use <CHART> blocks in Design mode — always use <TOOL> blocks to modify the current chart.
• Use set_graph_color / set_line_style for individual series tweaks.
• Use apply_style_preset when the user asks for a named look or theme.
• Use style_all_graphs when changes should affect all open chart tabs.
• set_threshold_colors adds colored zones — always ask for the value and direction (above/below).
• Chaining is allowed: emit multiple <TOOL> blocks to apply several design changes at once.` : ''}
${mode === 'overlay' ? `\
• Use overlay tools to add analytical layers on top of the existing chart data.
• Never replace data with overlay tools — only add/remove decorative or analytical overlays.
• add_annotation marks a specific time on the X axis (e.g. a deploy or incident).
• add_moving_average adds a rolling average line — specify the period in data points.
• add_threshold_line draws a horizontal dashed line at a fixed Y value — great for SLA/SLO references.
• add_trend_line computes a linear regression over a series and plots the best-fit line.
• add_time_grid adds evenly-spaced vertical guide lines — specify the interval in data points.
• remove_overlay removes by type or id; omit both to clear ALL overlay types from the selected chart.
• Pass all=true to remove_overlay to remove from EVERY chart on the tab — use this whenever the user says "all charts", "every chart", or no specific chart is selected.
• Chaining: emit multiple overlay tool blocks in one response (e.g. MA + threshold line together).
• When user says "add X to all charts" — emit one <TOOL name="..."> per chart is NOT the right approach. Instead use style_all_graphs or confirm that overlay tools apply per-chart (tell user to select a chart).` : ''}`
}

// ─── Parse tool blocks from AI response ──────────────────────────────────────

/**
 * parseToolBlocks(text)
 *
 * Extracts all <TOOL name="...">...</TOOL> blocks from the AI response.
 * Returns { clean, tools } where:
 *   clean — response text with tool blocks removed
 *   tools — array of { name, params, raw, parseError? }
 */
export function parseToolBlocks(text) {
  const tools = []
  let clean = text
  const regex = /<TOOL\s+name="([^"]+)">([\s\S]*?)<\/TOOL>/g
  let match
  while ((match = regex.exec(text)) !== null) {
    const [full, name, body] = match
    try {
      const params = JSON.parse(body.trim())
      tools.push({ name, params, raw: full })
    } catch {
      tools.push({ name, params: {}, raw: full, parseError: true })
    }
    clean = clean.replace(full, '')
  }
  return { clean: clean.trim(), tools }
}

// ─── Tool execution ───────────────────────────────────────────────────────────

/**
 * executeToolCall(name, params, deps)
 *
 * Executes one tool and returns a structured result object.
 * The result type determines how ToolResultCard renders it.
 *
 * deps = {
 *   context,          // full TSDB context from fetchFullContext()
 *   activeTabId,
 *   updateTabSpec,    // (tabId, spec | fn) => void
 *   setTabLoading,    // (tabId, bool) => void
 *   addTab,           // (spec) => newTabId
 * }
 */
export async function executeToolCall(name, params, deps) {
  const { context, activeTabId, updateTabSpec, setTabLoading, addTab } = deps

  try {
    switch (name) {

      // ── fetch_timeseries ────────────────────────────────────────────────────
      case 'fetch_timeseries': {
        const { metric, duration = 3600, step = null, label, color, tab = 'current' } = params
        if (!metric) return { type: 'error', message: '"metric" is required' }

        if (tab === 'current') setTabLoading(activeTabId, true)

        const results = await queryMetricForChart(metric, duration, step)
        if (!results.length) {
          if (tab === 'current') setTabLoading(activeTabId, false)
          return { type: 'error', message: `No data returned for metric "${metric}". Is the metric name correct?` }
        }

        const seriesName = metric.replace(/[^a-z0-9_]/gi, '_')
        const newSeries = {
          name: seriesName,
          label: label || metric,
          color: color || CHART_COLORS[0],
          data: results[0].data,
        }

        if (tab === 'new') {
          const spec = {
            title: label || metric,
            type: 'line',
            showGrid: true,
            lineWidth: 2,
            series: [newSeries],
          }
          const newTabId = addTab(spec)
          return {
            type: 'chart-update',
            metric, seriesCount: 1, points: results[0].data.length,
            tabCreated: true, tabId: newTabId,
          }
        } else {
          updateTabSpec(activeTabId, existing => {
            if (!existing) {
              return {
                title: label || metric, type: 'line', showGrid: true, lineWidth: 2,
                series: [newSeries],
              }
            }
            const existingSeries = existing.series || []
            const alreadyExists = existingSeries.some(s => s.name === seriesName)
            return {
              ...existing,
              series: alreadyExists
                ? existingSeries.map(s => s.name === seriesName ? { ...s, data: newSeries.data } : s)
                : [...existingSeries, newSeries],
            }
          })
          setTabLoading(activeTabId, false)
          return {
            type: 'chart-update',
            metric, seriesCount: 1, points: results[0].data.length,
            tabCreated: false,
          }
        }
      }

      // ── list_available_metrics ──────────────────────────────────────────────
      case 'list_available_metrics': {
        const { query = '' } = params
        const metrics = query
          ? await searchMetricNames(query)
          : (context?.metricNames || [])
        return {
          type: 'metric-list',
          query,
          metrics,
          total: metrics.length,
        }
      }

      // ── create_graph ────────────────────────────────────────────────────────
      case 'create_graph': {
        const { title = 'New Chart', type = 'line', metrics: metricList = [], duration = 3600 } = params
        if (!metricList.length) return { type: 'error', message: '"metrics" array must not be empty' }

        const series = await Promise.all(
          metricList.map(async (m, i) => {
            const name   = typeof m === 'string' ? m : m.metric
            const lbl    = typeof m === 'object' ? (m.label || name) : name
            const col    = typeof m === 'object' ? m.color : undefined
            const sName  = name.replace(/[^a-z0-9_]/gi, '_')
            try {
              const results = await queryMetricForChart(name, duration)
              return {
                name: sName, label: lbl,
                color: col || CHART_COLORS[i % CHART_COLORS.length],
                data: results[0]?.data || [],
                metric: name,
              }
            } catch {
              return {
                name: sName, label: lbl,
                color: col || CHART_COLORS[i % CHART_COLORS.length],
                data: [], metric: name,
              }
            }
          })
        )

        const spec = { title, type, showGrid: true, lineWidth: 2, series }
        const newTabId = addTab(spec)
        return {
          type: 'graph-created',
          title, tabId: newTabId,
          seriesCount: series.length,
          metrics: metricList.map(m => typeof m === 'string' ? m : m.metric),
          pointCounts: series.map(s => s.data.length),
        }
      }

      // ── predict_timeseries ──────────────────────────────────────────────────
      case 'predict_timeseries': {
        const { metric, horizon = 300, tab = 'new' } = params
        if (!metric) return { type: 'error', message: '"metric" is required' }

        if (tab === 'current') setTabLoading(activeTabId, true)

        const [histRes, fcRes] = await Promise.allSettled([
          queryMetricForChart(metric, 3600),
          fetchMetricForecast(metric, horizon),
        ])
        const historical = histRes.status === 'fulfilled' ? histRes.value : []
        const fc = fcRes.status === 'fulfilled' ? fcRes.value?.data : null

        if (!historical.length && !fc) {
          if (tab === 'current') setTabLoading(activeTabId, false)
          return { type: 'error', message: `No data or forecast available for "${metric}"` }
        }

        const histData = historical[0]?.data || []

        // Build forecast extension points (last historical + forecast endpoint)
        const lastHist = histData.length > 0 ? [histData[histData.length - 1]] : []
        const fcTime = new Date(Date.now() + horizon * 1000)
          .toLocaleTimeString('en', { hour: '2-digit', minute: '2-digit' })

        const fcSeries = fc ? [
          {
            name: 'forecast',
            label: `Forecast (${fc.forecast_quality || '?'})`,
            color: '#f59e0b',
            data: [...lastHist, { t: fcTime, v: fc.predicted_value }],
          },
          ...(fc.confidence_high != null ? [{
            name: 'conf_hi',
            label: 'Upper bound',
            color: '#f59e0b',
            data: [...lastHist.map(p => ({ ...p, v: p.v })),
                   { t: fcTime, v: fc.confidence_high }],
          }] : []),
          ...(fc.confidence_low != null ? [{
            name: 'conf_lo',
            label: 'Lower bound',
            color: '#f59e0b',
            data: [...lastHist.map(p => ({ ...p, v: p.v })),
                   { t: fcTime, v: fc.confidence_low }],
          }] : []),
        ] : []

        const spec = {
          title: `${metric}  +${horizon}s forecast`,
          type: 'line',
          showGrid: true,
          lineWidth: 2,
          series: [
            { name: metric.replace(/\W/g, '_'), label: 'Actual', color: '#06b6d4', data: histData },
            ...fcSeries,
          ],
        }

        if (tab === 'new') {
          addTab(spec)
        } else {
          updateTabSpec(activeTabId, spec)
          setTabLoading(activeTabId, false)
        }

        return {
          type: 'forecast-result',
          metric, horizon,
          current:    fc?.current_value,
          predicted:  fc?.predicted_value,
          confLow:    fc?.confidence_low,
          confHigh:   fc?.confidence_high,
          quality:    fc?.forecast_quality,
          model:      fc?.model_name || `model_${fc?.model_id}`,
          rmse:       fc?.rolling_rmse,
          histPoints: histData.length,
        }
      }

      // ── find_historical_incidents ───────────────────────────────────────────
      case 'find_historical_incidents': {
        const { metric, top_k = 5 } = params
        if (!metric) return { type: 'error', message: '"metric" is required' }
        const matches = await vectorSearchSimilar(metric, top_k)
        return {
          type: 'incident-list',
          metric, matches,
          total: matches.length,
        }
      }

      // ── suggest_alert_thresholds ────────────────────────────────────────────
      case 'suggest_alert_thresholds': {
        const { metrics: metricList = [] } = params
        if (!metricList.length) return { type: 'error', message: '"metrics" array must not be empty' }

        const suggestions = {}
        await Promise.allSettled(
          metricList.map(async name => {
            // Use 24h window for more statistically robust percentiles
            const results = await queryMetricForChart(name, 86400, 60)
            const values = results.flatMap(r => r.data.map(d => d.v)).filter(v => !isNaN(v) && isFinite(v))

            if (!values.length) {
              suggestions[name] = { error: 'No data available (24h)' }
              return
            }
            const sorted = [...values].sort((a, b) => a - b)
            const pct = p => sorted[Math.min(Math.floor(sorted.length * p), sorted.length - 1)]
            const fmt = v => v.toPrecision(5)

            suggestions[name] = {
              samples:  values.length,
              min:      fmt(sorted[0]),
              p50:      fmt(pct(0.50)),
              p75:      fmt(pct(0.75)),
              p90:      fmt(pct(0.90)),
              p95:      fmt(pct(0.95)),
              p99:      fmt(pct(0.99)),
              max:      fmt(sorted[sorted.length - 1]),
              // Recommended thresholds: warning=P90, critical=P95
              warning:  fmt(pct(0.90)),
              critical: fmt(pct(0.95)),
            }
          })
        )
        return { type: 'threshold-suggestions', metrics: metricList, suggestions }
      }

      // ── hunt_outliers ───────────────────────────────────────────────────────
      case 'hunt_outliers': {
        const { min_rmse = 0, severity = 'any' } = params
        let anomalies = context?.anomalies?.anomalies || []
        if (min_rmse > 0) anomalies = anomalies.filter(a => (a.rmse || 0) >= min_rmse)
        if (severity !== 'any') {
          anomalies = anomalies.filter(a => a.severity?.toLowerCase() === severity.toLowerCase())
        }
        return {
          type: 'outlier-list',
          anomalies,
          total: anomalies.length,
          filtered: min_rmse > 0 || severity !== 'any',
        }
      }

      // ── correlate_service_metrics ────────────────────────────────────────────
      case 'correlate_service_metrics': {
        const { metric, min_obs = 1 } = params
        let causal = context?.causal?.edges || []
        let structural = context?.relationships?.edges || []

        if (metric) {
          const lc = metric.toLowerCase()
          causal     = causal.filter(e =>
            e.source_metric?.toLowerCase().includes(lc) ||
            e.target_metric?.toLowerCase().includes(lc)
          )
          structural = structural.filter(e =>
            e.source_metric?.toLowerCase().includes(lc) ||
            e.target_metric?.toLowerCase().includes(lc)
          )
        }
        causal = causal.filter(e => (e.observation_count || 0) >= min_obs)

        return {
          type: 'correlation-graph',
          metric: metric || null,
          causalEdges: causal,
          structuralEdges: structural.slice(0, 10),
          totalCausal: causal.length,
          totalStructural: structural.length,
        }
      }

      // ══════════════════════════════════════════════════════════════════════
      // PHASE 2 — DESIGN TOOLS
      // These tools modify the chart spec (colors, styles, type, thresholds).
      // They do not fetch data.  They require { updateTabSpec, setAllTabs } in deps.
      // ══════════════════════════════════════════════════════════════════════

      // ── set_graph_color ─────────────────────────────────────────────────────
      case 'set_graph_color': {
        const { color, series_index, series_name } = params
        if (!color) return { type: 'error', message: '"color" is required' }

        let changed = 0
        updateTabSpec(activeTabId, spec => {
          if (!spec) return spec
          const series = (spec.series || []).map((s, i) => {
            const matches =
              series_index != null ? i === series_index :
              series_name  != null ? s.name === series_name || s.label === series_name :
              true // apply to all if no target given
            if (!matches) return s
            changed++
            return { ...s, color }
          })
          return { ...spec, series }
        })
        return {
          type: 'design-update',
          tool: 'set_graph_color',
          summary: changed === 1
            ? `Series ${series_index ?? series_name ?? '(all)'} → ${color}`
            : `${changed} series → ${color}`,
          color,
        }
      }

      // ── set_line_style ──────────────────────────────────────────────────────
      case 'set_line_style': {
        const { style, width, series_index, series_name } = params
        if (!style && width == null) return { type: 'error', message: 'Provide at least "style" or "width"' }

        const DASH_MAP = { solid: '0', dashed: '8 4', dotted: '2 3' }
        const dashArray = style ? (DASH_MAP[style] || '0') : undefined

        let changed = 0
        updateTabSpec(activeTabId, spec => {
          if (!spec) return spec
          const targetAll = series_index == null && series_name == null
          const series = (spec.series || []).map((s, i) => {
            const matches = targetAll ? true :
              series_index != null ? i === series_index :
              s.name === series_name || s.label === series_name
            if (!matches) return s
            changed++
            return {
              ...s,
              ...(dashArray !== undefined ? { dashArray } : {}),
            }
          })
          return {
            ...spec,
            series,
            ...(width != null ? { lineWidth: width } : {}),
          }
        })
        return {
          type: 'design-update',
          tool: 'set_line_style',
          summary: `${style || ''}${width != null ? ` w=${width}` : ''} → ${changed} series`,
          style, width,
        }
      }

      // ── set_all_line_styles ─────────────────────────────────────────────────
      case 'set_all_line_styles': {
        const { style, width } = params
        if (!style && width == null) return { type: 'error', message: 'Provide at least "style" or "width"' }

        const DASH_MAP = { solid: '0', dashed: '8 4', dotted: '2 3' }
        const dashArray = style ? (DASH_MAP[style] || '0') : undefined

        const { setAllTabs } = deps
        if (!setAllTabs) return { type: 'error', message: 'setAllTabs dep missing' }

        let tabCount = 0
        setAllTabs(spec => {
          if (!spec) return spec
          tabCount++
          const series = (spec.series || []).map(s => ({
            ...s,
            ...(dashArray !== undefined ? { dashArray } : {}),
          }))
          return {
            ...spec,
            series,
            ...(width != null ? { lineWidth: width } : {}),
          }
        })
        return {
          type: 'design-update',
          tool: 'set_all_line_styles',
          summary: `${style || ''}${width != null ? ` w=${width}` : ''} applied to all charts`,
          style, width, allTabs: true,
        }
      }

      // ── set_graph_type ──────────────────────────────────────────────────────
      case 'set_graph_type': {
        const { type } = params
        const valid = ['line', 'area', 'bar', 'scatter']
        if (!valid.includes(type)) return { type: 'error', message: `type must be one of: ${valid.join(', ')}` }

        updateTabSpec(activeTabId, spec => spec ? { ...spec, type } : spec)
        return {
          type: 'design-update',
          tool: 'set_graph_type',
          summary: `Chart type → ${type}`,
          chartType: type,
        }
      }

      // ── set_threshold_colors ────────────────────────────────────────────────
      case 'set_threshold_colors': {
        const { thresholds } = params
        if (!Array.isArray(thresholds) || !thresholds.length) {
          return { type: 'error', message: '"thresholds" must be a non-empty array' }
        }
        updateTabSpec(activeTabId, spec => spec ? { ...spec, thresholds } : spec)
        return {
          type: 'design-update',
          tool: 'set_threshold_colors',
          summary: `${thresholds.length} threshold zone${thresholds.length !== 1 ? 's' : ''} applied`,
          thresholds,
        }
      }

      // ── set_graph_title ─────────────────────────────────────────────────────
      case 'set_graph_title': {
        const { title } = params
        if (!title) return { type: 'error', message: '"title" is required' }
        updateTabSpec(activeTabId, spec => spec ? { ...spec, title } : spec)
        // Also update the tab label
        const { setTabLabel } = deps
        if (setTabLabel) setTabLabel(activeTabId, title)
        return {
          type: 'design-update',
          tool: 'set_graph_title',
          summary: `Title → "${title}"`,
        }
      }

      // ── apply_style_preset ──────────────────────────────────────────────────
      case 'apply_style_preset': {
        const { preset, target = 'current' } = params
        const p = STYLE_PRESETS[preset]
        if (!p) {
          const available = Object.keys(STYLE_PRESETS).join(', ')
          return { type: 'error', message: `Unknown preset "${preset}". Available: ${available}` }
        }

        const applyPreset = spec => {
          if (!spec) return spec
          const series = (spec.series || []).map((s, i) => ({
            ...s,
            color: p.colors[i % p.colors.length],
            dashArray: '0', // reset to solid
          }))
          return {
            ...spec,
            series,
            lineWidth: p.lineWidth,
            showGrid: p.showGrid,
            ...(p.type ? { type: p.type } : {}),
          }
        }

        if (target === 'all') {
          const { setAllTabs } = deps
          if (!setAllTabs) return { type: 'error', message: 'setAllTabs dep missing' }
          setAllTabs(applyPreset)
        } else {
          updateTabSpec(activeTabId, applyPreset)
        }

        return {
          type: 'design-update',
          tool: 'apply_style_preset',
          summary: `"${preset}" applied${target === 'all' ? ' to all charts' : ''}`,
          preset, target,
          presetDescription: p.description,
        }
      }

      // ── style_all_graphs ────────────────────────────────────────────────────
      case 'style_all_graphs': {
        const { type: chartType, lineWidth, showGrid, colors } = params
        const { setAllTabs } = deps
        if (!setAllTabs) return { type: 'error', message: 'setAllTabs dep missing' }

        setAllTabs(spec => {
          if (!spec) return spec
          const series = colors
            ? (spec.series || []).map((s, i) => ({ ...s, color: colors[i % colors.length] }))
            : spec.series
          return {
            ...spec,
            series,
            ...(chartType  != null ? { type: chartType }   : {}),
            ...(lineWidth  != null ? { lineWidth }          : {}),
            ...(showGrid   != null ? { showGrid }           : {}),
          }
        })

        const changes = [
          chartType  && `type → ${chartType}`,
          lineWidth  && `width → ${lineWidth}`,
          showGrid   != null && `grid → ${showGrid}`,
          colors     && `${colors.length} colors`,
        ].filter(Boolean).join(', ')

        return {
          type: 'design-update',
          tool: 'style_all_graphs',
          summary: `All charts: ${changes}`,
          allTabs: true,
        }
      }

      // ══════════════════════════════════════════════════════════════════════
      // PHASE 3 — OVERLAY TOOLS
      // These tools add/remove analytical overlay layers from spec.overlays[].
      // Each overlay has a unique id generated at add-time for targeted removal.
      // ══════════════════════════════════════════════════════════════════════

      // ── add_annotation ──────────────────────────────────────────────────────
      case 'add_annotation': {
        const { time, label, color = '#06b6d4', position = 'insideTop' } = params
        if (!time)  return { type: 'error', message: '"time" is required' }
        if (!label) return { type: 'error', message: '"label" is required' }

        const id = `ann_${Date.now()}`
        updateTabSpec(activeTabId, spec => {
          if (!spec) return spec
          const overlays = [...(spec.overlays || []), { id, type: 'annotation', time, label, color, position }]
          return { ...spec, overlays }
        })
        return {
          type: 'overlay-added',
          overlayType: 'annotation',
          id, time, label, color,
          summary: `Annotation "${label}" at ${time}`,
        }
      }

      // ── add_moving_average ──────────────────────────────────────────────────
      case 'add_moving_average': {
        const { period, color = '#f59e0b', label } = params
        if (!period || period < 2) return { type: 'error', message: '"period" must be ≥ 2' }

        const id = `ma_${period}_${Date.now()}`
        const resolvedLabel = label || `MA(${period})`
        updateTabSpec(activeTabId, spec => {
          if (!spec) return spec
          // Remove any existing MA with same period first
          const existing = (spec.overlays || []).filter(ov =>
            !(ov.type === 'movingAverage' && ov.period === period)
          )
          const overlays = [...existing, { id, type: 'movingAverage', period, color, label: resolvedLabel }]
          return { ...spec, overlays }
        })
        return {
          type: 'overlay-added',
          overlayType: 'movingAverage',
          id, period, color,
          summary: `${resolvedLabel} overlay added`,
        }
      }

      // ── add_threshold_line ──────────────────────────────────────────────────
      case 'add_threshold_line': {
        const { value, label, color = '#ef4444', style = 'dashed' } = params
        if (value == null) return { type: 'error', message: '"value" is required' }
        if (!label)        return { type: 'error', message: '"label" is required' }

        const STYLE_TO_DASH = { solid: undefined, dashed: '6 3', dotted: '2 3' }
        const id = `thl_${Date.now()}`
        updateTabSpec(activeTabId, spec => {
          if (!spec) return spec
          const overlays = [...(spec.overlays || []), {
            id, type: 'thresholdLine',
            value, label, color,
            strokeDasharray: STYLE_TO_DASH[style],
          }]
          return { ...spec, overlays }
        })
        return {
          type: 'overlay-added',
          overlayType: 'thresholdLine',
          id, value, label, color, style,
          summary: `Threshold "${label}" at y=${value}`,
        }
      }

      // ── add_trend_line ──────────────────────────────────────────────────────
      case 'add_trend_line': {
        const { series_name, series_index, color = '#10b981', label = 'Trend' } = params

        const id = `trend_${Date.now()}`
        updateTabSpec(activeTabId, spec => {
          if (!spec) return spec
          // Find the target series key
          const series = spec.series || []
          const target = series_index != null
            ? series[series_index]
            : series_name
              ? series.find(s => s.name === series_name || s.label === series_name)
              : series[0]

          if (!target) return spec

          const overlays = [...(spec.overlays || []), {
            id, type: 'trendLine',
            seriesName: target.name,
            color, label,
          }]
          return { ...spec, overlays }
        })
        return {
          type: 'overlay-added',
          overlayType: 'trendLine',
          id, color,
          summary: `Trend line (${label}) added`,
        }
      }

      // ── add_time_grid ────────────────────────────────────────────────────────
      case 'add_time_grid': {
        const { interval, color = '#64748b', label = '' } = params
        if (!interval || interval < 1) return { type: 'error', message: '"interval" must be ≥ 1' }

        const id = `tg_${Date.now()}`
        updateTabSpec(activeTabId, spec => {
          if (!spec) return spec
          // Replace any existing time grid (only one per chart makes sense)
          const existing = (spec.overlays || []).filter(ov => ov.type !== 'timeGrid')
          const overlays = [...existing, { id, type: 'timeGrid', interval, color, showLabel: label === 'time' || label === 'index' }]
          return { ...spec, overlays }
        })
        return {
          type: 'overlay-added',
          overlayType: 'timeGrid',
          id, interval, color,
          summary: `Time grid every ${interval} points`,
        }
      }

      // ── remove_overlay ───────────────────────────────────────────────────────
      case 'remove_overlay': {
        const { type: ovType, id: ovId, all: applyToAll } = params

        // Filter function — returns the new overlays array and count removed
        const filterOverlays = (spec) => {
          if (!spec) return { spec, removed: 0 }
          const before = spec.overlays || []
          let after
          if (!ovType && !ovId) {
            after = []
          } else if (ovId) {
            after = before.filter(ov => ov.id !== ovId)
          } else {
            // Remove ALL overlays matching the type (not just first)
            after = before.filter(ov => ov.type !== ovType)
          }
          return { spec: { ...spec, overlays: after }, removed: before.length - after.length }
        }

        const { setAllTabs } = deps
        let removed = 0
        if (applyToAll) {
          // Apply to every chart on every tab
          if (!setAllTabs) return { type: 'error', message: 'setAllTabs dep missing' }
          setAllTabs(spec => {
            const { spec: next, removed: r } = filterOverlays(spec)
            removed += r
            return next
          })
        } else {
          updateTabSpec(activeTabId, spec => {
            const { spec: next, removed: r } = filterOverlays(spec)
            removed += r
            return next
          })
        }

        return {
          type: 'overlay-removed',
          removed,
          summary: removed > 0
            ? `Removed ${removed} overlay${removed !== 1 ? 's' : ''}${ovType ? ` (${ovType})` : ''}${applyToAll ? ' from all charts' : ''}`
            : 'No matching overlay found',
        }
      }

      default:
        return { type: 'error', message: `Unknown tool: "${name}"` }
    }
  } catch (err) {
    return { type: 'error', message: `${name} failed: ${err.message}` }
  }
}
