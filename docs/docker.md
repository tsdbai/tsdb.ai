# Docker — Build from Scratch

This guide walks through building a TSDB.ai Docker image from source and running it as a single container. The image bundles every service (Ingestor, Query Gateway, WAL Shipper, Deduper, Vector Store, Self Exporter, Scraper Agent, MCP Server) under Supervisor, so one `docker run` starts everything.

---

## Prerequisites

| Requirement | Version |
|---|---|
| Docker | 20.10 or newer |
| Go source tree | `v0.9/` directory |
| `model_core.wasm` | Present in `v0.9/` |
| `tsdb.yaml` | Present in `v0.9/` |

> **Note:** You do not need Go installed locally. The multi-stage Dockerfile compiles everything inside a `golang:1.23` builder container.

---

## Project layout (relevant files)

```
v0.9/
├── install/docker/
│   ├── Dockerfile          ← multi-stage build definition
│   └── supervisord.conf    ← starts all services at container boot
├── tsdb.yaml               ← default config (copied into image)
├── model_core.wasm         ← compression engine (required)
└── *.go                    ← all Go source files
```

---

## Step 1 — Build the image

Run from the `v0.9/` directory (where the Go source lives):

```bash
cd v0.9/

docker build \
  -f install/docker/Dockerfile \
  -t tsdb-ai:latest \
  .
```

The build has two stages:

**Stage 1 — Go builder** (`golang:1.23-bullseye`):
Compiles 7 static Go binaries:

```
tsdb_ingestor     ← main write path + AI engines
query_gateway     ← PromQL-compatible read path
wal_shipper       ← block staging + S3 upload
deduper_service   ← canonical block deduplication
tsdb_self_exporter← /metrics endpoint for self-monitoring
scraper_agent     ← Prometheus target scraper
vector_service    ← behavioral vector DB
```

**Stage 2 — Runtime** (`debian:bookworm-slim`):
Installs Supervisor and the Python MCP server (`uv` + `mcp[cli]`), then copies the compiled binaries in.

Build time is approximately 3–5 minutes on first run (Go module downloads + Python deps). Subsequent builds are fast thanks to Docker layer caching.

---

## Step 2 — Run with persistent storage

Data is written to `tsdb.ai-data/` inside the container. Mount a host volume so it survives container restarts:

```bash
docker run -d \
  --name tsdb-ai \
  -p 8080:8080 \   # Ingestor (write path)
  -p 8081:8081 \   # Query Gateway (read path)
  -p 8000:8000 \   # MCP Server (AI agent)
  -p 9102:9102 \   # Self Exporter (Prometheus metrics)
  -v $(pwd)/tsdb-data:/app/tsdb.ai-data \
  tsdb-ai:latest
```

Ports `8084` (Deduper) and `8085` (Vector Store) are internal-only — do not expose them unless you need direct access for debugging.

---

## Step 3 — Override the config

The image ships with a default `tsdb.yaml`. To use your own config without rebuilding, mount it at `/app/tsdb.yaml`:

```bash
docker run -d \
  --name tsdb-ai \
  -p 8080:8080 \
  -p 8081:8081 \
  -p 8000:8000 \
  -v $(pwd)/tsdb.ai-data:/app/tsdb.ai-data \
  -v $(pwd)/tsdb.yaml:/app/tsdb.yaml \
  tsdb-ai:latest
```

**Minimal production `tsdb.yaml`:**

```yaml
server:
  ingest_port: 8080
  query_port:  8081
  deduper_endpoint: "http://localhost:8084/ingest_block"
  vector_db_endpoint: "http://localhost:8085/ingest"

data:
  root: "/app/tsdb.ai-data"

ingestion:
  rmse_tolerance: 10.0
  num_shards: 256
  samples_per_segment: 100

s3:
  enabled: false
```

---

## Step 4 — Verify all services are running

```bash
# Check Supervisor process list
docker exec tsdb-ai supervisorctl status

# Expected output:
# deduper        RUNNING   pid 12, uptime 0:00:08
# ingestor       RUNNING   pid 13, uptime 0:00:08
# mcp_server     RUNNING   pid 14, uptime 0:00:07
# query_gateway  RUNNING   pid 15, uptime 0:00:08
# scraper_agent  RUNNING   pid 16, uptime 0:00:08
# self_exporter  RUNNING   pid 17, uptime 0:00:08
# vector_db      RUNNING   pid 18, uptime 0:00:08
# wal_shipper    RUNNING   pid 19, uptime 0:00:08

# Quick health check
curl http://localhost:8080/internal/metrics
curl http://localhost:8081/api/v1/query?query=up
```

---

## Step 5 — View logs

```bash
# All services (Supervisor aggregates to stdout)
docker logs -f tsdb-ai

# Individual service
docker exec tsdb-ai supervisorctl tail -f ingestor
docker exec tsdb-ai supervisorctl tail -f query_gateway
```

---

## Docker Compose (optional)

For local development with a mock data source, use this `compose.yml`:

```yaml
services:
  tsdb:
    build:
      context: ./v0.9
      dockerfile: install/docker/Dockerfile
    ports:
      - "8080:8080"
      - "8081:8081"
      - "8000:8000"
      - "9102:9102"
    volumes:
      - tsdb-data:/app/tsdb.ai-data
      - ./v0.9/tsdb.yaml:/app/tsdb.yaml
    restart: unless-stopped

  mock:
    image: prom/node-exporter:latest
    ports:
      - "9101:9100"
    restart: unless-stopped

  scraper:
    image: python:3.11-slim
    command: >
      python3 -c "
      import time, re, urllib.request, json
      while True:
          r = urllib.request.urlopen('http://mock:9100/metrics')
          lines = r.read().decode()
          samples = []
          for m in re.finditer(r'^([a-zA-Z_:]\S+)\s+([0-9eE+\-.]+)', lines, re.M):
              samples.append({'metric_name': m.group(1), 'value': float(m.group(2)),
                              'timestamp': int(time.time()), 'labels': {}})
          urllib.request.urlopen(urllib.request.Request(
              'http://tsdb:8080/ingest_samples',
              data=json.dumps({'samples': samples}).encode(),
              headers={'Content-Type': 'application/json'}, method='POST'))
          time.sleep(15)
      "
    depends_on: [tsdb, mock]
    restart: unless-stopped

volumes:
  tsdb-data:
```

Run with:

```bash
docker compose up --build
```

---

## Pushing to a registry

```bash
# Tag for Docker Hub
docker tag tsdb-ai:latest yourorg/tsdb-ai:v0.9

# Tag for Google Artifact Registry (GCR)
docker tag tsdb-ai:latest us-central1-docker.pkg.dev/YOUR_PROJECT/tsdb-ai/tsdb-ai:v0.9

# Push
docker push yourorg/tsdb-ai:v0.9
# or
docker push us-central1-docker.pkg.dev/YOUR_PROJECT/tsdb-ai/tsdb-ai:v0.9
```

The pushed image is what the [Kubernetes deployment](./kubernetes.md) references.

---

## Resource recommendations

| Environment | CPU | Memory | Storage |
|---|---|---|---|
| Development / laptop | 1 vCPU | 512 MB | 1 GB |
| Small production | 2 vCPU | 2 GB | 50 GB |
| Medium production | 4 vCPU | 8 GB | 500 GB |
| Large production | 8+ vCPU | 32 GB | 2+ TB |

TSDB.ai is memory-efficient by design. The head cache (most recent model per series) is the primary RAM consumer — roughly 1–2 KB per active series.

---

## Troubleshooting

**Build fails on `go build`**

Ensure all `.go` files are present in `v0.9/`. The build expects all source files in a flat directory — no subdirectory-per-service layout.

**Container starts but `/internal/metrics` returns 502**

The Ingestor takes 1–2 seconds to initialize. Retry after a moment. If it persists, check `docker logs tsdb-ai` for a config parsing error.

**`model_core.wasm` not found**

The Dockerfile copies `model_core.wasm` from the build context (`v0.9/`). Ensure the file exists at `v0.9/model_core.wasm` before running `docker build`.

**MCP server keeps restarting**

The MCP server requires Python `uv` and the `mcp[cli]` package. If the `uv init` step failed during build, rebuild without the cache: `docker build --no-cache ...`
