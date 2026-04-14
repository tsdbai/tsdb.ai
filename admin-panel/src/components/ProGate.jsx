import { useNavigate } from 'react-router-dom'
import { useTheme } from '../context/ThemeContext'
import { Lock, Zap, ChevronRight, Bell, MessageSquare, GitBranch } from 'lucide-react'
import { useLicense } from '../context/LicenseContext'

// ─── Shimmer helpers ──────────────────────────────────────────────────────────

function ShimmerBlock({ w = '100%', h = 16, radius = 6, opacity = 0.5 }) {
  const { T } = useTheme()
  return (
    <div style={{ width: w, height: h, borderRadius: radius, background: T.bgCard, opacity }} />
  )
}

function ShimmerCard({ children, style = {} }) {
  const { T } = useTheme()
  return (
    <div style={{
      background: T.bgCard, borderRadius: 10, padding: '14px 16px',
      border: `1px solid ${T.border}`, ...style,
    }}>
      {children}
    </div>
  )
}

// ─── Per-feature blurred page previews ───────────────────────────────────────

function AlertPreview() {
  const chips = ['cpu_usage', 'memory_rss', 'http_latency_p99', 'error_rate']
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <ShimmerCard>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
          {chips.map(c => (
            <div key={c} style={{
              padding: '3px 10px', borderRadius: 20, fontSize: 11,
              background: `${T.cyan}22`, border: `1px solid ${T.cyan}44`, color: T.textMut,
            }}>{c}</div>
          ))}
        </div>
        <ShimmerBlock h={32} radius={8} opacity={0.4} />
      </ShimmerCard>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
        <ShimmerCard>
          <ShimmerBlock w="60%" h={10} opacity={0.4} />
          <div style={{ marginTop: 6 }}><ShimmerBlock h={28} radius={7} opacity={0.35} /></div>
        </ShimmerCard>
        <ShimmerCard>
          <ShimmerBlock w="40%" h={10} opacity={0.4} />
          <div style={{ marginTop: 6 }}><ShimmerBlock h={28} radius={7} opacity={0.35} /></div>
        </ShimmerCard>
      </div>
      <ShimmerCard>
        <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
          {['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'].map((s, i) => (
            <div key={s} style={{
              padding: '3px 10px', borderRadius: 5, fontSize: 10, fontWeight: 700,
              background: i === 2 ? `${T.red}22` : T.bgPanel,
              border: `1px solid ${i === 2 ? T.red + '55' : T.border}`,
              color: i === 2 ? T.red : T.textMut, opacity: 0.7,
            }}>{s}</div>
          ))}
        </div>
        <ShimmerBlock h={12} w="80%" opacity={0.3} />
      </ShimmerCard>
    </div>
  )
}

function ChatPreview() {
  const { T } = useTheme()
  const platforms = [
    { name: 'Slack',    color: '#E01E5A', icon: '💬' },
    { name: 'Teams',    color: '#6264A7', icon: '🟦' },
    { name: 'Telegram', color: '#229ED9', icon: '✈️' },
  ]
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {platforms.map(p => (
        <ShimmerCard key={p.name}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
            <div style={{
              width: 32, height: 32, borderRadius: 8, fontSize: 16,
              background: p.color + '22', border: `1px solid ${p.color}44`,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>{p.icon}</div>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: T.textMut, marginBottom: 4 }}>{p.name}</div>
              <ShimmerBlock w={100} h={9} opacity={0.35} />
            </div>
            <div style={{
              width: 36, height: 20, borderRadius: 10,
              background: T.bgPanel, border: `1px solid ${T.border}`, opacity: 0.5,
            }} />
          </div>
          <ShimmerBlock h={28} radius={7} opacity={0.3} />
        </ShimmerCard>
      ))}
    </div>
  )
}

function CausalPreview() {
  const { T } = useTheme()
  const nodes = [
    { x: 160, y: 90,  label: 'cpu_usage'    },
    { x: 300, y: 160, label: 'latency_p99'  },
    { x: 70,  y: 180, label: 'memory_rss'   },
    { x: 230, y: 265, label: 'error_rate'   },
    { x: 370, y: 90,  label: 'gc_pause'     },
  ]
  const edges = [[0, 1], [0, 2], [1, 3], [4, 1], [2, 3]]
  return (
    <div style={{
      background: T.bgPanel, borderRadius: 10,
      border: `1px solid ${T.border}`, padding: 4, overflow: 'hidden',
    }}>
      <svg width="100%" viewBox="0 0 440 320" style={{ display: 'block' }}>
        {edges.map(([a, b], i) => (
          <line key={i}
            x1={nodes[a].x} y1={nodes[a].y} x2={nodes[b].x} y2={nodes[b].y}
            stroke={T.cyan + '44'} strokeWidth={1.5} strokeDasharray="4 3"
          />
        ))}
        {nodes.map((n, i) => (
          <g key={i}>
            <circle cx={n.x} cy={n.y} r={24} fill={T.bgCard} stroke={T.cyan + '55'} strokeWidth={1.5} />
            <circle cx={n.x} cy={n.y} r={15} fill={T.cyan + '18'} />
            <text x={n.x} y={n.y + 38} textAnchor="middle"
              fill={T.textMut} fontSize={9} fontFamily="monospace">{n.label}</text>
          </g>
        ))}
        <rect x={248} y={103} width={84} height={22} rx={4} fill={T.bgCard} stroke={T.border} />
        <text x={290} y={118} textAnchor="middle" fill={T.textMut} fontSize={9} fontFamily="monospace">
          lag ~2.4 min
        </text>
      </svg>
    </div>
  )
}

// ─── Feature registry ─────────────────────────────────────────────────────────

const FEATURES = {
  'Alert Builder': {
    icon: Bell,
    color: T.amber,
    tagline: 'Intelligent alerting for any metric',
    desc: 'Define threshold, anomaly, RMSE, or forecast-breach rules on any ingested metric — then route alerts to Slack, Teams, Telegram, or custom webhooks with configurable severity.',
    bullets: [
      'Threshold, RMSE, % change, and anomaly trigger conditions',
      'Forecast-breach alerts — fire before a metric goes out of range',
      'Slack, Teams, Webex, and Telegram delivery channels',
      'Natural-language rule preview before you save',
      'Severity levels: LOW → CRITICAL with colour coding',
    ],
    Preview: AlertPreview,
  },
  'Chat Integrations': {
    icon: MessageSquare,
    color: '#7C3AED',
    tagline: 'Push alerts to every channel your team uses',
    desc: 'Configure Slack, Microsoft Teams, Webex, and Telegram webhooks in one place. Choose which events trigger notifications and test delivery instantly — no guessing.',
    bullets: [
      'Slack, Teams, Webex, and Telegram configured in one screen',
      'Per-platform event filters: anomalies, alerts, regimes, forecasts',
      'One-click delivery test to verify your webhook works immediately',
      'Message templates with metric name, value, and severity',
      'Rate-limit controls to prevent alert fatigue',
    ],
    Preview: ChatPreview,
  },
  'Root Cause Graph': {
    icon: GitBranch,
    color: T.cyan,
    tagline: 'Discover what drives what — automatically',
    desc: 'TSDB.ai continuously mines your time series for cause-and-effect relationships. Visualise which metrics drive changes in others, with quantified lag times and confidence scores.',
    bullets: [
      'Auto-discovers cross-metric causal links from historical data',
      'Force-directed graph — zoom, pan, click any node for details',
      'Quantified lag: "When X spikes, Y follows in ~3 min"',
      'Confidence scores on every detected relationship',
      'Ideal for root-cause analysis and deploy regression detection',
    ],
    Preview: CausalPreview,
  },
}

// ─── ProGate component ────────────────────────────────────────────────────────

export default function ProGate({ feature }) {
  const { T } = useTheme()
  const navigate   = useNavigate()
  const { isProActive } = useLicense()

  // If pro is active (valid license OR within 30-day grace period), render children directly.
  // ProGate is only shown when isProActive is false (no license or past grace period).
  // Callers should pass children when they want to render the real page content:
  //   <ProGate feature="Alert Builder"><AlertBuilderPage /></ProGate>
  // But since our current pages use ProGate as a wrapper without children,
  // we just check isProActive here and skip the gate if active.
  // (Pages themselves call ProGate at their top level, not wrapping child content)

  const info = FEATURES[feature] || {
    icon: Lock, color: T.purple,
    tagline: 'Pro feature',
    desc: 'This feature requires a TSDB.ai Pro license.',
    bullets: [],
    Preview: () => null,
  }
  const FeatureIcon = info.icon
  const Preview = info.Preview

  return (
    <div style={{ flex: 1, display: 'flex', overflow: 'hidden', position: 'relative', background: T.bgRoot }}>

      {/* ── Blurred ghost preview of page content ── */}
      <div style={{
        position: 'absolute', inset: 0, pointerEvents: 'none', overflow: 'hidden',
        filter: 'blur(7px) brightness(0.28) saturate(0.5)',
        padding: '28px 36px',
        display: 'flex', flexDirection: 'column', gap: 16,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 4 }}>
          <div style={{
            width: 40, height: 40, borderRadius: 10,
            background: `${info.color}33`, border: `1px solid ${info.color}55`,
          }} />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <div style={{ width: 160, height: 18, borderRadius: 6, background: T.bgCard }} />
            <div style={{ width: 220, height: 11, borderRadius: 5, background: T.bgPanel }} />
          </div>
        </div>
        <div style={{ flex: 1, overflow: 'hidden' }}>
          <Preview />
        </div>
        <ShimmerBlock h={13} w="65%" opacity={0.35} />
        <ShimmerBlock h={13} w="45%" opacity={0.25} />
      </div>

      {/* ── Upgrade card overlay ── */}
      <div style={{
        position: 'absolute', inset: 0, zIndex: 10,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 24,
      }}>
        <div style={{
          width: '100%', maxWidth: 520,
          background: `${T.bgCard}f2`,
          backdropFilter: 'blur(18px)',
          borderRadius: 18,
          border: `1px solid ${info.color}44`,
          boxShadow: `0 0 48px ${info.color}1a, 0 24px 64px rgba(0,0,0,0.55)`,
          overflow: 'hidden',
        }}>
          {/* Accent bar */}
          <div style={{ height: 3, background: `linear-gradient(90deg, ${info.color}, ${T.cyan})` }} />

          <div style={{ padding: '30px 34px 34px' }}>
            {/* Icon + PRO badge */}
            <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 20 }}>
              <div style={{
                width: 50, height: 50, borderRadius: 13,
                background: `${info.color}1a`, border: `1.5px solid ${info.color}44`,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                boxShadow: `0 0 18px ${info.color}22`,
              }}>
                <FeatureIcon size={22} color={info.color} />
              </div>
              <div style={{
                display: 'inline-flex', alignItems: 'center', gap: 5,
                background: `${T.amber}18`, border: `1px solid ${T.amber}44`,
                borderRadius: 20, padding: '4px 12px',
              }}>
                <Lock size={10} color={T.amber} />
                <span style={{ fontSize: 10, fontWeight: 700, color: T.amber, letterSpacing: '0.1em' }}>PRO ONLY</span>
              </div>
            </div>

            {/* Title + tagline */}
            <h2 style={{ fontSize: 21, fontWeight: 700, color: T.textPri, margin: '0 0 4px' }}>{feature}</h2>
            <div style={{ fontSize: 13, color: info.color, fontWeight: 600, marginBottom: 14 }}>{info.tagline}</div>

            {/* Description */}
            <p style={{ fontSize: 13.5, color: T.textSec, lineHeight: 1.7, margin: '0 0 20px' }}>{info.desc}</p>

            {/* Capability bullets */}
            <div style={{
              background: T.bgPanel, borderRadius: 10,
              padding: '14px 16px', border: `1px solid ${T.border}`, marginBottom: 22,
            }}>
              {info.bullets.map((b, i) => (
                <div key={i} style={{
                  display: 'flex', alignItems: 'flex-start', gap: 9,
                  marginBottom: i < info.bullets.length - 1 ? 9 : 0,
                }}>
                  <span style={{ color: info.color, fontSize: 12, lineHeight: '20px', flexShrink: 0 }}>✦</span>
                  <span style={{ fontSize: 13, color: T.textSec, lineHeight: 1.55 }}>{b}</span>
                </div>
              ))}
            </div>

            {/* CTAs */}
            <div style={{ display: 'flex', gap: 10 }}>
              <button
                onClick={() => navigate('/settings')}
                style={{
                  flex: 1, padding: '11px 20px', borderRadius: 9,
                  border: 'none', cursor: 'pointer',
                  background: `linear-gradient(135deg, ${info.color}, ${T.cyan})`,
                  color: '#fff', fontSize: 13.5, fontWeight: 600,
                  display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 7,
                  boxShadow: `0 0 22px ${info.color}33`, transition: 'opacity 0.15s',
                }}
                onMouseEnter={e => { e.currentTarget.style.opacity = '0.88' }}
                onMouseLeave={e => { e.currentTarget.style.opacity = '1' }}
              >
                <Zap size={14} />
                Enter License Key
                <ChevronRight size={14} />
              </button>
              <a
                href="https://tsdb.ai/pro"
                target="_blank"
                rel="noopener noreferrer"
                style={{
                  padding: '11px 18px', borderRadius: 9, fontSize: 13,
                  color: T.textSec, textDecoration: 'none',
                  border: `1px solid ${T.border}`,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  whiteSpace: 'nowrap', transition: 'border-color 0.15s, color 0.15s',
                }}
                onMouseEnter={e => {
                  e.currentTarget.style.borderColor = info.color + '66'
                  e.currentTarget.style.color = T.textPri
                }}
                onMouseLeave={e => {
                  e.currentTarget.style.borderColor = T.border
                  e.currentTarget.style.color = T.textSec
                }}
              >
                View pricing
              </a>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
