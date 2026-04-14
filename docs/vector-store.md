# Vector Store

The Vector Store persists compressed polynomial model vectors for semantic similarity search and pattern matching. Every time the Ingestor fits a new model to a series, an enriched vector representation is pushed here asynchronously.

## Responsibilities

- Accepts enriched model vectors from the Ingestor via `POST /ingest`
- Deduplicates incoming vectors by cosine similarity (avoids storing redundant "boring" patterns)
- Maintains an in-memory and on-disk vector index
- Serves similarity search queries for the Pattern Registry and Relationship Graph
- Filters out low-change vectors below the `interesting_threshold`

## Port

`8085` (default, configurable via `server.vector_port`)

## How Vectors Are Created

Each time a polynomial model is fit to a segment of raw samples, the Ingestor extracts an 8-dimensional enriched feature vector from the model coefficients. This vector captures the shape and dynamics of the metric's recent behavior — not just its value.

These vectors are what power:
- **Pattern matching** — find metrics that look like a known pattern
- **Relationship graph** — find metrics whose vectors are structurally similar
- **Causal analysis** — detect which metrics lead others in time

## Deduplication

Before storing a new vector, the Vector Store checks it against existing entries using cosine similarity. If the score exceeds `match_threshold` (default 0.99), the new vector is considered a semantic duplicate and merged rather than inserted. This keeps the vector DB lean over time.

Vectors whose total change magnitude is below `interesting_threshold` (default 0.01) are filtered out entirely — flat, unchanging metrics don't produce useful patterns.

## Configuration Reference

| Setting | Default | Description |
|---|---|---|
| `match_threshold` | 0.99 | Cosine score for dedup merge |
| `interesting_threshold` | 0.01 | Minimum change magnitude to store |
| `ingest_queue_capacity` | 1000 | Async ingest queue depth |

```yaml
vectors:
  match_threshold: 0.99
  interesting_threshold: 0.01
  ingest_queue_capacity: 1000
```

## Tuning Tips

- Raise `match_threshold` to `0.995` to keep more distinct vectors (larger DB, richer search)
- Lower `interesting_threshold` to `0.005` to capture subtler behavioral changes
- Raise `ingest_queue_capacity` to `5000` under high metric cardinality to avoid queue-full warnings
