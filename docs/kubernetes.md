# Kubernetes — Deployment Guide

This guide covers deploying TSDB.ai on any Kubernetes cluster — self-hosted (k3s, kubeadm), or managed (EKS, AKS, GKE, DigitalOcean, etc.).

---

## Prerequisites

| Requirement | Notes |
|---|---|
| Kubernetes 1.26+ | Any distribution |
| `kubectl` configured | Pointing at your target cluster |
| Images pushed | `tsdbai/tsdb-ai-server:v0.9`, `tsdbai/tsdb-ai-scraper:v0.9`, `tsdbai/tsdb-ai-ui:v0.9` |
| 2 vCPU / 2 GB RAM | Minimum node size for a single-replica deployment |

---

## Quick Start

```bash
# 1. Apply everything (namespace, PVC, deployments, services)
kubectl apply -f install/k8s/deployment.yaml

# 2. Check pods
kubectl get pods -n tsdb-ai -w

# 3. Once Running — tail logs
kubectl logs -f -l app=tsdb-server -n tsdb-ai
```

---

## Manifests Overview

### `install/k8s/deployment.yaml`

Creates the full stack in the `tsdb-ai` namespace:

- **Namespace** `tsdb-ai`
- **PersistentVolumeClaim** `tsdb-pvc` — 10 Gi default (increase for production)
- **Deployment** `tsdb-server` — core engine: ingestor, query gateway, WAL shipper, deduper, vector DB, MCP server
- **Service** `tsdb-server` — ClusterIP, exposes all internal ports
- **Deployment** `tsdb-scraper` — metric scraper agent
- **Deployment** `tsdb-ui` — React admin panel served by nginx
- **Service** `tsdb-ui` — ClusterIP on port 3000

### `install/k8s/ingress.yaml`

Optional nginx ingress for external access. See [Exposing Services](#exposing-services) below.

---

## Storage

The PVC defaults to 10 Gi. For production, edit before first apply:

```yaml
# install/k8s/deployment.yaml
resources:
  requests:
    storage: 100Gi   # adjust to your retention needs
```

> **Important:** PVC size cannot be shrunk after creation. Start with headroom.

All data is written to `/app/tsdb.ai-data` inside the pod. The PVC is shared between the server and scraper deployments.

---

## Overriding Config with a ConfigMap

Rather than rebuilding the image to change config, mount `tsdb.yaml` from a ConfigMap:

```bash
kubectl create configmap tsdb-config \
  --from-file=tsdb.yaml=./tsdb.yaml \
  -n tsdb-ai
```

Add to the server Deployment spec:

```yaml
containers:
- name: tsdb-server
  volumeMounts:
  - mountPath: /app/tsdb.ai-data
    name: tsdb-storage
  - mountPath: /app/tsdb.yaml
    name: tsdb-config
    subPath: tsdb.yaml
volumes:
- name: tsdb-storage
  persistentVolumeClaim:
    claimName: tsdb-pvc
- name: tsdb-config
  configMap:
    name: tsdb-config
```

Apply a config update without rebuilding:

```bash
kubectl create configmap tsdb-config \
  --from-file=tsdb.yaml=./tsdb.yaml \
  -n tsdb-ai \
  --dry-run=client -o yaml | kubectl apply -f -

kubectl rollout restart deployment/tsdb-server -n tsdb-ai
```

---

## Exposing Services

### Option A — Port-forward (local testing)

```bash
# Admin UI
kubectl port-forward svc/tsdb-ui 3000:3000 -n tsdb-ai

# Core API + Query Gateway
kubectl port-forward svc/tsdb-server 8080:8080 8081:8081 -n tsdb-ai
```

### Option B — LoadBalancer service

For a simple public IP without an ingress controller:

```yaml
apiVersion: v1
kind: Service
metadata:
  name: tsdb-lb
  namespace: tsdb-ai
spec:
  type: LoadBalancer
  selector:
    app: tsdb-server
  ports:
  - name: ingestor
    port: 8080
    targetPort: 8080
  - name: query-gateway
    port: 8081
    targetPort: 8081
```

> Keep ports `8084` (deduper) and `8085` (vector service) off any LoadBalancer — they are internal-only.

### Option C — Nginx Ingress (recommended for production)

Install the nginx ingress controller if not already present:

```bash
kubectl apply -f https://raw.githubusercontent.com/kubernetes/ingress-nginx/controller-v1.10.0/deploy/static/provider/cloud/deploy.yaml
```

Get the external IP:

```bash
kubectl get svc -n ingress-nginx
# NAME                       TYPE           EXTERNAL-IP
# ingress-nginx-controller   LoadBalancer   203.0.113.42
```

Point your DNS A record at that IP. Then apply the ingress:

```bash
# Edit install/k8s/ingress.yaml — set your domain under `host:`
kubectl apply -f install/k8s/ingress.yaml
```

#### Adding TLS with cert-manager

```bash
# Install cert-manager
kubectl apply -f https://github.com/cert-manager/cert-manager/releases/latest/download/cert-manager.yaml

# Create a ClusterIssuer for Let's Encrypt
cat <<EOF | kubectl apply -f -
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: letsencrypt-prod
spec:
  acme:
    server: https://acme-v02.api.letsencrypt.org/directory
    email: you@yourdomain.com
    privateKeySecretRef:
      name: letsencrypt-prod
    solvers:
    - http01:
        ingress:
          class: nginx
EOF
```

Then uncomment the `tls` and `cert-manager.io/cluster-issuer` sections in `install/k8s/ingress.yaml`.

---

## Resource Sizing

Adjust based on active series count:

| Active series | Memory request | CPU request |
|---|---|---|
| < 1,000 | 256 Mi | 250m |
| 1,000–10,000 | 512 Mi | 500m |
| 10,000–100,000 | 2 Gi | 1000m |
| 100,000+ | 8 Gi | 2000m |

---

## Upgrading

```bash
# Re-tag and push the new image
docker tag tsdbai/tsdb-ai-server:v0.9 tsdbai/tsdb-ai-server:v1.0
docker push tsdbai/tsdb-ai-server:v1.0

# Roll out the new image
kubectl set image deployment/tsdb-server \
  tsdb-server=tsdbai/tsdb-ai-server:v1.0 \
  -n tsdb-ai

kubectl rollout status deployment/tsdb-server -n tsdb-ai
```

TSDB.ai uses a WAL — in-flight data is safe across restarts as long as the PVC is intact.

---

## Scaling

TSDB.ai is designed as a **single-shard, single-replica** database. The 256 internal shards are in-process (not networked), so horizontal scaling requires a sharding layer in front. For now, scale **vertically** (larger nodes) rather than horizontally.

---

## Troubleshooting

**Pod stuck in `Pending`** — Usually a PVC binding issue:
```bash
kubectl describe pvc tsdb-pvc -n tsdb-ai
kubectl get storageclass
```
Ensure a default StorageClass exists on your cluster.

**`CrashLoopBackOff` immediately** — Check for config errors:
```bash
kubectl logs -l app=tsdb-server -n tsdb-ai --previous
```

**Metrics endpoint returns empty** — No data ingested yet. Verify your scraper is pointed at `http://tsdb-server.tsdb-ai.svc.cluster.local:8080/ingest_samples`.
