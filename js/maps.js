// 地圖服務抽象層：每趟行程各自選 Google 或 Naver。
//
// 為什麼需要這層：韓國政府限制圖資輸出，Google Maps 在韓國沒有步行/大眾運輸
// 路線、店家資料也殘缺，排韓國行程幾乎沒用。但兩家的能力差很多，不是換個
// 網域就好：
//
//   Google  免金鑰的 iframe embed，只吃地名字串，多點路線一條網址就搞定
//   Naver   不能 iframe（X-Frame-Options），路線網址要座標不吃地名，
//           內嵌地圖得載官方 JS SDK 並附上 ncpKeyId
//
// 所以這裡的介面刻意收在「連結」與「畫進容器」兩件事上，讓 app.js 不必知道
// 上面那些差異。沒有金鑰時 Naver 自動退回純連結模式，不會壞。

import { geocode } from "@/weather.js";
import { updateItem } from "@/itinerary.js";
import { callAI } from "@/ai.js";
import { escapeHtml, toast } from "@/ui.js";

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

// 「這個字串可以原封不動丟給 Naver 嗎」＝ 有韓文，而且沒有夾雜獨立的英文單字。
// 夾雜英文的（如「ARTE MUSEUM 제주」）交給 AI 轉成在地正式名更準。
const isKoreanName = (s) => !!s && HANGUL.test(s) && !LATIN_WORD.test(s);

// 項目 → 拿來搜尋的字串。
// Google 吃中文地名；Naver 只認韓文（「濟州國際機場」搜不到，「제주국제공항」才行），
// 所以 Naver 有自己一條優先序：
//   1. map_query 清掉地區尾巴後是乾淨的韓文名 —— 使用者/AI 特地填的，最準，優先
//   2. naver_query —— AI 轉過並快取在 DB 的韓文名
//   3. 都沒有就先用原地名頂著（搜得不準，但至少開得起來），同時排程去轉
function queryOf(it, provider) {
  const mq = (it?.map_query || "").trim();
  const fallback = (mq || it?.location_name || it?.title || "").trim();
  if (providerOf({ map_provider: provider }) !== "naver") return fallback;
  const cleaned = stripRegionTail(mq);
  if (isKoreanName(cleaned)) return cleaned;
  // 連退回原地名時也先清一次尾巴：naver_query 還沒補上的空窗期，
  // 用「뼈다귀에반하다」去搜也比「뼈다귀에반하다 Jeju」有機會搜到
  return (it?.naver_query || "").trim() || stripRegionTail(fallback) || fallback;
}

// 座標欄位沒填時 DB 回 null，而 Number(null) 是 0、Number.isFinite(0) 是 true ——
// 直接 Number() 會把「沒座標」當成「在幾內亞灣外海」，路線網址就組出一條錯的。
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

// ---------- 整天路線連結 ----------
// items = 目前顯示的行程項目（itinerary rows）
export function routeUrl(provider, items) {
  const p = providerOf({ map_provider: provider });
  const list = (items || []).filter((i) => queryOf(i, p));
  if (p === "naver") return naverRouteUrl(list);

  // 注意不能寫成 list.map(queryOf)：map 會把索引當成第二個參數餵進 provider
  const pts = list.map((i) => queryOf(i, p));
  if (pts.length === 0) return "https://www.google.com/maps";
  if (pts.length === 1) return searchUrl("google", pts[0]);
  return "https://www.google.com/maps/dir/" + pts.map(encodeURIComponent).join("/");
}

// Naver 的網頁版路線網址官方沒有文件（NCP 只公開 nmap:// 那套），這裡的格式是
// 從實際站台觀察來的，隨時可能變。所以只在「首尾都有座標」時才組，其餘一律
// 退回單點搜尋 —— 格式哪天失效，最糟也只是變成搜尋，鈕不會壞掉。
function naverRouteUrl(list) {
  if (list.length === 0) return "https://map.naver.com/";
  if (list.length === 1) return searchUrl("naver", queryOf(list[0], "naver"));

  const s = list[0];
  const g = list[list.length - 1];
  if (!hasCoords(s) || !hasCoords(g)) return searchUrl("naver", queryOf(s, "naver"));

  const pt = (it) => `${it.lng},${it.lat},${encodeURIComponent(queryOf(it, "naver"))},,`;
  return `https://map.naver.com/p/directions/${pt(s)}/${pt(g)}/-/transit`;
}

// ---------- 手機 App 深連結 ----------
// 韓國人幾乎都用 Naver 的 App，網頁版體驗差很多。桌機開 nmap:// 只會跳出
// 「找不到應用程式」，所以只在觸控裝置給這顆鈕。
export function appUrl(provider, items) {
  if (providerOf({ map_provider: provider }) !== "naver") return null;
  if (!window.matchMedia?.("(pointer: coarse)")?.matches) return null;

  const q = (it) => encodeURIComponent(queryOf(it, "naver"));
  const list = (items || []).filter((i) => queryOf(i, "naver"));
  const app = encodeURIComponent(location.hostname || "trip-planner");
  const withXy = list.filter(hasCoords);
  if (withXy.length >= 2) {
    const s = withXy[0], g = withXy[withXy.length - 1];
    return "nmap://route/public?" +
      `slat=${s.lat}&slng=${s.lng}&sname=${q(s)}` +
      `&dlat=${g.lat}&dlng=${g.lng}&dname=${q(g)}&appname=${app}`;
  }
  if (withXy.length === 1) {
    const p = withXy[0];
    return `nmap://place?lat=${p.lat}&lng=${p.lng}&name=${q(p)}&appname=${app}`;
  }
  if (list.length) return `nmap://search?query=${q(list[0])}&appname=${app}`;
  return null;
}

// ---------- 內嵌預覽 ----------
// Google 走 iframe（#mapFrame），Naver 走 JS SDK 畫進 div（#mapCanvas）。
// 每次只顯示其中一個，另一個要確實清掉，否則換行程/換服務會殘留舊圖。
export async function previewMap(provider, item, { silent = false } = {}) {
  const p = providerOf({ map_provider: provider });
  const query = typeof item === "string" ? item : queryOf(item, p);
  if (!query) return;
  // 標題給看得懂的中文名；實際拿去搜的字不一樣時（Naver 的韓文）附在後面，
  // 這樣 AI 轉錯的時候一眼就看得出來，不用去猜為什麼地圖跑到別的地方
  const display = typeof item === "string" ? item : (item?.location_name || item?.title || query);
  setText("#mapTitle", query === display ? display : `${display}（${query}）`);

  if (p === "google") {
    clearNaver();
    const frame = $("#mapFrame");
    if (!frame) return;
    frame.hidden = false;
    frame.src = `https://www.google.com/maps?q=${encodeURIComponent(query)}&output=embed`;
    if (!silent) frame.scrollIntoView({ behavior: "smooth", block: "nearest" });
    return;
  }

  // Naver：先把 Google 的 iframe 收掉，免得兩張圖疊著
  clearGoogle();
  const box = $("#mapCanvas");
  if (!box) return;
  const it = typeof item === "string" ? { map_query: item } : item;
  const ok = await renderNaver(box, it, query);
  if (ok && !silent) box.scrollIntoView({ behavior: "smooth", block: "nearest" });
  if (!ok) {
    // 沒金鑰或載入失敗 —— 誠實地退回「開新分頁」的連結，別留一塊空白
    box.hidden = false;
    box.classList.add("map-fallback");
    box.innerHTML = `<p class="status">Naver 地圖不支援網頁內嵌預覽。</p>
      <a class="btn btn--sm" target="_blank" rel="noopener"
         href="${escapeHtml(searchUrl("naver", query))}">在 Naver 地圖開啟「${escapeHtml(query)}」</a>`;
  }
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

// 判斷條件是「map_query 不是乾淨的韓文名」而不是「完全沒有韓文」：後者會讓
// 「ARTE MUSEUM 제주」這種夾雜英文的寫法被當成已經轉好，永遠補不到 naver_query。
const needsNaver = (it) =>
  it?.id && !it.naver_query && !isKoreanName(stripRegionTail(it.map_query || ""))
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

// 換行程 / 換地圖服務時呼叫：兩個容器都清乾淨
export function resetMap() {
  clearGoogle();
  clearNaver();
  setText("#mapTitle", "點行程項目的「地圖」即可在此顯示");
}

function clearGoogle() {
  const frame = $("#mapFrame");
  if (frame) { frame.hidden = true; frame.removeAttribute("src"); }
}

function clearNaver() {
  const box = $("#mapCanvas");
  if (!box) return;
  box.hidden = true;
  box.classList.remove("map-fallback");
  box.innerHTML = "";
  naverMap = null;   // SDK 的實例綁在被清掉的 DOM 上，留著也沒用
}

function setText(sel, txt) {
  const el = $(sel);
  if (el) el.textContent = txt;
}

// ---------- Naver Maps JS API v3 ----------
// 金鑰是可鎖網域的前端金鑰（跟 Supabase anon key 同一類），放 config.js 安全。
// 沒設定就整條路徑安靜地退回連結模式，Google 行程完全不受影響。
let sdkPromise = null;
let naverMap = null;

function naverKey() {
  return (window.APP_CONFIG?.NAVER_MAP_KEY_ID || "").trim();
}

function loadNaverSdk() {
  if (sdkPromise) return sdkPromise;
  const key = naverKey();
  if (!key) return Promise.reject(new Error("no key"));
  sdkPromise = new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = `https://oapi.map.naver.com/openapi/v3/maps.js?ncpKeyId=${encodeURIComponent(key)}`;
    s.async = true;
    s.onload = () => (window.naver?.maps ? resolve(window.naver.maps) : reject(new Error("naver.maps 未就緒")));
    s.onerror = () => reject(new Error("Naver 地圖載入失敗"));
    document.head.appendChild(s);
  });
  // 失敗了要讓下一次還能重試（例如只是暫時斷線）
  sdkPromise.catch(() => { sdkPromise = null; });
  return sdkPromise;
}

// 回傳是否真的畫出來了；false = 呼叫端該退回連結模式
async function renderNaver(box, item, query) {
  if (!naverKey()) return false;

  const pos = await coordsFor(item, query);
  if (!pos) return false;

  let maps;
  try { maps = await loadNaverSdk(); }
  catch (e) {
    if (naverKey()) toast(e.message || "Naver 地圖載入失敗", false);
    return false;
  }

  try {
    box.hidden = false;
    box.classList.remove("map-fallback");
    box.innerHTML = "";
    const center = new maps.LatLng(pos.lat, pos.lng);
    naverMap = new maps.Map(box, { center, zoom: 16 });
    new maps.Marker({ position: center, map: naverMap, title: query });
    return true;
  } catch {
    return false;
  }
}

// 座標來源：優先用項目上已經存的，沒有就走 Open-Meteo 免金鑰地理編碼
// （weather.js 已經有 memo cache），拿到後順手寫回 DB，下次就不用再查。
// 不用 Naver 自己的 Geocoding API —— 那個要 server secret，得多開一支 Edge Function。
async function coordsFor(item, query) {
  if (hasCoords(item)) return { lat: num(item.lat), lng: num(item.lng) };
  const geo = await geocode(query);
  if (!geo) return null;
  if (item?.id) {
    updateItem(item.id, { lat: geo.lat, lng: geo.lon }).catch(() => { /* 寫不回去不影響顯示 */ });
    item.lat = geo.lat;
    item.lng = geo.lon;
  }
  return { lat: geo.lat, lng: geo.lon };
}
