// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Hank Wang

// 公開設定 — 可安全 commit 進 public repo。
// Supabase URL 與 anon key 本來就是要給瀏覽器用的，資料安全靠 RLS（見 supabase/schema.sql）。
// ⚠️ service_role key / Gemini key 絕不可寫在這裡。
window.APP_CONFIG = {
  SUPABASE_URL: "https://bmwzoqdypgrwmcxasxnr.supabase.co",
  SUPABASE_ANON_KEY:
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJtd3pvcWR5cGdyd21jeGFzeG5yIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA5NzQ1NDAsImV4cCI6MjA5NjU1MDU0MH0.fLuCl3NK-X-JDvB1GZ3YwECwLvgbdL-vUD3pZ65jpeY",

  // 預設值（每趟行程仍可在 DB 各自覆寫，達成跨旅行復用）
  // 不預設任何特定國家的幣別；只帶基準幣別，其餘由使用者自行加入
  DEFAULT_BASE_CURRENCY: "TWD",
  DEFAULT_CURRENCIES: ["TWD"],

  // 唯一管理員（寫死）。只有這個 Email 註冊會是 admin；前端也用它擋註冊。
  // 若要更換，記得 supabase/schema.sql 的 handle_new_user 觸發器也要同步改。
  ADMIN_EMAIL: "hank.wang.716@gmail.com",
};
