'use strict';
/**
 * Truck Shop Tracker — production Node server (Render).
 * Derived from the verified Mac/box preview (node_server_preview.js).
 */
const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { parse } = require('csv-parse/sync');

const ROOT = path.resolve(__dirname);
const PUBLIC = path.join(ROOT, 'public');
const SEED_DATA = path.join(ROOT, 'data');
const DATA = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(ROOT, 'data');
const NIGHTLY = path.join(DATA, 'nightly');
const STORE = path.join(DATA, 'store.json');
const PORT = Number(process.env.PORT || 8080);

const APP_PASSWORD = process.env.APP_PASSWORD || '';
const SYNC_TOKEN = process.env.SYNC_TOKEN || '';
const SESSION_SECRET = process.env.SESSION_SECRET || '';
const COOKIE_SECURE = String(process.env.COOKIE_SECURE || (process.env.NODE_ENV === 'production' ? '1' : '0')) !== '0';

if (!APP_PASSWORD) {
  console.error('APP_PASSWORD env var is required');
  process.exit(1);
}
if (!SESSION_SECRET) {
  console.error('SESSION_SECRET env var is required');
  process.exit(1);
}

function loadUsersFromEnv() {
  const raw = process.env.APP_USERS || '';
  if (!raw.trim()) {
    console.error('APP_USERS env var is required (JSON array of users)');
    process.exit(1);
  }
  let parsed;
  try { parsed = JSON.parse(raw); }
  catch (e) {
    console.error('APP_USERS must be valid JSON:', e.message);
    process.exit(1);
  }
  if (!Array.isArray(parsed) || !parsed.length) {
    console.error('APP_USERS must be a non-empty JSON array');
    process.exit(1);
  }
  return parsed.map(m => ({
    username: String(m.username || '').toLowerCase(),
    name: String(m.name || m.username || ''),
    initials: String(m.initials || ''),
    role: m.role || 'manager',
    aliases: (m.aliases || []).map(a => String(a).toLowerCase()),
  })).filter(u => u.username && u.initials);
}

const USERS = loadUsersFromEnv();

// Private oil-change forecast: only these usernames may read it (server-enforced).
const OIL_CHART_USERS = String(process.env.OIL_CHART_USERS || 'lloyd,dan')
  .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
// Only these users may create/move/remove schedule cards. Others may still change stage + notes.
const SCHEDULE_USERS = String(process.env.SCHEDULE_USERS || 'lloyd,dan')
  .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
const OIL_DIR = path.join(DATA, 'oil-chart');
const OIL_LATEST = path.join(OIL_DIR, 'latest.json');
const OIL_HISTORY = path.join(OIL_DIR, 'history');

if (!fs.existsSync(DATA)) fs.mkdirSync(DATA, { recursive: true });
if (!fs.existsSync(NIGHTLY)) fs.mkdirSync(NIGHTLY, { recursive: true });
if (!fs.existsSync(OIL_HISTORY)) fs.mkdirSync(OIL_HISTORY, { recursive: true });

// Seed static truck list into DATA_DIR once (never overwrite runtime edits).
for (const f of ['trucks.json']) {
  const dest = path.join(DATA, f);
  const src = path.join(SEED_DATA, f);
  if (!fs.existsSync(dest) && fs.existsSync(src)) fs.copyFileSync(src, dest);
}

const COOKIE = 'st_session';
const STAGES = ['Scheduled', 'Dropped off', 'Completed', 'Picked up'];

function findUser(login) {
  const key = String(login || '').trim().toLowerCase();
  return USERS.find(u => u.username === key || u.aliases.includes(key)) || null;
}

/** Resolve allowlist entries through aliases (e.g. daniel → dan). */
function allowlistUsernames(list) {
  const out = new Set();
  for (const raw of list) {
    const u = findUser(raw);
    out.add(u ? u.username : String(raw || '').toLowerCase());
  }
  return out;
}
const OIL_CHART_USERNAMES = allowlistUsernames(OIL_CHART_USERS);
const SCHEDULE_USERNAMES = allowlistUsernames(SCHEDULE_USERS);
function canSeeOilChart(u) { return !!u && OIL_CHART_USERNAMES.has(u.username); }
function canSchedule(u) { return !!u && SCHEDULE_USERNAMES.has(u.username); }
function scheduleForbidden(res) {
  res.status(403).json({ detail: 'Only Lloyd and Dan can schedule trucks.' });
  return null;
}
function userPayload(u) {
  return {
    username: u.username,
    name: u.name,
    initials: u.initials,
    role: u.role,
    features: { oil_chart: canSeeOilChart(u), can_schedule: canSchedule(u) },
  };
}

const trucksFile = JSON.parse(fs.readFileSync(path.join(DATA, 'trucks.json'), 'utf8'));
const trucks = [
  ...trucksFile.trucks.map(t => ({ unit: t.unit, station: t.station })),
  ...((trucksFile.unmapped || []).filter(u => u.location === 'NOS').map(u => ({ unit: u.unit, station: 'NOS' }))),
];

function loadStore() {
  let s;
  try { s = JSON.parse(fs.readFileSync(STORE, 'utf8')); }
  catch { s = { sessions: {}, cards: [], audit: [], notes: [] }; }
  if (!Array.isArray(s.cards)) s.cards = [];
  if (!Array.isArray(s.audit)) s.audit = [];
  if (!Array.isArray(s.notes)) s.notes = [];
  if (!s.sessions || typeof s.sessions !== 'object') s.sessions = {};
  // Backfill truck_unit / schedule_date / station onto older audit rows while the card still exists.
  // Audit entries are never deleted.
  let dirty = false;
  const byId = new Map(s.cards.map(c => [c.id, c]));
  for (const a of s.audit) {
    if (a.truck_unit && a.schedule_date && a.station) continue;
    const card = byId.get(a.card_id);
    if (!card) continue;
    if (!a.truck_unit) { a.truck_unit = card.truck_unit; dirty = true; }
    if (!a.schedule_date) { a.schedule_date = card.schedule_date; dirty = true; }
    if (!a.station) { a.station = card.station; dirty = true; }
  }
  if (dirty) saveStore(s);
  return s;
}
function saveStore(s) { fs.writeFileSync(STORE, JSON.stringify(s, null, 2)); }
function utcnow() { return new Date().toISOString().replace(/\.\d{3}Z$/, '+00:00'); }
function id() { return crypto.randomUUID(); }
function makeAudit(u, card, action, detail, extra) {
  const entry = {
    id: id(),
    card_id: card.id,
    truck_unit: card.truck_unit,
    station: card.station || null,
    schedule_date: card.schedule_date,
    user: u.username,
    initials: u.initials,
    action,
    detail: detail || '',
    created_at: utcnow(),
  };
  if (extra && typeof extra === 'object') Object.assign(entry, extra);
  return entry;
}
/** America/New_York calendar date YYYY-MM-DD for an ISO timestamp. */
function etYmd(iso) {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date(iso));
  } catch {
    return String(iso || '').slice(0, 10);
  }
}
function mondayOf(d) {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const day = (x.getDay() + 6) % 7;
  x.setDate(x.getDate() - day);
  return x;
}
function ymd(d) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
function parseYmd(s) {
  const [y,m,dd] = s.split('-').map(Number);
  return new Date(y, m-1, dd);
}
function isShopDay(d) { return ((d.getDay()+6)%7) < 4; }

function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie || '';
  raw.split(';').forEach(p => {
    const i = p.indexOf('=');
    if (i > -1) out[p.slice(0,i).trim()] = decodeURIComponent(p.slice(i+1).trim());
  });
  return out;
}
function cookieFlags() {
  return `Path=/; HttpOnly; SameSite=Lax; Max-Age=${30*24*3600}${COOKIE_SECURE ? '; Secure' : ''}`;
}
function setCookie(res, token) {
  res.setHeader('Set-Cookie', `${COOKIE}=${token}; ${cookieFlags()}`);
}
function clearCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${COOKIE_SECURE ? '; Secure' : ''}`);
}
function makeSessionToken() {
  const raw = crypto.randomBytes(32).toString('base64url');
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(raw).digest('base64url');
  return `${raw}.${sig}`;
}
function authUser(req) {
  const cookies = parseCookies(req);
  const token = cookies[COOKIE];
  if (!token) return null;
  const store = loadStore();
  const sess = store.sessions[token];
  if (!sess) return null;
  if (new Date(sess.expires_at) < new Date()) return null;
  return findUser(sess.username);
}

function requireAuth(req, res) {
  const u = authUser(req);
  if (!u) { res.status(401).json({ detail: 'Sign in required' }); return null; }
  return u;
}

function displayLot(lot) {
  if (!lot) return null;
  const low = lot.toLowerCase();
  if (low.includes('east windsor shop-area') || low.includes('south main') || low.includes('227 south main')) {
    return 'At the shop (227 South Main St, East Windsor)';
  }
  return lot;
}
function lookupTruck(truck6) {
  if (!fs.existsSync(NIGHTLY)) return null;
  const nights = fs.readdirSync(NIGHTLY).filter(n => fs.statSync(path.join(NIGHTLY, n)).isDirectory()).sort().reverse();
  for (const night of nights) {
    const mapPath = path.join(NIGHTLY, night, 'map_observations.csv');
    const devPath = path.join(NIGHTLY, night, 'devices.csv');
    if (!fs.existsSync(mapPath)) continue;
    const maps = parse(fs.readFileSync(mapPath, 'utf8'), { columns: true, skip_empty_lines: true, relax_column_count: true });
    const obs = maps.find(r => String(r.truck6 || '').trim() === truck6);
    if (!obs) continue;
    let device = {};
    if (fs.existsSync(devPath)) {
      const devices = parse(fs.readFileSync(devPath, 'utf8'), { columns: true, skip_empty_lines: true, relax_column_count: true });
      device = devices.find(r => String(r.truck6 || '').trim() === truck6) || {};
    }
    return { truck6, lot: displayLot(obs.lot), updated_time: obs.updated_time, notes: obs.notes,
      camera_name: device.name, camera_status: device.status, last_checkin: device.last_checkin,
      badge: device.badge, as_of_night: night };
  }
  return null;
}

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '25mb' }));

app.get('/healthz', (_req, res) => res.status(200).type('text/plain').send('ok'));
app.get('/api/health', (_req, res) => res.json({ ok: true, service: 'shop-tracker' }));

app.post('/api/auth/login', (req, res) => {
  const user = findUser(req.body.username);
  if (!user || String(req.body.password || '') !== APP_PASSWORD) {
    return res.status(401).json({ detail: 'Wrong name or password.' });
  }
  const token = makeSessionToken();
  const store = loadStore();
  store.sessions[token] = { username: user.username, expires_at: new Date(Date.now() + 30*864e5).toISOString() };
  saveStore(store);
  setCookie(res, token);
  res.json({ ok: true, user: userPayload(user) });
});

app.post('/api/auth/logout', (req, res) => {
  const token = parseCookies(req)[COOKIE];
  if (token) {
    const store = loadStore();
    delete store.sessions[token];
    saveStore(store);
  }
  clearCookie(res);
  res.json({ ok: true });
});

app.get('/api/me', (req, res) => {
  const u = requireAuth(req, res); if (!u) return;
  res.json({ user: userPayload(u) });
});

app.get('/api/trucks', (req, res) => {
  if (!requireAuth(req, res)) return;
  const list = trucks.slice().sort((a, b) => a.station.localeCompare(b.station) || a.unit.localeCompare(b.unit));
  res.json({ trucks: list.map(t => ({ unit: t.unit, station: t.station, label: `${t.unit} · ${t.station}` })) });
});

app.get('/api/schedule', (req, res) => {
  if (!requireAuth(req, res)) return;
  const today = new Date();
  const start = req.query.week_start ? mondayOf(parseYmd(String(req.query.week_start))) : mondayOf(today);
  const days = [];
  for (let w = 0; w < 2; w++) for (let i = 0; i < 4; i++) {
    const d = new Date(start); d.setDate(d.getDate() + w * 7 + i);
    days.push({ date: ymd(d), label: `${d.getMonth()+1}/${d.getDate()}`,
      weekday: d.toLocaleDateString('en-US', { weekday: 'short' }), is_today: ymd(d) === ymd(today), week: w + 1 });
  }
  const daySet = new Set(days.map(d => d.date));
  const store = loadStore();
  const cards = store.cards.filter(c => daySet.has(c.schedule_date)).map(c => {
    const notes = store.notes
      .filter(n => n.card_id === c.id)
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .map(n => ({
        id: n.id,
        body: n.body,
        initials: n.initials,
        user: n.user,
        created_at: n.created_at,
      }));
    return { ...c, notes_count: notes.length, notes };
  });
  const prev = new Date(start); prev.setDate(prev.getDate() - 7);
  const next = new Date(start); next.setDate(next.getDate() + 7);
  res.json({ week_start: ymd(start), next_week_start: ymd(next), prev_week_start: ymd(prev),
    today: ymd(today), days, cards, stages: STAGES });
});

app.post('/api/cards', (req, res) => {
  const u = requireAuth(req, res); if (!u) return;
  if (!canSchedule(u)) return scheduleForbidden(res);
  const unit = String(req.body.truck_unit || '').trim();
  const d = parseYmd(String(req.body.schedule_date || ''));
  if (!isShopDay(d)) return res.status(400).json({ detail: 'Shop is Mon–Thu only. Pick a Monday–Thursday date.' });
  const truck = trucks.find(t => t.unit === unit);
  if (!truck) return res.status(404).json({ detail: 'Unknown truck number' });
  const store = loadStore();
  if (store.cards.some(c => c.truck_unit === unit && c.schedule_date === ymd(d)))
    return res.status(400).json({ detail: 'That truck is already scheduled on that day' });
  const now = utcnow();
  const card = { id: id(), truck_unit: unit, station: truck.station, schedule_date: ymd(d), stage: 'Scheduled',
    last_initials: u.initials, last_user: u.username, updated_at: now, created_at: now };
  store.cards.push(card);
  store.audit.push(makeAudit(u, card, 'created', `Scheduled on ${ymd(d)}`));
  // makeAudit stamps its own created_at; keep card timestamps as `now`
  saveStore(store);
  res.json({ card });
});

app.patch('/api/cards/:cardId', (req, res) => {
  const u = requireAuth(req, res); if (!u) return;
  const store = loadStore();
  const card = store.cards.find(c => c.id === req.params.cardId);
  if (!card) return res.status(404).json({ detail: 'Card not found' });
  const details = [];
  // Reschedule (date / position) is schedulers only. Non-schedulers get 403 if they send
  // schedule_date; they can still PATCH stage alone (and add notes on the notes endpoint).
  if (req.body.schedule_date != null && !canSchedule(u)) return scheduleForbidden(res);
  // Stage updates are allowed for every signed-in manager.
  if (req.body.stage != null) {
    if (!STAGES.includes(req.body.stage)) return res.status(400).json({ detail: `Stage must be one of ${STAGES}` });
    if (req.body.stage !== card.stage) { details.push(`stage ${card.stage} → ${req.body.stage}`); card.stage = req.body.stage; }
  }
  if (req.body.schedule_date != null) {
    const d = parseYmd(String(req.body.schedule_date));
    if (!isShopDay(d)) return res.status(400).json({ detail: 'Shop is Mon–Thu only' });
    if (store.cards.some(c => c.truck_unit === card.truck_unit && c.schedule_date === ymd(d) && c.id !== card.id))
      return res.status(400).json({ detail: 'That truck is already on that day' });
    if (ymd(d) !== card.schedule_date) { details.push(`date ${card.schedule_date} → ${ymd(d)}`); card.schedule_date = ymd(d); }
  }
  if (!details.length) return res.json({ card });
  const now = utcnow();
  card.last_initials = u.initials; card.last_user = u.username; card.updated_at = now;
  store.audit.push(makeAudit(u, card, 'updated', details.join('; ')));
  saveStore(store);
  res.json({ card });
});

app.delete('/api/cards/:cardId', (req, res) => {
  const u = requireAuth(req, res); if (!u) return;
  if (!canSchedule(u)) return scheduleForbidden(res);
  const store = loadStore();
  const idx = store.cards.findIndex(c => c.id === req.params.cardId);
  if (idx < 0) return res.status(404).json({ detail: 'Card not found' });
  const card = store.cards[idx];
  store.audit.push(makeAudit(u, card, 'deleted', `Removed ${card.truck_unit} from ${card.schedule_date}`));
  store.cards.splice(idx, 1);
  // Notes for the removed card are kept; audit is never deleted.
  saveStore(store);
  res.json({ ok: true });
});

app.get('/api/cards/:cardId/audit', (req, res) => {
  if (!requireAuth(req, res)) return;
  const store = loadStore();
  res.json({ events: store.audit.filter(a => a.card_id === req.params.cardId).sort((a,b) => b.created_at.localeCompare(a.created_at)) });
});

app.get('/api/cards/:cardId/notes', (req, res) => {
  if (!requireAuth(req, res)) return;
  const store = loadStore();
  if (!store.cards.some(c => c.id === req.params.cardId)) return res.status(404).json({ detail: 'Card not found' });
  const notes = store.notes.filter(n => n.card_id === req.params.cardId).sort((a,b) => a.created_at.localeCompare(b.created_at));
  res.json({ notes, count: notes.length });
});

app.post('/api/cards/:cardId/notes', (req, res) => {
  const u = requireAuth(req, res); if (!u) return;
  const text = String(req.body.body || '').trim();
  if (!text) return res.status(400).json({ detail: 'Note cannot be empty' });
  const store = loadStore();
  const now = utcnow();
  const card = store.cards.find(c => c.id === req.params.cardId);
  if (!card) return res.status(404).json({ detail: 'Card not found' });
  const note = { id: id(), card_id: card.id, user: u.username, initials: u.initials, body: text, created_at: now };
  store.notes.push(note);
  store.audit.push(makeAudit(u, card, 'note', text.slice(0, 200)));
  saveStore(store);
  res.json({ note });
});

app.get('/api/lookup/:truck', (req, res) => {
  if (!requireAuth(req, res)) return;
  const truck = String(req.params.truck || '').trim();
  const loc = lookupTruck(truck);
  const store = loadStore();
  const open = store.cards.filter(c => c.truck_unit === truck && c.stage !== 'Picked up').sort((a,b) => b.schedule_date.localeCompare(a.schedule_date))[0] || null;
  if (!loc) return res.json({ found: false, truck, message: 'No recent location', shop_card: open });
  res.json({ found: true, truck, lot: loc.lot, updated_time: loc.updated_time,
    camera_status: loc.badge || loc.camera_status, last_checkin: loc.last_checkin, camera_name: loc.camera_name,
    as_of_night: loc.as_of_night,
    disclaimer: `Location data is from the nightly Ground Cloud run (${loc.as_of_night}), not live GPS.`,
    shop_card: open });
});

app.post('/api/admin/sync-nightly', (req, res) => {
  const tok = req.headers['x-sync-token'] || req.query.token;
  if (!SYNC_TOKEN || tok !== SYNC_TOKEN) return res.status(401).json({ detail: 'Unauthorized' });
  const night = String(req.body.night || '').trim();
  const mapCsv = req.body.map_observations_csv;
  const devicesCsv = req.body.devices_csv;
  if (!night || !mapCsv) return res.status(400).json({ detail: 'night and map_observations_csv required' });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(night)) return res.status(400).json({ detail: 'bad night' });
  const dir = path.join(NIGHTLY, night);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'map_observations.csv'), mapCsv);
  if (devicesCsv) fs.writeFileSync(path.join(dir, 'devices.csv'), devicesCsv);
  res.json({ ok: true, night });
});

// ---- Change history (all signed-in managers) ----
app.get('/api/history', (req, res) => {
  if (!requireAuth(req, res)) return;
  const store = loadStore();
  const truckQ = String(req.query.truck || '').trim();
  const userQ = String(req.query.user || '').trim().toLowerCase();
  const actionQ = String(req.query.action || '').trim().toLowerCase();
  const fromQ = String(req.query.from || '').trim();
  const toQ = String(req.query.to || '').trim();
  const limit = Math.min(Math.max(parseInt(String(req.query.limit || '200'), 10) || 200, 1), 1000);
  const offset = Math.max(parseInt(String(req.query.offset || '0'), 10) || 0, 0);

  let events = store.audit.slice();
  if (truckQ) {
    events = events.filter(a => String(a.truck_unit || '').includes(truckQ));
  }
  if (userQ) {
    events = events.filter(a =>
      String(a.user || '').toLowerCase() === userQ ||
      String(a.initials || '').toLowerCase() === userQ
    );
  }
  if (actionQ) {
    events = events.filter(a => String(a.action || '').toLowerCase() === actionQ);
  }
  if (fromQ && /^\d{4}-\d{2}-\d{2}$/.test(fromQ)) {
    events = events.filter(a => etYmd(a.created_at) >= fromQ);
  }
  if (toQ && /^\d{4}-\d{2}-\d{2}$/.test(toQ)) {
    events = events.filter(a => etYmd(a.created_at) <= toQ);
  }
  // Newest first; when timestamps collide (utcnow drops ms), later inserts win.
  events = events.map((a, i) => ({ a, i })).sort((x, y) => {
    const c = String(y.a.created_at).localeCompare(String(x.a.created_at));
    return c || (y.i - x.i);
  }).map(x => x.a);
  const total = events.length;
  const page = events.slice(offset, offset + limit).map(a => ({
    id: a.id,
    card_id: a.card_id,
    truck_unit: a.truck_unit || null,
    station: a.station || null,
    schedule_date: a.schedule_date || null,
    user: a.user,
    initials: a.initials,
    action: a.action,
    detail: a.detail || '',
    created_at: a.created_at,
  }));
  // Distinct managers for the History filter UI
  const managers = USERS.map(u => ({ username: u.username, name: u.name, initials: u.initials }));
  res.json({ events: page, total, limit, offset, managers, actions: ['created', 'updated', 'deleted', 'note'] });
});

// ---- Admin export (SYNC_TOKEN) — no secrets / sessions / passwords ----
app.get('/api/admin/export', (req, res) => {
  const tok = req.headers['x-sync-token'] || req.query.token;
  if (!SYNC_TOKEN || tok !== SYNC_TOKEN) return res.status(401).json({ detail: 'Unauthorized' });
  const store = loadStore();
  let oil_chart = null;
  try { oil_chart = JSON.parse(fs.readFileSync(OIL_LATEST, 'utf8')); } catch { oil_chart = null; }
  res.setHeader('Cache-Control', 'no-store');
  res.json({
    exported_at: utcnow(),
    service: 'shop-tracker',
    cards: store.cards,
    audit: store.audit,
    notes: store.notes,
    oil_chart,
  });
});

// ---- Oil change forecast (private: OIL_CHART_USERS only) ----
const OIL_STATION = { SW: 'SW', WIN: 'Win', WA: 'Wall', WALL: 'Wall', '-': '-', '': '-' };
function numOrNull(v) {
  if (v === null || v === undefined || String(v).trim() === '') return null;
  const n = Number(String(v).replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}
function normalizeOilRow(r) {
  const truck = String(r.truck || '').trim();
  if (!/^[A-Za-z0-9-]{1,20}$/.test(truck)) return null;
  const st = String(r.station || '').trim().toUpperCase();
  const known = trucks.find(t => t.unit === truck);
  const due = String(r.projected_due || '').trim();
  return {
    truck,
    station: known ? known.station : (OIL_STATION[st] || String(r.station || '-').slice(0, 8)),
    oil_life_used_pct: numOrNull(r.oil_life_used_pct),
    miles_left: numOrNull(r.miles_left),
    avg_daily_miles: numOrNull(r.avg_daily_miles),
    days_left: numOrNull(r.days_left),
    projected_due: /^\d{4}-\d{2}-\d{2}$/.test(due) ? due : null,
    note: String(r.note || '').slice(0, 300),
  };
}

app.post('/api/admin/oil-chart', (req, res) => {
  const tok = req.headers['x-sync-token'] || req.query.token;
  if (!SYNC_TOKEN || tok !== SYNC_TOKEN) return res.status(401).json({ detail: 'Unauthorized' });
  const dataDate = String(req.body.data_date || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dataDate)) return res.status(400).json({ detail: 'data_date must be YYYY-MM-DD' });
  if (!Array.isArray(req.body.rows) || !req.body.rows.length) return res.status(400).json({ detail: 'rows must be a non-empty array' });
  if (req.body.rows.length > 2000) return res.status(400).json({ detail: 'too many rows' });
  const rows = req.body.rows.map(normalizeOilRow).filter(Boolean);
  if (!rows.length) return res.status(400).json({ detail: 'no valid rows' });
  const chart = {
    data_date: dataDate,
    generated_at: String(req.body.generated_at || '').slice(0, 40) || null,
    received_at: utcnow(),
    interval_miles: numOrNull(req.body.interval_miles) || 5000,
    source: String(req.body.source || '').slice(0, 200) || null,
    rows,
  };
  const json = JSON.stringify(chart, null, 2);
  fs.mkdirSync(OIL_HISTORY, { recursive: true });
  fs.writeFileSync(path.join(OIL_HISTORY, `${dataDate}.json`), json);
  const tmp = OIL_LATEST + '.tmp';
  fs.writeFileSync(tmp, json);
  fs.renameSync(tmp, OIL_LATEST);
  res.json({ ok: true, data_date: dataDate, rows: rows.length });
});

app.get('/api/oil-chart', (req, res) => {
  const u = requireAuth(req, res); if (!u) return;
  if (!canSeeOilChart(u)) return res.status(403).json({ detail: 'Not allowed' });
  res.setHeader('Cache-Control', 'no-store');
  let chart = null;
  try { chart = JSON.parse(fs.readFileSync(OIL_LATEST, 'utf8')); } catch { chart = null; }
  let history = [];
  try { history = fs.readdirSync(OIL_HISTORY).filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).map(f => f.slice(0, 10)).sort().reverse(); } catch {}
  res.json({ chart, history });
});

app.use('/assets', express.static(PUBLIC));
app.use(express.static(PUBLIC, { index: false }));
app.get('/sw.js', (_req, res) => res.sendFile(path.join(PUBLIC, 'sw.js')));
app.get('/manifest.webmanifest', (_req, res) => res.type('application/manifest+json').sendFile(path.join(PUBLIC, 'manifest.webmanifest')));
app.get('/', (_req, res) => res.sendFile(path.join(PUBLIC, 'index.html')));

app.listen(PORT, '0.0.0.0', () => {
  console.log(`shop tracker listening on 0.0.0.0:${PORT} DATA_DIR=${DATA}`);
});
