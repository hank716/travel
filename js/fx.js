// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Hank Wang

// 即時匯率：open.er-api.com（免金鑰，含全球主要貨幣）。
// 三層快取：記憶體 → Supabase fx_cache（每日一筆，跨裝置共用）→ 外部 API。
import { supabase } from "@/supabase.js";

const mem = new Map(); // base -> { rates, date }

function today() {
  return new Date().toISOString().slice(0, 10);
}

// 取得以 base 為基準的匯率表 { USD: 1, JPY: 156.2, ... }
export async function getRates(base) {
  base = (base || "USD").toUpperCase();
  const d = today();

  const cached = mem.get(base);
  if (cached && cached.date === d) return cached.rates;

  // Supabase 每日快取
  try {
    const { data } = await supabase
      .from("fx_cache").select("rates").eq("date", d).eq("base", base).maybeSingle();
    if (data?.rates) {
      mem.set(base, { rates: data.rates, date: d });
      return data.rates;
    }
  } catch { /* 略過，往下打 API */ }

  // 外部 API
  const res = await fetch(`https://open.er-api.com/v6/latest/${base}`);
  if (!res.ok) throw new Error("匯率服務暫時無法使用");
  const json = await res.json();
  if (json.result !== "success" || !json.rates) throw new Error("匯率資料格式異常");
  const rates = json.rates;

  mem.set(base, { rates, date: d });
  // 寫回快取（失敗不影響使用）
  supabase.from("fx_cache").upsert(
    { date: d, base, rates }, { onConflict: "date,base" }
  ).then(() => {}, () => {});

  return rates;
}

// 換算：amount(from) → to。rates 為以 from 同基準的表時無法直接用，故統一用「以 base 表」。
// 傳入以 base 為基準的 rates：1 base = rates[X] X。
export function convert(amount, from, to, ratesByBase, base) {
  if (from === to) return amount;
  const rFrom = from === base ? 1 : ratesByBase[from];
  const rTo = to === base ? 1 : ratesByBase[to];
  if (!rFrom || !rTo) return null;
  // amount(from) → base → to
  const inBase = amount / rFrom;
  return inBase * rTo;
}

// 1 單位 code 等於多少 base（給 UI 顯示用）
export function rateToBase(code, ratesByBase, base) {
  if (code === base) return 1;
  const r = ratesByBase[code];
  if (!r) return null;
  return 1 / r;
}
