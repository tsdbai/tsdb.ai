# MCP Server

The TSDB.ai MCP Server exposes your time series data to Claude (and any other MCP-compatible AI) as a set of callable tools. Once connected, Claude can query metrics, detect anomalies, retrieve forecasts, and analyze patterns directly from a conversation — no dashboards required.

## What is MCP?

Model Context Protocol (MCP) is an open standard for connecting AI models to external data sources and tools. The TSDB.ai MCP server implements this protocol so that Claude can interact with your live metrics data conversationally.

## Capabilities

Once connected, Claude can:
- Query any ingested metric by name and time range
- List all available metrics
- Retrieve recent anomaly events
- Fetch forecasts with confidence bands
- Search for patterns by name
- Get regime change events
- Run natural language analysis across your metric data

## Setup

The MCP server is a Python process (`tsdb_mcp_server.py`) that runs alongside the main TSDB.ai services.

### Docker

The MCP server is included in the Docker image and started automatically by Supervisor. It listens on port `8000` inside the container.

### Local

```bash
cd v0.9
uv run tsdb_mcp_server.py
```

Or with pip:

```bash
pip install mcp requests pandas scikit-learn numpy
python tsdb_mcp_server.py
```

### Connecting to Claude Desktop

Add the following to your Claude Desktop MCP configuration:

```json
{
  "mcpServers": {
    "tsdb": {
      "command": "python",
      "args": ["/path/to/v0.9/tsdb_mcp_server.py"],
      "env": {
        "TSDB_URL": "http://localhost:8081"
      }
    }
  }
}
```

## Example Conversations

Once connected, you can ask Claude things like:

- *"What metrics had anomalies in the last hour?"*
- *"Show me the forecast for `http_latency_p99` over the next 10 minutes"*
- *"Which metrics are most similar to `memory_rss` right now?"*
- *"Are there any regime changes in the last 24 hours?"*

## Dependencies

The MCP server requires Python 3.11+ and the following packages:

```
mcp[cli]
requests
pandas
scikit-learn
numpy
```

All dependencies are included in the Docker image and in the `uv` project definition.
