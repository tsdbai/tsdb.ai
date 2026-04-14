# API Reference

TSDB.ai exposes two primary HTTP APIs on separate ports:

| Port | Service | Purpose |
|---|---|---|
| `:8080` | Ingestor | Write path, AI endpoints, internal state |
| `:8081` | Query Gateway | PromQL-compatible reads |
| `:8085` | Vector Store | Vector search and management |

All responses are JSON. All timestamps are Unix epoch (seconds) unless noted.

---

## Ingestor API (:8080)

### Write

#### `POST /ingest_samples`

Ingest raw metric samples. This is the primary write endpoint — Prometheus scrapers and external agents push to this endpoint.

**Request body**

```json
[
  {
    "metric": "http_latency_p99{service=\"checkout\",env=\"prod\"}",
    "timestamp_ms": 1712500000000,
    "value": 142.7
  },
  {
    "metric": "error_rate{service=\"checkout\"}",
    "timestamp_ms": 1712500000000,
    "value": 0.03
  }
]
```

**Response**

```
200 OK
Samples accepted.
```

---

### Query (Head Cache)

#### `GET /api/v1/query?query=<metric_prefix>`

Query the in-memory head cache for the most recent model and any in-flight raw samples. Used by the dashboard for real-time charts.

**Query parameters**

| Parameter | Required | Description |
|---|---|---|
| `query` | ✅ | Metric name or prefix to match |

**Response**

```json
{
  "models": [
    {
      "metric_string": "cpu_usage{host=\"web-01\"}",
      "coefficients": [1.2, 0.003, -0.0001],
      "model_id": 7,
      "timestamp": 1712500000
    }
  ],
  "raw_series": [
    {
      "metric": { "__name__": "cpu_usage", "host": "web-01" },
      "values": [[1712500000, "42.1"], [1712500030, "43.5"]]
    }
  ]
}
```

---

### Forecasting

#### `GET /forecast?metric=<name>&horizon=<seconds>`

Forecast a single metric forward by `horizon` seconds from now.

**Query parameters**

| Parameter | Required | Description |
|---|---|---|
| `metric` | ✅ | Full metric string or name prefix |
| `horizon` | ❌ | Forecast window in seconds (default: `300`) |

**Response**

```json
{
  "status": "success",
  "data": {
    "metric": "http_latency_p99{service=\"checkout\"}",
    "points": [
      { "timestamp": 1712500300, "value": 148.2, "upper": 155.1, "lower": 141.3 },
      { "timestamp": 1712500360, "value": 149.0, "upper": 156.2, "lower": 141.8 }
    ]
  }
}
```

#### `POST /forecast_batch`

Forecast multiple metrics in a single request.

**Request body**

```json
{
  "metrics": ["http_latency_p99", "error_rate", "memory_rss"],
  "horizon_seconds": 600
}
```

**Response**

```json
{
  "status": "success",
  "count": 3,
  "forecasts": [ ... ],
  "errors": []
}
```

#### `GET /forecast_all`

Forecast all known metrics using the default horizon. Used by the dashboard overview.

---

### Patterns

#### `GET /patterns`

List all registered behavioral pattern fingerprints.

**Response**

```json
{
  "status": "success",
  "count": 4,
  "patterns": [
    {
      "name": "memory_leak",
      "description": "Slow monotonic growth in RSS",
      "metric": "memory_rss{service=\"api\"}",
      "tagged_by": "alice",
      "created_at": "2026-04-07T10:00:00Z"
    }
  ]
}
```

#### `POST /patterns/label`

Register a new behavioral pattern from a specific metric's current vector.

**Request body**

```json
{
  "metric": "memory_rss{service=\"api\"}",
  "name": "memory_leak",
  "description": "Slow monotonic growth in RSS",
  "tagged_by": "alice"
}
```

**Response**

```json
{
  "status": "success",
  "message": "Pattern 'memory_leak' registered for metric 'memory_rss{service=\"api\"}'"
}
```

---

### Causal Graph

#### `GET /causal/graph?min_obs=<n>`

Return all causal edges in the root cause graph.

**Query parameters**

| Parameter | Required | Description |
|---|---|---|
| `min_obs` | ❌ | Minimum observation count to include an edge (default: `1`) |

**Response**

```json
{
  "status": "success",
  "count": 12,
  "edges": [
    {
      "source": "auth_errors",
      "target": "checkout_latency",
      "lag_seconds": 45,
      "confidence": 0.87,
      "observations": 14
    }
  ]
}
```

#### `GET /causal/upstream?metric=<name>&min_obs=<n>`

Return all metrics that causally precede the given metric (upstream causes).

**Query parameters**

| Parameter | Required | Description |
|---|---|---|
| `metric` | ✅ | Target metric name |
| `min_obs` | ❌ | Minimum observation count (default: `1`) |

**Response**

```json
{
  "status": "success",
  "metric": "checkout_latency",
  "upstream": [
    { "source": "auth_errors", "lag_seconds": 45, "confidence": 0.87 },
    { "source": "db_query_time", "lag_seconds": 12, "confidence": 0.91 }
  ]
}
```

#### `GET /causal/downstream?metric=<name>`

Return all metrics that are causally driven by the given metric (downstream effects).

**Response**

```json
{
  "status": "success",
  "metric": "auth_errors",
  "downstream": [
    { "target": "checkout_latency", "lag_seconds": 45, "confidence": 0.87 }
  ]
}
```

---

### Relationships

#### `GET /relationships`

Return all structural similarity edges — pairs of metrics whose behavioral vectors are similar but not necessarily causal.

**Response**

```json
{
  "status": "success",
  "count": 8,
  "edges": [
    {
      "source": "cpu_usage{host=\"web-01\"}",
      "target": "cpu_usage{host=\"web-02\"}",
      "score": 0.94
    }
  ]
}
```

---

### Internal

#### `GET /internal/license`

Returns the current license validation status.

**Response**

```json
{
  "IsLicensed": true,
  "Customer": "Acme Corp",
  "Email": "you@example.com",
  "Tier": "pro",
  "Features": ["alert_builder", "chat_integrations", "causal_graph"],
  "Issued": "2026-04-07",
  "Expires": "2027-04-07",
  "DaysLeft": 365,
  "ExpiringSoon": false
}
```

#### `GET /internal/config`

Returns the current active configuration as JSON (mirrors `tsdb.yaml` after parsing).

#### `GET /internal/metrics`

Returns operational metrics for TSDB.ai itself — WAL queue depth, compression latency, cache hit rate, etc.

#### `GET /internal/metadata`

Returns metadata for all known series — metric names, label sets, and last-seen timestamps.

#### `GET /internal/ui_state`
#### `POST /internal/ui_state`

Persist and retrieve admin panel state (AI chat history, chart layout). Used internally by the React UI.

---

## Query Gateway API (:8081)

The Query Gateway exposes a Prometheus-compatible HTTP API. Any Grafana datasource, PromQL client, or Prometheus-compatible tool works without modification.

### PromQL Queries

#### `GET /api/v1/query`
#### `POST /api/v1/query`

Instant query at a point in time.

**Parameters**

| Parameter | Description |
|---|---|
| `query` | PromQL expression |
| `time` | Unix timestamp (optional, defaults to now) |

#### `GET /api/v1/query_range`
#### `POST /api/v1/query_range`

Range query over a time window.

**Parameters**

| Parameter | Description |
|---|---|
| `query` | PromQL expression |
| `start` | Start Unix timestamp |
| `end` | End Unix timestamp |
| `step` | Resolution step (e.g. `15`, `60`) |

**Response format**

```json
{
  "status": "success",
  "data": {
    "resultType": "matrix",
    "result": [
      {
        "metric": { "__name__": "cpu_usage", "host": "web-01" },
        "values": [[1712500000, "42.1"], [1712500060, "43.5"]]
      }
    ]
  }
}
```

### Metadata

#### `GET /api/v1/labels`

Return all label names.

#### `GET /api/v1/label/<name>/values`

Return all values for a given label name.

#### `GET /api/v1/series`

Return all matching series for a label selector.

**Parameters**

| Parameter | Description |
|---|---|
| `match[]` | Label selector (e.g. `{service="checkout"}`) |
| `start` | Start Unix timestamp |
| `end` | End Unix timestamp |

#### `GET /api/v1/metadata`

Return metadata for all metrics (type and help text where available).

---

## Vector Store API (:8085)

### `POST /ingest`

Ingest a behavioral vector. Called automatically by the Ingestor — typically not called directly.

**Request body**

```json
{
  "id": "cpu_usage{host=\"web-01\"}",
  "vector": [0.12, -0.03, 0.87, 0.44, 0.01, -0.22, 0.65, 0.09],
  "metadata": { "model_id": 7, "timestamp": 1712500000 }
}
```

### `POST /search`

Search for vectors semantically similar to the given query vector.

**Request body**

```json
{
  "vector": [0.12, -0.03, 0.87, 0.44, 0.01, -0.22, 0.65, 0.09],
  "top_k": 5
}
```

**Response**

```json
{
  "status": "success",
  "results": [
    { "id": "memory_rss{service=\"api\"}", "score": 0.97 },
    { "id": "cpu_usage{host=\"web-02\"}", "score": 0.91 }
  ]
}
```

### `GET /vectors?model=<id>`

List all stored vectors, optionally filtered by model ID.

**Query parameters**

| Parameter | Required | Description |
|---|---|---|
| `model` | ❌ | Integer model ID filter |

---

## Error Responses

All endpoints return standard HTTP status codes:

| Code | Meaning |
|---|---|
| `200` | Success |
| `400` | Bad request — missing or invalid parameters |
| `404` | Metric or resource not found |
| `405` | Method not allowed |
| `500` | Internal server error |

Error bodies follow this format where applicable:

```json
{
  "status": "error",
  "error": "no series found for metric 'foo'"
}
```

---

## CORS

The Ingestor sets permissive CORS headers (`Access-Control-Allow-Origin: *`) on all responses, allowing the React admin panel dev server on `:3000` to call `:8080` without browser errors.

---

## Grafana Integration

Point a Grafana Prometheus datasource at the Query Gateway:

```
URL: http://localhost:8081
```

No authentication required for local deployments. The Query Gateway responds to Grafana's health check (`1+1`), label queries, and full PromQL range queries.
