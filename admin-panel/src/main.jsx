import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { ThemeProvider } from './context/ThemeContext'

console.log(
  '%c' +
  '    _      ___     ___   _  _  ___  ___ _  _  ___\n' +
  '   /_\\    |_ _|   | __|| \\| |/ __||_ _|| \\| || __|\n' +
  '  / _ \\    | |    | _| | .` || (_ || | || .` || _|\n' +
  ' /_/ \\_\\  |___|   |___|_|\\_| \\___||___|_|\\_||___|\n' +
  '\n' +
  '  ___  _____  ___  ___  _____  _  _  ___\n' +
  ' / __|_   _|/ _ \\| _ \\_   _|| \\| |/ __|\n' +
  ' \\__ \\ | | | |_| |   / | |  | .` || (_ |\n' +
  ' |___/ |_|  \\___/|_|_\\ |_|  |_|\\_| \\___|',
  'color: #22d3ee; font-family: monospace; font-size: 11px; line-height: 1.6'
)
console.log('%c TSDB.ai Admin Panel — https://tsdb.ai', 'color: #a78bfa; font-family: monospace; font-size: 11px; font-weight: bold')

// Global CSS reset
const style = document.createElement('style')
style.textContent = `
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Inter', 'Segoe UI', sans-serif;
    -webkit-font-smoothing: antialiased;
    background: ${localStorage.getItem('tsdb_theme') === 'light' ? '#f0f4f8' : '#070711'};
    color: ${localStorage.getItem('tsdb_theme') === 'light' ? '#0f172a' : '#e2e8f0'};
    overflow: hidden;
  }
  ::-webkit-scrollbar { width: 6px; height: 6px; }
  ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-thumb { background: #334155; border-radius: 3px; }
  ::-webkit-scrollbar-thumb:hover { background: #475569; }
  input, select, button, textarea { font-family: inherit; }
  a { color: inherit; }
`
document.head.appendChild(style)

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <ThemeProvider>
      <App />
    </ThemeProvider>
  </StrictMode>
)
