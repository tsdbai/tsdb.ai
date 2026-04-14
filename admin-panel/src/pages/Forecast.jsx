import { useState, useEffect } from 'react'
import { useTheme } from '../context/ThemeContext'
import { gradientBorder } from '../theme'
import { fetchForecast, fetchMetricNames } from '../api'
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ReferenceLine, ResponsiveContainer
} from 'recharts'
import { TrendingUp, Search, ChevronRight } from 'lucide-react'

const QUALITY_COLOR = { HIGH: T.green, MEDIUM: T.amber, LOW: T.red }

function buildChartData(f) {
  if (!f) return []
  const now = Date.now() / 1000
  const horizon = f.horizon_seconds
  const points = 20
  const data = []

  // Historical: last 5 minutes of "current value" (mock linear backfill)
  for (let i = -10; i <= 0; i++) {
    const t = now + (i * 30)
    const label = new Date(t * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    data.push({
      time: label,
      value: +f.current_value.toFixed(3),
      isForecast: false,
    })
  }

  // Forecast range: projected value with confidence band
  for (let i = 1; i <= points; i++) {
    const frac = i / points
    const t = now + frac * horizon
    const label = new Date(t * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    // Interpolate linearly between current and predicted
    const val = f.current_value + (f.predicted_value - f.current_value) * frac
    // Confidence band widens with sqrt(frac)
    const spread = (f.confidence_high - f.confidence_low) / 2
    const scaledSpread = spread * Math.sqrt(frac)
    data.push({
      time: label,
      forecast: +val.toFixed(3),
      bandLow: +(val - scaledSpread).toFixed(3),
      bandHigh: +(val + scaledSpread).toFixed(3),
      isForecast: true,
    })
  }
  return data
}

const CustomTooltip = ({ active, payload, label }) => {
  const { T } = useTheme()
  if (!active || !payload?.length) return null
  const d = payload[0]?.payload
  return (
    <div style={{
      background: T.bgCard, border: `1px solid ${T.border}`, borderRadius: 8,
      padding: '10px 14px', fontSize: 12, color: T.textSec,
    }}>
      <div style={{ color: T.textMut, marginBottom: 6 }}>{label}</div>
      {d.value !== undefined && <div>Value: <b style={{ color: T.cyan }}>{d.value}</b></div>}
      {d.forecast !== undefined && <div>Forecast: <b style={{ color: T.purple }}>{d.forecast}</b></div>}
      {d.bandHigh !== undefined && (
        <div style={{ color: T.textMut, fontSize: 11 }}>
          Band: [{d.bandLow}, {d.bandHigh}]
        </div>
      )}
    </div>
  )
}

export default function Forecast() {
  const { T } = useTheme()
  const [metric, setMetric] = useState('')
  const [horizon, setHorizon] = useState(300)
  const [result, setResult] = useState(null)
  const [loading, setLoading] = useState(false)
  const [suggestions, setSuggestions] = useState([])
  const [allMetrics, setAllMetrics] = useState([])
  const [showSuggestions, setShowSuggestions] = useState(false)

  useEffect(() => {
    fetchMetricNames().then(d => setAllMetrics(d?.data || []))
  }, [])

  const filtered = metric.length > 0
    ? allMetrics.filter(m => m.toLowerCase().includes(metric.toLowerCase())).slice(0, 8)
    : []

  const run = async (m = metric) => {
    if (!m) return
    setLoading(true)
    setShowSuggestions(false)
    const r = await fetchForecast(m, horizon)
    setResult(r?.data || null)
    setLoading(false)
  }

  const chartData = buildChartData(result)
  const delta = result ? result.predicted_value - result.current_value : 0
  const qColor = result ? (QUALITY_COLOR[result.forecast_quality] || T.textMut) : T.textMut

  return (
    <div style={{ padding: '24px 28px', overflowY: 'auto', flex: 1, width: '100%', boxSizing: 'border-box' }}>
      <div style={{ marginBottom: 28, display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
        <div>
        <h1 style={{ fontSize: 22, fontWeight: 700, color: T.textPri }}>Forecast Viewer</h1>
        <p style={{ fontSize: 13, color: T.textMut, marginTop: 4 }}>
          Project any metric forward using its current polynomial model with confidence bands.
        </p>
        </div>
      </div>

      {/* Input row */}
      <div style={{ display: 'flex', gap: 12, marginBottom: 24, position: 'relative', flexWrap: 'wrap' }}>
        <div style={{ flex: 1, position: 'relative' }}>
          <Search size={14} color={T.textMut} style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)' }} />
          <input
            value={metric}
            onChange={e => { setMetric(e.target.value); setShowSuggestions(true) }}
            onFocus={() => setShowSuggestions(true)}
            onKeyDown={e => e.key === 'Enter' && run()}
            placeholder="Enter metric name (e.g. cpu_usage)"
            style={{
              width: '100%', padding: '10px 12px 10px 36px',
              background: T.bgInput, border: `1px solid ${T.border}`, borderRadius: 8,
              color: T.textPri, fontSize: 13, fontFamily: T.mono, outline: 'none',
            }}
          />
          {/* Autocomplete */}
          {showSuggestions && filtered.length > 0 && (
            <div style={{
              position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 50,
              background: T.bgCard, border: `1px solid ${T.border}`, borderRadius: 8,
              marginTop: 4, overflow: 'hidden',
            }}>
              {filtered.map(m => (
                <div key={m}
                  onClick={() => { setMetric(m); setShowSuggestions(false); run(m) }}
                  style={{
                    padding: '9px 14px', fontSize: 13, fontFamily: T.mono,
                    color: T.textSec, cursor: 'pointer',
                    borderBottom: `1px solid ${T.border}`,
                  }}
                  onMouseEnter={e => e.currentTarget.style.background = T.bgCardHov}
                  onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                >
                  {m}
                </div>
              ))}
            </div>
          )}
        </div>

        <select
          value={horizon}
          onChange={e => setHorizon(+e.target.value)}
          style={{
            padding: '10px 14px', background: T.bgInput, border: `1px solid ${T.border}`,
            borderRadius: 8, color: T.textPri, fontSize: 13, cursor: 'pointer', outline: 'none',
          }}
        >
          {[60,300,600,1800,3600].map(h => (
            <option key={h} value={h}>{h < 60 ? h+'s' : h < 3600 ? h/60+'m' : h/3600+'h'}</option>
          ))}
        </select>

        <button onClick={() => run()} disabled={!metric || loading} style={{
          padding: '10px 20px', borderRadius: 8, border: 'none',
          background: `linear-gradient(135deg, ${T.purple}, ${T.cyan})`,
          color: '#fff', fontSize: 13, fontWeight: 600, cursor: 'pointer',
          display: 'flex', alignItems: 'center', gap: 8,
          opacity: (!metric || loading) ? 0.5 : 1,
        }}>
          <TrendingUp size={14} />
          {loading ? 'Running…' : 'Forecast'}
        </button>
      </div>

      {/* Result */}
      {result && (
        <>
          {/* Summary cards */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: 12, marginBottom: 20 }}>
            {[
              { label: 'Current',   value: result.current_value.toFixed(4),   color: T.textPri },
              { label: 'Predicted', value: result.predicted_value.toFixed(4), color: delta > 0 ? T.amber : delta < 0 ? T.green : T.textPri },
              { label: 'Model',     value: result.model_name,                  color: T.cyan },
              { label: 'Quality',   value: result.forecast_quality,            color: qColor },
            ].map(c => (
              <div key={c.label} style={{
                background: T.bgCard, borderRadius: 10, padding: '14px 16px',
                border: `1px solid ${T.border}`,
              }}>
                <div style={{ fontSize: 10, color: T.textMut, letterSpacing: '0.07em', marginBottom: 6, fontWeight: 600 }}>
                  {c.label.toUpperCase()}
                </div>
                <div style={{ fontSize: 18, fontWeight: 700, color: c.color, fontFamily: T.mono }}>
                  {c.value}
                </div>
              </div>
            ))}
          </div>

          {/* Chart */}
          <div style={{ background: T.bgCard, borderRadius: 12, padding: '20px 16px 12px', border: `1px solid ${T.border}` }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: T.textSec, marginBottom: 16, paddingLeft: 8 }}>
              {result.metric} — {horizon / 60}min forecast
              <span style={{ marginLeft: 12, fontSize: 11, color: T.textMut, fontFamily: T.mono }}>
                RMSE baseline: {result.rolling_rmse.toFixed(4)}
              </span>
            </div>
            <ResponsiveContainer width="100%" height={260}>
              <AreaChart data={chartData} margin={{ top: 4, right: 20, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke={T.border} />
                <XAxis dataKey="time" tick={{ fontSize: 10, fill: T.textMut }} interval="preserveStartEnd" />
                <YAxis tick={{ fontSize: 10, fill: T.textMut }} width={55} />
                <Tooltip content={<CustomTooltip />} />
                <ReferenceLine x={chartData[10]?.time} stroke={T.textMut} strokeDasharray="4 4" label={{ value: 'NOW', fill: T.textMut, fontSize: 10 }} />
                {/* Confidence band */}
                <Area dataKey="bandHigh" stroke="none" fill={`${T.purple}22`} />
                <Area dataKey="bandLow"  stroke="none" fill={T.bgCard} />
                {/* Historical value */}
                <Area type="monotone" dataKey="value"    stroke={T.cyan}   strokeWidth={2} fill={`${T.cyan}15`} dot={false} />
                {/* Forecast */}
                <Area type="monotone" dataKey="forecast" stroke={T.purple} strokeWidth={2} strokeDasharray="5 3" fill="none" dot={false} />
              </AreaChart>
            </ResponsiveContainer>
            <div style={{ display: 'flex', gap: 20, paddingLeft: 8, marginTop: 8 }}>
              {[
                { color: T.cyan,   label: 'Historical' },
                { color: T.purple, label: 'Forecast' },
                { color: `${T.purple}44`, label: 'Confidence band', isArea: true },
              ].map(l => (
                <div key={l.label} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: T.textMut }}>
                  <div style={{ width: l.isArea ? 16 : 20, height: l.isArea ? 10 : 2, background: l.color, borderRadius: l.isArea ? 2 : 0 }} />
                  {l.label}
                </div>
              ))}
            </div>
          </div>
        </>
      )}

      {!result && !loading && (
        <div style={{ textAlign: 'center', padding: '60px 0', color: T.textMut, fontSize: 13 }}>
          Enter a metric name above and click Forecast to see the projection.
        </div>
      )}
    </div>
  )
}
