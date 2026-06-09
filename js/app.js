// Phase 1 控制器：路由（加入畫面 ↔ 行程主畫面）、表單、即時成員/幣別。
import { ensureAuth } from "./supabase.js";
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
import { computeBalances, currencyTotals, settleUp, splitEqually } from "./settle.js";
import { loadItineraryWeather, loadCityWeather, getWeatherSummaries } from "./weather.js";
import { callAI } from "./ai.js";
import {
  getSavedTrip, saveTrip, clearSavedTrip,
  createTrip, joinTrip, getTrip, getMyMember,
  listMembers, getTripCurrencies, addTripCurrency, removeTripCurrency,
  updateBaseCurrency, subscribeTrip, listMyTrips, deleteTrip,
} from "./trip.js";

const $ = (s) => document.querySelector(s);
const { DEFAULT_BASE_CURRENCY, DEFAULT_CURRENCIES } = window.APP_CONFIG;

let unsub = null;       // 行程/成員 realtime 取消訂閱
let unsubItin = null;   // 行程項目 realtime 取消訂閱
let unsubExp = null;    // 記帳 realtime 取消訂閱
let createCurrencies = new Set(); // 建立行程時已選的幣別
const state = {
  trip: null, me: null, activeDay: null, mapInit: false,
  members: [], currencies: [], splitSel: new Set(), weatherLoaded: false,
};

// ---------- 分頁路由 + 抽屜 ----------
const PAGES = ["overview", "itinerary", "expenses", "weather"];

function openDrawer() { $("#drawer").classList.add("open"); $("#drawerBackdrop").classList.add("show"); }
function closeDrawer() { $("#drawer").classList.remove("open"); $("#drawerBackdrop").classList.remove("show"); }

function showPage(name) {
  if (!PAGES.includes(name)) name = "overview";
  PAGES.forEach((p) => ($("#view-" + p).hidden = p !== name));
  document.querySelectorAll(".nav-item").forEach((b) => b.classList.toggle("is-active", b.dataset.page === name));
  if (location.hash.slice(1) !== name) history.replaceState(null, "", "#" + name);
  closeDrawer();
  if (name === "weather") ensureWeather();
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

  $("#joinForm").addEventListener("submit", onJoinSubmit);
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
  const currencies = [...createCurrencies];
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
      code: f.code.value.trim() || null,
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
  if (unsubItin) { unsubItin(); unsubItin = null; }
  if (unsubExp) { unsubExp(); unsubExp = null; }
  const trip = await getTrip(tripId);
  state.trip = trip;
  state.me = await getMyMember(tripId);
  state.mapInit = false;   // 進新行程時重設地圖預設
  const frame = $("#mapFrame");
  frame.hidden = true; frame.removeAttribute("src");
  $("#mapTitle").textContent = "點行程項目的「地圖」即可在此顯示";
  state.weatherLoaded = false;
  await renderTrip(trip);
  await renderItinerary(trip);
  await renderExpenses(trip);

  document.body.classList.add("in-trip");
  show("appView");
  // 頂部徽章 + 抽屜標題
  $("#tripBadge").hidden = false;
  $("#tripBadgeTitle").textContent = trip.title;
  $("#drawerTripTitle").textContent = trip.title;
  // 進入時依 hash 決定起始頁
  showPage(PAGES.includes(location.hash.slice(1)) ? location.hash.slice(1) : "overview");

  // 即時：成員/幣別變動就重畫
  unsub = subscribeTrip(tripId, () => renderTrip(trip).catch(console.error));
  // 即時：行程項目變動就重畫（並讓天氣下次重新載入）
  unsubItin = subscribeItinerary(tripId, () => {
    state.weatherLoaded = false;
    renderItinerary(trip).catch(console.error);
    if (!$("#view-weather").hidden) ensureWeather(true);
  });
  // 即時：記帳變動就重畫
  unsubExp = subscribeExpenses(tripId, () => renderExpenses(trip).catch(console.error));
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
  state.members = members;
  state.currencies = currencies;

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
    } catch (err) { alert(humanError(err)); }
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
      catch (err) { alert(humanError(err)); }
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
    catch (err) { alert(humanError(err)); }
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

// ---------- 項目 Modal ----------
function openItemModal(item) {
  const f = $("#itemForm");
  f.reset();
  $("#itemError").hidden = true;
  const editing = !!item;
  $("#itemModalTitle").textContent = editing ? "編輯項目" : "新增項目";
  $("#itemDeleteBtn").hidden = !editing;
  f.id.value = item?.id || "";
  if (item) {
    f.title.value = item.title || "";
    f.day_date.value = item.day_date || "";
    f.category.value = item.category || "景點";
    f.start_time.value = item.start_time ? item.start_time.slice(0, 5) : "";
    f.end_time.value = item.end_time ? item.end_time.slice(0, 5) : "";
    f.location_name.value = item.location_name || "";
    f.notes.value = item.notes || "";
  } else {
    // 預設日期：目前選的日期，或行程出發日
    f.day_date.value = (state.activeDay && state.activeDay !== "") ? state.activeDay
      : (state.trip?.start_date || "");
  }
  $("#itemModal").hidden = false;
}

function closeItemModal() { $("#itemModal").hidden = true; }

async function onItemSubmit(e) {
  e.preventDefault();
  const f = e.target;
  const payload = {
    title: f.title.value.trim(),
    day_date: f.day_date.value || null,
    category: f.category.value,
    start_time: f.start_time.value || null,
    end_time: f.end_time.value || null,
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
  if (!id || !confirm("確定刪除這個項目？")) return;
  try {
    await deleteItem(id);
    closeItemModal();
    await renderItinerary(state.trip);
  } catch (err) { alert(humanError(err)); }
}

// ---------- 記帳 + 結算 ----------
const EXP_ICON = { 餐飲: "🍜", 交通: "🚆", 住宿: "🏨", 購物: "🛍️", 門票: "🎟️", 其他: "✨" };

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

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
  if (!state.members.length) { alert("尚未載入成員，請稍候再試。"); return; }
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
  if (!id || !confirm("確定刪除這筆支出？")) return;
  try {
    await deleteExpense(id);
    closeExpenseModal();
    await renderExpenses(state.trip);
  } catch (err) { alert(humanError(err)); }
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
function humanError(err) {
  const m = err?.message || String(err);
  if (/code taken/i.test(m)) return "這個行程碼已被使用，換一個吧。";
  if (/invalid code/i.test(m)) return "行程碼只能用英文或數字，長度 3–12 碼。";
  if (/name required/i.test(m)) return "請輸入你的名字。";
  if (/not found/i.test(m)) return "找不到這個行程碼，請確認後再試。";
  if (/not authenticated/i.test(m)) return "身份尚未就緒，請重新整理頁面。";
  return m;
}

// ---------- 我的行程（管理/刪除） ----------
async function showJoin() {
  document.body.classList.remove("in-trip");
  closeDrawer();
  show("joinView");
  try { renderMyTrips(await listMyTrips()); } catch { /* 略過 */ }
}

function renderMyTrips(trips) {
  const box = $("#myTrips");
  const list = $("#myTripsList");
  if (!trips || !trips.length) { box.hidden = true; return; }
  box.hidden = false;
  list.innerHTML = trips.map((t) => `
    <div class="my-trip">
      <button class="my-trip-main" type="button" data-enter="${t.id}">
        <span class="my-trip-title">${escapeHtml(t.title)}</span>
        <span class="status">${t.code}${t.start_date ? " · " + t.start_date : ""}</span>
      </button>
      <button class="btn btn--ghost btn--sm" type="button" data-del="${t.id}" data-title="${escapeAttr(t.title)}">刪除</button>
    </div>`).join("");
  list.querySelectorAll("[data-enter]").forEach((b) =>
    (b.onclick = () => {
      const t = trips.find((x) => x.id === b.dataset.enter);
      saveTrip(t);
      enterTrip(t.id).catch((e) => alert(humanError(e)));
    }));
  list.querySelectorAll("[data-del]").forEach((b) =>
    (b.onclick = () => onDeleteTrip(b.dataset.del, b.dataset.title)));
}

async function onDeleteTrip(id, title) {
  if (!confirm(`確定刪除「${title}」？\n此行程的所有項目與記帳都會一起刪除，無法復原。`)) return;
  try {
    await deleteTrip(id);
    if (getSavedTrip()?.id === id) clearSavedTrip();
    renderMyTrips(await listMyTrips());
  } catch (e) { alert(humanError(e)); }
}

// ---------- 啟動 ----------
async function boot() {
  show("bootView");
  buildJoinView();

  $("#switchTrip").onclick = () => {
    clearSavedTrip();
    if (unsub) { unsub(); unsub = null; }
    if (unsubItin) { unsubItin(); unsubItin = null; }
    if (unsubExp) { unsubExp(); unsubExp = null; }
    $("#tripBadge").hidden = true;
    showJoin();
  };
  $("#copyCode").onclick = async () => {
    await navigator.clipboard.writeText($("#tripCode").textContent);
    $("#copyCode").textContent = "已複製";
    setTimeout(() => ($("#copyCode").textContent = "複製"), 1500);
  };

  // 行程項目 modal
  $("#addItemBtn").onclick = () => openItemModal(null);
  $("#itemModalClose").onclick = closeItemModal;
  $("#itemForm").addEventListener("submit", onItemSubmit);
  $("#itemDeleteBtn").onclick = onItemDelete;
  $("#itemModal").addEventListener("click", (e) => {
    if (e.target.id === "itemModal") closeItemModal(); // 點背景關閉
  });

  // 抽屜 + 分頁路由
  $("#navToggle").onclick = openDrawer;
  $("#drawerBackdrop").onclick = closeDrawer;
  document.querySelectorAll(".nav-item").forEach((b) => (b.onclick = () => showPage(b.dataset.page)));
  window.addEventListener("hashchange", () => {
    if (!$("#appView").hidden) showPage(location.hash.slice(1) || "overview");
  });

  // 天氣
  $("#refreshWeather").onclick = () => ensureWeather(true);
  $("#weatherManualBtn").onclick = () => {
    const q = $("#weatherManualInput").value.trim();
    if (q) loadCityWeather(q).catch((e) => alert(humanError(e)));
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
  await showJoin();
}

boot();
