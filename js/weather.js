// 天氣：行程地點 →（AI 推斷行政區）→ Open-Meteo 即時預報（超過範圍改去年同期參考）。
// 解析到的座標寫回 itinerary_items.lat/lng/weather_area 快取，避免重複呼叫 AI。
import { callAI } from "@/ai.js";
import { ymd } from "@/constants.js";
import { updateItem } from "@/itinerary.js";

const ICONS = {
  0: { icon: "☀️", label: "晴朗" }, 1: { icon: "🌤️", label: "大致晴朗" },
  2: { icon: "⛅", label: "局部多雲" }, 3: { icon: "☁️", label: "陰天" },
  45: { icon: "🌫️", label: "霧" }, 48: { icon: "🌫️", label: "凍霧" },
  51: { icon: "🌦️", label: "毛毛雨" }, 53: { icon: "🌦️", label: "毛毛雨" }, 55: { icon: "🌧️", label: "強毛毛雨" },
  61: { icon: "🌧️", label: "小雨" }, 63: { icon: "🌧️", label: "中雨" }, 65: { icon: "⛈️", label: "大雨" },
  66: { icon: "🌧️", label: "凍雨" }, 67: { icon: "🌧️", label: "凍雨" },
  71: { icon: "🌨️", label: "小雪" }, 73: { icon: "🌨️", label: "中雪" }, 75: { icon: "❄️", label: "大雪" },
  77: { icon: "🌨️", label: "霰" },
  80: { icon: "🌦️", label: "陣雨" }, 81: { icon: "🌧️", label: "陣雨" }, 82: { icon: "⛈️", label: "強陣雨" },
  85: { icon: "🌨️", label: "陣雪" }, 86: { icon: "❄️", label: "強陣雪" },
  95: { icon: "⛈️", label: "雷雨" }, 96: { icon: "⛈️", label: "雷雨夾冰雹" }, 99: { icon: "⛈️", label: "強雷雨" },
};

function uvLabel(uv) {
  if (uv == null) return null;
  if (uv < 3) return "低量"; if (uv < 6) return "中量";
  if (uv < 8) return "高量"; if (uv < 11) return "過量"; return "危險";
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function r0(v, f = "—") { return v == null ? f : Math.round(v); }

const FORECAST_DAILY = [
  "temperature_2m_max", "temperature_2m_min", "apparent_temperature_max",
  "precipitation_probability_max", "weathercode", "uv_index_max", "windspeed_10m_max",
];
const ARCHIVE_DAILY = ["temperature_2m_max", "temperature_2m_min", "weathercode", "precipitation_sum", "windspeed_10m_max"];

const geoCache = new Map();
let lastSummaries = [];

// 地理編碼（Open-Meteo，免金鑰）
//
// countryCode（ISO-3166 alpha-2）不是可有可無的裝飾：這個 API 的地名索引是全球的，
// 同名地點只按人口/權重排序。實測 geocode("Jeju") 的第一名是**衣索比亞**的 Jeju
// （8.41667, 39.63333），濟州連前三名都排不進去；帶上 countryCode=KR 才會回 Jeju City。
// 呼叫端只要知道國家就務必傳，並用回傳的 countryCode 再驗一次（見 resolveEntries）。
export async function geocode(query, { countryCode = "" } = {}) {
  if (!query) return null;
  const cc = (countryCode || "").trim().toUpperCase();
  const key = query.trim().toLowerCase() + "|" + cc;
  if (geoCache.has(key)) return geoCache.get(key);
  let result = null;
  try {
    const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(query)}`
      + `&count=1&language=zh&format=json${cc ? `&countryCode=${encodeURIComponent(cc)}` : ""}`;
    const r = await fetch(url);
    const j = await r.json();
    const g = j.results && j.results[0];
    if (g) {
      const admin = g.admin1 && g.admin1 !== g.name ? ` · ${g.admin1}` : "";
      result = {
        lat: g.latitude, lon: g.longitude, name: g.name + admin,
        country: g.country, countryCode: (g.country_code || "").toUpperCase(),
      };
    }
  } catch { /* ignore */ }
  geoCache.set(key, result);
  return result;
}

function withinForecast(date) {
  const d = new Date(date + "T00:00:00");
  const now = new Date(); now.setHours(0, 0, 0, 0);
  const diff = (d - now) / 86400000;
  return diff >= -1 && diff <= 15; // Open-Meteo 預報約未來 16 天
}

// 取得某地某日天氣：範圍內用 forecast，否則用去年同期 archive
async function fetchDay(lat, lon, date) {
  if (withinForecast(date)) {
    const p = new URLSearchParams({
      latitude: lat, longitude: lon, daily: FORECAST_DAILY.join(","),
      timezone: "auto", start_date: date, end_date: date,
    });
    const r = await fetch(`https://api.open-meteo.com/v1/forecast?${p}`);
    if (!r.ok) throw new Error("forecast " + r.status);
    return { source: "forecast", daily: (await r.json()).daily };
  }
  const ly = (Number(date.slice(0, 4)) - 1) + date.slice(4); // 去年同月日
  const p = new URLSearchParams({
    latitude: lat, longitude: lon, daily: ARCHIVE_DAILY.join(","),
    timezone: "auto", start_date: ly, end_date: ly,
  });
  const r = await fetch(`https://archive-api.open-meteo.com/v1/archive?${p}`);
  if (!r.ok) throw new Error("archive " + r.status);
  return { source: "climate", refDate: ly, daily: (await r.json()).daily };
}

// 行程 → 每天代表項目（取每天第一個有地點的項目）
function deriveDayLocations(items) {
  const byDay = new Map();
  for (const it of items) {
    if (!it.day_date) continue;
    if (!(it.location_name || it.map_query)) continue;
    if (!byDay.has(it.day_date)) {
      byDay.set(it.day_date, {
        date: it.day_date,
        item: it,
        query: it.location_name || it.map_query,
      });
    }
  }
  return [...byDay.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
}

function cardHtml(e) {
  const wd = ["日", "一", "二", "三", "四", "五", "六"][new Date(e.date + "T00:00:00").getDay()];
  const head = `<div class="fc-head"><span class="fc-city">${esc(e.geo ? e.geo.name : e.query)}</span><span class="fc-date">${e.date.slice(5)}（${wd}）</span></div>`;
  if (e.error || !e.res) {
    return `<div class="forecast-card">${head}<p class="fc-cond">${esc(e.error || "查無天氣")}</p></div>`;
  }
  const d = e.res.daily, i = 0;
  const meta = ICONS[d.weathercode?.[i]] || { icon: "🌤️", label: "—" };
  const climate = e.res.source === "climate";
  const pop = d.precipitation_probability_max?.[i];
  const uv = uvLabel(d.uv_index_max?.[i]);
  const wind = d.windspeed_10m_max?.[i];
  const app = d.apparent_temperature_max?.[i];
  return `<div class="forecast-card">
    ${head}
    <div class="fc-icon">${meta.icon}</div>
    <div class="fc-temp">${r0(d.temperature_2m_max?.[i])}° <small>/ ${r0(d.temperature_2m_min?.[i])}°</small>${climate ? '<span class="fc-tag">去年同期參考</span>' : ""}</div>
    <div class="fc-cond">${meta.label}</div>
    <div class="fc-meta">
      ${pop != null ? `<span>降雨 <b>${r0(pop)}%</b></span>` : ""}
      ${app != null ? `<span>體感 <b>${r0(app)}°</b></span>` : ""}
      ${uv ? `<span>UV <b>${uv}</b></span>` : ""}
      ${wind != null ? `<span>風速 <b>${r0(wind)}km/h</b></span>` : ""}
    </div>
    ${climate ? `<p class="fc-note status">超過預報範圍，顯示 ${e.res.refDate} 實測供參考。</p>` : ""}
  </div>`;
}

function toSummary(e) {
  const d = e.res.daily, i = 0;
  return {
    date: e.date, city: e.geo?.name || e.query,
    tmax: d.temperature_2m_max?.[i], tmin: d.temperature_2m_min?.[i],
    pop: d.precipitation_probability_max?.[i] ?? null,
    condition: (ICONS[d.weathercode?.[i]] || {}).label || "",
    source: e.res.source,
  };
}

// 對沒有座標的日子，一次呼叫 AI 取得各日行政區
async function resolveAreas(days) {
  const need = days.filter((d) => !(d.item.lat && d.item.lng));
  if (!need.length) return {};
  try {
    const { areas } = await callAI("resolve_districts", {
      days: need.map((d) => ({
        date: d.date, title: d.item.title,
        location_name: d.item.location_name, map_query: d.item.map_query,
      })),
    });
    const map = {};
    for (const a of areas || []) {
      if (!a || !a.date) continue;
      map[a.date] = { area: a.area || "", geo: a.geo || a.area || "", cc: (a.cc || "").toUpperCase() };
    }
    return map;
  } catch {
    return {}; // AI 失敗 → 後面以原始地名回退
  }
}

async function resolveEntries(days) {
  const areaByDate = await resolveAreas(days);
  return Promise.all(days.map(async (dd) => {
    try {
      const it = dd.item;
      let geo = null;
      let area = null;

      if (it.lat && it.lng) {
        // 已快取座標，直接用
        geo = { lat: it.lat, lon: it.lng, name: it.weather_area || it.location_name || dd.query };
      } else {
        const resolved = areaByDate[dd.date] || null;     // { area, geo, cc } 或 null
        area = resolved?.area || null;
        const cc = resolved?.cc || "";
        const opts = { countryCode: cc };
        geo = (resolved?.geo ? await geocode(resolved.geo, opts) : null)
          || (area ? await geocode(area, opts) : null)
          || await geocode(it.location_name || dd.query, opts)
          || (it.map_query ? await geocode(it.map_query, opts) : null);
        // 寫回快取（座標 + 行政區標籤），下次與夥伴都免再呼叫 AI。
        //
        // 但 lat/lng 是跟 maps.js 共用的欄位（Naver 路線網址、nmap:// 深連結、內嵌地圖都讀它），
        // 而這裡的地名是 AI 猜的羅馬拼音、又只取地理編碼的第一名 —— 猜錯的代價不是天氣不準，
        // 是整條路線被帶到別的國家（真的發生過：AI 回 "Jeju"，寫進去的是衣索比亞的座標）。
        // 所以只有在確定國家對得上時才寫座標；對不上就只留行政區標籤，
        // 座標留空讓 maps.js 自己用真正的地名去查，天氣本次仍照常顯示。
        // 刻意要求「AI 給了國碼」且「地理編碼結果的國家對得上」兩者都成立才寫座標：
        // 沒有國碼可比對時就是無從驗證，寧可不快取（下次重查一次而已），
        // 也不要再往共用欄位塞一個沒人檢查過的座標。
        if (geo) {
          const trusted = !!cc && geo.countryCode === cc;
          const patch = { weather_area: area || geo.name };
          if (trusted) { patch.lat = geo.lat; patch.lng = geo.lon; }
          updateItem(it.id, patch).catch(() => {});
        }
      }
      if (!geo) return { ...dd, error: "找不到地點：" + dd.query };
      const label = area || geo.name;
      return { ...dd, geo: { ...geo, name: label }, res: await fetchDay(geo.lat, geo.lon, dd.date) };
    } catch {
      return { ...dd, error: "天氣讀取失敗" };
    }
  }));
}

const $grid = () => document.querySelector("#forecastGrid");
const $sub = () => document.querySelector("#weatherSubtitle");

// 依行程地點載入天氣
export async function loadItineraryWeather(items) {
  const grid = $grid();
  const days = deriveDayLocations(items);
  if (!days.length) {
    grid.innerHTML = `<p class="status">行程還沒有「有地點」的項目。到行程頁新增帶地點的項目，或在上方手動查城市。</p>`;
    lastSummaries = [];
    return [];
  }
  grid.innerHTML = days.map(() => `<div class="fc-skeleton"></div>`).join("");
  const entries = await resolveEntries(days);
  grid.innerHTML = entries.map(cardHtml).join("");
  lastSummaries = entries.filter((e) => e.res).map(toSummary);
  if ($sub()) $sub().textContent = `依行程地點即時取得 Open-Meteo 預報 · 共 ${days.length} 天`;
  return lastSummaries;
}

// 手動查某城市（今天起 3 天）
export async function loadCityWeather(query) {
  const grid = $grid();
  grid.innerHTML = `<div class="fc-skeleton"></div>`;
  const geo = await geocode(query);
  if (!geo) { grid.innerHTML = `<p class="status">找不到「${esc(query)}」這個地點。</p>`; lastSummaries = []; return []; }
  // 用本地日期：toISOString() 是 UTC，台北時間早上 8 點前會查成昨天
  const dates = [0, 1, 2].map((o) => {
    const d = new Date(); d.setDate(d.getDate() + o); return ymd(d);
  });
  const entries = await Promise.all(dates.map(async (date) => {
    try { return { date, query, geo, res: await fetchDay(geo.lat, geo.lon, date) }; }
    catch { return { date, query, geo, error: "天氣讀取失敗" }; }
  }));
  grid.innerHTML = entries.map(cardHtml).join("");
  lastSummaries = entries.filter((e) => e.res).map(toSummary);
  if ($sub()) $sub().textContent = `${geo.name} 未來 3 天天氣`;
  return lastSummaries;
}

export function getWeatherSummaries() { return lastSummaries; }
