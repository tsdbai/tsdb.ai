# Querying with LLM — Usage Guide

Once you've connected a language model (see [llm-setup.md](./llm-setup.md)), you can use two different AI interfaces depending on what you want to do. This document explains how each one works, what context the LLM receives automatically, and how to write effective queries.

---

## Two AI interfaces

### AI Chat (`/chat`)

A conversational interface for asking questions about your TSDB.ai instance. Best for:
- Diagnosing anomalies ("why is my CPU metric spiking?")
- Understanding configuration ("how do I tune my RMSE tolerance?")
- Writing PromQL queries in plain English
- Getting explanations of TSDB.ai concepts

### AI Dashboard (`/ai-dashboard`)

A richer interface that combines chat with live chart rendering, metric exploration, and saved sessions. Best for:
- Iterative investigation of a specific incident
- Charting metrics by asking in natural language
- Building dashboards conversationally
- Saving and revisiting past investigations

---

## What context the LLM receives automatically

Every message you send includes a **live system snapshot** injected as a system prompt. You don't need to describe your environment — the AI already knows:

- **Active series count** — how many unique metric streams are currently being tracked
- **Anomaly list** — every active anomaly with metric name, severity, RMSE deviation, and timestamp
- **Forecast data** — predicted values and quality scores for all forecasted metrics
- **Compression statistics** — chunks modeled, bytes stored, compression ratio
- **WAL and head cache state** — queue depths, cache size
- **Known metric names** — the full list of metric names currently in the system

When you mention a metric name in your message (e.g. "what's happening with `node_cpu_seconds_total`?"), the system automatically fetches the last hour of data for that metric and appends it as a data table before sending to the LLM. This means the AI can analyze the actual values, not just metadata.

---

## AI Dashboard modes

The AI Dashboard has three operating modes selectable via tabs:

| Mode | What it does |
|---|---|
| **Data** | General metric analysis, anomaly investigation, PromQL generation |
| **Design** | UI layout and dashboard organization suggestions |
| **Overlay** | Adds reference lines, annotations, and context overlays to charts |

Most investigative queries use **Data** mode.

---

## Example queries

### Investigating anomalies

```
What anomalies are active right now and which one is most severe?
```

```
The anomaly on node_memory_MemAvailable_bytes started 20 minutes ago.
What could cause a sudden drop in available memory?
```

```
Are any of the current anomalies related to each other?
Show me which metrics tend to move together.
```

### Understanding metric behavior

```
Chart node_cpu_seconds_total for the last hour
```

```
What is the trend on go_goroutines over the last 6 hours?
Is it growing, stable, or decreasing?
```

```
Show me my top 5 metrics by value right now
```

### Writing PromQL

```
Write a PromQL query to find all metrics where the value has
increased by more than 50% in the last hour
```

```
How do I calculate the rate of change for http_requests_total
over a 5-minute window in PromQL?
```

```
Give me a PromQL query for p99 latency from a histogram metric
called api_request_duration_seconds
```

### Storage and performance

```
How much data am I storing? What's my current compression ratio?
```

```
My WAL queue depth is showing 1200. Is that a problem?
What should I do about it?
```

```
How long until my storage fills up at the current ingestion rate?
```

### Configuration help

```
I have 500 active series coming in every 15 seconds.
What should I set for samples_per_segment and num_shards?
```

```
How do I connect TSDB.ai to my existing Prometheus setup?
```

```
What's the difference between rmse_tolerance and rmse_multiplier?
```

### Root cause analysis

```
node_memory_MemAvailable_bytes dropped 30% at 14:22.
What else changed around the same time?
```

```
Look at the causal graph. Which metrics are leading indicators
for my CPU utilization?
```

---

## Charting from natural language (AI Dashboard only)

In the AI Dashboard, the LLM can generate chart configurations and render them inline. Ask things like:

```
Show me a line chart of node_cpu_seconds_total for the last 2 hours
```

```
Compare node_memory_MemTotal_bytes and node_memory_MemAvailable_bytes
on the same chart
```

```
Chart go_goroutines as a bar chart
```

The AI Dashboard renders charts directly in the response panel using the live data from your Query Gateway. If a metric name isn't recognized, the AI will suggest similar names from the ones it knows about.

---

## Tips for better results

**Be specific about time ranges.** The default context window is the last hour. If you're investigating something that happened 3 hours ago, say so explicitly: "Look at node_cpu_seconds_total from 3 hours ago."

**Name metrics exactly.** The context engine auto-enriches your query when it detects a known metric name. Misspellings won't trigger enrichment. If you're not sure of the exact name, ask: "What metrics do you know about related to memory?"

**Mention the anomaly by name.** If there's an active anomaly on `process_resident_memory_bytes`, asking "what's causing the process_resident_memory_bytes anomaly?" will attach the actual anomaly details and recent data to the prompt automatically.

**Use the Refresh Context button.** If you've been in a session for a while and the instance state has changed (new anomalies, new metrics), click **Refresh context** in the header to pull a fresh snapshot before your next query.

**Ask follow-up questions.** The full conversation history is sent with each message, so the AI retains context across turns. You can ask "why?" or "show me that in a chart" after a previous answer without re-explaining the situation.

---

## Saved sessions (AI Dashboard)

The AI Dashboard automatically saves your conversation sessions to `ui_state.json` on the backend (via the `/internal/ui_state` endpoint). Sessions persist across browser refreshes.

- **New session:** Click **+** in the sessions panel on the left.
- **Rename session:** Click the session label and type a new name.
- **Switch sessions:** Click any session in the left panel.
- **Session context is independent** — switching sessions changes the full conversation history sent to the LLM.

---

## What the LLM cannot do

The LLM integration is read-only. It can analyze and explain your data, generate queries, and provide recommendations — but it cannot:

- Write or modify metric data
- Change your `tsdb.yaml` configuration directly
- Create alert rules (alert configuration is done in the alert builder UI)
- Push anomaly resolutions or acknowledgements

For automated actions triggered by LLM analysis, see the [MCP Server](./mcp-server.md) documentation — it enables AI agents (Claude Desktop, Cursor) to call TSDB.ai read APIs programmatically.
