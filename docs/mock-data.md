# Mock Data Source & Scraper Agent

This guide covers the two components that let you run TSDB.ai with realistic data immediately — no real infrastructure required. It also explains how to use the scraper agent to pull from any real Prometheus-format endpoint.

---

## Overview

| Component | What it does |
|---|---|
| **Mock Data Source** | Go binary that serves synthetic Prometheus metrics on `:9101` |
| **Mock Scraper** | Python script that scrapes `:9101` and pushes to the TSDB.ai ingestor |
| **Scraper Agent** | Go binary that scrapes any Prometheus endpoint with full config support |

The typical development workflow uses all three in separate terminals:

```
Terminal 1: ./install/local/start-server.sh    # TSDB.ai server
Terminal 2: ./install/local/start-mock.sh      # Mock data source
Terminal 3: ./install/local/start-mock-scraper.sh  # Scraper loop
```

After ~30 seconds you should see active series appear on the dashboard. Within a few minutes, the first compressed chunks will be written and the AI features will have data to work with.

---

## Mock Data Source

### Starting it

```bash
./install/local/start-mock.sh
```

This runs `go run mock_data_source.go config.go` from the `v0.9/` directory. The mock source serves a Prometheus-format `/metrics` endpoint at:

```
http://localhost:9101/metrics
```

### Configuring the port

The mock source port is read from config. To change it from the default `9101`, add to `tsdb.yaml`:

```yaml
server:
  mock_source_port: 9101   # default; change if 9101 is already in use
```

### What metrics it generates

The mock source generates four metric families with a total of **96 series** designed to exercise TSDB.ai's compression, anomaly detection, and forecasting features.

---

#### `mock_cpu_utilization_percent`

**Type:** Gauge
**Series:** 1
**Labels:** `instance="web-01"`, `core="cpu0"`

Simulates CPU utilization as a Gaussian random walk centered around 50%, with ±15% standard deviation per sample. Values are clipped to `[0, 100]`. This produces a smooth-ish signal that compresses well and occasionally triggers RMSE anomalies when the random walk drifts far from its baseline.

```
mock_cpu_utilization_percent{instance="web-01",core="cpu0"} 52.3
```

---

#### `mock_memory_free_bytes`

**Type:** Gauge
**Series:** 1
**Labels:** `instance="web-01"`, `zone="us-west-1"`

Simulates free memory as a slow downward trend with noise, representing gradual memory pressure. Values stay within a realistic range (hundreds of MB) and trend downward over time, which exercises the forecasting engine's trend detection.

```
mock_memory_free_bytes{instance="web-01",zone="us-west-1"} 892436480
```

---

#### `mock_queue_depth_items`

**Type:** Gauge
**Series:** 1
**Labels:** `shard="main"`, `type="processor"`

A sinusoidal signal representing queue depth oscillating over a fixed period. This deterministic pattern is ideal for testing pattern recognition — TSDB.ai's behavioral fingerprint engine will quickly register it as a recurring pattern.

```
mock_queue_depth_items{shard="main",type="processor"} 142
```

---

#### `mock_http_requests_total`

**Type:** Counter
**Series:** 93
**Labels:** `job="api"`, `method="GET"`, `status={"200","400","500"}`, `path=<30 values>`

A high-cardinality counter family with 30 stable endpoint paths (`/api/v1/users`, `/api/v1/products`, etc.) × 3 HTTP status codes. Counter values increment on each scrape.

This metric family is intentionally large to test TSDB.ai's ability to handle many series per family, compress counters efficiently, and exercise label-set indexing.

```
mock_http_requests_total{job="api",method="GET",status="200",path="/api/v1/users"} 4821
mock_http_requests_total{job="api",method="GET",status="400",path="/api/v1/users"} 12
mock_http_requests_total{job="api",method="GET",status="500",path="/api/v1/users"} 3
...
```

**Total series count:** 30 paths × 3 statuses + 3 gauge series = **93 active series**

---

## Mock Scraper (Python)

The mock scraper is a lightweight Python script using only the standard library — no dependencies to install.

### Starting it

```bash
./install/local/start-mock-scraper.sh
```

### Flags

| Flag | Default | Description |
|---|---|---|
| `--target` | `http://localhost:9101/metrics` | Prometheus metrics endpoint to scrape |
| `--ingest` | `http://localhost:8080/ingest_samples` | TSDB.ai ingestor endpoint to push to |
| `--interval` | `15` | Scrape interval in seconds |

### Customizing

```bash
# Scrape a different port, push every 10 seconds
python3 scraper.py \
  --target http://localhost:9200/metrics \
  --ingest http://localhost:8080/ingest_samples \
  --interval 10
```

### What it does

On each interval, the scraper:

1. Fetches the target `/metrics` endpoint (plain text Prometheus format)
2. Parses each non-comment, non-empty line into `(metric_name, labels, value, timestamp)` tuples
3. POSTs the parsed samples to the TSDB.ai `/ingest_samples` endpoint in Prometheus remote write format
4. Logs the number of samples pushed and any HTTP errors to stdout

If either the scrape or the ingest call fails, the error is logged and the loop continues — a single failed scrape does not stop the process.

---

## Scraper Agent (Go)

For production use, TSDB.ai includes a Go-based scraper agent (`scraper_agent.go`) that runs as part of the main server process. It is more robust than the Python script and supports HTTP proxy configuration.

### Configuration

All scraper agent settings live in `tsdb.yaml`:

```yaml
scraper:
  target_endpoint: "http://localhost:9101/metrics"   # endpoint to scrape
  ingest_endpoint: "http://localhost:8080/ingest_samples"  # where to push
  interval_s: 15       # scrape interval in seconds
  timeout_s: 10        # per-request timeout
  proxy_url: ""        # optional HTTP proxy, e.g. "http://proxy.corp:3128"
```

### Key behavior

- **Max body size:** The scraper reads up to 10 MB of response body per scrape. Endpoints returning more than this are truncated — split large exporters into smaller targets if needed.
- **Prometheus text format:** The agent parses standard Prometheus exposition format. Both `# TYPE` and `# HELP` comment lines are ignored. Metric lines without an explicit timestamp receive the scrape time as their timestamp.
- **Proxy support:** If `proxy_url` is set, both the scrape client and ingest client route through it. This enables scraping endpoints in network segments not directly accessible from the TSDB.ai host.
- **Shared HTTP clients:** The scraper uses persistent `scrapeClient` and `ingestClient` instances with connection pooling, so high-frequency scraping does not open a new TCP connection on every interval.

### Scraping real infrastructure

The scraper agent works with any Prometheus-format exporter. Common targets:

| Exporter | Typical endpoint |
|---|---|
| Node Exporter | `http://<host>:9100/metrics` |
| cAdvisor | `http://<host>:8080/metrics` |
| Kubernetes API server | `https://<k8s-api>:6443/metrics` |
| Custom application | `http://<app>:<port>/metrics` |
| Prometheus itself | `http://<prometheus>:9090/metrics` |

To ingest from multiple endpoints simultaneously, run additional scraper agent instances or use the scraper setup wizard in the admin panel (Settings → Scraper Setup).

---

## Timing and warm-up

After starting the mock pipeline, expect the following timeline:

| Time after start | What happens |
|---|---|
| ~0–15 s | First scrape lands; series appear in Active Series count |
| ~1–2 min | Head cache has several samples per series; basic queries return data |
| ~25 min | Series accumulate enough samples (≥100 per segment by default) for the compression engine to fit polynomial models and write the first chunks |
| ~30 min | Compression statistics, pattern registry, and forecasting begin populating |

The `samples_per_segment` threshold (default: 100 samples) controls how many raw samples must accumulate before a polynomial fit is attempted. At a 15-second scrape interval, this takes roughly 25 minutes per segment. Lowering this value in `tsdb.yaml` speeds up the warm-up at the cost of less accurate models:

```yaml
ingestion:
  samples_per_segment: 60   # fit after ~15 minutes at 15s interval
```

---

## Using the admin panel setup wizard

For non-mock scrapers, the admin panel includes a setup wizard that generates ready-to-paste configs for Linux, macOS, Docker, and Kubernetes:

1. Open the admin panel at `http://localhost:3000`
2. Navigate to **Settings → Scraper Setup**
3. Select your platform and exporter type
4. Copy the generated config or start command

The wizard generates the correct `tsdb.yaml` scraper block and an optional systemd unit file for Linux deployments.

---

## Troubleshooting

**Active series count stays at 0**

The scraper is not reaching the ingestor. Check:
- Mock source is running: `curl http://localhost:9101/metrics`
- Ingestor is running: `curl http://localhost:8080/health`
- Scraper logs for HTTP errors

**Series appear but compression ratio stays at 0**

The compression engine needs ~100 samples per series before it fits a model. At 15s intervals this takes ~25 minutes. The dashboard will show `—` until the first canonical block is written.

**`mock_http_requests_total` series count looks wrong**

Verify the mock source is running correctly with `curl http://localhost:9101/metrics | grep mock_http | wc -l`. You should see 93 lines (one per label combination). If the count is lower, the server may have been restarted mid-scrape; the counters reset on restart.

**Python scraper exits immediately**

Check that Python 3 is available: `python3 --version`. The scraper uses only the standard library (`urllib`, `argparse`, `time`) so no pip install is needed.
