# Changelog

All notable changes to TSDB.ai are documented here.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).
Versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [0.9.0] — 2026-04-13

### Added

**Admin Panel**
- **Light / dark mode toggle** — persisted in `localStorage`, default dark. Sun/Moon button in sidebar footer. All 20 component files use the new `ThemeContext` / `useTheme()` hook — no hardcoded colours anywhere
- **Presentation mode full-height charts** — recharts `ResponsiveContainer` now fills the entire viewport in presentation mode via absolute-position wrapper trick; fixed a long-standing 260px height cap
- **Large metric title in presentation mode** — chart title renders at 28px/800 weight overlaid on the chart; metric name(s) shown in monospace beneath it. Reverts to normal 13px card header on exit
- **Pattern Registry — visual drag-to-select workflow** — completely redesigned registration flow: enter metric → chart loads → drag to highlight a time range → label and save. Three-step wizard replaces the old plain form. Recharts `ReferenceArea` used for live drag highlight
- **Pattern Registry — autocomplete** — metric name input autocompletes from the query gateway's label index
- **Causal Graph — node and edge hover tooltips** — hovering a node shows full metric name, upstream/downstream counts, and connected edge list with lag + correlation. Hovering an edge shows source → target, lag, correlation, and observation count. Tooltip uses `position: fixed` so it never clips
- **Root Cause Graph — seeded demo data** — `causal.json` pre-populated with 6 plausible causal edges between mock metrics on first startup; `seedMockCausalEdgesIfEmpty()` in `causal_engine.go` runs when the registry file is missing or empty
- **Pattern Registry — seeded demo data** — `patterns.json` pre-populated with 7 named behavioral fingerprints on first startup; `seedMockPatternsIfEmpty()` in `pattern_registry.go` writes and activates them immediately so `MatchPatterns` has data from the first ingested chunk
- **Brand icon** — new "Anomaly Pulse" SVG favicon replacing the `⬡` placeholder. Crisp at all sizes: integer coordinates, blur only on the peak dot, no ambient smear filter. Used in browser tab (`public/favicon.svg`) and sidebar (`TsdbIcon` component)
- **Synonym expansion for overlay removal** — `detectOverlayRemoveRequest` now matches natural synonyms: outlier/spike/aberration → anomaly; rolling average/smoothing line/MA → movingAverage; regression line/best fit/plot line/graph line → trendLine; note/tag/pin/event → annotation; SLA line/baseline/target line → thresholdLine; vertical lines/tick marks/interval lines → timeGrid. 61/61 test cases pass
- **Hard / smooth line toggle** — per-chart button (⌇/∿) toggles recharts `type` between `linear` and `monotone`. State persisted in chart spec

**Server**
- `seedMockCausalEdgesIfEmpty()` — auto-seeds causal graph on first run
- `seedMockPatternsIfEmpty()` — auto-seeds pattern registry on first run; writes `patterns.json` immediately so matches accumulate from first ingest

### Fixed

- **`/causal` 404 on direct navigation** — Vite proxy config had `/causal` in the broad catch-all list, intercepting SPA page navigations and forwarding them to the Go backend. Fixed by replacing with specific sub-routes: `/causal/graph`, `/causal/upstream`, `/causal/downstream`
- **Anomaly overlays off-chart** — overlay markers with epoch/ISO timestamps didn't align with recharts categorical XAxis strings. Fixed by `snapToRows()` which snaps any timestamp format to the nearest matching row time
- **"Remove all anomalies" pattern not matching** — regex prefix `anomal` left `ies` unmatched against `$` anchor. Fixed: `anomal(?:ies?|y)?`
- **Regex alternation leak in overlay detection** — `keyRe.source` containing `|` was embedded bare in a larger `new RegExp()` pattern, causing alternatives like `markers?` to match anywhere in the string. Fixed by wrapping with `(?:${keyRe.source})`
- **"Remove vertical lines" not matching timeGrid** — pattern only matched `vertical.?grid`. Added `vertical.?lines?` as a standalone alternative
- **Causal graph `loadCausalGraph` mutex deadlock** — removed `defer` unlock so `seedMockCausalEdgesIfEmpty` can acquire the mutex when called after load
- **Time dropdowns too narrow to read** — hour/minute selects in the date picker: `width: 42, fontSize: 11` → `width: 62, fontSize: 13`

### Changed

- **Sidebar** — icon enlarged to 42px, TSDB.ai logotype to 20px/800, sidebar width 220 → 240px
- **Version bump** — all internal references updated from `v0.8` → `v0.9`

---

## [0.8.0] — 2026-03-15

### Added

**Admin Panel**
- **AI Dashboard** — multi-tab canvas; Claude creates, modifies, and overlays charts via `<CHART>` tag protocol; natural language chart manipulation; bulk metric plotting; tool engine with 15 tools
- **Global time range picker** — Grafana-style preset bar (15m → 7d) + calendar date picker with drag-select. Preserves all chart spec properties (overlays, colours, AI tweaks) on refresh
- **MiniCalendar** — standalone FROM/TO calendar grid with month navigation for custom absolute ranges
- **Overlay system** — anomaly markers, moving averages, trend lines, threshold lines, annotations, time grids — all AI-addressable
- **`detectTimeRangeCommand`** — parses "show last 6 hours", "set to 30m", etc. without AI round-trip
- **`detectOverlayRemoveRequest`** — direct state mutation for "remove all anomalies" etc.; bypasses AI call entirely
- **`snapToRows()`** — converts any timestamp format to the nearest matching recharts categorical XAxis string
- **Presentation mode** — full-screen chart carousel with keyboard navigation, dot indicators, thumbnail strip, and PNG export

**Server**
- Phase 3 vector embeddings — 8D enriched embedding (`[a, b, c, rmse, rolling_rmse, direction, complexity, stability]`) replacing the original 3D `[a, b, c]` for all AI features
- Pattern Registry API — `POST /patterns/label`, `GET /patterns`
- Causal Engine — `GET /causal/graph`, `/causal/upstream`, `/causal/downstream`
- Relationship Graph — `GET /relationships`
- Alert Builder — rule engine with threshold, RMSE, % change, and forecast-breach types; Slack/Teams/Telegram delivery (Pro)
- Chat Integrations — Slack, Teams, Webex, Telegram webhook management (Pro)

### Changed

- `buildEnrichedEmbedding` refactored out of `main.go` into `pattern_registry.go` — shared by pattern matching, causal engine, and relationship graph
- `tabsRef` pattern added to `AIDashboard` to avoid stale closures in async handlers

---

## [0.7.0] — 2026-02-01

### Added

- Initial public release
- Polynomial model compression (constant / linear / quadratic adaptive fitting)
- WAL → block pipeline with deduplication service
- Query Gateway — PromQL-compatible `query_range` endpoint with WASM reconstruction
- Anomaly detection — seasonal RMSE baselines
- Regime change detection — model-ID ring buffer
- Forecasting — polynomial projection with confidence bands
- Vector Store — cosine similarity behavioral search
- S3 tiered long-term storage
- MCP Server — Claude integration via Model Context Protocol
- Admin Panel — React 18 + Recharts dashboard
- Self-monitoring exporter
- Mock data source for dev/demo
- Docker + Kubernetes deployment configs

---

[0.9.0]: https://github.com/tsdb-ai/tsdb.ai/compare/v0.8.0...v0.9.0
[0.8.0]: https://github.com/tsdb-ai/tsdb.ai/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/tsdb-ai/tsdb.ai/releases/tag/v0.7.0
