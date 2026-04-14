import { useState, useEffect } from 'react'
import { useTheme } from '../context/ThemeContext'
import { fetchSystemMetrics, fetchLiveConfig, fetchPatterns } from '../api'
import {
  RefreshCw, Activity, Database,
  Bot, Zap, Server,
  Clock, HardDrive, MemoryStick, Layers, AlertTriangle,
} from 'lucide-react'

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmt(n, decimals = 0) {
  if (n == null) return '—'
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M'
  if (n >= 1_000)     return (n / 1_000).toFixed(1) + 'K'
  return typeof n === 'number' ? n.toFixed(decimals) : n
}

function bytes(n) {
  if (n == null) return '—'
  if (n >= 1_073_741_824) return (n / 1_073_741_824).toFixed(2) + ' GB'
  if (n >= 1_048_576)     return (n / 1_048_576).toFixed(2) + ' MB'
  if (n >= 1_024)         return (n / 1_024).toFixed(1) + ' KB'
  return n + ' B'
}

// ─── Status badge ─────────────────────────────────────────────────────────────

const STATUS = {
  online:     { label: 'Online',     color: T.green  },
  offline:    { label: 'Offline',    color: T.red    },
  configured: { label: 'Configured', color: T.textSec },
  external:   { label: 'External',   color: T.cyan   },
  checking:   { label: 'Checking…',  color: T.textMut },
}

function StatusBadge({ status }) {
  const { T } = useTheme()
  const s = STATUS[status] || STATUS.configured
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 5,
      fontSize: 10, fontWeight: 700, padding: '2px 9px', borderRadius: 10,
      background: `${s.color}18`, border: `1px solid ${s.color}44`, color: s.color,
    }}>
      <span style={{
        width: 5, height: 5, borderRadius: '50%', background: s.color,
        boxShadow: status === 'online' ? `0 0 6px ${s.color}` : 'none',
      }} />
      {s.label}
    </span>
  )
}

// ─── Single metric row ─────────────────────────────────────────────────────────

function MetricRow({ label, value, color, sub }) {
  const { T } = useTheme()
  return (
    <div style={{
      display: 'flex', alignItems: 'baseline', justifyContent: 'space-between',
      padding: '5px 0', borderBottom: `1px solid #1e1e3a`,
    }}>
      <span style={{ fontSize: 11, color: T.textMut }}>{label}</span>
      <span style={{ fontSize: 12, fontWeight: 700, color: color || T.textPri, fontFamily: T.mono }}>
        {value}
        {sub && <span style={{ fontSize: 10, fontWeight: 400, color: T.textMut, marginLeft: 4 }}>{sub}</span>}
      </span>
    </div>
  )
}

// ─── Component card ───────────────────────────────────────────────────────────

function ComponentCard({ icon: Icon, iconColor, title, addr, status, description, metrics = [] }) {
  const { T } = useTheme()
  return (
    <div style={{
      background: T.bgCard, borderRadius: 14, padding: '18px 20px',
      border: `1px solid ${iconColor}22`,
      boxShadow: `0 0 20px ${iconColor}0a`,
      display: 'flex', flexDirection: 'column', gap: 14,
    }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{
            width: 36, height: 36, borderRadius: 10, flexShrink: 0,
            background: `${iconColor}18`, border: `1px solid ${iconColor}33`,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            <Icon size={16} color={iconColor} />
          </div>
          <div>
            <div style={{ fontSize: 14, fontWeight: 700, color: T.textPri }}>{title}</div>
            {addr && (
              <div style={{ fontSize: 10, color: T.textMut, fontFamily: T.mono, marginTop: 1 }}>{addr}</div>
            )}
          </div>
        </div>
        <StatusBadge status={status} />
      </div>

      {/* Description */}
      <div style={{ fontSize: 11, color: T.textSec, lineHeight: 1.5 }}>{description}</div>

      {/* Metrics */}
      {metrics.length > 0 && (
        <div style={{ marginTop: -4 }}>
          {metrics.map((m, i) => (
            <MetricRow key={i} {...m} />
          ))}
        </div>
      )}
    </div>
  )
}

// ─── Performance strip ────────────────────────────────────────────────────────

function PerfStat({ label, value, color, icon: Icon }) {
  const { T } = useTheme()
  return (
    <div style={{
      flex: '1 1 140px', background: T.bgCard, borderRadius: 10, padding: '13px 16px',
      border: `1px solid ${T.border}`, display: 'flex', flexDirection: 'column', gap: 4,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        {Icon && <Icon size={11} color={color || T.textMut} />}
        <span style={{ fontSize: 10, color: T.textMut, fontWeight: 700, letterSpacing: '0.06em' }}>
          {label.toUpperCase()}
        </span>
      </div>
      <div style={{ fontSize: 20, fontWeight: 700, color: color || T.textPri, fontFamily: T.mono }}>
        {value}
      </div>
    </div>
  )
}


// ─── Main page ────────────────────────────────────────────────────────────────

export default function Instance() {
  const { T } = useTheme()
  const [metrics, setMetrics]   = useState(null)
  const [config, setConfig]     = useState(null)
  const [patterns, setPatterns] = useState(null)
  const [ingestorUp, setIngestorUp] = useState('checking')
  const [queryUp, setQueryUp]   = useState('checking')
  const [loading, setLoading]   = useState(false)
  const [lastRefresh, setLastRefresh] = useState(null)

  const load = async () => {
    setLoading(true)
    setIngestorUp('checking')
    setQueryUp('checking')

    const [m, cfg, pats] = await Promise.all([
      fetchSystemMetrics(),
      fetchLiveConfig(),
      fetchPatterns(),
    ])

    setMetrics(m)
    setConfig(cfg)
    setPatterns(pats)
    setIngestorUp(m ? 'online' : 'offline')

    // Probe query gateway separately
    try {
      const r = await fetch('/qgw/api/v1/labels', { signal: AbortSignal.timeout(3000) })
      setQueryUp(r.ok ? 'online' : 'offline')
    } catch {
      setQueryUp('offline')
    }

    setLastRefresh(new Date())
    setLoading(false)
  }

  useEffect(() => { load() }, [])

  // ── Derived values ──────────────────────────────────────────────────────────
  const cfg = config || {}
  const srv = cfg.server || {}
  const m   = metrics || {}

  const ingestPort  = srv.ingest_port  || 8080
  const queryPort   = srv.query_port   || 8081
  const vectorPort  = srv.vector_port  || 8085
  const deduperPort = srv.deduper_port || 8084

  const compressionRatio = m.total_canonical_bytes && m.total_shipped_bytes
    ? (m.total_shipped_bytes / m.total_canonical_bytes).toFixed(1)
    : null

  const walColor = m.wal_queue_depth > 500 ? T.red : m.wal_queue_depth > 100 ? T.amber : T.green

  const patternCount = patterns?.patterns?.length ?? 0

  // ── Component definitions ───────────────────────────────────────────────────
  const components = [
    {
      icon: Server,
      iconColor: T.cyan,
      title: 'Core Ingestor',
      addr: `localhost:${ingestPort}`,
      status: ingestorUp,
      description: 'Receives time-series samples, compresses them via polynomial model fitting, detects anomalies, and maintains the WAL write queue.',
      metrics: [
        { label: 'Active Series',     value: fmt(m.unique_series_active),     color: T.cyan   },
        { label: 'Samples Ingested',  value: fmt(m.total_samples_ingested),   color: T.textPri },
        { label: 'Chunks Modeled',    value: fmt(m.total_chunks_modeled),     color: T.textPri },
        { label: 'WAL Queue Depth',   value: m.wal_queue_depth ?? '—',        color: walColor  },
        { label: 'Compression Slots', value: m.compression_slots_free != null ? `${m.compression_slots_free} free` : '—', color: T.textPri },
        { label: 'Avg RMSE',          value: m.avg_rmse?.toFixed(4) ?? '—',   color: T.textPri },
      ],
    },
    {
      icon: Database,
      iconColor: T.purple,
      title: 'Query Gateway',
      addr: `localhost:${queryPort}`,
      status: queryUp,
      description: 'Serves a Prometheus-compatible PromQL API. Merges head cache (hot) + LTS disk blocks (cold) on every query with LRU block caching.',
      metrics: [
        { label: 'Head Cache Entries',  value: fmt(m.head_cache_size),          color: T.purple  },
        { label: 'LTS Index Entries',   value: fmt(m.lts_index_size_entries),   color: T.textPri },
        { label: 'Symbols Registered',  value: fmt(m.total_symbols_registered), color: T.textPri },
        { label: 'Index Queue Size',    value: m.index_queue_size ?? '—',       color: T.textPri },
        { label: 'Head Memory',         value: bytes(m.head_cache_memory_bytes), color: T.textPri },
        { label: 'Symbol Metadata',     value: bytes(m.symbol_metadata_size_bytes), color: T.textPri },
      ],
    },
    {
      icon: Layers,
      iconColor: T.amber,
      title: 'Vector Store',
      addr: `localhost:${vectorPort}`,
      status: 'configured',
      description: 'In-memory 8-dimensional vector database. Stores behavioral fingerprints per metric for cosine-similarity pattern matching and historical incident search.',
      metrics: [
        { label: 'Registered Patterns', value: patternCount,                  color: T.amber   },
        { label: 'Vector Dimensions',   value: '8D',                          color: T.textPri },
        { label: 'Cosine Threshold',    value: '≥ 92%',                       color: T.textPri },
        { label: 'Ingest Endpoint',     value: srv.vector_db_endpoint || `http://localhost:${vectorPort}/ingest`, color: T.textMut },
      ],
    },
    {
      icon: HardDrive,
      iconColor: T.green,
      title: 'Deduper / S3 Shipper',
      addr: `localhost:${deduperPort}`,
      status: 'configured',
      description: 'Receives canonical blocks from the ingestor, deduplicates them, and optionally ships to S3 for long-term storage. Runs a periodic retention sweep.',
      metrics: [
        { label: 'Shipped to LTS',     value: bytes(m.total_shipped_bytes),    color: T.green   },
        { label: 'Canonical Bytes',    value: bytes(m.total_canonical_bytes),  color: T.textPri },
        { label: 'Compression Gain',   value: compressionRatio ? compressionRatio + 'x' : '—', color: T.green },
        { label: 'Ingest Endpoint',    value: srv.deduper_endpoint || `http://localhost:${deduperPort}/ingest_block`, color: T.textMut },
      ],
    },
    {
      icon: Bot,
      iconColor: T.purpleL,
      title: 'MCP Server',
      addr: 'tsdb_mcp_server.py',
      status: 'external',
      description: 'Python FastMCP server exposing TSDB tools to Claude and compatible AI agents via Server-Sent Events (SSE) transport.',
      metrics: [
        { label: 'Transport',          value: 'SSE',                 color: T.purpleL },
        { label: 'Tool Count',         value: '17 tools',            color: T.textPri },
        { label: 'Ingestor Target',    value: `http://localhost:${ingestPort}`, color: T.textMut },
        { label: 'Query GW Target',    value: `http://localhost:${queryPort}`,  color: T.textMut },
        { label: 'Vector DB Target',   value: `http://localhost:${vectorPort}`, color: T.textMut },
      ],
    },
  ]

  // ── Performance stats ───────────────────────────────────────────────────────
  const perfStats = [
    { label: 'Compression',    value: compressionRatio ? compressionRatio + 'x' : '—', color: T.green,  icon: Zap        },
    { label: 'Avg RMSE',       value: m.avg_rmse?.toFixed(4) ?? '—',                   color: T.textPri, icon: Activity   },
    { label: 'WAL Depth',      value: m.wal_queue_depth ?? '—',                         color: walColor,  icon: Clock      },
    { label: 'Head Memory',    value: bytes(m.head_cache_memory_bytes),                 color: T.textPri, icon: MemoryStick },
    { label: 'LTS Entries',    value: fmt(m.lts_index_size_entries),                    color: T.textPri, icon: HardDrive  },
    { label: 'Active Anomalies', value: m.active_anomalies_count ?? '—', color: m.active_anomalies_count > 0 ? T.red : T.green, icon: AlertTriangle },
  ]

  return (
    <div style={{ padding: '24px 28px', overflowY: 'auto', flex: 1, width: '100%', boxSizing: 'border-box' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', marginBottom: 28 }}>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 700, color: T.textPri }}>Instance Overview</h1>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4 }}>
            <p style={{ fontSize: 13, color: T.textMut, margin: 0 }}>
              Core service components and their runtime metrics
            </p>
            {lastRefresh && (
              <span style={{ fontSize: 11, color: T.textMut }}>
                · refreshed {lastRefresh.toLocaleTimeString()}
              </span>
            )}
          </div>
        </div>
        <button
          onClick={load}
          disabled={loading}
          style={{
            display: 'flex', alignItems: 'center', gap: 7,
            padding: '8px 16px', borderRadius: 8, border: `1px solid #28284a`,
            background: T.bgCard, color: T.textSec, fontSize: 13, cursor: 'pointer',
          }}
        >
          <RefreshCw size={13} style={{ animation: loading ? 'spin 1s linear infinite' : 'none' }} />
          Refresh
        </button>
      </div>

      {/* Component grid */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))',
        gap: 16,
        marginBottom: 28,
      }}>
        {components.map(c => (
          <ComponentCard key={c.title} {...c} />
        ))}
      </div>

      {/* Performance strip */}
      <div style={{
        background: T.bgCard, borderRadius: 14, padding: '18px 20px',
        border: `1px solid ${T.border}`, marginBottom: 8,
      }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: T.textMut, letterSpacing: '0.08em', marginBottom: 14 }}>
          PERFORMANCE SNAPSHOT
        </div>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          {perfStats.map(s => (
            <PerfStat key={s.label} {...s} />
          ))}
        </div>
      </div>

      <style>{`@keyframes spin { 100% { transform: rotate(360deg) } }`}</style>
    </div>
  )
}
