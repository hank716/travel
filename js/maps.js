// 地圖服務抽象層：每趟行程各自選 Google 或 Naver。
//
// 為什麼需要這層：韓國政府限制圖資輸出，Google Maps 在韓國沒有步行/大眾運輸
// 路線、店家資料也殘缺，排韓國行程幾乎沒用。但兩家的能力差很多，不是換個
// 網域就好：
//
//   Google  免金鑰的 iframe embed，只吃地名字串，多點路線一條網址就搞定
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
export function itemMapUrl(provider, item) {
  const p = providerOf({ map_provider: provider });
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
// items = 目前顯示的行程項目（itinerary rows）
export function routeUrl(provider, items) {
  const p = providerOf({ map_provider: provider });
  if (p !== "google") return "https://map.naver.com/";

  // 注意不能寫成 list.map(queryOf)：map 會把索引當成第二個參數餵進 provider
  const pts = (items || []).map((i) => queryOf(i, p)).filter(Boolean);
  if (pts.length === 0) return "https://www.google.com/maps";
  if (pts.length === 1) return searchUrl("google", pts[0]);
  return "https://www.google.com/maps/dir/" + pts.map(encodeURIComponent).join("/");
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
  frame.src = `https://www.google.com/maps?q=${encodeURIComponent(query)}&output=embed`;
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
