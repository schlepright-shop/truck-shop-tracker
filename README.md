# Truck Shop Tracker

Schlep Right East Windsor shop schedule (Mon–Thu, two-week calendar).

## Stack

- Node.js 22 + Express
- JSON store on a persistent disk (`DATA_DIR`)
- PWA (manifest + service worker caches the shell only; `/api` is always network)

## Required environment variables

| Variable | Purpose |
|----------|---------|
| `APP_PASSWORD` | Shared manager password |
| `APP_USERS` | JSON array of `{username,name,initials,role?,aliases?}` |
| `SESSION_SECRET` | Signs session cookies |
| `SYNC_TOKEN` | Auth for `POST /api/admin/sync-nightly` |
| `DATA_DIR` | Persistent data root (default `./data`; on Render `/var/data`) |
| `PORT` | Listen port (Render sets this) |
| `COOKIE_SECURE` | Set `0` for local HTTP; omit in production (Secure cookies on) |

Values for Render live outside this repo (see the deploy env notes kept with the operator).

## Local run

```bash
npm ci
export APP_PASSWORD=...
export APP_USERS='[...]'
export SESSION_SECRET=dev-session-secret
export SYNC_TOKEN=dev-sync-token
export DATA_DIR=/tmp/shop-tracker-data
export COOKIE_SECURE=0
export PORT=8080
npm start
```

Open http://localhost:8080 — sign in with a first name from `APP_USERS`.

## Render

`render.yaml` defines a starter web service in Ohio with a 1 GB disk at `/var/data`.

- `APP_PASSWORD` / `APP_USERS`: enter in the Dashboard (`sync: false`)
- `SYNC_TOKEN` / `SESSION_SECRET`: auto-generated
- `DATA_DIR=/var/data`, `NODE_VERSION=22`

Nightly Ground Cloud location sync: `POST /api/admin/sync-nightly` with header `x-sync-token: $SYNC_TOKEN` (helper: `sync/push_nightly_http.sh`).

## Health

`GET /healthz` → `ok`
