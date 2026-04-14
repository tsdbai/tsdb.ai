import logging
import requests
import numpy as np
from typing import List, Dict, Any
from mcp.server.fastmcp import FastMCP
from sklearn.cluster import KMeans
import time

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# --- Configuration ---
TSDB_QUERY_URL = "http://localhost:8081"   # Query Gateway
VECTOR_DB_URL  = "http://localhost:8085"   # Vector DB
INGESTOR_URL   = "http://localhost:8080"   # Ingestor (also serves /forecast)

# Data root — must match the DataRoot constant in main.go
DATA_ROOT         = "./tsdb.ai-data"
ANOMALY_DIR       = DATA_ROOT + "/events/anomalies"
REGIME_CHANGE_DIR = DATA_ROOT + "/events/regimes"

# Initialize MCP Server
mcp = FastMCP("TSDB.ai-Agent")

# --- Helper Functions ---

def fetch_series(metric_name: str, lookback_seconds: int = 600) -> List[Dict]:
    """Fetches raw series data from the TSDB Query Gateway."""
    end_time = int(time.time())
    start_time = end_time - lookback_seconds
    
    params = {
        "query": metric_name,
        "start": start_time,
        "end": end_time
    }
    
    try:
        response = requests.get(f"{TSDB_QUERY_URL}/api/v1/query_range", params=params)
        response.raise_for_status()
        data = response.json()
        if data.get("status") == "success":
            return data.get("data", {}).get("result", [])
        return []
    except Exception as e:
        logger.error(f"Error fetching series {metric_name}: {e}")
        return []

def get_metric_vector(metric_name: str, lookback_seconds: int = 300) -> List[float]:
    """
    Calculates a simple shape vector [a, b, c] for a metric's recent history.
    Uses numpy polyfit (degree 2) to mimic the TSDB's internal model.
    """
    series_list = fetch_series(metric_name, lookback_seconds)
    if not series_list:
        return []
    
    # Use the first series found
    values = [float(v[1]) for v in series_list[0].get("values", [])]
    if len(values) < 3:
        return [] # Not enough data
    
    # Fit quadratic curve: y = ax^2 + bx + c
    x = np.arange(len(values))
    coeffs = np.polyfit(x, values, 2)
    return coeffs.tolist() # Returns [a, b, c]

def fetch_metadata() -> List[str]:
    """Fetches all available metric names."""
    try:
        response = requests.get(f"{TSDB_QUERY_URL}/api/v1/label/__name__/values")
        response.raise_for_status()
        data = response.json()
        if data.get("status") == "success":
            return data.get("data", [])
        return []
    except Exception as e:
        logger.error(f"Error fetching metadata: {e}")
        return []


# --- MCP Tools ---

@mcp.tool()
def find_historical_incidents(metric_name: str) -> str:
    """
    Checks if the current behavior of a metric matches any historical incidents.
    Use this when a user asks "Has this happened before?".
    
    Args:
        metric_name: The name of the metric to analyze (e.g., 'cpu_usage').
    """
    # 1. Get current shape vector
    query_vector = get_metric_vector(metric_name)
    if not query_vector:
        return f"Could not analyze shape for {metric_name} (insufficient data)."
        
    # 2. Search Vector DB
    payload = {"vector": query_vector, "top_k": 5}
    try:
        resp = requests.post(f"{VECTOR_DB_URL}/search", json=payload)
        resp.raise_for_status()
        results = resp.json().get("results", [])
    except Exception as e:
        return f"Error querying Vector DB: {e}"
        
    if not results:
        return "No similar historical patterns found."
        
    # 3. Format Output for LLM
    output = [f"Found {len(results)} historical matches for {metric_name}'s current shape:"]
    for res in results:
        score = res.get("score", 0)
        meta = res.get("metadata", {})

        incident_id = meta.get("incident_id", "Unknown-Incident")
        root_cause  = meta.get("root_cause", "Unknown Cause")
        timestamp   = meta.get("t_base", "Unknown Time")
        # Phase 3: surface any named pattern matches stored in metadata
        named_patterns = meta.get("matched_patterns", "")

        if score > 0.95:
            output.append(f"- MATCH (Score: {score:.4f}): Incident {incident_id} at {timestamp}")
            if root_cause != "Unknown Cause":
                output.append(f"  Possible Root Cause: {root_cause}")
            if named_patterns:
                output.append(f"  ⚠️  Known Pattern: {named_patterns}")

    return "\n".join(output)


@mcp.tool()
def correlate_service_metrics(target_metric: str) -> str:
    """
    Finds other metrics in the system that are behaving identically to the target metric right now.
    Use this for root cause analysis ("What else is breaking?").
    """
    target_vector = get_metric_vector(target_metric)
    if not target_vector:
        return f"No data for {target_metric}."
        
    payload = {"vector": target_vector, "top_k": 10}
    try:
        resp = requests.post(f"{VECTOR_DB_URL}/search", json=payload)
        results = resp.json().get("results", [])
    except:
        return "Vector search failed."

    correlated = []
    
    for res in results:
        meta = res.get("metadata", {})
        metric = meta.get("metric")
        
        if metric == target_metric: continue
        
        score = res.get("score", 0)
        if score > 0.90:
            correlated.append(f"- {metric} (Similarity: {score:.4f})")
            
    if not correlated:
        return "No other metrics found with a similar behavior pattern."
        
    return f"Found strongly correlated metrics for {target_metric}:\n" + "\n".join(correlated)


@mcp.tool()
def summarize_system_state(service_filter: str = "") -> str:
    """
    Provides a semantic summary of system behavior.
    Fetches model types (Constant, Linear, Quadratic) to describe state.
    
    Args:
        service_filter: Optional string to filter metrics (e.g., "checkout").
    """
    all_metrics = fetch_metadata()
    if service_filter:
        targets = [m for m in all_metrics if service_filter in m]
    else:
        targets = all_metrics[:5] 
        
    summary = []
    for metric in targets:
        vec = get_metric_vector(metric, lookback_seconds=300)
        if not vec: continue
        
        a, b, c = vec[0], vec[1], vec[2]
        
        behavior = "Stable"
        if abs(a) > 0.01: 
            behavior = "Accelerating (Quadratic)" if a > 0 else "Decelerating/Crashing (Quadratic)"
        elif abs(b) > 0.1:
            behavior = "Growing Linearly" if b > 0 else "Declining Linearly"
            
        summary.append(f"- {metric}: {behavior}")
        
    return "System State Summary:\n" + "\n".join(summary)


@mcp.tool()
def suggest_alert_thresholds(metric_name: str) -> str:
    """
    Analyzes historical 'Normal' behavior to suggest alert thresholds.
    """
    series_list = fetch_series(metric_name, lookback_seconds=86400) 
    if not series_list: return "No history found."
    
    values = []
    for s in series_list:
        for v in s.get("values", []):
            values.append(float(v[1]))
            
    if not values: return "No data."
    
    p95 = np.percentile(values, 95)
    p99 = np.percentile(values, 99)
    
    x = np.arange(len(values))
    m, c = np.polyfit(x, values, 1)
    
    return (
        f"Based on the last 24 hours of '{metric_name}':\n"
        f"- 'Normal' range (p95): up to {p95:.2f}\n"
        f"- Recommended Warning Threshold: {p95 * 1.1:.2f}\n"
        f"- Recommended Critical Threshold: {p99 * 1.2:.2f}\n"
        f"- Fast Leak Detection: Alert if Slope > {abs(m)*1.5:.4f} / tick"
    )


@mcp.tool()
def hunt_outliers(metric_pattern: str) -> str:
    """
    Finds "needle in the haystack" anomalies by clustering a group of metrics.
    Example: "Which container is behaving differently?"
    """
    all_metrics = fetch_metadata()
    targets = [m for m in all_metrics if metric_pattern in m]
    
    if len(targets) < 3:
        return f"Need at least 3 metrics matching '{metric_pattern}' to find outliers."
        
    data_matrix = []
    valid_metrics = []
    
    for m in targets:
        vec = get_metric_vector(m)
        if vec:
            data_matrix.append(vec)
            valid_metrics.append(m)
            
    if not data_matrix: return "No data available for clustering."
    
    kmeans = KMeans(n_clusters=2, random_state=42)
    clusters = kmeans.fit_predict(data_matrix)
    
    count0 = np.sum(clusters == 0)
    count1 = np.sum(clusters == 1)
    
    outlier_cluster = 0 if count0 < count1 else 1
    outliers = []
    
    for i, label in enumerate(clusters):
        if label == outlier_cluster:
            outliers.append(valid_metrics[i])
            
    if len(outliers) == 0:
        return "No distinct outliers found (all metrics behave similarly)."
        
    return f"Found {len(outliers)} outliers in the '{metric_pattern}' group:\n" + "\n".join([f"- {m}" for m in outliers])

# =============================================================================
# Phase 3 Tool — Pattern Fingerprint Registry
# =============================================================================

@mcp.tool()
def set_pattern_label(metric_name: str, pattern_name: str, notes: str = "") -> str:
    """
    Tags the current behavioral shape of a metric with a named pattern label.
    Future metrics that match this shape will be identified as this pattern type.
    Use this after an incident to encode the failure signature for future detection.
    Examples: "memory_leak", "DDoS_spike", "cache_stampede", "normal_deploy_ramp".

    Args:
        metric_name: The metric whose current shape to fingerprint.
        pattern_name: A short name for this pattern (e.g., 'memory_leak').
        notes: Optional description or root-cause notes for this pattern.
    """
    try:
        payload = {
            "metric": metric_name,
            "name": pattern_name,
            "description": notes,
            "tagged_by": "claude_mcp"
        }
        resp = requests.post(
            f"{INGESTOR_URL}/patterns/label",
            json=payload,
            timeout=5
        )
        resp.raise_for_status()
        data = resp.json()
        if data.get("status") == "success":
            return (
                f"Pattern '{pattern_name}' registered for '{metric_name}'.\n"
                f"Future metrics with this behavioral shape will be flagged automatically.\n"
                f"Details: {data.get('message', '')}"
            )
        return f"Failed to register pattern: {data.get('error', 'unknown error')}"
    except Exception as e:
        return f"Error registering pattern for '{metric_name}': {e}"


@mcp.tool()
def list_known_patterns() -> str:
    """
    Lists all named behavioral patterns registered in the system, ordered by
    how frequently they've been matched.  Shows which failure signatures the
    system has learned to recognize.
    """
    try:
        resp = requests.get(f"{INGESTOR_URL}/patterns", timeout=5)
        resp.raise_for_status()
        data = resp.json()
        patterns = data.get("patterns", [])
        if not patterns:
            return "No patterns registered yet. Use set_pattern_label to teach the system failure signatures."

        lines = [f"Known behavioral patterns ({len(patterns)} registered):\n"]
        for p in patterns:
            lines.append(
                f"  [{p.get('match_count', 0)} matches] {p['name']}\n"
                f"    ID: {p['id']}\n"
                f"    Tagged by: {p.get('tagged_by', '?')} at "
                f"{__import__('time').strftime('%Y-%m-%d', __import__('time').localtime(p.get('tagged_at', 0)))}\n"
                f"    Notes: {p.get('description', 'none')}"
            )
        return "\n".join(lines)
    except Exception as e:
        return f"Error fetching pattern registry: {e}"


# =============================================================================
# Phase 1 Tools — Forecasting & Natural Language Explanation
# =============================================================================

@mcp.tool()
def predict_metric(metric_name: str, horizon_seconds: int = 300) -> str:
    """
    Forecasts the future value of a metric using its current polynomial model.
    Use this when a user asks "Will X breach a threshold?", "How long until Y runs out?",
    or "What will Z look like in 10 minutes?".

    Args:
        metric_name: The metric to forecast (e.g., 'cpu_usage', 'disk_free{host="web01"}').
        horizon_seconds: How far ahead to forecast in seconds (default: 300 = 5 minutes).
    """
    try:
        resp = requests.get(
            f"{INGESTOR_URL}/forecast",
            params={"metric": metric_name, "horizon": horizon_seconds},
            timeout=5
        )
        resp.raise_for_status()
        data = resp.json()

        if data.get("status") != "success":
            return f"Forecast unavailable for '{metric_name}': {data.get('error', 'unknown error')}"

        f = data["data"]
        metric   = f["metric"]
        current  = f["current_value"]
        predicted = f["predicted_value"]
        low      = f["confidence_low"]
        high     = f["confidence_high"]
        model    = f["model_name"]
        quality  = f["forecast_quality"]
        horizon  = f["horizon_seconds"]
        rmse     = f["rolling_rmse"]

        # Build a human-readable time label
        if horizon >= 3600:
            time_label = f"{horizon/3600:.1f} hours"
        elif horizon >= 60:
            time_label = f"{horizon/60:.0f} minutes"
        else:
            time_label = f"{horizon:.0f} seconds"

        # Describe the trend direction
        delta = predicted - current
        if abs(delta) < rmse * 0.5:
            trend_desc = "remaining approximately stable"
        elif delta > 0:
            rate = delta / horizon
            trend_desc = f"increasing by ~{rate:.3f}/sec ({'+' if delta >= 0 else ''}{delta:.2f} total)"
        else:
            rate = abs(delta) / horizon
            trend_desc = f"decreasing by ~{rate:.3f}/sec ({delta:.2f} total)"

        quality_note = {
            "HIGH":   "High confidence — stable metric with low noise.",
            "MEDIUM": "Medium confidence — some variability in recent history.",
            "LOW":    "Low confidence — volatile metric, treat as directional only."
        }.get(quality, "")

        return (
            f"Forecast for '{metric}' over the next {time_label}:\n"
            f"  Current value:   {current:.4f}\n"
            f"  Predicted value: {predicted:.4f}\n"
            f"  Confidence band: [{low:.4f}, {high:.4f}]\n"
            f"  Trend:           {trend_desc}\n"
            f"  Model:           {model} (RMSE baseline: {rmse:.4f})\n"
            f"  Quality:         {quality} — {quality_note}"
        )

    except Exception as e:
        return f"Error fetching forecast for '{metric_name}': {e}"


@mcp.tool()
def explain_metric(metric_name: str) -> str:
    """
    Provides a plain-English explanation of what a metric is currently doing,
    including its behavioral trend, rate of change, model quality, and a short
    near-term outlook.  Use this when a user asks "What is X doing?" or
    "Is Y healthy right now?".

    Args:
        metric_name: The name of the metric to explain.
    """
    try:
        # Fetch current model + 5-minute forecast together
        forecast_resp = requests.get(
            f"{INGESTOR_URL}/forecast",
            params={"metric": metric_name, "horizon": 300},
            timeout=5
        )
        forecast_resp.raise_for_status()
        fdata = forecast_resp.json()

        if fdata.get("status") != "success":
            return f"No data found for '{metric_name}'."

        f = fdata["data"]
        model_id  = f["model_id"]
        model_name = f["model_name"]
        current   = f["current_value"]
        predicted_5m = f["predicted_value"]
        rmse      = f["rolling_rmse"]
        quality   = f["forecast_quality"]
        params_note = ""

        # Describe behavior based on model type
        if model_id == 0:
            behavior = f"completely stable at {current:.4f}"
            outlook  = "No change expected — metric is constant."

        elif model_id == 1:
            # Linear: params = [m, c, 0]
            # We infer slope from current vs 5-min predicted
            slope = (predicted_5m - current) / 300.0
            if abs(slope) < 0.001:
                behavior = f"nearly flat, hovering around {current:.4f}"
                outlook  = "Minimal change expected over the next few minutes."
            elif slope > 0:
                time_to_double = None
                if current > 0:
                    time_to_double = current / slope / 60
                behavior = f"growing linearly at ~{slope:.4f} per second (currently {current:.4f})"
                outlook  = f"Will reach ~{predicted_5m:.4f} in 5 minutes."
                if time_to_double and time_to_double < 60:
                    outlook += f" At this rate, it doubles in ~{time_to_double:.1f} minutes."
            else:
                behavior = f"declining linearly at ~{abs(slope):.4f} per second (currently {current:.4f})"
                outlook  = f"Will reach ~{predicted_5m:.4f} in 5 minutes."

        else:  # Quadratic
            delta = predicted_5m - current
            if delta > 0:
                behavior = f"accelerating upward — growth rate is itself increasing (currently {current:.4f})"
                outlook  = f"Projected to reach ~{predicted_5m:.4f} in 5 minutes. ⚠️ Curved growth — monitor closely."
            else:
                behavior = f"decelerating/curving downward (currently {current:.4f})"
                outlook  = f"Projected to reach ~{predicted_5m:.4f} in 5 minutes."

        # Noise/quality annotation
        noise_note = {
            "HIGH":   "Signal is clean and reliable.",
            "MEDIUM": "Moderate noise — predictions are directionally correct.",
            "LOW":    "High noise — exact values unreliable, trend only."
        }.get(quality, "")

        return (
            f"'{metric_name}' is currently {behavior}.\n\n"
            f"Outlook (5 min): {outlook}\n"
            f"Model:           {model_name} | Quality: {quality} | RMSE: {rmse:.4f}\n"
            f"Signal:          {noise_note}"
        )

    except Exception as e:
        return f"Error explaining '{metric_name}': {e}"


# =============================================================================
# Phase 2 Tools — Anomaly & Regime Change Intelligence
# =============================================================================

@mcp.tool()
def list_active_anomalies(lookback_minutes: int = 30, min_severity: float = 0.0) -> str:
    """
    Returns all anomalies detected in the last N minutes, ranked by severity.
    Severity is the ratio of detected RMSE to historical mean RMSE — higher = worse.
    Use this when a user asks "What's alerting right now?" or "What went wrong recently?".

    Args:
        lookback_minutes: How far back to scan for anomaly events (default: 30).
        min_severity: Minimum RMSE ratio to include (default: 0 = show all).
    """
    import os, json, glob

    anomaly_dir = ANOMALY_DIR
    if not os.path.exists(anomaly_dir):
        return "No anomaly directory found. No anomalies have been logged yet."

    cutoff_time = time.time() - (lookback_minutes * 60)
    events = []

    for filepath in glob.glob(f"{anomaly_dir}/*.json"):
        try:
            with open(filepath) as fh:
                ev = json.load(fh)
            log_time = ev.get("log_time", 0)
            if log_time < cutoff_time:
                continue
            rmse = ev.get("rmse", 0)
            if rmse < min_severity:
                continue
            events.append(ev)
        except Exception:
            continue

    if not events:
        return f"No anomalies detected in the last {lookback_minutes} minutes."

    # Sort by RMSE descending (highest severity first)
    events.sort(key=lambda e: e.get("rmse", 0), reverse=True)

    lines = [f"Active anomalies (last {lookback_minutes} min) — {len(events)} found:\n"]
    for ev in events[:20]:  # cap at 20
        metric = ev.get("metric_string", "unknown")
        rmse   = ev.get("rmse", 0)
        reason = ev.get("reason", "")
        model  = ev.get("detected_model", "?")
        ts     = ev.get("timestamp_start", 0)
        model_names = {0: "Constant", 1: "Linear", 2: "Quadratic"}
        lines.append(
            f"  [{model_names.get(model, '?')}] {metric}\n"
            f"    RMSE: {rmse:.2f} | Reason: {reason}\n"
            f"    Time: {time.strftime('%Y-%m-%d %H:%M:%S', time.localtime(ts))}"
        )

    return "\n".join(lines)


@mcp.tool()
def what_changed_recently(lookback_minutes: int = 15) -> str:
    """
    Identifies metrics that recently underwent a behavioral regime shift —
    e.g., a metric that was stable (Constant model) but is now trending (Linear),
    or one that was trending but is now accelerating (Quadratic).
    Use this for "What changed after the deploy?" or "What started acting differently?".

    Args:
        lookback_minutes: Scan window in minutes (default: 15).
    """
    import os, json, glob

    regime_dir = REGIME_CHANGE_DIR
    if not os.path.exists(regime_dir):
        return "No regime change directory found. This feature requires v0.7 data to accumulate."

    cutoff_time = time.time() - (lookback_minutes * 60)
    changes = []

    for filepath in glob.glob(f"{regime_dir}/*.json"):
        try:
            with open(filepath) as fh:
                ev = json.load(fh)
            if ev.get("detected_at", 0) < cutoff_time:
                continue
            changes.append(ev)
        except Exception:
            continue

    if not changes:
        return f"No regime shifts detected in the last {lookback_minutes} minutes. System behavior appears stable."

    changes.sort(key=lambda e: e.get("detected_at", 0), reverse=True)

    model_names = {0: "Constant (stable)", 1: "Linear (trending)", 2: "Quadratic (accelerating)"}
    lines = [f"Regime shifts in the last {lookback_minutes} min — {len(changes)} found:\n"]
    for ev in changes[:20]:
        metric    = ev.get("metric_string", "unknown")
        from_m    = ev.get("from_model", "?")
        to_m      = ev.get("to_model", "?")
        ts        = ev.get("detected_at", 0)
        lines.append(
            f"  {metric}\n"
            f"    {model_names.get(from_m, str(from_m))} → {model_names.get(to_m, str(to_m))}\n"
            f"    Detected: {time.strftime('%H:%M:%S', time.localtime(ts))}"
        )

    return "\n".join(lines)


# =============================================================================
# Phase 4 Tools — Causal Analysis & Root Cause
# =============================================================================

@mcp.tool()
def find_root_cause(affected_metric: str, lookback_minutes: int = 10) -> str:
    """
    Identifies which metrics likely caused a problem in the target metric by
    combining causal graph upstream edges with recent regime change events.
    Use this when a user asks "Why is X degrading?" or "What caused this incident?".

    Args:
        affected_metric: The metric that is degrading or anomalous.
        lookback_minutes: How far back to check for correlated changes (default: 10).
    """
    import os, json, glob

    lines = [f"Root cause analysis for '{affected_metric}':\n"]

    # 1. Causal graph: who leads this metric?
    try:
        resp = requests.get(
            f"{INGESTOR_URL}/causal/upstream",
            params={"metric": affected_metric, "min_obs": 1},
            timeout=5
        )
        upstream = resp.json().get("upstream", [])
        if upstream:
            lines.append("Causal upstream (leading indicators):")
            for edge in upstream[:5]:
                lines.append(
                    f"  {edge['source_metric']} → {affected_metric}\n"
                    f"    Lag: ~{edge['lag_seconds']}s | Confidence: {edge['max_correlation']:.3f} "
                    f"| Seen {edge['observation_count']}x"
                )
        else:
            lines.append("No upstream causal edges found yet (needs more observation time).")
    except Exception as e:
        lines.append(f"Causal graph unavailable: {e}")

    # 2. Regime changes: what shifted behavior recently?
    lines.append("\nRecent regime shifts (possible change points):")
    regime_dir = REGIME_CHANGE_DIR
    cutoff_time = time.time() - (lookback_minutes * 60)
    found_changes = []
    if os.path.exists(regime_dir):
        for filepath in glob.glob(f"{regime_dir}/*.json"):
            try:
                with open(filepath) as fh:
                    ev = json.load(fh)
                if ev.get("detected_at", 0) >= cutoff_time:
                    found_changes.append(ev)
            except Exception:
                continue

    if found_changes:
        found_changes.sort(key=lambda e: e.get("detected_at", 0))
        model_names = {0: "Constant", 1: "Linear", 2: "Quadratic"}
        for ev in found_changes[:8]:
            metric = ev.get("metric_string", "?")
            from_m = model_names.get(ev.get("from_model"), "?")
            to_m   = model_names.get(ev.get("to_model"), "?")
            ts     = time.strftime("%H:%M:%S", time.localtime(ev.get("detected_at", 0)))
            lines.append(f"  [{ts}] {metric}: {from_m} → {to_m}")
    else:
        lines.append(f"  No regime shifts detected in the last {lookback_minutes} minutes.")

    # 3. Related metrics (structural siblings)
    lines.append("\nStructurally related metrics (may share root cause):")
    try:
        resp = requests.get(
            f"{INGESTOR_URL}/relationships",
            params={"metric": affected_metric, "min_score": 0.85},
            timeout=5
        )
        related = resp.json().get("related", [])
        if related:
            for edge in related[:5]:
                peer = edge["metric_b"] if edge["metric_a"] == affected_metric else edge["metric_a"]
                lines.append(f"  {peer} (similarity: {edge['latest_score']:.3f})")
        else:
            lines.append("  No strongly related metrics found.")
    except Exception as e:
        lines.append(f"  Relationship graph unavailable: {e}")

    return "\n".join(lines)


# =============================================================================
# Phase 5 Tools — Deployment Intelligence & Health Scoring
# =============================================================================

@mcp.tool()
def detect_regressions(service_filter: str, lookback_minutes: int = 15) -> str:
    """
    Compares metric behavior in the current window vs N minutes ago to surface
    any metrics that changed significantly — likely caused by a recent deploy.
    Use this immediately after a deploy: "Did anything regress in the last 15 minutes?".

    Args:
        service_filter: Label substring to match metrics (e.g., 'checkout', 'auth').
        lookback_minutes: Minutes to look back for the baseline window (default: 15).
    """
    all_metrics = fetch_metadata()
    if service_filter:
        targets = [m for m in all_metrics if service_filter in m]
    else:
        targets = all_metrics[:30]

    if not targets:
        return f"No metrics found matching '{service_filter}'."

    now = int(time.time())
    baseline_start = now - (lookback_minutes * 2 * 60)
    baseline_end   = now - (lookback_minutes * 60)
    current_start  = baseline_end
    current_end    = now

    regressions = []
    stable       = []

    for metric in targets:
        try:
            # Baseline window
            r1 = requests.get(f"{TSDB_QUERY_URL}/api/v1/query_range",
                              params={"query": metric, "start": baseline_start, "end": baseline_end}, timeout=5)
            # Current window
            r2 = requests.get(f"{TSDB_QUERY_URL}/api/v1/query_range",
                              params={"query": metric, "start": current_start, "end": current_end}, timeout=5)

            d1 = r1.json().get("data", {}).get("result", [])
            d2 = r2.json().get("data", {}).get("result", [])

            if not d1 or not d2:
                continue

            v1 = [float(v[1]) for v in d1[0].get("values", [])]
            v2 = [float(v[1]) for v in d2[0].get("values", [])]

            if len(v1) < 3 or len(v2) < 3:
                continue

            c1 = np.polyfit(np.arange(len(v1)), v1, 2)
            c2 = np.polyfit(np.arange(len(v2)), v2, 2)

            score, _ = _cosine_sim(c1.tolist(), c2.tolist())

            if score < 0.80:
                regressions.append((metric, score))
            else:
                stable.append(metric)
        except Exception:
            continue

    if not regressions:
        return f"No regressions detected across {len(stable)} '{service_filter}' metrics. System looks stable."

    regressions.sort(key=lambda x: x[1])
    lines = [f"Regressions detected after deploy ({len(regressions)} of {len(targets)} metrics diverged):\n"]
    for metric, score in regressions:
        severity = "🔴 HIGH" if score < 0.50 else ("🟡 MEDIUM" if score < 0.65 else "🟢 LOW")
        lines.append(f"  {severity}  {metric}  (similarity: {score:.3f})")

    lines.append(f"\n{len(stable)} metrics unchanged.")
    return "\n".join(lines)


def _cosine_sim(a, b):
    """Helper: numpy cosine similarity between two lists."""
    a, b = np.array(a), np.array(b)
    denom = np.linalg.norm(a) * np.linalg.norm(b)
    if denom == 0:
        return 0.0, None
    return float(np.dot(a, b) / denom), None


@mcp.tool()
def compare_deployments(baseline_timestamp: int, service_filter: str = "", window_minutes: int = 15) -> str:
    """
    Compares metric behavior in two deploy windows to assess whether the current
    deploy is safer or worse than a reference.
    Use this when asked "Is this deploy better or worse than last Tuesday's?".

    Args:
        baseline_timestamp: Unix timestamp of the reference deploy to compare against.
        service_filter: Optional label substring to filter metrics.
        window_minutes: Duration of each window in minutes (default: 15).
    """
    all_metrics = fetch_metadata()
    targets = [m for m in all_metrics if service_filter in m] if service_filter else all_metrics[:20]

    if not targets:
        return f"No metrics found matching '{service_filter}'."

    now = int(time.time())
    window_secs = window_minutes * 60

    high, medium, low = [], [], []
    errors = 0

    for metric in targets:
        try:
            r1 = requests.get(f"{TSDB_QUERY_URL}/api/v1/query_range",
                params={"query": metric, "start": baseline_timestamp, "end": baseline_timestamp + window_secs}, timeout=5)
            r2 = requests.get(f"{TSDB_QUERY_URL}/api/v1/query_range",
                params={"query": metric, "start": now - window_secs, "end": now}, timeout=5)

            d1 = r1.json().get("data", {}).get("result", [])
            d2 = r2.json().get("data", {}).get("result", [])

            if not d1 or not d2:
                errors += 1
                continue

            v1 = [float(v[1]) for v in d1[0].get("values", [])]
            v2 = [float(v[1]) for v in d2[0].get("values", [])]

            if len(v1) < 3 or len(v2) < 3:
                continue

            c1 = np.polyfit(np.arange(len(v1)), v1, 2)
            c2 = np.polyfit(np.arange(len(v2)), v2, 2)
            score, _ = _cosine_sim(c1.tolist(), c2.tolist())

            if score > 0.85:
                high.append((metric, score))
            elif score > 0.65:
                medium.append((metric, score))
            else:
                low.append((metric, score))
        except Exception:
            errors += 1

    total = len(high) + len(medium) + len(low)
    if total == 0:
        return "Insufficient data to compare deployments."

    overall_score = (len(high) * 100 + len(medium) * 72 + len(low) * 40) / total
    verdict = "✅ SAFE" if overall_score > 85 else ("⚠️  DEGRADED" if overall_score > 65 else "🔴 REGRESSION")

    lines = [
        f"Deploy comparison — baseline: {time.strftime('%Y-%m-%d %H:%M', time.localtime(baseline_timestamp))}",
        f"Verdict: {verdict}  (composite similarity: {overall_score:.0f}/100)\n",
        f"  {len(high)} metrics: similar (>0.85)",
        f"  {len(medium)} metrics: slightly changed (0.65–0.85)",
        f"  {len(low)} metrics: significantly diverged (<0.65)",
    ]
    if low:
        lines.append("\nDiverged metrics:")
        for m, s in sorted(low, key=lambda x: x[1]):
            lines.append(f"  {m} (similarity: {s:.3f})")
    return "\n".join(lines)


@mcp.tool()
def get_service_health_score(service_filter: str = "") -> str:
    """
    Returns a 0–100 health score for a service by aggregating the current
    behavioral state of all matching metrics.  Higher is healthier.
    Use this for dashboards or when asked "How healthy is the checkout service?".

    Args:
        service_filter: Label substring to match metrics (e.g., 'checkout').
                        Leave empty to score the whole system.
    """
    all_metrics = fetch_metadata()
    targets = [m for m in all_metrics if service_filter in m] if service_filter else all_metrics

    if not targets:
        return f"No metrics found matching '{service_filter}'."

    scores = {"stable": [], "trending": [], "volatile": [], "anomalous": []}

    for metric in targets[:50]:  # cap at 50 for speed
        vec = get_metric_vector(metric, lookback_seconds=300)
        if not vec or len(vec) < 3:
            continue
        a, b, _ = vec[0], vec[1], vec[2]
        if abs(a) > 0.01:
            scores["volatile"].append(metric)
        elif abs(b) > 0.05:
            scores["trending"].append(metric)
        else:
            scores["stable"].append(metric)

    # Check for active anomalies via anomaly dir
    import os, json, glob
    anomaly_dir = ANOMALY_DIR
    cutoff = time.time() - 600  # last 10 min
    active_anomalies = set()
    if os.path.exists(anomaly_dir):
        for fp in glob.glob(f"{anomaly_dir}/*.json"):
            try:
                with open(fp) as fh:
                    ev = json.load(fh)
                if ev.get("log_time", 0) > cutoff:
                    m = ev.get("metric_string", "")
                    if not service_filter or service_filter in m:
                        active_anomalies.add(m)
            except Exception:
                pass

    # Move anomalous to its own bucket
    for m in list(active_anomalies):
        for bucket in ["stable", "trending", "volatile"]:
            if m in scores[bucket]:
                scores[bucket].remove(m)
        scores["anomalous"].append(m)

    n_stable   = len(scores["stable"])
    n_trending = len(scores["trending"])
    n_volatile = len(scores["volatile"])
    n_anomalous = len(scores["anomalous"])
    total = n_stable + n_trending + n_volatile + n_anomalous

    if total == 0:
        return f"No metric data available for '{service_filter}'."

    score = (n_stable * 100 + n_trending * 70 + n_volatile * 40 + n_anomalous * 10) / total

    emoji = "✅" if score >= 80 else ("⚠️" if score >= 50 else "🔴")
    label = service_filter or "System"

    lines = [
        f"{emoji} {label} health: {score:.0f}/100\n",
        f"  {n_stable} stable     | {n_trending} trending",
        f"  {n_volatile} volatile  | {n_anomalous} anomalous",
    ]
    if scores["anomalous"]:
        lines.append("\nActive anomalies:")
        for m in scores["anomalous"][:5]:
            lines.append(f"  🔴 {m}")
    if scores["trending"]:
        lines.append("\nTrending metrics (watch):")
        for m in scores["trending"][:5]:
            lines.append(f"  🟡 {m}")
    return "\n".join(lines)


# =============================================================================
# Phase 6 Tools — Advanced Clustering & Natural Language Alerting
# =============================================================================

@mcp.tool()
def cluster_metrics(service_filter: str = "", n_clusters: int = 0) -> str:
    """
    Groups all matching metrics by behavioral similarity using K-Means clustering.
    Returns a human-readable summary of each cluster and highlights outliers.
    Use this for "Show me the behavioral groups in my checkout service" or
    "Which metrics are behaving differently from the rest?".

    Args:
        service_filter: Optional label substring to filter metrics.
        n_clusters: Number of clusters (0 = auto-select using elbow method, max 6).
    """
    all_metrics = fetch_metadata()
    targets = [m for m in all_metrics if service_filter in m] if service_filter else all_metrics

    if len(targets) < 3:
        return f"Need at least 3 metrics to cluster. Found {len(targets)} matching '{service_filter}'."

    data_matrix = []
    valid_metrics = []
    for m in targets:
        vec = get_metric_vector(m, lookback_seconds=300)
        if vec and len(vec) >= 3:
            data_matrix.append(vec[:3])  # use [a,b,c] for clustering
            valid_metrics.append(m)

    if len(data_matrix) < 3:
        return "Not enough data to cluster."

    X = np.array(data_matrix)

    # Auto-select k using elbow method (2–6 clusters)
    if n_clusters <= 0:
        best_k, best_inertia_drop = 2, 0
        prev_inertia = None
        for k in range(2, min(7, len(X))):
            km = KMeans(n_clusters=k, random_state=42, n_init=10)
            km.fit(X)
            if prev_inertia is not None:
                drop = prev_inertia - km.inertia_
                if drop > best_inertia_drop:
                    best_inertia_drop = drop
                    best_k = k
            prev_inertia = km.inertia_
        n_clusters = best_k

    km = KMeans(n_clusters=n_clusters, random_state=42, n_init=10)
    labels = km.fit_predict(X)

    # Group metrics by cluster
    clusters = {}
    for i, label in enumerate(labels):
        clusters.setdefault(int(label), []).append((valid_metrics[i], data_matrix[i]))

    # Describe each cluster by its centroid behavior
    def describe_centroid(centroid):
        a, b, c = centroid[0], centroid[1], centroid[2]
        if abs(a) > 0.01:
            return "Accelerating / Quadratic"
        elif abs(b) > 0.05:
            return ("Growing Linearly" if b > 0 else "Declining Linearly")
        else:
            return "Stable / Constant"

    lines = [f"Behavioral clusters ({n_clusters} groups, {len(valid_metrics)} metrics):\n"]
    for cluster_id in sorted(clusters.keys()):
        members = clusters[cluster_id]
        centroid = km.cluster_centers_[cluster_id]
        description = describe_centroid(centroid)
        size = len(members)
        is_outlier = size <= max(1, len(valid_metrics) // (n_clusters * 3))
        outlier_flag = " ⚠️  OUTLIER" if is_outlier else ""
        lines.append(f"Cluster {cluster_id + 1}: {description} — {size} metrics{outlier_flag}")
        for metric, _ in members[:5]:
            lines.append(f"    • {metric}")
        if len(members) > 5:
            lines.append(f"    ... and {len(members) - 5} more")

    return "\n".join(lines)


@mcp.tool()
def natural_language_alert_config(description: str) -> str:
    """
    Converts a plain-English alert description into a structured alert configuration.
    Use this when a user says "Alert me if checkout latency spikes for more than
    5 minutes" or "Warn when memory grows faster than normal".

    Args:
        description: Plain English alert description.
    """
    desc_lower = description.lower()

    # Parse intent signals
    metric_filter = ""
    for word in desc_lower.split():
        if any(kw in word for kw in ["latency", "cpu", "mem", "disk", "error", "request",
                                      "queue", "payment", "checkout", "auth", "db", "cache"]):
            metric_filter = word
            break

    # Duration
    duration_seconds = 300  # default 5 minutes
    if "1 minute" in desc_lower or "1min" in desc_lower:
        duration_seconds = 60
    elif "5 minute" in desc_lower or "5min" in desc_lower:
        duration_seconds = 300
    elif "10 minute" in desc_lower:
        duration_seconds = 600
    elif "30 minute" in desc_lower:
        duration_seconds = 1800
    elif "1 hour" in desc_lower:
        duration_seconds = 3600

    # Condition
    condition = "anomaly_detected"
    slope_multiplier = 1.5
    if any(w in desc_lower for w in ["spike", "sudden", "jump"]):
        condition = "rmse_deviation_3sigma"
    elif any(w in desc_lower for w in ["grow", "increase", "rise", "climb"]):
        condition = "slope_exceeds_baseline"
        slope_multiplier = 1.5
    elif any(w in desc_lower for w in ["drop", "decrease", "fall", "decline"]):
        condition = "slope_below_negative_baseline"
        slope_multiplier = -1.5
    elif any(w in desc_lower for w in ["breach", "exceed", "over", "above"]):
        condition = "value_exceeds_p99"
    elif any(w in desc_lower for w in ["leak", "gradual", "slow"]):
        condition = "sustained_linear_growth"
        slope_multiplier = 1.2

    # Severity
    severity = "warning"
    if any(w in desc_lower for w in ["critical", "page", "urgent", "immediately"]):
        severity = "critical"
    elif any(w in desc_lower for w in ["warn", "watch", "notice"]):
        severity = "warning"

    config = {
        "alert_name": f"auto_{metric_filter or 'metric'}_{condition}",
        "metric_filter": metric_filter or "*",
        "condition": condition,
        "slope_multiplier": slope_multiplier,
        "duration_seconds": duration_seconds,
        "severity": severity,
        "description": description,
        "generated_by": "tsdb.ai natural language alert config",
        "note": "Review thresholds before activating. Adjust metric_filter to match exact metric names."
    }

    import json
    return (
        f"Generated alert config from: \"{description}\"\n\n"
        f"```json\n{json.dumps(config, indent=2)}\n```\n\n"
        f"To activate: POST this config to your alertmanager or register it "
        f"against the /forecast endpoint with a horizon matching the duration."
    )


if __name__ == "__main__":
    print("Starting TSDB.ai MCP Server (v0.7)...")
    print(f"  Ingestor:    {INGESTOR_URL}")
    print(f"  Query GW:    {TSDB_QUERY_URL}")
    print(f"  Vector DB:   {VECTOR_DB_URL}")
    mcp.run(transport='sse')
