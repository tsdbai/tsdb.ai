import { useState } from 'react'
import { NavLink } from 'react-router-dom'
import { useTheme } from '../context/ThemeContext'
import {
  LayoutDashboard, AlertTriangle, TrendingUp, BookMarked,
  GitBranch, MessageSquare, Bell, Settings, Lock, Zap,
  Activity, SlidersHorizontal, Bot, Cpu, Server, Radio, X,
  Sun, Moon,
} from 'lucide-react'
import { useLicense } from '../context/LicenseContext'

// ── TSDB.ai brand mark — the Anomaly Pulse icon ───────────────────────────────
// Crisp at all sizes: integer coords, minimal blur (0.7 only on the peak dot),
// no ambient blob filter that smears the whole shape at small sizes.
function TsdbIcon({ size = 32 }) {
  const { T } = useTheme()
  const id = 'tsdb-icon'
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 32 32" style={{ flexShrink: 0, shapeRendering: 'crispEdges' }}>
      <defs>
        {/* Tight glow — only used on the peak dot, not the whole line */}
        <filter id={`${id}-dotglow`} x="-80%" y="-80%" width="360%" height="360%">
          <feGaussianBlur stdDeviation="0.9" result="blur"/>
          <feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
        </filter>
        {/* Gradient: purple left → bright cyan center → fade right */}
        <linearGradient id={`${id}-grad`} x1="0%" y1="0%" x2="100%" y2="0%">
          <stop offset="0%"   stopColor="#6d28d9" stopOpacity="0.6"/>
          <stop offset="38%"  stopColor="#06b6d4" stopOpacity="1"/>
          <stop offset="58%"  stopColor="#22d3ee" stopOpacity="1"/>
          <stop offset="100%" stopColor="#0891b2" stopOpacity="0.35"/>
        </linearGradient>
      </defs>

      {/* Background */}
      <rect width="32" height="32" rx="6" fill="#06070f"/>
      {/* Subtle border */}
      <rect width="32" height="32" rx="6" fill="none" stroke="#ffffff" strokeOpacity="0.06" strokeWidth="1"/>

      {/* Waveform — all integer coords for pixel-sharp rendering
          baseline y=21, spike peak y=7 */}
      <polyline
        points="3,21 10,21 13,21 14,7 16,23 18,18 19,21 29,21"
        fill="none"
        stroke={`url(#${id}-grad)`}
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />

      {/* Peak dot — only this element gets the glow filter, keeps rest sharp */}
      <circle cx="14" cy="7" r="2" fill="#22d3ee" filter={`url(#${id}-dotglow)`}/>
      <circle cx="14" cy="7" r="1" fill="#ffffff"/>
    </svg>
  )
}

const NAV = [
  { to: '/',             label: 'Dashboard',         icon: LayoutDashboard,   pro: false },
  { to: '/ai-dashboard', label: 'AI Chat',           icon: Bot,               pro: false },
  { to: '/anomalies',    label: 'Anomalies',         icon: AlertTriangle,     pro: false },
  { to: '/forecast',     label: 'Forecast',          icon: TrendingUp,        pro: false },
  { to: '/patterns',     label: 'Patterns',          icon: BookMarked,        pro: false },
  { to: '/regimes',      label: 'Regime Changes',    icon: Activity,          pro: false },
  { divider: true, label: 'PRO FEATURES' },
  { to: '/chat',         label: 'Chat Integrations', icon: MessageSquare,     pro: true  },
  { to: '/alerts',       label: 'Alert Builder',     icon: Bell,              pro: true  },
  { to: '/alert-events', label: 'Alert Events',      icon: AlertTriangle,     pro: true  },
  { to: '/causal',       label: 'Root Cause Graph',  icon: GitBranch,         pro: true  },
  { divider: true, label: 'INSTANCE' },
  { to: '/instance',     label: 'Components',        icon: Server,            pro: false },
  { to: '/mcp',          label: 'MCP',               icon: Cpu,               pro: false },
  { to: '/scrapers',     label: 'Scrapers',          icon: Radio,             pro: false },
  { to: '/config',       label: 'Configuration',     icon: SlidersHorizontal, pro: false },
  { divider: true, label: 'SYSTEM' },
  { to: '/settings',     label: 'Settings',          icon: Settings,          pro: false },
]

// ─── Banner config ────────────────────────────────────────────────────────────

const BANNER_CFG = {
  // ≤ 30 days left — yellow
  warning: {
    bg:     '#451a03',
    border: '#92400e',
    accent: '#fbbf24',
    text:   '#fef3c7',
    icon:   '⚠',
    msg:  (days) => `Your Pro license expires in ${days} day${days !== 1 ? 's' : ''}.`,
    cta:   'Renew now →',
    dismissable: true,
  },
  // ≤ 7 days left — light red
  danger: {
    bg:     '#450a0a',
    border: '#b91c1c',
    accent: '#f87171',
    text:   '#fee2e2',
    icon:   '⚠',
    msg:  (days) => `Your Pro license expires in ${days} day${days !== 1 ? 's' : ''}. Renew immediately to avoid disruption.`,
    cta:   'Renew now →',
    dismissable: true,
  },
  // Expired — within 30-day grace period — vibrant red
  expired: {
    bg:     '#7f1d1d',
    border: '#dc2626',
    accent: '#fca5a5',
    text:   '#fff1f2',
    icon:   '⛔',
    msg:  (_, dse) => `License expired. Pro features are active for ${30 - dse} more day${(30 - dse) !== 1 ? 's' : ''} (grace period).`,
    cta:   'Renew to restore →',
    dismissable: false,
  },
  // Expired + past grace — maximum red, features blocked
  blocked: {
    bg:     '#dc2626',
    border: '#991b1b',
    accent: '#fff',
    text:   '#fff',
    icon:   '⛔',
    msg:  () => 'Your license has expired and the grace period has ended. Pro features are now disabled.',
    cta:   'Renew license →',
    dismissable: false,
  },
}

function ExpiryBanner({ level, daysLeft, daysSinceExpiry, onDismiss }) {
  const { T } = useTheme()
  const cfg = BANNER_CFG[level]
  if (!cfg) return null
  return (
    <div style={{
      flexShrink: 0,
      background: cfg.bg,
      borderBottom: `2px solid ${cfg.border}`,
      padding: '10px 20px',
      display: 'flex', alignItems: 'center', gap: 10,
    }}>
      <span style={{ fontSize: 15, flexShrink: 0 }}>{cfg.icon}</span>
      <span style={{ flex: 1, fontSize: 12.5, fontWeight: 500, color: cfg.text, lineHeight: 1.4 }}>
        {cfg.msg(daysLeft, daysSinceExpiry)}
      </span>
      <a
        href="https://tsdb.ai/pro"
        target="_blank"
        rel="noopener noreferrer"
        style={{
          flexShrink: 0,
          fontSize: 12, fontWeight: 700,
          color: cfg.accent,
          textDecoration: 'underline',
          whiteSpace: 'nowrap',
        }}
      >
        {cfg.cta}
      </a>
      {cfg.dismissable && (
        <button
          onClick={onDismiss}
          title="Dismiss"
          style={{
            flexShrink: 0,
            background: 'none', border: 'none', cursor: 'pointer',
            color: cfg.text, opacity: 0.5, padding: 2,
            display: 'flex', alignItems: 'center',
          }}
        >
          <X size={13} />
        </button>
      )}
    </div>
  )
}

// ─── Nav item ─────────────────────────────────────────────────────────────────

function NavItem({ item, isProActive }) {
  const { T } = useTheme()
  const locked = item.pro && !isProActive
  const Icon   = item.icon
  return (
    <NavLink
      to={item.to}
      style={({ isActive }) => ({
        display: 'flex', alignItems: 'center', gap: 10,
        padding: '9px 14px', borderRadius: 8,
        textDecoration: 'none', fontSize: 13.5, fontWeight: 500,
        transition: 'all 0.15s',
        color:     isActive ? T.cyanL : locked ? `${T.textSec}88` : T.textSec,
        background: isActive ? `${T.cyan}18` : 'transparent',
        border:    `1px solid ${isActive ? T.cyan + '55' : 'transparent'}`,
        boxShadow:  isActive ? glow.cyan : 'none',
        cursor:    'pointer',
        opacity:   locked ? 0.7 : 1,
      })}
    >
      <Icon size={15} />
      <span style={{ flex: 1 }}>{item.label}</span>
      {locked               && <Lock size={11} color={T.amber} style={{ opacity: 0.8 }} />}
      {item.pro && isProActive && <Zap size={11} color={T.amber} />}
    </NavLink>
  )
}

// ─── Layout ───────────────────────────────────────────────────────────────────

export default function Layout({ children }) {
  const { T, isDark, toggle } = useTheme()
  const { isLicensed, isProActive, inGracePeriod, bannerLevel, daysLeft, daysSinceExpiry } = useLicense()
  const [dismissedLevel, setDismissedLevel] = useState(null)

  const showBanner = bannerLevel && dismissedLevel !== bannerLevel

  // ── Footer tier badge ─────────────────────────────────────────────────────
  let tierBadge
  if (isLicensed) {
    tierBadge = <span style={{ color: T.amber }}>PRO</span>
  } else if (inGracePeriod) {
    tierBadge = (
      <>
        <span style={{ color: '#f87171' }}>PRO</span>
        <span style={{
          marginLeft: 5, padding: '1px 5px', borderRadius: 4,
          background: '#7f1d1d55', border: '1px solid #ef444455',
          color: '#fca5a5', fontSize: 9, fontWeight: 700, letterSpacing: '0.05em',
        }}>GRACE</span>
      </>
    )
  } else {
    tierBadge = (
      <>
        <span>FREE</span>
        <span style={{
          marginLeft: 6, padding: '1px 6px', borderRadius: 4,
          background: '#1f0a0a', border: '1px solid #ef444433',
          color: '#f87171', fontSize: 9, fontWeight: 700, letterSpacing: '0.08em',
        }}>UNLICENSED</span>
      </>
    )
  }

  return (
    <div style={{ display: 'flex', height: '100vh', overflow: 'hidden' }}>

      {/* ── Sidebar ────────────────────────────────────────────────────────── */}
      <aside style={{
        width: 240, minWidth: 240,
        background: T.bgPanel, borderRight: `1px solid ${T.border}`,
        display: 'flex', flexDirection: 'column', overflow: 'hidden',
      }}>
        {/* Logo */}
        <div style={{ padding: '22px 18px 18px', borderBottom: `1px solid ${T.border}` }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 13 }}>
            <TsdbIcon size={42} />
            <div>
              <div style={{ fontSize: 20, fontWeight: 800, color: T.textPri, letterSpacing: '-0.01em', lineHeight: 1.1 }}>
                TSDB<span style={{ color: T.cyan }}>.ai</span>
              </div>
              <div style={{ fontSize: 11, color: T.textSec, fontFamily: T.mono, marginTop: 3 }}>
                {isLicensed ? '✦ PRO' : 'Control Panel'}
              </div>
            </div>
          </div>
        </div>

        {/* Nav */}
        <nav style={{
          flex: 1, padding: '12px 10px', overflowY: 'auto',
          display: 'flex', flexDirection: 'column', gap: 2,
        }}>
          {NAV.map((item, i) =>
            item.divider ? (
              <div key={i} style={{
                padding: '14px 4px 6px', fontSize: 10, fontWeight: 700,
                letterSpacing: '0.1em', color: T.textMut, fontFamily: T.mono,
              }}>{item.label}</div>
            ) : (
              <NavItem key={item.to} item={item} isProActive={isProActive} />
            )
          )}
        </nav>

        {/* Footer */}
        <div style={{
          padding: '10px 12px', borderTop: `1px solid ${T.border}`,
          display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8,
        }}>
          <span style={{ fontSize: 11, color: T.textSec, fontFamily: T.mono }}>
            v0.9.0 — {tierBadge}
          </span>
          {/* Light / dark toggle */}
          <button
            onClick={toggle}
            title={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
            style={{
              display: 'flex', alignItems: 'center', gap: 5,
              padding: '5px 10px', borderRadius: 20, border: `1px solid ${T.border}`,
              background: isDark ? T.bgCard : '#e2e8f0',
              color: isDark ? T.amber : '#6366f1',
              cursor: 'pointer', fontSize: 11, fontWeight: 600,
              transition: 'all 0.2s',
              flexShrink: 0,
            }}
          >
            {isDark
              ? <><Sun size={12} /> Light</>
              : <><Moon size={12} /> Dark</>
            }
          </button>
        </div>
      </aside>

      {/* ── Main ───────────────────────────────────────────────────────────── */}
      <main style={{
        flex: 1, overflow: 'hidden', background: T.bgRoot,
        display: 'flex', flexDirection: 'column',
      }}>
        {showBanner && (
          <ExpiryBanner
            level={bannerLevel}
            daysLeft={daysLeft}
            daysSinceExpiry={daysSinceExpiry}
            onDismiss={() => setDismissedLevel(bannerLevel)}
          />
        )}
        {children}
      </main>

    </div>
  )
}
