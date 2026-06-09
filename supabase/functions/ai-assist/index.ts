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

const GEMINI_MODEL = "gemini-2.0-flash";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers: { ...CORS, "Content-Type": "application/json" },
  });
}

async function gemini(prompt: string): Promise<string> {
  const key = Deno.env.get("GEMINI_API_KEY");
  if (!key) throw new Error("尚未設定 GEMINI_API_KEY");
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${key}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.7, maxOutputTokens: 800 },
    }),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Gemini ${res.status}: ${t.slice(0, 300)}`);
  }
  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.map((p: { text?: string }) => p.text).join("") ?? "";
  return text.trim();
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

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const { mode, ...payload } = await req.json().catch(() => ({}));
    switch (mode) {
      case "weather_suggest": {
        const text = await gemini(weatherPrompt(payload));
        return json({ text });
      }
      // Phase 5 接續：
      // case "suggest_itinerary": ...
      // case "parse_expense": ...
      default:
        return json({ error: `不支援的 mode：${mode ?? "(空)"}` }, 400);
    }
  } catch (e) {
    return json({ error: String((e as Error)?.message ?? e) }, 500);
  }
});
