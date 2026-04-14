# Causal Engine (Root Cause Graph)

The Causal Engine continuously mines your ingested time series for cause-and-effect relationships between metrics. It tests whether changes in one metric statistically precede changes in another at various lag offsets, and builds a directed graph of leading-indicator relationships.

## Responsibilities

- Runs a background analysis cycle on all metrics in the head cache
- Tests cross-metric correlations at configurable lag offsets (e.g. 5s, 30s, 60s, 5min)
- Builds a directed causal edge graph: `A → B` means "A changes, then B follows ~Xs later"
- Assigns confidence scores to each edge
- Prunes edges that are not re-observed within the TTL window
- Persists the graph to `registry/causal.json`

## How It Works

For every pair of metrics (A, B), the engine shifts A's vector forward by each configured lag offset and computes the cross-correlation with B. If the correlation exceeds a threshold at a particular lag, a directed edge `A → B` is created with that lag time and confidence score.

This is how TSDB.ai can tell you: *"When `auth_errors` spikes, `checkout_latency` typically follows ~45 seconds later."*

## The Root Cause Graph UI

The admin panel's **Root Cause Graph** page renders the causal edges as an interactive force-directed graph. You can:
- Zoom and pan the graph
- Click any node to inspect its inbound and outbound edges
- See quantified lag times and confidence scores on each edge
- Identify the upstream root cause for any degrading metric

## Configuration Reference

| Setting | Default | Description |
|---|---|---|
| `analysis_interval_s` | 60 | Background cycle frequency |
| `max_edges_per_node` | 5 | Max outgoing edges per metric (fan-out cap) |
| `edge_ttl_minutes` | 10 | Edges not re-observed are pruned (raise in prod) |
| `lag_offsets_s` | [5,10,30,60,120,300] | Lag values tested (seconds) |

```yaml
causal:
  analysis_interval_s: 60
  max_edges_per_node: 5
  edge_ttl_minutes: 1440   # 1 day recommended for production
  lag_offsets_s: [5, 10, 30, 60, 120, 300]
```

## Production Notes

- **Raise `edge_ttl_minutes` to at least 1440 (1 day) in production.** The default of 10 is demo-only and will cause edges to disappear between analysis cycles
- To cover longer inter-service call chains, add larger offsets to `lag_offsets_s` (e.g. 600, 1800)
- Reduce `max_edges_per_node` if a highly-correlated "hub" metric is dominating the graph
- The causal graph is a **Pro** feature

## Persistence

The graph is saved to `{data.root}/registry/causal.json` at the end of each analysis cycle. The relationship graph (structural similarity) is stored separately in `registry/relationships.json`.
