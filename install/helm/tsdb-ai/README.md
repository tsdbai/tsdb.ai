# tsdb-ai

<p align="left">
  <a href="https://tsdb.ai"><img alt="Website" src="https://img.shields.io/badge/website-tsdb.ai-06b6d4"></a>
  <a href="https://github.com/tsdb-ai/tsdb.ai"><img alt="Source" src="https://img.shields.io/badge/source-GitHub-181717?logo=github&logoColor=white"></a>
  <a href="https://helm.sh"><img alt="Helm" src="https://img.shields.io/badge/Helm-v3.8%2B-0F1689?logo=helm&logoColor=white"></a>
  <a href="https://kubernetes.io"><img alt="Kubernetes" src="https://img.shields.io/badge/Kubernetes-1.23%2B-326CE5?logo=kubernetes&logoColor=white"></a>
</p>

Umbrella Helm chart that deploys the complete TSDB.ai stack — AI-native
time-series database — on any Kubernetes cluster.

| Subchart                         | Role                                                          |
| -------------------------------- | ------------------------------------------------------------- |
| [`tsdb-server`](./charts/tsdb-server)   | Core server: ingestor, query gateway, vector, deduper, MCP |
| [`tsdb-scraper`](./charts/tsdb-scraper) | Scraper agent that ships samples to the core server        |
| [`tsdb-ui`](./charts/tsdb-ui)           | React admin UI served by nginx                             |

The umbrella itself owns the three resources that must be shared across
subcharts: the optional `Namespace`, the `PersistentVolumeClaim` (`tsdb-pvc`),
and the `Ingress` routing rules.

```
┌──────────────────────── Kubernetes cluster ────────────────────────┐
│                                                                    │
│    ┌─── tsdb-ai namespace ──────────────────────────────────────┐  │
│    │                                                            │  │
│    │  ┌───────────┐      ┌─────────────┐      ┌─────────────┐  │  │
│    │  │  tsdb-ui  │◀─────│   Ingress   │─────▶│ tsdb-server │  │  │
│    │  │  :3000    │      │  (nginx)    │      │  :8080-9102│  │  │
│    │  └───────────┘      └─────────────┘      └──────┬──────┘  │  │
│    │                                                 │ shared  │  │
│    │                       ┌────────────┐            │  PVC    │  │
│    │                       │ tsdb-scraper│──────────┘         │  │
│    │                       └────────────┘                      │  │
│    └───────────────────────────────────────────────────────────┘  │
│                                                                    │
└────────────────────────────────────────────────────────────────────┘
```

## TL;DR

```bash
# Add the repo (OCI — preferred)
helm install tsdb-ai oci://ghcr.io/tsdb-ai/charts/tsdb-ai \
  --version 0.9.0 -n tsdb-ai --create-namespace

# …or from source
helm dependency update install/helm/tsdb-ai
helm install tsdb-ai install/helm/tsdb-ai -n tsdb-ai --create-namespace
```

See the full guide at [`docs/helm.md`](../../docs/helm.md).

## Prerequisites

| Requirement                  | Notes                                                          |
| ---------------------------- | -------------------------------------------------------------- |
| Kubernetes **1.23+**         | Any distribution (EKS, GKE, AKS, k3s, kind, minikube, …).      |
| Helm **3.8+**                | Older Helm works for source installs but cannot pull OCI.      |
| A default `StorageClass`     | Required for the shared `tsdb-pvc` (10 Gi by default).         |
| `ingress-nginx` *(optional)* | Needed only if you enable `ingress.enabled` (default `true`).  |
| Public images                | `tsdbai/tsdb-ai-{server,scraper,ui}:v0.9` on Docker Hub.       |

## Install

### Option 1 — OCI registry (preferred)

```bash
helm install tsdb-ai oci://ghcr.io/tsdb-ai/charts/tsdb-ai \
  --version 0.9.0 \
  --namespace tsdb-ai --create-namespace
```

### Option 2 — Classic Helm repo

```bash
helm repo add tsdb-ai https://tsdb-ai.github.io/charts
helm repo update
helm install tsdb-ai tsdb-ai/tsdb-ai \
  --namespace tsdb-ai --create-namespace
```

### Option 3 — From source (contributing / customizing)

```bash
git clone https://github.com/tsdb-ai/tsdb.ai
cd tsdb.ai/v0.9

helm dependency update install/helm/tsdb-ai
helm install tsdb-ai install/helm/tsdb-ai \
  --namespace tsdb-ai --create-namespace
```

## Values

### Globals

| Key                           | Default      | Notes                                                       |
| ----------------------------- | ------------ | ----------------------------------------------------------- |
| `global.image.registry`       | `docker.io`  | Applied to every subchart unless they override.             |
| `global.image.pullPolicy`     | `Always`     |                                                             |
| `global.imagePullSecrets`     | `[]`         |                                                             |
| `global.commonLabels`         | `{}`         | Merged into every rendered resource.                        |

Override the image tag for all three components at once by moving to a
release-specific tag:

```bash
helm upgrade tsdb-ai install/helm/tsdb-ai -n tsdb-ai \
  --set tsdb-server.image.tag=v0.9.1 \
  --set tsdb-scraper.image.tag=v0.9.1 \
  --set tsdb-ui.image.tag=v0.9.1
```

### Namespace / PVC / Ingress (umbrella-owned)

| Key                              | Default                                                | Notes                                                     |
| -------------------------------- | ------------------------------------------------------ | --------------------------------------------------------- |
| `namespace.create`               | `false`                                                | Prefer `--create-namespace`.                              |
| `namespace.name`                 | `tsdb-ai`                                              |                                                           |
| `persistence.enabled`            | `true`                                                 |                                                           |
| `persistence.name`               | `tsdb-pvc`                                             | Shared between server + scraper.                          |
| `persistence.accessModes`        | `[ReadWriteOnce]`                                      |                                                           |
| `persistence.size`               | `10Gi`                                                 | **Cannot shrink** after creation — start with headroom.   |
| `persistence.storageClass`       | `""` (cluster default)                                 |                                                           |
| `ingress.enabled`                | `true`                                                 |                                                           |
| `ingress.className`              | `nginx`                                                |                                                           |
| `ingress.host`                   | `tsdb.yourdomain.com`                                  | **Replace.**                                              |
| `ingress.tls.enabled`            | `false`                                                |                                                           |
| `ingress.tls.secretName`         | `tsdb-tls`                                             |                                                           |
| `ingress.annotations`            | nginx `rewrite-target: /`, 60s timeouts                |                                                           |

### Subchart toggles

| Key                           | Default | Notes                                                           |
| ----------------------------- | ------- | --------------------------------------------------------------- |
| `tsdb-server.enabled`         | `true`  |                                                                 |
| `tsdb-scraper.enabled`        | `true`  |                                                                 |
| `tsdb-scraper.ingestorUrl`    | in-cluster URL | Override to point at an ingestor outside the cluster.    |
| `tsdb-ui.enabled`             | `true`  |                                                                 |

Every subchart exposes its own per-component values (`replicaCount`, `image`,
`resources`, probes, …). See each subchart's `README.md` for the full list.

## Scenarios

### Server-only (no scraper, no UI)

```bash
helm install tsdb-ai ./install/helm/tsdb-ai -n tsdb-ai --create-namespace \
  --set tsdb-scraper.enabled=false \
  --set tsdb-ui.enabled=false \
  --set ingress.enabled=false
```

### Large deployment (100k+ active series)

```bash
helm upgrade tsdb-ai ./install/helm/tsdb-ai -n tsdb-ai \
  --set persistence.size=500Gi \
  --set tsdb-server.resources.requests.memory=8Gi \
  --set tsdb-server.resources.requests.cpu=2000m \
  --set tsdb-server.resources.limits.memory=16Gi \
  --set tsdb-server.resources.limits.cpu=4000m
```

### Custom ingress with TLS

```bash
helm upgrade tsdb-ai ./install/helm/tsdb-ai -n tsdb-ai \
  --set ingress.host=tsdb.example.com \
  --set ingress.tls.enabled=true \
  --set ingress.tls.secretName=tsdb-tls \
  --set 'ingress.annotations.cert-manager\.io/cluster-issuer=letsencrypt-prod'
```

## Upgrade

```bash
# From an OCI registry
helm upgrade tsdb-ai oci://ghcr.io/tsdb-ai/charts/tsdb-ai \
  --version 0.10.0 -n tsdb-ai

# From source
helm dependency update install/helm/tsdb-ai
helm upgrade tsdb-ai install/helm/tsdb-ai -n tsdb-ai
```

TSDB.ai uses a WAL, so in-flight data is safe across pod restarts as long
as the PVC is intact.

## Uninstall

```bash
helm uninstall tsdb-ai -n tsdb-ai

# The PVC is NOT deleted by `helm uninstall` — remove it explicitly if you
# want to wipe data.
kubectl -n tsdb-ai delete pvc tsdb-pvc
kubectl delete namespace tsdb-ai
```

## Layout

```
install/helm/
├── artifacthub-repo.yml             # Artifact Hub repo metadata
└── tsdb-ai/
    ├── Chart.yaml
    ├── values.yaml
    ├── README.md                    # you're reading it
    ├── templates/                   # umbrella-owned: namespace, pvc, ingress
    └── charts/
        ├── tsdb-server/
        ├── tsdb-scraper/
        └── tsdb-ui/
```

The plain manifests in [`install/k8s/`](../../install/k8s) are retained as an
alternative install path for users who don't want Helm.

## Related docs

- Full Helm guide — [`docs/helm.md`](../../docs/helm.md)
- Plain Kubernetes — [`docs/kubernetes.md`](../../docs/kubernetes.md)
- Docker — [`docs/docker.md`](../../docs/docker.md)
- Networking — [`docs/networking.md`](../../docs/networking.md)
