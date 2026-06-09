# 日本旅遊規劃系統

多人 · 多幣別 · 即時的旅遊規劃 / 記帳網頁。前端純靜態跑在 **GitHub Pages**，後端用 **Supabase**（Postgres + RLS + Realtime + Edge Functions）。完整架構見 [`PLAN.md`](./PLAN.md)。

## 目前進度
- ✅ **Phase 0** 基礎：repo 結構、`schema.sql` + RLS、可部署骨架
- ⬜ Phase 1 加入行程（行程碼 + 名字）
- ⬜ Phase 2 行程 CRUD ｜ Phase 3 多幣別記帳 ｜ Phase 4 天氣 ｜ Phase 5 AI ｜ Phase 6 收尾

## 結構
```
index.html              連線檢查骨架（Phase 1 起變主應用）
config.js               Supabase URL + anon key（公開、可 commit）
css/app.css             設計系統
js/supabase.js          client + 匿名登入
supabase/schema.sql     建表 + RLS + RPC（create_trip / join_trip）
supabase/functions/ai-assist/   Edge Function（Gemini，Phase 5）
legacy/                 舊的高雄×台南行程頁（保留參考）
```

## 啟用步驟（Phase 0 驗收）

### 1. 套用資料庫 schema
Supabase Dashboard → **SQL Editor** → 貼上 [`supabase/schema.sql`](./supabase/schema.sql) 全部 → Run。

### 2. 開啟匿名登入
Dashboard → **Authentication → Providers → Anonymous** → 開啟。

### 3. 本機預覽
```bash
python3 -m http.server 5173
# 開 http://localhost:5173 — 兩個狀態都應顯示綠色「正常 / 已取得」
```

### 4. 部署 GitHub Pages
Push 到 `main` → repo **Settings → Pages → Source: main / root**。

## 祕密金鑰（絕不進 repo）
- `service_role key`：只在本機 Supabase CLI 用，可繞過 RLS。
- `GEMINI_API_KEY`：只設到 Edge Function — `supabase secrets set GEMINI_API_KEY=xxx`。

`.gitignore` 已擋掉 `.env` 等檔案。
