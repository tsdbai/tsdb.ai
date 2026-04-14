import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const backend  = process.env.VITE_BACKEND_URL       || 'http://localhost:8080'
const queryGW  = process.env.VITE_QUERY_GATEWAY_URL || 'http://localhost:8081'

const proxy = {
  // Core ingestor routes
  ...Object.fromEntries(
    ['/api', '/internal', '/forecast', '/patterns', '/relationships', '/regime_changes']
      .map(path => [path, { target: backend, changeOrigin: true }])
  ),
  // Causal API sub-routes only — /causal itself is a SPA page and must NOT be proxied
  '/causal/graph':      { target: backend, changeOrigin: true },
  '/causal/upstream':   { target: backend, changeOrigin: true },
  '/causal/downstream': { target: backend, changeOrigin: true },
  // Query gateway — proxied under /qgw/* → strips prefix before forwarding
  '/qgw': {
    target: queryGW,
    changeOrigin: true,
    rewrite: path => path.replace(/^\/qgw/, ''),
  },
}

export default defineConfig({
  plugins: [react()],
  server: {
    port: 3000,
    proxy,
  }
})
