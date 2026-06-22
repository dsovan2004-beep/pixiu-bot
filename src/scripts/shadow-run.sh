#!/bin/bash
# shadow-run.sh <collect|paper-sim|report>
# Runs a forward-shadow harness script. SHADOW-ONLY: no SOL, no broadcast,
# no bot_state/tracked_wallets writes (only stacked_filter_shadow).
# Logs to logs/shadow-<mode>.log. Single-instance lock per mode (no overlap).
set -u
MODE="${1:?usage: shadow-run.sh collect|paper-sim|report}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT" || exit 1
export PATH="/usr/local/bin:/opt/homebrew/bin:$PATH"
mkdir -p logs
LOG="logs/shadow-$MODE.log"
LOCK="logs/.lock-$MODE"

case "$MODE" in
  collect)   SCRIPT="src/scripts/shadow-collect.ts" ;;
  paper-sim) SCRIPT="src/scripts/shadow-paper-sim.ts" ;;
  report)    SCRIPT="src/scripts/shadow-report.ts" ;;
  *) echo "bad mode: $MODE" >&2; exit 2 ;;
esac

# atomic lock — skip if a previous run is still going
if ! mkdir "$LOCK" 2>/dev/null; then
  echo "$(date -u +%FT%TZ) [$MODE] skipped (locked)" >> "$LOG"
  exit 0
fi
trap 'rmdir "$LOCK" 2>/dev/null' EXIT

echo "=== $(date -u +%FT%TZ) [$MODE] start ===" >> "$LOG"
npx tsx "$SCRIPT" >> "$LOG" 2>&1
RC=$?
echo "=== $(date -u +%FT%TZ) [$MODE] end (exit $RC) ===" >> "$LOG"
# keep log bounded (last ~2000 lines)
tail -n 2000 "$LOG" > "$LOG.tmp" 2>/dev/null && mv "$LOG.tmp" "$LOG"
exit $RC
