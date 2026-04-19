# Helm — Deployment Guide

This guide covers deploying TSDB.ai on any Kubernetes cluster using the
official Helm chart. Helm is the recommended install path for Kubernetes
— for the raw manifest alternative see [`kubernetes.md`](./kubernetes.md).

The chart source lives in [`install/helm/tsdb-ai/`](../install/helm/tsdb-ai).

---

## Prerequisites

| Requirement                   | Notes                                                                                   |
| ----------------------------- | --------------------------------------------------------------------------------------- |
| Kubernetes **1.23+**          | Any distribution (EKS, GKE, AKS, k3s, kind, minikube, Rancher, DigitalOcean, …).        |
| Helm **3.8+**                 | Older Helm can install from source but cannot pull OCI charts. `helm version`.          |
| `kubectl` configured          | Pointing at your target cluster.                                                        |
| A default `StorageClass`      | Required for the shared `tsdb-pvc`. `kubectl get storageclass` — one must be marked `(default)`. |
| `ingress-nginx` *(optional)*  | Only needed if you keep `ingress.enabled=true` (the default).                           |
| Public images                 | `tsdbai/tsdb-ai-{server,scraper,ui}:v0.9` — pulled from Docker Hub by default.          |

---

## Chart Layout

```
install/helm/tsdb-ai/
├── Chart.yaml              # umbrella — version 0.9.0, appVersion v0.9
├── values.yaml             # global image settings + per-subchart toggles
├── README.md               # human-readable chart overview
├── templates/
│   ├── _helpers.tpl        # shared labels / namespace helpers
│   ├── NOTES.txt           # post-install message
│   ├── namespace.yaml      # optional (prefer `--create-namespace`)
│   ├── pvc.yaml            # shared 10 Gi PVC (server + scraper)
│   └── ingress.yaml        # nginx ingress with full path routing
└── charts/
    ├── tsdb-server/        # core binary — 6 ports, shared PVC mount
    ├── tsdb-scraper/       # scraper agent — no Service, outbound only
    └── tsdb-ui/            # React admin UI served by nginx on :3000
```

**Architectural notes:**

- The `Namespace`, `PVC`, and `Ingress` live in the umbrella because they are
  shared across subcharts. Putting them inside any single subchart would
  create ordering and lifecycle problems.
- Each subchart declares a `condition: <name>.enabled` in the umbrella's
  `Chart.yaml` dependencies — toggle components on/off with a single flag.
- Subchart Deployments and Services use fixed names (`tsdb-server`,
  `tsdb-scraper`, `tsdb-ui`) so the umbrella Ingress backends and the
  scraper's `TSDB_INGESTOR_URL` resolve correctly regardless of release name.
- Image tags default to `.Chart.AppVersion` (`v0.9`). Override globally with
  `--set global.image.tag=...`, or per-component with
  `--set tsdb-server.image.tag=...`.

---

## Quick Start

### Option A — OCI registry (recommended)

```bash
helm install tsdb-ai oci://ghcr.io/tsdb-ai/charts/tsdb-ai \
  --version 0.9.0 \
  --namespace tsdb-ai --create-namespace
```

### Option B — Classic Helm repo

```bash
helm repo add tsdb-ai https://tsdb-ai.github.io/charts
helm repo update
helm install tsdb-ai tsdb-ai/tsdb-ai \
  --namespace tsdb-ai --create-namespace
```

### Option C — From source (for development or customization)

```bash
git clone https://github.com/tsdb-ai/tsdb.ai
cd tsdb.ai/v0.9

helm dependency update install/helm/tsdb-ai
helm install tsdb-ai install/helm/tsdb-ai \
  --namespace tsdb-ai --create-namespace
```

After installation, Helm will print a readiness checklist (the `NOTES.txt`).
Confirm everything is up:

```bash
kubectl -n tsdb-ai get pods,svc,ingress,pvc
kubectl -n tsdb-ai rollout status deploy/tsdb-server
```

Open the admin UI — if Ingress is enabled, at
`http://<your-host>/`; otherwise port-forward:

```bash
kubectl -n tsdb-ai port-forward svc/tsdb-ui 3000:3000
open http://localhost:3000
```

---

## Values Reference

Full reference lives in
[`install/helm/tsdb-ai/values.yaml`](../install/helm/tsdb-ai/values.yaml);
the highlights:

### Globals

| Key                         | Default     | Notes                                             |
| --------------------------- | ----------- | ------------------------------------------------- |
| `global.image.registry`     | `docker.io` | Applied to every subchart unless overridden.      |
| `global.image.pullPolicy`   | `Always`    |                                                   |
| `global.imagePullSecrets`   | `[]`        | Applied to every pod.                             |
| `global.commonLabels`       | `{}`        | Merged into every rendered resource.              |

### Namespace / PVC / Ingress (umbrella-owned)

| Key                         | Default                  | Notes                                                   |
| --------------------------- | ------------------------ | ------------------------------------------------------- |
| `namespace.create`          | `false`                  | Prefer `helm install --create-namespace`.               |
| `namespace.name`            | `tsdb-ai`                |                                                         |
| `persistence.enabled`       | `true`                   |                                                         |
| `persistence.name`          | `tsdb-pvc`               | Shared between server and scraper.                      |
| `persistence.size`          | `10Gi`                   | **Cannot shrink** — start with headroom.                |
| `persistence.accessModes`   | `[ReadWriteOnce]`        |                                                         |
| `persistence.storageClass`  | `""` (cluster default)   |                                                         |
| `ingress.enabled`           | `true`                   |                                                         |
| `ingress.className`         | `nginx`                  |                                                         |
| `ingress.host`              | `tsdb.yourdomain.com`    | **Replace.**                                            |
| `ingress.tls.enabled`       | `false`                  |                                                         |
| `ingress.tls.secretName`    | `tsdb-tls`               | Used only when TLS is enabled.                          |
| `ingress.annotations`       | nginx `rewrite-target: /`, 60 s timeouts | Merge your own on top. |

### Subchart toggles

| Key                           | Default | Notes                                                            |
| ----------------------------- | ------- | ---------------------------------------------------------------- |
| `tsdb-server.enabled`         | `true`  |                                                                  |
| `tsdb-scraper.enabled`        | `true`  |                                                                  |
| `tsdb-scraper.ingestorUrl`    | in-cluster URL | Override to point at an ingestor elsewhere.               |
| `tsdb-ui.enabled`             | `true`  |                                                                  |

Every subchart exposes its own per-component values (`replicaCount`, `image`,
`resources`, probes, `env`, `nodeSelector`, …). See:

- [`charts/tsdb-server/values.yaml`](../install/helm/tsdb-ai/charts/tsdb-server/values.yaml)
- [`charts/tsdb-scraper/values.yaml`](../install/helm/tsdb-ai/charts/tsdb-scraper/values.yaml)
- [`charts/tsdb-ui/values.yaml`](../install/helm/tsdb-ai/charts/tsdb-ui/values.yaml)

---

## Common Scenarios

### Server + UI only (no scraper)

Useful when you already run Prometheus remote-write or have a scraper living
elsewhere.

```bash
helm install tsdb-ai ./install/helm/tsdb-ai \
  -n tsdb-ai --create-namespace \
  --set tsdb-scraper.enabled=false
```

### Scraper only (ingestor outside the cluster)

```bash
helm install tsdb-scraper ./install/helm/tsdb-ai/charts/tsdb-scraper \
  -n tsdb-ai --create-namespace \
  --set ingestorUrl=https://tsdb.example.com/ingest_samples
```

### Large deployment (100 k+ active series)

```bash
helm upgrade tsdb-ai ./install/helm/tsdb-ai -n tsdb-ai \
  --set persistence.size=500Gi \
  --set tsdb-server.resources.requests.memory=8Gi \
  --set tsdb-server.resources.requests.cpu=2000m \
  --set tsdb-server.resources.limits.memory=16Gi \
  --set tsdb-server.resources.limits.cpu=4000m
```

### Custom ingress hostname + TLS via cert-manager

```bash
helm upgrade tsdb-ai ./install/helm/tsdb-ai -n tsdb-ai \
  --set ingress.host=tsdb.example.com \
  --set ingress.tls.enabled=true \
  --set ingress.tls.secretName=tsdb-tls \
  --set 'ingress.annotations.cert-manager\.io/cluster-issuer=letsencrypt-prod'
```

### Per-environment values files

Keep overrides in version control and pass them via `-f`:

```yaml
# values.prod.yaml
persistence:
  size: 1Ti
  storageClass: gp3
ingress:
  host: tsdb.example.com
  tls:
    enabled: true
tsdb-server:
  resources:
    requests: { memory: 8Gi, cpu: 2000m }
    limits:   { memory: 16Gi, cpu: 4000m }
```

```bash
helm upgrade --install tsdb-ai ./install/helm/tsdb-ai \
  -n tsdb-ai --create-namespace \
  -f values.prod.yaml
```

### Mounting `tsdb.yaml` from a ConfigMap

```bash
kubectl -n tsdb-ai create configmap tsdb-config \
  --from-file=tsdb.yaml=./tsdb.yaml

helm upgrade tsdb-ai ./install/helm/tsdb-ai -n tsdb-ai \
  --set-json 'tsdb-server.envFrom=[{"configMapRef":{"name":"tsdb-config"}}]'
```

---

## Upgrading

```bash
# Dry-run to preview the diff
helm upgrade tsdb-ai ./install/helm/tsdb-ai -n tsdb-ai --dry-run

# Apply
helm upgrade tsdb-ai ./install/helm/tsdb-ai -n tsdb-ai

# Roll back if something breaks
helm rollback tsdb-ai 1 -n tsdb-ai
```

TSDB.ai uses a WAL — in-flight writes survive pod restarts as long as the PVC
is intact. Rolling upgrades follow standard Kubernetes rolling-update
semantics (one new pod up before the old is terminated).

---

## Uninstalling

```bash
helm uninstall tsdb-ai -n tsdb-ai
```

**Important:** `helm uninstall` does **not** remove the PVC. Your time-series
data is preserved so you can reinstall without loss. To fully wipe:

```bash
kubectl -n tsdb-ai delete pvc tsdb-pvc
kubectl delete namespace tsdb-ai
```

---

## Troubleshooting

### `ImagePullBackOff`

The images aren't on the registry Helm resolved. Either the registry or the
tag is wrong:

```bash
kubectl -n tsdb-ai describe pod -l app=tsdb-server | head -40
```

If the resolved image is `docker.io/tsdbai/tsdb-ai-server:v0.9` and that isn't
published yet, point at your own registry:

```bash
helm upgrade tsdb-ai ./install/helm/tsdb-ai -n tsdb-ai \
  --set global.image.registry=ghcr.io/myorg
```

### Pod stuck `Pending` — no PVC

```bash
kubectl -n tsdb-ai describe pvc tsdb-pvc
kubectl get storageclass
```

Most likely no default `StorageClass` exists. Either mark one default:

```bash
kubectl patch storageclass <name> \
  -p '{"metadata":{"annotations":{"storageclass.kubernetes.io/is-default-class":"true"}}}'
```

or pick one explicitly:

```bash
helm upgrade tsdb-ai ./install/helm/tsdb-ai -n tsdb-ai \
  --set persistence.storageClass=gp3
```

### `CrashLoopBackOff` immediately after startup

```bash
kubectl -n tsdb-ai logs -l app=tsdb-server --previous
```

Most common causes: the server can't write to `/app/tsdb.ai-data` (fix:
`persistence.enabled=true` + a compatible `StorageClass`), or a ConfigMap
mounted to `/app/tsdb.yaml` has invalid YAML.

### Ingress returns 404 / 502

Confirm the nginx ingress controller is installed and has an external IP:

```bash
kubectl -n ingress-nginx get svc ingress-nginx-controller
```

Confirm the host header matches `ingress.host`:

```bash
curl -H "Host: $INGRESS_HOST" http://$INGRESS_IP/api/health
```

### Scraper isn't ingesting

```bash
kubectl -n tsdb-ai logs -l app=tsdb-scraper --tail=50
```

Verify the resolved `TSDB_INGESTOR_URL`:

```bash
kubectl -n tsdb-ai get deploy tsdb-scraper -o yaml | grep -A2 TSDB_INGESTOR_URL
```

It should resolve inside the cluster:

```bash
kubectl -n tsdb-ai run -it --rm curl --image=curlimages/curl --restart=Never -- \
  curl -sS http://tsdb-server.tsdb-ai.svc.cluster.local:8080/health
```

### `helm dependency update` fails offline

The `Chart.yaml` dependencies use `file://charts/<subchart>` so they don't
require internet — but `helm dependency update` *does* walk the tree. If you
see a "not found" error, make sure you ran it from **the chart directory**
(the path holding `Chart.yaml`), not from the subchart:

```bash
helm dependency update install/helm/tsdb-ai   # ✅
helm dependency update install/helm/tsdb-ai/charts/tsdb-server   # ❌
```

---

## Publishing the Chart

You only need this section if you're forking and want to distribute your own
copy. The upstream chart is published by the TSDB.ai team.

### 1. Package

```bash
helm package install/helm/tsdb-ai --destination ./dist
# dist/tsdb-ai-0.9.0.tgz
```

### 2. Publish to an OCI registry (preferred)

Any OCI-compliant registry works — GHCR, Docker Hub, Quay, ECR Public.

```bash
echo "$GHCR_PAT" | helm registry login ghcr.io -u <your-user> --password-stdin

helm push dist/tsdb-ai-0.9.0.tgz oci://ghcr.io/<your-org>/charts
```

Users then install with:

```bash
helm install tsdb-ai oci://ghcr.io/<your-org>/charts/tsdb-ai --version 0.9.0
```

### 3. Or publish to GitHub Pages (classic repo)

```bash
helm package install/helm/tsdb-ai --destination ./dist
helm repo index ./dist --url https://<your-org>.github.io/charts

# Commit dist/ to the `gh-pages` branch and push.
git worktree add /tmp/gh-pages gh-pages
cp dist/* /tmp/gh-pages/
cp install/helm/artifacthub-repo.yml /tmp/gh-pages/
(cd /tmp/gh-pages && git add . && git commit -m "chart 0.9.0" && git push)
```

### 4. List on Artifact Hub

[Artifact Hub](https://artifacthub.io) doesn't host charts — it indexes them.

1. Sign in → Control Panel → Repositories → Add.
2. Choose kind `Helm charts` and paste the repo URL:
   - OCI: `oci://ghcr.io/<your-org>/charts`
   - GH Pages: `https://<your-org>.github.io/charts`
3. Artifact Hub will generate a `repositoryID`. Paste it into
   [`install/helm/artifacthub-repo.yml`](../install/helm/artifacthub-repo.yml),
   commit, and redeploy. This is what gives you the "Verified Publisher"
   badge.
4. After the next crawl (usually < 30 min) the chart appears at
   `artifacthub.io/packages/helm/<your-repo>/tsdb-ai`.

The umbrella `Chart.yaml` already includes the Artifact Hub annotations
(`artifacthub.io/images`, `artifacthub.io/links`, `artifacthub.io/changes`,
etc.) that populate the package page.

---

## Validating the Chart Locally

```bash
# Static lint
helm lint install/helm/tsdb-ai

# Render to stdout without installing
helm template tsdb-ai install/helm/tsdb-ai \
  --namespace tsdb-ai > /tmp/rendered.yaml

# Compare against the raw manifests (sanity check)
diff -u install/k8s/deployment.yaml <(helm template tsdb-ai install/helm/tsdb-ai)

# Dry-run on the live cluster (talks to the API server)
helm install tsdb-ai install/helm/tsdb-ai -n tsdb-ai --create-namespace --dry-run
```

---

## See Also

- [`kubernetes.md`](./kubernetes.md) — raw `kubectl apply` install path.
- [`docker.md`](./docker.md) — single-host Docker install.
- [`networking.md`](./networking.md) — port and firewall reference.
- Chart README — [`install/helm/tsdb-ai/README.md`](../install/helm/tsdb-ai/README.md).
- Subchart READMEs — [tsdb-server](../install/helm/tsdb-ai/charts/tsdb-server/README.md),
  [tsdb-scraper](../install/helm/tsdb-ai/charts/tsdb-scraper/README.md),
  [tsdb-ui](../install/helm/tsdb-ai/charts/tsdb-ui/README.md).
