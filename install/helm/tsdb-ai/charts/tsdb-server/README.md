# tsdb-server

The core server of TSDB.ai — a single Go binary that runs the ingestor, query
gateway, WAL shipper, deduplication service, vector store, self-monitoring
exporter, and MCP server in-process. This subchart installs that one binary
as a `Deployment` + `Service`.

> **Prefer the [`tsdb-ai` umbrella chart](../..)** unless you specifically need
> to install the server on its own. The umbrella wires the server together
> with the scraper agent, admin UI, shared PVC, and Ingress.

## What this chart installs

| Kind         | Name          | Purpose                                                                 |
| ------------ | ------------- | ----------------------------------------------------------------------- |
| `Deployment` | `tsdb-server` | 1 replica of `tsdbai/tsdb-ai-server:<appVersion>`, 6 container ports.   |
| `Service`    | `tsdb-server` | `ClusterIP`; same 6 ports surfaced cluster-internally.                  |

### Ports exposed

| Name             | Port   | Role                                                  |
| ---------------- | ------ | ----------------------------------------------------- |
| `ingestor`       | `8080` | Write path + AI endpoints (`/ingest_samples`, `/api`) |
| `query-gateway`  | `8081` | PromQL-compatible reads (`/qgw`)                      |
| `vector-svc`     | `8084` | Vector store + similarity search (`/vectors`)         |
| `deduper`        | `8085` | Block deduplication (internal)                        |
| `self-exporter`  | `9102` | `/metrics` + `/health`                                |
| `mcp-server`     | `8000` | MCP / SSE for Claude integration (`/sse`)             |

## Install

The chart depends on an existing `PersistentVolumeClaim` (default name
`tsdb-pvc`). The umbrella chart creates this for you; when installing this
subchart standalone, create the PVC yourself first:

```bash
kubectl create namespace tsdb-ai

kubectl -n tsdb-ai apply -f - <<'EOF'
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: tsdb-pvc
spec:
  accessModes: [ReadWriteOnce]
  resources:
    requests:
      storage: 10Gi
EOF

helm install tsdb-server ./charts/tsdb-server -n tsdb-ai
```

## Values

| Key                               | Default                                 | Notes                                                        |
| --------------------------------- | --------------------------------------- | ------------------------------------------------------------ |
| `replicaCount`                    | `1`                                     | TSDB.ai is single-writer — do not scale beyond 1.            |
| `image.registry`                  | `""` (inherits `global.image.registry`) |                                                              |
| `image.repository`                | `tsdbai/tsdb-ai-server`                 |                                                              |
| `image.tag`                       | *empty* → `.Chart.AppVersion`           | Override per install, CI, or env.                            |
| `image.pullPolicy`                | *empty* → `global.image.pullPolicy`     | Defaults to `Always`.                                        |
| `persistence.existingClaim`       | `tsdb-pvc`                              | Must already exist.                                          |
| `persistence.mountPath`           | `/app/tsdb.ai-data`                     | Where the binary expects its data directory.                 |
| `service.type`                    | `ClusterIP`                             | Do not expose ports 8084/8085 externally.                    |
| `service.ports`                   | see values.yaml                         | Edit the list to add/remove ports; names drive probes+ingress. |
| `env`                             | `[{TSDB_IN_DOCKER: "1"}]`               | Replaces the full env array — use `extraEnv` to append.      |
| `extraEnv`                        | `[]`                                    | Appended onto `env`.                                         |
| `envFrom`                         | `[]`                                    | e.g. `[{configMapRef: {name: tsdb-config}}]`                 |
| `resources`                       | req 256Mi/250m, lim 1Gi/1000m           |                                                              |
| `livenessProbe` / `readinessProbe`| `GET /health` on `self-exporter`        |                                                              |
| `terminationGracePeriodSeconds`   | `30`                                    |                                                              |
| `podAnnotations` / `podLabels`    | `{}`                                    |                                                              |
| `nodeSelector` / `tolerations` / `affinity` | `{}` / `[]` / `{}`            | Standard scheduling knobs.                                   |
| `securityContext`                 | `{}`                                    | Per-container.                                               |
| `podSecurityContext`              | `{}`                                    | Per-pod.                                                     |

### Common overrides

```bash
# Use a custom image tag
helm upgrade tsdb-server ./charts/tsdb-server -n tsdb-ai \
  --set image.tag=v0.9.1

# Mount tsdb.yaml from a ConfigMap
helm upgrade tsdb-server ./charts/tsdb-server -n tsdb-ai \
  --set envFrom[0].configMapRef.name=tsdb-config
```

## Scaling

TSDB.ai is a single-shard, single-writer database by design. Use a **larger
pod** (bigger `resources.limits`, bigger node) rather than more replicas.

## Links

- Umbrella chart: [`tsdb-ai`](../..)
- Ingestor: [docs/ingestor.md](../../../../../docs/ingestor.md)
- Query Gateway: [docs/query-gateway.md](../../../../../docs/query-gateway.md)
- MCP Server: [docs/mcp-server.md](../../../../../docs/mcp-server.md)
