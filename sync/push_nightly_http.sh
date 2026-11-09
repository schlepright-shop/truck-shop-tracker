#!/usr/bin/env bash
# Push newest Ground Cloud nightly CSVs to the live Shop Tracker.
# Usage:
#   SYNC_URL=https://YOUR-SERVICE.onrender.com SYNC_TOKEN=secret ./sync/push_nightly_http.sh
set -euo pipefail
NIGHTLY_ROOT="${GC_NIGHTLY_DIR:-/workspace/groundcloud/nightly}"
SYNC_URL="${SYNC_URL:?set SYNC_URL to the live app origin}"
SYNC_TOKEN="${SYNC_TOKEN:?set SYNC_TOKEN}"
night="$(ls -1 "$NIGHTLY_ROOT" | sort | tail -1)"
dir="$NIGHTLY_ROOT/$night"
map="$dir/map_observations.csv"
dev="$dir/devices.csv"
[[ -f "$map" ]] || { echo "missing $map"; exit 1; }
body=$(python3 - <<PY
import json, pathlib
night="$night"
map_csv=pathlib.Path("$map").read_text()
dev=pathlib.Path("$dev")
payload={"night": night, "map_observations_csv": map_csv}
if dev.exists():
    payload["devices_csv"]=dev.read_text()
print(json.dumps(payload))
PY
)
curl -sS -X POST "$SYNC_URL/api/admin/sync-nightly" \
  -H "Content-Type: application/json" \
  -H "x-sync-token: $SYNC_TOKEN" \
  -d "$body"
echo
