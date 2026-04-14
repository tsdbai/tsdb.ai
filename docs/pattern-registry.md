# Pattern Registry

The Pattern Registry stores named behavioral fingerprints for your metrics. You register a pattern (e.g. "memory_leak", "normal_deploy_ramp", "cache_warmup") and TSDB.ai automatically annotates future metrics whose vector matches the fingerprint above a configurable cosine similarity threshold.

## Responsibilities

- Stores named pattern fingerprints keyed by user-defined name
- Auto-annotates incoming vectors against all registered patterns each time a new model is fit
- Persists the registry to `registry/patterns.json`
- Evicts least-recently-used patterns when `max_registry_size` is exceeded
- Age-evicts patterns not matched within `max_age_days`

## How It Works

When the Ingestor fits a new model and generates a vector, it queries the Pattern Registry. For every registered pattern, it computes the cosine similarity between the new vector and the pattern's stored fingerprint. If the score exceeds `match_threshold`, the metric is annotated with that pattern name.

This means once you teach TSDB.ai what a "memory leak" looks like, it will automatically flag every future metric that exhibits the same shape — across all your services.

## Registering Patterns

Patterns can be registered via the admin panel (Patterns page) or via the API:

```http
POST /api/v1/patterns
Content-Type: application/json

{
  "name": "memory_leak",
  "metric": "memory_rss",
  "from": "2026-03-01T10:00:00Z",
  "to":   "2026-03-01T10:30:00Z"
}
```

TSDB.ai captures the vector from that metric in that time range and stores it as the pattern fingerprint.

## Configuration Reference

| Setting | Default | Description |
|---|---|---|
| `match_threshold` | 0.92 | Cosine similarity required for auto-annotation |
| `max_registry_size` | 500 | Max patterns stored (LRU eviction) |
| `max_age_days` | 90 | Patterns unmatched for this many days are evicted |

```yaml
patterns:
  match_threshold: 0.92
  max_registry_size: 500
  max_age_days: 90
```

## Persistence

The registry is saved to `{data.root}/registry/patterns.json` and loaded at startup. It survives restarts automatically.

## Use Cases

- **Incident playbooks** — register what an outage looks like, get notified automatically next time
- **Regression detection** — register "normal deploy" behavior; flag deploys that don't match
- **Capacity planning** — register "pre-saturation" patterns to catch resource exhaustion early
