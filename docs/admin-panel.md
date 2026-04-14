# Admin Panel

The Admin Panel is a React-based web UI for monitoring, configuring, and managing your TSDB.ai instance. It runs as a Vite dev server in development and as a static build in production/Docker.

## Pages

### Free

| Page | Route | Description |
|---|---|---|
| Dashboard | `/` | Live metric charts with time-range selection |
| AI Chat | `/ai-dashboard` | Natural language interface to your metrics |
| Anomalies | `/anomalies` | Timeline of detected anomaly events |
| Forecast | `/forecast` | Forward projections with confidence bands |
| Patterns | `/patterns` | Registered behavioral fingerprints |
| Regime Changes | `/regimes` | Detected baseline shifts |
| Components | `/instance` | Real-time health of all internal services |
| Scrapers | `/scrapers` | Scraper setup wizard (Linux/macOS/Docker/K8s) |
| Configuration | `/config` | Live configuration editor |
| Settings | `/settings` | License status and instance settings |

### Pro

| Page | Route | Description |
|---|---|---|
| Chat Integrations | `/chat` | Slack, Teams, Webex, Telegram webhooks |
| Alert Builder | `/alerts` | Threshold, RMSE, forecast-breach alert rules |
| Root Cause Graph | `/causal` | Interactive causal relationship explorer |

## Running Locally

```bash
# Install dependencies (first time only)
cd v0.9/admin-panel
npm install

# Start with defaults (proxies to localhost:8080)
./install/local/start-ui.sh

# Custom port or backend
./install/local/start-ui.sh --port 4000 --backend http://my-server:8080
```

The UI will be available at `http://localhost:3000`.

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `TSDB_UI_PORT` | 3000 | UI dev server port |
| `TSDB_UI_HOST` | localhost | UI dev server host |
| `TSDB_BACKEND_URL` | `http://localhost:8080` | Backend proxy target |

## Building for Production

```bash
cd v0.9/admin-panel
npm run build
```

Output is written to `admin-panel/dist/`. Serve this with any static file server or embed it into the Docker image.

## Tech Stack

- **React 18** with React Router v6
- **Vite** for development server and production builds
- **Lucide React** for icons
- **Context API** for license state (`LicenseContext`)
- No external CSS framework — all styles are inline with the custom `theme.js` token system

## License Context

The UI reads license status from `/internal/license` on mount and every 5 minutes. License state is distributed globally via `LicenseContext`, which drives:

- Pro feature gate screens
- Expiry warning banners (30 days, 7 days, expired, hard-blocked)
- Footer tier badge (PRO / PRO GRACE / FREE + UNLICENSED)
- Settings license status card
