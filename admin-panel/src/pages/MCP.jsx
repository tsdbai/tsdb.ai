import { useTheme } from '../context/ThemeContext'
import { Bot, Search, Activity, GitBranch, TrendingUp, Wrench } from 'lucide-react'

// ─── Category config ───────────────────────────────────────────────────────────

const CATEGORIES = {
  discovery:  { label: 'Discovery',   color: T.cyan,    icon: Search     },
  analysis:   { label: 'Analysis',    color: T.purple,  icon: Activity   },
  rootcause:  { label: 'Root Cause',  color: '#f87171', icon: GitBranch  },
  prediction: { label: 'Prediction',  color: T.amber,   icon: TrendingUp },
  config:     { label: 'Config',      color: T.green,   icon: Wrench     },
}

// ─── Tool definitions ──────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: 'summarize_system_state',
    label: 'Summarize System State',
    category: 'discovery',
    params: ['service_filter?'],
    description: 'High-level semantic summary of the entire system — active anomalies, regime changes, and behavioral patterns across all metrics.',
  },
  {
    name: 'list_active_anomalies',
    label: 'List Active Anomalies',
    category: 'discovery',
    params: ['lookback_minutes?', 'min_severity?'],
    description: 'Returns all anomalies detected in the last N minutes, ranked by severity with metric names and RMSE scores.',
  },
  {
    name: 'list_known_patterns',
    label: 'List Known Patterns',
    category: 'discovery',
    params: [],
    description: 'Lists all named behavioral patterns registered in the pattern registry, ordered by occurrence frequency.',
  },
  {
    name: 'what_changed_recently',
    label: 'What Changed Recently',
    category: 'discovery',
    params: ['lookback_minutes?'],
    description: 'Identifies metrics that recently underwent a behavioral regime shift — useful for spotting the moment a deployment changed something.',
  },
  {
    name: 'explain_metric',
    label: 'Explain Metric',
    category: 'analysis',
    params: ['metric_name'],
    description: 'Plain-English explanation of what a metric is currently doing, its recent trend, whether it is anomalous, and what pattern it matches.',
  },
  {
    name: 'correlate_service_metrics',
    label: 'Correlate Service Metrics',
    category: 'analysis',
    params: ['target_metric'],
    description: 'Finds other metrics behaving identically to the target right now using cosine similarity across behavioral vectors.',
  },
  {
    name: 'find_historical_incidents',
    label: 'Find Historical Incidents',
    category: 'analysis',
    params: ['metric_name'],
    description: 'Checks if the current behavior of a metric matches any historical incidents stored in the vector database.',
  },
  {
    name: 'hunt_outliers',
    label: 'Hunt Outliers',
    category: 'analysis',
    params: ['metric_pattern'],
    description: 'Needle-in-a-haystack anomaly detection across a group of related metrics using behavioral clustering.',
  },
  {
    name: 'cluster_metrics',
    label: 'Cluster Metrics',
    category: 'analysis',
    params: ['service_filter?', 'n_clusters?'],
    description: 'Groups all matching metrics by behavioral similarity via K-Means — surfaces which services are moving together.',
  },
  {
    name: 'find_root_cause',
    label: 'Find Root Cause',
    category: 'rootcause',
    params: ['affected_metric', 'lookback_minutes?'],
    description: 'Identifies which upstream metrics likely caused a problem in the target by walking the causal graph with lag-correlation analysis.',
  },
  {
    name: 'detect_regressions',
    label: 'Detect Regressions',
    category: 'rootcause',
    params: ['service_filter', 'lookback_minutes?'],
    description: 'Compares current metric behavior vs N minutes ago to surface statistically significant performance regressions.',
  },
  {
    name: 'compare_deployments',
    label: 'Compare Deployments',
    category: 'rootcause',
    params: ['baseline_timestamp', 'service_filter?', 'window_minutes?'],
    description: 'Side-by-side behavioral comparison between a baseline deploy window and now — answers "did this deploy make things worse?"',
  },
  {
    name: 'predict_metric',
    label: 'Predict Metric',
    category: 'prediction',
    params: ['metric_name', 'horizon_seconds?'],
    description: 'Forecasts future values of a metric using its current polynomial model with upper/lower confidence bands.',
  },
  {
    name: 'get_service_health_score',
    label: 'Service Health Score',
    category: 'prediction',
    params: ['service_filter?'],
    description: 'Returns a 0–100 composite health score for a service by aggregating anomaly severity, RMSE, and regime stability.',
  },
  {
    name: 'suggest_alert_thresholds',
    label: 'Suggest Alert Thresholds',
    category: 'prediction',
    params: ['metric_name'],
    description: 'Analyzes historical "Normal" behavior to recommend alert thresholds calibrated to this metric\'s actual variance.',
  },
  {
    name: 'set_pattern_label',
    label: 'Set Pattern Label',
    category: 'config',
    params: ['metric_name', 'pattern_name', 'notes?'],
    description: 'Tags the current behavioral shape of a metric with a named pattern label, persisting it to the pattern registry.',
  },
  {
    name: 'natural_language_alert_config',
    label: 'Natural Language Alert Config',
    category: 'config',
    params: ['description'],
    description: 'Converts a plain-English alert description into a structured alert configuration (threshold, window, severity).',
  },
]

// ─── Tool card ─────────────────────────────────────────────────────────────────

function ToolCard({ tool }) {
  const { T } = useTheme()
  const cat = CATEGORIES[tool.category]
  const CatIcon = cat.icon
  return (
    <div
      style={{
        background: T.bgCard,
        borderRadius: 12,
        padding: '15px 16px',
        border: `1px solid ${cat.color}1e`,
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
        transition: 'border-color 0.15s, box-shadow 0.15s',
        cursor: 'default',
      }}
      onMouseEnter={e => {
        e.currentTarget.style.borderColor = `${cat.color}50`
        e.currentTarget.style.boxShadow = `0 0 18px ${cat.color}0d`
      }}
      onMouseLeave={e => {
        e.currentTarget.style.borderColor = `${cat.color}1e`
        e.currentTarget.style.boxShadow = 'none'
      }}
    >
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 9, minWidth: 0 }}>
          <div style={{
            width: 30, height: 30, borderRadius: 8, flexShrink: 0,
            background: `${cat.color}18`, border: `1px solid ${cat.color}30`,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            <CatIcon size={13} color={cat.color} />
          </div>
          <span style={{ fontSize: 12.5, fontWeight: 700, color: T.textPri, lineHeight: 1.3 }}>
            {tool.label}
          </span>
        </div>
        <span style={{
          flexShrink: 0,
          fontSize: 9, fontWeight: 700, letterSpacing: '0.06em',
          padding: '2px 7px', borderRadius: 6,
          background: `${cat.color}15`, border: `1px solid ${cat.color}30`, color: cat.color,
        }}>
          {cat.label.toUpperCase()}
        </span>
      </div>

      {/* Description */}
      <p style={{ margin: 0, fontSize: 11.5, color: T.textSec, lineHeight: 1.6 }}>
        {tool.description}
      </p>

      {/* Params */}
      {tool.params.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
          {tool.params.map(p => (
            <code key={p} style={{
              fontSize: 10, padding: '2px 7px', borderRadius: 4,
              background: '#0d0d1c', border: `1px solid #25254a`,
              color: p.endsWith('?') ? T.textMut : T.cyan,
              fontFamily: T.mono,
            }}>
              {p}
            </code>
          ))}
        </div>
      )}

      {/* Function name */}
      <div style={{ fontSize: 10, color: T.textMut, fontFamily: T.mono, opacity: 0.5, marginTop: -2 }}>
        {tool.name}()
      </div>
    </div>
  )
}

// ─── Page ──────────────────────────────────────────────────────────────────────

export default function MCP() {
  const { T } = useTheme()
  const byCat = Object.entries(CATEGORIES).map(([key, cat]) => ({
    key,
    cat,
    tools: TOOLS.filter(t => t.category === key),
  }))

  return (
    <div style={{ padding: '24px 28px', overflowY: 'auto', flex: 1, width: '100%', boxSizing: 'border-box' }}>

      {/* Page header */}
      <div style={{ marginBottom: 28 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 6 }}>
          <div style={{
            width: 36, height: 36, borderRadius: 10,
            background: `${T.purpleL}18`, border: `1px solid ${T.purpleL}33`,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            <Bot size={17} color={T.purpleL} />
          </div>
          <div>
            <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700, color: T.textPri }}>
              MCP Tools
            </h1>
            <p style={{ margin: 0, fontSize: 12.5, color: T.textMut, marginTop: 2 }}>
              {TOOLS.length} tools exposed to Claude via{' '}
              <code style={{ fontFamily: T.mono, fontSize: 11 }}>tsdb_mcp_server.py</code>
              {' '}· SSE transport · localhost:8888
            </p>
          </div>
        </div>

        {/* Category pill strip */}
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 14 }}>
          {byCat.map(({ key, cat, tools }) => {
            const CatIcon = cat.icon
            return (
              <div key={key} style={{
                display: 'inline-flex', alignItems: 'center', gap: 6,
                padding: '5px 12px', borderRadius: 20,
                background: `${cat.color}12`, border: `1px solid ${cat.color}30`,
                fontSize: 11, fontWeight: 600, color: cat.color,
              }}>
                <CatIcon size={11} color={cat.color} />
                {cat.label}
                <span style={{
                  background: `${cat.color}25`, borderRadius: 10,
                  padding: '0px 5px', fontSize: 10, fontWeight: 700,
                }}>
                  {tools.length}
                </span>
              </div>
            )
          })}
        </div>
      </div>

      {/* Sections per category */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 32 }}>
        {byCat.map(({ key, cat, tools }) => {
          const CatIcon = cat.icon
          return (
            <div key={key}>
              {/* Category heading */}
              <div style={{
                display: 'flex', alignItems: 'center', gap: 8,
                marginBottom: 14, paddingBottom: 10,
                borderBottom: `1px solid ${cat.color}20`,
              }}>
                <CatIcon size={13} color={cat.color} />
                <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.08em', color: cat.color }}>
                  {cat.label.toUpperCase()}
                </span>
                <span style={{ fontSize: 11, color: T.textMut }}>
                  — {tools.length} tool{tools.length !== 1 ? 's' : ''}
                </span>
              </div>

              {/* Cards grid */}
              <div style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fill, minmax(290px, 1fr))',
                gap: 12,
              }}>
                {tools.map(tool => <ToolCard key={tool.name} tool={tool} />)}
              </div>
            </div>
          )
        })}
      </div>

    </div>
  )
}
