# Networking & Firewall

This document covers every port used by TSDB.ai, which ports need to be externally reachable, which are internal-only, and the recommended firewall rules for each deployment type.

---

## Port Reference

| Port | Service | Protocol | Direction | Description |
|---|---|---|---|---|
| `8080` | Ingestor | HTTP | Inbound | Primary write path. Receives metric samples from scrapers and external agents. Also serves AI endpoints (forecast, anomalies, patterns, causal graph). |
| `8081` | Query Gateway | HTTP | Inbound | PromQL-compatible read API. Used by Grafana, the admin panel, and any external query client. |
| `8084` | Deduplication Service | HTTP | Internal only | Receives staged blocks from the WAL Shipper. Should never be exposed externally. |
| `8085` | Vector Store | HTTP | Internal only | Receives behavioral vectors from the Ingestor. Should never be exposed externally. |
| `9101` | Mock Data Source | HTTP | Local only | Development/demo mock metric generator. Never expose in production. |
| `9102` | Self Exporter | HTTP | Internal / restricted | Prometheus `/metrics` endpoint for TSDB.ai self-monitoring. Expose only to your internal Prometheus scraper or monitoring system. Also used as the Kubernetes health check target (`/health`). |
| `8000` | MCP Server | HTTP/SSE | Restricted | Claude / AI agent integration via Model Context Protocol. Expose only to trusted AI clients. |
| `3000` | Admin Panel UI | HTTP | Internal / VPN | React dev server (local development). In production, serve the built static files behind a reverse proxy. |

---

## Traffic Classification

### Must be externally reachable

These ports need to accept traffic from your metric sources and query clients:

| Port | Who connects |
|---|---|
| `8080` | Prometheus scrapers, external agents, CI/CD deploy webhooks (future), any system pushing metrics |
| `8081` | Grafana, dashboards, PromQL clients, the admin panel UI |

### Internal traffic only (same host / same pod)

These ports are used for inter-service communication within a single TSDB.ai instance and must **not** be exposed to the public internet:

| Port | From | To |
|---|---|---|
| `8084` | WAL Shipper | Deduplication Service |
| `8085` | Ingestor | Vector Store |
| `9102` | Scraper Agent | Self Exporter (scrapes this) |

### Restricted access

These ports should only be reachable by specific, trusted systems:

| Port | Allow from |
|---|---|
| `9102` | Internal monitoring / Prometheus only |
| `8000` | Your MCP client (Claude Desktop, AI agent infrastructure) only |
| `3000` | Developer machines / VPN only |

---

## Firewall Rules by Deployment

### Local Development

No firewall changes needed. All services bind to `localhost` and communicate over the loopback interface. The admin panel dev server proxies API calls to `:8080` automatically.

### Linux Server (bare metal / VM)

Using `ufw`:

```bash
# Allow metric ingest from your scrapers / agents
ufw allow from <scraper_subnet> to any port 8080 proto tcp

# Allow PromQL queries from Grafana / dashboards
ufw allow from <grafana_ip> to any port 8081 proto tcp

# Allow admin panel access from your team / VPN
ufw allow from <vpn_subnet> to any port 3000 proto tcp

# Self-exporter — only allow your internal monitoring scraper
ufw allow from <monitoring_ip> to any port 9102 proto tcp

# MCP server — only allow your AI agent host
ufw allow from <ai_agent_ip> to any port 8000 proto tcp

# Block all internal service ports from external access
ufw deny 8084
ufw deny 8085
ufw deny 9101
```

Using `iptables`:

```bash
# Allow ingestor from scraper subnet
iptables -A INPUT -p tcp --dport 8080 -s <scraper_subnet> -j ACCEPT

# Allow query gateway from Grafana
iptables -A INPUT -p tcp --dport 8081 -s <grafana_ip> -j ACCEPT

# Block internal ports
iptables -A INPUT -p tcp --dport 8084 -j DROP
iptables -A INPUT -p tcp --dport 8085 -j DROP
iptables -A INPUT -p tcp --dport 9101 -j DROP
```

### Docker

Docker exposes only the ports listed in the `-p` flags. Only map ports that need to be reachable:

```bash
# Minimal production — ingest + query only
docker run -d \
  -p 8080:8080 \
  -p 8081:8081 \
  -v tsdb-data:/app/tsdb.ai-data \
  tsdb-ai

# With admin panel and MCP server
docker run -d \
  -p 8080:8080 \
  -p 8081:8081 \
  -p 3000:3000 \
  -p 8000:8000 \
  -v tsdb-data:/app/tsdb.ai-data \
  tsdb-ai
```

Do **not** publish `8084`, `8085`, `9101`, or `9102` unless you have a specific need — these are internal services.

### Kubernetes

The included `install/k8s/ingress.yaml` uses nginx ingress with path-based routing. All external traffic enters on port `443` (HTTPS) and is routed to the correct internal service by path prefix.

**Path routing table:**

| Path prefix | Backend port | Service |
|---|---|---|
| `/api`, `/internal`, `/ingest_samples` | `8080` | Ingestor |
| `/qgw` | `8081` | Query Gateway |
| `/vectors`, `/search` | `8084` | Vector Service |
| `/sse` | `8000` | MCP Server |
| `/` (catch-all) | `3000` | Admin UI |

All backend ports are `ClusterIP` — not directly reachable from outside the cluster. The ingress controller is the only public entry point. Only port `443` needs to be open inbound on your nodes.

---

## HA / Multi-Node

In a multi-node deployment, peer nodes communicate with each other over the Ingestor port (`:8080`). Peer addresses are configured in `tsdb.yaml`:

```yaml
server:
  peer_nodes:
    - "http://node2:8080"
    - "http://node3:8080"
```

Ensure the following is allowed between all peer nodes:

```
TCP 8080 — node-to-node (all peers, bidirectional)
```

This should be an internal network rule only — peer traffic should never traverse the public internet.

---

## TLS / HTTPS

TSDB.ai services do not terminate TLS natively. Terminate TLS at:

- **Nginx / Caddy reverse proxy** — recommended for bare metal / VM deployments
- **Kubernetes nginx ingress** — used in the included `install/k8s/ingress.yaml`
- **Cloud load balancer** — any managed LB with TLS termination (Cloudflare, etc.)

Example Nginx config for a single-server deployment:

```nginx
server {
    listen 443 ssl;
    server_name tsdb.example.com;

    ssl_certificate     /etc/ssl/tsdb.crt;
    ssl_certificate_key /etc/ssl/tsdb.key;

    # Query Gateway (PromQL reads)
    location /api/v1/ {
        proxy_pass http://localhost:8081;
    }

    # Ingestor (writes + AI endpoints)
    location / {
        proxy_pass http://localhost:8080;
    }
}
```

---

## Summary — What to Open

| Deployment | Open to internet | Internal only | Never expose |
|---|---|---|---|
| Local dev | None | All ports on localhost | — |
| Linux server | `8080`, `8081` | `9102`, `8000`, `3000` | `8084`, `8085`, `9101` |
| Docker | `8080`, `8081` (published) | Rest unpublished | `8084`, `8085`, `9101` |
| Kubernetes | `443` (via nginx ingress) | All ClusterIP ports | Direct pod access |
