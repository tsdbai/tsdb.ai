import { useState, useEffect } from 'react'
import { useTheme } from '../context/ThemeContext'
import { fetchRegimeChanges } from '../api'
import { Activity, RefreshCw, Clock, ArrowRight, TrendingUp } from 'lucide-react'

const MODEL_INFO = [
  { id: 0, name: 'Constant',  desc: 'y = c',          color: T.green,  symbol: '—' },
  { id: 1, name: 'Linear',    desc: 'y = mt + c',     color: T.amber,  symbol: '/' },
  { id: 2, name: 'Quadratic', desc: 'y = at² + bt + c', color: T.red,  symbol: '∪' },
]

function ModelPill({ modelId }) {
  const { T } = useTheme()
  const m = MODEL_INFO[modelId] || { name: '?', color: T.textMut, symbol: '?' }
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 5,
      padding: '3px 10px', borderRadius: 20,
      background: `${m.color}18`, border: `1px solid ${m.color}44`,
      fontSize: 11, fontWeight: 700, color: m.color, fontFamily: T.mono,
    }}>
      <span>{m.symbol}</span>
      {m.name}
    </span>
  )
}

function RegimeRow({ r, index }) {
  const { T } = useTheme()
  const age = Math.floor((Date.now() / 1000 - r.detected_at) / 60)
  const ageStr = age < 60 ? `${age}m ago` : `${Math.floor(age / 60)}h ago`
  const increasing = r.to_model > r.from_model
  const severity = increasing ? T.amber : T.green
  const isEven = index % 2 === 0

  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 14,
      padding: '14px 18px',
      background: isEven ? T.bgCard : T.bgPanel,
      borderBottom: `1px solid ${T.border}`,
    }}>
      {/* Icon */}
      <div style={{
        width: 32, height: 32, borderRadius: 8, flexShrink: 0,
        background: `${severity}18`, border: `1px solid ${severity}33`,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>
        <Activity size={14} color={severity} />
      </div>

      {/* Metric */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{
          fontSize: 12, color: T.textPri, fontFamily: T.mono,
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>
          {r.metric_string}
        </div>
      </div>

      {/* Transition */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
        <ModelPill modelId={r.from_model} />
        <ArrowRight size={12} color={T.textMut} />
        <ModelPill modelId={r.to_model} />
      </div>

      {/* Complexity badge */}
      <div style={{
        padding: '3px 10px', borderRadius: 20, fontSize: 10, fontWeight: 700,
        background: `${severity}18`, border: `1px solid ${severity}33`,
        color: severity, flexShrink: 0,
      }}>
        {increasing ? '↑ Increasing' : '↓ Decreasing'}
      </div>

      {/* Time */}
      <div style={{
        fontSize: 11, color: T.textMut, display: 'flex', alignItems: 'center', gap: 4,
        flexShrink: 0, minWidth: 72, textAlign: 'right', justifyContent: 'flex-end',
      }}>
        <Clock size={10} />
        {ageStr}
      </div>
    </div>
  )
}

function ModelLegend() {
  const { T } = useTheme()
  return (
    <div style={{
      background: T.bgCard, borderRadius: 12, padding: '16px 20px',
      border: `1px solid ${T.border}`, marginBottom: 20,
    }}>
      <div style={{ fontSize: 11, color: T.textMut, fontWeight: 700, letterSpacing: '0.07em', marginBottom: 12 }}>
        COMPLEXITY MODELS
      </div>
      <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', rowGap: 12 }}>
        {MODEL_INFO.map(m => (
          <div key={m.id} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <div style={{
              width: 28, height: 28, borderRadius: 6,
              background: `${m.color}18`, border: `1px solid ${m.color}44`,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 14, fontWeight: 700, color: m.color,
            }}>
              {m.symbol}
            </div>
            <div>
              <div style={{ fontSize: 12, fontWeight: 700, color: m.color, fontFamily: T.mono }}>{m.name}</div>
              <div style={{ fontSize: 10, color: T.textMut, fontFamily: T.mono }}>{m.desc}</div>
            </div>
          </div>
        ))}
        <div style={{ marginLeft: 'auto', fontSize: 11, color: T.textMut, alignSelf: 'center' }}>
          <span style={{ color: T.amber }}>↑ Higher model</span> = accelerating change · <span style={{ color: T.green }}>↓ Lower model</span> = stabilizing
        </div>
      </div>
    </div>
  )
}

export default function Regimes() {
  const { T } = useTheme()
  const [regimes, setRegimes] = useState([])
  const [loading, setLoading] = useState(false)
  const [filter, setFilter] = useState('ALL')

  const load = async () => {
    setLoading(true)
    const d = await fetchRegimeChanges()
    setRegimes(d?.changes || [])
    setLoading(false)
  }

  useEffect(() => { load() }, [])

  const filtered = filter === 'ALL' ? regimes
    : filter === 'INCREASING' ? regimes.filter(r => r.to_model > r.from_model)
    : regimes.filter(r => r.to_model < r.from_model)

  const increasing = regimes.filter(r => r.to_model > r.from_model).length
  const decreasing = regimes.filter(r => r.to_model < r.from_model).length

  return (
    <div style={{ padding: '24px 28px', overflowY: 'auto', flex: 1, width: '100%', boxSizing: 'border-box' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', marginBottom: 24 }}>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 700, color: T.textPri }}>Regime Changes</h1>
          <p style={{ fontSize: 13, color: T.textMut, marginTop: 4 }}>
            Behavioral model transitions detected across all tracked series
          </p>
        </div>
        <button onClick={load} disabled={loading} style={{
          display: 'flex', alignItems: 'center', gap: 7,
          padding: '8px 16px', borderRadius: 8, border: `1px solid ${T.border}`,
          background: T.bgCard, color: T.textSec, fontSize: 13, cursor: 'pointer',
        }}>
          <RefreshCw size={13} />
          Refresh
        </button>
      </div>

      {/* Stat cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: 12, marginBottom: 20 }}>
        {[
          { label: 'Total Changes', value: regimes.length, color: T.cyan },
          { label: 'Increasing Complexity', value: increasing, color: T.amber },
          { label: 'Decreasing Complexity', value: decreasing, color: T.green },
        ].map(s => (
          <div key={s.label} style={{
            background: T.bgCard, borderRadius: 10, padding: '14px 18px',
            border: `1px solid ${T.border}`,
          }}>
            <div style={{ fontSize: 10, color: T.textMut, letterSpacing: '0.07em', fontWeight: 700, marginBottom: 6 }}>
              {s.label.toUpperCase()}
            </div>
            <div style={{ fontSize: 24, fontWeight: 700, color: s.color, fontFamily: T.mono }}>
              {s.value}
            </div>
          </div>
        ))}
      </div>

      <ModelLegend />

      {/* Filter */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 16, flexWrap: 'wrap', alignItems: 'center' }}>
        {['ALL', 'INCREASING', 'DECREASING'].map(f => (
          <button key={f} onClick={() => setFilter(f)} style={{
            padding: '5px 14px', borderRadius: 20, fontSize: 11, cursor: 'pointer', border: 'none',
            background: filter === f ? T.purpleDim : T.bgPanel,
            color: filter === f ? T.cyanL : T.textMut, fontWeight: 700,
          }}>
            {f}
          </button>
        ))}
        <span style={{ marginLeft: 'auto', fontSize: 12, color: T.textMut, alignSelf: 'center' }}>
          {filtered.length} change{filtered.length !== 1 ? 's' : ''}
        </span>
      </div>

      {/* Table */}
      <div style={{ borderRadius: 12, border: `1px solid ${T.border}`, overflowX: 'auto' }}>
      <div style={{ background: T.bgCard, borderRadius: 12, minWidth: 520, overflow: 'hidden' }}>
        {/* Header */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: 14,
          padding: '10px 18px',
          background: T.bgPanel, borderBottom: `1px solid ${T.border}`,
          fontSize: 10, color: T.textMut, fontWeight: 700, letterSpacing: '0.07em',
        }}>
          <div style={{ width: 32, flexShrink: 0 }} />
          <div style={{ flex: 1 }}>METRIC</div>
          <div style={{ flexShrink: 0, minWidth: 200 }}>TRANSITION</div>
          <div style={{ flexShrink: 0, minWidth: 110 }}>DIRECTION</div>
          <div style={{ flexShrink: 0, minWidth: 80, textAlign: 'right' }}>WHEN</div>
        </div>

        {loading ? (
          <div style={{ textAlign: 'center', padding: '40px 0', color: T.textMut, fontSize: 13 }}>
            Loading…
          </div>
        ) : filtered.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '50px 0', color: T.textMut, fontSize: 13 }}>
            No regime changes found
          </div>
        ) : (
          filtered.map((r, i) => <RegimeRow key={i} r={r} index={i} />)
        )}
      </div>
      </div>
    </div>
  )
}
