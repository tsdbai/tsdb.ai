# Query Gateway

The Query Gateway serves Prometheus-compatible read queries by reconstructing time series from stored polynomial model coefficients. It implements a three-tier read path so that queries are fast regardless of how old the data is.

## Responsibilities

- Exposes a Prometheus-compatible `/api/v1` query interface
- Reconstructs time series by synthesizing points from polynomial model coefficients (via WASM)
- Implements a 3-tier read path: memory LRU cache → local disk → S3
- Scans canonical blocks in parallel using configurable worker goroutines
- Manages an LRU block cache to keep hot data in memory

## Port

`8081` (default, configurable via `server.query_port`)

## Three-Tier Read Path

```
Query Request
     │
     ▼
┌─────────────┐     hit      Response
│  LRU Cache  │ ───────────▶ (fastest)
└─────────────┘
     │ miss
     ▼
┌─────────────┐     hit      Response + cache fill
│  Local Disk │ ───────────▶
└─────────────┘
     │ miss (block evicted)
     ▼
┌─────────────┐     hit      Response + cache fill
│  S3 / R2    │ ───────────▶
└─────────────┘
```

## Configuration Reference

| Setting | Default | Description |
|---|---|---|
| `timeout_s` | 30 | Per-query execution deadline |
| `synthesize_points` | 100 | Points synthesized per series per query |
| `max_cache_size` | "500MB" | LRU block cache memory limit |
| `eviction_headroom_pct` | 0.20 | Proactive eviction at 80% capacity |
| `symbol_refresh_interval_s` | 30 | Metric name table refresh interval |
| `file_index_interval_s` | 10 | Block catalog rescan interval |
| `lts_scan_workers` | 8 | Parallel goroutines for block scanning |
| `wasm_module_path` | "model_core.wasm" | Path to polynomial evaluation module |

```yaml
query:
  timeout_s: 30
  synthesize_points: 100
  max_cache_size: "500MB"
  eviction_headroom_pct: 0.20
  symbol_refresh_interval_s: 30
  file_index_interval_s: 10
  lts_scan_workers: 8
  wasm_module_path: "model_core.wasm"
```

## Performance Tuning

For high-query-volume deployments:
- Raise `max_cache_size` to `4GB`–`16GB` to keep more blocks in memory
- Raise `lts_scan_workers` to `16`–`32` on machines with many cores
- Raise `synthesize_points` to `200`–`500` for smoother chart resolution

## Prometheus Compatibility

The Query Gateway exposes the standard Prometheus HTTP API, meaning it works as a drop-in replacement datasource in Grafana, or any tool that speaks PromQL.
