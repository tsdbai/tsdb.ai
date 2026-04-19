# tsdb-scraper

The TSDB.ai scraper agent — pulls samples from Prometheus-compatible HTTP
endpoints and ships them into the TSDB.ai ingestor.

> **Prefer the [`tsdb-ai` umbrella chart](../..)**. Install this subchart
> standalone only when the TSDB.ai server is already running (elsewhere in the
> cluster, in another cluster, or outside Kubernetes entirely).

## What this chart installs

| Kind         | Name           | Purpose                                                  |
| ------------ | -------------- | -------------------------------------------------------- |
| `Deployment` | `tsdb-scraper` | 1 replica of `tsdbai/tsdb-ai-scraper:<appVersion>`.      |

No `Service` is created — the scraper is a pure outbound client.

## Install

```bash
# Standalone, pointed at an ingestor outside the cluster:
helm install tsdb-scraper ./charts/tsdb-scraper -n tsdb-ai \
  --set ingestorUrl=https://tsdb.example.com/ingest_samples
```

## Values

| Key                            | Default                                                         | Notes                                                |
| ------------------------------ | --------------------------------------------------------------- | ---------------------------------------------------- |
| `replicaCount`                 | `1`                                                             |                                                      |
| `image.registry`               | `""` (inherits `global.image.registry`)                         |                                                      |
| `image.repository`             | `tsdbai/tsdb-ai-scraper`                                        |                                                      |
| `image.tag`                    | *empty* → `.Chart.AppVersion`                                   |                                                      |
| `image.pullPolicy`             | *empty* → `global.image.pullPolicy`                             |                                                      |
| `ingestorUrl`                  | `http://tsdb-server.tsdb-ai.svc.cluster.local:8080`             | Set via `TSDB_INGESTOR_URL`.                         |
| `persistence.existingClaim`    | `tsdb-pvc`                                                      | Same PVC the server mounts (for cache + state).      |
| `persistence.mountPath`        | `/app/tsdb.ai-data`                                             |                                                      |
| `env`                          | `[{TSDB_IN_DOCKER: "1"}]`                                       | `TSDB_INGESTOR_URL` is appended automatically.       |
| `extraEnv`                     | `[]`                                                            | Appended after `TSDB_INGESTOR_URL`.                  |
| `envFrom`                      | `[]`                                                            |                                                      |
| `resources`                    | req 64Mi/50m, lim 256Mi/200m                                    |                                                      |
| `terminationGracePeriodSeconds`| `30`                                                            |                                                      |
| `podAnnotations` / `podLabels` | `{}`                                                            |                                                      |
| `nodeSelector` / `tolerations` / `affinity` | `{}` / `[]` / `{}`                                 |                                                      |
| `securityContext` / `podSecurityContext` | `{}` / `{}`                                           |                                                      |

### Point at a remote ingestor

```bash
helm upgrade tsdb-scraper ./charts/tsdb-scraper -n tsdb-ai \
  --set ingestorUrl=https://tsdb.example.com/ingest_samples
```

### Provide scrape targets via ConfigMap

The scraper reads its scrape-target list from the data directory. The typical
pattern is to ship a ConfigMap into the PVC via an initContainer, or to mount
it directly:

```bash
kubectl -n tsdb-ai create configmap scrape-targets \
  --from-file=targets.yaml=./my-targets.yaml

helm upgrade tsdb-scraper ./charts/tsdb-scraper -n tsdb-ai \
  --set-json 'envFrom=[{"configMapRef":{"name":"scrape-targets"}}]'
```

## Links

- Umbrella chart: [`tsdb-ai`](../..)
- Scraper docs: [docs/scraper-agent.md](../../../../../docs/scraper-agent.md)
- Mock data guide: [docs/mock-data.md](../../../../../docs/mock-data.md)
