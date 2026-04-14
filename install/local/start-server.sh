#!/usr/bin/env bash
# start-server.sh — Launch the TSDB.ai core server + query gateway
# Run this from the v0.9 directory: ./start-server.sh
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$SRC_DIR"

# ── colour helpers ────────────────────────────────────────────────────────────
CYAN=$'\033[0;36m'; GREEN=$'\033[0;32m'; YELLOW=$'\033[0;33m'; RED=$'\033[0;31m'; NC=$'\033[0m'

echo -e "${CYAN}"
echo "  ████████╗███████╗██████╗ ██████╗      █████╗ ██╗"
echo "     ██╔══╝██╔════╝██╔══██╗██╔══██╗    ██╔══██╗██║"
echo "     ██║   ███████╗██║  ██║██████╔╝    ███████║██║"
echo "     ██║   ╚════██║██║  ██║██╔══██╗    ██╔══██║██║"
echo "     ██║   ███████║██████╔╝██████╔╝    ██║  ██║██║"
echo "     ╚═╝   ╚══════╝╚═════╝ ╚═════╝     ╚═╝  ╚═╝╚═╝"
echo -e "${NC}"
echo -e "${GREEN}Starting TSDB.ai Server Components${NC}"
echo ""

# ── pid tracking ──────────────────────────────────────────────────────────────
CORE_PID=""
QUERY_PID=""

cleanup() {
  echo ""
  echo -e "${YELLOW}Shutting down…${NC}"
  [ -n "$CORE_PID"  ] && kill "$CORE_PID"  2>/dev/null && echo "  Core server stopped."
  [ -n "$QUERY_PID" ] && kill "$QUERY_PID" 2>/dev/null && echo "  Query gateway stopped."
  exit 0
}
trap cleanup SIGINT SIGTERM

# ── Core server (ingestor + AI endpoints + UI state) ─────────────────────────
echo -e "${CYAN}[1/2]${NC} Starting core server on :8080 …"
go run \
  main.go \
  config.go \
  banner.go \
  cors.go \
  alerts.go \
  forecasting.go \
  causal_engine.go \
  model_compressor.go \
  pattern_registry.go \
  local_cleaner.go \
  relationship_graph.go \
  vector_store.go \
  s3_client.go \
  s3_manifest.go \
  ui_state_handler.go \
  license.go \
  2>&1 | sed "s/^/  ${CYAN}[core]${NC} /" &
CORE_PID=$!

# Give the core server a moment to bind its port
sleep 2

# ── Query gateway ─────────────────────────────────────────────────────────────
echo -e "${CYAN}[2/2]${NC} Starting query gateway on :8081 …"
go run \
  query_gateway.go \
  config.go \
  banner.go \
  cors.go \
  model_compressor.go \
  vector_store.go \
  s3_client.go \
  s3_manifest.go \
  2>&1 | sed "s/^/  ${YELLOW}[query]${NC} /" &
QUERY_PID=$!

echo ""
echo -e "${GREEN}Both services running.${NC}"
echo -e "  Core server  → ${CYAN}http://localhost:8080${NC}"
echo -e "  Query gateway→ ${CYAN}http://localhost:8081${NC}"
echo ""
echo -e "  Open the UI  → ${CYAN}http://localhost:3000${NC}  (run ./install/local/start-ui.sh)"
echo -e "  Mock data    → run ${YELLOW}./install/local/start-mock.sh${NC} in another terminal"
echo ""
echo -e "  Press ${RED}Ctrl+C${NC} to stop all services."
echo ""

# ── Wait for either process to exit ──────────────────────────────────────────
wait
