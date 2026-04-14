import { useState, useEffect, useCallback } from 'react'
import { useTheme } from '../context/ThemeContext'
import { getAlertEvents, clearAlertEvents } from '../api'
import ProGate from '../components/ProGate'
import { useLicense } from '../context/LicenseContext'
import { Bell, RefreshCw, Trash2, AlertTriangle, Activity, TrendingUp, Zap, Clock } from 'lucide-react'

// ─── Severity config ───────────────────────────────────────────────────────────

const SEV = {
  CRITICAL: { color: '#f87171', bg: '#f8717118', border: '#f8717133' },
  HIGH:     { color: '#fb923c', bg: '#fb923c18', border: '#fb923c33' },
  MEDIUM:   { color: T.amber,   bg: `${T.amber}18`, border: `${T.amber}33` },
  LOW:      { color: T.textSec, bg: '#1e1e3a',       border: '#2a2a4a' },
}

const COND_LABEL = {
  threshold_above:  'Threshold ↑',
  threshold_below:  'Threshold ↓',
  rmse_above:       'RMSE',
  pct_change:       '% Change',
  forecast_breach:  'Forecast',
  regime_change:    'Regime Shift',
  anomaly:          'Anomaly',
}

function severityCfg(sev) {
  return SEV[sev] || SEV.LOW
}

function relativeTime(iso) {
  const d = new Date(iso)
  const diff = Math.floor((Date.now() - d.getTime()) / 1000)
  if (diff < 60)  return `${diff}s ago`
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`
  return d.toLocaleDateString()
}

// ─── Single event row ──────────────────────────────────────────────────────────

function EventRow({ ev }) {
  const { T } = useTheme()
  const s = severityCfg(ev.severity)
  return (
    <div style={{
      display: 'grid',
      gridTemplateColumns: '90px 1fr 120px 110px 130px',
      alignItems: 'center',
      gap: 12,
      padding: '11px 18px',
      borderBottom: `1px solid ${T.border}`,
      transition: 'background 0.1s',
    }}
      onMouseEnter={e => e.currentTarget.style.background = '#0d0d1e'}
      onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
    >
      {/* Severity badge */}
      <span style={{
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        fontSize: 9, fontWeight: 800, letterSpacing: '0.07em',
        padding: '3px 8px', borderRadius: 6,
        background: s.bg, border: `1px solid ${s.border}`, color: s.color,
      }}>
        {ev.severity}
      </span>

      {/* Message */}
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: T.textPri, marginBottom: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {ev.rule_name || ev.rule_id}
        </div>
        <div style={{ fontSize: 11, color: T.textMut, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {ev.message}
        </div>
      </div>

      {/* Metric */}
      <div style={{ fontSize: 11, color: T.cyan, fontFamily: T.mono, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {ev.metric}
      </div>

      {/* Condition */}
      <span style={{
        fontSize: 10, fontWeight: 700, color: T.textMut,
        background: '#13132a', border: `1px solid ${T.border}`,
        borderRadius: 5, padding: '2px 7px',
        display: 'inline-block',
      }}>
        {COND_LABEL[ev.condition] || ev.condition}
      </span>

      {/* Time */}
      <div style={{ fontSize: 11, color: T.textMut, textAlign: 'right', fontFamily: T.mono }}>
        {relativeTime(ev.fired_at)}
      </div>
    </div>
  )
}

// ─── Stats strip ──────────────────────────────────────────────────────────────

function StatsStrip({ events }) {
  const { T } = useTheme()
  const bySev = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 }
  events.forEach(ev => { if (bySev[ev.severity] != null) bySev[ev.severity]++ })

  return (
    <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 20 }}>
      {Object.entries(bySev).map(([sev, count]) => {
        const s = severityCfg(sev)
        return (
          <div key={sev} style={{
            flex: '1 1 100px',
            background: T.bgCard, borderRadius: 10, padding: '12px 16px',
            border: `1px solid ${count > 0 ? s.border : T.border}`,
            display: 'flex', flexDirection: 'column', gap: 4,
          }}>
            <div style={{ fontSize: 9, fontWeight: 800, letterSpacing: '0.08em', color: count > 0 ? s.color : T.textMut }}>
              {sev}
            </div>
            <div style={{ fontSize: 22, fontWeight: 700, color: count > 0 ? s.color : T.textMut, fontFamily: T.mono }}>
              {count}
            </div>
          </div>
        )
      })}
      <div style={{
        flex: '1 1 100px',
        background: T.bgCard, borderRadius: 10, padding: '12px 16px',
        border: `1px solid ${T.border}`,
        display: 'flex', flexDirection: 'column', gap: 4,
      }}>
        <div style={{ fontSize: 9, fontWeight: 800, letterSpacing: '0.08em', color: T.textMut }}>TOTAL</div>
        <div style={{ fontSize: 22, fontWeight: 700, color: T.textPri, fontFamily: T.mono }}>{events.length}</div>
      </div>
    </div>
  )
}

// ─── Main content ──────────────────────────────────────────────────────────────

function AlertEventsContent() {
  const { T } = useTheme()
  const [events, setEvents]     = useState([])
  const [loading, setLoading]   = useState(false)
  const [clearing, setClearing] = useState(false)
  const [lastRefresh, setLastRefresh] = useState(null)
  const [filter, setFilter]     = useState('ALL')

  const load = useCallback(async () => {
    setLoading(true)
    const evs = await getAlertEvents()
    setEvents(evs || [])
    setLastRefresh(new Date())
    setLoading(false)
  }, [])

  useEffect(() => {
    load()
    const t = setInterval(load, 30_000)  // auto-refresh every 30s
    return () => clearInterval(t)
  }, [load])

  const handleClear = async () => {
    setClearing(true)
    await clearAlertEvents()
    setEvents([])
    setClearing(false)
  }

  const severities = ['ALL', 'CRITICAL', 'HIGH', 'MEDIUM', 'LOW']
  const visible = filter === 'ALL' ? events : events.filter(e => e.severity === filter)

  return (
    <div style={{ padding: '24px 28px', overflowY: 'auto', flex: 1, width: '100%', boxSizing: 'border-box' }}>

      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', marginBottom: 24 }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
            <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700, color: T.textPri }}>Alert Events</h1>
            <span style={{
              fontSize: 10, fontWeight: 700, color: T.amber,
              background: `${T.amber}18`, border: `1px solid ${T.amber}33`,
              borderRadius: 20, padding: '3px 10px',
              display: 'inline-flex', alignItems: 'center', gap: 4,
            }}>
              <Zap size={10} /> PRO
            </span>
          </div>
          <p style={{ margin: 0, fontSize: 12.5, color: T.textMut }}>
            Fired alert history — last 500 events, newest first.
            {lastRefresh && <span> · refreshed {lastRefresh.toLocaleTimeString()}</span>}
          </p>
        </div>

        <div style={{ display: 'flex', gap: 8 }}>
          <button
            onClick={load}
            disabled={loading}
            style={{
              display: 'flex', alignItems: 'center', gap: 6,
              padding: '8px 14px', borderRadius: 8,
              border: `1px solid ${T.border}`,
              background: T.bgCard, color: T.textSec, fontSize: 12, cursor: 'pointer',
            }}
          >
            <RefreshCw size={12} style={{ animation: loading ? 'spin 1s linear infinite' : 'none' }} />
            Refresh
          </button>
          <button
            onClick={handleClear}
            disabled={clearing || events.length === 0}
            style={{
              display: 'flex', alignItems: 'center', gap: 6,
              padding: '8px 14px', borderRadius: 8,
              border: `1px solid #ef444433`,
              background: '#1a0a0a', color: '#f87171',
              fontSize: 12, cursor: events.length === 0 ? 'not-allowed' : 'pointer',
              opacity: events.length === 0 ? 0.5 : 1,
            }}
          >
            <Trash2 size={12} />
            {clearing ? 'Clearing…' : 'Clear All'}
          </button>
        </div>
      </div>

      {/* Stats strip */}
      <StatsStrip events={events} />

      {/* Severity filter tabs */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 14, flexWrap: 'wrap' }}>
        {severities.map(sev => {
          const active = filter === sev
          const s = sev === 'ALL' ? null : severityCfg(sev)
          return (
            <button
              key={sev}
              onClick={() => setFilter(sev)}
              style={{
                padding: '5px 14px', borderRadius: 20, fontSize: 11, fontWeight: 700,
                cursor: 'pointer',
                background: active ? (s ? s.bg : `${T.cyan}18`) : T.bgCard,
                border: `1px solid ${active ? (s ? s.border : `${T.cyan}44`) : T.border}`,
                color: active ? (s ? s.color : T.cyan) : T.textMut,
              }}
            >
              {sev}
              {sev !== 'ALL' && (
                <span style={{ marginLeft: 5, opacity: 0.7 }}>
                  ({events.filter(e => e.severity === sev).length})
                </span>
              )}
            </button>
          )
        })}
      </div>

      {/* Event table */}
      <div style={{
        background: T.bgCard, borderRadius: 12,
        border: `1px solid ${T.border}`,
        overflow: 'hidden',
      }}>
        {/* Column headers */}
        <div style={{
          display: 'grid',
          gridTemplateColumns: '90px 1fr 120px 110px 130px',
          gap: 12,
          padding: '9px 18px',
          background: '#0d0d1e',
          borderBottom: `1px solid ${T.border}`,
        }}>
          {['SEVERITY', 'RULE / MESSAGE', 'METRIC', 'CONDITION', 'TIME'].map(col => (
            <div key={col} style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.08em', color: T.textMut }}>
              {col}
            </div>
          ))}
        </div>

        {visible.length === 0 ? (
          <div style={{ padding: '48px 24px', textAlign: 'center' }}>
            <Bell size={28} color={T.textMut} style={{ opacity: 0.3, marginBottom: 12 }} />
            <div style={{ fontSize: 13, color: T.textMut }}>
              {events.length === 0
                ? 'No alert events yet. Rules will fire once conditions are met.'
                : `No ${filter} events.`}
            </div>
          </div>
        ) : (
          visible.map(ev => <EventRow key={ev.id} ev={ev} />)
        )}
      </div>

      <style>{`@keyframes spin { 100% { transform: rotate(360deg) } }`}</style>
    </div>
  )
}

// ─── Page export (Pro-gated) ───────────────────────────────────────────────────

export default function AlertEvents() {
  const { isProActive } = useLicense()
  if (!isProActive) return <ProGate feature="Alert Events" />
  return <AlertEventsContent />
}
