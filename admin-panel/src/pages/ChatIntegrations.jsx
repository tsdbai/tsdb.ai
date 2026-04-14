import { useState, useEffect } from 'react'
import { useTheme } from '../context/ThemeContext'
import { getNotificationConfigs, saveNotificationConfigs } from '../api'
import ProGate from '../components/ProGate'
import { useLicense } from '../context/LicenseContext'
import {
  MessageSquare, Send, Bell, Check, X, Zap, ChevronDown, ChevronUp,
  AlertTriangle, Activity, TrendingUp, RefreshCw
} from 'lucide-react'

const PLATFORMS = [
  {
    id: 'slack',
    name: 'Slack',
    color: '#4A154B',
    accent: '#E01E5A',
    icon: '💬',
    placeholder: 'https://hooks.slack.com/services/T.../B.../...',
    desc: 'Post alerts to a Slack channel via Incoming Webhook',
    docUrl: 'https://api.slack.com/messaging/webhooks',
    testPayload: (cfg) => ({
      url: cfg.webhook_url,
      headers: { 'Content-Type': 'application/json' },
      body: { text: '🧪 TSDB.ai test — Slack integration is active!' },
    }),
  },
  {
    id: 'teams',
    name: 'Microsoft Teams',
    color: '#464775',
    accent: '#6264A7',
    icon: '🟦',
    placeholder: 'https://outlook.office.com/webhook/...',
    desc: 'Send adaptive card messages to a Teams channel',
    docUrl: 'https://learn.microsoft.com/en-us/microsoftteams/platform/webhooks-and-connectors/how-to/add-incoming-webhook',
    testPayload: (cfg) => ({
      url: cfg.webhook_url,
      headers: { 'Content-Type': 'application/json' },
      body: { text: '🧪 TSDB.ai test — Teams integration is active!' },
    }),
  },
  {
    id: 'webex',
    name: 'Webex',
    color: '#00B4A0',
    accent: '#00B4A0',
    icon: '🟢',
    placeholder: '(not used — Webex uses Bot token API directly)',
    desc: 'Post to a Webex Space via Bot token + Room ID',
    docUrl: 'https://developer.webex.com/docs/bots',
    extraFields: [
      { key: 'bot_token', label: 'BOT TOKEN', type: 'password', placeholder: 'OTQy...', desc: 'Bot access token from developer.webex.com (starts with OTQ…)' },
      { key: 'room_id',   label: 'ROOM ID',   type: 'text',     placeholder: 'Y2lzY29zcGFyazovL3...', desc: 'Webex Space (room) ID — copy from the room details URL' },
    ],
    testPayload: (cfg) => ({
      url: 'https://webexapis.com/v1/messages',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.bot_token || ''}` },
      body: { roomId: cfg.room_id || '', text: '🧪 TSDB.ai test — Webex integration is active!' },
    }),
  },
  {
    id: 'telegram',
    name: 'Telegram',
    color: '#229ED9',
    accent: '#229ED9',
    icon: '✈️',
    placeholder: 'https://api.telegram.org/bot<TOKEN>/sendMessage',
    desc: 'Send messages via Telegram Bot API to a chat ID',
    docUrl: 'https://core.telegram.org/bots/api',
    extraFields: [
      { key: 'chat_id', label: 'CHAT ID', type: 'text', placeholder: '-100123456789', desc: 'Numeric chat ID for a group/channel. Use @userinfobot to find yours.' },
    ],
    testPayload: (cfg) => ({
      url: cfg.webhook_url,
      headers: { 'Content-Type': 'application/json' },
      body: { chat_id: cfg.chat_id || '', text: '🧪 TSDB.ai test — Telegram integration is active!' },
    }),
  },
  {
    id: 'pagerduty',
    name: 'PagerDuty',
    color: '#06AC38',
    accent: '#06AC38',
    icon: '🔔',
    placeholder: '(not used — PagerDuty uses its Events API v2 endpoint)',
    desc: 'Trigger PagerDuty incidents via Events API v2',
    docUrl: 'https://developer.pagerduty.com/docs/events-api-v2/overview/',
    extraFields: [
      { key: 'routing_key', label: 'ROUTING KEY', type: 'password', placeholder: 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx', desc: '32-character integration key from your PagerDuty Events API v2 integration' },
    ],
    testPayload: (cfg) => ({
      url: 'https://events.pagerduty.com/v2/enqueue',
      headers: { 'Content-Type': 'application/json' },
      body: {
        routing_key: cfg.routing_key || '',
        event_action: 'trigger',
        payload: { summary: '🧪 TSDB.ai test alert', source: 'tsdb-ai-admin', severity: 'info' },
      },
    }),
  },
]

const TRIGGER_OPTIONS = [
  { id: 'anomaly_high',   label: 'HIGH anomaly detected',    icon: AlertTriangle, color: T.red },
  { id: 'anomaly_medium', label: 'MEDIUM anomaly detected',  icon: AlertTriangle, color: T.amber },
  { id: 'regime_change',  label: 'Regime change detected',   icon: Activity,      color: T.cyan },
  { id: 'forecast_alert', label: 'Forecast threshold breach',icon: TrendingUp,    color: T.purple },
]

const inputStyle = {
  width: '100%', padding: '9px 12px', boxSizing: 'border-box',
  background: T.bgInput, border: `1px solid ${T.border}`, borderRadius: 7,
  color: T.textPri, fontSize: 12, fontFamily: T.mono, outline: 'none',
}

function TestButton({ onTest, status, testNote }) {
  const { T } = useTheme()
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 3, alignItems: 'flex-end', flexShrink: 0 }}>
      <button
        onClick={onTest}
        disabled={status === 'loading'}
        style={{
          display: 'flex', alignItems: 'center', gap: 6,
          padding: '7px 14px', borderRadius: 7,
          border: status === 'ok' ? `1px solid ${T.green}55` : status === 'err' ? `1px solid ${T.red}55` : `1px solid ${T.border}`,
          background: status === 'ok' ? `${T.green}18` : status === 'err' ? `${T.red}18` : T.bgPanel,
          color: status === 'ok' ? T.green : status === 'err' ? T.red : T.textSec,
          fontSize: 12, cursor: status === 'loading' ? 'default' : 'pointer',
        }}
      >
        {status === 'ok' ? <Check size={12} /> :
         status === 'err' ? <X size={12} /> :
         status === 'loading' ? <RefreshCw size={12} style={{ animation: 'spin 1s linear infinite' }} /> :
         <Send size={12} />}
        {status === 'ok' ? 'Sent!' : status === 'err' ? 'Failed' : status === 'loading' ? 'Sending…' : 'Test'}
      </button>
      {testNote && (
        <span style={{ fontSize: 10, color: T.textMut, maxWidth: 200, textAlign: 'right', lineHeight: 1.3 }}>
          {testNote}
        </span>
      )}
    </div>
  )
}

function PlatformCard({ platform, config, onChange }) {
  const { T } = useTheme()
  // Platforms with extra auth fields (Webex, PagerDuty) expand by default if any field is filled
  const hasExtraFields = (platform.extraFields || []).length > 0
  const isConfigured = hasExtraFields
    ? (platform.extraFields || []).some(f => config[f.key])
    : !!config.webhook_url
  const [expanded, setExpanded] = useState(isConfigured)
  const [testStatus, setTestStatus] = useState(null)
  const [testNote, setTestNote] = useState(null)

  const showWebhookUrl = !['webex', 'pagerduty'].includes(platform.id)
  const accent = platform.accent
  const enabled = hasExtraFields
    ? (platform.extraFields || []).every(f => config[f.key])
    : !!config.webhook_url

  const handleTest = async () => {
    if (!platform.testPayload) return
    setTestStatus('loading')
    setTestNote(null)
    const p = platform.testPayload(config)
    if (!p.url || p.url.startsWith('(')) {
      setTestStatus('err')
      setTestNote('Configure all required fields first')
      setTimeout(() => { setTestStatus(null); setTestNote(null) }, 4000)
      return
    }
    try {
      const r = await fetch(p.url, {
        method: 'POST',
        headers: p.headers,
        body: JSON.stringify(p.body),
        signal: AbortSignal.timeout(8000),
      })
      if (r.ok || r.status === 202 || r.status === 204) {
        setTestStatus('ok')
        setTestNote(null)
      } else {
        setTestStatus('err')
        setTestNote(`HTTP ${r.status}`)
      }
    } catch (e) {
      if (e?.message?.includes('CORS') || e?.message?.includes('Failed to fetch') || e?.name === 'TypeError') {
        // CORS blocks browser → tell user to test from server
        setTestStatus('err')
        setTestNote('Browser CORS blocked — will work when fired by the backend')
      } else {
        setTestStatus('err')
        setTestNote(e?.message || 'Network error')
      }
    }
    setTimeout(() => { setTestStatus(null); setTestNote(null) }, 5000)
  }

  const toggleTrigger = (triggerId) => {
    const current = config.triggers || []
    const next = current.includes(triggerId)
      ? current.filter(t => t !== triggerId)
      : [...current, triggerId]
    onChange({ ...config, triggers: next })
  }

  return (
    <div style={{
      background: T.bgCard, borderRadius: 12,
      border: `1px solid ${enabled ? accent + '44' : T.border}`,
      boxShadow: enabled ? `0 0 20px ${accent}11` : 'none',
      overflow: 'hidden', marginBottom: 12,
      transition: 'all 0.2s',
    }}>
      {/* Header row */}
      <div
        style={{
          display: 'flex', alignItems: 'center', gap: 14,
          padding: '14px 18px', cursor: 'pointer',
        }}
        onClick={() => setExpanded(!expanded)}
      >
        <span style={{ fontSize: 20 }}>{platform.icon}</span>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: T.textPri }}>{platform.name}</div>
          <div style={{ fontSize: 11, color: T.textMut, marginTop: 1 }}>{platform.desc}</div>
        </div>
        {enabled && (
          <span style={{
            fontSize: 10, fontWeight: 700, color: T.green,
            background: `${T.green}18`, border: `1px solid ${T.green}33`,
            borderRadius: 20, padding: '3px 10px',
          }}>ACTIVE</span>
        )}
        {expanded ? <ChevronUp size={14} color={T.textMut} /> : <ChevronDown size={14} color={T.textMut} />}
      </div>

      {expanded && (
        <div style={{ padding: '0 18px 18px', borderTop: `1px solid ${T.border}` }}>

          {/* Webhook URL (Slack, Teams, Telegram only) */}
          {showWebhookUrl && (
            <div style={{ marginTop: 14, marginBottom: 12 }}>
              <div style={{ fontSize: 11, color: T.textMut, fontWeight: 700, letterSpacing: '0.07em', marginBottom: 6 }}>
                WEBHOOK URL
              </div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                <input
                  value={config.webhook_url || ''}
                  onChange={e => onChange({ ...config, webhook_url: e.target.value })}
                  placeholder={platform.placeholder}
                  style={{ ...inputStyle, width: undefined, flex: 1 }}
                />
                <TestButton onTest={handleTest} status={testStatus} testNote={testNote} />
              </div>
            </div>
          )}

          {/* Extra auth fields (Webex bot_token/room_id, Telegram chat_id, PagerDuty routing_key) */}
          {(platform.extraFields || []).map((f, idx) => (
            <div key={f.key} style={{ marginBottom: 12, marginTop: idx === 0 && !showWebhookUrl ? 14 : 0 }}>
              <div style={{ fontSize: 11, color: T.textMut, fontWeight: 700, letterSpacing: '0.07em', marginBottom: 4 }}>
                {f.label}
              </div>
              {f.desc && <div style={{ fontSize: 10, color: T.textMut, marginBottom: 5, lineHeight: 1.4 }}>{f.desc}</div>}
              <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                <input
                  type={f.type === 'password' ? 'password' : 'text'}
                  value={config[f.key] || ''}
                  onChange={e => onChange({ ...config, [f.key]: e.target.value })}
                  placeholder={f.placeholder}
                  style={{ ...inputStyle, width: undefined, flex: 1 }}
                />
                {/* Test button appears next to the last extra field when no webhook url shown */}
                {!showWebhookUrl && idx === (platform.extraFields.length - 1) && (
                  <TestButton onTest={handleTest} status={testStatus} testNote={testNote} />
                )}
              </div>
            </div>
          ))}

          {/* Triggers */}
          <div style={{ marginBottom: 4, marginTop: 4 }}>
            <div style={{ fontSize: 11, color: T.textMut, fontWeight: 700, letterSpacing: '0.07em', marginBottom: 8 }}>
              ALERT TRIGGERS
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {TRIGGER_OPTIONS.map(t => {
                const active = (config.triggers || []).includes(t.id)
                const Icon = t.icon
                return (
                  <button
                    key={t.id}
                    onClick={() => toggleTrigger(t.id)}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 6,
                      padding: '5px 12px', borderRadius: 20, border: `1px solid ${active ? t.color + '55' : T.border}`,
                      background: active ? `${t.color}18` : T.bgPanel,
                      color: active ? t.color : T.textMut,
                      fontSize: 11, fontWeight: active ? 700 : 500, cursor: 'pointer',
                    }}
                  >
                    <Icon size={10} />
                    {t.label}
                  </button>
                )
              })}
            </div>
          </div>

          <a href={platform.docUrl} target="_blank" rel="noopener noreferrer"
            style={{ fontSize: 11, color: T.textMut, textDecoration: 'none', marginTop: 10, display: 'inline-block' }}
          >
            Setup docs →
          </a>
        </div>
      )}
    </div>
  )
}

function ChatIntegrationsContent() {
  const { T } = useTheme()

  const [configs, setConfigs] = useState({})
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    const d = getNotificationConfigs()
    setConfigs((d && !Array.isArray(d)) ? d : {})
  }, [])

  const save = async () => {
    setSaving(true)
    await saveNotificationConfigs(configs)
    setSaving(false)
    setSaved(true)
    setTimeout(() => setSaved(false), 2500)
  }

  const updateConfig = (platformId, cfg) => {
    setConfigs(prev => ({ ...prev, [platformId]: cfg }))
  }

  const activeCount = PLATFORMS.filter(p => {
    const cfg = configs[p.id] || {}
    if (p.extraFields?.length) return p.extraFields.every(f => cfg[f.key])
    return !!cfg.webhook_url
  }).length

  return (
    <div style={{ padding: '28px 32px', overflowY: 'auto', flex: 1, maxWidth: 820 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 28 }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
            <h1 style={{ fontSize: 22, fontWeight: 700, color: T.textPri }}>Chat Integrations</h1>
            <span style={{
              fontSize: 10, fontWeight: 700, color: T.amber,
              background: `${T.amber}18`, border: `1px solid ${T.amber}33`,
              borderRadius: 20, padding: '3px 10px', display: 'flex', alignItems: 'center', gap: 4,
            }}>
              <Zap size={10} /> PRO
            </span>
          </div>
          <p style={{ fontSize: 13, color: T.textMut }}>
            Route anomaly alerts and regime changes to your team's chat platforms.
            {activeCount > 0 && <span style={{ color: T.green }}> {activeCount} active integration{activeCount > 1 ? 's' : ''}.</span>}
          </p>
        </div>
        <button
          onClick={save}
          disabled={saving}
          style={{
            display: 'flex', alignItems: 'center', gap: 7,
            padding: '9px 20px', borderRadius: 8, border: 'none',
            background: saved ? T.green : `linear-gradient(135deg, ${T.purple}, ${T.cyan})`,
            color: '#fff', fontSize: 13, fontWeight: 600, cursor: 'pointer',
            transition: 'background 0.3s',
          }}
        >
          {saved ? <Check size={14} /> : <Send size={14} />}
          {saving ? 'Saving…' : saved ? 'Saved!' : 'Save Config'}
        </button>
      </div>

      {PLATFORMS.map(platform => (
        <PlatformCard
          key={platform.id}
          platform={platform}
          config={configs[platform.id] || {}}
          onChange={cfg => updateConfig(platform.id, cfg)}
        />
      ))}

      {/* Info footer */}
      <div style={{
        marginTop: 20, padding: '14px 18px', background: T.bgPanel,
        borderRadius: 10, border: `1px solid ${T.border}`,
        fontSize: 12, color: T.textMut, lineHeight: 1.6,
      }}>
        <strong style={{ color: T.textSec }}>How it works:</strong> When TSDB detects a triggered event, it will POST
        a formatted message to each enabled webhook. Messages include the metric name, severity, reason,
        RMSE deviation, and a link to the admin panel. Triggers fire at most once per metric per 5-minute window
        to prevent alert floods.
      </div>
    </div>
  )
}

export default function ChatIntegrations() {
  const { isProActive } = useLicense()
  if (!isProActive) return <ProGate feature="Chat Integrations" />
  return <ChatIntegrationsContent />
}
