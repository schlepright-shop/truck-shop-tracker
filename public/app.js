const STAGE_CLASS = {
  "Scheduled": "s1",
  "Dropped off": "s2",
  "Completed": "s3",
  "Picked up": "s4",
};
const STAGES = ["Scheduled", "Dropped off", "Completed", "Picked up"];

const state = {
  user: null,
  weekStart: null,
  trucks: [],
  schedule: null,
  activeCard: null,
};

function $(id) { return document.getElementById(id); }

function canSchedule() {
  return !!(state.user && state.user.features && state.user.features.can_schedule);
}

/** Show/hide schedule-only UI (add bar, modal move/delete). */
function applySchedulePermissions() {
  const allow = canSchedule();
  const addPanel = $("add-panel");
  if (addPanel) addPanel.classList.toggle("hidden", !allow);
  const moveField = $("m-date") && $("m-date").closest(".field");
  if (moveField) moveField.classList.toggle("hidden", !allow);
  if ($("m-save")) $("m-save").classList.toggle("hidden", !allow);
  if ($("m-delete")) $("m-delete").classList.toggle("hidden", !allow);
}

async function api(path, opts = {}) {
  const headers = Object.assign({ "Content-Type": "application/json" }, opts.headers || {});
  const res = await fetch(path, { ...opts, headers, credentials: "same-origin" });
  let data = null;
  try { data = await res.json(); } catch (_) {}
  if (!res.ok) {
    const msg = (data && (data.detail || data.error)) || res.statusText;
    throw new Error(typeof msg === "string" ? msg : JSON.stringify(msg));
  }
  return data;
}

function showAuth(msg, isErr) {
  const el = $("auth-msg");
  el.className = isErr ? "err" : "ok";
  el.textContent = msg || "";
}

function setSignedIn(on) {
  $("auth").classList.toggle("hidden", on);
  $("app").classList.toggle("hidden", !on);
}

async function bootstrap() {
  try {
    const me = await api("/api/me");
    state.user = me.user;
    $("who").textContent = `${me.user.name} (${me.user.initials})`;
    setSignedIn(true);
    applySchedulePermissions();
    await loadTrucks();
    await loadSchedule();
    await initOilChart();
  } catch (e) {
    setSignedIn(false);
  }
}

async function loadTrucks() {
  const data = await api("/api/trucks");
  state.trucks = data.trucks;
  $("truck-list").innerHTML = data.trucks.map(t =>
    `<option value="${t.unit}">${t.label}</option>`
  ).join("");
  setupCombobox();
}

function setupCombobox() {
  const input = $("add-truck-input");
  const hidden = $("add-truck");
  const menu = $("add-truck-menu");

  function render(q) {
    const qq = (q || "").trim().toLowerCase();
    const matches = state.trucks.filter(t =>
      !qq || t.unit.includes(qq) || t.label.toLowerCase().includes(qq) || t.station.toLowerCase().includes(qq)
    ).slice(0, 40);
    if (!matches.length) {
      menu.innerHTML = `<button type="button" disabled>No match</button>`;
    } else {
      menu.innerHTML = matches.map(t =>
        `<button type="button" data-unit="${t.unit}">${t.unit} · ${t.station}</button>`
      ).join("");
    }
    menu.classList.remove("hidden");
    menu.querySelectorAll("button[data-unit]").forEach(btn => {
      btn.addEventListener("mousedown", (e) => {
        e.preventDefault();
        hidden.value = btn.dataset.unit;
        input.value = `${btn.dataset.unit} · ${state.trucks.find(t => t.unit === btn.dataset.unit).station}`;
        menu.classList.add("hidden");
      });
    });
  }

  input.addEventListener("focus", () => render(input.value));
  input.addEventListener("input", () => {
    // if user is typing a raw number, clear hidden until pick
    const raw = input.value.trim();
    const exact = state.trucks.find(t => t.unit === raw || t.label === raw);
    hidden.value = exact ? exact.unit : "";
    render(raw);
  });
  input.addEventListener("blur", () => setTimeout(() => menu.classList.add("hidden"), 150));
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      const first = menu.querySelector("button[data-unit]");
      if (first) first.dispatchEvent(new Event("mousedown"));
    }
  });
}

function fmtRange(days) {
  if (!days || !days.length) return "";
  const a = days[0].date, b = days[days.length - 1].date;
  const fa = new Date(a + "T12:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" });
  const fb = new Date(b + "T12:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  return `${fa} – ${fb}`;
}

async function loadSchedule(weekStart) {
  const q = weekStart ? `?week_start=${weekStart}` : "";
  const data = await api(`/api/schedule${q}`);
  state.schedule = data;
  state.weekStart = data.week_start;
  $("range-label").textContent = fmtRange(data.days);
  renderBoard(data);
  if (!$("add-date").value) {
    const today = data.today;
    const next = data.days.find(d => d.date >= today) || data.days[0];
    $("add-date").value = next.date;
  }
}

function renderBoard(data) {
  const byDate = {};
  for (const c of data.cards) {
    (byDate[c.schedule_date] || (byDate[c.schedule_date] = [])).push(c);
  }
  const week1 = data.days.filter(d => d.week === 1);
  const week2 = data.days.filter(d => d.week === 2);
  const board = $("board");
  board.innerHTML = "";
  for (const [label, days] of [["This week", week1], ["Next week", week2]]) {
    const wl = document.createElement("div");
    wl.className = "week-label";
    wl.textContent = label;
    board.appendChild(wl);
    const grid = document.createElement("div");
    grid.className = "grid";
    for (const d of days) {
      const day = document.createElement("div");
      day.className = "day" + (d.is_today ? " today" : "");
      day.innerHTML = `<div class="dh"><span>${d.label}</span><span class="wd">${d.weekday}</span></div>`;
      for (const c of (byDate[d.date] || [])) {
        const el = document.createElement("div");
        el.className = `truck-row ${STAGE_CLASS[c.stage] || "s1"}`;
        el.dataset.id = c.id;
        const ncount = c.notes_count || 0;
        const opts = STAGES.map(s =>
          `<option value="${s}" ${s === c.stage ? "selected" : ""}>${s}</option>`
        ).join("") + (canSchedule()
          ? `<option value="__remove__" class="opt-remove" style="color:#dc2626">Remove from schedule</option>`
          : "");
        const notes = Array.isArray(c.notes) ? c.notes : [];
        const newest = notes.slice(0, 2);
        const more = Math.max(0, (c.notes_count || notes.length) - newest.length);
        const notesHtml = newest.length
          ? `<div class="card-notes">${newest.map(n =>
              `<div class="card-note">${escapeHtml(n.body)} (${escapeHtml(n.initials || "")})</div>`
            ).join("")}${more ? `<button type="button" class="more-notes" data-act="notes-more">+${more} more</button>` : ""}</div>`
          : "";
        el.innerHTML = `
          <div class="row-top">
            <span class="unit">${c.truck_unit}</span>
            <span class="tag">${c.station}</span>
            <span class="who">${c.last_initials || ""}</span>
            <button type="button" class="notes-btn" data-act="notes" title="Notes">📝${ncount ? `<span class="badge">${ncount}</span>` : ""}</button>
          </div>
          <select class="stage-select" aria-label="Status for ${c.truck_unit}">${opts}</select>
          ${notesHtml}`;
        const sel = el.querySelector(".stage-select");
        sel.addEventListener("change", async () => {
          const stage = sel.value;
          if (stage === c.stage) return;
          if (stage === "__remove__") {
            const dd = new Date(c.schedule_date + "T12:00:00");
            const label = `${dd.toLocaleDateString("en-US", { weekday: "short" })} ${dd.getMonth() + 1}/${dd.getDate()}`;
            if (!confirm(`Remove ${c.truck_unit} from ${label}?`)) { sel.value = c.stage; return; }
            sel.disabled = true;
            try {
              await api(`/api/cards/${c.id}`, { method: "DELETE" });
              await loadSchedule(state.weekStart);
            } catch (err) {
              alert(err.message);
              sel.value = c.stage;
              sel.disabled = false;
            }
            return;
          }
          sel.disabled = true;
          try {
            await api(`/api/cards/${c.id}`, {
              method: "PATCH",
              body: JSON.stringify({ stage }),
            });
            await loadSchedule(state.weekStart);
          } catch (err) {
            alert(err.message);
            sel.value = c.stage;
            sel.disabled = false;
          }
        });
        const openNotes = (ev) => {
          ev.stopPropagation();
          openNotesPopover(c.id, ev.currentTarget);
        };
        el.querySelector('[data-act="notes"]').addEventListener("click", openNotes);
        const moreBtn = el.querySelector('[data-act="notes-more"]');
        if (moreBtn) moreBtn.addEventListener("click", openNotes);
        day.appendChild(el);
      }
      grid.appendChild(day);
    }
    board.appendChild(grid);
  }
  $("test-banner").classList.toggle("hidden", localStorage.getItem("st_test") !== "1");
}

function formatWhen(iso) {
  try {
    return new Date(iso).toLocaleString("en-US", { timeZone: "America/New_York" }) + " ET";
  } catch { return iso; }
}
function formatNY(iso) { return formatWhen(iso); }

async function openCard(id) {
  const card = state.schedule.cards.find(c => c.id === id);
  if (!card) return;
  state.activeCard = card;
  $("m-title").textContent = `${card.truck_unit} · ${card.station}`;
  $("m-sub").textContent = `${card.stage} · last change ${card.last_initials}`;
  $("m-date").value = card.schedule_date;
  $("modal").classList.remove("hidden");
  try {
    const nd = await api(`/api/cards/${id}/notes`);
    $("m-notes").innerHTML = nd.notes.length
      ? nd.notes.map(n => `<li><strong>${n.initials}</strong> — ${n.body}<div class="when">${formatNY(n.created_at)}</div></li>`).join("")
      : "<li>No notes yet</li>";
  } catch (e) {
    $("m-notes").innerHTML = `<li class="err">${e.message}</li>`;
  }
  try {
    const aud = await api(`/api/cards/${id}/audit`);
    $("m-audit").innerHTML = aud.events.map(e => `
      <li>
        <div><strong>${e.initials}</strong> — ${e.action}: ${e.detail || ""}</div>
        <div class="when">${formatWhen(e.created_at)}</div>
      </li>`).join("") || "<li>No history yet</li>";
  } catch (e) {
    $("m-audit").innerHTML = `<li class="err">${e.message}</li>`;
  }
}

function closeModal() {
  $("modal").classList.add("hidden");
  state.activeCard = null;
}

$("btn-login").addEventListener("click", async () => {
  showAuth("");
  try {
    const r = await api("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({
        username: $("username").value.trim(),
        password: $("password").value,
      }),
    });
    state.user = r.user;
    $("who").textContent = `${r.user.name} (${r.user.initials})`;
    setSignedIn(true);
    applySchedulePermissions();
    await loadTrucks();
    await loadSchedule();
    await initOilChart();
  } catch (e) {
    showAuth(e.message, true);
  }
});

$("password").addEventListener("keydown", (e) => {
  if (e.key === "Enter") $("btn-login").click();
});

$("btn-logout").addEventListener("click", async () => {
  try { await api("/api/auth/logout", { method: "POST" }); } catch (_) {}
  removeOilPanel();
  closeHistoryPanel();
  state.user = null;
  applySchedulePermissions();
  setSignedIn(false);
});

$("btn-prev").addEventListener("click", () => loadSchedule(state.schedule.prev_week_start));
$("btn-next").addEventListener("click", () => loadSchedule(state.schedule.next_week_start));

$("btn-add").addEventListener("click", async () => {
  $("add-msg").textContent = "";
  let unit = $("add-truck").value;
  if (!unit) {
    const typed = $("add-truck-input").value.trim();
    const match = state.trucks.find(t => t.unit === typed || t.label === typed || typed.startsWith(t.unit));
    if (match) unit = match.unit;
  }
  if (!unit) {
    $("add-msg").textContent = "Pick a truck from the list";
    return;
  }
  try {
    await api("/api/cards", {
      method: "POST",
      body: JSON.stringify({ truck_unit: unit, schedule_date: $("add-date").value }),
    });
    $("add-truck-input").value = "";
    $("add-truck").value = "";
    await loadSchedule(state.weekStart);
  } catch (e) {
    $("add-msg").textContent = e.message;
  }
});

$("btn-lookup").addEventListener("click", async () => {
  const truck = $("lookup-truck").value.trim();
  const out = $("lookup-out");
  if (!truck) return;
  out.innerHTML = "Looking up…";
  try {
    const r = await api(`/api/lookup/${encodeURIComponent(truck)}`);
    if (!r.found) {
      let html = `<div class="lookup-result miss"><strong>No recent location</strong> for ${truck}.`;
      if (r.shop_card) {
        html += `<div style="margin-top:6px">On shop schedule: <strong>${r.shop_card.stage}</strong> (${r.shop_card.schedule_date}) · ${r.shop_card.last_initials}</div>`;
      }
      html += `</div>`;
      out.innerHTML = html;
      return;
    }
    let html = `<div class="lookup-result">
      <div><strong>${r.truck}</strong> · ${r.lot || "Unknown lot"}</div>
      <div>GPS update: ${r.updated_time || "—"}</div>
      <div>Camera: ${r.camera_status || "—"} · last check-in ${r.last_checkin || "—"}</div>`;
    if (r.shop_card) {
      html += `<div style="margin-top:6px">Shop schedule: <strong>${r.shop_card.stage}</strong> on ${r.shop_card.schedule_date} · ${r.shop_card.last_initials}</div>`;
    }
    html += `<div class="disclaimer">${r.disclaimer}</div></div>`;
    out.innerHTML = html;
  } catch (e) {
    out.innerHTML = `<div class="err">${e.message}</div>`;
  }
});

$("m-close").addEventListener("click", closeModal);
$("modal").addEventListener("click", (e) => { if (e.target.id === "modal") closeModal(); });

$("m-save").addEventListener("click", async () => {
  if (!state.activeCard) return;
  try {
    await api(`/api/cards/${state.activeCard.id}`, {
      method: "PATCH",
      body: JSON.stringify({ schedule_date: $("m-date").value }),
    });
    closeModal();
    await loadSchedule(state.weekStart);
  } catch (e) { alert(e.message); }
});

$("m-delete").addEventListener("click", async () => {
  if (!state.activeCard) return;
  if (!confirm(`Remove ${state.activeCard.truck_unit} from the schedule?`)) return;
  try {
    await api(`/api/cards/${state.activeCard.id}`, { method: "DELETE" });
    closeModal();
    await loadSchedule(state.weekStart);
  } catch (e) { alert(e.message); }
});

function clampShopDate(input) {
  input.addEventListener("change", () => {
    if (!input.value) return;
    const d = new Date(input.value + "T12:00:00");
    const day = d.getDay();
    if (day === 0) d.setDate(d.getDate() + 1);
    if (day === 5) d.setDate(d.getDate() + 3);
    if (day === 6) d.setDate(d.getDate() + 2);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    const next = `${y}-${m}-${dd}`;
    if (next !== input.value) input.value = next;
  });
}
clampShopDate($("add-date"));
clampShopDate($("m-date"));

$("m-note-add").addEventListener("click", async () => {
  if (!state.activeCard) return;
  const text = $("m-note-input").value.trim();
  if (!text) return;
  try {
    await api(`/api/cards/${state.activeCard.id}/notes`, {
      method: "POST", body: JSON.stringify({ body: text }),
    });
    $("m-note-input").value = "";
    await openCard(state.activeCard.id);
    await loadSchedule(state.weekStart);
  } catch (e) { alert(e.message); }
});

let openPop = null;
function closeNotesPopover() {
  if (openPop) { openPop.remove(); openPop = null; }
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c]));
}
async function openNotesPopover(cardId, anchor) {
  closeNotesPopover();
    const pop = document.createElement("div");
  pop.className = "notes-pop";
  pop.innerHTML = `<h4>Notes</h4><div class="notes-body">Loading…</div>
    <textarea id="note-input" placeholder="Add a note…"></textarea>
    <div class="pop-actions">
      <button type="button" id="note-save">Add note</button>
      <button type="button" class="secondary" id="note-close">Close</button>
    </div>`;
  document.body.appendChild(pop);
  openPop = pop;
  const rect = anchor.getBoundingClientRect();
  const top = Math.min(window.scrollY + rect.bottom + 6, window.scrollY + window.innerHeight - 280);
  let left = window.scrollX + rect.left;
  if (left + 300 > window.scrollX + window.innerWidth) left = window.scrollX + window.innerWidth - 310;
  pop.style.top = top + "px";
  pop.style.left = Math.max(8, left) + "px";

  async function refresh() {
    const data = await api(`/api/cards/${cardId}/notes`);
    const body = pop.querySelector(".notes-body");
    if (!data.notes.length) body.innerHTML = `<div class="sub">No notes yet.</div>`;
    else body.innerHTML = data.notes.map(n => `
      <div class="note">
        <div><span class="who">${n.initials}</span> — ${escapeHtml(n.body)}</div>
        <div class="when">${formatNY(n.created_at)}</div>
      </div>`).join("");
    const row = document.querySelector(`.truck-row[data-id="${cardId}"]`);
    const btn = row && row.querySelector(".notes-btn");
    if (btn) {
      const existing = btn.querySelector(".badge");
      if (data.count) {
        if (existing) existing.textContent = data.count;
        else { const b = document.createElement("span"); b.className = "badge"; b.textContent = data.count; btn.appendChild(b); }
      } else if (existing) existing.remove();
    }
  }
  pop.querySelector("#note-close").onclick = closeNotesPopover;
  pop.querySelector("#note-save").onclick = async () => {
    const text = pop.querySelector("#note-input").value.trim();
    if (!text) return;
    try {
      await api(`/api/cards/${cardId}/notes`, { method: "POST", body: JSON.stringify({ body: text }) });
      pop.querySelector("#note-input").value = "";
      await loadSchedule(state.weekStart);
      await refresh();
    } catch (e) { alert(e.message); }
  };
  setTimeout(() => {
    document.addEventListener("click", function onDoc(e) {
      if (openPop && !openPop.contains(e.target) && e.target !== anchor && !anchor.contains(e.target)) {
        closeNotesPopover();
        document.removeEventListener("click", onDoc);
      }
    });
  }, 0);
  try { await refresh(); } catch (e) {
    pop.querySelector(".notes-body").innerHTML = `<div class="err">${e.message}</div>`;
  }
}

/* ---- Oil change forecast (only shown to allowed users; server enforces 403 for others) ---- */
const oil = { chart: null, sortKey: "days", sortDir: 1 };
const OIL_STATION = { SW: "SW", WIN: "Win", WA: "Wall", WALL: "Wall" };
function removeOilPanel() { const p = $("oil-panel"); if (p) p.remove(); oil.chart = null; }
function todayYmd() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function daysUntil(ymdStr) {
  if (!ymdStr) return null;
  const a = new Date(todayYmd() + "T12:00:00"), b = new Date(ymdStr + "T12:00:00");
  return Math.round((b - a) / 864e5);
}
function shopDayFor(dueYmd) {
  // Latest Mon–Thu on or before the due date, but never before today.
  const today = new Date(todayYmd() + "T12:00:00");
  let d = dueYmd ? new Date(dueYmd + "T12:00:00") : new Date(today);
  if (d < today) d = new Date(today);
  const back = new Date(d);
  while (((back.getDay() + 6) % 7) > 3) back.setDate(back.getDate() - 1);
  if (back >= today) d = back;
  else while (((d.getDay() + 6) % 7) > 3) d.setDate(d.getDate() + 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function fmtDue(ymdStr) {
  if (!ymdStr) return "";
  return new Date(ymdStr + "T12:00:00").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}
async function initOilChart() {
  removeOilPanel();
  if (!state.user || !state.user.features || !state.user.features.oil_chart) return;
  let data;
  try { data = await api("/api/oil-chart"); } catch (_) { return; }
  oil.chart = data.chart;
  const panel = document.createElement("details");
  panel.id = "oil-panel";
  panel.className = "panel oil-panel";
  const anchor = document.querySelector(".weeknav");
  anchor.parentNode.insertBefore(panel, anchor);
  renderOilPanel();
}
function oilSortVal(r, key) {
  switch (key) {
    case "truck": return r.truck;
    case "station": return r.station || "";
    case "pct": return r.oil_life_used_pct ?? -1;
    case "left": return r.miles_left ?? 1e9;
    case "daily": return r.avg_daily_miles ?? -1;
    default: return r.projected_due ? daysUntil(r.projected_due) : 1e9;
  }
}
function renderOilPanel() {
  const panel = $("oil-panel"); if (!panel) return;
  const wasOpen = panel.open;
  const ch = oil.chart;
  if (!ch || !ch.rows || !ch.rows.length) {
    panel.innerHTML = `<summary><strong>Oil change forecast</strong> <span class="sub">· no chart yet</span></summary>`;
    return;
  }
  const withMiles = ch.rows.filter(r => r.projected_due);
  const noMiles = ch.rows.filter(r => !r.projected_due);
  const due2 = withMiles.filter(r => daysUntil(r.projected_due) <= 7).length;
  const due8 = withMiles.filter(r => daysUntil(r.projected_due) <= 21).length;
  withMiles.sort((a, b) => {
    const x = oilSortVal(a, oil.sortKey), y = oilSortVal(b, oil.sortKey);
    return (x < y ? -1 : x > y ? 1 : 0) * oil.sortDir || a.truck.localeCompare(b.truck);
  });
  noMiles.sort((a, b) => a.truck.localeCompare(b.truck));
  const cols = [["truck", "Truck"], ["station", "Stn"], ["pct", "Oil used"], ["left", "Miles left"], ["daily", "Mi/day"], ["days", "Days left"], ["days", "Due"]];
  const head = cols.map(([k, l], i) => i === 5 ? `<th>${l}</th>` :
    `<th data-sort="${k}" class="sortable${oil.sortKey === k ? " sorted" : ""}">${l}${oil.sortKey === k ? (oil.sortDir > 0 ? " ▲" : " ▼") : ""}</th>`).join("") + `<th>Note</th><th></th>`;
  const rowHtml = (r) => {
    const dl = r.projected_due ? daysUntil(r.projected_due) : null;
    const cls = dl === null ? "oil-nomiles" : dl <= 7 ? "oil-due2" : dl <= 21 ? "oil-due8" : "";
    const st = OIL_STATION[String(r.station || "").toUpperCase()] || r.station || "—";
    const daysTxt = dl === null ? "—" : dl < 0 ? `${-dl} overdue` : String(dl);
    return `<tr class="${cls}">
      <td class="u">${escapeHtml(r.truck)}</td>
      <td>${st && st !== "-" ? `<span class="otag">${escapeHtml(st)}</span>` : "—"}</td>
      <td>${r.oil_life_used_pct ?? "—"}%</td>
      <td>${r.miles_left != null ? Number(r.miles_left).toLocaleString() : "—"}</td>
      <td>${r.avg_daily_miles != null ? Math.round(r.avg_daily_miles) : "—"}</td>
      <td>${daysTxt}</td>
      <td>${r.projected_due ? fmtDue(r.projected_due) : "no recent miles"}</td>
      <td class="note">${escapeHtml(r.note || "")}</td>
      <td>${canSchedule() ? `<button type="button" class="secondary oil-add" data-unit="${escapeHtml(r.truck)}" data-due="${r.projected_due || ""}">+ Schedule</button>` : ""}</td>
    </tr>`;
  };
  panel.innerHTML = `<summary><strong>Oil change forecast</strong>
      <span class="sub">· ${due2} due within 1 wk · ${due8} within 3 wks</span></summary>
    <div class="sub" style="margin:6px 0">MTC data as of <strong>${fmtDue(ch.data_date)}</strong>
      · ${(ch.interval_miles || 5000).toLocaleString()}-mile interval · days/due counted from today · visible only to you and Dan</div>
    <div class="oil-legend"><span class="oil-due2">Due within 1 week</span><span class="oil-due8">Due within 3 weeks</span><span class="oil-nomiles">No recent miles</span></div>
    <div class="oil-wrap"><table class="oil-table"><thead><tr>${head}</tr></thead>
    <tbody>${withMiles.map(rowHtml).join("")}${noMiles.map(rowHtml).join("")}</tbody></table></div>`;
  panel.open = wasOpen;
  panel.querySelectorAll("th[data-sort]").forEach(th => th.addEventListener("click", () => {
    const k = th.dataset.sort;
    if (oil.sortKey === k) oil.sortDir = -oil.sortDir; else { oil.sortKey = k; oil.sortDir = (k === "pct" || k === "daily") ? -1 : 1; }
    renderOilPanel();
  }));
  panel.querySelectorAll(".oil-add").forEach(btn => btn.addEventListener("click", () => {
    const unit = btn.dataset.unit;
    const t = state.trucks.find(x => x.unit === unit);
    const msg = $("add-msg");
    if (!t) { msg.textContent = `${unit} isn't on the truck list`; }
    else {
      $("add-truck").value = unit;
      $("add-truck-input").value = `${unit} · ${t.station}`;
      $("add-date").value = shopDayFor(btn.dataset.due);
      msg.textContent = "";
    }
    $("btn-add").scrollIntoView({ behavior: "smooth", block: "center" });
  }));
}


/* ---- Change history (all managers) ---- */
function ymdDaysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function fmtHistWhen(iso) {
  try {
    return new Date(iso).toLocaleString("en-US", {
      timeZone: "America/New_York",
      weekday: "short", month: "numeric", day: "numeric",
      hour: "numeric", minute: "2-digit",
    });
  } catch { return iso || ""; }
}
function fmtSchedDay(ymdStr) {
  if (!ymdStr) return "";
  try {
    return new Date(ymdStr + "T12:00:00").toLocaleDateString("en-US", {
      weekday: "short", month: "numeric", day: "numeric",
    });
  } catch { return ymdStr; }
}
function humanHistoryDetail(ev) {
  const d = String(ev.detail || "");
  if (ev.action === "created") return "Scheduled";
  if (ev.action === "deleted") return "Removed from schedule";
  if (ev.action === "note") return d ? `Note: ${d}` : "Note added";
  if (ev.action === "updated") {
    const stage = d.match(/stage\s+(.+?)\s*→\s*(.+?)(?:;|$)/i);
    if (stage) return `${stage[2].trim()} (was ${stage[1].trim()})`;
    const date = d.match(/date\s+(\d{4}-\d{2}-\d{2})\s*→\s*(\d{4}-\d{2}-\d{2})/i);
    if (date) return `Moved to ${fmtSchedDay(date[2])} (was ${fmtSchedDay(date[1])})`;
    return d || "Updated";
  }
  return d || ev.action || "";
}
function fillHistoryManagers(managers) {
  const sel = $("hist-user");
  if (!sel) return;
  const cur = sel.value;
  sel.innerHTML = `<option value="">All</option>` + (managers || []).map(m =>
    `<option value="${escapeHtml(m.username)}">${escapeHtml(m.name)} (${escapeHtml(m.initials)})</option>`
  ).join("");
  if (cur) sel.value = cur;
}
function openHistoryPanel() {
  const panel = $("history-panel");
  if (!panel) return;
  panel.classList.remove("hidden");
  if (!$("hist-from").value) $("hist-from").value = ymdDaysAgo(14);
  if (!$("hist-to").value) $("hist-to").value = ymdDaysAgo(0);
  loadHistory();
  panel.scrollIntoView({ behavior: "smooth", block: "start" });
}
function closeHistoryPanel() {
  const panel = $("history-panel");
  if (panel) panel.classList.add("hidden");
}
async function loadHistory() {
  const list = $("history-list");
  const msg = $("history-msg");
  if (!list) return;
  list.innerHTML = "";
  msg.textContent = "Loading…";
  const params = new URLSearchParams();
  const truck = ($("hist-truck").value || "").trim();
  const from = ($("hist-from").value || "").trim();
  const to = ($("hist-to").value || "").trim();
  const user = ($("hist-user").value || "").trim();
  const action = ($("hist-action").value || "").trim();
  if (truck) params.set("truck", truck);
  if (from) params.set("from", from);
  if (to) params.set("to", to);
  if (user) params.set("user", user);
  if (action) params.set("action", action);
  params.set("limit", "200");
  try {
    const data = await api(`/api/history?${params.toString()}`);
    fillHistoryManagers(data.managers);
    if (!data.events.length) {
      msg.textContent = "No matching changes.";
      return;
    }
    msg.textContent = `Showing ${data.events.length} of ${data.total}`;
    list.innerHTML = data.events.map(ev => {
      const when = fmtHistWhen(ev.created_at);
      const truck = ev.truck_unit || "?";
      const stn = ev.station ? ` ${escapeHtml(ev.station)}` : "";
      const sched = ev.schedule_date ? ` · for ${fmtSchedDay(ev.schedule_date)}` : "";
      const what = escapeHtml(humanHistoryDetail(ev));
      const who = escapeHtml(ev.initials || ev.user || "");
      return `<li class="history-item hist-${escapeHtml(ev.action || "")}">
        <div class="hist-line"><span class="hist-when">${escapeHtml(when)}</span>
          <span class="hist-truck">${escapeHtml(truck)}${stn}</span></div>
        <div class="hist-detail">${what} — <strong>${who}</strong><span class="hist-sched">${sched}</span></div>
      </li>`;
    }).join("");
  } catch (e) {
    msg.textContent = e.message;
  }
}
$("btn-history").addEventListener("click", openHistoryPanel);
$("btn-history-close").addEventListener("click", closeHistoryPanel);
$("btn-history-load").addEventListener("click", loadHistory);
["hist-truck", "hist-from", "hist-to", "hist-user", "hist-action"].forEach(id => {
  const el = $(id);
  if (!el) return;
  el.addEventListener("keydown", (e) => { if (e.key === "Enter") loadHistory(); });
});


bootstrap();

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  });
}
