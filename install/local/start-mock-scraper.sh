#!/usr/bin/env bash
# start-mock-scraper.sh — Scrape the mock data source (:9101) and push to the ingestor (:8080)
#
# Run this after both start-server.sh and start-mock.sh are up:
#   Terminal 1: ./install/local/start-server.sh
#   Terminal 2: ./install/local/start-mock.sh
#   Terminal 3: ./install/local/start-mock-scraper.sh
set -e

CYAN=$'\033[0;36m'; GREEN=$'\033[0;32m'; YELLOW=$'\033[0;33m'; RED=$'\033[0;31m'; NC=$'\033[0m'

# ── Defaults (override via env vars or flags) ──────────────────────────────────
TARGET="${TSDB_MOCK_TARGET:-http://localhost:9101/metrics}"
INGEST="${TSDB_INGEST_URL:-http://localhost:8080/ingest_samples}"
INTERVAL="${TSDB_SCRAPE_INTERVAL:-15}"

while [[ $# -gt 0 ]]; do
  case $1 in
    --target)   TARGET="$2";   shift 2 ;;
    --ingest)   INGEST="$2";   shift 2 ;;
    --interval) INTERVAL="$2"; shift 2 ;;
    --help|-h)
      echo "Usage: $0 [options]"
      echo ""
      echo "  --target   URL   Prometheus /metrics endpoint to scrape (default: http://localhost:9101/metrics)"
      echo "  --ingest   URL   Ingestor push endpoint               (default: http://localhost:8080/ingest_samples)"
      echo "  --interval N     Scrape interval in seconds           (default: 15)"
      exit 0 ;;
    *)
      echo -e "${RED}Unknown argument:${NC} $1  (try --help)"
      exit 1 ;;
  esac
done

echo -e "${YELLOW}[mock-scraper]${NC} Scraping mock data source and pushing to ingestor"
echo -e "  Target  → ${CYAN}${TARGET}${NC}"
echo -e "  Ingest  → ${CYAN}${INGEST}${NC}"
echo -e "  Interval→ ${GREEN}${INTERVAL}s${NC}"
echo -e "  Press ${RED}Ctrl+C${NC} to stop."
echo ""

# ── Python scrape-and-push loop ────────────────────────────────────────────────
python3 - "$TARGET" "$INGEST" "$INTERVAL" <<'PYEOF'
import sys, time, json, re, urllib.request, urllib.error

target   = sys.argv[1]
ingest   = sys.argv[2]
interval = int(sys.argv[3])

# Matches: metric_name{labels} value  OR  metric_name value
RE = re.compile(r'^([a-zA-Z_:][a-zA-Z0-9_:{}\[\]=,"./\-\s]*?)\s+([0-9eE+\-.]+)(?:\s+\d+)?$')

def scrape(url):
    try:
        with urllib.request.urlopen(url, timeout=10) as r:
            return r.read().decode("utf-8")
    except Exception as e:
        print(f"  [mock-scraper] SCRAPE ERROR: {e}", flush=True)
        return None

def push(samples, url):
    try:
        body = json.dumps(samples).encode("utf-8")
        req  = urllib.request.Request(url, data=body,
                 headers={"Content-Type": "application/json"}, method="POST")
        with urllib.request.urlopen(req, timeout=10) as r:
            return r.status
    except Exception as e:
        print(f"  [mock-scraper] PUSH ERROR: {e}", flush=True)
        return None

cycle = 0
while True:
    raw = scrape(target)
    if raw:
        now     = time.time()
        samples = []
        for line in raw.splitlines():
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            m = RE.match(line)
            if m:
                try:
                    samples.append({
                        "metric_string": m.group(1).strip(),
                        "value":         float(m.group(2)),
                        "timestamp":     now,
                    })
                except ValueError:
                    pass

        if samples:
            status = push(samples, ingest)
            cycle += 1
            ok = "✓" if status == 200 else f"✗ {status}"
            print(f"  [mock-scraper] cycle {cycle:4d} — {len(samples)} samples → {ok}", flush=True)
        else:
            print(f"  [mock-scraper] no samples parsed from {target}", flush=True)

    time.sleep(interval)
PYEOF
