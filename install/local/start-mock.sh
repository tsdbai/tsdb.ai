#!/usr/bin/env bash
# start-mock.sh — Launch the TSDB.ai mock data source
# Generates synthetic time-series metrics so the UI has something to show.
# Run after start-server.sh is already up: ./start-mock.sh
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$SRC_DIR"

CYAN=$'\033[0;36m'; GREEN=$'\033[0;32m'; YELLOW=$'\033[0;33m'; NC=$'\033[0m'

echo -e "${YELLOW}[mock]${NC} Starting mock data source…"
echo -e "  Pushes synthetic metrics to ${CYAN}http://localhost:8080/ingest_samples${NC}"
echo -e "  Make sure ${GREEN}./install/local/start-server.sh${NC} is running first."
echo ""

go run mock_data_source.go config.go 2>&1 | sed "s/^/  ${YELLOW}[mock]${NC} /"
