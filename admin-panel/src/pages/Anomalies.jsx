import { useState, useEffect } from 'react'
import { useTheme } from '../context/ThemeContext'
import { fetchAnomalies, fetchRegimeChanges } from '../api'
import { AlertTriangle, Activity, Clock, RefreshCw } from 'lucide-react'

const MODEL = ['Constant', 'Linear', 'Quadratic']

function AnomalyCard({ a }) {
  const { T } = useTheme()
  const SEV_COLOR = { HIGH: T.red, MEDIUM: T.amber, LOW: T.textSec }
  const color = SEV_COLOR[a.severity] || T.textSec
  const modelName = MODEL[a.detected_model] || '?'
  const age = Math.floor((Date.now()/1000 - a.log_time) / 60)
  return (
    <div style={{
      background: T.bgCard, borderRadius: 12, padding: '16px 20px',
      border: `1px solid ${color}44`,
      boxShadow: `0 0 16px ${color}18`,
      marginBottom: 10,
    }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
            <AlertTriangle size={13} color={color} />
            <span style={{ fontSize: 13, color: T.textPri, fontFamily: T.mono, fontWeight: 600 }}>
              {a.metric_string}
            </span>
          </div>
          <div style={{ fontSize: 12, color: T.textSec, marginBottom: 6 }}>{a.reason}</div>
          <div style={{ display: 'flex', gap: 8 }}>
            <Tag label={`Model: ${modelName}`} color={T.cyan} />
            <Tag label={`RMSE: ${a.rmse.toFixed(2)}`} color={color} />
            <Tag label={`${age}m ago`} color={T.textMut} />
          </div>
        </div>
        <div style={{
          padding: '4px 10px', borderRadius: 20, fontSize: 11, fontWeight: 700,
          background: `${color}22`, border: `1px solid ${color}55`,
          color, letterSpacing: '0.07em', flexShrink: 0,
        }}>
          {a.severity}
        </div>
      </div>
    </div>
  )
}

function Tag({ label, color }) {
  const { T } = useTheme()
  return (
    <span style={{
      fontSize: 10, color, fontFamily: T.mono,
      background: `${color}18`, border: `1px solid ${color}33`,
      borderRadius: 4, padding: '2px 7px',
    }}>
      {label}
    </span>
  )
}

function RegimeCard({ r }) {
  const fromName = MODEL[r.from_model] || '?'
  const toName = MODEL[r.to_model] || '?'
  const severity = r.to_model > r.from_model ? T.amber : T.green
  const age = Math.floor((Date.now()/1000 - r.detected_at) / 60)
  return (
    <div style={{
      background: T.bgCard, borderRadius: 10, padding: '14px 18px',
      border: `1px solid ${T.border}`, marginBottom: 8,
      display: 'flex', alignItems: 'center', gap: 14,
    }}>
      <Activity size={14} color={severity} style={{ flexShrink: 0 }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 12, color: T.textPri, fontFamily: T.mono, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {r.metric_string}
        </div>
        <div style={{ fontSize: 11, color: T.textMut, marginTop: 3 }}>
          <span style={{ color: T.textSec }}>{fromName}</span>
          <span style={{ margin: '0 6px', color: T.textMut }}>→</span>
          <span style={{ color: severity, fontWeight: 600 }}>{toName}</span>
        </div>
      </div>
      <div style={{ fontSize: 11, color: T.textMut, display: 'flex', alignItems: 'center', gap: 4 }}>
        <Clock size={10} />
        {age < 60 ? `${age}m ago` : `${Math.floor(age/60)}h ago`}
      </div>
    </div>
  )
}

export default function Anomalies() {
  const { T } = useTheme()
  const [anomalies, setAnomalies] = useState([])
  const [regimes, setRegimes] = useState([])
  const [filter, setFilter] = useState('ALL')
  const [loading, setLoading] = useState(false)

  const load = async () => {
    setLoading(true)
    const [a, r] = await Promise.all([fetchAnomalies(), fetchRegimeChanges()])
    setAnomalies(a?.anomalies || [])
    setRegimes(r?.changes || [])
    setLoading(false)
  }

  useEffect(() => { load() }, [])

  const filtered = filter === 'ALL' ? anomalies : anomalies.filter(a => a.severity === filter)

  return (
    <div style={{ padding: '24px 28px', overflowY: 'auto', flex: 1, width: '100%', boxSizing: 'border-box' }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', marginBottom: 28 }}>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 700, color: T.textPri }}>Anomalies</h1>
          <p style={{ fontSize: 13, color: T.textMut, marginTop: 4 }}>
            Active anomalies and behavioral regime shifts
          </p>
        </div>
        <button onClick={load} style={{
          display: 'flex', alignItems: 'center', gap: 7,
          padding: '8px 16px', borderRadius: 8, border: `1px solid ${T.border}`,
          background: T.bgCard, color: T.textSec, fontSize: 13, cursor: 'pointer',
        }}>
          <RefreshCw size={13} />
          Refresh
        </button>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(380px, 1fr))', gap: 28 }}>
        {/* Anomalies */}
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
            <AlertTriangle size={15} color={T.red} />
            <span style={{ fontSize: 14, fontWeight: 600, color: T.textPri }}>
              Active Anomalies ({filtered.length})
            </span>
            <div style={{ display: 'flex', gap: 6, marginLeft: 'auto' }}>
              {['ALL','HIGH','MEDIUM','LOW'].map(f => (
                <button key={f} onClick={() => setFilter(f)} style={{
                  padding: '3px 10px', borderRadius: 20, fontSize: 11, cursor: 'pointer', border: 'none',
                  background: filter === f ? T.purpleDim : T.bgPanel,
                  color: filter === f ? T.cyanL : T.textMut, fontWeight: 600,
                }}>
                  {f}
                </button>
              ))}
            </div>
          </div>
          {filtered.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '40px 0', color: T.green, fontSize: 13 }}>
              ✓ No {filter !== 'ALL' ? filter.toLowerCase() + ' ' : ''}anomalies detected
            </div>
          ) : (
            filtered.map((a, i) => <AnomalyCard key={i} a={a} />)
          )}
        </div>

        {/* Regime changes */}
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
            <Activity size={15} color={T.amber} />
            <span style={{ fontSize: 14, fontWeight: 600, color: T.textPri }}>
              Regime Changes ({regimes.length})
            </span>
          </div>
          {regimes.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '40px 0', color: T.textMut, fontSize: 13 }}>
              No recent regime shifts
            </div>
          ) : (
            regimes.map((r, i) => <RegimeCard key={i} r={r} />)
          )}

          {/* Legend */}
          <div style={{ marginTop: 20, padding: '14px 16px', background: T.bgPanel, borderRadius: 10, border: `1px solid ${T.border}` }}>
            <div style={{ fontSize: 11, color: T.textMut, fontWeight: 700, letterSpacing: '0.07em', marginBottom: 10 }}>MODELS</div>
            {[
              { id: 0, name: 'Constant', desc: 'y = c — stable, flat', color: T.green },
              { id: 1, name: 'Linear',   desc: 'y = mt + c — steady trend', color: T.amber },
              { id: 2, name: 'Quadratic', desc: 'y = at² + bt + c — accelerating', color: T.red },
            ].map(m => (
              <div key={m.id} style={{ display: 'flex', gap: 8, marginBottom: 7, alignItems: 'center' }}>
                <div style={{ width: 6, height: 6, borderRadius: '50%', background: m.color, flexShrink: 0 }} />
                <span style={{ fontSize: 12, color: m.color, fontFamily: T.mono, fontWeight: 600, minWidth: 72 }}>{m.name}</span>
                <span style={{ fontSize: 11, color: T.textMut }}>{m.desc}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
