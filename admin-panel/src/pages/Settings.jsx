import { useState } from 'react'
import { useTheme } from '../context/ThemeContext'
import { Settings as SettingsIcon, Check, X, Server, Key, RefreshCw, Shield,
         Globe, Star, Zap, Lock, AlertTriangle, Clock } from 'lucide-react'
import { useLicense } from '../context/LicenseContext'

const DEFAULT_BACKEND = 'http://localhost:8080'

function Section({ title, icon: Icon, color, children }) {
  const { T } = useTheme()
  const c = color || T.cyan
  return (
    <div style={{
      background: T.bgCard, borderRadius: 12, padding: '22px 24px',
      border: `1px solid ${T.border}`, marginBottom: 18,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 18 }}>
        <div style={{
          width: 32, height: 32, borderRadius: 8,
          background: `${c}18`, border: `1px solid ${c}33`,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <Icon size={15} color={c} />
        </div>
        <span style={{ fontSize: 15, fontWeight: 700, color: T.textPri }}>{title}</span>
      </div>
      {children}
    </div>
  )
}

function FieldRow({ label, hint, children }) {
  const { T } = useTheme()
  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{ fontSize: 12, fontWeight: 700, color: T.textSec, marginBottom: 4 }}>{label}</div>
      {hint && <div style={{ fontSize: 11, color: T.textMut, marginBottom: 6 }}>{hint}</div>}
      {children}
    </div>
  )
}

function InputField({ value, onChange, placeholder, type = 'text', mono = false }) {
  const { T } = useTheme()
  return (
    <input
      type={type}
      value={value}
      onChange={e => onChange(e.target.value)}
      placeholder={placeholder}
      style={{
        width: '100%', padding: '9px 12px', boxSizing: 'border-box',
        background: T.bgInput, border: `1px solid ${T.border}`, borderRadius: 7,
        color: T.textPri, fontSize: 13,
        fontFamily: mono ? T.mono : 'inherit',
        outline: 'none',
      }}
    />
  )
}

// ─── License status card ───────────────────────────────────────────────────────

function LicenseStatusCard() {
  const { T } = useTheme()
  const { isLicensed, isExpired, inGracePeriod, hardBlocked, isProActive,
          daysLeft, daysSinceExpiry, raw, refresh, loading } = useLicense()
  const [refreshing, setRefreshing] = useState(false)

  const handleRefresh = async () => {
    setRefreshing(true)
    await refresh()
    setTimeout(() => setRefreshing(false), 600)
  }

  // ── status display config ──────────────────────────────────────────────────
  let statusColor, statusIcon, statusTitle, statusDesc
  if (loading) {
    statusColor = T.textMut
    statusIcon  = <RefreshCw size={16} color={T.textMut} />
    statusTitle = 'Checking license…'
    statusDesc  = 'Contacting the server.'
  } else if (hardBlocked) {
    statusColor = '#ef4444'
    statusIcon  = <Lock size={16} color="#ef4444" />
    statusTitle = 'License Expired — Pro Disabled'
    statusDesc  = `Expired ${daysSinceExpiry} days ago. Grace period has ended.`
  } else if (inGracePeriod) {
    statusColor = '#f87171'
    statusIcon  = <AlertTriangle size={16} color="#f87171" />
    statusTitle = 'License Expired — Grace Period'
    statusDesc  = `${30 - daysSinceExpiry} day${(30 - daysSinceExpiry) !== 1 ? 's' : ''} remaining before Pro features are disabled.`
  } else if (isLicensed && daysLeft <= 30) {
    statusColor = T.amber
    statusIcon  = <Clock size={16} color={T.amber} />
    statusTitle = `Pro License — Expires in ${daysLeft} day${daysLeft !== 1 ? 's' : ''}`
    statusDesc  = `Renew before ${raw?.expires_at} to avoid interruption.`
  } else if (isLicensed) {
    statusColor = T.amber
    statusIcon  = <Zap size={16} color={T.amber} />
    statusTitle = '✦ TSDB.ai Pro Active'
    statusDesc  = `Licensed to ${raw?.customer ?? '—'}`
  } else {
    statusColor = T.textMut
    statusIcon  = <Lock size={16} color={T.textMut} />
    statusTitle = 'Unlicensed — Free Tier'
    statusDesc  = 'Add a license key to tsdb.yaml to unlock Pro features.'
  }

  return (
    <div style={{
      padding: '14px 16px', borderRadius: 10, marginBottom: 18,
      background: isLicensed ? `${statusColor}12` : T.bgPanel,
      border: `1px solid ${isLicensed ? statusColor + '44' : T.border}`,
    }}>
      {/* Header row */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: isLicensed ? 14 : 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          {statusIcon}
          <div>
            <div style={{ fontSize: 13, fontWeight: 700, color: statusColor }}>{statusTitle}</div>
            <div style={{ fontSize: 11, color: T.textMut, marginTop: 1 }}>{statusDesc}</div>
          </div>
        </div>
        <button
          onClick={handleRefresh}
          title="Re-check license"
          style={{
            background: 'none', border: `1px solid ${T.border}`,
            borderRadius: 6, padding: '5px 8px', cursor: 'pointer',
            color: T.textMut, display: 'flex', alignItems: 'center', gap: 5,
            fontSize: 11,
          }}
        >
          <RefreshCw size={11} style={{ animation: refreshing ? 'spin 0.6s linear infinite' : 'none' }} />
          Check
        </button>
      </div>

      {/* Detail grid — only when licensed */}
      {isLicensed && raw && (
        <div style={{
          display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8,
          paddingTop: 12, borderTop: `1px solid ${statusColor}22`,
        }}>
          {[
            { label: 'Customer',  value: raw.customer  },
            { label: 'Email',     value: raw.email     },
            { label: 'Tier',      value: raw.tier?.toUpperCase() },
            { label: 'Issued',    value: raw.issued_at  },
            { label: 'Expires',   value: raw.expires_at },
            { label: 'Days Left', value: daysLeft > 0 ? `${daysLeft} days` : 'Expired' },
          ].map(({ label, value }) => value ? (
            <div key={label}>
              <div style={{ fontSize: 10, color: T.textMut, fontWeight: 700, letterSpacing: '0.06em' }}>{label.toUpperCase()}</div>
              <div style={{ fontSize: 12, color: T.textSec, fontFamily: T.mono, marginTop: 2 }}>{value}</div>
            </div>
          ) : null)}
        </div>
      )}

      {/* Features */}
      {isProActive && raw?.features?.length > 0 && (
        <div style={{ marginTop: 12, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {raw.features.map(f => (
            <span key={f} style={{
              fontSize: 10, padding: '2px 8px', borderRadius: 20,
              background: `${statusColor}18`, border: `1px solid ${statusColor}33`,
              color: statusColor, fontWeight: 600,
            }}>
              {f.replace(/_/g, ' ')}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function Settings() {
  const { T } = useTheme()
  const { isLicensed, isProActive, refresh } = useLicense()

  const [backendUrl, setBackendUrl] = useState(
    localStorage.getItem('tsdb_backend_url') || DEFAULT_BACKEND
  )
  const [saved, setSaved]         = useState(false)
  const [pingStatus, setPingStatus] = useState(null)
  const [pinging, setPinging]     = useState(false)

  const handleSave = () => {
    localStorage.setItem('tsdb_backend_url', backendUrl)
    setSaved(true)
    setTimeout(() => setSaved(false), 2500)
  }

  const handlePing = async () => {
    setPinging(true)
    setPingStatus(null)
    // Use the configured backendUrl so the ping reflects what the user entered,
    // not just the Vite proxy default.
    const url = (backendUrl || DEFAULT_BACKEND).replace(/\/$/, '') + '/internal/metrics'
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(3000) })
      setPingStatus(res.ok ? 'ok' : 'err')
    } catch {
      setPingStatus('err')
    }
    setPinging(false)
  }

  return (
    <div style={{ padding: '28px 32px', overflowY: 'auto', flex: 1, maxWidth: 680 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 28 }}>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 700, color: T.textPri }}>Settings</h1>
          <p style={{ fontSize: 13, color: T.textMut, marginTop: 4 }}>
            Configure your TSDB.ai connection and license.
          </p>
        </div>
        <button onClick={handleSave} style={{
          display: 'flex', alignItems: 'center', gap: 7,
          padding: '9px 22px', borderRadius: 8, border: 'none',
          background: saved ? T.green : `linear-gradient(135deg, ${T.purple}, ${T.cyan})`,
          color: '#fff', fontSize: 13, fontWeight: 600, cursor: 'pointer',
          transition: 'background 0.3s',
          boxShadow: saved ? glow.green : glow.purple,
        }}>
          {saved ? <Check size={14} /> : <SettingsIcon size={14} />}
          {saved ? 'Saved!' : 'Save Settings'}
        </button>
      </div>

      {/* ── Connection ────────────────────────────────────────────────────── */}
      <Section title="Connection" icon={Server} color={T.cyan}>
        <FieldRow label="Backend URL" hint="The address of your TSDB.ai core server. Default: http://localhost:8080">
          <div style={{ display: 'flex', gap: 8 }}>
            <div style={{ flex: 1 }}>
              <InputField value={backendUrl} onChange={setBackendUrl} placeholder={DEFAULT_BACKEND} mono />
            </div>
            <button
              onClick={handlePing}
              disabled={pinging}
              style={{
                display: 'flex', alignItems: 'center', gap: 6,
                padding: '9px 14px', borderRadius: 7,
                border: `1px solid ${pingStatus === 'ok' ? T.green + '55' : pingStatus === 'err' ? T.red + '55' : T.border}`,
                background: pingStatus === 'ok' ? `${T.green}18` : pingStatus === 'err' ? `${T.red}18` : T.bgPanel,
                color: pingStatus === 'ok' ? T.green : pingStatus === 'err' ? T.red : T.textSec,
                fontSize: 12, cursor: 'pointer', flexShrink: 0,
              }}
            >
              {pinging ? <RefreshCw size={12} /> : pingStatus === 'ok' ? <Check size={12} /> : pingStatus === 'err' ? <X size={12} /> : <Globe size={12} />}
              {pinging ? 'Pinging…' : pingStatus === 'ok' ? 'Connected' : pingStatus === 'err' ? 'Unreachable' : 'Ping'}
            </button>
          </div>
        </FieldRow>

        <div style={{
          marginTop: 12, padding: '12px 14px', background: T.bgPanel,
          borderRadius: 8, border: `1px solid ${T.border}`,
        }}>
          <div style={{ fontSize: 10, color: T.textMut, fontWeight: 700, letterSpacing: '0.07em', marginBottom: 8 }}>
            EXPECTED ENDPOINTS
          </div>
          {['/internal/metrics', '/internal/head_cache', '/forecast', '/forecast_all',
            '/patterns', '/causal/graph', '/relationships', '/internal/license',
          ].map(ep => (
            <div key={ep} style={{
              fontSize: 11, color: T.textSec, fontFamily: T.mono,
              padding: '2px 0', borderBottom: `1px solid ${T.border}11`,
            }}>
              <span style={{ color: T.textMut }}>GET </span>{ep}
            </div>
          ))}
        </div>
      </Section>

      {/* ── License ───────────────────────────────────────────────────────── */}
      <Section title="License" icon={Key} color={isLicensed ? T.amber : T.textMut}>
        <LicenseStatusCard />

        {/* How to apply */}
        <div style={{
          padding: '14px 16px', borderRadius: 9,
          background: T.bgPanel, border: `1px solid ${T.border}`,
          marginBottom: 14,
        }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: T.textSec, marginBottom: 8, letterSpacing: '0.06em' }}>
            HOW TO APPLY A LICENSE
          </div>
          <div style={{ fontSize: 12, color: T.textMut, lineHeight: 1.7 }}>
            Add your license key to <code style={{ fontFamily: T.mono, color: T.cyanL, background: T.bgInput, padding: '1px 5px', borderRadius: 4 }}>tsdb.yaml</code> and restart the server:
          </div>
          <pre style={{
            margin: '10px 0 0', padding: '10px 12px', borderRadius: 7,
            background: T.bgRoot, border: `1px solid ${T.border}`,
            fontFamily: T.mono, fontSize: 11.5, color: T.textSec, lineHeight: 1.6,
            overflowX: 'auto',
          }}>{`license:\n  key: "TSDB1.eyJ..."`}</pre>
          <div style={{ marginTop: 10, fontSize: 11, color: T.textMut }}>
            After restarting, click <strong style={{ color: T.textSec }}>Check</strong> above to refresh the license status — or it will update automatically within 5 minutes.
          </div>
        </div>

        <div style={{ fontSize: 12, color: T.textMut }}>
          Need a license?{' '}
          <a href="https://tsdb.ai/pro" target="_blank" rel="noopener noreferrer" style={{ color: T.cyan }}>
            Visit tsdb.ai/pricing →
          </a>
        </div>
      </Section>

      {/* ── Pro Features ──────────────────────────────────────────────────── */}
      <Section title="Pro Features" icon={Shield} color={T.purple}>
        {!isProActive && (
          <a href="https://tsdb.ai/pro" target="_blank" rel="noopener noreferrer"
            style={{ textDecoration: 'none', display: 'block', marginBottom: 18 }}>
            <div style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              padding: '14px 18px', borderRadius: 10,
              background: `linear-gradient(135deg, ${T.purple}22, ${T.cyan}11)`,
              border: `1px solid ${T.purple}55`,
              boxShadow: `0 0 24px ${T.purple}18`,
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <Star size={16} color={T.amber} />
                <div>
                  <div style={{ fontSize: 13, fontWeight: 700, color: T.textPri }}>Upgrade to TSDB.ai Pro</div>
                  <div style={{ fontSize: 11, color: T.textMut, marginTop: 1 }}>
                    Unlock alerts, root cause graph, AI chat, and more
                  </div>
                </div>
              </div>
              <span style={{
                fontSize: 12, fontWeight: 700, color: '#fff',
                background: `linear-gradient(135deg, ${T.purple}, ${T.cyan})`,
                padding: '6px 16px', borderRadius: 20, boxShadow: glow.purple,
                flexShrink: 0,
              }}>
                Get Pro →
              </span>
            </div>
          </a>
        )}

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
          {[
            { label: 'Slack, Teams & Telegram alerts',  desc: 'Route anomalies to your team channels' },
            { label: 'Natural language alert builder',   desc: 'Define alert rules in plain English' },
            { label: 'Root cause graph',                  desc: 'Visualize leading-indicator relationships' },
            { label: 'Deploy regression detection',      desc: 'Flag post-deploy metric degradation' },
            { label: 'Scheduled digest reports',         desc: 'Email summaries of anomalies & forecasts' },
            { label: 'Service health scoring',           desc: 'Per-service composite health score' },
            { label: 'AI chat (OpenAI, Anthropic & Local LLM)', desc: 'Ask questions — cloud or self-hosted model' },
            { label: 'PagerDuty incident integration',   desc: 'Auto-trigger incidents from anomalies' },
          ].map(f => (
            <div key={f.label} style={{
              display: 'flex', alignItems: 'flex-start', gap: 10,
              padding: '10px 12px', borderRadius: 8,
              background: isProActive ? `${T.amber}09` : T.bgPanel,
              border: `1px solid ${isProActive ? T.amber + '22' : T.border}`,
            }}>
              <span style={{ color: isProActive ? T.amber : T.textMut, fontSize: 14, lineHeight: 1, marginTop: 1 }}>
                {isProActive ? '✦' : '○'}
              </span>
              <div>
                <div style={{ fontSize: 12, fontWeight: 600, color: isProActive ? T.textPri : T.textMut }}>{f.label}</div>
                <div style={{ fontSize: 11, color: T.textMut, marginTop: 2 }}>{f.desc}</div>
              </div>
            </div>
          ))}
        </div>
      </Section>

      {/* ── Version ───────────────────────────────────────────────────────── */}
      <div style={{
        padding: '12px 16px', background: T.bgPanel, borderRadius: 8,
        border: `1px solid ${T.border}`, fontSize: 11, color: T.textMut, fontFamily: T.mono,
        display: 'flex', gap: 24,
      }}>
        <span>Admin Panel v0.9.0</span>
        <span>|</span>
        <span>TSDB.ai Go Server v0.9</span>
        <span>|</span>
        <a href="https://tsdb.ai/docs" target="_blank" rel="noopener noreferrer" style={{ color: T.cyan, textDecoration: 'none' }}>
          Documentation
        </a>
      </div>

      <style>{`@keyframes spin { from { transform: rotate(0deg) } to { transform: rotate(360deg) } }`}</style>
    </div>
  )
}
