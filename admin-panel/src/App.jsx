import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { LicenseProvider } from './context/LicenseContext'
import Layout from './components/Layout'
import Dashboard from './pages/Dashboard'
import Anomalies from './pages/Anomalies'
import Forecast from './pages/Forecast'
import Patterns from './pages/Patterns'
import Regimes from './pages/Regimes'
import ChatIntegrations from './pages/ChatIntegrations'
import AlertBuilder from './pages/AlertBuilder'
import CausalGraph from './pages/CausalGraph'
import Config from './pages/Config'
import Instance from './pages/Instance'
import Scrapers from './pages/Scrapers'
import AIChat from './pages/AIChat'
import AIDashboard from './pages/AIDashboard'
import Settings from './pages/Settings'
import MCP from './pages/MCP'
import AlertEvents from './pages/AlertEvents'

export default function App() {
  return (
    <BrowserRouter>
      <LicenseProvider>
      <Layout>
        <Routes>
          <Route path="/"           element={<Dashboard />} />
          <Route path="/anomalies"  element={<Anomalies />} />
          <Route path="/forecast"   element={<Forecast />} />
          <Route path="/patterns"   element={<Patterns />} />
          <Route path="/regimes"    element={<Regimes />} />
          <Route path="/chat"       element={<ChatIntegrations />} />
          <Route path="/alerts"     element={<AlertBuilder />} />
          <Route path="/causal"     element={<CausalGraph />} />
          <Route path="/config"        element={<Config />} />
          <Route path="/instance"      element={<Instance />} />
          <Route path="/scrapers"      element={<Scrapers />} />
          <Route path="/ai-chat"       element={<AIChat />} />
          <Route path="/ai-dashboard"  element={<AIDashboard />} />
          <Route path="/settings"      element={<Settings />} />
          <Route path="/mcp"           element={<MCP />} />
          <Route path="/alert-events"  element={<AlertEvents />} />
          <Route path="*"           element={<Navigate to="/" replace />} />
        </Routes>
      </Layout>
      </LicenseProvider>
    </BrowserRouter>
  )
}
