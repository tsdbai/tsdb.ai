# tsdb-ui

The TSDB.ai admin UI — a React single-page application served by nginx.
Provides the AI Chat, AI Dashboard, live charts, anomaly and forecast views,
pattern registry editor, causal graph, and scraper setup wizard.

> **Prefer the [`tsdb-ai` umbrella chart](../..)**. Install this standalone
> only when the TSDB.ai server is already running elsewhere.

## What this chart installs

| Kind         | Name      | Purpose                                          |
| ------------ | --------- | ------------------------------------------------ |
| `Deployment` | `tsdb-ui` | 1 replica of `tsdbai/tsdb-ai-ui:<appVersion>`.   |
| `Service`    | `tsdb-ui` | `ClusterIP` on port `3000`.                      |

## Install

```bash
helm install tsdb-ui ./charts/tsdb-ui -n tsdb-ai
kubectl -n tsdb-ai port-forward svc/tsdb-ui 3000:3000
open http://localhost:3000
```

The UI talks to the server over the in-cluster DNS name `tsdb-server`. When
installed via the umbrella chart, the Ingress routes `/` to the UI and the
various `/api`, `/qgw`, `/sse` prefixes to the server automatically.

## Values

| Key                           | Default                                 | Notes                                                  |
| ----------------------------- | --------------------------------------- | ------------------------------------------------------ |
| `replicaCount`                | `1`                                     | Stateless — safe to run more than 1 behind a Service.  |
| `image.registry`              | `""` (inherits `global.image.registry`) |                                                        |
| `image.repository`            | `tsdbai/tsdb-ai-ui`                     |                                                        |
| `image.tag`                   | *empty* → `.Chart.AppVersion`           |                                                        |
| `image.pullPolicy`            | *empty* → `global.image.pullPolicy`     |                                                        |
| `service.type`                | `ClusterIP`                             | Use `NodePort` or `LoadBalancer` for direct exposure.  |
| `service.port`                | `3000`                                  |                                                        |
| `service.targetPort`          | `3000`                                  |                                                        |
| `service.portName`            | `http`                                  |                                                        |
| `env`                         | `[]`                                    |                                                        |
| `extraEnv`                    | `[]`                                    |                                                        |
| `envFrom`                     | `[]`                                    |                                                        |
| `resources`                   | req 32Mi/25m, lim 128Mi/100m            | UI is very light.                                      |
| `livenessProbe` / `readinessProbe` | `GET /` on `http`                  |                                                        |
| `podAnnotations` / `podLabels`| `{}`                                    |                                                        |
| `nodeSelector` / `tolerations` / `affinity` | `{}` / `[]` / `{}`         |                                                        |
| `securityContext` / `podSecurityContext` | `{}` / `{}`                    |                                                        |

### Expose directly (no Ingress)

```bash
helm upgrade tsdb-ui ./charts/tsdb-ui -n tsdb-ai \
  --set service.type=LoadBalancer
```

## Links

- Umbrella chart: [`tsdb-ai`](../..)
- Admin panel docs: [docs/admin-panel.md](../../../../../docs/admin-panel.md)
