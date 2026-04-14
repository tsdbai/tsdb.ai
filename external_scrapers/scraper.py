# tsdb.ai External Scraper — Python implementation
#
# NOTE: The Go binary (scraper_external.go) is the canonical production
# implementation. This Python version is provided as an alternative for
# environments where deploying a Go binary is not practical.
# All fixes applied here should be kept in sync with the Go version.

import argparse
import json
import os
import re
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import urlparse

import requests

# ---------------------------------------------------------------------------
# Configuration defaults
# ---------------------------------------------------------------------------
DEFAULT_INGEST_ENDPOINT  = "http://localhost:8080/ingest_samples"
DEFAULT_SCRAPE_INTERVAL  = 30
DEFAULT_SCRAPE_TIMEOUT   = 15
DEFAULT_JOB_LABEL        = "external"
MAX_BUFFER_SIZE_BYTES    = 50 * 1024 * 1024   # 50 MB
MAX_SCRAPE_BODY_BYTES    = 10 * 1024 * 1024   # 10 MB per response

# ---------------------------------------------------------------------------
# Regex — compiled once at module load, not per scrape call
# ---------------------------------------------------------------------------
RE_METRIC = re.compile(
    r'^([a-zA-Z_:][a-zA-Z0-9_:{}=,"/\.\-\[\]\s]+)\s+([0-9\.eE\+\-]+)'
)

# ---------------------------------------------------------------------------
# Global state
# ---------------------------------------------------------------------------
ingest_endpoint = DEFAULT_INGEST_ENDPOINT
job_label       = DEFAULT_JOB_LABEL

retry_buffer       = []
buffer_lock        = threading.Lock()
current_buffer_size = 0

# Self-monitoring counters (protected by their own lock for simplicity)
_stats_lock    = threading.Lock()
stat_scraped   = 0
stat_sent      = 0
stat_dropped   = 0
stat_scrape_err = 0
stat_ingest_err = 0


def _inc(name, n=1):
    global stat_scraped, stat_sent, stat_dropped, stat_scrape_err, stat_ingest_err
    with _stats_lock:
        if   name == "scraped":    stat_scraped    += n
        elif name == "sent":       stat_sent       += n
        elif name == "dropped":    stat_dropped    += n
        elif name == "scrape_err": stat_scrape_err += n
        elif name == "ingest_err": stat_ingest_err += n


def _stats():
    with _stats_lock:
        return dict(
            scraped=stat_scraped, sent=stat_sent, dropped=stat_dropped,
            scrape_err=stat_scrape_err, ingest_err=stat_ingest_err,
        )


# ---------------------------------------------------------------------------
# Label injection
# ---------------------------------------------------------------------------

def inject_labels(metric_str, instance, job):
    """Stamp instance= and job= onto a Prometheus metric string.

    Without this, samples from different targets that expose the same metric
    name would collide inside the TSDB.

    "http_requests_total{method=\"GET\"}"  →
        "http_requests_total{instance=\"h:p\",job=\"j\",method=\"GET\"}"
    "go_gc_duration_seconds"               →
        "go_gc_duration_seconds{instance=\"h:p\",job=\"j\"}"
    """
    injected = f'instance="{instance}",job="{job}"'
    idx = metric_str.rfind("}")
    if idx != -1:
        prefix = metric_str[:idx].rstrip(", ")
        return f"{prefix},{injected}}}"
    return f"{metric_str.strip()}{{{injected}}}"


def instance_from_url(raw_url):
    """Return 'host:port' from a URL, filling in the scheme default if absent."""
    try:
        parsed = urlparse(raw_url)
        host = parsed.hostname or ""
        port = parsed.port
        if not port:
            port = 443 if parsed.scheme == "https" else 80
        return f"{host}:{port}"
    except Exception:
        return raw_url


# ---------------------------------------------------------------------------
# Prometheus text-format parser
# ---------------------------------------------------------------------------

def parse_prometheus_metrics(data, instance, job):
    """Parse Prometheus exposition format and inject instance/job labels."""
    lines   = data.decode("utf-8", errors="replace").split("\n")
    samples = []
    now     = time.time()

    for line in lines:
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        m = RE_METRIC.match(line)
        if not m:
            continue
        try:
            value = float(m.group(2))
        except ValueError:
            continue
        samples.append({
            "metric_string": inject_labels(m.group(1).strip(), instance, job),
            "value":         value,
            "timestamp":     now,
        })
    return samples


# ---------------------------------------------------------------------------
# Ingestor communication
# ---------------------------------------------------------------------------

def send_batch(samples):
    """POST a batch of samples to the ingestor. Raises on failure."""
    response = None
    try:
        response = requests.post(
            ingest_endpoint,
            data=json.dumps(samples),
            headers={"Content-Type": "application/json"},
            timeout=5,
        )
        if response.status_code != 200:
            raise Exception(f"non-200 status: {response.status_code}")
    except requests.exceptions.RequestException as e:
        raise Exception(str(e)) from e


def add_to_buffer(samples):
    """Append to retry buffer. Must be called with buffer_lock held."""
    global current_buffer_size
    sz = len(json.dumps(samples).encode())
    if sz == 0:
        sz = len(samples) * 512
    if current_buffer_size + sz > MAX_BUFFER_SIZE_BYTES:
        ts = time.strftime("%H:%M:%S")
        print(f"[{ts}] CRITICAL: buffer full — dropping {len(samples)} samples.")
        _inc("dropped", len(samples))
        return
    retry_buffer.extend(samples)
    current_buffer_size += sz


def push_metrics_to_ingestor(samples):
    """Deliver samples to the ingestor, buffering on failure.

    Network calls are made outside the buffer lock to avoid blocking
    concurrent scrape goroutines.
    """
    global retry_buffer, current_buffer_size

    if not samples:
        return

    # Snapshot the backlog without holding the lock during the network call.
    with buffer_lock:
        pending = list(retry_buffer) if retry_buffer else []

    if pending:
        ts = time.strftime("%H:%M:%S")
        print(f"[{ts}] RECOVERY: flushing {len(pending)} buffered samples...")
        try:
            send_batch(pending)
            print(f"[{time.strftime('%H:%M:%S')}] RECOVERY: buffer flushed.")
            with buffer_lock:
                retry_buffer.clear()
                current_buffer_size = 0
            _inc("sent", len(pending))
        except Exception as e:
            print(f"[{time.strftime('%H:%M:%S')}] RECOVERY FAILED: {e} — buffering new samples.")
            _inc("ingest_err")
            with buffer_lock:
                add_to_buffer(samples)
            return

    try:
        send_batch(samples)
        _inc("sent", len(samples))
        print(f"[{time.strftime('%H:%M:%S')}] Pushed {len(samples)} samples.")
    except Exception as e:
        print(f"[{time.strftime('%H:%M:%S')}] PUSH ERROR: {e} — buffering {len(samples)} samples.")
        _inc("ingest_err")
        with buffer_lock:
            add_to_buffer(samples)


# ---------------------------------------------------------------------------
# Scrape worker
# ---------------------------------------------------------------------------

def scrape_target(target_url):
    instance  = instance_from_url(target_url)
    start     = time.time()
    try:
        response = requests.get(
            target_url,
            timeout=_scrape_timeout,
            headers={"Accept": "text/plain;version=0.0.4,*/*"},
            stream=True,
        )
        response.raise_for_status()
        # Read with a size cap to prevent OOM from bad endpoints.
        content = response.raw.read(MAX_SCRAPE_BODY_BYTES)

        samples  = parse_prometheus_metrics(content, instance, job_label)
        duration = time.time() - start
        _inc("scraped", len(samples))
        print(f"[{time.strftime('%H:%M:%S')}] Scraped {target_url} in {duration:.3f}s — {len(samples)} samples")
        push_metrics_to_ingestor(samples)

    except Exception as e:
        print(f"[{time.strftime('%H:%M:%S')}] SCRAPE FAIL {target_url}: {e}")
        _inc("scrape_err")


# ---------------------------------------------------------------------------
# Self-monitoring HTTP server
# ---------------------------------------------------------------------------

def _make_health_handler():
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass  # suppress access log noise

        def do_GET(self):
            if self.path == "/health":
                body = json.dumps({"status": "ok", "ingest_endpoint": ingest_endpoint}).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(body)

            elif self.path == "/metrics":
                s = _stats()
                with buffer_lock:
                    buf_len   = len(retry_buffer)
                    buf_bytes = current_buffer_size

                lines = []
                for name, help_text, val in [
                    ("scraper_samples_scraped_total",  "Total samples parsed from all targets",             s["scraped"]),
                    ("scraper_samples_sent_total",     "Samples successfully delivered to ingestor",        s["sent"]),
                    ("scraper_samples_dropped_total",  "Samples dropped because retry buffer was full",     s["dropped"]),
                    ("scraper_scrape_errors_total",    "Scrape attempts that failed",                       s["scrape_err"]),
                    ("scraper_ingest_errors_total",    "Ingestor push attempts that failed",                s["ingest_err"]),
                ]:
                    lines += [f"# HELP {name} {help_text}", f"# TYPE {name} counter", f"{name} {val}", ""]
                lines += [
                    "# HELP scraper_buffer_samples Samples in the retry buffer",
                    "# TYPE scraper_buffer_samples gauge",
                    f"scraper_buffer_samples {buf_len}", "",
                    "# HELP scraper_buffer_bytes Serialised bytes in the retry buffer",
                    "# TYPE scraper_buffer_bytes gauge",
                    f"scraper_buffer_bytes {buf_bytes}",
                ]
                body = "\n".join(lines).encode()
                self.send_response(200)
                self.send_header("Content-Type", "text/plain; version=0.0.4")
                self.end_headers()
                self.wfile.write(body)
            else:
                self.send_response(404)
                self.end_headers()
    return Handler


def start_health_server(port):
    handler = _make_health_handler()
    server  = HTTPServer(("", port), handler)
    t = threading.Thread(target=server.serve_forever, daemon=True)
    t.start()
    print(f"[{time.strftime('%H:%M:%S')}] Self-monitoring → http://localhost:{port}/health  |  http://localhost:{port}/metrics")


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

_scrape_timeout = DEFAULT_SCRAPE_TIMEOUT  # set in main(), read by workers


def main():
    global ingest_endpoint, job_label, _scrape_timeout

    parser = argparse.ArgumentParser(description="tsdb.ai External Scraper (Python)")
    parser.add_argument("--scrape-urls",             help="Comma-separated Prometheus /metrics endpoints")
    parser.add_argument("--scrape-interval-seconds", type=int, default=0)
    parser.add_argument("--scrape-timeout-seconds",  type=int, default=0)
    parser.add_argument("--ingest-endpoint",         help="tsdb.ai ingestor URL")
    parser.add_argument("--job-label",               help='Value for job= label (default "external")')
    parser.add_argument("--health-port",             type=int, default=0,
                        help="Port for /health and /metrics (0 = disabled)")
    args = parser.parse_args()

    # ingest endpoint (env → flag)
    ingest_endpoint = os.environ.get("INGEST_ENDPOINT", DEFAULT_INGEST_ENDPOINT)
    if args.ingest_endpoint:
        ingest_endpoint = args.ingest_endpoint
    if not ingest_endpoint:
        print("Error: ingest endpoint required (--ingest-endpoint or INGEST_ENDPOINT)", file=sys.stderr)
        sys.exit(1)

    # job label (env → flag → default)
    job_label = os.environ.get("JOB_LABEL", DEFAULT_JOB_LABEL)
    if args.job_label:
        job_label = args.job_label

    # targets (env → flag)
    targets = []
    for src in [os.environ.get("SCRAPE_URLS", ""), args.scrape_urls or ""]:
        for u in src.split(","):
            u = u.strip()
            if u:
                targets.append(u)
    if not targets:
        print("Error: no scrape targets (--scrape-urls or SCRAPE_URLS)", file=sys.stderr)
        sys.exit(1)

    # interval
    interval = int(os.environ.get("SCRAPE_INTERVAL_SECONDS", DEFAULT_SCRAPE_INTERVAL))
    if args.scrape_interval_seconds > 0:
        interval = args.scrape_interval_seconds
    if interval < 15:
        print(f"Warning: interval {interval}s < 15s minimum; using 15s.")
        interval = 15

    # timeout
    _scrape_timeout = int(os.environ.get("SCRAPE_TIMEOUT_SECONDS", DEFAULT_SCRAPE_TIMEOUT))
    if args.scrape_timeout_seconds > 0:
        _scrape_timeout = args.scrape_timeout_seconds
    if _scrape_timeout >= interval:
        _scrape_timeout = interval - 1
        print(f"Warning: timeout must be < interval; capped to {_scrape_timeout}s.")

    # health server
    health_port = int(os.environ.get("HEALTH_PORT", 0))
    if args.health_port > 0:
        health_port = args.health_port
    if health_port > 0:
        start_health_server(health_port)

    print("--- tsdb.ai External Scraper (Python) ---")
    print(f"Ingestor  : {ingest_endpoint}")
    print(f"Targets   : {targets}")
    print(f"Job label : {job_label}")
    print(f"Interval  : {interval}s  Timeout: {_scrape_timeout}s")

    # Persistent thread pool — created once, not per interval tick.
    executor = ThreadPoolExecutor(max_workers=max(len(targets), 1))

    def run_round():
        for target in targets:
            executor.submit(scrape_target, target)

    run_round()  # immediate first scrape
    while True:
        time.sleep(interval)
        run_round()


if __name__ == "__main__":
    main()
