// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Hank Wang

// 地圖服務抽象層：每趟行程各自選 Google 或 Naver。
//
// 為什麼需要這層：韓國政府限制圖資輸出，Google Maps 在韓國沒有步行/大眾運輸
// 路線、店家資料也殘缺，排韓國行程幾乎沒用。但兩家的能力差很多，不是換個
// 網域就好：
//
//   Google  免金鑰的 iframe embed；多點路線用官方的 Maps URLs（dir/?api=1）一條網址就搞定
//   Naver   不能 iframe（X-Frame-Options），內嵌只能靠官方 JS SDK，而那個
//           ncpKeyId 我們申請不到 —— 所以 Naver 一律「跳出去開」，不內嵌
//
// 因此兩家的互動模式本來就不一樣，這層把差異收成三件事讓 app.js 去問：
// 能不能內嵌（hasEmbed）、單一項目要跳去哪（itemMapUrl / itemAppUrl）、
// 以及 Google 專用的整天路線與內嵌預覽。

import { updateItem } from "@/itinerary.js";
import { callAI } from "@/ai.js";

const $ = (s) => document.querySelector(s);

export const MAP_PROVIDERS = [
  { value: "google", label: "Google 地圖" },
  { value: "naver", label: "Naver 地圖（韓國）" },
];

const DEFAULT_PROVIDER = "google";
const VALID = new Set(MAP_PROVIDERS.map((p) => p.value));

// 舊行程沒有這個欄位、或 DB 被塞了不認得的值，一律當 Google
export function providerOf(trip) {
  const p = trip?.map_provider;
  return VALID.has(p) ? p : DEFAULT_PROVIDER;
}

// 「這家能不能畫在頁面裡」—— 只有 Google 可以。app.js 用這個決定要不要顯示地圖卡，
// 是全專案唯一一處定義內嵌能力的地方。
export function hasEmbed(provider) {
  return providerOf({ map_provider: provider }) === "google";
}

export function openLabel(provider) {
  return providerOf({ map_provider: provider }) === "naver"
    ? "在 Naver 地圖開啟行程"
    : "在 Google Maps 開啟行程";
}

// 韓文（諺文音節 + 字母 + 相容字母）。用來判斷「這個字串 Naver 搜得到嗎」。
const HANGUL = /[가-힣ᄀ-ᇿ㄰-㆏]/;

// 使用者/AI 常把地名寫成「韓文店名 + 英文地區」的混雜形式（實際遇過「뼈다귀에반하다 Jeju」），
// 那條英文尾巴會讓 Naver 直接搜不到 —— 它不是店名的一部分，只是拿來標註在哪個地區。
//
// 只砍結尾、而且只砍白名單裡的詞。不寫成「刪掉所有純 ASCII 的 token」是因為那會把
// 「ARTE MUSEUM 제주」砍成「제주」（跑到整座島的中心），也可能動到把英文縮寫黏在
// 韓文前面的正式店名。
const REGION_TAIL = /[\s,]+(south\s+korea|korea|jeju(\s*-?\s*(do|island))?|seoul|busan)$/i;

function stripRegionTail(s) {
  let out = (s || "").trim();
  // 「… Jeju Korea」這種疊兩層的也要清掉，但設上限免得寫出無窮迴圈
  for (let i = 0; i < 3; i++) {
    const next = out.replace(REGION_TAIL, "").trim();
    if (!next || next === out) break;
    out = next;
  }
  return out;
}

// 獨立成詞的純英文單字（黏在韓文上的不算，例如「BHC치킨」的 BHC）
const LATIN_WORD = /(^|\s)[A-Za-z][A-Za-z.'&-]*(\s|$)/;

// 中日文字。Naver 搜不到中文地名（「濟州國際機場」查無結果），一律要先轉過。
const CJK = /[一-鿿぀-ヿ]/;

// 純拉丁字母的字串（英文店名／羅馬拼音）
const LATIN_ONLY = /^[A-Za-z0-9\s.,'&()\/+-]+$/;

// 「這個字串可以原封不動丟給 Naver 嗎」。Naver 兩種語言都吃：
//
//   純英文    Naver 的店家資料本來就登錄了官方英文名（「Seongsan Ilchulbong Tuff
//             Cone」「SNOOPY GARDEN」），搜得到，而且使用者把 App 設成英文時
//             看到的就是這個名字 —— 送韓文進去反而整頁都是看不懂的字
//   純韓文    最準，沒有英文名的小店只能靠它
//
// 擋掉的只有兩種：中文（Naver 真的查無結果）、以及韓文夾雜獨立英文單字的混雜寫法
// （實際遇過「뼈다귀에반하다 Jeju」，那條英文尾巴會讓 Naver 直接搜不到）。
// 這兩種都交給 AI 轉成在地正式名。
const naverSearchable = (s) => {
  if (!s) return false;
  if (CJK.test(s)) return false;
  if (LATIN_ONLY.test(s)) return true;
  return HANGUL.test(s) && !LATIN_WORD.test(s);
};

// 項目 → 拿來搜尋的字串。
// Google 吃中文地名；Naver 搜不到中文（「濟州國際機場」查無結果），但韓文與官方
// 英文名都吃，所以 Naver 有自己一條優先序：
//   1. map_query 是 Naver 認得的寫法（英文或韓文）—— 使用者/AI 特地填的，最準，優先
//   2. naver_query —— AI 轉過並快取在 DB 的韓文名
//   3. 都沒有就先用原地名頂著（搜得不準，但至少開得起來），同時排程去轉
function queryOf(it, provider) {
  const mq = (it?.map_query || "").trim();
  const fallback = (mq || it?.location_name || it?.title || "").trim();
  if (providerOf({ map_provider: provider }) !== "naver") return fallback;
  // 砍地區尾巴只對混雜寫法有意義。純英文名不能砍：官方英文名很多本來就以地名結尾，
  // 「Lotte City Hotel Jeju」砍成「Lotte City Hotel」會跑到首爾或大田的同名飯店。
  const cleaned = LATIN_ONLY.test(mq) ? mq : stripRegionTail(mq);
  if (naverSearchable(cleaned)) return cleaned;
  // 連退回原地名時也先清一次尾巴：naver_query 還沒補上的空窗期，
  // 用「뼈다귀에반하다」去搜也比「뼈다귀에반하다 Jeju」有機會搜到
  return (it?.naver_query || "").trim() || stripRegionTail(fallback) || fallback;
}

// 座標欄位沒填時 DB 回 null，而 Number(null) 是 0、Number.isFinite(0) 是 true ——
// 直接 Number() 會把「沒座標」當成「在幾內亞灣外海」，深連結就指到錯的地方。
const num = (v) => (v === null || v === undefined || v === "" ? NaN : Number(v));
const hasCoords = (it) => Number.isFinite(num(it?.lat)) && Number.isFinite(num(it?.lng));

// ---------- 單點搜尋連結 ----------
export function searchUrl(provider, query) {
  const enc = encodeURIComponent(query || "");
  if (providerOf({ map_provider: provider }) === "naver") {
    return `https://map.naver.com/p/search/${enc}`;
  }
  return `https://www.google.com/maps/search/?api=1&query=${enc}`;
}

// 單一行程項目要跳去的網頁地圖網址。Naver 會自動吃到 queryOf 轉好的韓文名。
//
// Google 有座標就直接用座標：文字搜尋是「猜」，同名地點一多就猜錯（實測
// 「屋島山上展望台」會開到愛知縣瀨戶市、「近鉄大阪難波駅」會開到生野區的信用金庫）。
// 座標是逐筆確認過的，沒有猜的空間。沒座標才退回文字搜尋。
// Naver 不走這條：它的網頁版吃 query 字串，座標要用 itemAppUrl 的 nmap:// 深連結。
export function itemMapUrl(provider, item) {
  const p = providerOf({ map_provider: provider });
  if (typeof item !== "string" && p === "google" && hasCoords(item)) {
    return searchUrl(p, `${num(item.lat)},${num(item.lng)}`);
  }
  const q = typeof item === "string" ? item : queryOf(item, p);
  return searchUrl(p, q);
}

// ---------- 手機 App 深連結 ----------
// 韓國人幾乎都用 Naver 的 App，網頁版體驗差很多。桌機開 nmap:// 只會跳出
// 「找不到應用程式」，所以只在觸控裝置回傳網址，其餘一律 null（呼叫端就走網頁）。
export function itemAppUrl(provider, item) {
  if (providerOf({ map_provider: provider }) !== "naver") return null;
  if (!window.matchMedia?.("(pointer: coarse)")?.matches) return null;

  const q = encodeURIComponent(queryOf(item, "naver"));
  if (!q) return null;
  const app = encodeURIComponent(location.hostname || "trip-planner");
  // 有座標就直接指到那個點，比用名字搜可靠（同名店家在韓國很多）
  if (hasCoords(item)) {
    return `nmap://place?lat=${num(item.lat)}&lng=${num(item.lng)}&name=${q}&appname=${app}`;
  }
  return `nmap://search?query=${q}&appname=${app}`;
}

// ---------- 整天路線連結（只有 Google）----------
// Naver 的網頁版路線網址官方沒有文件，而且要首尾座標才組得出來；既然 Naver 現在
// 是逐點跳轉、連地圖卡都不顯示，這裡就只服務 Google。

// Google Maps URLs 的上限：起點 + 終點 + 最多 9 個中途點。
const MAX_WAYPOINTS = 9;
const MAX_STOPS = MAX_WAYPOINTS + 2;

// 一站在網址裡長什麼樣。有座標就用座標：地名字串要 Google 自己 geocode，
// 「道後溫泉」這種到處都有同名的猜錯一站整條路線就歪掉。
//
// 沒地點的項目不算一站。queryOf 會一路退到 title，而移動段的 title 是
// 「德島道／高松道 → 高松」「出發往今治」這種句子 —— 拿去 geocode 會得到
// 完全不相干的座標（實測分別落在島根縣與中國南寧），整條路線就被拉歪。
// 所以路線只收「真的指得出地點」的項目：有座標，或有人填過地點/搜尋字。
function stopOf(it) {
  if (hasCoords(it)) return `${num(it.lat)},${num(it.lng)}`;
  if (!(it?.map_query || it?.location_name)) return "";
  return queryOf(it, "google");
}

/**
 * 把一批行程項目收成真的可以送給 Google 的站點序列。
 * 排序就是傳進來的順序（listItems 已經依日期→時間排過）。
 */
function routeStops(items) {
  const all = (items || []).map(stopOf).filter(Boolean);
  // 同一個地點連著出現很常見（早上從飯店出發、晚上又回同一家，或是同一個景點
  // 拆成兩筆）。連續重複對 Google 來說是一段長度 0 的路程，白白吃掉一個中途點名額。
  const dedup = all.filter((s, i) => s !== all[i - 1]);
  if (dedup.length <= MAX_STOPS) return { stops: dedup, total: dedup.length };
  // 超過上限：留住首尾（一天的起點跟過夜的地方最不能掉），中間取前 9 個。
  // 不假裝沒事：少掉幾站要讓使用者知道，所以連 total 一起回傳給介面去標。
  const stops = [dedup[0], ...dedup.slice(1, -1).slice(0, MAX_WAYPOINTS), dedup[dedup.length - 1]];
  return { stops, total: dedup.length };
}

/**
 * 整天路線。回傳 { url, used, total }，used < total 表示有站被 Google 的上限砍掉。
 *
 * 用官方文件化的 Maps URLs（dir/?api=1&origin=&destination=&waypoints=），
 * 不再用 /maps/dir/A/B/C 那種路徑式寫法 —— 路徑式沒有文件、手機點進去常常
 * 只開成一個搜尋結果而不是一條路線，也沒地方指定交通方式。
 *
 * travelmode 固定 driving：transit 在 Google 只支援「起點→終點」，帶中途點會被
 * 整排忽略，整天路線就斷了 —— 而這條連結的意義就是「一眼看完順不順路」。
 */
export function routePlan(provider, items) {
  const p = providerOf({ map_provider: provider });
  if (p !== "google") return { url: "https://map.naver.com/", used: 0, total: 0 };

  const { stops, total } = routeStops(items);
  if (stops.length === 0) return { url: "https://www.google.com/maps", used: 0, total: 0 };
  if (stops.length === 1) return { url: searchUrl("google", stops[0]), used: 1, total };

  const q = new URLSearchParams({
    api: "1",
    origin: stops[0],
    destination: stops[stops.length - 1],
    travelmode: "driving",
  });
  const mid = stops.slice(1, -1);
  // URLSearchParams 會把分隔用的 | 也編碼成 %7C，Google 照樣讀得懂，
  // 所以直接交給它組，不自己拼字串（站名裡的 & # 才不會把網址打斷）。
  if (mid.length) q.set("waypoints", mid.join("|"));
  return { url: `https://www.google.com/maps/dir/?${q}`, used: stops.length, total };
}

// ---------- 內嵌預覽（只有 Google）----------
export async function previewMap(provider, item, { silent = false } = {}) {
  const p = providerOf({ map_provider: provider });
  if (!hasEmbed(p)) return;
  const query = typeof item === "string" ? item : queryOf(item, p);
  if (!query) return;
  // 標題給看得懂的中文名；實際拿去搜的字不一樣時附在後面，這樣搜錯的時候
  // 一眼就看得出來，不用去猜為什麼地圖跑到別的地方
  const display = typeof item === "string" ? item : (item?.location_name || item?.title || query);
  setText("#mapTitle", query === display ? display : `${display}（${query}）`);

  const frame = $("#mapFrame");
  if (!frame) return;
  frame.hidden = false;
  // 跟 itemMapUrl 同一個道理：有座標就別讓 Google 再猜一次。
  // 「緯度,經度(名稱)」這個寫法會把圖釘釘在座標上，同時保留看得懂的標籤。
  const embedQ = (typeof item !== "string" && hasCoords(item))
    ? `${num(item.lat)},${num(item.lng)}(${display})`
    : query;
  frame.src = `https://www.google.com/maps?q=${encodeURIComponent(embedQ)}&output=embed`;
  if (!silent) frame.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

// ---------- 韓文地名解析 ----------
// Naver 只認韓文，但使用者是用中文排行程的。這裡一次把整批地點丟給 AI 轉成韓文，
// 結果寫回 DB（naver_query）當永久快取 —— 同行夥伴共用，之後都不用再花配額。
//
// 失敗一律安靜吞掉：轉不出來就用原本的中文地名去搜，頂多搜不準，
// 不該讓地圖卡整個壞掉，也不該把 AI 配額用完的錯誤丟到使用者臉上。

// 這一輪已經問過（含問了但 AI 也答不出來的），避免每次 render 又打一次 AI
const askedNaver = new Set();

export function forgetNaverQueries() { askedNaver.clear(); }

// 判斷條件是「map_query 不是 Naver 認得的寫法」而不是「完全沒有韓文」：後者會讓
// 「ARTE MUSEUM 제주」這種夾雜英文的寫法被當成已經轉好，永遠補不到 naver_query。
// 反過來，已經填了官方英文名的項目不必再問 AI —— 那個名字 Naver 本來就搜得到。
const needsNaver = (it) =>
  it?.id && !it.naver_query && !naverSearchable(stripRegionTail(it.map_query || ""))
  && (it.map_query || it.location_name || it.title);

/**
 * 補齊 items 的 naver_query。就地改寫傳進來的物件，並回傳有沒有補到東西
 * （呼叫端據此決定要不要重畫地圖連結）。
 */
export async function ensureNaverQueries(provider, items) {
  if (providerOf({ map_provider: provider }) !== "naver") return false;
  const need = (items || []).filter((it) => needsNaver(it) && !askedNaver.has(it.id));
  if (!need.length) return false;
  need.forEach((it) => askedNaver.add(it.id));

  let queries;
  try {
    ({ queries } = await callAI("resolve_naver_queries", {
      items: need.map((it) => ({
        ref: it.id, title: it.title,
        location_name: it.location_name, map_query: it.map_query,
      })),
    }));
  } catch {
    return false;
  }

  let changed = false;
  for (const row of queries || []) {
    const q = String(row?.q ?? "").trim();
    // 模型偶爾會把原文原樣吐回來 —— 沒有韓文就等於沒轉成功，別存進快取
    if (!q || !HANGUL.test(q)) continue;
    const it = need.find((x) => x.id === row.ref);
    if (!it) continue;                       // ref 對不上（模型幻覺），這筆丟掉
    it.naver_query = q;
    changed = true;
    updateItem(it.id, { naver_query: q }).catch(() => { /* 寫不回去不影響這次顯示 */ });
  }
  return changed;
}

// 換行程 / 換地圖服務時呼叫
export function resetMap() {
  const frame = $("#mapFrame");
  if (frame) { frame.hidden = true; frame.removeAttribute("src"); }
  setText("#mapTitle", "點行程項目的「地圖」即可在此顯示");
}

function setText(sel, txt) {
  const el = $(sel);
  if (el) el.textContent = txt;
}
