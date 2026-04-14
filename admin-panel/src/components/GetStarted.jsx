import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTheme } from '../context/ThemeContext'
import { useLicense } from '../context/LicenseContext'
import { getAICredentials } from '../api'
import {
  Rocket, CheckCircle2, Circle, ChevronDown, ChevronUp,
  Radio, Zap, Bot, Key, X, ExternalLink, ArrowRight, Database,
} from 'lucide-react'

// ─── Animated pulsing dot for pending steps ───────────────────────────────────
function PulsingDot({ color }) {
  const { T } = useTheme()
  return (
    <div style={{ position: 'relative', width: 20, height: 20, flexShrink: 0 }}>
      <div style={{
        position: 'absolute', inset: 0,
        borderRadius: '50%',
        background: `${color}22`,
        animation: 'ping 1.4s cubic-bezier(0,0,0.2,1) infinite',
      }} />
      <div style={{
        position: 'absolute', inset: 3,
        borderRadius: '50%',
        background: color,
        opacity: 0.85,
      }} />
    </div>
  )
}

// ─── Single checklist row ─────────────────────────────────────────────────────
function Step({ done, optional, icon: Icon, color, title, desc, action, onAction }) {
  const { T } = useTheme()
  const statusColor = done ? T.green : optional ? T.textMut : color

  return (
    <div style={{
      display: 'flex', alignItems: 'flex-start', gap: 14,
      padding: '14px 16px', borderRadius: 10,
      background: done ? `${T.green}08` : `${T.bgCard}`,
      border: `1px solid ${done ? T.green + '30' : T.border}`,
      marginBottom: 8,
      transition: 'all 0.3s',
    }}>
      {/* Status indicator */}
      <div style={{ marginTop: 1 }}>
        {done
          ? <CheckCircle2 size={20} color={T.green} style={{ filter: `drop-shadow(0 0 6px ${T.green}88)` }} />
          : optional
            ? <Circle size={20} color={T.textMut} />
            : <PulsingDot color={color} />
        }
      </div>

      {/* Icon */}
      <div style={{
        width: 34, height: 34, borderRadius: 8, flexShrink: 0,
        background: `${statusColor}18`, border: `1px solid ${statusColor}33`,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>
        <Icon size={16} color={statusColor} />
      </div>

      {/* Text */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 13, fontWeight: 600, color: done ? T.textMut : T.textPri }}>
            {title}
          </span>
          {optional && (
            <span style={{
              fontSize: 10, fontWeight: 700, color: T.textMut,
              background: `${T.textMut}18`, border: `1px solid ${T.textMut}33`,
              borderRadius: 4, padding: '1px 6px',
            }}>OPTIONAL</span>
          )}
          {done && (
            <span style={{
              fontSize: 10, fontWeight: 700, color: T.green,
              background: `${T.green}18`, border: `1px solid ${T.green}33`,
              borderRadius: 4, padding: '1px 6px',
            }}>DONE</span>
          )}
        </div>
        <div style={{ fontSize: 11, color: T.textMut, marginTop: 3, lineHeight: 1.5 }}>{desc}</div>
      </div>

      {/* Action button */}
      {action && !done && (
        <button
          onClick={onAction}
          style={{
            display: 'flex', alignItems: 'center', gap: 5,
            padding: '6px 12px', borderRadius: 7, border: `1px solid ${color}55`,
            background: `${color}18`, color: color,
            fontSize: 11, fontWeight: 600, cursor: 'pointer', flexShrink: 0,
            whiteSpace: 'nowrap',
            transition: 'all 0.15s',
          }}
          onMouseEnter={e => e.currentTarget.style.background = `${color}30`}
          onMouseLeave={e => e.currentTarget.style.background = `${color}18`}
        >
          {action} <ArrowRight size={11} />
        </button>
      )}
    </div>
  )
}

// ─── Progress bar ─────────────────────────────────────────────────────────────
function ProgressBar({ completed, total }) {
  const { T } = useTheme()
  const pct = Math.round((completed / total) * 100)
  return (
    <div style={{ marginBottom: 20 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
        <span style={{ fontSize: 11, color: T.textMut }}>{completed} of {total} steps complete</span>
        <span style={{ fontSize: 11, fontWeight: 700, color: pct === 100 ? T.green : T.cyan }}>{pct}%</span>
      </div>
      <div style={{
        height: 4, borderRadius: 4,
        background: T.border,
        overflow: 'hidden',
      }}>
        <div style={{
          height: '100%',
          width: `${pct}%`,
          borderRadius: 4,
          background: pct === 100
            ? T.green
            : `linear-gradient(90deg, ${T.purple}, ${T.cyan})`,
          boxShadow: pct === 100 ? glow.green : glow.cyan,
          transition: 'width 0.6s ease',
        }} />
      </div>
    </div>
  )
}

// ─── Main component ───────────────────────────────────────────────────────────
export default function GetStarted({ metrics }) {
  const { T } = useTheme()
  const navigate              = useNavigate()
  const { isLicensed }        = useLicense()
  const [expanded, setExpanded] = useState(true)

  // "Hidden for now" — clears when the browser tab is closed (sessionStorage)
  const [hiddenForNow, setHiddenForNow] = useState(
    () => sessionStorage.getItem('tsdb_getstarted_hidden') === 'true'
  )
  // Permanently gone — survives across sessions (localStorage)
  const [dismissed, setDismissed] = useState(
    () => localStorage.getItem('tsdb_getstarted_dismissed') === 'true'
  )

  // ── Derive step states ────────────────────────────────────────────────────
  const serverOnline  = true  // we only render when online
  const hasData       = (metrics?.unique_series_active ?? 0) > 0
  const hasChunks     = (metrics?.total_chunks_modeled  ?? 0) > 0
  const aiCreds       = getAICredentials()
  const hasAIKey      = !!(aiCreds.openai_key || aiCreds.anthropic_key)

  const steps = [
    { id: 'server',  done: serverOnline },
    { id: 'data',    done: hasData      },
    { id: 'chunks',  done: hasChunks    },
    { id: 'ai',      done: hasAIKey     },
    { id: 'license', done: isLicensed, optional: true },
  ]
  const requiredSteps  = steps.filter(s => !s.optional)
  const completedCount = steps.filter(s => s.done).length
  const allRequired    = requiredSteps.every(s => s.done)

  // Auto-dismiss permanently once all required steps are done
  useEffect(() => {
    if (allRequired) {
      const t = setTimeout(() => {
        localStorage.setItem('tsdb_getstarted_dismissed', 'true')
        setDismissed(true)
      }, 4000)
      return () => clearTimeout(t)
    }
  }, [allRequired])

  const hideForNow = () => {
    sessionStorage.setItem('tsdb_getstarted_hidden', 'true')
    setHiddenForNow(true)
  }
  const dismissForever = () => {
    localStorage.setItem('tsdb_getstarted_dismissed', 'true')
    setDismissed(true)
  }

  if (dismissed || hiddenForNow) return null

  return (
    <div style={{
      marginBottom: 24,
      borderRadius: 14,
      border: `1px solid ${T.purple}55`,
      background: `linear-gradient(135deg, ${T.bgCard} 0%, #0e0e25 100%)`,
      boxShadow: `0 0 32px ${T.purple}22, 0 0 64px ${T.cyan}0a`,
      overflow: 'hidden',
    }}>
      {/* ── Header bar ── */}
      <button
        onClick={() => setExpanded(o => !o)}
        style={{
          width: '100%', display: 'flex', alignItems: 'center', gap: 12,
          padding: '16px 20px', background: 'transparent', border: 'none',
          cursor: 'pointer', textAlign: 'left',
          borderBottom: expanded ? `1px solid ${T.border}` : 'none',
        }}
      >
        {/* Rocket icon with glow */}
        <div style={{
          width: 40, height: 40, borderRadius: 10, flexShrink: 0,
          background: `linear-gradient(135deg, ${T.purple}33, ${T.cyan}22)`,
          border: `1px solid ${T.purple}55`,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          boxShadow: glow.purple,
        }}>
          <Rocket size={18} color={T.cyan}
            style={{ filter: `drop-shadow(0 0 6px ${T.cyan})` }} />
        </div>

        {/* Title */}
        <div style={{ flex: 1 }}>
          <div style={{
            fontSize: 15, fontWeight: 700,
            background: `linear-gradient(90deg, ${T.purpleL}, ${T.cyanL})`,
            WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent',
          }}>
            Get Started with TSDB.ai
          </div>
          <div style={{ fontSize: 11, color: T.textMut, marginTop: 2 }}>
            {allRequired
              ? '🎉 All set! Your instance is collecting and analyzing data.'
              : `Complete ${requiredSteps.filter(s => !s.done).length} more ${requiredSteps.filter(s => !s.done).length === 1 ? 'step' : 'steps'} to start collecting metrics`
            }
          </div>
        </div>

        {/* Progress pill */}
        <div style={{
          padding: '4px 12px', borderRadius: 20, flexShrink: 0,
          background: allRequired ? `${T.green}18` : `${T.purple}18`,
          border: `1px solid ${allRequired ? T.green + '44' : T.purple + '44'}`,
          fontSize: 11, fontWeight: 700,
          color: allRequired ? T.green : T.purpleL,
        }}>
          {completedCount}/{steps.length}
        </div>

        {expanded
          ? <ChevronUp size={16} color={T.textMut} />
          : <ChevronDown size={16} color={T.textMut} />
        }

        {/* Hide for now — prominent, returns next session */}
        <div
          onClick={e => { e.stopPropagation(); hideForNow() }}
          title="Hide for now (shows again next session)"
          style={{
            display: 'flex', alignItems: 'center', gap: 4,
            padding: '4px 10px', borderRadius: 6, cursor: 'pointer',
            background: `${T.textMut}12`, border: `1px solid ${T.textMut}28`,
            color: T.textMut, fontSize: 11, fontWeight: 600,
            whiteSpace: 'nowrap', flexShrink: 0,
            transition: 'all 0.15s',
          }}
          onMouseEnter={e => { e.currentTarget.style.background = `${T.textMut}22`; e.currentTarget.style.color = T.textSec }}
          onMouseLeave={e => { e.currentTarget.style.background = `${T.textMut}12`; e.currentTarget.style.color = T.textMut }}
        >
          <X size={11} /> Hide
        </div>
      </button>

      {/* ── Expandable body ── */}
      {expanded && (
        <div style={{ padding: '20px 20px 16px' }}>
          <ProgressBar completed={completedCount} total={steps.length} />

          {/* Step 1: Server running */}
          <Step
            done={serverOnline}
            icon={Zap}
            color={T.cyan}
            title="Backend server running"
            desc="Core ingestor and query gateway are online and reachable."
          />

          {/* Step 2: Data source connected */}
          <Step
            done={hasData}
            icon={Radio}
            color={T.purple}
            title="Connect a data source"
            desc={
              hasData
                ? `${metrics?.unique_series_active?.toLocaleString()} active series flowing in.`
                : "Set up a scraper to push Prometheus metrics into TSDB.ai. Use the Scrapers page to auto-generate a config for Linux, macOS, Docker, or Kubernetes."
            }
            action={hasData ? null : "Open Scrapers"}
            onAction={() => navigate('/scrapers')}
          />

          {/* Step 3: Wait for compression */}
          <Step
            done={hasChunks}
            icon={Database}
            color={T.amber}
            title="First compression cycle"
            desc={
              hasChunks
                ? `${metrics?.total_chunks_modeled?.toLocaleString()} polynomial model chunks stored.`
                : `Waiting for ${100 - (metrics?.total_samples_ingested ?? 0)} more samples per series to trigger compression. At a 15s scrape interval this takes ~25 min. Speed it up by running the mock scraper at --interval 5.`
            }
          />

          {/* Step 4: AI key */}
          <Step
            done={hasAIKey}
            icon={Bot}
            color={T.cyan}
            title="Configure an AI key"
            desc={
              hasAIKey
                ? "AI key configured — AI Chat is ready."
                : "Add an OpenAI or Anthropic API key to enable the AI Chat page, which lets you ask natural language questions about your metrics."
            }
            action={hasAIKey ? null : "Open Settings"}
            onAction={() => navigate('/settings')}
          />

          {/* Step 5: License (optional) */}
          <Step
            done={isLicensed}
            optional
            icon={Key}
            color={T.amber}
            title="Activate a Pro license"
            desc={
              isLicensed
                ? "Pro license active — all features unlocked."
                : "Unlock Alert Builder, Chat Integrations, and the Root Cause Graph. Annual licenses available at tsdb.ai/pro."
            }
            action={isLicensed ? null : "View Pro"}
            onAction={() => window.open('https://tsdb.ai/pro', '_blank')}
          />

          {/* Footer */}
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            marginTop: 12, paddingTop: 12, borderTop: `1px solid ${T.border}`,
          }}>
            <a
              href="https://tsdb.ai/docs"
              target="_blank"
              rel="noopener noreferrer"
              style={{
                display: 'flex', alignItems: 'center', gap: 5,
                fontSize: 11, color: T.textMut, textDecoration: 'none',
              }}
              onMouseEnter={e => e.currentTarget.style.color = T.cyan}
              onMouseLeave={e => e.currentTarget.style.color = T.textMut}
            >
              <ExternalLink size={11} /> View full documentation
            </a>
            <button
              onClick={dismissForever}
              style={{
                fontSize: 11, color: T.textMut, background: 'none',
                border: 'none', cursor: 'pointer', padding: '2px 0',
                opacity: 0.7,
              }}
              onMouseEnter={e => e.currentTarget.style.opacity = '1'}
              onMouseLeave={e => e.currentTarget.style.opacity = '0.7'}
              title="Permanently hide this checklist"
            >
              Don't show again
            </button>
          </div>
        </div>
      )}

      <style>{`
        @keyframes ping {
          0%   { transform: scale(1);   opacity: 0.75; }
          75%  { transform: scale(1.8); opacity: 0;    }
          100% { transform: scale(1.8); opacity: 0;    }
        }
      `}</style>
    </div>
  )
}
