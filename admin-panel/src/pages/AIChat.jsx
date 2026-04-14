import { useState, useEffect, useRef } from 'react'
import {
  ResponsiveContainer, LineChart, BarChart, AreaChart,
  Line, Bar, Area, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
  ReferenceLine, ReferenceArea,
} from 'recharts'
import { useTheme } from '../context/ThemeContext'
import { getAICredentials, saveAICredentials } from '../api'
import {
  fetchFullContext,
  extractMentionedMetrics,
  enrichWithMetricData,
  buildSystemPrompt as buildRichPrompt,
} from '../contextEngine'
import {
  Bot, Send, User, Settings, ChevronDown, ChevronUp,
  Eye, EyeOff, RefreshCw, Zap, AlertTriangle, X, Key, BarChart3,
} from 'lucide-react'

// ─── Chart utilities ─────────────────────────────────────────────────────────

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

async function queryMetricRange(metricName, durationSeconds = 3600) {
  const end = Math.floor(Date.now() / 1000)
  const start = end - durationSeconds
  const step = Math.max(15, Math.floor(durationSeconds / 300))
  const url =
    `${getQueryUrl()}/api/v1/query_range` +
    `?query=${encodeURIComponent(metricName)}&start=${start}&end=${end}&step=${step}`
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(6000) })
    const json = await res.json()
    return (json.data?.result || []).map(series => ({
      name: series.metric.__name__ || metricName,
      labels: series.metric,
      data: series.values.map(([ts, v]) => ({
        t: new Date(ts * 1000).toLocaleTimeString('en', { hour: '2-digit', minute: '2-digit' }),
        v: parseFloat(v),
      })),
    }))
  } catch {
    return []
  }
}

// Parse <CHART>…</CHART> from an AI response.
// Returns { clean: textWithoutBlock, spec: parsedObject | null }
function parseChartBlock(text) {
  // Primary: explicit <CHART> tags
  const m = text.match(/<CHART>([\s\S]*?)<\/CHART>/)
  if (m) {
    try {
      const spec = JSON.parse(m[1].trim())
      return { clean: text.replace(m[0], '').trim(), spec }
    } catch {
      return { clean: text, spec: null }
    }
  }

  // Fallback: JSON code blocks that look like chart specs
  // (AI sometimes emits ```json {...}``` instead of <CHART> tags)
  const codeBlockRe = /```(?:json)?\s*(\{[\s\S]*?\})\s*```/g
  let cbMatch
  while ((cbMatch = codeBlockRe.exec(text)) !== null) {
    try {
      const candidate = JSON.parse(cbMatch[1].trim())
      if (candidate.series || candidate.overlays || candidate.type === 'line'
          || candidate.type === 'bar' || candidate.type === 'area') {
        return { clean: text.replace(cbMatch[0], '').trim(), spec: candidate }
      }
    } catch { /* skip */ }
  }

  return { clean: text, spec: null }
}

// Fetch real TSDB data for any series that have a `metric` key but no `data`.
async function resolveChartSpec(spec) {
  if (!spec?.series?.length) return spec
  const needsFetch = spec.series.some(s => s.metric && !s.data?.length)
  if (!needsFetch) return spec
  const resolved = {
    ...spec,
    series: await Promise.all(spec.series.map(async s => {
      if (!s.metric) return s
      try {
        const results = await queryMetricRange(s.metric, 3600)
        const best = results.find(r => r.name === s.metric) || results[0]
        return best ? { ...s, data: best.data } : s
      } catch {
        return s
      }
    })),
  }
  return resolved
}

const CHART_COLORS = ['#06b6d4','#7c3aed','#10b981','#f59e0b','#ef4444','#3b82f6','#ec4899','#84cc16']

function ChartBlock({ spec }) {
  const { T } = useTheme()
  if (!spec?.series?.length) return null

  const allTimes = [...new Set(spec.series.flatMap(s => (s.data || []).map(d => d.t)))]
  if (allTimes.length === 0) {
    return (
      <div style={{
        marginTop: 12, padding: '14px 18px', borderRadius: 10,
        background: `${T.amber}12`, border: `1px solid ${T.amber}33`,
        fontSize: 12, color: T.amber,
      }}>
        ⚠ No data returned for this metric. Check the metric name or ensure the backend is ingesting data.
      </div>
    )
  }

  const rows = allTimes.map(t => {
    const row = { time: t }
    spec.series.forEach(s => {
      const pt = (s.data || []).find(d => d.t === t)
      if (pt != null) row[s.name] = pt.v
    })
    return row
  })

  const type  = spec.type || 'line'
  const lw    = spec.lineWidth ?? 2
  const grid  = spec.showGrid !== false
  const axisStyle = { fontSize: 11, fill: T.textMut }
  const tooltipStyle = {
    contentStyle: { background: T.bgCard, border: `1px solid ${T.border}`, borderRadius: 8, fontSize: 12 },
    labelStyle: { color: T.textSec }, itemStyle: { color: T.textPri },
  }
  const sharedProps = { data: rows, margin: { top: 8, right: 20, left: 0, bottom: 0 } }

  const axes = (
    <>
      {grid && <CartesianGrid strokeDasharray="3 3" stroke={T.border} />}
      <XAxis dataKey="time" tick={axisStyle} tickLine={false} axisLine={false} />
      <YAxis
        tick={axisStyle} tickLine={false} axisLine={false}
        label={spec.yLabel ? { value: spec.yLabel, angle: -90, position: 'insideLeft', fill: T.textMut, fontSize: 11 } : undefined}
        width={spec.yLabel ? 52 : 36}
      />
      <Tooltip {...tooltipStyle} />
      <Legend wrapperStyle={{ fontSize: 11, color: T.textSec }} />
    </>
  )

  const seriesElements = spec.series.map((s, i) => {
    const color = s.color || CHART_COLORS[i % CHART_COLORS.length]
    if (type === 'bar')  return <Bar  key={s.name} dataKey={s.name} name={s.label || s.name} fill={color} opacity={0.85} />
    if (type === 'area') return <Area key={s.name} dataKey={s.name} name={s.label || s.name} stroke={color} fill={color + '33'} strokeWidth={lw} dot={false} type="monotone" />
    return <Line key={s.name} dataKey={s.name} name={s.label || s.name} stroke={color} strokeWidth={lw} dot={false} type="monotone" />
  })

  return (
    <div style={{
      marginTop: 14, borderRadius: 12,
      background: T.bgCard, border: `1px solid ${T.border}`,
      overflow: 'hidden',
    }}>
      {spec.title && (
        <div style={{
          padding: '10px 16px', borderBottom: `1px solid ${T.border}`,
          display: 'flex', alignItems: 'center', gap: 8,
        }}>
          <BarChart3 size={13} color={T.cyan} />
          <span style={{ fontSize: 13, fontWeight: 600, color: T.textPri }}>{spec.title}</span>
          <span style={{ fontSize: 11, color: T.textMut, marginLeft: 4 }}>{type} · last 1h</span>
        </div>
      )}
      <div style={{ height: 220, padding: '8px 4px 4px' }}>
        <ResponsiveContainer width="100%" height="100%">
          {type === 'bar'
            ? <BarChart  {...sharedProps}>{axes}{seriesElements}</BarChart>
            : type === 'area'
            ? <AreaChart {...sharedProps}>{axes}{seriesElements}</AreaChart>
            : <LineChart {...sharedProps}>{axes}{seriesElements}</LineChart>
          }
        </ResponsiveContainer>
      </div>
    </div>
  )
}

// ─── Provider config ──────────────────────────────────────────────────────────

const PROVIDERS = {
  openai: {
    name: 'OpenAI',
    icon: '🟢',
    color: '#10a37f',
    models: ['gpt-4o', 'gpt-4-turbo', 'gpt-4o-mini', 'gpt-3.5-turbo'],
    placeholder: 'sk-...',
    keyHint: 'Find your key at platform.openai.com/api-keys',
    docsUrl: 'https://platform.openai.com/docs/api-reference/chat',
  },
  anthropic: {
    name: 'Anthropic',
    icon: '🔶',
    color: '#d97706',
    models: ['claude-sonnet-4-6', 'claude-opus-4-6', 'claude-haiku-4-5-20251001'],
    placeholder: 'sk-ant-...',
    keyHint: 'Find your key at console.anthropic.com/settings/keys',
    docsUrl: 'https://docs.anthropic.com/en/api/messages',
  },
  local: {
    name: 'Local LLM',
    icon: '🖥️',
    color: '#22c55e',
    models: [],   // free-text — depends on what the user has installed
    placeholder: '',
    keyHint: 'Optional — leave blank for Ollama / llama.cpp (no auth required)',
    docsUrl: 'https://github.com/ollama/ollama',
  },
}

// ─── API call helpers ─────────────────────────────────────────────────────────

async function callOpenAI(apiKey, model, messages) {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    signal: AbortSignal.timeout(60000),
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ model, messages, temperature: 0.7, max_tokens: 2048 }),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(err?.error?.message || `OpenAI API error ${res.status}`)
  }
  const data = await res.json()
  return data.choices?.[0]?.message?.content || ''
}

async function callAnthropic(apiKey, model, messages) {
  // Extract system message and user/assistant messages
  const sysMsg = messages.find(m => m.role === 'system')
  const chatMsgs = messages.filter(m => m.role !== 'system')

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    signal: AbortSignal.timeout(60000),
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model,
      max_tokens: 2048,
      system: sysMsg?.content || '',
      messages: chatMsgs,
    }),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(err?.error?.message || `Anthropic API error ${res.status}`)
  }
  const data = await res.json()
  return data.content?.[0]?.text || ''
}

// Calls any OpenAI-compatible endpoint (Ollama, LM Studio, llama.cpp, vLLM…)
async function callLocal(baseUrl, model, messages, apiKey) {
  const url = (baseUrl || 'http://localhost:11434').replace(/\/$/, '') + '/v1/chat/completions'
  const headers = { 'Content-Type': 'application/json' }
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`
  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ model, messages, temperature: 0.7, stream: false }),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(err?.error?.message || `Local LLM error ${res.status} — is ${baseUrl} running?`)
  }
  const data = await res.json()
  return data.choices?.[0]?.message?.content || ''
}

// ─── UI helpers ──────────────────────────────────────────────────────────────

function ProviderButton({ id, provider, selected, onClick }) {
  const { T } = useTheme()
  return (
    <button
      onClick={() => onClick(id)}
      style={{
        display: 'flex', alignItems: 'center', gap: 8,
        padding: '8px 16px', borderRadius: 8, cursor: 'pointer', fontSize: 13,
        border: selected ? `1px solid ${provider.color}66` : `1px solid ${T.border}`,
        background: selected ? `${provider.color}18` : T.bgPanel,
        color: selected ? T.textPri : T.textSec,
        fontWeight: selected ? 700 : 500,
        transition: 'all 0.15s',
      }}
    >
      <span>{provider.icon}</span>
      {provider.name}
    </button>
  )
}

function Message({ msg }) {
  const { T } = useTheme()
  const isUser  = msg.role === 'user'
  const isError = msg.role === 'error'

  return (
    <div style={{
      display: 'flex', gap: 12, alignItems: 'flex-start',
      justifyContent: isUser ? 'flex-end' : 'flex-start',
      marginBottom: 16,
    }}>
      {!isUser && (
        <div style={{
          width: 30, height: 30, borderRadius: '50%', flexShrink: 0,
          background: isError ? `${T.red}22` : `linear-gradient(135deg, ${T.purple}, ${T.cyan})`,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          boxShadow: isError ? glow.red : glow.purple,
        }}>
          {isError ? <AlertTriangle size={14} color={T.red} /> : <Bot size={14} color="#fff" />}
        </div>
      )}

      <div style={{
        maxWidth: msg.chartSpec ? '90%' : '75%',
        padding: '10px 14px',
        borderRadius: isUser ? '14px 14px 4px 14px' : '4px 14px 14px 14px',
        background: isUser
          ? `linear-gradient(135deg, ${T.purple}cc, ${T.cyan}99)`
          : isError
            ? `${T.red}14`
            : T.bgCard,
        border: isUser
          ? 'none'
          : `1px solid ${isError ? T.red + '33' : T.border}`,
        color: isUser ? '#fff' : isError ? T.red : T.textPri,
        fontSize: 13,
        lineHeight: 1.65,
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
        minWidth: msg.chartSpec ? 420 : undefined,
      }}>
        {msg.content}
        {msg.chartSpec && <ChartBlock spec={msg.chartSpec} />}
      </div>

      {isUser && (
        <div style={{
          width: 30, height: 30, borderRadius: '50%', flexShrink: 0,
          background: `${T.border}88`,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <User size={14} color={T.textSec} />
        </div>
      )}
    </div>
  )
}

function ThinkingDot() {
  const { T } = useTheme()
  return (
    <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start', marginBottom: 16 }}>
      <div style={{
        width: 30, height: 30, borderRadius: '50%', flexShrink: 0,
        background: `linear-gradient(135deg, ${T.purple}, ${T.cyan})`,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>
        <Bot size={14} color="#fff" />
      </div>
      <div style={{
        padding: '12px 16px', borderRadius: '4px 14px 14px 14px',
        background: T.bgCard, border: `1px solid ${T.border}`,
        display: 'flex', alignItems: 'center', gap: 6,
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

// ─── Suggestion chips ─────────────────────────────────────────────────────────

const SUGGESTIONS = [
  'What anomalies are active right now?',
  'Explain how polynomial model compression works',
  'How do I tune the RMSE tolerance for my workload?',
  'What does "regime change" mean in TSDB.ai?',
  'How should I configure S3 tiered storage?',
  'Why is my WAL queue depth high?',
  'Write a PromQL query to find my top-5 metrics by value',
  'What are the best practices for cardinality management?',
]

// ─── Main component ───────────────────────────────────────────────────────────

export default function AIChat() {
  const { T } = useTheme()
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

  const [messages, setMessages] = useState([])
  const [input, setInput] = useState('')
  const [thinking, setThinking] = useState(false)
  const [context, setContext] = useState(null)

  const messagesEndRef = useRef(null)
  const inputRef = useRef(null)

  // Load full context on mount
  useEffect(() => {
    fetchFullContext().then(setContext)
  }, [])

  // Auto-scroll
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, thinking])

  const handleProviderChange = (p) => {
    setProvider(p)
    if (p !== 'local') setModel(PROVIDERS[p].models[0])
  }

  const saveCreds = () => {
    const c = { provider, model, apiKey, local_url: localUrl, local_model: localModel }
    saveAICredentials(c)
    setCreds(c)
    setCredsSaved(true)
    setTimeout(() => setCredsSaved(false), 2000)
    if (apiKey) setSettingsOpen(false)
  }

  const sendMessage = async (text) => {
    const userText = (text || input).trim()
    if (!userText) return
    if (provider !== 'local' && !apiKey) { setSettingsOpen(true); return }

    setInput('')
    const userMsg = { role: 'user', content: userText }
    const newMessages = [...messages, userMsg]
    setMessages(newMessages)
    setThinking(true)

    try {
      // Build full message list with rich system prompt
      const knownMetrics = context?.metricNames || []
      const mentioned = extractMentionedMetrics(userText, knownMetrics)
      const anomalyList = context?.anomalies?.anomalies || context?.anomalies || []
      const activeAnomalyNames = Array.isArray(anomalyList)
        ? anomalyList.map(a => a.metric_string).filter(Boolean)
        : []
      const metricData = mentioned.length
        ? await enrichWithMetricData(mentioned, activeAnomalyNames)
        : {}
      const systemPrompt = buildRichPrompt(context || {}, 'data', null, metricData)
      const apiMessages = [
        { role: 'system', content: systemPrompt },
        ...newMessages.map(m => ({ role: m.role === 'error' ? 'assistant' : m.role, content: m.content })),
      ]

      let reply
      if (provider === 'openai') {
        reply = await callOpenAI(apiKey, model, apiMessages)
      } else if (provider === 'anthropic') {
        reply = await callAnthropic(apiKey, model, apiMessages)
      } else {
        reply = await callLocal(localUrl, localModel, apiMessages, apiKey)
      }

      if (!reply || !reply.trim()) {
        setMessages(prev => [...prev, {
          role: 'error',
          content: 'The AI returned an empty response. This can happen if the model hit its output limit or if a content filter was triggered. Try rephrasing your question.',
        }])
      } else {
        // Parse any embedded <CHART> block
        const { clean, spec: rawSpec } = parseChartBlock(reply)
        if (rawSpec) {
          // Fetch real TSDB data for series that only have a metric name
          const resolvedSpec = await resolveChartSpec(rawSpec)
          setMessages(prev => [...prev, { role: 'assistant', content: clean, chartSpec: resolvedSpec }])
        } else {
          setMessages(prev => [...prev, { role: 'assistant', content: clean }])
        }
      }
    } catch (err) {
      setMessages(prev => [...prev, {
        role: 'error',
        content: `API error: ${err.message}\n\nCheck your API key and model selection in settings above.`,
      }])
    } finally {
      setThinking(false)
      inputRef.current?.focus()
    }
  }

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      sendMessage()
    }
  }

  const refreshContext = async () => {
    const ctx = await fetchFullContext()
    setContext(ctx)
  }

  const p = PROVIDERS[provider]

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <style>{`
        @keyframes bounce {
          0%, 80%, 100% { transform: translateY(0); opacity: 0.4; }
          40% { transform: translateY(-6px); opacity: 1; }
        }
      `}</style>

      {/* Header */}
      <div style={{
        padding: '18px 28px', borderBottom: `1px solid ${T.border}`,
        background: T.bgPanel, display: 'flex', alignItems: 'center', gap: 14,
      }}>
        <div style={{
          width: 38, height: 38, borderRadius: '50%',
          background: `linear-gradient(135deg, ${T.purple}, ${T.cyan})`,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          boxShadow: glow.purple, flexShrink: 0,
        }}>
          <Bot size={18} color="#fff" />
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 16, fontWeight: 700, color: T.textPri }}>TSDB.ai Assistant</span>
            {(creds.apiKey || creds.provider === 'local') && (
              <span style={{
                fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 10,
                background: `${p.color}22`, border: `1px solid ${p.color}44`, color: p.color,
              }}>
                {p.icon} {p.name} · {creds.provider === 'local' ? (creds.local_model || localModel) : model}
              </span>
            )}
          </div>
          <p style={{ fontSize: 12, color: T.textMut, marginTop: 2 }}>
            Ask anything about your TSDB.ai instance — anomalies, config, forecasts, PromQL, and more.
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
          <button
            onClick={refreshContext}
            title="Refresh live instance context"
            style={{
              display: 'flex', alignItems: 'center', gap: 5,
              padding: '6px 12px', borderRadius: 7, border: `1px solid ${T.border}`,
              background: T.bgCard, color: T.textSec, fontSize: 11, cursor: 'pointer',
            }}
          >
            <RefreshCw size={12} />
            Refresh context
          </button>
          <button
            onClick={() => setSettingsOpen(o => !o)}
            style={{
              display: 'flex', alignItems: 'center', gap: 5,
              padding: '6px 12px', borderRadius: 7,
              border: `1px solid ${settingsOpen ? T.purple + '66' : T.border}`,
              background: settingsOpen ? `${T.purple}18` : T.bgCard,
              color: settingsOpen ? T.purpleL : T.textSec,
              fontSize: 11, cursor: 'pointer',
            }}
          >
            <Key size={12} />
            API Key
            {settingsOpen ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
          </button>
        </div>
      </div>

      {/* API key settings panel */}
      {settingsOpen && (
        <div style={{
          padding: '16px 28px', borderBottom: `1px solid ${T.border}`,
          background: T.bgCard,
        }}>
          {!creds.apiKey && (
            <div style={{
              display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14,
              padding: '10px 14px', borderRadius: 8,
              background: `${T.amber}12`, border: `1px solid ${T.amber}44`,
            }}>
              <AlertTriangle size={14} color={T.amber} />
              <span style={{ fontSize: 12, color: T.amber }}>
                Enter an API key to start chatting. Your key is stored only in your browser's local storage and never leaves your machine.
              </span>
            </div>
          )}

          <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', alignItems: 'flex-end' }}>
            {/* Provider */}
            <div>
              <div style={{ fontSize: 11, fontWeight: 700, color: T.textMut, marginBottom: 8, letterSpacing: '0.07em' }}>PROVIDER</div>
              <div style={{ display: 'flex', gap: 8 }}>
                {Object.entries(PROVIDERS).map(([id, prov]) => (
                  <ProviderButton key={id} id={id} provider={prov} selected={provider === id} onClick={handleProviderChange} />
                ))}
              </div>
            </div>

            {/* Local LLM: base URL + model text field */}
            {provider === 'local' ? (<>
              <div style={{ minWidth: 240 }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: T.textMut, marginBottom: 8, letterSpacing: '0.07em' }}>BASE URL</div>
                <input
                  value={localUrl}
                  onChange={e => setLocalUrl(e.target.value)}
                  placeholder="http://localhost:11434"
                  style={{
                    width: '100%', boxSizing: 'border-box', padding: '9px 12px',
                    background: T.bgInput, border: `1px solid ${T.border}`, borderRadius: 8,
                    color: T.textPri, fontSize: 13, fontFamily: T.mono, outline: 'none',
                  }}
                />
                <div style={{ fontSize: 10, color: T.textMut, marginTop: 4 }}>
                  Ollama: <code style={{ color: T.cyan }}>:11434</code> · LM Studio: <code style={{ color: T.cyan }}>:1234</code> · llama.cpp: <code style={{ color: T.cyan }}>:8000</code>
                </div>
              </div>
              <div style={{ minWidth: 180 }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: T.textMut, marginBottom: 8, letterSpacing: '0.07em' }}>MODEL NAME</div>
                <input
                  value={localModel}
                  onChange={e => setLocalModel(e.target.value)}
                  placeholder="llama3, mistral, phi3…"
                  style={{
                    width: '100%', boxSizing: 'border-box', padding: '9px 12px',
                    background: T.bgInput, border: `1px solid ${T.border}`, borderRadius: 8,
                    color: T.textPri, fontSize: 13, fontFamily: T.mono, outline: 'none',
                  }}
                />
                <div style={{ fontSize: 10, color: T.textMut, marginTop: 4 }}>
                  Must match a model you've already pulled
                </div>
              </div>
              <div style={{ minWidth: 200 }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: T.textMut, marginBottom: 8, letterSpacing: '0.07em' }}>
                  API KEY <span style={{ fontWeight: 400, color: T.textMut }}>(optional)</span>
                </div>
                <div style={{ position: 'relative' }}>
                  <input
                    type={showKey ? 'text' : 'password'}
                    value={apiKey}
                    onChange={e => setApiKey(e.target.value)}
                    placeholder="Leave blank if no auth"
                    style={{
                      width: '100%', boxSizing: 'border-box',
                      padding: '9px 36px 9px 12px',
                      background: T.bgInput, border: `1px solid ${T.border}`, borderRadius: 8,
                      color: T.textPri, fontSize: 13, fontFamily: T.mono, outline: 'none',
                    }}
                  />
                  <button onClick={() => setShowKey(s => !s)} style={{ position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', color: T.textMut, padding: 2 }}>
                    {showKey ? <EyeOff size={14} /> : <Eye size={14} />}
                  </button>
                </div>
              </div>
            </>) : (<>
              {/* Cloud: model select + API key */}
              <div style={{ minWidth: 200 }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: T.textMut, marginBottom: 8, letterSpacing: '0.07em' }}>MODEL</div>
                <select
                  value={model}
                  onChange={e => setModel(e.target.value)}
                  style={{
                    padding: '9px 12px', borderRadius: 8, border: `1px solid ${T.border}`,
                    background: T.bgInput, color: T.textPri, fontSize: 13,
                    fontFamily: T.mono, outline: 'none', cursor: 'pointer', minWidth: 200,
                  }}
                >
                  {PROVIDERS[provider].models.map(m => (
                    <option key={m} value={m}>{m}</option>
                  ))}
                </select>
              </div>

              <div style={{ flex: 1, minWidth: 280 }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: T.textMut, marginBottom: 8, letterSpacing: '0.07em' }}>
                  API KEY
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <div style={{ flex: 1, position: 'relative' }}>
                    <input
                      type={showKey ? 'text' : 'password'}
                      value={apiKey}
                      onChange={e => setApiKey(e.target.value)}
                      placeholder={PROVIDERS[provider].placeholder}
                      style={{
                        width: '100%', boxSizing: 'border-box',
                        padding: '9px 36px 9px 12px',
                        background: T.bgInput, border: `1px solid ${T.border}`, borderRadius: 8,
                        color: T.textPri, fontSize: 13, fontFamily: T.mono, outline: 'none',
                      }}
                    />
                    <button
                      onClick={() => setShowKey(s => !s)}
                      style={{
                        position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)',
                        background: 'none', border: 'none', cursor: 'pointer', color: T.textMut, padding: 2,
                      }}
                    >
                      {showKey ? <EyeOff size={14} /> : <Eye size={14} />}
                    </button>
                  </div>
                  <button
                    onClick={saveCreds}
                    style={{
                      padding: '9px 18px', borderRadius: 8, border: 'none', cursor: 'pointer',
                      background: credsSaved ? T.green : `linear-gradient(135deg, ${T.purple}, ${T.cyan})`,
                      color: '#fff', fontSize: 13, fontWeight: 600, flexShrink: 0,
                      boxShadow: credsSaved ? glow.green : glow.purple,
                      transition: 'background 0.3s',
                    }}
                  >
                    {credsSaved ? '✓ Saved' : 'Save'}
                  </button>
                </div>
                <div style={{ fontSize: 10, color: T.textMut, marginTop: 5 }}>
                  {PROVIDERS[provider].keyHint} ·{' '}
                  <a href={PROVIDERS[provider].docsUrl} target="_blank" rel="noopener noreferrer" style={{ color: T.cyan }}>API docs</a>
                </div>
              </div>
            </>)}

            {/* Save button for local provider */}
            {provider === 'local' && (
              <div style={{ display: 'flex', alignItems: 'flex-end' }}>
                <button
                  onClick={saveCreds}
                  style={{
                    padding: '9px 18px', borderRadius: 8, border: 'none', cursor: 'pointer',
                    background: credsSaved ? T.green : `linear-gradient(135deg, ${T.purple}, ${T.cyan})`,
                    color: '#fff', fontSize: 13, fontWeight: 600,
                    boxShadow: credsSaved ? glow.green : glow.purple,
                    transition: 'background 0.3s',
                  }}
                >
                  {credsSaved ? '✓ Saved' : 'Save'}
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Messages */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '20px 28px' }}>
        {messages.length === 0 && (
          <div style={{ maxWidth: 640, margin: '0 auto', textAlign: 'center', paddingTop: 32 }}>
            <div style={{
              width: 64, height: 64, borderRadius: '50%', margin: '0 auto 20px',
              background: `linear-gradient(135deg, ${T.purpleDim}, ${T.cyanDim})`,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              border: `2px solid ${T.purple}`, boxShadow: glow.purple,
            }}>
              <Bot size={26} color={T.cyanL} />
            </div>
            <h2 style={{ fontSize: 20, fontWeight: 700, color: T.textPri, marginBottom: 8 }}>
              TSDB.ai Assistant
            </h2>
            <p style={{ fontSize: 13, color: T.textMut, lineHeight: 1.7, marginBottom: 28, maxWidth: 420, margin: '0 auto 28px' }}>
              I have live context about your TSDB.ai instance — active anomalies,
              ingestion metrics, series count, and more. Ask me anything.
            </p>

            {/* Context snapshot pills */}
            {context?.metrics && (
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'center', marginBottom: 28 }}>
                {[
                  { label: 'Active series', value: context.metrics.unique_series_active?.toLocaleString() },
                  { label: 'Anomalies', value: context.metrics.anomalies_detected, color: context.metrics.anomalies_detected > 0 ? T.red : T.green },
                  { label: 'Avg RMSE', value: context.metrics.average_rmse?.toFixed(3) },
                  { label: 'WAL queue', value: context.metrics.wal_queue_depth },
                ].filter(p => p.value !== undefined).map(pill => (
                  <div key={pill.label} style={{
                    padding: '5px 12px', borderRadius: 20,
                    background: T.bgCard, border: `1px solid ${T.border}`,
                    fontSize: 11, color: T.textMut,
                  }}>
                    {pill.label}: <strong style={{ color: pill.color || T.textSec }}>{pill.value}</strong>
                  </div>
                ))}
              </div>
            )}

            {/* Suggestion chips */}
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, justifyContent: 'center' }}>
              {SUGGESTIONS.map(s => (
                <button
                  key={s}
                  onClick={() => sendMessage(s)}
                  disabled={!apiKey}
                  style={{
                    padding: '7px 14px', borderRadius: 20,
                    border: `1px solid ${T.border}`,
                    background: T.bgCard, color: apiKey ? T.textSec : T.textMut,
                    fontSize: 12, cursor: apiKey ? 'pointer' : 'not-allowed',
                    transition: 'all 0.15s',
                    opacity: apiKey ? 1 : 0.5,
                  }}
                >
                  {s}
                </button>
              ))}
            </div>
            {!apiKey && (
              <div style={{ marginTop: 16, fontSize: 12, color: T.textMut }}>
                ↑ Enter an API key above to enable chat
              </div>
            )}
          </div>
        )}

        {messages.map((msg, i) => <Message key={i} msg={msg} />)}
        {thinking && <ThinkingDot />}
        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <div style={{
        padding: '14px 24px 18px',
        borderTop: `1px solid ${T.border}`,
        background: T.bgPanel,
      }}>
        {messages.length > 0 && (
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10 }}>
            {['What anomalies are active?', 'Suggest config improvements', 'Explain the latest regime change', 'Write a PromQL query'].map(s => (
              <button
                key={s}
                onClick={() => sendMessage(s)}
                disabled={thinking || !apiKey}
                style={{
                  padding: '4px 11px', borderRadius: 12,
                  border: `1px solid ${T.border}`, background: T.bgCard,
                  color: T.textMut, fontSize: 11, cursor: 'pointer',
                }}
              >
                {s}
              </button>
            ))}
          </div>
        )}
        <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end' }}>
          <textarea
            ref={inputRef}
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={apiKey ? 'Ask about your TSDB.ai instance… (Enter to send, Shift+Enter for newline)' : 'Enter an API key in settings to start chatting'}
            disabled={!apiKey || thinking}
            rows={1}
            style={{
              flex: 1, padding: '11px 14px', borderRadius: 10, resize: 'none',
              border: `1px solid ${T.border}`, background: T.bgInput,
              color: T.textPri, fontSize: 13, fontFamily: 'inherit', outline: 'none',
              lineHeight: 1.5, maxHeight: 120, overflowY: 'auto',
              opacity: !apiKey ? 0.5 : 1,
            }}
          />
          <button
            onClick={() => sendMessage()}
            disabled={!input.trim() || !apiKey || thinking}
            style={{
              width: 42, height: 42, borderRadius: 10, border: 'none', cursor: 'pointer',
              background: input.trim() && apiKey && !thinking
                ? `linear-gradient(135deg, ${T.purple}, ${T.cyan})`
                : T.bgCard,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              boxShadow: input.trim() && apiKey ? glow.purple : 'none',
              transition: 'all 0.2s', flexShrink: 0,
            }}
          >
            {thinking
              ? <RefreshCw size={16} color={T.textMut} style={{ animation: 'spin 1s linear infinite' }} />
              : <Send size={16} color={input.trim() && apiKey ? '#fff' : T.textMut} />
            }
          </button>
        </div>
        <div style={{ fontSize: 10, color: T.textMut, marginTop: 6, textAlign: 'center' }}>
          API calls go directly from your browser to {PROVIDERS[provider].name}. Your key and messages never pass through TSDB.ai servers.
        </div>
      </div>
    </div>
  )
}
