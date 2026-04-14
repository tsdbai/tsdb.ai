import { useState, useEffect, useCallback, useRef } from 'react'
import { useTheme } from '../context/ThemeContext'
import { fetchPatterns, registerPattern, fetchMetricNames } from '../api'
import {
  BookMarked, Plus, Search, Tag, X, Check, ChevronRight,
  AlertCircle, RefreshCw, Crosshair,
} from 'lucide-react'
import {
  ResponsiveContainer, LineChart, Line, XAxis, YAxis,
  CartesianGrid, Tooltip, ReferenceArea,
} from 'recharts'

// ── Query helper (same as AIDashboard) ────────────────────────────────────────
function getQueryUrl() {
  try {
    const u = new URL(window.location.href)
    u.port = '8081'
    return u.origin
  } catch { return 'http://localhost:8081' }
}

async function fetchMetricData(metricName, durationSeconds = 3600) {
  const end   = Math.floor(Date.now() / 1000)
  const start = end - durationSeconds
  const step  = Math.max(15, Math.floor(durationSeconds / 300))
  const url   = `${getQueryUrl()}/api/v1/query_range` +
    `?query=${encodeURIComponent(metricName)}&start=${start}&end=${end}&step=${step}`
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) })
  if (!res.ok) throw new Error(`Query gateway returned ${res.status}`)
  const json = await res.json()
  return (json.data?.result || []).map(series => ({
    name: series.metric.__name__ || metricName,
    labels: series.metric,
    data: series.values.map(([ts, v]) => ({
      time:      new Date(ts * 1000).toLocaleTimeString('en', { hour: '2-digit', minute: '2-digit' }),
      timeEpoch: ts,
      value:     parseFloat(v),
    })),
  }))
}

// ── Small helpers ─────────────────────────────────────────────────────────────
function CosineBadge({ score }) {
  const { T } = useTheme()
  const pct   = Math.round((score || 0) * 100)
  const color = pct >= 95 ? T.green : pct >= 90 ? T.cyan : T.amber
  return (
    <span style={{
      fontSize: 10, color, fontFamily: T.mono, fontWeight: 700,
      background: `${color}18`, border: `1px solid ${color}33`,
      borderRadius: 4, padding: '2px 7px',
    }}>{pct}% match</span>
  )
}

function VectorBar({ vector }) {
  const { T } = useTheme()
  if (!vector?.length) return null
  const labels = ['a', 'b', 'c', 'rmse', 'r.rmse', 'dir', 'cmplx', 'stab']
  const max = Math.max(...vector.map(Math.abs), 0.001)
  return (
    <div style={{ display: 'flex', gap: 4, marginTop: 8 }}>
      {vector.map((v, i) => {
        const frac = Math.abs(v) / max
        const color = v >= 0 ? T.cyan : T.red
        return (
          <div key={i} style={{ flex: 1, textAlign: 'center' }}>
            <div style={{
              height: 28, background: T.bgPanel, borderRadius: 3,
              position: 'relative', overflow: 'hidden', border: `1px solid ${T.border}`,
            }}>
              <div style={{
                position: 'absolute', bottom: 0, left: 0, right: 0,
                height: `${frac * 100}%`, background: `${color}55`,
              }} />
            </div>
            <div style={{ fontSize: 8, color: T.textMut, marginTop: 2 }}>{labels[i] || i}</div>
          </div>
        )
      })}
    </div>
  )
}

function PatternCard({ p }) {
  const { T } = useTheme()
  const matchColor = (p.match_count || 0) > 50 ? T.green : (p.match_count || 0) > 10 ? T.cyan : T.textMut
  return (
    <div style={{
      background: T.bgCard, borderRadius: 12, padding: '16px 20px',
      border: `1px solid ${T.border}`, marginBottom: 10,
    }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
            <Tag size={12} color={T.cyan} />
            <span style={{ fontSize: 14, fontWeight: 700, color: T.textPri, fontFamily: T.mono }}>
              {p.name}
            </span>
            <span style={{
              fontSize: 10, color: matchColor, fontFamily: T.mono, fontWeight: 700,
              background: `${matchColor}18`, border: `1px solid ${matchColor}33`,
              borderRadius: 4, padding: '1px 6px',
            }}>
              {p.match_count || 0} matches
            </span>
          </div>
          {p.description && (
            <div style={{ fontSize: 12, color: T.textSec, marginBottom: 8, lineHeight: 1.5 }}>
              {p.description}
            </div>
          )}
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {p.tagged_by && (
              <span style={{
                fontSize: 10, color: T.textMut, fontFamily: T.mono,
                background: `${T.textMut}12`, border: `1px solid ${T.border}`,
                borderRadius: 4, padding: '2px 7px',
              }}>by {p.tagged_by}</span>
            )}
            {p.cosine_score && <CosineBadge score={p.cosine_score} />}
          </div>
          <VectorBar vector={p.vector} />
        </div>
        <div style={{ fontSize: 10, color: T.textMut, fontFamily: T.mono, textAlign: 'right', flexShrink: 0 }}>
          {p.id && <div style={{ marginBottom: 4 }}>{p.id.slice(0, 8)}</div>}
          {p.registered_at && <div>{new Date(p.registered_at * 1000).toLocaleDateString()}</div>}
        </div>
      </div>
    </div>
  )
}

// ── Step indicator ─────────────────────────────────────────────────────────────
function Steps({ current }) {
  const { T } = useTheme()
  const steps = ['Select Metric', 'Mark Range', 'Label & Save']
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 0, marginBottom: 28 }}>
      {steps.map((s, i) => {
        const done    = i < current
        const active  = i === current
        const color   = done ? T.green : active ? T.cyan : T.textMut
        return (
          <div key={i} style={{ display: 'flex', alignItems: 'center', flex: i < steps.length - 1 ? 1 : 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 7, flexShrink: 0 }}>
              <div style={{
                width: 22, height: 22, borderRadius: '50%', flexShrink: 0,
                background: done ? `${T.green}22` : active ? `${T.cyan}22` : T.bgPanel,
                border: `1.5px solid ${color}`,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: 10, fontWeight: 700, color,
              }}>
                {done ? '✓' : i + 1}
              </div>
              <span style={{ fontSize: 11, fontWeight: active ? 700 : 400, color, whiteSpace: 'nowrap' }}>
                {s}
              </span>
            </div>
            {i < steps.length - 1 && (
              <div style={{ flex: 1, height: 1, background: done ? `${T.green}44` : T.border, margin: '0 10px' }} />
            )}
          </div>
        )
      })}
    </div>
  )
}

// ── Register wizard ────────────────────────────────────────────────────────────
function RegisterModal({ onClose, onSuccess }) {
  const { T } = useTheme()
  const [step,      setStep]      = useState(0)
  const [metric,    setMetric]    = useState('')
  const [metricNames, setMetricNames] = useState([])
  const [chartData, setChartData] = useState([])    // flat [{time, value}]
  const [seriesName, setSeriesName] = useState('')
  const [loadingChart, setLoadingChart] = useState(false)
  const [chartError, setChartError] = useState('')

  // Drag-select state
  const [selStart, setSelStart] = useState(null)    // time string
  const [selEnd,   setSelEnd]   = useState(null)
  const [dragging, setDragging] = useState(false)

  // Step 3
  const [name,     setName]     = useState('')
  const [desc,     setDesc]     = useState('')
  const [taggedBy, setTaggedBy] = useState('')
  const [saving,   setSaving]   = useState(false)
  const [saveError, setSaveError] = useState('')
  const [saved,    setSaved]    = useState(false)

  // Autocomplete
  useEffect(() => {
    fetchMetricNames().then(d => setMetricNames(d?.data || []))
  }, [])

  const filteredNames = metric.length >= 2
    ? metricNames.filter(n => n.toLowerCase().includes(metric.toLowerCase())).slice(0, 8)
    : []

  // Step 1 → 2: load chart
  const loadChart = async () => {
    if (!metric.trim()) return
    setLoadingChart(true)
    setChartError('')
    try {
      const series = await fetchMetricData(metric.trim(), 3600)
      if (!series.length || !series[0].data.length) {
        setChartError('No data found for this metric in the last hour. Try a different metric or time range.')
        setLoadingChart(false)
        return
      }
      // Flatten first series (most useful for pattern selection)
      setChartData(series[0].data)
      setSeriesName(series[0].name)
      setSelStart(null)
      setSelEnd(null)
      setStep(1)
    } catch (e) {
      setChartError(e.message || 'Failed to load metric data.')
    }
    setLoadingChart(false)
  }

  // Drag handlers
  const handleMouseDown = useCallback((e) => {
    if (e?.activeLabel) {
      setSelStart(e.activeLabel)
      setSelEnd(null)
      setDragging(true)
    }
  }, [])

  const handleMouseMove = useCallback((e) => {
    if (dragging && e?.activeLabel) {
      setSelEnd(e.activeLabel)
    }
  }, [dragging])

  const handleMouseUp = useCallback(() => {
    setDragging(false)
    if (selStart && selEnd && selStart !== selEnd) {
      setStep(2)
    }
  }, [selStart, selEnd])

  // Normalise selection so start < end in data order
  const dataIndex = (label) => chartData.findIndex(d => d.time === label)
  const [normStart, normEnd] = (() => {
    if (!selStart || !selEnd) return [selStart, selEnd]
    const si = dataIndex(selStart), ei = dataIndex(selEnd)
    return si <= ei ? [selStart, selEnd] : [selEnd, selStart]
  })()

  const selectedPoints = chartData.filter(d => {
    if (!normStart || !normEnd) return false
    const di = dataIndex(d.time)
    return di >= dataIndex(normStart) && di <= dataIndex(normEnd)
  })

  // Step 3: save
  const save = async () => {
    if (!name.trim()) { setSaveError('Pattern name is required.'); return }
    setSaving(true)
    setSaveError('')
    try {
      await registerPattern(metric.trim(), name.trim(), desc.trim(), taggedBy.trim() || 'admin')
      setSaved(true)
      setTimeout(() => { onSuccess(); onClose() }, 900)
    } catch (e) {
      setSaveError(e.message || 'Registration failed.')
    }
    setSaving(false)
  }

  const inputStyle = {
    width: '100%', padding: '9px 12px', boxSizing: 'border-box',
    background: T.bgInput, border: `1px solid ${T.border}`, borderRadius: 7,
    color: T.textPri, fontSize: 13, fontFamily: T.mono, outline: 'none',
  }

  return (
    <div
      style={{ position: 'fixed', inset: 0, background: '#00000099', zIndex: 100, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
      onClick={onClose}
    >
      <div
        style={{
          background: T.bgCard, borderRadius: 16, padding: '28px 32px',
          width: step === 1 ? 'min(820px, calc(100vw - 32px))' : 'min(520px, calc(100vw - 32px))',
          maxHeight: 'calc(100vh - 40px)', overflowY: 'auto',
          border: `1px solid ${T.purple}44`, boxShadow: `0 0 60px ${T.purple}22`,
          transition: 'width 0.3s ease',
        }}
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <Crosshair size={16} color={T.cyan} />
            <span style={{ fontSize: 16, fontWeight: 700, color: T.textPri }}>Register Pattern</span>
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: T.textMut }}>
            <X size={16} />
          </button>
        </div>

        <Steps current={step} />

        {/* ── STEP 0: Select metric ─────────────────────────────────────────── */}
        {step === 0 && (
          <div>
            <div style={{ fontSize: 13, color: T.textSec, marginBottom: 18, lineHeight: 1.6 }}>
              Enter the metric you want to fingerprint. A chart will load so you can
              visually select the time range that shows the behavior you want to capture.
            </div>

            <div style={{ fontSize: 11, color: T.textMut, fontWeight: 700, letterSpacing: '0.07em', marginBottom: 6 }}>
              METRIC NAME
            </div>
            <div style={{ position: 'relative' }}>
              <input
                value={metric}
                onChange={e => setMetric(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && loadChart()}
                placeholder='mock_cpu_utilization_percent{instance="web-01"}'
                autoFocus
                style={inputStyle}
              />
              {filteredNames.length > 0 && (
                <div style={{
                  position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 10,
                  background: T.bgCard, border: `1px solid ${T.border}`, borderRadius: 8,
                  marginTop: 4, overflow: 'hidden',
                }}>
                  {filteredNames.map(n => (
                    <div
                      key={n}
                      onClick={() => { setMetric(n) }}
                      style={{
                        padding: '9px 14px', fontSize: 12, color: T.textSec,
                        fontFamily: T.mono, cursor: 'pointer',
                        borderBottom: `1px solid ${T.border}`,
                      }}
                      onMouseEnter={e => e.currentTarget.style.background = T.bgPanel}
                      onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                    >
                      {n}
                    </div>
                  ))}
                </div>
              )}
            </div>

            {chartError && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 12, fontSize: 12, color: T.red }}>
                <AlertCircle size={13} /> {chartError}
              </div>
            )}

            <button
              onClick={loadChart}
              disabled={!metric.trim() || loadingChart}
              style={{
                marginTop: 20, width: '100%', padding: '11px',
                borderRadius: 8, border: 'none', cursor: metric.trim() ? 'pointer' : 'default',
                background: metric.trim() ? `linear-gradient(135deg, ${T.purple}, ${T.cyan})` : T.bgPanel,
                color: metric.trim() ? '#fff' : T.textMut,
                fontSize: 14, fontWeight: 600,
                display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
                opacity: loadingChart ? 0.7 : 1,
              }}
            >
              {loadingChart
                ? <><RefreshCw size={14} style={{ animation: 'spin 1s linear infinite' }} /> Loading chart…</>
                : <><ChevronRight size={14} /> Load Chart</>
              }
            </button>
          </div>
        )}

        {/* ── STEP 1: Chart + drag select ───────────────────────────────────── */}
        {step === 1 && (
          <div>
            <div style={{ fontSize: 13, color: T.textSec, marginBottom: 6 }}>
              <strong style={{ color: T.cyan, fontFamily: T.mono }}>{seriesName}</strong>
              &nbsp;— last hour
            </div>
            <div style={{
              fontSize: 12, color: T.textMut, marginBottom: 16,
              display: 'flex', alignItems: 'center', gap: 6,
            }}>
              <Crosshair size={11} color={T.cyan} />
              Click and drag on the chart to select the time range showing the behavior you want to capture.
            </div>

            <div style={{ userSelect: 'none' }}>
              <ResponsiveContainer width="100%" height={260}>
                <LineChart
                  data={chartData}
                  onMouseDown={handleMouseDown}
                  onMouseMove={handleMouseMove}
                  onMouseUp={handleMouseUp}
                  style={{ cursor: dragging ? 'col-resize' : 'crosshair' }}
                >
                  <CartesianGrid strokeDasharray="3 3" stroke={T.border} />
                  <XAxis
                    dataKey="time"
                    tick={{ fontSize: 9, fill: T.textMut }}
                    interval="preserveStartEnd"
                  />
                  <YAxis tick={{ fontSize: 9, fill: T.textMut }} width={48} />
                  <Tooltip
                    contentStyle={{ background: T.bgCard, border: `1px solid ${T.border}`, borderRadius: 8, fontSize: 11 }}
                    labelStyle={{ color: T.textMut }}
                    itemStyle={{ color: T.cyan }}
                  />
                  <Line
                    type="linear"
                    dataKey="value"
                    stroke={T.cyan}
                    strokeWidth={1.5}
                    dot={false}
                    isAnimationActive={false}
                  />
                  {/* Live drag highlight */}
                  {selStart && selEnd && selStart !== selEnd && (
                    <ReferenceArea
                      x1={normStart} x2={normEnd}
                      fill={T.purple} fillOpacity={0.25}
                      stroke={T.purple} strokeOpacity={0.6}
                    />
                  )}
                </LineChart>
              </ResponsiveContainer>
            </div>

            {/* Instruction if nothing selected yet */}
            {!selStart && (
              <div style={{
                marginTop: 14, padding: '10px 14px', borderRadius: 8,
                background: `${T.cyan}0d`, border: `1px dashed ${T.cyan}44`,
                fontSize: 12, color: T.textMut, textAlign: 'center',
              }}>
                No range selected yet — drag across the chart to highlight a region
              </div>
            )}

            <div style={{ display: 'flex', gap: 10, marginTop: 16 }}>
              <button
                onClick={() => setStep(0)}
                style={{
                  flex: 1, padding: '9px', borderRadius: 8, cursor: 'pointer',
                  background: T.bgPanel, border: `1px solid ${T.border}`,
                  color: T.textMut, fontSize: 13,
                }}
              >
                ← Back
              </button>
              <button
                onClick={() => selStart && selEnd && setStep(2)}
                disabled={!selStart || !selEnd || selStart === selEnd}
                style={{
                  flex: 2, padding: '9px', borderRadius: 8, cursor: selStart && selEnd ? 'pointer' : 'default',
                  background: selStart && selEnd ? `linear-gradient(135deg, ${T.purple}, ${T.cyan})` : T.bgPanel,
                  border: 'none',
                  color: selStart && selEnd ? '#fff' : T.textMut,
                  fontSize: 13, fontWeight: 600,
                  display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
                }}
              >
                <ChevronRight size={13} /> Label This Pattern
              </button>
            </div>
          </div>
        )}

        {/* ── STEP 2: Label & save ──────────────────────────────────────────── */}
        {step === 2 && (
          <div>
            {/* Selected range summary */}
            <div style={{
              background: `${T.purple}12`, border: `1px solid ${T.purple}44`,
              borderRadius: 10, padding: '12px 16px', marginBottom: 22,
            }}>
              <div style={{ fontSize: 11, color: T.textMut, fontWeight: 700, letterSpacing: '0.07em', marginBottom: 6 }}>
                SELECTED RANGE
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 12, color: T.textSec }}>
                <span style={{ fontFamily: T.mono, color: T.cyan }}>{normStart}</span>
                <span style={{ color: T.textMut }}>→</span>
                <span style={{ fontFamily: T.mono, color: T.cyan }}>{normEnd}</span>
                <span style={{ color: T.textMut, marginLeft: 4 }}>
                  ({selectedPoints.length} points)
                </span>
              </div>
              <div style={{ fontSize: 11, color: T.textMut, marginTop: 6, fontFamily: T.mono }}>
                {metric}
              </div>
            </div>

            {/* Name */}
            <div style={{ marginBottom: 14 }}>
              <div style={{ fontSize: 11, color: T.textMut, fontWeight: 700, letterSpacing: '0.07em', marginBottom: 6 }}>
                PATTERN NAME *
              </div>
              <input
                value={name}
                onChange={e => setName(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && save()}
                placeholder="cpu_spike  /  memory_leak  /  traffic_surge"
                autoFocus
                style={inputStyle}
              />
            </div>

            {/* Description */}
            <div style={{ marginBottom: 14 }}>
              <div style={{ fontSize: 11, color: T.textMut, fontWeight: 700, letterSpacing: '0.07em', marginBottom: 6 }}>
                DESCRIPTION
              </div>
              <input
                value={desc}
                onChange={e => setDesc(e.target.value)}
                placeholder="What does this behavior mean? What causes it?"
                style={inputStyle}
              />
            </div>

            {/* Tagged by */}
            <div style={{ marginBottom: 20 }}>
              <div style={{ fontSize: 11, color: T.textMut, fontWeight: 700, letterSpacing: '0.07em', marginBottom: 6 }}>
                TAGGED BY
              </div>
              <input
                value={taggedBy}
                onChange={e => setTaggedBy(e.target.value)}
                placeholder="admin"
                style={inputStyle}
              />
            </div>

            {saveError && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14, fontSize: 12, color: T.red }}>
                <AlertCircle size={13} /> {saveError}
              </div>
            )}

            <div style={{ display: 'flex', gap: 10 }}>
              <button
                onClick={() => setStep(1)}
                style={{
                  flex: 1, padding: '10px', borderRadius: 8, cursor: 'pointer',
                  background: T.bgPanel, border: `1px solid ${T.border}`,
                  color: T.textMut, fontSize: 13,
                }}
              >
                ← Back
              </button>
              <button
                onClick={save}
                disabled={saving || saved || !name.trim()}
                style={{
                  flex: 2, padding: '10px', borderRadius: 8, border: 'none',
                  cursor: name.trim() ? 'pointer' : 'default',
                  background: saved
                    ? `${T.green}44`
                    : name.trim()
                    ? `linear-gradient(135deg, ${T.purple}, ${T.cyan})`
                    : T.bgPanel,
                  color: saved ? T.green : name.trim() ? '#fff' : T.textMut,
                  fontSize: 14, fontWeight: 600,
                  display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
                  opacity: saving ? 0.7 : 1,
                  transition: 'background 0.3s',
                }}
              >
                {saved
                  ? <><Check size={14} /> Saved!</>
                  : saving
                  ? <><RefreshCw size={14} style={{ animation: 'spin 1s linear infinite' }} /> Saving…</>
                  : <><Check size={14} /> Register Pattern</>
                }
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────
export default function Patterns() {
  const { T } = useTheme()
  const [patterns,   setPatterns]   = useState([])
  const [search,     setSearch]     = useState('')
  const [loading,    setLoading]    = useState(false)
  const [showModal,  setShowModal]  = useState(false)

  const load = async () => {
    setLoading(true)
    const d = await fetchPatterns()
    setPatterns(d?.patterns || [])
    setLoading(false)
  }

  useEffect(() => { load() }, [])

  const filtered = patterns.filter(p =>
    !search ||
    p.name?.toLowerCase().includes(search.toLowerCase()) ||
    p.description?.toLowerCase().includes(search.toLowerCase())
  )

  const totalMatches = patterns.reduce((s, p) => s + (p.match_count || 0), 0)

  return (
    <div style={{ padding: '24px 28px', overflowY: 'auto', flex: 1, width: '100%', boxSizing: 'border-box' }}>
      {showModal && <RegisterModal onClose={() => setShowModal(false)} onSuccess={load} />}

      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', marginBottom: 28 }}>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 700, color: T.textPri }}>Pattern Registry</h1>
          <p style={{ fontSize: 13, color: T.textMut, marginTop: 4 }}>
            Named behavioral fingerprints — matched at cosine ≥ 0.92 against every ingested chunk
          </p>
        </div>
        <button
          onClick={() => setShowModal(true)}
          style={{
            display: 'flex', alignItems: 'center', gap: 7,
            padding: '9px 18px', borderRadius: 8, border: 'none',
            background: `linear-gradient(135deg, ${T.purple}, ${T.cyan})`,
            color: '#fff', fontSize: 13, fontWeight: 600, cursor: 'pointer',
          }}
        >
          <Plus size={13} /> Register Pattern
        </button>
      </div>

      {/* Stats */}
      <div style={{ display: 'flex', gap: 12, marginBottom: 24, flexWrap: 'wrap' }}>
        {[
          { label: 'Patterns',       value: patterns.length,  color: T.cyan   },
          { label: 'Total Matches',  value: totalMatches,     color: T.purple },
          { label: 'Showing',        value: filtered.length,  color: T.textSec },
        ].map(s => (
          <div key={s.label} style={{
            background: T.bgCard, borderRadius: 8, padding: '10px 16px',
            border: `1px solid ${T.border}`,
          }}>
            <span style={{ fontSize: 11, color: T.textMut }}>{s.label}: </span>
            <span style={{ fontSize: 14, fontWeight: 700, color: s.color, fontFamily: T.mono }}>{s.value}</span>
          </div>
        ))}
      </div>

      {/* Search */}
      <div style={{ position: 'relative', marginBottom: 20 }}>
        <Search size={14} color={T.textMut} style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)' }} />
        <input
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search by name or description…"
          style={{
            width: '100%', padding: '10px 12px 10px 36px', boxSizing: 'border-box',
            background: T.bgInput, border: `1px solid ${T.border}`, borderRadius: 8,
            color: T.textPri, fontSize: 13, outline: 'none',
          }}
        />
      </div>

      {/* Empty state */}
      {!loading && patterns.length === 0 && (
        <div style={{
          textAlign: 'center', padding: '60px 32px', color: T.textMut,
          background: T.bgCard, borderRadius: 14, border: `1px dashed ${T.border}`,
        }}>
          <BookMarked size={32} color={T.textMut} style={{ marginBottom: 16, opacity: 0.4 }} />
          <div style={{ fontSize: 15, fontWeight: 600, color: T.textSec, marginBottom: 8 }}>
            No patterns registered yet
          </div>
          <div style={{ fontSize: 13, lineHeight: 1.7, maxWidth: 400, margin: '0 auto 20px' }}>
            Patterns are behavioral fingerprints you define by selecting a time range on a metric
            while it's showing interesting behavior — a spike, a leak, a steady baseline.
            Once registered, TSDB automatically matches future data against them.
          </div>
          <button
            onClick={() => setShowModal(true)}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 7,
              padding: '10px 22px', borderRadius: 8, border: 'none',
              background: `linear-gradient(135deg, ${T.purple}, ${T.cyan})`,
              color: '#fff', fontSize: 13, fontWeight: 600, cursor: 'pointer',
            }}
          >
            <Plus size={13} /> Register your first pattern
          </button>
        </div>
      )}

      {/* List */}
      {loading ? (
        <div style={{ textAlign: 'center', padding: '40px 0', color: T.textMut, fontSize: 13 }}>
          Loading patterns…
        </div>
      ) : filtered.length === 0 && patterns.length > 0 ? (
        <div style={{ textAlign: 'center', padding: '40px 0', color: T.textMut, fontSize: 13 }}>
          No patterns match "{search}"
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(380px, 1fr))', gap: 0 }}>
          {filtered.map((p, i) => <PatternCard key={p.id || i} p={p} />)}
        </div>
      )}
    </div>
  )
}
