# Ingestor

The Ingestor is the primary write path for TSDB.ai. It receives raw Prometheus-format metric samples, buffers them per series, and runs polynomial model compression before writing to the Write-Ahead Log (WAL).

## Responsibilities

- Accepts `POST /ingest_samples` in Prometheus exposition format
- Buffers raw samples per series in 256 independent sharded memory structures
- Triggers adaptive polynomial compression when the sample buffer reaches the configured threshold
- Writes compressed model chunks to the binary WAL
- Forwards enriched model vectors to the Vector Store
- Runs anomaly detection and regime-change detection on every new model fit
- Maintains the in-memory head cache (most recent model per series)
- Exposes internal endpoints for the UI: anomalies, regimes, forecasts, patterns, causal graph

## Port

`8080` (default, configurable via `server.ingest_port`)

## Compression Engine

The Ingestor uses a polynomial model fitting approach (via `model_core.wasm`) to compress raw float64 samples. Instead of storing every sample point, it fits a mathematical model to each segment and stores only the model coefficients.

| Setting | Default | Description |
|---|---|---|
| `samples_per_segment` | 100 | Samples buffered before compression triggers |
| `max_samples_per_segment` | 1000 | Hard ceiling — compression fires regardless |
| `rmse_tolerance` | 10.0 | Fit error tolerance — lower = more faithful, less compression |
| `num_shards` | 256 | Independent lock shards (must be power of 2) |
| `wal_batch_size` | 500 | Chunks per WAL batch flush |
| `wal_batch_interval_ms` | 200 | Max ms between WAL flushes |

## Anomaly Detection

Every new model fit is compared against a per-series seasonal RMSE baseline (168 slots = 7 days × 24 hours). An anomaly is declared when:

```
current_rmse > historical_mean_rmse × rmse_multiplier
```

| Setting | Default | Description |
|---|---|---|
| `anomaly.rmse_multiplier` | 3.0 | Sensitivity multiplier |
| `anomaly.min_chunks_for_history` | 5 | Warm-up period before detection activates |
| `anomaly.regime_history_len` | 10 | Ring buffer depth for regime-change detection |
| `anomaly.seasonal_slots` | 168 | Time slots for seasonal baseline |

## Key Endpoints

| Method | Path | Description |
|---|---|---|
| `POST` | `/ingest_samples` | Primary metric ingest (Prometheus format) |
| `GET` | `/api/v1/anomalies` | Recent anomaly events |
| `GET` | `/api/v1/regimes` | Regime change events |
| `GET` | `/api/v1/forecast` | Forecast for a given metric |
| `GET` | `/api/v1/patterns` | Pattern registry contents |
| `GET` | `/internal/license` | License status |

## Sharding

The Ingestor splits its in-memory state across 256 independent shards. Each series maps to a shard via `seriesID % 256`. Goroutines working on different series hit different shards and therefore different locks — eliminating write contention at high metric cardinality.

## Configuration Reference

```yaml
ingestion:
  samples_per_segment: 100
  max_samples_per_segment: 1000
  rmse_tolerance: 10.0
  num_shards: 256
  wal_batch_size: 500
  wal_batch_interval_ms: 200
  index_sync_interval_s: 5
```

## Deployment Notes

- The Ingestor and Query Gateway are the only two processes that must be externally reachable
- For high-cardinality deployments (thousands of series), raise `num_shards` to 512 or 1024
- Lower `rmse_tolerance` (e.g. 5.0) for precise reconstruction; raise (e.g. 20.0) for maximum storage savings
