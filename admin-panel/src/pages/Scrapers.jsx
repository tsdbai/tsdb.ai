import { useState } from 'react'
import { useTheme } from '../context/ThemeContext'
import ScraperSetup from '../components/ScraperSetup'
import {
  Radio, Plus, Trash2, Settings, Copy, Check,
  Clock, Zap, Server,
} from 'lucide-react'

// ─── localStorage helpers ─────────────────────────────────────────────────────

const KEY = 'tsdb_scrapers'
function load() {
  try { return JSON.parse(localStorage.getItem(KEY) || '[]') } catch { return [] }
}
function save(list) { localStorage.setItem(KEY, JSON.stringify(list)) }

// ─── Status badge ─────────────────────────────────────────────────────────────

function StatusBadge({ color, label }) {
  const { T } = useTheme()
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 5,
      fontSize: 10, fontWeight: 700, padding: '2px 9px', borderRadius: 10,
      background: `${color}18`, border: `1px solid ${color}44`, color,
    }}>
      <span style={{ width: 5, height: 5, borderRadius: '50%', background: color }} />
      {label}
    </span>
  )
}

// ─── Scraper card ─────────────────────────────────────────────────────────────

function ScraperCard({ scraper: s, onEdit, onRemove }) {
  const { T } = useTheme()
  const [copied, setCopied] = useState(false)

  const copyYaml = () => {
    const yaml = [
      'scraper:',
      `  target_endpoint: "${s.targetEndpoint}"`,
      `  ingest_endpoint: "${s.ingestEndpoint}"`,
      `  interval_s: ${s.intervalS}`,
      `  timeout_s: ${s.timeoutS}`,
      `  max_buffer_bytes: ${s.maxBufferBytes}`,
      ...(s.proxyUrl ? [`  proxy_url: "${s.proxyUrl}"`] : []),
    ].join('\n')
    navigator.clipboard.writeText(yaml).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    })
  }

  return (
    <div style={{
      background: T.bgCard, borderRadius: 14, padding: '18px 20px',
      border: `1px solid ${T.cyanL}22`,
      boxShadow: `0 0 20px ${T.cyanL}08`,
      display: 'flex', flexDirection: 'column', gap: 14,
    }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{
            width: 36, height: 36, borderRadius: 10,
            background: `${T.cyanL}18`, border: `1px solid ${T.cyanL}33`,
            display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
          }}>
            <Radio size={16} color={T.cyanL} />
          </div>
          <div>
            <div style={{ fontSize: 14, fontWeight: 700, color: T.textPri }}>{s.name}</div>
            <div style={{ fontSize: 10, color: T.textMut, fontFamily: T.mono, marginTop: 1 }}>
              every {s.intervalS}s · timeout {s.timeoutS}s
            </div>
          </div>
        </div>
        <StatusBadge color={T.textSec} label="Registered" />
      </div>

      {/* Endpoint rows */}
      <div>
        {[
          { icon: Server, label: 'Target',  value: s.targetEndpoint },
          { icon: Zap,    label: 'Ingest',  value: s.ingestEndpoint },
          ...(s.proxyUrl ? [{ icon: Clock, label: 'Proxy', value: s.proxyUrl }] : []),
        ].map(({ icon: Icon, label, value }) => (
          <div key={label} style={{
            display: 'flex', alignItems: 'center', gap: 8,
            padding: '5px 0', borderBottom: `1px solid #1e1e3a`,
          }}>
            <Icon size={10} color={T.textMut} style={{ flexShrink: 0 }} />
            <span style={{ fontSize: 10, color: T.textMut, width: 38, flexShrink: 0 }}>{label}</span>
            <span style={{
              fontSize: 11, color: T.textSec, fontFamily: T.mono,
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1,
            }}>{value || '—'}</span>
          </div>
        ))}
      </div>

      {/* Actions */}
      <div style={{ display: 'flex', gap: 8 }}>
        <button
          onClick={onEdit}
          style={{
            flex: 1, padding: '7px 0', borderRadius: 7, cursor: 'pointer',
            background: T.bgPanel, border: `1px solid ${T.border}`,
            color: T.textSec, fontSize: 11, fontWeight: 600,
            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5,
          }}
        >
          <Settings size={11} /> Configure
        </button>
        <button
          onClick={copyYaml}
          style={{
            flex: 1, padding: '7px 0', borderRadius: 7, cursor: 'pointer',
            background: copied ? `${T.green}18` : T.bgPanel,
            border: `1px solid ${copied ? T.green + '55' : T.border}`,
            color: copied ? T.green : T.textSec, fontSize: 11, fontWeight: 600,
            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5,
            transition: 'all 0.2s',
          }}
        >
          {copied ? <Check size={11} /> : <Copy size={11} />}
          {copied ? 'Copied!' : 'YAML'}
        </button>
        <button
          onClick={onRemove}
          style={{
            padding: '7px 10px', borderRadius: 7, cursor: 'pointer',
            background: T.bgPanel, border: `1px solid ${T.border}`,
            color: T.red, fontSize: 11,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}
          onMouseEnter={e => { e.currentTarget.style.borderColor = T.red + '55' }}
          onMouseLeave={e => { e.currentTarget.style.borderColor = T.border }}
        >
          <Trash2 size={13} />
        </button>
      </div>
    </div>
  )
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function Scrapers() {
  const { T } = useTheme()
  const [scrapers, setScrapers] = useState(load)
  const [modal, setModal]       = useState(null) // null | 'new' | scraper-object

  const upsert = (s) => {
    setScrapers(prev => {
      const idx  = prev.findIndex(x => x.id === s.id)
      const next = idx >= 0 ? prev.map((x, i) => i === idx ? s : x) : [...prev, s]
      save(next)
      return next
    })
    setModal(null)
  }

  const remove = (id) => {
    setScrapers(prev => {
      const next = prev.filter(x => x.id !== id)
      save(next)
      return next
    })
  }

  return (
    <div style={{ padding: '24px 28px', overflowY: 'auto', flex: 1, width: '100%', boxSizing: 'border-box' }}>

      {/* Header */}
      <div style={{
        display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between',
        gap: 12, flexWrap: 'wrap', marginBottom: 28,
      }}>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 700, color: T.textPri, margin: 0 }}>Scrapers</h1>
          <p style={{ fontSize: 13, color: T.textMut, margin: '4px 0 0' }}>
            Prometheus-format scraper agents registered to this TSDB.ai instance
          </p>
        </div>
        <button
          onClick={() => setModal('new')}
          style={{
            display: 'flex', alignItems: 'center', gap: 7,
            padding: '9px 18px', borderRadius: 8, border: 'none', cursor: 'pointer',
            background: `linear-gradient(135deg, ${T.cyan}cc, ${T.purple}cc)`,
            color: '#fff', fontSize: 13, fontWeight: 600,
          }}
        >
          <Plus size={14} />
          Add Scraper
        </button>
      </div>

      {/* Stats strip */}
      {scrapers.length > 0 && (
        <div style={{
          display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 24,
        }}>
          {[
            { label: 'Registered',    value: scrapers.length,                     color: T.cyanL },
            { label: 'Avg Interval',  value: Math.round(scrapers.reduce((a, s) => a + s.intervalS, 0) / scrapers.length) + 's', color: T.textPri },
            { label: 'Targets',       value: new Set(scrapers.map(s => s.targetEndpoint)).size, color: T.textPri },
          ].map(({ label, value, color }) => (
            <div key={label} style={{
              flex: '1 1 120px', background: T.bgCard, borderRadius: 10, padding: '12px 16px',
              border: `1px solid ${T.border}`, display: 'flex', flexDirection: 'column', gap: 3,
            }}>
              <div style={{ fontSize: 10, color: T.textMut, fontWeight: 700, letterSpacing: '0.06em' }}>
                {label.toUpperCase()}
              </div>
              <div style={{ fontSize: 22, fontWeight: 700, color, fontFamily: T.mono }}>{value}</div>
            </div>
          ))}
        </div>
      )}

      {/* Content */}
      {scrapers.length === 0 ? (

        /* Empty state */
        <div style={{
          border: `2px dashed ${T.border}`, borderRadius: 16,
          padding: '60px 24px', textAlign: 'center',
        }}>
          <div style={{
            width: 56, height: 56, borderRadius: 14,
            background: `${T.cyanL}12`, border: `1px solid ${T.cyanL}33`,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            margin: '0 auto 16px',
          }}>
            <Radio size={24} color={T.cyanL} style={{ opacity: 0.6 }} />
          </div>
          <div style={{ fontSize: 16, fontWeight: 700, color: T.textSec, marginBottom: 8 }}>
            No scrapers registered
          </div>
          <div style={{ fontSize: 13, color: T.textMut, marginBottom: 24, maxWidth: 400, margin: '0 auto 24px' }}>
            Register a scraper to generate ready-to-run launch scripts for Linux, macOS, Docker, or Kubernetes.
          </div>
          <button
            onClick={() => setModal('new')}
            style={{
              padding: '10px 22px', borderRadius: 8, cursor: 'pointer',
              background: `linear-gradient(135deg, ${T.cyan}cc, ${T.purple}cc)`,
              border: 'none', color: '#fff', fontSize: 13, fontWeight: 600,
              display: 'inline-flex', alignItems: 'center', gap: 8,
            }}
          >
            <Plus size={14} />
            Register your first scraper
          </button>
        </div>

      ) : (

        /* Scraper cards */
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))',
          gap: 16,
        }}>
          {scrapers.map(s => (
            <ScraperCard
              key={s.id}
              scraper={s}
              onEdit={() => setModal(s)}
              onRemove={() => remove(s.id)}
            />
          ))}
        </div>

      )}

      {/* Modal */}
      {modal && (
        <ScraperSetup
          existing={modal === 'new' ? null : modal}
          onClose={() => setModal(null)}
          onSave={upsert}
        />
      )}
    </div>
  )
}
