// Phase 1 控制器：路由（加入畫面 ↔ 行程主畫面）、表單、即時成員/幣別。
import { login, logout, getSession, getProfile, onAuthChange } from "./auth.js";
import {
  CURRENCIES, CURRENCY_CODES, currencyLabel, pickColor, fmtMoney, ZERO_DECIMAL,
} from "./constants.js";
import { getRates, rateToBase } from "./fx.js";
import {
  listItems, addItem, updateItem, deleteItem, subscribeItinerary,
} from "./itinerary.js";
import {
  listExpenses, addExpense, updateExpense, deleteExpense, subscribeExpenses,
} from "./expenses.js";
import {
  listPacking, addPacking, updatePacking, deletePacking, subscribePacking,
} from "./packing.js";
import { computeBalances, currencyTotals, settleUp, splitEqually } from "./settle.js";
import { loadItineraryWeather, loadCityWeather, getWeatherSummaries } from "./weather.js";
import { callAI } from "./ai.js";
import {
  getSavedTrip, saveTrip, clearSavedTrip,
  createTrip, getTrip, getMyMember,
  listMembers, getTripCurrencies, addTripCurrency, removeTripCurrency,
  updateBaseCurrency, subscribeTrip, listMyTrips, deleteTrip,
  provisionMember, removeMember, updateTrip, adminAction,
  setTripAdmin, setMemberCanEdit,
} from "./trip.js";

const $ = (s) => document.querySelector(s);
// 安全寫入：節點不存在就略過（避免快取到舊版 HTML 時整頁崩潰）
const setText = (sel, v) => { const el = $(sel); if (el) el.textContent = v; };
const setHTML = (sel, v) => { const el = $(sel); if (el) el.innerHTML = v; };
const setHidden = (sel, v) => { const el = $(sel); if (el) el.hidden = v; };
const { DEFAULT_BASE_CURRENCY, DEFAULT_CURRENCIES } = window.APP_CONFIG;

let unsub = null;       // 行程/成員 realtime 取消訂閱
let unsubItin = null;   // 行程項目 realtime 取消訂閱
let unsubExp = null;    // 記帳 realtime 取消訂閱
let unsubPacking = null; // 行李 realtime 取消訂閱
let createCurrencies = new Set(); // 建立行程時已選的幣別
let adminTrips = [];              // 管理頁目前的行程清單（指派行程彈窗用）
const state = {
  trip: null, me: null, activeDay: null, mapInit: false,
  members: [], currencies: [], splitSel: new Set(), weatherLoaded: false,
  profile: null, // 登入者 profile（含 is_admin）
};
const isAdmin = () => !!state.profile?.is_admin;
// 目前使用者能否編輯這趟（成員且可編輯，或行程管理員）。非成員（如全域 admin 旁觀）= 唯讀。
const canEdit = () => !!(state.me && (state.me.can_edit || state.me.is_admin));
// 寫入動作前的守門：唯讀就提示並擋下
function guardEdit() {
  if (canEdit()) return true;
  toast("你是唯讀成員，無法編輯", false);
  return false;
}

// ---------- 分頁路由（桌機側欄 + 手機底部分頁列共用 data-page）----------
const PAGES = ["overview", "itinerary", "expenses", "weather", "packing", "admin"];

function showPage(name) {
  if (!PAGES.includes(name)) name = "overview";
  if (name === "admin" && !isAdmin()) name = "overview";        // 管理頁僅管理員
  if (!state.trip && name !== "overview" && name !== "admin") name = "overview"; // 沒選行程只能看總覽/管理
  PAGES.forEach((p) => ($("#view-" + p).hidden = p !== name));
  document.querySelectorAll(".nav-item, .tab-item").forEach((b) => b.classList.toggle("is-active", b.dataset.page === name));
  if (location.hash.slice(1) !== name) history.replaceState(null, "", "#" + name);
  closePopovers();
  if (name === "weather") ensureWeather();
  if (name === "packing") renderPacking(state.trip).catch(console.error);
  if (name === "admin") renderAdmin();
}

// ---------- 頂部：行程切換器 + 帳號選單（popover）----------
function closePopovers() {
  const tm = $("#tripMenu"); if (tm) tm.hidden = true;
  const am = $("#accountMenu"); if (am) am.hidden = true;
}

// 頂部切換器文字 / 顯隱（標題只出現在頂部一處）
function renderTripSwitcher() {
  setHidden("#tripSwitcher", !state.trip);
  setText("#tripSwitcherTitle", state.trip ? state.trip.title : "");
}

async function openTripMenu() {
  const menu = $("#tripMenu");
  if (!menu.hidden) { menu.hidden = true; return; }
  $("#accountMenu").hidden = true;
  menu.innerHTML = `<div class="popover-head">載入中…</div>`;
  menu.hidden = false;
  let trips = [];
  try { trips = await listMyTrips(); } catch { /* ignore */ }
  const cur = state.trip?.id;
  let html = `<div class="popover-head">切換行程</div>`;
  html += trips.length ? trips.map((t) => `
    <button class="popover-item ${t.id === cur ? "is-current" : ""}" type="button" data-go="${t.id}">
      ${escapeHtml(t.title)}
      <span class="sub">${t.start_date ? t.start_date + (t.end_date ? " ~ " + t.end_date : "") : "未設定日期"}</span>
    </button>`).join("") : `<div class="popover-head">尚無行程</div>`;
  if (isAdmin()) html += `<div class="popover-sep"></div><button class="popover-item" type="button" data-admin="1">⚙️ 管理行程與帳號</button>`;
  menu.innerHTML = html;
  menu.querySelectorAll("[data-go]").forEach((b) => (b.onclick = () => {
    closePopovers();
    const t = trips.find((x) => x.id === b.dataset.go);
    if (!t || t.id === cur) return;
    saveTrip(t); enterTrip(t.id).catch((e) => toast(humanError(e), false));
  }));
  const adminBtn = menu.querySelector("[data-admin]");
  if (adminBtn) adminBtn.onclick = () => { closePopovers(); showPage("admin"); };
}

function openAccountMenu() {
  const menu = $("#accountMenu");
  if (!menu.hidden) { menu.hidden = true; return; }
  $("#tripMenu").hidden = true;
  const p = state.profile;
  const name = p ? (p.username || p.email || "使用者") : "使用者";
  menu.innerHTML = `
    <div class="popover-head">${escapeHtml(name)}${isAdmin() ? "（管理員）" : ""}</div>
    <div class="popover-sep"></div>
    <button class="popover-item" type="button" data-logout="1">登出</button>`;
  menu.querySelector("[data-logout]").onclick = async () => { closePopovers(); await logout(); showLogin(); };
  menu.hidden = false;
}

async function ensureWeather(force = false) {
  if (state.weatherLoaded && !force) return;
  state.weatherLoaded = true;
  try {
    const items = await listItems(state.trip.id);
    await loadItineraryWeather(items);
  } catch (e) {
    $("#forecastGrid").innerHTML = `<p class="status" data-ok="false">${humanError(e)}</p>`;
  }
}

async function onAiWeather() {
  const out = $("#aiWeatherOut");
  let days = getWeatherSummaries();
  if (!days.length) { await ensureWeather(true); days = getWeatherSummaries(); }
  if (!days.length) {
    out.innerHTML = `<p class="status">目前沒有可用天氣資料，請先在行程加入地點或手動查城市。</p>`;
    return;
  }
  out.classList.add("loading"); out.textContent = "AI 思考中…";
  try {
    const { text } = await callAI("weather_suggest", { trip: { title: state.trip.title }, days });
    out.classList.remove("loading"); out.textContent = text || "（沒有回應）";
  } catch (e) {
    out.classList.remove("loading");
    out.innerHTML = `<p class="status" data-ok="false">AI 失敗：${humanError(e)}</p>`;
  }
}

// ---------- 視圖切換 ----------
function show(view) {
  for (const id of ["bootView", "loginView", "appView"]) $("#" + id).hidden = id !== view;
}

// ---------- 建立行程 Modal（僅管理員）----------
function openTripModal() {
  showError("");
  $("#tripModal").hidden = false;
  syncDateFaces($("#tripModal"));   // 要在顯示之後才量得到寬度
}
function closeTripModal() { $("#tripModal").hidden = true; }

function showError(msg) {
  const el = $("#joinError");
  el.textContent = msg;
  el.hidden = !msg;
}

// ---------- 建立行程表單 ----------
function buildJoinView() {
  // 基準幣別下拉（全世界）
  const baseSel = $('#createForm select[name="base"]');
  baseSel.innerHTML = CURRENCY_CODES.map(
    (c) => `<option value="${c}" ${c === DEFAULT_BASE_CURRENCY ? "selected" : ""}>${currencyLabel(c)}</option>`
  ).join("");
  baseSel.onchange = () => renderCreateCurrencyPicker(); // 基準改了，chip 標記跟著更新

  // 啟用幣別：可點選的 chip（手機友善），預設帶入 DEFAULT_CURRENCIES
  createCurrencies = new Set(DEFAULT_CURRENCIES);
  renderCreateCurrencyPicker();
  $("#createAddCurrencyBtn").onclick = () => {
    const v = $("#createAddCurrency").value;
    if (v) { createCurrencies.add(v); renderCreateCurrencyPicker(); }
  };

  $("#createForm").addEventListener("submit", onCreateSubmit);
}

// 建立行程的幣別 chip 選擇器（點 chip 移除、下拉新增）
function renderCreateCurrencyPicker() {
  const base = $('#createForm select[name="base"]').value;
  const chips = $("#createCurrencyChips");
  const codes = [...createCurrencies];
  chips.innerHTML = codes.length
    ? codes.map((c) => {
        const isBase = c === base;
        return `<span class="pill ${isBase ? "pill--base" : ""}">
          <span>${CURRENCIES[c]?.flag || ""} ${c}${isBase ? " · 基準" : ""}</span>
          ${isBase ? "" : `<button class="pill-x" type="button" data-cc-remove="${c}">×</button>`}
        </span>`;
      }).join("")
    : `<span class="status">尚未選擇</span>`;
  chips.querySelectorAll("[data-cc-remove]").forEach((b) => {
    b.onclick = () => { createCurrencies.delete(b.dataset.ccRemove); renderCreateCurrencyPicker(); };
  });

  const avail = CURRENCY_CODES.filter((c) => !createCurrencies.has(c));
  const sel = $("#createAddCurrency");
  sel.innerHTML = avail.length
    ? avail.map((c) => `<option value="${c}">${currencyLabel(c)}</option>`).join("")
    : `<option value="">已全部加入</option>`;
  $("#createAddCurrencyBtn").disabled = !avail.length;
}

async function onCreateSubmit(e) {
  e.preventDefault();
  showError("");
  const f = e.target;
  const currencies = [...createCurrencies];
  const base = f.base.value;
  if (!currencies.includes(base)) currencies.push(base); // 基準幣別一定要啟用
  const join = $("#tripJoinSelf") ? $("#tripJoinSelf").checked : true;
  if (join && !f.name.value.trim()) { showError("請填你的名字（管理員），或取消「我要一起參加」。"); return; }
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
      code: null, // 行程碼已不對外使用；交由後端自動產生內部碼
      join,
    });
    saveTrip(trip);
    closeTripModal();
    if (join) {
      await enterTrip(trip.id);
    } else {
      // 自己不參加：不進這趟，回管理頁繼續指派家人
      toast("已建立行程（你未加入）。請在「指派行程」把家人加進來。");
      if (!$("#view-admin").hidden) await renderAdmin();
    }
  } catch (err) {
    showError(humanError(err));
  } finally {
    setBusy(f, false);
  }
}

// ---------- 行程主畫面 ----------
async function enterTrip(tripId) {
  if (unsub) { unsub(); unsub = null; }
  if (unsubItin) { unsubItin(); unsubItin = null; }
  if (unsubExp) { unsubExp(); unsubExp = null; }
  if (unsubPacking) { unsubPacking(); unsubPacking = null; }
  const trip = await getTrip(tripId);
  state.trip = trip;
  state.me = await getMyMember(tripId);
  state.mapInit = false;   // 進新行程時重設地圖預設
  const frame = $("#mapFrame");
  if (frame) { frame.hidden = true; frame.removeAttribute("src"); }
  setText("#mapTitle", "點行程項目的「地圖」即可在此顯示");
  state.weatherLoaded = false;
  await renderTrip(trip);
  await renderItinerary(trip);
  await renderExpenses(trip);

  document.body.classList.add("in-trip");
  show("appView");
  // 頂部行程切換器顯示目前行程（標題只出現在頂部一處）
  renderTripSwitcher();
  renderOverviewState();
  renderMyTrips(await listMyTrips());
  // 進入時依 hash 決定起始頁
  showPage(PAGES.includes(location.hash.slice(1)) ? location.hash.slice(1) : "overview");

  // 即時：成員/幣別變動就重畫
  unsub = subscribeTrip(tripId, () => renderTrip(trip).catch(console.error));
  // 即時：行程項目變動就重畫（天氣只標記失效，下次開或按重新整理才重載，避免座標回寫造成連環重載）
  unsubItin = subscribeItinerary(tripId, () => {
    state.weatherLoaded = false;
    renderItinerary(trip).catch(console.error);
    renderDashboard().catch(() => {});
  });
  // 即時：記帳變動就重畫
  unsubExp = subscribeExpenses(tripId, () => {
    renderExpenses(trip).catch(console.error);
    renderDashboard().catch(() => {});
  });
  // 即時：行李變動就重畫
  unsubPacking = subscribePacking(tripId, () => {
    renderPacking(trip).catch(console.error);
  });
}

async function renderTrip(trip) {
  const [members, currencies] = await Promise.all([
    listMembers(trip.id),
    getTripCurrencies(trip.id),
  ]);
  const me = await getMyMember(trip.id);
  state.members = members;
  state.currencies = currencies;
  state.me = me;
  const canManage = !!me?.is_admin;   // 行程管理員可管理名單/權限

  // 成員（管理員可移除/設權限；未登入者標示）。新增成員帳號統一在「管理」頁。
  setText("#memberCount", `（${members.length} 人）`);
  const memberListEl = $("#memberList");
  if (memberListEl) {
    memberListEl.innerHTML = members.map((m) => {
      const isMe = me && m.id === me.id;
      const readOnly = !m.is_admin && m.can_edit === false;
      const roleTag = m.is_admin ? ' <span class="tag">管理員</span>'
        : readOnly ? ' <span class="tag">唯讀</span>' : "";
      const manageBtns = (canManage && !isMe) ? `
        ${m.is_admin ? "" : `<button class="btn btn--ghost btn--sm" type="button" data-set-admin="${m.id}" data-name="${escapeAttr(m.display_name)}">設管理員</button>`}
        ${m.is_admin ? "" : `<button class="btn btn--ghost btn--sm" type="button" data-toggle-edit="${m.id}" data-can="${m.can_edit === false ? 0 : 1}">${m.can_edit === false ? "設可編輯" : "設唯讀"}</button>`}
        <button class="pill-x" type="button" data-rm-member="${m.id}" data-name="${escapeAttr(m.display_name)}" title="移除">×</button>` : "";
      return `<div class="member-chip">
        <span class="avatar" style="background:${m.color}">${(m.display_name || "?").slice(0, 1)}</span>
        <span>${escapeHtml(m.display_name)}${roleTag}${isMe ? " <small class='status'>(你)</small>" : ""}${m.auth_uid ? "" : " <small class='status'>未登入</small>"}</span>
        ${manageBtns}
      </div>`;
    }).join("");
    memberListEl.querySelectorAll("[data-rm-member]").forEach((b) =>
      (b.onclick = () => onRemoveMember(b.dataset.rmMember, b.dataset.name)));
    memberListEl.querySelectorAll("[data-set-admin]").forEach((b) =>
      (b.onclick = () => onSetTripAdmin(b.dataset.setAdmin, b.dataset.name)));
    memberListEl.querySelectorAll("[data-toggle-edit]").forEach((b) =>
      (b.onclick = () => onToggleCanEdit(b.dataset.toggleEdit, b.dataset.can === "0")));
  }

  // 幣別
  renderBaseSelect(trip);
  renderCurrencyPills(trip, currencies);
  renderAddCurrency(trip, currencies);

  // 依編輯權限隱藏/顯示寫入按鈕（唯讀成員只看不改）
  applyPerms();

  // 總覽儀表板（摘要 / 統計 / 接下來的行程）
  renderDashboard().catch(() => {});
}

// 依目前使用者的編輯權限切換寫入入口的顯示。RLS 才是最終把關，這裡只是體驗層。
function applyPerms() {
  const editable = canEdit();
  document.body.classList.toggle("readonly", !editable);
  // 各分頁主要寫入按鈕（不存在就略過）
  ["#addItemBtn", "#aiItinBtn", "#addExpenseBtn", "#addPackingBtn", "#aiPackingBtn"]
    .forEach((sel) => setHidden(sel, !editable));
  // 基準幣別下拉：唯讀時停用（保留標籤文字）
  const baseSel = $("#baseSelect"); if (baseSel) baseSel.disabled = !editable;
  // 記帳語意輸入列（含輸入框）
  const nl = $("#nlExpenseInput"); if (nl) { const row = nl.closest(".add-currency"); if (row) row.hidden = !editable; }
  // 幣別新增列
  const addCur = $("#addCurrencySelect"); if (addCur) { const row = addCur.closest(".add-currency"); if (row) row.hidden = !editable; }
}

// 設某成員為行程管理員
async function onSetTripAdmin(memberId, name) {
  if (!await confirmDialog({ title: "設為行程管理員", body: `把「${name}」設為這趟的管理員？原管理員會被取消。`, okText: "設定" })) return;
  try {
    await setTripAdmin(state.trip.id, memberId);
    toast("已更新行程管理員");
    await renderTrip(state.trip);
  } catch (e) { toast(humanError(e), false); }
}

// 切換某成員可編輯 / 唯讀
async function onToggleCanEdit(memberId, canEditNext) {
  try {
    await setMemberCanEdit(memberId, canEditNext);
    toast(canEditNext ? "已設為可編輯" : "已設為唯讀");
    await renderTrip(state.trip);
  } catch (e) { toast(humanError(e), false); }
}

// ---------- 總覽儀表板 ----------
function daysBetween(a, b) {
  return Math.round((new Date(b + "T00:00:00") - new Date(a + "T00:00:00")) / 86400000);
}
function tripSummaryHtml(trip) {
  if (!trip.start_date) return `<span class="status">尚未設定日期，到「管理」頁編輯行程可加上日期。</span>`;
  const start = trip.start_date, end = trip.end_date || trip.start_date;
  const totalDays = daysBetween(start, end) + 1;
  const today = todayStr();
  let badge;
  if (today < start) badge = `距出發 ${daysBetween(today, start)} 天`;
  else if (today > end) badge = "已結束";
  else badge = `旅程進行中 · 第 ${daysBetween(start, today) + 1} 天`;
  const range = end === start ? start : `${start} – ${end}`;
  return `<span>${range}</span><span class="ts-dot">·</span><span>${totalDays} 天</span><span class="ts-badge">${badge}</span>`;
}
function upcomingHtml(items) {
  if (!items.length) return `<p class="status">還沒有行程項目，到「行程」頁新增，或用 AI 排行程。</p>`;
  const dated = items.filter((i) => i.day_date)
    .sort((a, b) => ((a.day_date + (a.start_time || "")) < (b.day_date + (b.start_time || "")) ? -1 : 1));
  if (!dated.length) return `<p class="status">行程項目尚未排定日期。</p>`;
  const today = todayStr();
  let pick = dated.filter((i) => i.day_date >= today);
  if (!pick.length) pick = dated;            // 全部過去 → 顯示整體前幾筆
  return pick.slice(0, 4).map((it) => `
    <div class="up-row">
      <span class="up-date">${it.day_date.slice(5)}${it.start_time ? " " + it.start_time.slice(0, 5) : ""}</span>
      <span class="up-title">${CATEGORY_ICON[it.category] || "•"} ${escapeHtml(it.title)}</span>
    </div>`).join("");
}
async function renderDashboard() {
  const trip = state.trip;
  if (!trip) return;
  setHTML("#tripSummary", tripSummaryHtml(trip));
  setText("#statMembers", state.members.length || "–");
  let items = [], expenses = [];
  try { items = await listItems(trip.id); } catch { /* ignore */ }
  try { expenses = await listExpenses(trip.id); } catch { /* ignore */ }
  setText("#statItems", items.length);
  const { base: baseTotal } = currencyTotals(expenses);
  setText("#statSpend", fmtMoney(baseTotal, trip.base_currency));
  setHTML("#upcomingList", upcomingHtml(items));
}

// 切換「有/無選定行程」的總覽呈現 + 分頁可用性（側欄與底部列同步）
function renderOverviewState() {
  const has = !!state.trip;
  $("#overviewTripDetail").hidden = !has;
  $("#noTripHint").hidden = has;
  renderTripSwitcher();
  // 沒選行程時，行程/記帳/天氣分頁不可用；總覽與管理頁永遠可用
  document.querySelectorAll(".nav-item, .tab-item").forEach((b) => {
    if (b.dataset.page !== "overview" && b.dataset.page !== "admin") b.classList.toggle("is-disabled", !has);
  });
}

// 開「新增成員帳號」Modal。withTripSelect=true（管理頁）：顯示行程下拉；否則指派到目前行程。
async function openMemberModal(withTripSelect = false) {
  const f = $("#memberForm");
  f.reset();
  $("#memberError").hidden = true;
  const row = $("#memberTripRow");
  if (withTripSelect) {
    let trips = [];
    try { trips = await listMyTrips(); } catch { /* ignore */ }
    $("#memberTripSelect").innerHTML = `<option value="">（先不指派）</option>` +
      trips.map((t) => `<option value="${t.id}">${escapeHtml(t.title)}</option>`).join("");
    row.hidden = false;
  } else {
    row.hidden = true;
  }
  $("#memberModal").hidden = false;
}
function onAdminAddMember() { openMemberModal(true); }    // 管理頁：建立帳號並可選行程

async function onMemberSubmit(e) {
  e.preventDefault();
  const f = e.target;
  const err = $("#memberError");
  err.hidden = true;
  const display_name = f.display_name.value.trim();
  const username = f.username.value.trim().toLowerCase();
  const password = f.password.value;
  if (!display_name || !username || !password) return;
  const tripId = $("#memberTripRow").hidden ? state.trip?.id : ($("#memberTripSelect").value || null);
  try {
    setBusy(f, true);
    await provisionMember(tripId, {
      display_name, username, password,
      color: pickColor(state.members.map((m) => m.color)),
    });
    $("#memberModal").hidden = true;
    if (!$("#view-admin").hidden) await renderAdmin();
    if (state.trip) await renderTrip(state.trip);
  } catch (e2) {
    err.textContent = humanError(e2); err.hidden = false;
  } finally {
    setBusy(f, false);
  }
}

// ---------- 管理頁 ----------
async function renderAdmin() {
  const uBox = $("#adminUsersList");
  const tBox = $("#adminTripsList");
  uBox.innerHTML = `<p class="status">載入中…</p>`;
  let trips = [];
  try { trips = await listMyTrips(); } catch { /* ignore */ }
  adminTrips = trips; // 給指派行程彈窗用

  // 行程管理
  tBox.innerHTML = trips.length ? trips.map((t) => `
    <div class="admin-row">
      <div class="admin-row-main">
        <strong>${escapeHtml(t.title)}</strong>
        <span class="status">${t.start_date ? t.start_date + " ~ " + (t.end_date || "?") : "未設定日期"}</span>
      </div>
      <div class="admin-row-actions">
        <button class="btn btn--ghost btn--sm" data-enter-trip="${t.id}">進入</button>
        <button class="btn btn--ghost btn--sm" data-edit-trip="${t.id}">編輯</button>
        <button class="btn btn--ghost btn--sm" data-del-trip="${t.id}" data-title="${escapeAttr(t.title)}">刪除</button>
      </div>
    </div>`).join("") : `<p class="status">還沒有行程，按「＋ 建立行程」。</p>`;
  tBox.querySelectorAll("[data-enter-trip]").forEach((b) => (b.onclick = () => {
    const t = trips.find((x) => x.id === b.dataset.enterTrip); saveTrip(t); enterTrip(t.id).catch((e) => toast(humanError(e), false));
  }));
  tBox.querySelectorAll("[data-edit-trip]").forEach((b) => (b.onclick = () => openTripEdit(trips.find((x) => x.id === b.dataset.editTrip))));
  tBox.querySelectorAll("[data-del-trip]").forEach((b) => (b.onclick = () => onDeleteTrip(b.dataset.delTrip, b.dataset.title).then(() => renderAdmin())));

  // 帳號管理
  try {
    const { users } = await adminAction("list_users");
    const tripTitle = (id) => trips.find((t) => t.id === id)?.title || "?";
    uBox.innerHTML = (users || []).map((u) => `
      <div class="admin-row">
        <div class="admin-row-main">
          <strong>${escapeHtml(u.username || u.email || "?")}</strong>${u.is_admin ? ' <span class="tag">管理員</span>' : ""}
          <span class="status">${escapeHtml(u.email || "")}</span>
          <div class="admin-trips">${(u.trips || []).map((t) => {
            const roleTag = t.is_admin ? ' <span class="tag">管理員</span>'
              : (t.can_edit === false ? ' <span class="tag">唯讀</span>' : '');
            const ctrls = u.is_admin ? '' : `
              ${t.is_admin || !t.member_id ? '' : `<button class="btn btn--ghost btn--sm" data-trip-setadmin="${t.id}|${t.member_id}" data-name="${escapeAttr(t.title)}">設管理員</button>`}
              ${t.is_admin || !t.member_id ? '' : `<button class="btn btn--ghost btn--sm" data-trip-canedit="${t.member_id}|${t.can_edit === false ? 1 : 0}">${t.can_edit === false ? '設可編輯' : '設唯讀'}</button>`}
              <button class="pill-x" data-unassign="${u.id}|${t.id}" title="移出">×</button>`;
            return `<span class="pill">${escapeHtml(t.title)}${roleTag} ${ctrls}</span>`;
          }).join("") || '<span class="status">未指派任何行程</span>'}</div>
        </div>
        <div class="admin-row-actions">
          ${u.is_admin ? "" : `<button class="btn btn--ghost btn--sm" data-assign="${u.id}" data-name="${escapeAttr(u.username || u.email)}">指派行程</button>`}
          <button class="btn btn--ghost btn--sm" data-reset="${u.id}" data-name="${escapeAttr(u.username || u.email)}">重設密碼</button>
          ${u.is_admin ? "" : `<button class="btn btn--ghost btn--sm" data-deluser="${u.id}" data-name="${escapeAttr(u.username || u.email)}">刪除</button>`}
        </div>
      </div>`).join("") || `<p class="status">尚無帳號。</p>`;

    uBox.querySelectorAll("[data-unassign]").forEach((b) => (b.onclick = async () => {
      const [user_id, trip_id] = b.dataset.unassign.split("|");
      if (!await confirmDialog({ title: "移出行程", body: `把此帳號從「${tripTitle(trip_id)}」移出？`, danger: true, okText: "移出" })) return;
      try { await adminAction("unassign_trip", { user_id, trip_id }); toast("已移出"); await renderAdmin(); } catch (e) { toast(humanError(e), false); }
    }));
    uBox.querySelectorAll("[data-trip-setadmin]").forEach((b) => (b.onclick = async () => {
      const [trip_id, member_id] = b.dataset.tripSetadmin.split("|");
      if (!await confirmDialog({ title: "設為行程管理員", body: `把此帳號設為「${b.dataset.name}」的管理員？原管理員會被取消。`, okText: "設定" })) return;
      try { await adminAction("set_trip_admin", { trip_id, member_id }); toast("已設定管理員"); await renderAdmin(); } catch (e) { toast(humanError(e), false); }
    }));
    uBox.querySelectorAll("[data-trip-canedit]").forEach((b) => (b.onclick = async () => {
      const [member_id, canNext] = b.dataset.tripCanedit.split("|");
      try { await adminAction("set_member_can_edit", { member_id, can_edit: canNext === "1" }); toast(canNext === "1" ? "已設為可編輯" : "已設為唯讀"); await renderAdmin(); } catch (e) { toast(humanError(e), false); }
    }));
    uBox.querySelectorAll("[data-assign]").forEach((b) => (b.onclick = () =>
      openAssignTrip(b.dataset.assign, b.dataset.name)));
    uBox.querySelectorAll("[data-reset]").forEach((b) => (b.onclick = () =>
      openResetPw(b.dataset.reset, b.dataset.name)));
    uBox.querySelectorAll("[data-deluser]").forEach((b) => (b.onclick = async () => {
      if (!await confirmDialog({ title: "刪除帳號", body: `刪除帳號「${b.dataset.name}」？此動作無法復原。`, danger: true, okText: "刪除" })) return;
      try { await adminAction("delete_user", { user_id: b.dataset.deluser }); toast("已刪除帳號"); await renderAdmin(); } catch (e) { toast(humanError(e), false); }
    }));
  } catch (e) {
    uBox.innerHTML = `<p class="status" data-ok="false">${humanError(e)}</p>`;
  }
}

// 編輯行程 Modal
function openTripEdit(trip) {
  if (!trip) return;
  const f = $("#tripEditForm");
  f.reset(); $("#tripEditError").hidden = true;
  f.id.value = trip.id;
  f.title.value = trip.title || "";
  f.start.value = trip.start_date || "";
  f.end.value = trip.end_date || "";
  $("#tripEditModal").hidden = false;
  syncDateFaces($("#tripEditModal"));
}
async function onTripEditSubmit(e) {
  e.preventDefault();
  const f = e.target; const err = $("#tripEditError"); err.hidden = true;
  try {
    setBusy(f, true);
    await updateTrip(f.id.value, {
      title: f.title.value.trim(), start_date: f.start.value || null, end_date: f.end.value || null,
    });
    $("#tripEditModal").hidden = true;
    await renderAdmin();
    if (state.trip?.id === f.id.value) { state.trip = await getTrip(f.id.value); renderTrip(state.trip); }
  } catch (e2) { err.textContent = humanError(e2); err.hidden = false; }
  finally { setBusy(f, false); }
}

// 指派行程 Modal
function openAssignTrip(user_id, name) {
  const f = $("#assignTripForm");
  f.reset(); $("#assignTripError").hidden = true;
  f.user_id.value = user_id;
  $("#assignTripUser").textContent = name || "";
  $("#assignTripSelect").innerHTML = adminTrips.length
    ? adminTrips.map((t) => `<option value="${t.id}">${escapeHtml(t.title)}</option>`).join("")
    : `<option value="">尚無行程可指派</option>`;
  $("#assignTripModal").hidden = false;
}
async function onAssignTripSubmit(e) {
  e.preventDefault();
  const f = e.target; const err = $("#assignTripError"); err.hidden = true;
  const trip_id = $("#assignTripSelect").value;
  if (!trip_id) { err.textContent = "請先選擇行程"; err.hidden = false; return; }
  try {
    setBusy(f, true);
    await adminAction("assign_trip", { user_id: f.user_id.value, trip_id });
    $("#assignTripModal").hidden = true;
    toast("已指派行程");
    await renderAdmin();
  } catch (e2) { err.textContent = humanError(e2); err.hidden = false; }
  finally { setBusy(f, false); }
}

// 重設密碼 Modal
function openResetPw(user_id, name) {
  const f = $("#resetPwForm");
  f.reset(); $("#resetPwError").hidden = true;
  f.user_id.value = user_id;
  $("#resetPwUser").textContent = name || "";
  $("#resetPwModal").hidden = false;
}
async function onResetPwSubmit(e) {
  e.preventDefault();
  const f = e.target; const err = $("#resetPwError"); err.hidden = true;
  const password = f.password.value;
  if (!password || password.length < 6) { err.textContent = "密碼至少 6 碼"; err.hidden = false; return; }
  try {
    setBusy(f, true);
    await adminAction("reset_password", { user_id: f.user_id.value, password });
    $("#resetPwModal").hidden = true;
    toast("已重設密碼");
  } catch (e2) { err.textContent = humanError(e2); err.hidden = false; }
  finally { setBusy(f, false); }
}

async function onRemoveMember(id, name) {
  if (!await confirmDialog({ title: "移除成員", body: `移除成員「${name}」？\n（若對方已記帳，相關記錄的關聯會被清除）`, danger: true, okText: "移除" })) return;
  try {
    await removeMember(id);
    toast("已移除成員");
    await renderTrip(state.trip);
  } catch (e) { toast(humanError(e), false); }
}

// ---------- 登入 / 註冊 ----------
function loginError(m) { const el = $("#loginError"); el.textContent = m; el.hidden = !m; }
function loginErr(err) {
  const m = err?.message || String(err);
  if (/Invalid login credentials/i.test(m)) return "帳號或密碼錯誤。";
  if (/already.*regist/i.test(m)) return "這個 Email 已註冊，請直接登入。";
  if (/confirm/i.test(m)) return "帳號需 Email 驗證；請到 Supabase 關閉 Confirm email，或收信完成驗證。";
  if (/Password should be/i.test(m)) return "密碼至少 6 碼。";
  return m;
}
function showLogin() {
  document.body.classList.remove("in-trip");
  closePopovers();
  state.profile = null; state.trip = null;
  $("#tripSwitcher").hidden = true; $("#tripSwitcherTitle").textContent = "";
  $("#accountBtn").hidden = true;
  $("#loginForm").hidden = false;
  loginError("");
  show("loginView");
}
async function onLoginSubmit(e) {
  e.preventDefault(); loginError("");
  const f = e.target;
  try { setBusy(f, true); await login(f.account.value, f.password.value); await onLoggedIn(); }
  catch (err) { loginError(loginErr(err)); }
  finally { setBusy(f, false); }
}
function applyAccountUI() {
  const p = state.profile;
  const name = p ? (p.username || p.email || "使用者") : "";
  setText("#drawerAccount", p ? `${name}${isAdmin() ? "（管理員）" : ""}` : "");
  // 頂部帳號鈕（手機登出入口）
  setHidden("#accountBtn", !p);
  setText("#accountInitial", (name || "·").slice(0, 1).toUpperCase());
  // 管理頁入口（側欄 + 底部列同步）
  document.querySelectorAll('.nav-item[data-page="admin"], .tab-item[data-page="admin"]')
    .forEach((el) => (el.hidden = !isAdmin()));
}
async function onLoggedIn() {
  try { state.profile = await getProfile(); } catch { state.profile = null; }
  const saved = getSavedTrip();
  if (saved?.id) {
    try { const me = await getMyMember(saved.id); if (me) { await enterTrip(saved.id); applyAccountUI(); return; } } catch { /* fall through */ }
  }
  await showHub();
  applyAccountUI();
}

// ---------- AI 建議行程 ----------
function openAiItin() {
  if (!guardEdit()) return;
  $("#aiItinOut").innerHTML = "";
  $("#aiItinPrefs").value = "";
  // 規劃範圍：整趟 + 每一天。預設帶入目前正在看的那一天，避免一次蓋掉整趟。
  const days = tripDayRange();
  const sel = $("#aiItinDay");
  sel.innerHTML = `<option value="">整趟（所有日期）</option>` +
    days.map((d) => `<option value="${d}">${dayLabel(d)}</option>`).join("");
  sel.value = (state.activeDay && days.includes(state.activeDay)) ? state.activeDay : "";
  $("#aiItinModal").hidden = false;
}
function tripDayRange() {
  const t = state.trip;
  if (!t?.start_date) return [];
  const out = []; const d = new Date(t.start_date + "T00:00:00");
  const end = new Date((t.end_date || t.start_date) + "T00:00:00");
  // 用本地日期字串，避免 toISOString() 在 UTC+8 把日期往前推一天（少一天）
  while (d <= end) { out.push(ymd(d)); d.setDate(d.getDate() + 1); }
  return out;
}
async function onAiItinGo() {
  const out = $("#aiItinOut");
  out.innerHTML = `<p class="status">AI 規劃中…</p>`;
  try {
    const items = await listItems(state.trip.id);
    const onlyDay = $("#aiItinDay").value;            // 空 = 整趟
    let days = onlyDay ? [onlyDay] : tripDayRange();
    if (!days.length) days = [...new Set(items.map((i) => i.day_date).filter(Boolean))];
    const area = items.find((i) => i.weather_area)?.weather_area || "";
    const { items: raw } = await callAI("suggest_itinerary", {
      trip: { title: state.trip.title, start: state.trip.start_date, end: state.trip.end_date },
      area, days, only_day: onlyDay || null,
      existing: items.map((i) => i.title), notes: $("#aiItinPrefs").value.trim(),
    });
    // 指定某天時，前端再保險過濾：只留該天（缺日期者補上該天），確保不動到其他天
    const sug = (Array.isArray(raw) ? raw : []).filter((s) => s && s.title)
      .filter((s) => !onlyDay || !s.day_date || s.day_date === onlyDay)
      .map((s) => (onlyDay ? { ...s, day_date: onlyDay } : s));
    if (!sug.length) { out.innerHTML = `<p class="status">沒有建議，換個偏好再試。</p>`; return; }
    out.innerHTML = `
      <div class="ai-itin-bar">
        <span class="status">AI 建議 ${sug.length} 個項目${onlyDay ? "（僅 " + dayLabel(onlyDay) + "）" : ""}</span>
        <button class="btn btn--sm" type="button" id="aiAddAll">全部加入行程</button>
      </div>
      ${sug.map((s, idx) => `
      <div class="itin-item">
        <div class="itin-time">${s.day_date ? s.day_date.slice(5) : "·"}${s.start_time ? `<small>${escapeHtml(s.start_time)}</small>` : ""}</div>
        <div class="itin-body">
          <div class="itin-title">${CATEGORY_ICON[s.category] || "•"} ${escapeHtml(s.title || "")} ${s.category ? `<span class="tag">${escapeHtml(s.category)}</span>` : ""}</div>
          ${s.location_name ? `<div class="status">📍 ${escapeHtml(s.location_name)}</div>` : ""}
          ${s.note ? `<div class="itin-notes">${escapeHtml(s.note)}</div>` : ""}
        </div>
        <div class="itin-actions"><button class="btn btn--ghost btn--sm" data-add="${idx}">加入</button></div>
      </div>`).join("")}`;
    $("#aiAddAll").onclick = () => addAllAiItems(sug, $("#aiAddAll"));
    out.querySelectorAll("[data-add]").forEach((b) => (b.onclick = async () => {
      try {
        await addItem(state.trip.id, sugToItem(sug[Number(b.dataset.add)], Number(b.dataset.add)), state.me?.id);
        b.textContent = "已加入"; b.disabled = true;
        renderItinerary(state.trip).catch(() => {});
        renderDashboard().catch(() => {});
      } catch (e) { toast(humanError(e), false); }
    }));
  } catch (e) {
    out.innerHTML = `<p class="status" data-ok="false">${humanError(e)}</p>`;
  }
}

// AI 建議 → 行程項目（盡量帶齊欄位；不確定者留空）
function sugToItem(s, idx) {
  return {
    day_date: s.day_date || null,
    start_time: s.start_time || null,
    end_time: s.end_time || null,
    title: s.title,
    category: s.category || null,
    location_name: s.location_name || null,
    notes: s.note || null,
    sort_order: idx,
  };
}

// 一鍵把整份 AI 建議建立成行程
async function addAllAiItems(sug, btn) {
  if (!Array.isArray(sug) || !sug.length) return;
  const old = btn.textContent; btn.disabled = true; btn.textContent = "加入中…";
  let ok = 0;
  for (let i = 0; i < sug.length; i++) {
    if (!sug[i]?.title) continue;
    try { await addItem(state.trip.id, sugToItem(sug[i], i), state.me?.id); ok++; }
    catch { /* 略過單筆失敗，繼續其餘 */ }
  }
  await renderItinerary(state.trip).catch(() => {});
  renderDashboard().catch(() => {});
  $("#aiItinModal").hidden = true;
  toast(ok ? `已加入 ${ok} 筆行程` : "沒有可加入的項目", !!ok);
  if (ok) showPage("itinerary");
  btn.disabled = false; btn.textContent = old;
}

// ---------- 記帳語意輸入 ----------
async function onNlExpense() {
  if (!guardEdit()) return;
  const text = $("#nlExpenseInput").value.trim();
  if (!text) return;
  const btn = $("#nlExpenseBtn"); const old = btn.textContent;
  btn.disabled = true; btn.textContent = "解析中…";
  try {
    const { parsed } = await callAI("parse_expense", {
      text,
      members: state.members.map((m) => ({ id: m.id, name: m.display_name })),
      currencies: state.currencies, base: state.trip.base_currency,
    });
    const byName = (n) => {
      if (!n) return null;
      if (/^(我|自己|me)$/i.test(String(n).trim())) return state.me;
      return state.members.find((m) => m.display_name === n
        || m.display_name.toLowerCase() === String(n).toLowerCase());
    };
    openExpenseModal(null);
    const f = $("#expenseForm");
    if (parsed.description) f.description.value = parsed.description;
    if (parsed.amount != null) f.amount.value = parsed.amount;
    if (parsed.currency && state.currencies.includes(parsed.currency)) $("#expenseCurrency").value = parsed.currency;
    if (parsed.category) f.category.value = parsed.category;
    const payer = byName(parsed.paid_by);
    if (payer) $("#expensePayer").value = payer.id;
    if (Array.isArray(parsed.splits) && parsed.splits.length) {
      const ids = parsed.splits.map(byName).filter(Boolean).map((m) => m.id);
      if (ids.length) { state.splitSel = new Set(ids); renderSplitChips(); }
    }
    updateSplitHint();
    $("#nlExpenseInput").value = "";
  } catch (e) {
    toast("AI 解析失敗：" + humanError(e), false);
  } finally {
    btn.disabled = false; btn.textContent = old;
  }
}

function renderBaseSelect(trip) {
  const sel = $("#baseSelect");
  sel.innerHTML = CURRENCY_CODES.map(
    (c) => `<option value="${c}" ${c === trip.base_currency ? "selected" : ""}>${currencyLabel(c)}</option>`
  ).join("");
  sel.onchange = async () => {
    try {
      await updateBaseCurrency(trip.id, sel.value);
      trip.base_currency = sel.value;
      // 確保基準幣別已啟用
      const cur = await getTripCurrencies(trip.id);
      if (!cur.includes(sel.value)) await addTripCurrency(trip.id, sel.value);
      renderTrip(trip);
    } catch (err) { toast(humanError(err), false); }
  };
}

function renderCurrencyPills(trip, currencies) {
  const wrap = $("#currencyPills");
  wrap.innerHTML = currencies.map((c) => {
    const isBase = c === trip.base_currency;
    return `<span class="pill ${isBase ? "pill--base" : ""}">
      <span>${CURRENCIES[c]?.flag || ""} ${c}${isBase ? " · 基準" : ""}</span>
      <span class="rate" data-rate="${c}">${isBase ? "1.0000" : "…"}</span>
      ${isBase ? "" : `<button class="pill-x" data-remove="${c}" title="移除">×</button>`}
    </span>`;
  }).join("");
  wrap.querySelectorAll(".pill-x").forEach((b) => {
    b.onclick = async () => {
      try { await removeTripCurrency(trip.id, b.dataset.remove); renderTrip(trip); }
      catch (err) { toast(humanError(err), false); }
    };
  });

  // 即時匯率：顯示 1 單位該幣別 ≈ 多少基準幣別
  getRates(trip.base_currency).then((rates) => {
    wrap.querySelectorAll(".rate[data-rate]").forEach((el) => {
      const c = el.dataset.rate;
      if (c === trip.base_currency) { el.textContent = `1 ${c}`; return; }
      const r = rateToBase(c, rates, trip.base_currency);
      el.textContent = r ? `1${c}≈${r.toFixed(r < 0.01 ? 6 : 4)}${trip.base_currency}` : "—";
    });
  }).catch(() => {
    wrap.querySelectorAll(".rate[data-rate]").forEach((el) => { el.textContent = ""; });
  });
}

function renderAddCurrency(trip, currencies) {
  const avail = CURRENCY_CODES.filter((c) => !currencies.includes(c));
  const sel = $("#addCurrencySelect");
  sel.innerHTML = avail.length
    ? avail.map((c) => `<option value="${c}">${currencyLabel(c)}</option>`).join("")
    : `<option value="">已全部啟用</option>`;
  $("#addCurrencyBtn").disabled = !avail.length;
  $("#addCurrencyBtn").onclick = async () => {
    if (!sel.value) return;
    try { await addTripCurrency(trip.id, sel.value); renderTrip(trip); }
    catch (err) { toast(humanError(err), false); }
  };
}

// ---------- 行程項目 ----------
const CATEGORY_ICON = { 景點:"📍", 餐廳:"🍜", 交通:"🚆", 住宿:"🏨", 購物:"🛍️", 其他:"✨" };

function dayLabel(d) {
  if (!d) return "未排定";
  const wd = ["日","一","二","三","四","五","六"][new Date(d + "T00:00:00").getDay()];
  return `${d.slice(5)}（${wd}）`;
}

async function renderItinerary(trip) {
  const items = await listItems(trip.id);

  // 依日期分組
  const groups = new Map();
  for (const it of items) {
    const key = it.day_date || "";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(it);
  }
  const dayKeys = [...groups.keys()].sort((a, b) => (a === "" ? 1 : b === "" ? -1 : a < b ? -1 : 1));

  // 日期分頁
  const tabs = $("#dayTabs");
  if (dayKeys.length > 1) {
    if (!state.activeDay || !dayKeys.includes(state.activeDay)) state.activeDay = dayKeys[0];
    tabs.innerHTML = dayKeys.map((k) =>
      `<button class="day-tab ${k === state.activeDay ? "is-active" : ""}" data-day="${k}">${dayLabel(k)}<small>${groups.get(k).length}</small></button>`
    ).join("");
    tabs.querySelectorAll(".day-tab").forEach((b) => {
      b.onclick = () => { state.activeDay = b.dataset.day; renderItinerary(trip); };
    });
    tabs.hidden = false;
  } else {
    tabs.hidden = true;
    state.activeDay = dayKeys[0] ?? null;
  }

  // 清單（只顯示目前選的日期；若只有一組則全顯示）
  const showKeys = dayKeys.length > 1 ? [state.activeDay] : dayKeys;
  const list = $("#itineraryList");
  if (!items.length) {
    list.innerHTML = `<p class="status">還沒有任何項目，點右上角「＋ 新增項目」開始排行程。</p>`;
    $("#mapOpen").href = buildMapUrl([]);
    return;
  }
  list.innerHTML = showKeys.map((k) => `
    ${dayKeys.length > 1 ? "" : `<h3 class="day-head">${dayLabel(k)}</h3>`}
    ${groups.get(k).map(renderItemCard).join("")}
  `).join("");

  // 綁定每張卡片的按鈕
  list.querySelectorAll("[data-map]").forEach((b) =>
    (b.onclick = () => previewMap(b.dataset.map)));
  list.querySelectorAll("[data-edit]").forEach((b) =>
    (b.onclick = () => openItemModal(items.find((i) => i.id === b.dataset.edit))));

  // 「在 Google Maps 開啟」= 目前顯示日期的整條行程路線
  const shownItems = showKeys.flatMap((k) => groups.get(k) || []);
  $("#mapOpen").href = buildMapUrl(shownItems);

  // 首次進入時，內嵌地圖預覽第一個有地點的項目（無地點則維持空白提示）
  if (!state.mapInit) {
    const first = items.find((i) => i.map_query || i.location_name);
    if (first) { previewMap(first.map_query || first.location_name, { silent: true }); state.mapInit = true; }
  }
}

function renderItemCard(it) {
  const time = it.start_time
    ? it.start_time.slice(0, 5) + (it.end_time ? "–" + it.end_time.slice(0, 5) : "")
    : "";
  const q = it.map_query || it.location_name || it.title;
  return `
    <div class="itin-item">
      <div class="itin-time">${time || "·"}</div>
      <div class="itin-body">
        <div class="itin-title">${CATEGORY_ICON[it.category] || "•"} ${escapeHtml(it.title)}
          ${it.category ? `<span class="tag">${it.category}</span>` : ""}</div>
        ${it.location_name ? `<div class="status">📍 ${escapeHtml(it.location_name)}</div>` : ""}
        ${it.notes ? `<div class="itin-notes">${escapeHtml(it.notes)}</div>` : ""}
      </div>
      <div class="itin-actions">
        ${q ? `<button class="btn btn--ghost btn--sm" data-map="${escapeAttr(q)}">地圖</button>` : ""}
        <button class="btn btn--ghost btn--sm" data-edit="${it.id}">編輯</button>
      </div>
    </div>`;
}

// ---------- 地圖 ----------
// 單點預覽（內嵌 iframe），不影響「在 Google Maps 開啟」的整條路線連結
function previewMap(query, { silent = false } = {}) {
  const enc = encodeURIComponent(query);
  const frame = $("#mapFrame");
  frame.hidden = false;
  frame.src = `https://www.google.com/maps?q=${enc}&output=embed`;
  $("#mapTitle").textContent = query;
  if (!silent) frame.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

// 由項目清單組出 Google Maps 連結：多點→路線(dir)、單點→搜尋、無點→Google Maps 首頁
function buildMapUrl(items) {
  const pts = items.map((i) => i.map_query || i.location_name).filter(Boolean);
  if (pts.length === 0) return "https://www.google.com/maps";
  if (pts.length === 1)
    return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(pts[0])}`;
  return "https://www.google.com/maps/dir/" + pts.map(encodeURIComponent).join("/");
}

// ---------- 日期欄位（原生日曆 + 自畫的 YYYY-MM-DD） ----------
// input[type=date] 跟 type=time 一樣，顯示格式吃瀏覽器語言：英文 locale 會畫成
// 08/03/2026，分不出 8月3日還是 3月8日（lang 屬性無效，實測過）。但日曆彈窗本身
// 好用，尤其手機，所以留著原生欄位，只把它的文字設成透明再蓋上自己的顯示層。
const WEEKDAY = ["日", "一", "二", "三", "四", "五", "六"];

function formatDateFace(v) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v || "");
  if (!m) return "";
  // 用本地時間建構，避免 new Date("2026-08-03") 被當 UTC 午夜而在 UTC- 時區倒退一天
  const d = new Date(+m[1], +m[2] - 1, +m[3]);
  return `${v}（週${WEEKDAY[d.getDay()]}）`;
}

// 把某個範圍內所有日期欄位的顯示層更新成目前的值。
// 程式指派 .value 不會觸發 input/change，所以開 modal 時要自己叫一次。
function syncDateFaces(root) {
  // root 可能是容器（modal / form / document），也可能就是 .date-pick 本身
  const picks = root.matches?.(".date-pick") ? [root] : root.querySelectorAll(".date-pick");
  picks.forEach((w) => {
    const face = w.querySelector(".date-pick-face");
    const v = w.querySelector("input").value;
    const txt = formatDateFace(v);
    face.textContent = txt || "未設定";
    face.dataset.empty = txt ? "false" : "true";
    // 手機上雙欄的日期欄位塞不下星期，塞不下就只留日期（日期本身才是重點）
    if (txt && face.scrollWidth > face.clientWidth) face.textContent = v;
  });
}

function initDatePicks() {
  if (typeof HTMLInputElement.prototype.showPicker !== "function") return; // 不支援就維持原生樣子
  document.documentElement.classList.add("has-showpicker");
  document.querySelectorAll(".date-pick").forEach((w) => {
    const input = w.querySelector("input");
    input.addEventListener("input", () => syncDateFaces(w));
    input.addEventListener("change", () => syncDateFaces(w));
    w.addEventListener("click", () => {
      try { input.showPicker(); } catch { input.focus(); }
    });
  });
  // form.reset() 之後值會變，但沒有 input 事件；reset 的預設動作在事件之後才跑
  document.addEventListener("reset", (e) => setTimeout(() => syncDateFaces(e.target), 0), true);
  syncDateFaces(document);
}

// ---------- 時間選擇（時 / 分 兩個 select） ----------
// 原生 <input type="time"> 的顯示格式吃「瀏覽器語言」而非本頁 lang，英文 locale
// 會把 19:00 畫成 07:00 PM（存進 DB 的值其實是對的，但看起來像選錯）。HTML/CSS
// 沒有辦法強制 24 小時制，只能自建。
function fillTimeSelects(hSel, mSel) {
  if (hSel.options.length) return; // 只灌一次
  const opt = (v, label) => `<option value="${v}">${label}</option>`;
  hSel.innerHTML = opt("", "--") +
    Array.from({ length: 24 }, (_, h) => opt(pad2(h), pad2(h))).join("");
  mSel.innerHTML = opt("", "--") +
    Array.from({ length: 12 }, (_, i) => opt(pad2(i * 5), pad2(i * 5))).join("");
}

function pad2(n) { return String(n).padStart(2, "0"); }

// "19:00" → 選中 19 / 00；空值 → 兩個都回 "--"。
// 舊資料的分鐘若不是 5 的倍數（如 19:07），動態補一個選項，避免值被吃掉。
function setTimeValue(hSel, mSel, hhmm) {
  mSel.querySelectorAll("option[data-extra]").forEach((o) => o.remove()); // 清掉上一筆補的
  const m = /^(\d{2}):(\d{2})/.exec(hhmm || "");
  if (!m) { hSel.value = ""; mSel.value = ""; return; }
  hSel.value = m[1];
  if (!Array.from(mSel.options).some((o) => o.value === m[2])) {
    mSel.insertAdjacentHTML("beforeend", `<option data-extra value="${m[2]}">${m[2]}</option>`);
  }
  mSel.value = m[2];
}

// 時為空 → null；時有值、分留空 → 視為 00。
function getTimeValue(hSel, mSel) {
  if (!hSel.value) return null;
  return `${hSel.value}:${mSel.value || "00"}`;
}

// ---------- 項目 Modal ----------
function openItemModal(item) {
  if (!guardEdit()) return;
  const f = $("#itemForm");
  f.reset();
  fillTimeSelects(f.start_h, f.start_m);
  fillTimeSelects(f.end_h, f.end_m);
  $("#itemError").hidden = true;
  const editing = !!item;
  $("#itemModalTitle").textContent = editing ? "編輯項目" : "新增項目";
  $("#itemDeleteBtn").hidden = !editing;
  f.id.value = item?.id || "";
  if (item) {
    f.title.value = item.title || "";
    f.day_date.value = item.day_date || "";
    f.category.value = item.category || "景點";
    setTimeValue(f.start_h, f.start_m, item.start_time);
    setTimeValue(f.end_h, f.end_m, item.end_time);
    f.location_name.value = item.location_name || "";
    f.notes.value = item.notes || "";
  } else {
    // 預設日期：目前選的日期，或行程出發日
    f.day_date.value = (state.activeDay && state.activeDay !== "") ? state.activeDay
      : (state.trip?.start_date || "");
    setTimeValue(f.start_h, f.start_m, "");
    setTimeValue(f.end_h, f.end_m, "");
  }
  $("#itemModal").hidden = false;
  syncDateFaces($("#itemModal"));
}

function closeItemModal() { $("#itemModal").hidden = true; }

async function onItemSubmit(e) {
  e.preventDefault();
  const f = e.target;
  const payload = {
    title: f.title.value.trim(),
    day_date: f.day_date.value || null,
    category: f.category.value,
    start_time: getTimeValue(f.start_h, f.start_m),
    end_time: getTimeValue(f.end_h, f.end_m),
    location_name: f.location_name.value.trim() || null,
    notes: f.notes.value.trim() || null,
  };
  if (!payload.title) return;
  payload.map_query = payload.location_name || payload.title;
  try {
    setBusy(f, true);
    if (f.id.value) await updateItem(f.id.value, payload);
    else await addItem(state.trip.id, payload, state.me?.id);
    closeItemModal();
    await renderItinerary(state.trip);
  } catch (err) {
    const el = $("#itemError"); el.textContent = humanError(err); el.hidden = false;
  } finally {
    setBusy(f, false);
  }
}

async function onItemDelete() {
  const id = $("#itemForm").id.value;
  if (!id) return;
  if (!await confirmDialog({ title: "刪除項目", body: "確定刪除這個項目？", danger: true, okText: "刪除" })) return;
  try {
    await deleteItem(id);
    closeItemModal();
    await renderItinerary(state.trip);
  } catch (err) { toast(humanError(err), false); }
}

// ---------- 記帳 + 結算 ----------
const EXP_ICON = { 餐飲: "🍜", 交通: "🚆", 住宿: "🏨", 購物: "🛍️", 門票: "🎟️", 其他: "✨" };

// 本地時區的 YYYY-MM-DD（不要用 toISOString，會被轉成 UTC 而偏一天）
function ymd(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function todayStr() { return ymd(new Date()); }

async function renderExpenses(trip) {
  const base = trip.base_currency;
  const expenses = await listExpenses(trip.id);
  const memberById = new Map(state.members.map((m) => [m.id, m]));

  // 摘要
  const { byCurrency, base: baseTotal } = currencyTotals(expenses);
  const curParts = [...byCurrency.entries()]
    .map(([c, a]) => `<span class="sum-pill">${fmtMoney(a, c)} <small>${c}</small></span>`).join("");
  $("#expenseSummary").innerHTML = `
    <div class="sum-total">總支出 ≈ <strong>${fmtMoney(baseTotal, base)}</strong> <small>${base}</small></div>
    <div class="sum-currencies">${curParts || '<span class="status">尚無支出</span>'}</div>`;

  // 清單
  const list = $("#expenseList");
  if (!expenses.length) {
    list.innerHTML = `<p class="status">還沒有任何支出，點「＋ 新增支出」開始記帳。</p>`;
  } else {
    list.innerHTML = expenses.map((e) => renderExpenseRow(e, memberById, base)).join("");
    list.querySelectorAll("[data-exp-edit]").forEach((b) =>
      (b.onclick = () => openExpenseModal(expenses.find((x) => x.id === b.dataset.expEdit))));
  }

  renderSettlement(expenses, base);
}

function renderExpenseRow(e, memberById, base) {
  const payer = memberById.get(e.paid_by);
  const inBase = Number(e.amount) * (Number(e.rate_to_base) || 1);
  const names = (e.expense_splits || []).map((s) => memberById.get(s.member_id)?.display_name).filter(Boolean);
  return `
    <div class="exp-row" role="button" tabindex="0" data-exp-edit="${e.id}">
      <div class="exp-icon">${EXP_ICON[e.category] || "•"}</div>
      <div class="exp-body">
        <div class="exp-top">
          <span class="exp-desc">${escapeHtml(e.description || e.category || "支出")}</span>
          <span class="exp-amt">${fmtMoney(e.amount, e.currency)} <small>${e.currency}</small></span>
        </div>
        <div class="exp-sub status">
          ${payer ? escapeHtml(payer.display_name) + " 付" : "未指定付款人"}
          ${e.currency !== base ? " · ≈ " + fmtMoney(inBase, base) : ""}
          · ${names.length ? "分 " + names.length + " 人" : "未分帳"}
          ${e.spent_at ? " · " + e.spent_at.slice(0, 10) : ""}
        </div>
      </div>
    </div>`;
}

function renderSettlement(expenses, base) {
  const balances = computeBalances(expenses, state.members, base);
  $("#balanceList").innerHTML = balances.map((b) => {
    const cls = b.net > 0.005 ? "pos" : b.net < -0.005 ? "neg" : "zero";
    const txt = b.net > 0.005 ? "應收 " + fmtMoney(b.net, base)
      : b.net < -0.005 ? "應付 " + fmtMoney(-b.net, base) : "結清";
    return `<div class="bal-row">
      <span class="avatar avatar--sm" style="background:${b.member.color}">${(b.member.display_name || "?").slice(0, 1)}</span>
      <span class="bal-name">${escapeHtml(b.member.display_name)}</span>
      <span class="bal-net ${cls}">${txt}</span>
    </div>`;
  }).join("");

  const tx = settleUp(balances);
  $("#settleList").innerHTML = tx.length
    ? tx.map((t) => `<div class="settle-row">
        <span>${escapeHtml(t.from.display_name)}</span>
        <span class="arrow">→</span>
        <span>${escapeHtml(t.to.display_name)}</span>
        <strong>${fmtMoney(t.amount, base)}</strong>
      </div>`).join("")
    : `<p class="status">目前都結清，無需轉帳。</p>`;
}

// ---------- 支出 Modal ----------
function openExpenseModal(exp) {
  if (!guardEdit()) return;
  if (!state.members.length) { toast("尚未載入成員，請稍候再試。", false); return; }
  const f = $("#expenseForm");
  f.reset();
  $("#expenseError").hidden = true;
  const editing = !!exp;
  $("#expenseModalTitle").textContent = editing ? "編輯支出" : "新增支出";
  $("#expenseDeleteBtn").hidden = !editing;
  f.id.value = exp?.id || "";

  $("#expensePayer").innerHTML = state.members
    .map((m) => `<option value="${m.id}">${escapeHtml(m.display_name)}</option>`).join("");
  const curs = state.currencies.length ? state.currencies : [state.trip.base_currency];
  $("#expenseCurrency").innerHTML = curs
    .map((c) => `<option value="${c}">${currencyLabel(c)}</option>`).join("");

  if (exp) {
    f.description.value = exp.description || "";
    f.amount.value = exp.amount;
    $("#expenseCurrency").value = exp.currency;
    if (exp.paid_by) $("#expensePayer").value = exp.paid_by;
    f.category.value = exp.category || "餐飲";
    f.spent_at.value = exp.spent_at ? exp.spent_at.slice(0, 10) : todayStr();
    state.splitSel = new Set((exp.expense_splits || []).map((s) => s.member_id));
  } else {
    f.spent_at.value = todayStr();
    if (state.me) $("#expensePayer").value = state.me.id;
    state.splitSel = new Set(state.members.map((m) => m.id)); // 預設全員均分
  }
  renderSplitChips();
  updateSplitHint();
  $("#expenseModal").hidden = false;
  syncDateFaces($("#expenseModal"));
}

function closeExpenseModal() { $("#expenseModal").hidden = true; }

function renderSplitChips() {
  const wrap = $("#splitMembers");
  wrap.innerHTML = state.members.map((m) => {
    const on = state.splitSel.has(m.id);
    return `<button type="button" class="chip-toggle ${on ? "is-on" : ""}" data-split="${m.id}">
      <span class="avatar avatar--sm" style="background:${m.color}">${(m.display_name || "?").slice(0, 1)}</span>
      ${escapeHtml(m.display_name)}
    </button>`;
  }).join("");
  wrap.querySelectorAll("[data-split]").forEach((b) => (b.onclick = () => {
    const id = b.dataset.split;
    if (state.splitSel.has(id)) state.splitSel.delete(id); else state.splitSel.add(id);
    renderSplitChips(); updateSplitHint();
  }));
}

function updateSplitHint() {
  const amount = parseFloat($("#expenseForm").amount.value) || 0;
  const cur = $("#expenseCurrency").value;
  const n = state.splitSel.size;
  const hint = $("#splitHint");
  if (!n) { hint.textContent = "請至少選一人分攤"; return; }
  hint.textContent = `${n} 人均分，每人約 ${fmtMoney(amount / n, cur)}`;
}

async function onExpenseSubmit(e) {
  e.preventDefault();
  const f = e.target;
  const errEl = $("#expenseError");
  const showErr = (m) => { errEl.textContent = m; errEl.hidden = false; };
  const amount = parseFloat(f.amount.value);
  if (!(amount > 0)) return showErr("金額需大於 0。");
  const currency = $("#expenseCurrency").value;
  const memberIds = [...state.splitSel];
  if (!memberIds.length) return showErr("請至少選一人分攤。");
  try {
    setBusy(f, true);
    const base = state.trip.base_currency;
    let rate = 1;
    if (currency !== base) {
      const rates = await getRates(base);
      rate = rateToBase(currency, rates, base) ?? 1;
    }
    const splits = splitEqually(amount, memberIds, ZERO_DECIMAL.has(currency));
    const payload = {
      paid_by: $("#expensePayer").value || null,
      amount, currency, rate_to_base: rate,
      category: f.category.value,
      description: f.description.value.trim() || null,
      spent_at: f.spent_at.value ? new Date(f.spent_at.value).toISOString() : new Date().toISOString(),
    };
    if (f.id.value) await updateExpense(f.id.value, payload, splits);
    else await addExpense(state.trip.id, payload, splits);
    closeExpenseModal();
    await renderExpenses(state.trip);
  } catch (err) {
    showErr(humanError(err));
  } finally {
    setBusy(f, false);
  }
}

async function onExpenseDelete() {
  const id = $("#expenseForm").id.value;
  if (!id) return;
  if (!await confirmDialog({ title: "刪除支出", body: "確定刪除這筆支出？", danger: true, okText: "刪除" })) return;
  try {
    await deleteExpense(id);
    closeExpenseModal();
    await renderExpenses(state.trip);
  } catch (err) { toast(humanError(err), false); }
}

// ---------- 行李清單 ----------
const PACK_ICON = { 衣物: "👕", 證件: "🛂", 電子: "🔌", 盥洗: "🧴", 藥品: "💊", 其他: "✨" };

function fillPackingMemberSelect(sel, selectedId) {
  if (!sel) return;
  sel.innerHTML = `<option value="">🧳 共用 / 全體</option>` +
    state.members.map((m) => `<option value="${m.id}">${escapeHtml(m.display_name)}</option>`).join("");
  sel.value = selectedId || "";
}

async function renderPacking(trip) {
  if (!trip) return;
  const list = $("#packingList");
  if (!list) return;
  const items = await listPacking(trip.id);
  const editable = canEdit();
  const total = items.length;
  const done = items.filter((i) => i.checked).length;
  setText("#packingProgress", total ? `（已打包 ${done}/${total}）` : "");
  if (!items.length) {
    list.innerHTML = `<p class="status">還沒有任何物品，點「＋ 新增物品」或用「✨ AI 建議」開始整理行李。</p>`;
    return;
  }
  // 分組：共用(member_id=null) 優先，其餘依成員順序
  const memberById = new Map(state.members.map((m) => [m.id, m]));
  const groups = new Map();
  for (const it of items) {
    const key = it.member_id || "shared";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(it);
  }
  const order = ["shared", ...state.members.map((m) => m.id)];
  const keys = order.filter((k) => groups.has(k));
  for (const k of groups.keys()) if (!keys.includes(k)) keys.push(k);

  list.innerHTML = keys.map((k) => {
    const g = groups.get(k);
    const gDone = g.filter((i) => i.checked).length;
    const label = k === "shared" ? "🧳 共用 / 全體" : escapeHtml(memberById.get(k)?.display_name || "（已移除成員）");
    return `
      <div class="pack-group">
        <h3 class="day-head">${label} <small class="status">${gDone}/${g.length}</small></h3>
        ${g.map((it) => renderPackingRow(it, editable)).join("")}
      </div>`;
  }).join("");

  list.querySelectorAll("[data-pack-check]").forEach((b) =>
    (b.onchange = () => onTogglePacked(b.dataset.packCheck, b.checked)));
  list.querySelectorAll("[data-pack-edit]").forEach((b) =>
    (b.onclick = () => openPackingModal(items.find((i) => i.id === b.dataset.packEdit))));
}

function renderPackingRow(it, editable) {
  return `
    <div class="pack-row ${it.checked ? "is-done" : ""}">
      <label class="pack-check">
        <input type="checkbox" data-pack-check="${it.id}" ${it.checked ? "checked" : ""} ${editable ? "" : "disabled"} />
      </label>
      <div class="pack-body">
        <div class="pack-name">${PACK_ICON[it.category] || "•"} ${escapeHtml(it.name)}${it.qty > 1 ? ` <small class="status">×${it.qty}</small>` : ""}${it.category ? ` <span class="tag">${escapeHtml(it.category)}</span>` : ""}</div>
        ${it.note ? `<div class="itin-notes">${escapeHtml(it.note)}</div>` : ""}
      </div>
      ${editable ? `<div class="itin-actions"><button class="btn btn--ghost btn--sm" data-pack-edit="${it.id}">編輯</button></div>` : ""}
    </div>`;
}

async function onTogglePacked(id, checked) {
  if (!canEdit()) { toast("你是唯讀成員，無法編輯", false); renderPacking(state.trip).catch(() => {}); return; }
  try { await updatePacking(id, { checked }); renderPacking(state.trip).catch(() => {}); }
  catch (e) { toast(humanError(e), false); renderPacking(state.trip).catch(() => {}); }
}

function openPackingModal(item) {
  if (!guardEdit()) return;
  const f = $("#packingForm");
  f.reset();
  $("#packingError").hidden = true;
  const editing = !!item;
  $("#packingModalTitle").textContent = editing ? "編輯物品" : "新增物品";
  $("#packingDeleteBtn").hidden = !editing;
  f.id.value = item?.id || "";
  fillPackingMemberSelect($("#packingMember"), item?.member_id || "");
  f.name.value = item?.name || "";
  f.category.value = item?.category || "衣物";
  f.qty.value = item?.qty || 1;
  $("#packingModal").hidden = false;
}
function closePackingModal() { $("#packingModal").hidden = true; }

async function onPackingSubmit(e) {
  e.preventDefault();
  const f = e.target;
  const err = $("#packingError"); err.hidden = true;
  const payload = {
    name: f.name.value.trim(),
    category: f.category.value,
    qty: Math.max(1, parseInt(f.qty.value, 10) || 1),
    member_id: $("#packingMember").value || null,
  };
  if (!payload.name) return;
  try {
    setBusy(f, true);
    if (f.id.value) await updatePacking(f.id.value, payload);
    else await addPacking(state.trip.id, payload, state.me?.id);
    closePackingModal();
    await renderPacking(state.trip);
  } catch (e2) { err.textContent = humanError(e2); err.hidden = false; }
  finally { setBusy(f, false); }
}

async function onPackingDelete() {
  const id = $("#packingForm").id.value;
  if (!id) return;
  if (!await confirmDialog({ title: "刪除物品", body: "確定刪除這個物品？", danger: true, okText: "刪除" })) return;
  try { await deletePacking(id); closePackingModal(); await renderPacking(state.trip); }
  catch (e) { toast(humanError(e), false); }
}

// ---------- AI 建議行李 ----------
function openAiPacking() {
  if (!guardEdit()) return;
  $("#aiPackingOut").innerHTML = "";
  $("#aiPackingPrefs").value = "";
  fillPackingMemberSelect($("#aiPackingMember"), "");
  $("#aiPackingModal").hidden = false;
}

async function onAiPackingGo() {
  const out = $("#aiPackingOut");
  out.innerHTML = `<p class="status">AI 思考中…（依天氣與行程）</p>`;
  try {
    let days = getWeatherSummaries();
    if (!days.length) { await ensureWeather(true); days = getWeatherSummaries(); }
    const items = await listItems(state.trip.id);
    const forId = $("#aiPackingMember").value || "";
    const forName = forId ? (state.members.find((m) => m.id === forId)?.display_name || "") : "";
    const { items: raw } = await callAI("suggest_packing", {
      trip: { title: state.trip.title, start: state.trip.start_date, end: state.trip.end_date },
      days,
      itinerary: items.map((i) => i.title).filter(Boolean),
      preferences: $("#aiPackingPrefs").value.trim(),
      for_member: forName,
    });
    const sug = (Array.isArray(raw) ? raw : []).filter((s) => s && s.name);
    if (!sug.length) { out.innerHTML = `<p class="status">沒有建議，換個偏好再試。</p>`; return; }
    out.innerHTML = `
      <div class="ai-itin-bar">
        <span class="status">AI 建議 ${sug.length} 項${forName ? "（給 " + escapeHtml(forName) + "）" : "（共用）"}</span>
        <button class="btn btn--sm" type="button" id="aiPackAddAll">全部加入</button>
      </div>
      ${sug.map((s, idx) => `
      <div class="pack-row">
        <div class="pack-body">
          <div class="pack-name">${PACK_ICON[s.category] || "•"} ${escapeHtml(s.name)}${s.qty > 1 ? ` <small class="status">×${s.qty}</small>` : ""} ${s.category ? `<span class="tag">${escapeHtml(s.category)}</span>` : ""}</div>
          ${s.note ? `<div class="itin-notes">${escapeHtml(s.note)}</div>` : ""}
        </div>
        <div class="itin-actions"><button class="btn btn--ghost btn--sm" data-pack-add="${idx}">加入</button></div>
      </div>`).join("")}`;
    const forIdFinal = forId || null;
    $("#aiPackAddAll").onclick = () => addAllPacking(sug, forIdFinal, $("#aiPackAddAll"));
    out.querySelectorAll("[data-pack-add]").forEach((b) => (b.onclick = async () => {
      try {
        await addPacking(state.trip.id, sugToPacking(sug[Number(b.dataset.packAdd)], forIdFinal, Number(b.dataset.packAdd)), state.me?.id);
        b.textContent = "已加入"; b.disabled = true;
        renderPacking(state.trip).catch(() => {});
      } catch (e) { toast(humanError(e), false); }
    }));
  } catch (e) {
    out.innerHTML = `<p class="status" data-ok="false">${humanError(e)}</p>`;
  }
}

function sugToPacking(s, memberId, idx) {
  return {
    name: s.name,
    category: s.category || null,
    qty: Math.max(1, parseInt(s.qty, 10) || 1),
    note: s.note || null,
    member_id: memberId || null,
    sort_order: idx,
  };
}

async function addAllPacking(sug, memberId, btn) {
  if (!Array.isArray(sug) || !sug.length) return;
  const old = btn.textContent; btn.disabled = true; btn.textContent = "加入中…";
  let ok = 0;
  for (let i = 0; i < sug.length; i++) {
    if (!sug[i]?.name) continue;
    try { await addPacking(state.trip.id, sugToPacking(sug[i], memberId, i), state.me?.id); ok++; }
    catch { /* 略過單筆失敗 */ }
  }
  await renderPacking(state.trip).catch(() => {});
  $("#aiPackingModal").hidden = true;
  toast(ok ? `已加入 ${ok} 項行李` : "沒有可加入的項目", !!ok);
  if (ok) showPage("packing");
  btn.disabled = false; btn.textContent = old;
}

// ---------- 共用 ----------
function setBusy(form, busy) {
  form.querySelectorAll("button, input, select").forEach((el) => (el.disabled = busy));
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function escapeAttr(s) { return escapeHtml(s); }

// 底部短暫提示（取代成功/失敗 alert）
let toastTimer = null;
function toast(msg, ok = true) {
  const el = $("#toast");
  el.textContent = msg;
  el.dataset.ok = ok ? "true" : "false";
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 2600);
}

// 統一確認彈窗（取代原生 confirm）→ Promise<boolean>
function confirmDialog({ title = "確認", body = "", danger = false, okText = "確定" } = {}) {
  return new Promise((resolve) => {
    const modal = $("#confirmModal");
    $("#confirmTitle").textContent = title;
    $("#confirmBody").textContent = body;
    const okBtn = $("#confirmOk");
    okBtn.textContent = okText;
    okBtn.classList.toggle("btn--ghost", false);
    okBtn.style.background = danger ? "var(--accent-dark)" : "";
    const close = (val) => {
      modal.hidden = true;
      okBtn.onclick = null; $("#confirmCancel").onclick = null; modal.onclick = null;
      resolve(val);
    };
    okBtn.onclick = () => close(true);
    $("#confirmCancel").onclick = () => close(false);
    modal.onclick = (e) => { if (e.target.id === "confirmModal") close(false); };
    modal.hidden = false;
  });
}

function humanError(err) {
  const m = err?.message || String(err);
  if (/code taken/i.test(m)) return "這個行程碼已被使用，換一個吧。";
  if (/invalid code/i.test(m)) return "行程碼只能用英文或數字，長度 3–12 碼。";
  if (/name required/i.test(m)) return "請輸入你的名字。";
  if (/not found/i.test(m)) return "找不到這個行程碼，請確認後再試。";
  if (/not authenticated/i.test(m)) return "身份尚未就緒，請重新整理頁面。";
  if (/RESOURCE_EXHAUSTED|\b429\b/.test(m)) return "AI 今天的免費額度用完了，請稍後再試。";
  if (/不是合法 JSON|全部模型失敗/.test(m)) return "AI 服務異常：" + m;
  return m;
}

// ---------- 行程中樞（總覽：我的行程 / 建立 / 加入登入 / 刪除） ----------
// 沒有選定行程時的著陸：顯示 app 外殼 + 總覽中樞
async function showHub() {
  state.trip = null;
  let trips = [];
  try { trips = await listMyTrips(); } catch { /* 略過 */ }
  // 只有一個行程 → 直接進入，省去先在總覽點選
  if (trips.length === 1) { saveTrip(trips[0]); await enterTrip(trips[0].id); return; }
  document.body.classList.add("in-trip"); // 顯示外殼 + 中樞
  show("appView");
  renderOverviewState();
  showPage("overview");
  renderMyTrips(trips);
  // 管理員若還沒有行程，直接開建立 Modal
  if (!trips.length && isAdmin()) openTripModal();
}

function renderMyTrips(trips) {
  const list = $("#myTripsList");
  if (!list) return;
  // 頂部已有全域切換器：已在某趟且只有一個行程時，隱藏這張清單卡（避免重複）
  setHidden("#myTripsCard", !!state.trip && (trips?.length || 0) <= 1);
  if (!trips || !trips.length) {
    list.innerHTML = isAdmin()
      ? `<p class="status">還沒有行程。到「⚙️ 管理」頁建立一趟。</p>`
      : `<p class="status">還沒有被指派任何行程，請聯絡管理員。</p>`;
    return;
  }
  const cur = state.trip?.id;
  // 純切換器：點一下進入該行程。行程的建立/編輯/刪除集中在「管理」頁。
  list.innerHTML = trips.map((t) => `
    <div class="my-trip ${t.id === cur ? "is-current" : ""}">
      <button class="my-trip-main" type="button" data-enter="${t.id}">
        <span class="my-trip-title">${escapeHtml(t.title)}${t.id === cur ? ' <small class="status">· 使用中</small>' : ""}</span>
        <span class="status">${t.start_date ? t.start_date + (t.end_date ? " ~ " + t.end_date : "") : "未設定日期"}</span>
      </button>
    </div>`).join("");
  list.querySelectorAll("[data-enter]").forEach((b) =>
    (b.onclick = () => {
      const t = trips.find((x) => x.id === b.dataset.enter);
      saveTrip(t);
      enterTrip(t.id).catch((e) => toast(humanError(e), false));
    }));
}

async function onDeleteTrip(id, title) {
  if (!await confirmDialog({ title: "刪除行程", body: `確定刪除「${title}」？\n此行程的所有項目與記帳都會一起刪除，無法復原。`, danger: true, okText: "刪除" })) return;
  try {
    await deleteTrip(id);
    const wasCurrent = state.trip?.id === id;
    if (getSavedTrip()?.id === id) clearSavedTrip();
    if (wasCurrent) {
      if (unsub) { unsub(); unsub = null; }
      if (unsubItin) { unsubItin(); unsubItin = null; }
      if (unsubExp) { unsubExp(); unsubExp = null; }
      if (unsubPacking) { unsubPacking(); unsubPacking = null; }
      state.trip = null;
      renderOverviewState();
    }
    toast("已刪除行程");
    renderMyTrips(await listMyTrips());
  } catch (e) { toast(humanError(e), false); }
}

// ---------- 啟動 ----------
async function boot() {
  show("bootView");
  buildJoinView();
  initDatePicks();

  // 登入
  $("#loginForm").addEventListener("submit", onLoginSubmit);
  $("#logoutBtn").onclick = async () => { await logout(); showLogin(); };

  // 建立行程 / 新增成員帳號
  $("#tripModalClose").onclick = closeTripModal;
  $("#tripModal").addEventListener("click", (e) => { if (e.target.id === "tripModal") closeTripModal(); });
  $("#memberModalClose").onclick = () => ($("#memberModal").hidden = true);
  $("#memberForm").addEventListener("submit", onMemberSubmit);
  $("#memberModal").addEventListener("click", (e) => { if (e.target.id === "memberModal") $("#memberModal").hidden = true; });

  // 管理頁
  $("#adminAddMemberBtn").onclick = onAdminAddMember;
  $("#adminCreateTripBtn").onclick = () => openTripModal();
  $("#tripEditClose").onclick = () => ($("#tripEditModal").hidden = true);
  $("#tripEditForm").addEventListener("submit", onTripEditSubmit);
  $("#tripEditModal").addEventListener("click", (e) => { if (e.target.id === "tripEditModal") $("#tripEditModal").hidden = true; });

  // 指派行程 / 重設密碼 彈窗
  $("#assignTripForm").addEventListener("submit", onAssignTripSubmit);
  $("#assignTripClose").onclick = $("#assignTripCancel").onclick = () => ($("#assignTripModal").hidden = true);
  $("#assignTripModal").addEventListener("click", (e) => { if (e.target.id === "assignTripModal") $("#assignTripModal").hidden = true; });
  $("#resetPwForm").addEventListener("submit", onResetPwSubmit);
  $("#resetPwClose").onclick = $("#resetPwCancel").onclick = () => ($("#resetPwModal").hidden = true);
  $("#resetPwModal").addEventListener("click", (e) => { if (e.target.id === "resetPwModal") $("#resetPwModal").hidden = true; });

  // AI 建議行程
  $("#aiItinBtn").onclick = openAiItin;
  $("#aiItinClose").onclick = () => ($("#aiItinModal").hidden = true);
  $("#aiItinGo").onclick = onAiItinGo;
  $("#aiItinModal").addEventListener("click", (e) => { if (e.target.id === "aiItinModal") $("#aiItinModal").hidden = true; });

  // 記帳語意輸入
  $("#nlExpenseBtn").onclick = onNlExpense;
  $("#nlExpenseInput").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); onNlExpense(); } });

  // 行李清單
  $("#addPackingBtn").onclick = () => openPackingModal(null);
  $("#packingModalClose").onclick = closePackingModal;
  $("#packingForm").addEventListener("submit", onPackingSubmit);
  $("#packingDeleteBtn").onclick = onPackingDelete;
  $("#packingModal").addEventListener("click", (e) => { if (e.target.id === "packingModal") closePackingModal(); });
  // AI 建議行李
  $("#aiPackingBtn").onclick = openAiPacking;
  $("#aiPackingClose").onclick = () => ($("#aiPackingModal").hidden = true);
  $("#aiPackingGo").onclick = onAiPackingGo;
  $("#aiPackingModal").addEventListener("click", (e) => { if (e.target.id === "aiPackingModal") $("#aiPackingModal").hidden = true; });

  // 行程項目 modal
  $("#addItemBtn").onclick = () => openItemModal(null);
  $("#itemModalClose").onclick = closeItemModal;
  $("#itemForm").addEventListener("submit", onItemSubmit);
  $("#itemDeleteBtn").onclick = onItemDelete;
  $("#itemModal").addEventListener("click", (e) => {
    if (e.target.id === "itemModal") closeItemModal(); // 點背景關閉
  });

  // 分頁路由（側欄 + 底部列）
  document.querySelectorAll(".nav-item, .tab-item").forEach((b) => (b.onclick = () => showPage(b.dataset.page)));

  // 總覽快速統計卡 / 「查看全部」→ 跳頁；成員卡 → 捲到成員區
  document.querySelectorAll('#view-overview [data-page]').forEach((b) => (b.onclick = () => showPage(b.dataset.page)));
  document.querySelectorAll('#view-overview [data-scroll]').forEach((b) => (b.onclick = () =>
    $("#" + b.dataset.scroll)?.scrollIntoView({ behavior: "smooth", block: "start" })));

  // 頂部行程切換器 + 帳號選單（popover）
  $("#tripSwitcher").onclick = (e) => { e.stopPropagation(); openTripMenu(); };
  $("#accountBtn").onclick = (e) => { e.stopPropagation(); openAccountMenu(); };
  document.addEventListener("click", (e) => {
    if (!e.target.closest("#tripMenu, #tripSwitcher, #accountMenu, #accountBtn")) closePopovers();
  });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closePopovers(); });
  window.addEventListener("hashchange", () => {
    if (!$("#appView").hidden) showPage(location.hash.slice(1) || "overview");
  });

  // 天氣
  $("#refreshWeather").onclick = () => ensureWeather(true);
  $("#weatherManualBtn").onclick = () => {
    const q = $("#weatherManualInput").value.trim();
    if (q) loadCityWeather(q).catch((e) => toast(humanError(e), false));
  };
  $("#weatherManualInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); $("#weatherManualBtn").click(); }
  });
  $("#aiWeatherBtn").onclick = onAiWeather;

  // 支出 modal
  $("#addExpenseBtn").onclick = () => openExpenseModal(null);
  $("#expenseModalClose").onclick = closeExpenseModal;
  $("#expenseForm").addEventListener("submit", onExpenseSubmit);
  $("#expenseDeleteBtn").onclick = onExpenseDelete;
  $("#expenseForm").amount.addEventListener("input", updateSplitHint);
  $("#expenseCurrency").addEventListener("change", updateSplitHint);
  $("#expenseModal").addEventListener("click", (e) => {
    if (e.target.id === "expenseModal") closeExpenseModal();
  });

  // 登出 / session 失效時回登入頁
  onAuthChange((session) => { if (!session) showLogin(); });

  // 有 session → 進入；否則登入頁
  const session = await getSession();
  if (session) await onLoggedIn();
  else showLogin();
}

boot();
