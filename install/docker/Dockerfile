# --- Stage 1: Builder (Go) ---
FROM golang:1.23-bullseye AS builder

WORKDIR /app

# Copy all source files
COPY . .

# Build all microservices as static binaries.
# config.go and banner.go (both package main) must be included in every binary
# so that LoadConfig(), Cfg, PrintBanner(), and Logf() are available at link time.
RUN go build -o deduper_service \
        deduper_service.go s3_client.go s3_manifest.go config.go banner.go
RUN go build -o tsdb_ingestor \
        main.go model_compressor.go local_cleaner.go \
        pattern_registry.go causal_engine.go relationship_graph.go \
        vector_store.go forecasting.go s3_client.go s3_manifest.go config.go banner.go
RUN go build -o query_gateway \
        query_gateway.go s3_client.go s3_manifest.go config.go banner.go
RUN go build -o wal_shipper \
        wal_shipper.go model_compressor.go local_cleaner.go config.go banner.go
RUN go build -o tsdb_self_exporter \
        tsdb_self_exporter.go config.go banner.go
RUN go build -o scraper_agent \
        scraper_agent.go config.go banner.go
# Compile Vector DB service (Query Service + Store Logic)
RUN go build -o vector_service \
        query_vector.go vector_store.go config.go banner.go

# --- Stage 2: Runtime ---
# Using bookworm-slim for Python 3.11 support (required by mcp)
FROM debian:bookworm-slim

# Install Supervisor and Python
RUN apt-get update && apt-get install -y \
    supervisor \
    python3 \
    python3-pip \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Install uv
RUN curl -LsSf https://astral.sh/uv/install.sh | sh
# FIX: Updated PATH to match uv installer output (/root/.local/bin)
ENV PATH="/root/.local/bin:${PATH}"

# NETWORK FIX: Prefer IPv4 over IPv6
# This modifies getaddrinfo behavior to prioritize IPv4 addresses
# Effectively disabling IPv6 usage for DNS resolution
RUN echo "precedence ::ffff:0:0/96  100" >> /etc/gai.conf

WORKDIR /app

# Initialize uv project and add dependencies
RUN uv init mcp-server-tsdb
WORKDIR /app/mcp-server-tsdb
RUN uv add "mcp[cli]" requests pandas scikit-learn numpy

# Copy compiled binaries from builder to app root
COPY --from=builder /app/deduper_service /app/
COPY --from=builder /app/tsdb_ingestor /app/
COPY --from=builder /app/query_gateway /app/
COPY --from=builder /app/wal_shipper /app/
COPY --from=builder /app/tsdb_self_exporter /app/
COPY --from=builder /app/scraper_agent /app/
COPY --from=builder /app/vector_service /app/

# Copy Python MCP Server script into the uv project directory
COPY tsdb_mcp_server.py .

# Copy Configuration & Assets to app root
WORKDIR /app
COPY supervisord.conf /etc/supervisor/conf.d/supervisord.conf
COPY model_core.wasm .
# Global config file — services read this at startup; override with a volume mount
COPY tsdb.yaml .

# Create the unified tsdb.ai-data directory tree (mirrors tsdb.yaml data.root default)
RUN mkdir -p tsdb.ai-data/wal \
             tsdb.ai-data/blocks/staging \
             tsdb.ai-data/blocks/canonical \
             tsdb.ai-data/index \
             tsdb.ai-data/events/anomalies \
             tsdb.ai-data/events/regimes \
             tsdb.ai-data/registry

# Signal to services that they're running inside Docker so startup checks
# that require ./setup.sh on bare Linux are skipped.
ENV TSDB_IN_DOCKER=1

# Expose ports
EXPOSE 8080 8081 8084 8085 9102 8000

# Start Supervisor
CMD ["/usr/bin/supervisord"]
