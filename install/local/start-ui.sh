#!/usr/bin/env bash
# start-ui.sh — Launch the TSDB.ai React admin panel
#
# Usage:
#   ./install/local/start-ui.sh [--port 3000] [--host localhost] [--backend http://localhost:8080]
#
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
UI_DIR="$SRC_DIR/admin-panel"

CYAN=$'\033[0;36m'; GREEN=$'\033[0;32m'; YELLOW=$'\033[0;33m'; RED=$'\033[0;31m'; NC=$'\033[0m'

# ── Defaults ──────────────────────────────────────────────────────────────────
PORT="${TSDB_UI_PORT:-3000}"
HOST="${TSDB_UI_HOST:-localhost}"
BACKEND="${TSDB_BACKEND_URL:-http://localhost:8080}"

# ── Argument parsing (overrides env vars / defaults) ─────────────────────────
while [[ $# -gt 0 ]]; do
  case $1 in
    --port)    PORT="$2";    shift 2 ;;
    --host)    HOST="$2";    shift 2 ;;
    --backend) BACKEND="$2"; shift 2 ;;
    --help|-h)
      echo "Usage: $0 [options]"
      echo ""
      echo "  --port    PORT   UI dev server port       (default: 3000,             env: TSDB_UI_PORT)"
      echo "  --host    HOST   UI dev server host       (default: localhost,         env: TSDB_UI_HOST)"
      echo "  --backend URL    Backend proxy target     (default: http://localhost:8080, env: TSDB_BACKEND_URL)"
      exit 0 ;;
    *)
      echo -e "${RED}Unknown argument:${NC} $1  (try --help)"
      exit 1 ;;
  esac
done

echo -e "${CYAN}"
echo "  ████████╗███████╗██████╗ ██████╗      █████╗ ██╗"
echo "     ██╔══╝██╔════╝██╔══██╗██╔══██╗    ██╔══██╗██║"
echo "     ██║   ███████╗██║  ██║██████╔╝    ███████║██║"
echo "     ██║   ╚════██║██║  ██║██╔══██╗    ██╔══██║██║"
echo "     ██║   ███████║██████╔╝██████╔╝    ██║  ██║██║"
echo "     ╚═╝   ╚══════╝╚═════╝ ╚═════╝     ╚═╝  ╚═╝╚═╝"
echo -e "${NC}"
echo -e "${GREEN}Launching UI on port ${CYAN}${PORT}${NC}"
echo ""

if [ ! -d "$UI_DIR" ]; then
  echo -e "${RED}Error:${NC} admin-panel directory not found at $UI_DIR"
  exit 1
fi

cd "$UI_DIR"

# ── Install deps if node_modules is missing or stale ──────────────────────────
if [ ! -d "node_modules" ] || [ "package.json" -nt "node_modules/.package-lock.json" ]; then
  echo -e "${YELLOW}[ui]${NC} Installing dependencies…"
  rm -rf node_modules package-lock.json
  npm install --silent
  echo -e "${GREEN}[ui]${NC} Dependencies installed."
fi

echo ""
echo -e "${GREEN}Admin panel starting at${NC}  ${CYAN}http://${HOST}:${PORT}${NC}"
echo -e "  Proxying backend →  ${CYAN}${BACKEND}${NC}"
echo -e "  Press ${RED}Ctrl+C${NC} to stop."
echo ""

VITE_BACKEND_URL="$BACKEND" npm run dev -- --port "$PORT" --host "$HOST"
