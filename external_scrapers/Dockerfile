# syntax=docker/dockerfile:1

############################
# Stage 1: Build
############################
FROM golang:1.23-bullseye AS builder

WORKDIR /src

COPY scraper_external.go ./

# Static Linux binary — no CGO, smallest possible output.
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 \
    go build -trimpath -ldflags="-s -w" -o /out/scraper scraper_external.go


############################
# Stage 2: Runtime
############################
# Distroless has no shell, no package manager, no attack surface.
FROM gcr.io/distroless/static-debian12:nonroot

WORKDIR /app
COPY --from=builder /out/scraper /app/scraper

# ── Runtime configuration ─────────────────────────────────────────────────
# Override these at runtime with -e / kubectl env / docker-compose environment.

# Required: URL of the tsdb.ai ingestor /ingest_samples endpoint.
ENV INGEST_ENDPOINT=""

# Required: Comma-separated list of Prometheus /metrics URLs to scrape.
ENV SCRAPE_URLS=""

# Seconds between scrape rounds (minimum enforced: 15s).
ENV SCRAPE_INTERVAL_SECONDS="30"

# HTTP timeout per individual scrape request (must be < interval).
ENV SCRAPE_TIMEOUT_SECONDS="15"

# Value injected as job= label on every scraped sample.
# Lets you distinguish scraper deployments in multi-cluster setups.
ENV JOB_LABEL="external"

# Port for /health (JSON) and /metrics (Prometheus text) self-monitoring.
# Set to 0 to disable. Enable to support Kubernetes liveness/readiness probes.
ENV HEALTH_PORT="9090"

EXPOSE 9090

ENTRYPOINT ["/app/scraper"]
