// Supabase Edge Function: ai-assist
// 金鑰只存在於此函式環境變數，前端永遠看不到：
//   supabase secrets set GEMINI_API_KEY=xxxx
//   supabase functions deploy ai-assist
//
// 前端呼叫：supabase.functions.invoke("ai-assist", { body: { mode, ... } })

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// 主模型 + 備援；遇 503/429 會重試與切換
const GEMINI_MODELS = ["gemini-flash-latest", "gemini-flash-lite-latest"];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers: { ...CORS, "Content-Type": "application/json" },
  });
}

async function gemini(prompt: string, opts: { jsonOut?: boolean; maxTokens?: number } = {}): Promise<string> {
  const key = Deno.env.get("GEMINI_API_KEY");
  if (!key) throw new Error("尚未設定 GEMINI_API_KEY");
  const generationConfig: Record<string, unknown> = {
    temperature: opts.jsonOut ? 0.2 : 0.7,
    maxOutputTokens: opts.maxTokens ?? 800,
  };
  if (opts.jsonOut) {
    generationConfig.responseMimeType = "application/json";
    // 2.5-flash 是 thinking 模型，會吃掉輸出額度導致結構化結果為空 → 結構化模式關閉思考
    generationConfig.thinkingConfig = { thinkingBudget: 0 };
  }
  const body = JSON.stringify({
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig,
  });

  let lastErr = "";
  for (const model of GEMINI_MODELS) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;
      const res = await fetch(url, {
        method: "POST", headers: { "Content-Type": "application/json" }, body,
      });
      if (res.ok) {
        const data = await res.json();
        return (data?.candidates?.[0]?.content?.parts?.map((p: { text?: string }) => p.text).join("") ?? "").trim();
      }
      const t = await res.text();
      lastErr = `${res.status}: ${t.slice(0, 160)}`;
      if (res.status === 404) break;                 // 模型不存在 → 換下一個
      if (res.status === 503 || res.status === 429) { // 壅塞/限流 → 退避重試
        await sleep(1200 * (attempt + 1));
        continue;
      }
      throw new Error(`Gemini ${lastErr}`);            // 其他錯誤直接拋
    }
  }
  throw new Error(`Gemini 暫時無法使用，請稍後再試（${lastErr}）`);
}

function weatherPrompt(payload: Record<string, unknown>): string {
  const trip = (payload.trip ?? {}) as { title?: string };
  const days = (payload.days ?? []) as Array<Record<string, unknown>>;
  const lines = days.map((d) =>
    `- ${d.date} ${d.city}：${d.condition}，氣溫 ${d.tmin ?? "?"}~${d.tmax ?? "?"}°C，降雨機率 ${d.pop ?? "?"}%${d.source === "climate" ? "（去年同期參考）" : ""}`
  ).join("\n");
  return [
    `你是貼心的旅遊助理。以下是「${trip.title ?? "這趟旅行"}」每天的天氣：`,
    lines,
    "",
    "請用繁體中文，針對每一天給 1–2 句具體建議，包含：",
    "1) 穿搭與攜帶物（如雨具、防曬、保暖）；",
    "2) 若當天降雨機率偏高或天氣不佳，建議把室內景點（美術館、博物館、購物中心）排在該時段。",
    "語氣friendly、條列、精簡，不要重複天氣數據本身。",
  ].join("\n");
}

// 把每天的行程地點解析成「可查天氣的行政區」
function districtsPrompt(payload: Record<string, unknown>): string {
  const days = (payload.days ?? []) as Array<Record<string, unknown>>;
  const lines = days.map((d) =>
    `- date=${d.date}｜地點：${[d.title, d.location_name, d.map_query].filter(Boolean).join("、")}`
  ).join("\n");
  return [
    "你是地理助理。根據每天的行程地點，判斷它所在的行政區，用於查詢天氣。",
    "每天回兩個欄位：",
    "- area：給人看的行政區（中文）。台灣用「縣市+區」如「高雄市左營區」；日本用「都道府縣+市區町村」如「東京都台東区」；其他國家用城市名。",
    "- geo：給地理編碼 API 搜尋用的『羅馬拼音/英文』地名（重要：不要中文、不要含上層縣市），例如左營→Zuoying、台東区→Taito、安平→Anping；若不確定區級拼音就給城市英文名，如 Kaohsiung、Tokyo、Osaka、Paris。",
    "",
    "行程：",
    lines,
    "",
    '只輸出 JSON 陣列，格式：[{"date":"YYYY-MM-DD","area":"行政區中文","geo":"RomanizedName"}]，date 必須與輸入相同。',
  ].join("\n");
}

// AI 排行程
function itineraryPrompt(payload: Record<string, unknown>): string {
  const trip = (payload.trip ?? {}) as { title?: string; start?: string; end?: string };
  const area = (payload.area as string) || "";
  const days = (payload.days as string[]) || [];
  const existing = (payload.existing as string[]) || [];
  // notes：使用者貼上、已自行整理的資料（可能是 Markdown）。prefs 為舊欄位，仍相容。
  const notes = ((payload.notes ?? payload.prefs) as string) || "";
  return [
    `你是專業旅遊行程規劃師。請為「${trip.title ?? "這趟旅行"}」建議行程。`,
    area ? `主要地區：${area}` : "",
    days.length ? `要規劃的日期：${days.join("、")}` : (trip.start ? `期間：${trip.start} ~ ${trip.end ?? ""}` : ""),
    existing.length ? `已排的項目（請勿重複，可與之串接路線）：${existing.join("、")}` : "",
    notes ? `使用者已整理的參考資料（可能為 Markdown，可能含景點/餐廳/時間/備註）。請『優先』採用其中提到的具體地點，盡量保留其名稱與順序，依地理位置補齊與排順；缺日期者再分配到上面的日期：\n---\n${notes}\n---` : "",
    "",
    "為每一天安排 3~5 個具體景點/餐廳，依地理位置與時間排成順路、不重疊的一日動線（從早到晚）。若上面已有參考資料，以它為主、你再補強。",
    "盡量把每個欄位都填好：start_time/end_time 給合理時段（HH:MM，24 小時制）、category 分類、location_name 完整可搜尋地名、note 一句具體建議；只有真的無法判斷的欄位才留空字串。",
    '只輸出 JSON 陣列：[{"day_date":"YYYY-MM-DD","start_time":"HH:MM","end_time":"HH:MM","title":"地點名","category":"景點|餐廳|交通|住宿|購物|其他","location_name":"可在Google地圖搜尋的完整地名","note":"一句話建議"}]。',
    "day_date 用上面的日期；location_name 要含城市，能被地圖搜尋。",
  ].filter(Boolean).join("\n");
}

// 記帳語意解析
function expensePrompt(payload: Record<string, unknown>): string {
  const text = (payload.text as string) || "";
  const members = (payload.members as Array<{ id: string; name: string }>) || [];
  const currencies = (payload.currencies as string[]) || [];
  const base = (payload.base as string) || "";
  return [
    "你是記帳助理，把一句話拆成結構化支出。",
    `成員清單：${members.map((m) => m.name).join("、") || "（無）"}`,
    `可用幣別：${currencies.join("、") || base}（基準幣別：${base}）`,
    `句子：「${text}」`,
    "",
    "規則：",
    "- amount 數字；currency 從可用幣別猜（沒提到就用基準幣別）；",
    "- category 從 餐飲|交通|住宿|購物|門票|其他 擇一；",
    "- paid_by 是付款人名字（沒提到就留空字串）；",
    "- splits 是分攤者名字陣列（『我跟小明分』=我與小明；沒提到就空陣列代表全部均分）；",
    "- description 簡短說明。",
    '只輸出 JSON 物件：{"amount":number,"currency":"代碼","category":"類別","description":"說明","paid_by":"名字","splits":["名字"]}。',
  ].join("\n");
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const { mode, ...payload } = await req.json().catch(() => ({}));
    switch (mode) {
      case "weather_suggest": {
        const text = await gemini(weatherPrompt(payload));
        return json({ text });
      }
      case "resolve_districts": {
        const raw = await gemini(districtsPrompt(payload), { jsonOut: true });
        let areas: unknown = [];
        try { areas = JSON.parse(raw); } catch { areas = []; }
        return json({ areas });
      }
      case "suggest_itinerary": {
        const raw = await gemini(itineraryPrompt(payload), { jsonOut: true, maxTokens: 3072 });
        let parsed: unknown = [];
        try { parsed = JSON.parse(raw); } catch { parsed = []; }
        // 容錯：可能回成物件包陣列
        let items: unknown[] = Array.isArray(parsed) ? parsed
          : (Array.isArray((parsed as Record<string, unknown>)?.items) ? (parsed as { items: unknown[] }).items
          : Array.isArray((parsed as Record<string, unknown>)?.itinerary) ? (parsed as { itinerary: unknown[] }).itinerary
          : []);
        return json({ items });
      }
      case "parse_expense": {
        const raw = await gemini(expensePrompt(payload), { jsonOut: true });
        let parsed: unknown = {};
        try { parsed = JSON.parse(raw); } catch { parsed = {}; }
        return json({ parsed });
      }
      default:
        return json({ error: `不支援的 mode：${mode ?? "(空)"}` }, 400);
    }
  } catch (e) {
    return json({ error: String((e as Error)?.message ?? e) }, 500);
  }
});
