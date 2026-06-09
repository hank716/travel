// Supabase Edge Function: ai-assist  (Phase 5 才會完整實作)
// 金鑰只存在於此函式環境變數，前端永遠看不到：
//   supabase secrets set GEMINI_API_KEY=xxxx
//
// 部署：supabase functions deploy ai-assist
// 前端呼叫：supabase.functions.invoke("ai-assist", { body: { mode, ... } })
//
// 目前為佔位骨架，回傳 501，確認部署管線可用即可。

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  try {
    const { mode } = await req.json().catch(() => ({}));
    // TODO(Phase 5): mode === "suggest_itinerary" | "parse_expense" → 呼叫 Gemini
    return new Response(
      JSON.stringify({ error: "not_implemented", mode: mode ?? null }),
      { status: 501, headers: { ...CORS, "Content-Type": "application/json" } },
    );
  } catch (e) {
    return new Response(
      JSON.stringify({ error: String(e) }),
      { status: 500, headers: { ...CORS, "Content-Type": "application/json" } },
    );
  }
});
