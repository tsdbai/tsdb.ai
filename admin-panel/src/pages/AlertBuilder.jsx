import { useState, useEffect } from 'react'
import { useTheme } from '../context/ThemeContext'
import { fetchMetricNames, getAlertRules, saveAlertRules } from '../api'
import ProGate from '../components/ProGate'
import { useLicense } from '../context/LicenseContext'
import { Bell, Plus, Zap, Trash2, Check, Search, ChevronRight, ToggleLeft, ToggleRight } from 'lucide-react'

const CONDITION_TYPES = [
  { id: 'threshold_above', label: 'Value exceeds threshold', unit: 'value' },
  { id: 'threshold_below', label: 'Value drops below threshold', unit: 'value' },
  { id: 'rmse_above',      label: 'RMSE exceeds limit',     unit: 'rmse' },
  { id: 'pct_change',      label: '% change in time window', unit: 'pct' },
  { id: 'forecast_breach', label: 'Forecast will exceed in horizon', unit: 'value' },
  { id: 'regime_change',   label: 'Model regime changes',   unit: null },
  { id: 'anomaly',         label: 'Anomaly detected',       unit: null },
]

const SEVERITY_OPTIONS = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']

function NLPreview({ rule }) {
  const { T } = useTheme()
  if (!rule.metric && !rule.condition) return null
  const cond = CONDITION_TYPES.find(c => c.id === rule.condition)
  const parts = []
  if (rule.metric) parts.push(`When **${rule.metric}**`)
  if (cond) {
    if (cond.unit === 'value') parts.push(`${cond.label} **${rule.threshold ?? '?'}**`)
    else if (cond.unit === 'rmse') parts.push(`RMSE exceeds **${rule.threshold ?? '?'}**`)
    else if (cond.unit === 'pct') parts.push(`changes by **${rule.threshold ?? '?'}%** in **${rule.window_minutes ?? '?'} min**`)
    else parts.push(cond.label)
  }
  if (rule.severity) parts.push(`→ fire **${rule.severity}** alert`)
  if (rule.channels?.length) parts.push(`→ notify **${rule.channels.join(', ')}**`)

  const text = parts.join(', ')
  return (
    <div style={{
      padding: '12px 16px', background: T.bgPanel, borderRadius: 8,
      border: `1px solid ${T.cyan}33`, marginTop: 16, fontSize: 12,
      color: T.textSec, lineHeight: 1.6, fontStyle: 'italic',
    }}>
      <span style={{ fontSize: 10, color: T.cyan, fontWeight: 700, display: 'block', marginBottom: 4 }}>
        NATURAL LANGUAGE PREVIEW
      </span>
      {text.split('**').map((seg, i) =>
        i % 2 === 0
          ? <span key={i}>{seg}</span>
          : <strong key={i} style={{ color: T.cyan }}>{seg}</strong>
      )}
    </div>
  )
}

function RuleEditor({ rule, onChange, onDelete, allMetrics }) {
  const { T } = useTheme()
  const [metricSearch, setMetricSearch] = useState(rule.metric || '')
  const [showSuggestions, setShowSuggestions] = useState(false)

  const suggestions = metricSearch.length > 0
    ? allMetrics.filter(m => m.toLowerCase().includes(metricSearch.toLowerCase())).slice(0, 6)
    : []

  const cond = CONDITION_TYPES.find(c => c.id === rule.condition)
  const SEV_COLOR = { LOW: T.textSec, MEDIUM: T.amber, HIGH: T.red, CRITICAL: T.red }
  const sevColor = SEV_COLOR[rule.severity] || T.textMut

  const field = (label, content) => (
    <div style={{ marginBottom: 14 }}>
      <div style={{ fontSize: 10, color: T.textMut, fontWeight: 700, letterSpacing: '0.07em', marginBottom: 5 }}>
        {label}
      </div>
      {content}
    </div>
  )

  const inputStyle = {
    width: '100%', padding: '8px 12px', boxSizing: 'border-box',
    background: T.bgInput, border: `1px solid ${T.border}`, borderRadius: 7,
    color: T.textPri, fontSize: 12, fontFamily: T.mono, outline: 'none',
  }

  return (
    <div style={{
      background: T.bgCard, borderRadius: 12, padding: '18px 20px',
      border: `1px solid ${rule.enabled !== false ? T.purple + '44' : T.border}`,
      marginBottom: 12,
      opacity: rule.enabled === false ? 0.6 : 1,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
        <Bell size={14} color={sevColor} />
        <input
          value={rule.name || ''}
          onChange={e => onChange({ ...rule, name: e.target.value })}
          placeholder="Rule name…"
          style={{
            flex: 1, background: 'none', border: 'none', outline: 'none',
            fontSize: 14, fontWeight: 700, color: T.textPri,
          }}
        />
        {/* Enable toggle */}
        <button
          onClick={() => onChange({ ...rule, enabled: rule.enabled === false ? true : false })}
          style={{ background: 'none', border: 'none', cursor: 'pointer', color: T.textMut, display: 'flex' }}
        >
          {rule.enabled === false
            ? <ToggleLeft size={20} color={T.textMut} />
            : <ToggleRight size={20} color={T.green} />}
        </button>
        <button
          onClick={onDelete}
          style={{ background: 'none', border: 'none', cursor: 'pointer', color: T.textMut, display: 'flex' }}
        >
          <Trash2 size={14} />
        </button>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
        {/* Metric */}
        {field('METRIC', (
          <div style={{ position: 'relative' }}>
            <input
              value={metricSearch}
              onChange={e => { setMetricSearch(e.target.value); onChange({ ...rule, metric: e.target.value }); setShowSuggestions(true) }}
              onFocus={() => setShowSuggestions(true)}
              placeholder="cpu_usage{host=...}"
              style={inputStyle}
            />
            {showSuggestions && suggestions.length > 0 && (
              <div style={{
                position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 50,
                background: T.bgCard, border: `1px solid ${T.border}`, borderRadius: 7,
                marginTop: 3, overflow: 'hidden',
              }}>
                {suggestions.map(m => (
                  <div key={m} onClick={() => { setMetricSearch(m); onChange({ ...rule, metric: m }); setShowSuggestions(false) }}
                    style={{ padding: '8px 12px', fontSize: 12, fontFamily: T.mono, color: T.textSec, cursor: 'pointer', borderBottom: `1px solid ${T.border}` }}
                    onMouseEnter={e => e.currentTarget.style.background = T.bgPanel}
                    onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                  >{m}</div>
                ))}
              </div>
            )}
          </div>
        ))}

        {/* Condition */}
        {field('CONDITION', (
          <select
            value={rule.condition || ''}
            onChange={e => onChange({ ...rule, condition: e.target.value })}
            style={{ ...inputStyle, cursor: 'pointer' }}
          >
            <option value="">Select condition…</option>
            {CONDITION_TYPES.map(c => <option key={c.id} value={c.id}>{c.label}</option>)}
          </select>
        ))}

        {/* Threshold (if applicable) */}
        {cond?.unit && field(
          cond.unit === 'pct' ? 'CHANGE %' : cond.unit === 'rmse' ? 'RMSE LIMIT' : 'THRESHOLD',
          <input
            type="number"
            value={rule.threshold ?? ''}
            onChange={e => onChange({ ...rule, threshold: +e.target.value })}
            placeholder="e.g. 90"
            style={inputStyle}
          />
        )}

        {/* Window (for pct) */}
        {cond?.unit === 'pct' && field('WINDOW (minutes)', (
          <input
            type="number"
            value={rule.window_minutes ?? ''}
            onChange={e => onChange({ ...rule, window_minutes: +e.target.value })}
            placeholder="e.g. 5"
            style={inputStyle}
          />
        ))}

        {/* Severity */}
        {field('SEVERITY', (
          <div style={{ display: 'flex', gap: 6 }}>
            {SEVERITY_OPTIONS.map(s => {
              const c = SEV_COLOR[s]
              const active = rule.severity === s
              return (
                <button key={s} onClick={() => onChange({ ...rule, severity: s })} style={{
                  flex: 1, padding: '6px', borderRadius: 7,
                  border: `1px solid ${active ? c + '55' : T.border}`,
                  background: active ? `${c}22` : T.bgPanel,
                  color: active ? c : T.textMut, fontSize: 10, fontWeight: 700, cursor: 'pointer',
                }}>{s}</button>
              )
            })}
          </div>
        ))}

        {/* Cooldown */}
        {field('COOLDOWN (minutes)', (
          <input
            type="number"
            value={rule.cooldown_minutes ?? 5}
            onChange={e => onChange({ ...rule, cooldown_minutes: +e.target.value })}
            style={inputStyle}
          />
        ))}
      </div>

      <NLPreview rule={rule} />
    </div>
  )
}

let nextId = Date.now()
function makeRule() {
  return { id: ++nextId, name: '', metric: '', condition: '', severity: 'HIGH', enabled: true, cooldown_minutes: 5 }
}

function AlertBuilderContent() {
  const { T } = useTheme()
  const [rules, setRules] = useState([makeRule()])
  const [allMetrics, setAllMetrics] = useState([])
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    fetchMetricNames().then(d => setAllMetrics(d?.data || []))
    getAlertRules().then(loaded => {
      if (loaded && loaded.length > 0) setRules(loaded)
    })
  }, [])

  const updateRule = (id, updated) => setRules(rules.map(r => r.id === id ? updated : r))
  const deleteRule = (id) => setRules(rules.filter(r => r.id !== id))
  const addRule = () => setRules([...rules, makeRule()])

  const save = async () => {
    setSaving(true)
    await saveAlertRules(rules)
    setSaving(false)
    setSaved(true)
    setTimeout(() => setSaved(false), 2500)
  }

  return (
    <div style={{ padding: '28px 32px', overflowY: 'auto', flex: 1, maxWidth: 860 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 28 }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
            <h1 style={{ fontSize: 22, fontWeight: 700, color: T.textPri }}>Alert Builder</h1>
            <span style={{
              fontSize: 10, fontWeight: 700, color: T.amber,
              background: `${T.amber}18`, border: `1px solid ${T.amber}33`,
              borderRadius: 20, padding: '3px 10px', display: 'flex', alignItems: 'center', gap: 4,
            }}>
              <Zap size={10} /> PRO
            </span>
          </div>
          <p style={{ fontSize: 13, color: T.textMut }}>
            Build intelligent alert rules using natural language conditions.
            Rules fire via your configured Chat Integrations.
          </p>
        </div>
        <div style={{ display: 'flex', gap: 10 }}>
          <button onClick={addRule} style={{
            display: 'flex', alignItems: 'center', gap: 7,
            padding: '8px 16px', borderRadius: 8, border: `1px solid ${T.border}`,
            background: T.bgCard, color: T.textSec, fontSize: 13, cursor: 'pointer',
          }}>
            <Plus size={13} />
            Add Rule
          </button>
          <button onClick={save} style={{
            display: 'flex', alignItems: 'center', gap: 7,
            padding: '8px 16px', borderRadius: 8, border: 'none',
            background: saved ? T.green : `linear-gradient(135deg, ${T.purple}, ${T.cyan})`,
            color: '#fff', fontSize: 13, fontWeight: 600, cursor: 'pointer',
          }}>
            {saved ? <Check size={13} /> : <Bell size={13} />}
            {saved ? 'Saved!' : 'Save Rules'}
          </button>
        </div>
      </div>

      {/* Stats */}
      <div style={{ display: 'flex', gap: 12, marginBottom: 24 }}>
        {[
          { label: 'Total Rules', value: rules.length },
          { label: 'Active', value: rules.filter(r => r.enabled !== false).length, color: T.green },
          { label: 'Disabled', value: rules.filter(r => r.enabled === false).length },
        ].map(s => (
          <div key={s.label} style={{
            background: T.bgCard, borderRadius: 8, padding: '10px 16px',
            border: `1px solid ${T.border}`,
          }}>
            <span style={{ fontSize: 11, color: T.textMut }}>{s.label}: </span>
            <span style={{ fontSize: 14, fontWeight: 700, color: s.color || T.cyan, fontFamily: T.mono }}>
              {s.value}
            </span>
          </div>
        ))}
      </div>

      {rules.map(rule => (
        <RuleEditor
          key={rule.id}
          rule={rule}
          onChange={updated => updateRule(rule.id, updated)}
          onDelete={() => deleteRule(rule.id)}
          allMetrics={allMetrics}
        />
      ))}

      {rules.length === 0 && (
        <div style={{ textAlign: 'center', padding: '60px 0', color: T.textMut, fontSize: 13 }}>
          No rules yet.{' '}
          <button onClick={addRule} style={{ background: 'none', border: 'none', color: T.cyan, cursor: 'pointer', fontSize: 13 }}>
            Add your first rule →
          </button>
        </div>
      )}
    </div>
  )
}

export default function AlertBuilder() {
  const { isProActive } = useLicense()
  if (!isProActive) return <ProGate feature="Alert Builder" />
  return <AlertBuilderContent />
}
