# Kubernetes — Deployment Guide

This guide covers deploying TSDB.ai on Kubernetes. The manifests in `install/k8s/` target Google Kubernetes Engine (GKE) but the core `Deployment` and `PersistentVolumeClaim` work on any Kubernetes cluster.

---

## Prerequisites

| Requirement | Notes |
|---|---|
| Kubernetes 1.26+ | EKS, GKE, AKS, or self-hosted |
| `kubectl` configured | Pointing at your target cluster |
| Container image | Built and pushed to a registry — see [docker.md](./docker.md) |
| 2 vCPU / 2 GB RAM | Minimum node size for a single replica |

---

## Quick start

```bash
# 1. Create namespace
kubectl create namespace tsdb-ai

# 2. Apply storage + deployment
kubectl apply -f install/k8s/deployment.yaml -n tsdb-ai

# 3. Check pods
kubectl get pods -n tsdb-ai -w

# 4. Once Running, tail logs
kubectl logs -f -l app=tsdb-ai -n tsdb-ai
```

---

## Manifest overview

### `install/k8s/deployment.yaml`

Contains three resources:

**Deployment** — single replica of the all-in-one TSDB.ai container:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: tsdb-ai
  namespace: tsdb-ai
spec:
  replicas: 1
  selector:
    matchLabels:
      app: tsdb-ai
  template:
    spec:
      containers:
      - name: tsdb-ai
        image: YOUR_REGISTRY/tsdb-ai:v0.9   # ← update this
        ports:
        - containerPort: 8080   # Ingestor
        - containerPort: 8081   # Query Gateway
        - containerPort: 8084   # Deduper (internal)
        - containerPort: 8085   # Vector Store (internal)
        - containerPort: 9102   # Self Exporter
        - containerPort: 8000   # MCP Server
        volumeMounts:
        - mountPath: /app/tsdb.ai-data
          name: tsdb-storage
      volumes:
      - name: tsdb-storage
        persistentVolumeClaim:
          claimName: tsdb-pvc
```

**PersistentVolumeClaim** — 500 MB default (increase for production):

```yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: tsdb-pvc
  namespace: tsdb-ai
spec:
  accessModes:
    - ReadWriteOnce
  resources:
    requests:
      storage: 500Mi   # ← increase for production (50Gi, 500Gi, etc.)
```

**Service** — ClusterIP for internal routing:

```yaml
apiVersion: v1
kind: Service
metadata:
  name: tsdb-ai-svc
  namespace: tsdb-ai
spec:
  type: ClusterIP
  selector:
    app: tsdb-ai
  ports:
  - name: ingestor
    port: 8080
    targetPort: 8080
  - name: query-gateway
    port: 8081
    targetPort: 8081
  - name: mcp-server
    port: 8000
    targetPort: 8000
  - name: self-exporter
    port: 9102
    targetPort: 9102
```

---

## Step-by-step deployment

### 1. Build and push your image

```bash
cd v0.9/

# Build
docker build -f install/docker/Dockerfile -t tsdb-ai:v0.9 .

# Tag for your registry
docker tag tsdb-ai:v0.9 us-central1-docker.pkg.dev/MY_PROJECT/tsdb-ai/tsdb-ai:v0.9

# Push
docker push us-central1-docker.pkg.dev/MY_PROJECT/tsdb-ai/tsdb-ai:v0.9
```

### 2. Update the image reference

Edit `install/k8s/deployment.yaml` and replace the `image:` field:

```yaml
image: us-central1-docker.pkg.dev/MY_PROJECT/tsdb-ai/tsdb-ai:v0.9
```

### 3. Set the storage size

For production, increase the PVC size before first apply:

```yaml
resources:
  requests:
    storage: 100Gi   # adjust to your retention requirements
```

> **Important:** PVC size cannot be decreased after creation. Start with enough headroom.

### 4. Apply the manifests

```bash
kubectl create namespace tsdb-ai
kubectl apply -f install/k8s/deployment.yaml -n tsdb-ai
```

### 5. Verify the pod is running

```bash
kubectl get pods -n tsdb-ai

# NAME                      READY   STATUS    RESTARTS   AGE
# tsdb-ai-7d9b6f4c8-xk2nt   1/1     Running   0          45s

kubectl describe pod -l app=tsdb-ai -n tsdb-ai
```

---

## Overriding configuration with a ConfigMap

Rather than baking `tsdb.yaml` into the image, mount it from a ConfigMap so you can update config without rebuilding:

```bash
# Create ConfigMap from your tsdb.yaml
kubectl create configmap tsdb-config \
  --from-file=tsdb.yaml=./tsdb.yaml \
  -n tsdb-ai
```

Add to the Deployment spec:

```yaml
containers:
- name: tsdb-ai
  volumeMounts:
  - mountPath: /app/tsdb.ai-data
    name: tsdb-storage
  - mountPath: /app/tsdb.yaml
    name: tsdb-config
    subPath: tsdb.yaml          # ← mounts only the file, not a directory

volumes:
- name: tsdb-storage
  persistentVolumeClaim:
    claimName: tsdb-pvc
- name: tsdb-config
  configMap:
    name: tsdb-config
```

Apply a config update:

```bash
kubectl create configmap tsdb-config \
  --from-file=tsdb.yaml=./tsdb.yaml \
  -n tsdb-ai \
  --dry-run=client -o yaml | kubectl apply -f -

# Restart the pod to pick up the new config
kubectl rollout restart deployment/tsdb-ai -n tsdb-ai
```

---

## Exposing services

### Option A — Port-forward (local testing)

```bash
# Forward ingestor + query gateway to localhost
kubectl port-forward svc/tsdb-ai-svc 8080:8080 8081:8081 -n tsdb-ai

# Then access from your machine:
curl http://localhost:8080/internal/metrics
```

### Option B — LoadBalancer service (cloud)

Change the Service type and expose only the ports that should be public:

```yaml
apiVersion: v1
kind: Service
metadata:
  name: tsdb-ai-lb
  namespace: tsdb-ai
spec:
  type: LoadBalancer
  selector:
    app: tsdb-ai
  ports:
  - name: ingestor
    port: 8080
    targetPort: 8080
  - name: query-gateway
    port: 8081
    targetPort: 8081
```

> Keep ports `8084` (Deduper) and `8085` (Vector Store) off the LoadBalancer — they are internal-only.

### Option C — GKE Gateway API with HTTPS (production)

The `install/k8s/gke-networking.yaml` manifest configures a GKE L7 Global External Load Balancer with TLS termination via Google Certificate Manager.

**Prerequisites:**
- A static external IP named `tsdb-static-ip` reserved in your GCP project
- A Certificate Map entry in Google Certificate Manager for your domain
- GKE Gateway API enabled on your cluster

```bash
# Reserve static IP
gcloud compute addresses create tsdb-static-ip \
  --global --project MY_PROJECT

# Apply networking
kubectl apply -f install/k8s/gke-networking.yaml -n tsdb-ai
```

The Gateway manifest routes by path prefix:

| Path prefix | Routed to |
|---|---|
| `/ingest_samples`, `/internal/*` | Ingestor `:8080` |
| `/api/v1/*` | Query Gateway `:8081` |
| `/ingest`, `/search`, `/vectors` | Vector Store `:8085` |
| `/ingest_block` | Deduper `:8084` |
| `/metrics`, `/health` | Self Exporter `:9102` |

---

## Resource requests and limits

Add resource constraints to avoid noisy-neighbour issues on shared clusters:

```yaml
containers:
- name: tsdb-ai
  resources:
    requests:
      cpu: "500m"
      memory: "512Mi"
    limits:
      cpu: "2000m"
      memory: "4Gi"
```

Adjust based on your active series count. A rough guide:

| Active series | Memory request | CPU request |
|---|---|---|
| < 1,000 | 256 Mi | 250m |
| 1,000–10,000 | 512 Mi | 500m |
| 10,000–100,000 | 2 Gi | 1000m |
| 100,000+ | 8 Gi | 2000m |

---

## Liveness and readiness probes

```yaml
containers:
- name: tsdb-ai
  livenessProbe:
    httpGet:
      path: /health
      port: 9102
    initialDelaySeconds: 10
    periodSeconds: 30
    failureThreshold: 3

  readinessProbe:
    httpGet:
      path: /health
      port: 9102
    initialDelaySeconds: 5
    periodSeconds: 10
```

The `/health` endpoint on the Self Exporter `:9102` returns `200 OK` once all internal services are initialized.

---

## S3 long-term storage (recommended for production)

To enable S3 tiering so canonical blocks are offloaded from the PVC:

```yaml
# In your ConfigMap tsdb.yaml:
s3:
  enabled: true
  endpoint: ""              # leave blank for AWS; set for MinIO/GCS
  region: "us-east-1"
  bucket: "my-tsdb-blocks"
  prefix: "blocks/"
  access_key_id: "AKIAIOSFODNN7EXAMPLE"
  secret_access_key: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"
  retention_after_upload_min: 86400   # remove local copy after 24h
```

Store credentials as a Kubernetes Secret instead of plaintext in the ConfigMap:

```bash
kubectl create secret generic tsdb-s3-creds \
  --from-literal=access_key_id=AKIAIOSFODNN7EXAMPLE \
  --from-literal=secret_access_key=wJalrXUtnFEMI/K7MDENG \
  -n tsdb-ai
```

Then mount as environment variables:

```yaml
env:
- name: TSDB_S3_ACCESS_KEY_ID
  valueFrom:
    secretKeyRef:
      name: tsdb-s3-creds
      key: access_key_id
- name: TSDB_S3_SECRET_ACCESS_KEY
  valueFrom:
    secretKeyRef:
      name: tsdb-s3-creds
      key: secret_access_key
```

> S3 credential env var support requires the corresponding `tsdb.yaml` fields to reference the env vars — check `config.go` for the current approach; alternatively mount the entire secret as a file and reference it from `tsdb.yaml`.

---

## Upgrading

```bash
# Build and push new image
docker build -f install/docker/Dockerfile -t tsdb-ai:v0.9 .
docker push YOUR_REGISTRY/tsdb-ai:v0.9

# Update the deployment image
kubectl set image deployment/tsdb-ai \
  tsdb-ai=YOUR_REGISTRY/tsdb-ai:v0.9 \
  -n tsdb-ai

# Watch the rollout
kubectl rollout status deployment/tsdb-ai -n tsdb-ai
```

TSDB.ai uses a WAL — the in-flight data is safe across restarts as long as the PVC is intact.

---

## Scaling

TSDB.ai is designed as a **single-shard, single-replica** database. The 256 internal shards are in-process (not networked), so horizontal scaling requires a sharding layer in front (e.g. consistent-hash routing by metric name). Multi-replica support is on the roadmap.

For now, scale **vertically** (larger nodes) rather than horizontally.

---

## Troubleshooting

**Pod stuck in `Pending`**

Usually a PVC binding issue. Check:
```bash
kubectl describe pvc tsdb-pvc -n tsdb-ai
kubectl get storageclass
```
Ensure a default StorageClass exists on your cluster.

**`CrashLoopBackOff` immediately after start**

Check logs for config parse errors:
```bash
kubectl logs -l app=tsdb-ai -n tsdb-ai --previous
```
Most common cause: `tsdb.yaml` missing or malformed.

**Services running but metrics endpoint returns empty**

The Ingestor is up but no data has been pushed yet. Verify your scraper is pointed at `http://<service-ip>:8080/ingest_samples`. Check the Self Exporter for series count: `kubectl port-forward svc/tsdb-ai-svc 9102:9102 -n tsdb-ai && curl http://localhost:9102/metrics | grep unique_series`.
