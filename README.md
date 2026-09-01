# 🧳 旅程規劃 · Trip Planner

[![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-blue.svg)](./LICENSE)

多人共用、多幣別、即時同步的**旅遊規劃 + 記帳**網頁 App。

排行程、記帳分帳、查天氣、列行李、寫備忘——一趟旅行需要的都在同一個地方，
而且**每個人的裝置即時同步**：你在手機上加一筆支出，同行的人畫面上馬上就出現。

**線上版**：<https://hank716.github.io/travel/>

前端是**零建置的純靜態網頁**（沒有 npm、沒有打包工具，`index.html` 直接開就能跑），
後端全靠 **Supabase**（Postgres + RLS + Realtime + Edge Functions）。
架構與設計取捨見 [`PLAN.md`](./PLAN.md)。

---

## 60 秒 Demo 動線

> 建議先在管理後台按一次「🎌 示範行程」灌好假資料（見下方[示範行程](#示範行程一鍵灌滿假資料)），
> 出發日固定是「按下按鈕當天 + 7 天」，所以天氣頁一定拿得到真的預報。

| # | 頁面 | 講什麼 |
|---|------|--------|
| 1 | **🏠 總覽** | 一眼看完整趟：倒數天數、今日行程、花費小計、成員頭像。點卡片直接跳對應分頁。 |
| 2 | **🗺️ 行程** | 依日期分頁的行程表。→ 開一個項目，按地圖圖示帶出 Google Maps；把行程的地圖切成 Naver，同一個項目改成跳出去開韓國圖資。 |
| 3 | **🤖 AI（行程頁內）** | 用一句話講「幫我排京都第二天」→ Gemini 回結構化行程草稿 → **你確認後才寫進 DB**。記帳、行李也吃同一套對話式編輯。 |
| 4 | **💰 記帳** | 三種幣別混著記，每筆存**當下匯率快照**。→ 切到結算，看每人餘額與「最少轉帳筆數」的還錢建議。 |
| 5 | **⛅ 天氣** | 行程地點自動地理編碼 → Open-Meteo 逐日預報（超過預報範圍就改抓去年同期當參考）。 |
| 6 | **📱 即時同步** | 開兩個瀏覽器/手機同時登入同一趟，在 A 加一筆支出，B 不用重整就跳出來。**這段最有感，留到最後壓軸。** |
| 7 | **⚙️ 管理** | 管理員專屬：開帳號、指派行程、設唯讀成員、重設密碼。 |

隱藏操作：清單項目**向左滑**可刪除（桌機是 hover 出現按鈕）；行程切換在左上角標題的 ▾。

---

## 功能

**規劃**
- 行程項目 CRUD，依日期分頁，拖拉排序
- 地圖雙供應商：**Google**（免金鑰 iframe 內嵌 + 整天路線）／**Naver**（韓國圖資，逐點跳出去開）
- 每趟行程各自選地圖服務——韓國政府限制圖資輸出，Google 在韓國沒有步行/大眾運輸路線

**記帳**
- 全世界幣別（ISO 4217 完整清單）+ open.er-api 即時匯率、三層快取
- 每筆支出存原幣金額 **+ 記帳當下的匯率快照**，之後匯率變動不會改寫歷史帳
- 分帳（誰付、誰分攤）、各幣別小計
- 結算頁：每人餘額 + **最少轉帳筆數**的還錢建議

**其他**
- ⛅ 天氣：Open-Meteo 逐日預報，超出範圍顯示去年同期參考
- 🎒 行李清單、📝 備忘 + 留言
- 🤖 AI 助手（Gemini）：排行程、記帳語意輸入（「拉麵 1200 円我跟小明分」）、對話式修改行程/記帳/行李
- 🔄 Realtime：行程、記帳、成員、行李、備忘全部即時同步
- 📱 RWD：桌機常駐側欄、手機抽屜導航；可「加到主畫面」

**帳號與權限**
- 單一管理員（Email + 密碼），成員帳號由管理員建立並指派行程
- 成員分**可編輯／唯讀**兩級
- 一個帳號可同時在多趟行程，左上角切換

---

## 架構

```
┌──────────────────────────┐          ┌────────────────────────────────┐
│  GitHub Pages（純靜態）   │          │  Supabase                      │
│  index.html + js/ + css/ │  HTTPS   │  ┌──────────────────────────┐  │
│  · Supabase JS（CDN）    │◀────────▶│  │ Postgres + RLS           │  │
│  · ES Modules + importmap│          │  │ Realtime（即時同步）      │  │
│  · 無 build step         │          │  │ Auth（Email/密碼）        │  │
└───────────┬──────────────┘          │  └──────────────────────────┘  │
            │                         │  ┌──────────────────────────┐  │
            │ 天氣 Open-Meteo（免鑰）  │  │ Edge Functions           │  │
            │ 匯率 open.er-api（免鑰） │  │  ai-assist ─ GEMINI_KEY  │  │
            │ 地圖 Google/Naver（免鑰）│  │  admin-users ─ service_role │
            ▼                         │  └──────────────────────────┘  │
      第三方免金鑰 API                 └────────────────────────────────┘
```

**核心原則**：GitHub Pages 藏不住祕密，所以前端**只**拿得到公開的 Supabase URL + anon key，
資料安全完全靠 **RLS**（`supabase/schema.sql`，11 張表全開）。
需要特權的事（Gemini 金鑰、service_role）一律推到 Edge Function 後面，
而且**兩支 Function 都會先驗呼叫者身分**才做事。

---

## 檔案結構

```
index.html                  單頁應用（登入 ↔ 行程主畫面），所有畫面的 HTML 骨架
config.js                   Supabase URL + anon key + 管理員 Email（公開、可 commit）
css/app.css                 設計系統

js/supabase.js              Supabase client
js/auth.js                  登入/註冊/改密碼；成員帳號用合成 email
js/app.js                   UI 控制器（路由、渲染、事件）— 主戰場
js/constants.js             ISO 4217 幣別清單、成員配色、日期工具
js/trip.js                  行程資料層（建立/成員/幣別/Realtime）
js/itinerary.js             行程項目 CRUD + Realtime
js/expenses.js              多幣別記帳 + 分帳
js/settle.js                結算演算法（最少轉帳）
js/fx.js                    即時匯率 + 三層快取
js/weather.js               Open-Meteo 預報 + 座標快取
js/maps.js                  地圖抽象層（Google 內嵌 / Naver 跳出）
js/packing.js  js/memo.js   行李、備忘
js/ai.js  js/aichat.js      呼叫 ai-assist + 對話式編輯 UI
js/swipe.js                 左滑刪除（只吃觸控、避開反白選字）
js/ui.js                    共用 UI 小工具

supabase/schema.sql         建表 + RLS + RPC + 管理員觸發器（可重複執行）
supabase/seed-demo.sql      示範行程 RPC（seed_demo_trip）
supabase/reset.sql          清資料重來（A 保留帳號 / B 連帳號清光）
supabase/functions/ai-assist/     Gemini（排行程 / 記帳語意 / 對話式編輯）
supabase/functions/admin-users/   service_role（帳號與行程管理後台）

.github/workflows/keepalive.yml   每日 ping，防 Supabase 免費方案 7 天無活動被暫停
tools/make-icons.py         產生各尺寸 favicon
```

---

## 自己跑一份（fork 後的完整步驟）

這個 repo **clone 下來不會直接連到我的資料庫**——`config.js` 指向的 Supabase 專案受 RLS
保護，你沒有帳號就看不到任何資料。要自己玩必須開自己的 Supabase 專案：

1. **開 Supabase 專案**（免費方案即可），記下 `Project URL` 與 `anon public key`。
2. **套 schema**：Dashboard → SQL Editor → 貼上 [`supabase/schema.sql`](./supabase/schema.sql) 全部 → Run。
3. **改 `config.js`**：換成你的 `SUPABASE_URL` / `SUPABASE_ANON_KEY`，
   並把 `ADMIN_EMAIL` 改成**你自己的 Email**。
   ⚠️ `supabase/schema.sql` 裡的 `handle_new_user` 觸發器也硬編了同一個 Email（第 51、66 行），
   兩邊要一起改，否則你註冊完不會是管理員。
4. **註冊管理員**：用步驟 3 設定的 Email 到網站上註冊，觸發器會自動把你標成 admin。
5. **（選用）AI**：申請 Gemini API key，設到 Edge Function 環境變數，然後部署兩支 Function：
   ```bash
   supabase secrets set GEMINI_API_KEY=xxxx
   supabase functions deploy ai-assist
   supabase functions deploy admin-users
   ```
   沒設也能跑，只是 AI 相關按鈕會回錯誤。
6. **本機預覽**：
   ```bash
   python3 -m http.server 5173
   # 開 http://localhost:5173
   ```
7. **部署**：push 到 `main` → repo Settings → Pages → Source: `main` / root。
8. **改前端資產後記得 bump 快取版本**：`index.html` 裡 `app.js` / `app.css` / `config.js`
   都帶 `?v=YYYYMMDDx`，不改版本號使用者會拿到舊快取。

### 示範行程（一鍵灌滿假資料）

SQL Editor 再跑一次 [`supabase/seed-demo.sql`](./supabase/seed-demo.sql)（只需一次），
之後網站上按「🎌 示範行程」即可。入口三個：**⚙️ 管理 → 行程管理**、**❓ 說明**頁底部、
還沒有行程時**總覽**上的提示。

內容：5 天 24 個行程項目、14 筆三幣別支出（結算有得算）、17 件行李、4 則備忘與留言、
4 位成員（含唯讀）。出發日 = 按鈕當天 + 7 天，所以天氣頁一定有預報。
**重按一次＝砍掉重建，可當 demo 重置鈕。**

管理員建的是共用的 `DEMO`；一般成員建的是自己專屬那份（碼是 `DEMO` + uid 前 6 碼，
每人限一份，也砍不到別人的）。

---

## 安全

**repo 裡沒有任何祕密金鑰**，`config.js` 與 keepalive workflow 裡的 anon key
本來就是設計給瀏覽器公開使用的，資料由 RLS 保護。

絕不進 repo（`.gitignore` 已擋 `.env`、`.env.*`、`*.secret`）：

| 金鑰 | 該放哪 |
|------|--------|
| `service_role key` | Supabase 自動注入 Edge Function，不必手動設 |
| `SUPABASE_SECRET_KEY` / DB 密碼 / `sbp_` access token | 只留在本機 `.env` |
| `GEMINI_API_KEY` | `supabase secrets set`，只存在 Edge Function 環境變數 |

RLS 設計重點：
- 11 張表全部 `enable row level security`，讀寫都要求「你是這趟行程的 member」
- `profiles` / `members` 只開放**欄位級** `update (display_name)`，改不到 `is_admin`
- 特權函式放在 `private` schema，`revoke from public` 後只 `grant to authenticated`
- 兩支 Edge Function 都先 `auth.getUser(jwt)` 驗身分，`ai-assist` 另外擋掉拿 anon key
  當免費 LLM proxy 用的情況

---

## 已知限制

- **管理員 Email 硬編**在 `config.js` 和 `schema.sql` 兩處，換人要同時改（見上方步驟 3）
- Naver 地圖**不能內嵌**（`X-Frame-Options` + 申請不到 `ncpKeyId`），一律跳出去開
- 免費方案 Supabase 連續 7 天無 API 活動會被暫停，靠 `keepalive.yml` 每日心跳撐著
- AI 回覆一律是「產生草稿 → 你確認 → 才寫進 DB」，不會直接動資料
- 還沒做：PWA 離線

---

## 授權

Copyright (c) 2026 Hank Wang。本專案採 **GNU AGPL-3.0** 授權，全文見 [`LICENSE`](./LICENSE)。

**你可以**自由使用、修改、散布這份程式，商業或非商業都行。
**你必須**保留著作權與授權聲明，而且改作出來的版本一樣要用 AGPL-3.0 釋出**原始碼**。

**§13 網路條款**是 AGPL 跟 GPL 的關鍵差別，對這種網頁 App 特別對味：
把改過的版本架成網站給別人用，就算你一個檔案都沒散布出去，
也必須讓那些使用者拿得到你那份的原始碼。所以 App 的[說明頁](https://hank716.github.io/travel/)
最下面放了一張「關於 · 授權」卡，直接連回這個 repo —— 你 fork 出去架站時記得把它改成你自己的來源。

**想閉源商用？** 例如要把它整進不打算開源的商業產品裡，AGPL 的義務會擋住你 ——
這種情況可以另外洽談商業授權，請開一個 [GitHub Issue](https://github.com/hank716/travel/issues) 聯繫。
（雙授權成立的前提是著作權集中，所以**送 PR 即表示你同意自己的貢獻以相同條款授權給本專案**。）

**第三方相依**：repo 裡沒有夾帶任何第三方原始碼。`@supabase/supabase-js`
（`js/supabase.js` 從 esm.sh 載入）與 Deno std（兩支 Edge Function）都是執行時才從 CDN 抓，
各自維持自己的 MIT 授權，不受本授權影響。
