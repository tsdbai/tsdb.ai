// Brand / status colours are identical across themes — only bg/text/border change.

const BRAND = {
  purple:    '#7c3aed',
  purpleL:   '#9f67ff',
  cyan:      '#06b6d4',
  cyanL:     '#22d3ee',
  green:     '#10b981',
  red:       '#ef4444',
  amber:     '#f59e0b',
  mono:      "'JetBrains Mono', monospace",
}

export const darkTheme = {
  ...BRAND,
  bgRoot:    '#070711',
  bgPanel:   '#0d0d1a',
  bgCard:    '#111127',
  bgCardHov: '#14143a',
  bgInput:   '#0a0a1f',
  purpleDim: '#2d1b69',
  cyanDim:   '#0e4f5c',
  greenDim:  '#064e3b',
  redDim:    '#450a0a',
  amberDim:  '#451a03',
  textPri:   '#e2e8f0',
  textSec:   '#a0aec0',
  textMut:   '#64748b',
  border:    '#1e1e3f',
  borderBri: '#3d2f8a',
}

export const lightTheme = {
  ...BRAND,
  // Slightly deepen brand for contrast on white
  cyan:      '#0891b2',
  cyanL:     '#06b6d4',
  green:     '#059669',
  red:       '#dc2626',
  amber:     '#d97706',
  bgRoot:    '#f0f4f8',
  bgPanel:   '#f8fafc',
  bgCard:    '#ffffff',
  bgCardHov: '#f0f9ff',
  bgInput:   '#f1f5f9',
  purpleDim: '#ede9fe',
  cyanDim:   '#e0f2fe',
  greenDim:  '#d1fae5',
  redDim:    '#fee2e2',
  amberDim:  '#fef3c7',
  textPri:   '#0f172a',
  textSec:   '#475569',
  textMut:   '#94a3b8',
  border:    '#e2e8f0',
  borderBri: '#a78bfa',
}

export function makeGlow(isDark) {
  const o = isDark ? 1 : 0.5   // halve glow opacity in light mode
  return {
    purple: `0 0 20px rgba(124,58,237,${0.4*o}), 0 0 40px rgba(124,58,237,${0.15*o})`,
    cyan:   `0 0 20px rgba(6,182,212,${0.4*o}), 0 0 40px rgba(6,182,212,${0.15*o})`,
    red:    `0 0 20px rgba(239,68,68,${0.4*o})`,
    green:  `0 0 20px rgba(16,185,129,${0.4*o})`,
    amber:  `0 0 20px rgba(245,158,11,${0.4*o})`,
  }
}

// Legacy static exports — ThemeContext is the source of truth at runtime,
// but these let any non-context code still get a sensible default.
export const T    = darkTheme
export const glow = makeGlow(true)

export const gradientBorder = (color = darkTheme.purple) => ({
  border: `1px solid ${color}`,
  boxShadow: `0 0 12px ${color}33, inset 0 0 12px ${color}08`,
})
