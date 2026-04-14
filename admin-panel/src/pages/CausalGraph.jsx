import { useState, useEffect, useRef } from 'react'
import { useTheme } from '../context/ThemeContext'
import { fetchCausalGraph } from '../api'
import ProGate from '../components/ProGate'
import { useLicense } from '../context/LicenseContext'
import { GitBranch, Zap, RefreshCw, ChevronRight, ArrowRight, Activity } from 'lucide-react'

// Simple force-directed layout using d3-style simulation
function useLayout(nodes, edges) {
  const [positions, setPositions] = useState({})

  useEffect(() => {
    if (nodes.length === 0) return
    // Initial random positions in a circle
    const r = Math.min(260, 80 + nodes.length * 20)
    const pos = {}
    nodes.forEach((n, i) => {
      const angle = (2 * Math.PI * i) / nodes.length
      pos[n.id] = {
        x: 320 + r * Math.cos(angle),
        y: 220 + r * Math.sin(angle),
      }
    })
    // Simple force iterations
    for (let iter = 0; iter < 60; iter++) {
      const forces = {}
      nodes.forEach(n => { forces[n.id] = { x: 0, y: 0 } })
      // Repulsion
      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
          const a = nodes[i].id, b = nodes[j].id
          const dx = pos[a].x - pos[b].x
          const dy = pos[a].y - pos[b].y
          const d = Math.sqrt(dx * dx + dy * dy) + 0.01
          const f = 2000 / (d * d)
          forces[a].x += f * dx / d
          forces[a].y += f * dy / d
          forces[b].x -= f * dx / d
          forces[b].y -= f * dy / d
        }
      }
      // Attraction along edges
      edges.forEach(e => {
        const a = e.source, b = e.target
        if (!pos[a] || !pos[b]) return
        const dx = pos[b].x - pos[a].x
        const dy = pos[b].y - pos[a].y
        const d = Math.sqrt(dx * dx + dy * dy) + 0.01
        const f = (d - 120) * 0.05
        forces[a].x += f * dx / d
        forces[a].y += f * dy / d
        forces[b].x -= f * dx / d
        forces[b].y -= f * dy / d
      })
      // Center gravity
      nodes.forEach(n => {
        forces[n.id].x += (320 - pos[n.id].x) * 0.01
        forces[n.id].y += (220 - pos[n.id].y) * 0.01
      })
      // Apply
      const damp = 0.4
      nodes.forEach(n => {
        pos[n.id].x += forces[n.id].x * damp
        pos[n.id].y += forces[n.id].y * damp
      })
    }
    setPositions({ ...pos })
  }, [nodes.length, edges.length])

  return positions
}

// ── Tooltip component rendered outside SVG so it can overflow the canvas ──────
function GraphTooltip({ tooltip }) {
  const { T } = useTheme()
  if (!tooltip) return null
  const { x, y, content } = tooltip
  // Clamp so it doesn't go off-screen (rough: tooltip ~220px wide, 160px tall)
  const tx = Math.min(x + 14, window.innerWidth - 240)
  const ty = Math.max(y - 10, 4)
  return (
    <div style={{
      position: 'fixed', left: tx, top: ty,
      background: '#0f1117', border: `1px solid ${T.cyan}55`,
      borderRadius: 10, padding: '10px 13px', minWidth: 200, maxWidth: 300,
      boxShadow: `0 4px 24px #00000088, 0 0 0 1px ${T.cyan}22`,
      pointerEvents: 'none', zIndex: 9999,
      fontSize: 11, lineHeight: 1.6, color: T.textSec,
    }}>
      {content}
    </div>
  )
}

function GraphCanvas({ nodes, edges, selected, onSelect }) {
  const { T } = useTheme()
  const pos = useLayout(nodes, edges)
  const svgRef = useRef(null)
  const [drag, setDrag] = useState(null)
  const [localPos, setLocalPos] = useState(pos)
  const [tooltip, setTooltip] = useState(null)

  useEffect(() => { setLocalPos(pos) }, [pos])

  const getXY = (e) => {
    const rect = svgRef.current.getBoundingClientRect()
    return { x: e.clientX - rect.left, y: e.clientY - rect.top }
  }

  if (nodes.length === 0) {
    return (
      <div style={{
        height: 440, display: 'flex', alignItems: 'center', justifyContent: 'center',
        color: T.textMut, fontSize: 13, background: T.bgPanel, borderRadius: 12,
        border: `1px solid ${T.border}`,
      }}>
        No causal relationships detected yet. Run the TSDB server with vector data to populate.
      </div>
    )
  }

  const handleMouseDown = (e, nodeId) => {
    e.stopPropagation()
    onSelect(nodeId)
    const xy = getXY(e)
    setDrag({ nodeId, ox: xy.x - (localPos[nodeId]?.x || 0), oy: xy.y - (localPos[nodeId]?.y || 0) })
  }

  const handleMouseMove = (e) => {
    if (!drag) return
    const xy = getXY(e)
    setLocalPos(p => ({
      ...p,
      [drag.nodeId]: { x: xy.x - drag.ox, y: xy.y - drag.oy },
    }))
  }

  const handleMouseUp = () => setDrag(null)

  // Build node tooltip content
  const nodeTooltipContent = (nodeId) => {
    const inEdges  = edges.filter(e => e.target === nodeId)
    const outEdges = edges.filter(e => e.source === nodeId)
    const shortId  = nodeId.split('{')[0]
    const labels   = nodeId.match(/\{(.+)\}/)
    const labelStr = labels ? labels[1] : ''
    return (
      <div>
        <div style={{ color: T.cyan, fontWeight: 700, marginBottom: 6, fontFamily: T.mono, fontSize: 10, wordBreak: 'break-all' }}>
          {shortId}
        </div>
        {labelStr && (
          <div style={{ color: T.textMut, fontSize: 10, marginBottom: 8, fontFamily: T.mono, wordBreak: 'break-all' }}>
            {'{' + labelStr + '}'}
          </div>
        )}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '4px 12px', marginBottom: 8 }}>
          <Stat label="Upstream" value={inEdges.length} color={T.purple} />
          <Stat label="Downstream" value={outEdges.length} color={T.cyan} />
        </div>
        {inEdges.length > 0 && (
          <EdgeBlock title="Caused by" edgeList={inEdges} getOther={e => e.source} nodes={nodes} />
        )}
        {outEdges.length > 0 && (
          <EdgeBlock title="Leads to" edgeList={outEdges} getOther={e => e.target} nodes={nodes} />
        )}
      </div>
    )
  }

  // Build edge tooltip content
  const edgeTooltipContent = (edge) => {
    const srcLabel = nodes.find(n => n.id === edge.source)?.label || edge.source.split('{')[0]
    const dstLabel = nodes.find(n => n.id === edge.target)?.label || edge.target.split('{')[0]
    return (
      <div>
        <div style={{ color: T.purple, fontWeight: 700, marginBottom: 8, fontSize: 10 }}>Causal Edge</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8, flexWrap: 'wrap' }}>
          <span style={{ color: T.textSec, fontFamily: T.mono, fontSize: 10 }}>{srcLabel}</span>
          <span style={{ color: T.purple }}>→</span>
          <span style={{ color: T.textSec, fontFamily: T.mono, fontSize: 10 }}>{dstLabel}</span>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '4px 12px' }}>
          <Stat label="Lag" value={`${edge.lag_seconds}s`} color={T.cyan} />
          <Stat label="Correlation" value={`r=${edge.max_correlation?.toFixed(3) ?? '—'}`} color={T.amber} />
          <Stat label="Observations" value={edge.observation_count ?? '—'} color={T.textSec} />
          <Stat label="Type" value={edge.lag_seconds > 30 ? 'Long lag' : 'Short lag'} color={T.textMut} />
        </div>
        <div style={{ marginTop: 8, fontSize: 10, color: T.textMut, borderTop: `1px solid ${T.border}`, paddingTop: 6 }}>
          {edge.lag_seconds > 30
            ? 'Dashed line: delayed causal signal (>30s)'
            : 'Solid line: fast causal propagation (≤30s)'}
        </div>
      </div>
    )
  }

  return (
    <>
      <div style={{ position: 'relative' }}>
        <svg
          ref={svgRef}
          width="100%" height={440}
          style={{ background: T.bgPanel, borderRadius: 12, border: `1px solid ${T.border}`, cursor: drag ? 'grabbing' : 'default', display: 'block' }}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onMouseLeave={() => { handleMouseUp(); setTooltip(null) }}
        >
          <defs>
            <marker id="arrow" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto">
              <path d="M0,0 L0,6 L8,3 z" fill={T.purple} opacity="0.7" />
            </marker>
            <marker id="arrow-sel" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto">
              <path d="M0,0 L0,6 L8,3 z" fill={T.cyan} />
            </marker>
            <filter id="glow-node">
              <feGaussianBlur stdDeviation="3" result="coloredBlur" />
              <feMerge><feMergeNode in="coloredBlur" /><feMergeNode in="SourceGraphic" /></feMerge>
            </filter>
          </defs>

          {/* Edges — wide invisible hit area for hover */}
          {edges.map((e, i) => {
            const a = localPos[e.source], b = localPos[e.target]
            if (!a || !b) return null
            const isSel = e.source === selected || e.target === selected
            const dx = b.x - a.x, dy = b.y - a.y
            const d = Math.sqrt(dx * dx + dy * dy)
            const r = 22
            const x2 = b.x - dx / d * r, y2 = b.y - dy / d * r
            const x1 = a.x + dx / d * r, y1 = a.y + dy / d * r
            const mx = (x1 + x2) / 2, my = (y1 + y2) / 2
            return (
              <g key={i}
                onMouseEnter={ev => setTooltip({ x: ev.clientX, y: ev.clientY, content: edgeTooltipContent(e) })}
                onMouseLeave={() => setTooltip(null)}
                style={{ cursor: 'crosshair' }}
              >
                {/* Invisible wide stroke for easier hover capture */}
                <line x1={x1} y1={y1} x2={x2} y2={y2} stroke="transparent" strokeWidth={12} />
                <line
                  x1={x1} y1={y1} x2={x2} y2={y2}
                  stroke={isSel ? T.cyan : T.purple}
                  strokeWidth={isSel ? 1.8 : 1}
                  strokeOpacity={isSel ? 0.9 : 0.4}
                  markerEnd={`url(#${isSel ? 'arrow-sel' : 'arrow'})`}
                  strokeDasharray={e.lag_seconds > 30 ? '4 3' : 'none'}
                />
                <text
                  x={mx} y={my - 5}
                  textAnchor="middle" fontSize={9}
                  fill={isSel ? T.cyan : T.textMut}
                  opacity={isSel ? 1 : 0.5}
                  style={{ pointerEvents: 'none' }}
                >
                  {e.lag_seconds}s lag
                </text>
              </g>
            )
          })}

          {/* Nodes */}
          {nodes.map(n => {
            const p = localPos[n.id]
            if (!p) return null
            const isSel = n.id === selected
            const color = isSel ? T.cyan : T.purple
            const inDeg  = edges.filter(e => e.target === n.id).length
            const outDeg = edges.filter(e => e.source === n.id).length
            const size   = 18 + Math.min(outDeg * 3, 12)

            return (
              <g key={n.id} style={{ cursor: 'grab' }}
                onMouseDown={e => handleMouseDown(e, n.id)}
                onMouseEnter={e => setTooltip({ x: e.clientX, y: e.clientY, content: nodeTooltipContent(n.id) })}
                onMouseLeave={() => setTooltip(null)}
              >
                {isSel && <circle cx={p.x} cy={p.y} r={size + 6} fill={`${T.cyan}18`} />}
                <circle
                  cx={p.x} cy={p.y} r={size}
                  fill={`${color}22`}
                  stroke={color}
                  strokeWidth={isSel ? 2 : 1}
                  filter={isSel ? 'url(#glow-node)' : 'none'}
                />
                <text
                  x={p.x} y={p.y + 4}
                  textAnchor="middle" fontSize={9}
                  fill={color} fontWeight={isSel ? 700 : 500}
                  fontFamily="monospace"
                  style={{ pointerEvents: 'none' }}
                >
                  {n.label.length > 14 ? n.label.slice(0, 13) + '…' : n.label}
                </text>
                {(inDeg > 0 || outDeg > 0) && (
                  <text x={p.x} y={p.y + size + 12} textAnchor="middle" fontSize={8} fill={T.textMut} style={{ pointerEvents: 'none' }}>
                    {inDeg}↓ {outDeg}↑
                  </text>
                )}
              </g>
            )
          })}
        </svg>
      </div>
      <GraphTooltip tooltip={tooltip} />
    </>
  )
}

// Small helpers for tooltip layout
function Stat({ label, value, color }) {
  const { T } = useTheme()
  return (
    <div>
      <div style={{ fontSize: 9, color: T.textMut, textTransform: 'uppercase', letterSpacing: '0.06em' }}>{label}</div>
      <div style={{ fontSize: 12, fontWeight: 700, color, fontFamily: T.mono }}>{value}</div>
    </div>
  )
}

function EdgeBlock({ title, edgeList, getOther, nodes }) {
  const { T } = useTheme()
  return (
    <div style={{ marginTop: 6 }}>
      <div style={{ fontSize: 9, color: T.textMut, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 3 }}>{title}</div>
      {edgeList.slice(0, 4).map((e, i) => {
        const otherId = getOther(e)
        const otherLabel = nodes.find(n => n.id === otherId)?.label || otherId.split('{')[0]
        return (
          <div key={i} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: T.textSec, gap: 8, marginBottom: 2 }}>
            <span style={{ fontFamily: T.mono, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>{otherLabel}</span>
            <span style={{ color: T.cyan, flexShrink: 0 }}>{e.lag_seconds}s</span>
            <span style={{ color: T.amber, flexShrink: 0 }}>r={e.max_correlation?.toFixed(2) ?? '—'}</span>
          </div>
        )
      })}
      {edgeList.length > 4 && <div style={{ fontSize: 9, color: T.textMut, marginTop: 2 }}>+{edgeList.length - 4} more</div>}
    </div>
  )
}

function EdgeList({ edges, nodes, selected }) {
  const { T } = useTheme()
  const relevant = selected
    ? edges.filter(e => e.source === selected || e.target === selected)
    : edges.slice(0, 20)

  const nodeLabel = (id) => nodes.find(n => n.id === id)?.label || id

  return (
    <div style={{ background: T.bgCard, borderRadius: 10, border: `1px solid ${T.border}`, overflow: 'hidden' }}>
      <div style={{ padding: '10px 14px', background: T.bgPanel, borderBottom: `1px solid ${T.border}`, fontSize: 10, color: T.textMut, fontWeight: 700, letterSpacing: '0.07em' }}>
        {selected ? `EDGES FOR ${nodeLabel(selected)}` : `TOP EDGES (${relevant.length})`}
      </div>
      {relevant.length === 0 && (
        <div style={{ padding: '20px', fontSize: 12, color: T.textMut, textAlign: 'center' }}>
          No edges found
        </div>
      )}
      {relevant.map((e, i) => (
        <div key={i} style={{
          display: 'flex', alignItems: 'center', gap: 8,
          padding: '9px 14px', borderBottom: `1px solid ${T.border}`,
          fontSize: 11,
        }}>
          <span style={{ color: T.textSec, fontFamily: T.mono, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
            {nodeLabel(e.source)}
          </span>
          <ArrowRight size={10} color={T.purple} style={{ flexShrink: 0 }} />
          <span style={{ color: T.textSec, fontFamily: T.mono, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
            {nodeLabel(e.target)}
          </span>
          <span style={{ fontSize: 10, color: T.cyan, fontFamily: T.mono, flexShrink: 0, minWidth: 50, textAlign: 'right' }}>
            {e.lag_seconds}s
          </span>
          <span style={{ fontSize: 10, color: T.textMut, fontFamily: T.mono, flexShrink: 0, minWidth: 40, textAlign: 'right' }}>
            r={e.max_correlation?.toFixed(2) ?? '—'}
          </span>
        </div>
      ))}
    </div>
  )
}

function CausalGraphContent() {
  const { T } = useTheme()

  const [graphData, setGraphData] = useState({ nodes: [], edges: [] })
  const [loading, setLoading] = useState(false)
  const [selected, setSelected] = useState(null)

  const load = async () => {
    setLoading(true)
    const d = await fetchCausalGraph()
    // Build node/edge structure from API response
    const edgeList = d?.edges || []
    const nodeIds = new Set()
    edgeList.forEach(e => { nodeIds.add(e.source_metric); nodeIds.add(e.target_metric) })
    const nodes = Array.from(nodeIds).map(id => ({
      id,
      label: id.split('{')[0].split('.').slice(-2).join('.'), // Shortened label
    }))
    const edges = edgeList.map(e => ({
      source: e.source_metric,
      target: e.target_metric,
      lag_seconds: e.lag_seconds || 0,
      max_correlation: e.max_correlation,
    }))
    setGraphData({ nodes, edges })
    setLoading(false)
  }

  useEffect(() => { load() }, [])

  const selectedNode = graphData.nodes.find(n => n.id === selected)
  const inEdges = graphData.edges.filter(e => e.target === selected)
  const outEdges = graphData.edges.filter(e => e.source === selected)

  return (
    <div style={{ padding: '28px 32px', overflowY: 'auto', flex: 1, maxWidth: 1020 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24 }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
            <h1 style={{ fontSize: 22, fontWeight: 700, color: T.textPri }}>Root Cause Graph</h1>
            <span style={{
              fontSize: 10, fontWeight: 700, color: T.amber,
              background: `${T.amber}18`, border: `1px solid ${T.amber}33`,
              borderRadius: 20, padding: '3px 10px', display: 'flex', alignItems: 'center', gap: 4,
            }}>
              <Zap size={10} /> PRO
            </span>
          </div>
          <p style={{ fontSize: 13, color: T.textMut }}>
            Inferred causal relationships between metrics via lag correlation analysis.
            Drag nodes to explore. Click to inspect edges.
          </p>
        </div>
        <button onClick={load} disabled={loading} style={{
          display: 'flex', alignItems: 'center', gap: 7,
          padding: '8px 16px', borderRadius: 8, border: `1px solid ${T.border}`,
          background: T.bgCard, color: T.textSec, fontSize: 13, cursor: 'pointer',
        }}>
          <RefreshCw size={13} />
          Refresh
        </button>
      </div>

      {/* Stats */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12, marginBottom: 20 }}>
        {[
          { label: 'Metrics (nodes)', value: graphData.nodes.length, color: T.cyan },
          { label: 'Causal edges', value: graphData.edges.length, color: T.purple },
          { label: 'Selected',
            value: selectedNode ? selectedNode.label.slice(0, 16) : '—',
            color: selectedNode ? T.cyan : T.textMut },
        ].map(s => (
          <div key={s.label} style={{
            background: T.bgCard, borderRadius: 10, padding: '12px 16px',
            border: `1px solid ${T.border}`,
          }}>
            <div style={{ fontSize: 10, color: T.textMut, fontWeight: 700, letterSpacing: '0.07em', marginBottom: 5 }}>
              {s.label.toUpperCase()}
            </div>
            <div style={{ fontSize: 18, fontWeight: 700, color: s.color, fontFamily: T.mono }}>
              {s.value}
            </div>
          </div>
        ))}
      </div>

      {/* Selected node detail */}
      {selected && (
        <div style={{
          background: T.bgCard, borderRadius: 10, padding: '12px 18px',
          border: `1px solid ${T.cyan}44`, marginBottom: 16,
          display: 'flex', alignItems: 'center', gap: 16,
          boxShadow: glow.cyan,
        }}>
          <Activity size={14} color={T.cyan} />
          <span style={{ flex: 1, fontSize: 12, color: T.cyan, fontFamily: T.mono, fontWeight: 700 }}>
            {selected}
          </span>
          <span style={{ fontSize: 11, color: T.textMut }}>
            {inEdges.length} upstream · {outEdges.length} downstream
          </span>
          <button onClick={() => setSelected(null)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: T.textMut, fontSize: 13 }}>✕</button>
        </div>
      )}

      {loading ? (
        <div style={{ height: 440, display: 'flex', alignItems: 'center', justifyContent: 'center', color: T.textMut, fontSize: 13 }}>
          Loading causal graph…
        </div>
      ) : (
        <GraphCanvas
          nodes={graphData.nodes}
          edges={graphData.edges}
          selected={selected}
          onSelect={id => setSelected(id === selected ? null : id)}
        />
      )}

      <div style={{ marginTop: 20 }}>
        <EdgeList edges={graphData.edges} nodes={graphData.nodes} selected={selected} />
      </div>

      {/* Legend */}
      <div style={{
        marginTop: 16, padding: '12px 16px', background: T.bgPanel, borderRadius: 8,
        border: `1px solid ${T.border}`, display: 'flex', gap: 24, flexWrap: 'wrap',
        fontSize: 11, color: T.textMut,
      }}>
        <span><span style={{ color: T.purple }}>—→</span> solid = short lag (≤30s)</span>
        <span><span style={{ color: T.purple }}>- -→</span> dashed = longer lag</span>
        <span>↓ = in-degree · ↑ = out-degree per node</span>
        <span>Edge direction = inferred causality (complexity gradient)</span>
      </div>
    </div>
  )
}

export default function CausalGraph() {
  const { isProActive } = useLicense()
  if (!isProActive) return <ProGate feature="Root Cause Graph" />
  return <CausalGraphContent />
}
