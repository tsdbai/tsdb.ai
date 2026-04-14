import { createContext, useContext, useState, useEffect } from 'react'
import { darkTheme, lightTheme, makeGlow } from '../theme'

const ThemeContext = createContext(null)

export function ThemeProvider({ children }) {
  const [isDark, setIsDark] = useState(() => {
    const saved = localStorage.getItem('tsdb_theme')
    return saved ? saved === 'dark' : true   // default: dark
  })

  const toggle = () => setIsDark(d => {
    const next = !d
    localStorage.setItem('tsdb_theme', next ? 'dark' : 'light')
    return next
  })

  // Keep <html> background in sync so there's no flash on page edges
  useEffect(() => {
    document.documentElement.style.background = isDark ? '#070711' : '#f0f4f8'
    document.body.style.background            = isDark ? '#070711' : '#f0f4f8'
  }, [isDark])

  const T    = isDark ? darkTheme  : lightTheme
  const glow = makeGlow(isDark)

  return (
    <ThemeContext.Provider value={{ T, glow, isDark, toggle }}>
      {children}
    </ThemeContext.Provider>
  )
}

export function useTheme() {
  const ctx = useContext(ThemeContext)
  if (!ctx) throw new Error('useTheme must be used inside <ThemeProvider>')
  return ctx
}
