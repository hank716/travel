// Phase 1 控制器：路由（加入畫面 ↔ 行程主畫面）、表單、即時成員/幣別。
import { ensureAuth } from "./supabase.js";
import { CURRENCIES, CURRENCY_CODES, pickColor } from "./constants.js";
import {
  getSavedTrip, saveTrip, clearSavedTrip,
  createTrip, joinTrip, getTrip, getMyMember,
  listMembers, getTripCurrencies, addTripCurrency, removeTripCurrency,
  updateBaseCurrency, subscribeTrip,
} from "./trip.js";

const $ = (s) => document.querySelector(s);
const { DEFAULT_BASE_CURRENCY, DEFAULT_CURRENCIES } = window.APP_CONFIG;

let unsub = null; // realtime 取消訂閱

// ---------- 視圖切換 ----------
function show(view) {
  for (const id of ["bootView", "joinView", "appView"]) $("#" + id).hidden = id !== view;
}

function showError(msg) {
  const el = $("#joinError");
  el.textContent = msg;
  el.hidden = !msg;
}

// ---------- 加入畫面 ----------
function buildJoinView() {
  // 分頁切換
  document.querySelectorAll(".seg-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".seg-btn").forEach((b) => b.classList.toggle("is-active", b === btn));
      const tab = btn.dataset.tab;
      $("#joinForm").hidden = tab !== "join";
      $("#createForm").hidden = tab !== "create";
      showError("");
    });
  });

  // 基準幣別下拉
  const baseSel = $('#createForm select[name="base"]');
  baseSel.innerHTML = CURRENCY_CODES.map(
    (c) => `<option value="${c}" ${c === DEFAULT_BASE_CURRENCY ? "selected" : ""}>${CURRENCIES[c].flag} ${c} ${CURRENCIES[c].name}</option>`
  ).join("");

  // 啟用幣別複選
  $("#currencyChecks").innerHTML = CURRENCY_CODES.map((c) => `
    <label class="check">
      <input type="checkbox" value="${c}" ${DEFAULT_CURRENCIES.includes(c) ? "checked" : ""} />
      <span>${CURRENCIES[c].flag} ${c}</span>
    </label>`).join("");

  $("#joinForm").addEventListener("submit", onJoinSubmit);
  $("#createForm").addEventListener("submit", onCreateSubmit);
}

async function onJoinSubmit(e) {
  e.preventDefault();
  showError("");
  const f = e.target;
  const code = f.code.value.trim().toUpperCase();
  const name = f.name.value.trim();
  if (!code || !name) return;
  try {
    setBusy(f, true);
    const trip = await joinTrip({ code, name, color: pickColor() });
    saveTrip(trip);
    await enterTrip(trip.id);
  } catch (err) {
    showError(humanError(err));
  } finally {
    setBusy(f, false);
  }
}

async function onCreateSubmit(e) {
  e.preventDefault();
  showError("");
  const f = e.target;
  const currencies = [...f.querySelectorAll('#currencyChecks input:checked')].map((i) => i.value);
  const base = f.base.value;
  if (!currencies.includes(base)) currencies.push(base); // 基準幣別一定要啟用
  try {
    setBusy(f, true);
    const trip = await createTrip({
      title: f.title.value.trim(),
      start: f.start.value || null,
      end: f.end.value || null,
      base,
      currencies,
      name: f.name.value.trim(),
      color: pickColor(),
    });
    saveTrip(trip);
    await enterTrip(trip.id);
  } catch (err) {
    showError(humanError(err));
  } finally {
    setBusy(f, false);
  }
}

// ---------- 行程主畫面 ----------
async function enterTrip(tripId) {
  if (unsub) { unsub(); unsub = null; }
  const trip = await getTrip(tripId);
  await renderTrip(trip);
  show("appView");

  // 頂部徽章
  $("#tripBadge").hidden = false;
  $("#tripBadgeTitle").textContent = trip.title;

  // 即時：成員/幣別變動就重畫
  unsub = subscribeTrip(tripId, () => renderTrip(trip).catch(console.error));
}

async function renderTrip(trip) {
  $("#tripTitle").textContent = trip.title;
  $("#tripDates").textContent = trip.start_date
    ? `${trip.start_date} → ${trip.end_date || "?"}` : "尚未設定日期";
  $("#tripCode").textContent = trip.code;

  const [members, currencies] = await Promise.all([
    listMembers(trip.id),
    getTripCurrencies(trip.id),
  ]);
  const me = await getMyMember(trip.id);

  // 成員
  $("#memberCount").textContent = `（${members.length} 人）`;
  $("#memberList").innerHTML = members.map((m) => `
    <div class="member-chip">
      <span class="avatar" style="background:${m.color}">${(m.display_name || "?").slice(0, 1)}</span>
      <span>${escapeHtml(m.display_name)}${me && m.id === me.id ? " <small class='status'>(你)</small>" : ""}</span>
    </div>`).join("");

  // 幣別
  renderBaseSelect(trip);
  renderCurrencyPills(trip, currencies);
  renderAddCurrency(trip, currencies);
}

function renderBaseSelect(trip) {
  const sel = $("#baseSelect");
  sel.innerHTML = CURRENCY_CODES.map(
    (c) => `<option value="${c}" ${c === trip.base_currency ? "selected" : ""}>${c}</option>`
  ).join("");
  sel.onchange = async () => {
    try {
      await updateBaseCurrency(trip.id, sel.value);
      trip.base_currency = sel.value;
      // 確保基準幣別已啟用
      const cur = await getTripCurrencies(trip.id);
      if (!cur.includes(sel.value)) await addTripCurrency(trip.id, sel.value);
      renderTrip(trip);
    } catch (err) { alert(humanError(err)); }
  };
}

function renderCurrencyPills(trip, currencies) {
  $("#currencyPills").innerHTML = currencies.map((c) => {
    const isBase = c === trip.base_currency;
    return `<span class="pill ${isBase ? "pill--base" : ""}">
      ${CURRENCIES[c]?.flag || ""} ${c}${isBase ? " · 基準" : ""}
      ${isBase ? "" : `<button class="pill-x" data-remove="${c}" title="移除">×</button>`}
    </span>`;
  }).join("");
  $("#currencyPills").querySelectorAll(".pill-x").forEach((b) => {
    b.onclick = async () => {
      try { await removeTripCurrency(trip.id, b.dataset.remove); renderTrip(trip); }
      catch (err) { alert(humanError(err)); }
    };
  });
}

function renderAddCurrency(trip, currencies) {
  const avail = CURRENCY_CODES.filter((c) => !currencies.includes(c));
  const sel = $("#addCurrencySelect");
  sel.innerHTML = avail.length
    ? avail.map((c) => `<option value="${c}">${CURRENCIES[c].flag} ${c} ${CURRENCIES[c].name}</option>`).join("")
    : `<option value="">已全部啟用</option>`;
  $("#addCurrencyBtn").disabled = !avail.length;
  $("#addCurrencyBtn").onclick = async () => {
    if (!sel.value) return;
    try { await addTripCurrency(trip.id, sel.value); renderTrip(trip); }
    catch (err) { alert(humanError(err)); }
  };
}

// ---------- 共用 ----------
function setBusy(form, busy) {
  form.querySelectorAll("button, input, select").forEach((el) => (el.disabled = busy));
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function humanError(err) {
  const m = err?.message || String(err);
  if (/not found/i.test(m)) return "找不到這個行程碼，請確認後再試。";
  if (/not authenticated/i.test(m)) return "身份尚未就緒，請重新整理頁面。";
  return m;
}

// ---------- 啟動 ----------
async function boot() {
  show("bootView");
  buildJoinView();

  $("#switchTrip").onclick = () => {
    clearSavedTrip();
    if (unsub) { unsub(); unsub = null; }
    $("#tripBadge").hidden = true;
    show("joinView");
  };
  $("#copyCode").onclick = async () => {
    await navigator.clipboard.writeText($("#tripCode").textContent);
    $("#copyCode").textContent = "已複製";
    setTimeout(() => ($("#copyCode").textContent = "複製"), 1500);
  };

  try {
    await ensureAuth();
  } catch (err) {
    show("joinView");
    showError("無法建立身份：" + humanError(err) + "（請確認 Supabase 已開啟匿名登入）");
    return;
  }

  // 若本機記得上次行程，且自己仍是成員，直接進入
  const saved = getSavedTrip();
  if (saved?.id) {
    try {
      const me = await getMyMember(saved.id);
      if (me) { await enterTrip(saved.id); return; }
    } catch { /* 落到加入畫面 */ }
  }
  show("joinView");
}

boot();
