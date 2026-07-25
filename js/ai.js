// 呼叫 Supabase Edge Function「ai-assist」（金鑰在 function 端，前端看不到）。
import { supabase } from "@/supabase.js";

export async function callAI(mode, payload = {}) {
  const { data, error } = await supabase.functions.invoke("ai-assist", {
    body: { mode, ...payload },
  });
  if (error) {
    // Edge Function 非 2xx 時，錯誤內容在 error.context
    let detail = error.message || "AI 服務錯誤";
    try { const j = await error.context?.json(); if (j?.error) detail = j.error; } catch { /* ignore */ }
    throw new Error(detail);
  }
  return data; // { text }
}

// Supabase 免費方案沒有 log，出事時在瀏覽器 console 打 __aiDiag() 就能知道
// 是金鑰沒設、模型飄移、還是配額用完。
window.__aiDiag = () => callAI("diag").then((d) => { console.log(d); return d; });
