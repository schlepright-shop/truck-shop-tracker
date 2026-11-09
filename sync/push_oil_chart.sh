#!/usr/bin/env bash
# Push the newest MTC oil-change forecast CSV to the live Shop Tracker
# (private view for OIL_CHART_USERS, default lloyd,dan).
# Defaults:
#   OIL_CHART_DIR -> /workspace/mtc-mileage/oil-charts   (files named YYYY-MM-DD.csv = MTC data date)
#   SYNC_URL      -> https://shop-tracker-0snd.onrender.com
#   SYNC_TOKEN    -> contents of /workspace/shop-tracker-deploy-sync-token.txt
# Usage:
#   ./sync/push_oil_chart.sh                 # newest CSV
#   ./sync/push_oil_chart.sh path/to/2026-11-10.csv
set -euo pipefail
CHART_DIR="${OIL_CHART_DIR:-/workspace/mtc-mileage/oil-charts}"
SYNC_URL="${SYNC_URL:-https://shop-tracker-0snd.onrender.com}"
TOKEN_FILE="${SYNC_TOKEN_FILE:-/workspace/shop-tracker-deploy-sync-token.txt}"
if [[ -z "${SYNC_TOKEN:-}" ]]; then
  [[ -f "$TOKEN_FILE" ]] || { echo "missing SYNC_TOKEN and token file $TOKEN_FILE"; exit 1; }
  SYNC_TOKEN="$(tr -d ' \n\r\t' < "$TOKEN_FILE")"
fi
[[ -n "$SYNC_TOKEN" ]] || { echo "empty SYNC_TOKEN"; exit 1; }
if [[ $# -ge 1 ]]; then csv="$1"; else
  csv="$(ls -1 "$CHART_DIR"/[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9].csv 2>/dev/null | sort | tail -1 || true)"
fi
[[ -n "$csv" && -f "$csv" ]] || { echo "no YYYY-MM-DD.csv found in $CHART_DIR"; exit 1; }
body_file="$(mktemp)"; trap 'rm -f "$body_file"' EXIT
python3 - "$csv" > "$body_file" <<'PY'
import csv, json, os, re, sys, datetime
path = sys.argv[1]
name = os.path.basename(path)
m = re.match(r'^(\d{4}-\d{2}-\d{2})\.csv$', name)
if not m: sys.exit(f"bad filename {name}; expected YYYY-MM-DD.csv")
need = ["truck","station","oil_life_used_pct","miles_left","avg_daily_miles","days_left","projected_due","note"]
with open(path, newline='', encoding='utf-8-sig') as f:
    r = csv.DictReader(f)
    missing = [c for c in need if c not in (r.fieldnames or [])]
    if missing: sys.exit(f"CSV missing columns: {missing}")
    rows = [{k: (row.get(k) or '').strip() for k in need} for row in r if (row.get('truck') or '').strip()]
if not rows: sys.exit("CSV has no rows")
def num(v):
    try: return float(v.replace(',', '')) if v != '' else None
    except ValueError: return None
for row in rows:
    for k in ("oil_life_used_pct","miles_left","avg_daily_miles","days_left"):
        row[k] = num(row[k])
    if not re.match(r'^\d{4}-\d{2}-\d{2}$', row["projected_due"]): row["projected_due"] = None
gen = datetime.datetime.fromtimestamp(os.path.getmtime(path), datetime.timezone.utc).isoformat(timespec='seconds')
print(json.dumps({"data_date": m.group(1), "generated_at": gen, "interval_miles": 5000,
                  "source": f"MTC Mileage Updater ({name})", "rows": rows}))
PY
echo "Pushing oil chart $(basename "$csv") -> $SYNC_URL/api/admin/oil-chart"
curl -sS --fail-with-body -X POST "$SYNC_URL/api/admin/oil-chart" \
  -H "Content-Type: application/json" \
  -H "x-sync-token: $SYNC_TOKEN" \
  --data-binary @"$body_file"
echo
