# Scraper Agent

The Scraper Agent is an internal self-monitoring component. It polls TSDB.ai's own metrics exporter endpoint and forwards those operational metrics back into the Ingestor — closing the feedback loop so TSDB.ai monitors itself.

## Responsibilities

- Polls the Self Exporter (`/metrics`) at a configurable interval
- Forwards scraped samples to the Ingestor's `/ingest_samples` endpoint
- Buffers samples locally if the Ingestor is temporarily unreachable
- Flushes the buffer automatically when the Ingestor recovers

## Architecture

```
Self Exporter (:9102/metrics)
        │  scrape every 30s
        ▼
  Scraper Agent
        │  POST /ingest_samples
        ▼
    Ingestor (:8080)
        │
        ▼
  TSDB.ai stores and analyzes its own operational metrics
```

This means anomaly detection, forecasting, and pattern recognition all work on TSDB.ai's own WAL queue depth, compression latency, cache hit rate, and other internal metrics — without any external monitoring tool.

## Resiliency Buffer

If the Ingestor is temporarily down, the Scraper Agent buffers up to `max_buffer_bytes` of samples in memory. When the Ingestor recovers, the buffer is flushed in order. Samples are dropped only if the buffer is full.

## Configuration Reference

| Setting | Default | Description |
|---|---|---|
| `target_endpoint` | `http://localhost:9102/metrics` | Prometheus endpoint to scrape |
| `ingest_endpoint` | `http://localhost:8080/ingest_samples` | Ingestor push endpoint |
| `interval_s` | 30 | Scrape interval in seconds |
| `timeout_s` | 20 | Per-scrape HTTP timeout |
| `max_buffer_bytes` | 52428800 (50 MB) | Resiliency buffer before drops |
| `proxy_url` | "" | Optional HTTP/HTTPS/SOCKS5 proxy for scrape requests |

```yaml
scraper:
  target_endpoint: "http://localhost:9102/metrics"
  ingest_endpoint: "http://localhost:8080/ingest_samples"
  interval_s: 30
  timeout_s: 20
  max_buffer_bytes: 52428800
  proxy_url: ""
```

## External Scraper Setup

The admin panel's **Scrapers** page auto-generates scraper configs for connecting external Prometheus exporters to TSDB.ai. Supported formats:

- Linux shell script
- macOS shell script
- Docker Compose
- Kubernetes Deployment + ConfigMap

The Scraper Setup Wizard also validates target endpoints and detects common exporters (node_exporter, cAdvisor, JVM Micrometer, Redis, PostgreSQL, etc.).
