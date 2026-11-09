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
    await loadTrucks();
    await loadSchedule();
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
        ).join("");
        el.innerHTML = `
          <div class="row-top">
            <span class="unit">${c.truck_unit}</span>
            <span class="tag">${c.station}</span>
            <span class="who">${c.last_initials || ""}</span>
            <button type="button" class="notes-btn" data-act="notes" title="Notes">📝${ncount ? `<span class="badge">${ncount}</span>` : ""}</button>
          </div>
          <select class="stage-select" aria-label="Status for ${c.truck_unit}">${opts}</select>`;
        const sel = el.querySelector(".stage-select");
        sel.addEventListener("change", async () => {
          const stage = sel.value;
          if (stage === c.stage) return;
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
        el.querySelector('[data-act="notes"]').addEventListener("click", (ev) => {
          ev.stopPropagation();
          openNotesPopover(c.id, ev.currentTarget);
        });
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
    await loadTrucks();
    await loadSchedule();
  } catch (e) {
    showAuth(e.message, true);
  }
});

$("password").addEventListener("keydown", (e) => {
  if (e.key === "Enter") $("btn-login").click();
});

$("btn-logout").addEventListener("click", async () => {
  try { await api("/api/auth/logout", { method: "POST" }); } catch (_) {}
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
    const btn = document.querySelector(`.card[data-id="${cardId}"] .notes-btn`);
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

bootstrap();

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  });
}
