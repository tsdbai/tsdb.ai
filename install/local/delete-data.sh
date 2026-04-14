#!/usr/bin/env bash
# delete-data.sh — Wipe all local TSDB.ai data (testing / pre-commit cleanup)
# Run from the v0.9 directory or anywhere; it locates the data root automatically.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"

# ── colours ───────────────────────────────────────────────────────────────────
RED=$'\033[0;31m'; YELLOW=$'\033[0;33m'; CYAN=$'\033[0;36m'
GREEN=$'\033[0;32m'; BOLD=$'\033[1m'; NC=$'\033[0m'

DATA_DIR="$SRC_DIR/tsdb.ai-data"

# ── header ────────────────────────────────────────────────────────────────────
echo ""
echo -e "${RED}${BOLD}  ╔══════════════════════════════════════════════════╗${NC}"
echo -e "${RED}${BOLD}  ║          ⚠  TSDB.ai DATA WIPE UTILITY  ⚠        ║${NC}"
echo -e "${RED}${BOLD}  ╚══════════════════════════════════════════════════╝${NC}"
echo ""
echo -e "  This will permanently delete the following from:"
echo -e "  ${CYAN}${DATA_DIR}${NC}"
echo ""
echo -e "    ${YELLOW}•${NC} WAL chunks           ${CYAN}(wal/)${NC}"
echo -e "    ${YELLOW}•${NC} Staged blocks        ${CYAN}(blocks/staging/)${NC}"
echo -e "    ${YELLOW}•${NC} Canonical blocks     ${CYAN}(blocks/canonical/)${NC}"
echo -e "    ${YELLOW}•${NC} Checkpoint           ${CYAN}(checkpoint.json)${NC}"
echo -e "    ${YELLOW}•${NC} Pattern registry     ${CYAN}(registry/)${NC}"
echo -e "    ${YELLOW}•${NC} Anomaly events       ${CYAN}(events/anomalies/)${NC}"
echo -e "    ${YELLOW}•${NC} Regime change events ${CYAN}(events/regimes/)${NC}"
echo -e "    ${YELLOW}•${NC} S3 upload manifest   ${CYAN}(index/s3_manifest.json)${NC}"
echo ""

# ── check data dir exists ─────────────────────────────────────────────────────
if [ ! -d "$DATA_DIR" ]; then
  echo -e "  ${GREEN}Nothing to delete — data directory does not exist.${NC}"
  echo -e "  ${CYAN}${DATA_DIR}${NC}"
  echo ""
  exit 0
fi

# ── show current disk usage ───────────────────────────────────────────────────
USAGE=$(du -sh "$DATA_DIR" 2>/dev/null | cut -f1)
echo -e "  Current size: ${YELLOW}${USAGE}${NC}"
echo ""

# ── confirmation prompt ───────────────────────────────────────────────────────
echo -ne "  ${RED}${BOLD}Delete all data? This cannot be undone. [y/N]:${NC} "
read -r CONFIRM

if [[ ! "$CONFIRM" =~ ^[Yy]$ ]]; then
  echo ""
  echo -e "  ${GREEN}Aborted. No data was deleted.${NC}"
  echo ""
  exit 0
fi

echo ""

# ── delete ────────────────────────────────────────────────────────────────────
delete_path() {
  local path="$1"
  local label="$2"
  if [ -e "$path" ]; then
    rm -rf "$path"
    echo -e "  ${RED}✗${NC} Deleted  ${label}"
  else
    echo -e "  ${CYAN}–${NC} Skipped  ${label} (not found)"
  fi
}

delete_path "$DATA_DIR/wal"                         "wal/"
delete_path "$DATA_DIR/blocks/staging"              "blocks/staging/"
delete_path "$DATA_DIR/blocks/canonical"            "blocks/canonical/"
delete_path "$DATA_DIR/checkpoint.json"             "checkpoint.json"
delete_path "$DATA_DIR/registry"                    "registry/"
delete_path "$DATA_DIR/events/anomalies"            "events/anomalies/"
delete_path "$DATA_DIR/events/regimes"              "events/regimes/"
delete_path "$DATA_DIR/index/s3_manifest.json"      "index/s3_manifest.json"

echo ""
echo -e "  ${GREEN}${BOLD}Done.${NC} All TSDB.ai data has been wiped."
echo -e "  The server will start fresh on next launch."
echo ""
