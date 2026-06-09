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
const GEMINI_MODELS = ["gemini-2.5-flash", "gemini-2.5-flash-lite"];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers: { ...CORS, "Content-Type": "application/json" },
  });
}

async function gemini(prompt: string, opts: { jsonOut?: boolean } = {}): Promise<string> {
  const key = Deno.env.get("GEMINI_API_KEY");
  if (!key) throw new Error("尚未設定 GEMINI_API_KEY");
  const generationConfig: Record<string, unknown> = {
    temperature: opts.jsonOut ? 0.2 : 0.7,
    maxOutputTokens: 800,
  };
  if (opts.jsonOut) generationConfig.responseMimeType = "application/json";
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
      // Phase 5 接續：suggest_itinerary / parse_expense
      default:
        return json({ error: `不支援的 mode：${mode ?? "(空)"}` }, 400);
    }
  } catch (e) {
    return json({ error: String((e as Error)?.message ?? e) }, 500);
  }
});
