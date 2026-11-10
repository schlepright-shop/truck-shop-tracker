#!/usr/bin/env bash
# Nightly JSON export + forever audit CSV for Truck Shop Tracker.
# Defaults:
#   SYNC_URL   -> https://shop-tracker-0snd.onrender.com
#   SYNC_TOKEN -> /workspace/shop-tracker-deploy-sync-token.txt
#   BACKUP_DIR -> /workspace/shop-tracker-backups
# Usage:
#   ./sync/backup_nightly.sh
#   SYNC_URL=http://127.0.0.1:PORT SYNC_TOKEN=secret ./sync/backup_nightly.sh
set -euo pipefail

SYNC_URL="${SYNC_URL:-https://shop-tracker-0snd.onrender.com}"
TOKEN_FILE="${SYNC_TOKEN_FILE:-/workspace/shop-tracker-deploy-sync-token.txt}"
BACKUP_DIR="${BACKUP_DIR:-/workspace/shop-tracker-backups}"
KEEP_DAYS="${BACKUP_KEEP_DAYS:-90}"

if [[ -z "${SYNC_TOKEN:-}" ]]; then
  [[ -f "$TOKEN_FILE" ]] || { echo "missing SYNC_TOKEN and token file $TOKEN_FILE" >&2; exit 1; }
  SYNC_TOKEN="$(tr -d ' \n\r\t' < "$TOKEN_FILE")"
fi
[[ -n "$SYNC_TOKEN" ]] || { echo "empty SYNC_TOKEN" >&2; exit 1; }

mkdir -p "$BACKUP_DIR"

# America/New_York calendar date for the filename
TODAY="$(TZ=America/New_York date +%F)"
OUT_JSON="$BACKUP_DIR/${TODAY}.json"
TMP_JSON="$(mktemp "$BACKUP_DIR/.export.XXXXXX.json")"
CSV="$BACKUP_DIR/audit_all.csv"
TMP_CSV="$(mktemp "$BACKUP_DIR/.audit.XXXXXX.csv")"

cleanup() { rm -f "$TMP_JSON" "$TMP_CSV"; }
trap cleanup EXIT

echo "Fetching export from $SYNC_URL/api/admin/export -> $OUT_JSON"
HTTP_CODE="$(curl -sS -o "$TMP_JSON" -w '%{http_code}' \
  -H "x-sync-token: $SYNC_TOKEN" \
  -H "Accept: application/json" \
  "$SYNC_URL/api/admin/export")"

if [[ "$HTTP_CODE" != "200" ]]; then
  echo "export failed HTTP $HTTP_CODE" >&2
  head -c 500 "$TMP_JSON" >&2 || true
  echo >&2
  exit 1
fi

# Basic sanity: must be JSON with an audit array
python3 - "$TMP_JSON" <<'PY'
import json, sys
path = sys.argv[1]
with open(path) as f:
    data = json.load(f)
if not isinstance(data, dict):
    raise SystemExit("export is not a JSON object")
if "audit" not in data or not isinstance(data["audit"], list):
    raise SystemExit("export missing audit array")
if "cards" not in data or not isinstance(data["cards"], list):
    raise SystemExit("export missing cards array")
# Never keep secrets if a future server mistakenly includes them
for bad in ("sessions", "APP_PASSWORD", "password", "passwords", "SYNC_TOKEN", "SESSION_SECRET"):
    data.pop(bad, None)
with open(path, "w") as f:
    json.dump(data, f, indent=2)
    f.write("\n")
print(f"ok cards={len(data['cards'])} audit={len(data['audit'])} notes={len(data.get('notes') or [])}")
PY

mv -f "$TMP_JSON" "$OUT_JSON"
chmod 600 "$OUT_JSON" || true

# Merge / de-dupe audit into forever CSV by audit id
python3 - "$OUT_JSON" "$CSV" "$TMP_CSV" <<'PY'
import csv, json, sys
from pathlib import Path

export_path, csv_path, tmp_path = sys.argv[1], sys.argv[2], sys.argv[3]
FIELDS = [
    "id", "created_at", "user", "initials", "action", "detail",
    "truck_unit", "station", "schedule_date", "card_id",
]

with open(export_path) as f:
    data = json.load(f)

by_id = {}
csv_file = Path(csv_path)
if csv_file.exists() and csv_file.stat().st_size > 0:
    with csv_file.open(newline="") as f:
        reader = csv.DictReader(f)
        for row in reader:
            rid = (row.get("id") or "").strip()
            if rid:
                by_id[rid] = {k: row.get(k, "") or "" for k in FIELDS}

for a in data.get("audit") or []:
    rid = str(a.get("id") or "").strip()
    if not rid:
        continue
    by_id[rid] = {
        "id": rid,
        "created_at": a.get("created_at") or "",
        "user": a.get("user") or "",
        "initials": a.get("initials") or "",
        "action": a.get("action") or "",
        "detail": a.get("detail") or "",
        "truck_unit": a.get("truck_unit") or "",
        "station": a.get("station") or "",
        "schedule_date": a.get("schedule_date") or "",
        "card_id": a.get("card_id") or "",
    }

rows = sorted(by_id.values(), key=lambda r: (r.get("created_at") or "", r.get("id") or ""), reverse=True)
with open(tmp_path, "w", newline="") as f:
    w = csv.DictWriter(f, fieldnames=FIELDS, extrasaction="ignore")
    w.writeheader()
    w.writerows(rows)
print(f"audit csv rows={len(rows)}")
PY

mv -f "$TMP_CSV" "$CSV"
chmod 600 "$CSV" || true

# Prune daily JSON older than KEEP_DAYS (never delete audit_all.csv)
python3 - "$BACKUP_DIR" "$KEEP_DAYS" <<'PY'
import sys, time
from pathlib import Path
backup = Path(sys.argv[1])
keep_days = int(sys.argv[2])
cutoff = time.time() - keep_days * 86400
removed = 0
for p in sorted(backup.glob("????-??-??.json")):
    try:
        if p.stat().st_mtime < cutoff:
            p.unlink()
            removed += 1
            print(f"pruned {p.name}")
    except OSError as e:
        print(f"prune skip {p.name}: {e}", file=sys.stderr)
print(f"prune removed={removed} keep_days={keep_days}")
PY

echo "Backup complete: $OUT_JSON and $CSV"
