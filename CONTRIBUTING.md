# Contributing to TSDB.ai

First off — thank you. Every bug report, doc fix, and feature PR makes TSDB.ai better for everyone.

---

## Table of Contents

- [Ways to contribute](#ways-to-contribute)
- [Development setup](#development-setup)
- [Project structure](#project-structure)
- [Building the server](#building-the-server)
- [Running the admin panel](#running-the-admin-panel)
- [Running tests](#running-tests)
- [Submitting a pull request](#submitting-a-pull-request)
- [Code style](#code-style)
- [Good first issues](#good-first-issues)
- [Reporting bugs](#reporting-bugs)
- [Feature requests](#feature-requests)
- [Community](#community)

---

## Ways to contribute

| Type | Where |
|---|---|
| 🐛 Bug report | [GitHub Issues](../../issues/new?template=bug_report.md) |
| 💡 Feature request | [GitHub Issues](../../issues/new?template=feature_request.md) |
| 📖 Doc improvement | Edit any file in `docs/` or the root `README.md` |
| 🔧 Code fix / feature | Fork → branch → PR (see below) |
| 💬 Question / discussion | [GitHub Discussions](../../discussions) |

---

## Development setup

### Prerequisites

| Tool | Min version | Install |
|---|---|---|
| Go | 1.23 | [golang.org/dl](https://golang.org/dl/) |
| Node.js | 18.0 | [nodejs.org](https://nodejs.org/) |
| Git | any | [git-scm.com](https://git-scm.com/) |

You do **not** need Rust — `model_core.wasm` is pre-built and included in the repo.

### Clone and run

```bash
git clone https://github.com/tsdb-ai/tsdb.ai
cd tsdb.ai/v0.9

# Build and start the server (ingestor + query gateway + all services)
./install/local/start-server.sh

# In a second terminal — start the admin UI
./install/local/start-ui.sh

# Optional: stream synthetic mock metrics for local dev/testing
./install/local/start-mock.sh
```

The admin panel will be available at **http://localhost:3000**.

---

## Project structure

```
v0.9/
├── main.go                   Ingestor — write path, compression, anomaly detection
├── query_gateway.go          PromQL-compatible read path
├── deduper_service.go        Block deduplication + long-term storage
├── wal_shipper.go            WAL → block packaging + upload
├── vector_store.go           Behavioral vector database
├── pattern_registry.go       Named pattern fingerprints + auto-matching
├── causal_engine.go          Root cause graph — lag-correlation analysis
├── relationship_graph.go     Structural similarity graph
├── forecasting.go            Polynomial forward projection
├── model_compressor.go       Adaptive polynomial fitting (constant/linear/quadratic)
├── config.go                 All configuration — tsdb.yaml parsing + defaults
├── license.go                Ed25519-signed offline license verification
├── model_core.wasm           Pre-compiled Rust model evaluation (do not modify)
├── tsdb.yaml                 Configuration file (all keys are optional)
├── admin-panel/              React 18 + Vite + Recharts admin UI
│   └── src/
│       ├── pages/            One file per page (Dashboard, AIDashboard, etc.)
│       ├── components/       Shared UI components (Layout, ProGate, etc.)
│       ├── context/          React contexts (LicenseContext, ThemeContext)
│       └── theme.js          Dark/light colour tokens
├── install/
│   ├── local/               Shell scripts for local development
│   ├── docker/              Dockerfile + supervisord config
│   └── k8s/                 Kubernetes manifests
├── docs/                    Component documentation (mirrored at tsdb.ai/docs)
└── external_scrapers/       Optional external scraper (Go + Python)
```

---

## Building the server

Each service is a separate `go build` command. The `config.go` and `banner.go` files must be included in every binary since they're shared package-level code.

```bash
# Main ingestor (includes most components)
go build -o tsdb_ingestor \
  main.go model_compressor.go local_cleaner.go \
  pattern_registry.go causal_engine.go relationship_graph.go \
  vector_store.go forecasting.go s3_client.go s3_manifest.go \
  alerts.go scraper_agent.go cors.go ui_state_handler.go \
  mock_data_source.go license.go config.go banner.go

# Query gateway
go build -o query_gateway query_gateway.go query_vector.go s3_client.go s3_manifest.go config.go banner.go

# Deduplication service
go build -o deduper_service deduper_service.go s3_client.go s3_manifest.go config.go banner.go

# WAL shipper
go build -o wal_shipper wal_shipper.go s3_client.go s3_manifest.go config.go banner.go
```

Or use the install script which builds everything in the right order:

```bash
./install/local/start-server.sh   # builds binaries automatically if missing
```

---

## Running the admin panel

```bash
cd admin-panel
npm install
npm run dev        # dev server with hot reload on :3000
npm run build      # production build → dist/
```

The Vite dev server proxies `/api`, `/internal`, `/forecast`, etc. to the Go server on `:8080`, so you can run both together with no CORS config.

---

## Running tests

```bash
# Go — build check across all service entry points
go build ./...

# Go — vet (catches common mistakes)
go vet ./...

# Admin panel — type/lint check
cd admin-panel && npm run build
```

Formal unit tests are sparse right now — adding tests is a great way to contribute. See issues labeled [`good first issue`](../../issues?q=label%3A%22good+first+issue%22) for specific coverage gaps.

---

## Submitting a pull request

1. **Fork** the repo and create a branch from `main`:
   ```bash
   git checkout -b fix/my-descriptive-branch-name
   ```

2. **Make your changes.** Keep commits focused — one logical change per commit.

3. **Test locally** — make sure `go build ./...` and `go vet ./...` pass. If you touched the admin panel, `npm run build` should succeed.

4. **Update docs** if your change affects user-visible behaviour — edit the relevant file in `docs/` or update `README.md`.

5. **Open the PR** against `main`. Fill out the PR template. Link any related issue with `Closes #123`.

6. **Be responsive** — if reviewers request changes, try to address them within a week. PRs that go quiet will be closed after 30 days but can be re-opened.

### What makes a PR easy to merge

- Small and focused. A 200-line PR gets reviewed faster than a 2000-line one.
- Has a clear description of *why* the change is needed, not just *what* it does.
- Doesn't break `go build ./...` or the admin panel build.
- Includes a doc update when user-visible behaviour changes.

---

## Code style

### Go

- Run `gofmt` before committing. The CI will catch unformatted code.
- Follow standard Go idioms — [Effective Go](https://go.dev/doc/effective_go) is the reference.
- Error messages are lowercase and don't end with punctuation: `"metric not found"` not `"Metric not found."`.
- Log lines use the existing `Logf(component, format, args...)` helper, not `fmt.Printf`.

### JavaScript / React

- No external state management libraries (no Redux, Zustand, etc.) — local `useState` and React Context only.
- All colours come from `useTheme()` → `T.bgCard`, `T.cyan`, etc. — never hardcode hex values in components.
- New pages go in `admin-panel/src/pages/`, new reusable components in `admin-panel/src/components/`.
- Keep components self-contained — no implicit globals.

---

## Good first issues

Looking for a place to start? These are well-scoped and don't require deep knowledge of the compression engine:

- **Add unit tests for `detectOverlayRemoveRequest`** — the regex parser in `AIDashboard.jsx` already has a test harness; expand coverage
- **Add a `--version` flag** to all binaries (they currently only print version in the banner)
- **Improve empty states** on the Anomalies and Regimes pages when the backend is offline
- **Add keyboard shortcuts** to the AI Dashboard (next/prev chart, etc.)
- **Write a `docker-compose.yml`** for the full stack
- **Add a liveness endpoint** `GET /healthz` to each service

Browse all [`good first issue`](../../issues?q=label%3A%22good+first+issue%22) labels for the current list.

---

## Reporting bugs

Use the [bug report template](../../issues/new?template=bug_report.md). The most useful bug reports include:

- TSDB.ai version (`v0.9`, commit hash, or Docker tag)
- OS and Go version
- Steps to reproduce — minimal is better
- What you expected vs. what happened
- Relevant log output (from the terminal running `start-server.sh`)

---

## Feature requests

Use the [feature request template](../../issues/new?template=feature_request.md). Before opening one, search existing issues — it may already be planned or discussed.

---

## Community

- **GitHub Discussions** — questions, ideas, show-and-tell: [github.com/tsdb-ai/tsdb.ai/discussions](../../discussions)
- **Website** — [tsdb.ai](https://tsdb.ai)
- **Pro / commercial** — [tsdb.ai/pro](https://tsdb.ai/pro)

---

## License

By contributing to TSDB.ai, you agree that your contributions will be licensed under the same [source-available license](./docs/license.md) as the project.
