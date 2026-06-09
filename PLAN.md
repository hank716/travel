# 日本旅遊規劃系統 — 架構與實作計畫

> 把現有靜態行程頁（高雄×台南）升級成「GitHub Pages + Supabase」的多人、多幣別、即時旅遊規劃系統。
>
> 已確認決策：
> 1. **登入**：共用行程碼 + 自選名字（背後用 Supabase 匿名登入維持權限）
> 2. **AI**：行程建議與優化 + 記帳語意輸入
> 3. **AI 模型**：Gemini（金鑰只放在 Supabase Edge Function，前端看不到）
> 4. **流程**：先完整規劃 → 你確認 → 再動工

---

## 1. 整體架構

```
┌─────────────────────────────┐         ┌──────────────────────────────┐
│  GitHub Pages (純靜態)       │         │  Supabase                    │
│  index.html + js/ + css/    │  HTTPS  │  ┌────────────────────────┐  │
│  - Supabase JS (CDN)        │◀───────▶│  │ Postgres + RLS         │  │
│  - Alpine.js (CDN, 輕量響應)│         │  │ Realtime (即時同步)    │  │
│  - 既有 CSS 設計系統        │         │  │ 匿名 Auth (隱形)       │  │
└──────────┬──────────────────┘         │  └────────────────────────┘  │
           │                            │  ┌────────────────────────┐  │
           │  天氣 Open-Meteo (免金鑰)  │  │ Edge Function: ai-assist│ │
           │  匯率 open.er-api (免金鑰) │  │  └─ 持有 GEMINI_API_KEY │  │
           │  地圖 Google Maps iframe   │  └────────────────────────┘  │
           ▼                            └──────────────────────────────┘
   第三方免金鑰 API
```

**關鍵原則**：GitHub Pages 是純靜態，不能藏祕密。所以：
- Supabase URL + anon key 是「公開可放」的（靠 RLS 保護資料），可直接寫進 `config.js`。
- **Gemini 金鑰絕對不進前端**，只放在 Supabase Edge Function 的環境變數，由前端呼叫 Function、Function 再去打 Gemini。
- Google Maps 用 iframe embed（沿用現有做法，免金鑰）；若日後要自動補經緯度/地點自動完成，再加一支「網域限制」的 Maps JS 金鑰（這種金鑰可放前端）。

---

## 2. 登入模型（共用行程碼 + 自選名字）

UX 上使用者只會看到：「輸入行程碼 → 選/輸入自己的名字」。
技術上背後用 **Supabase 匿名登入（signInAnonymously）**：
- 每個瀏覽器第一次進來自動拿到一個穩定的 `auth.uid`（存在 localStorage）。
- 行程碼是「加入密語」；輸入正確才能成為該行程的 member。
- 有了 uid，RLS 才能真正擋住「不是這個行程的人」讀寫資料——這比純前端比對行程碼安全得多。

> 取捨：純自選名字無法防同行程內互改；這個方案在「零密碼、零註冊」的體驗下，仍能用 RLS 把不同行程隔離開。

---

## 3. 資料庫 Schema（Postgres）

```
trips            行程主檔
  id              uuid  PK
  code            text  unique        -- 行程碼（如 JP2026）
  title           text                -- 「2026 春 東京大阪」
  start_date      date
  end_date        date
  base_currency   text  default 'TWD' -- 結算用基準幣別
  created_at      timestamptz

trip_currencies  這趟啟用的幣別（N 種）
  trip_id         uuid  FK
  code            text                -- JPY / TWD / USD ...
  PRIMARY KEY (trip_id, code)

members          這趟的成員（N 人）
  id              uuid  PK
  trip_id         uuid  FK
  auth_uid        uuid                -- 來自匿名登入
  display_name    text
  color           text                -- 頭像底色
  UNIQUE (trip_id, auth_uid)

itinerary_items  行程項目（手動輸入）
  id              uuid  PK
  trip_id         uuid  FK
  day_date        date
  start_time      time
  end_time        time
  title           text
  category        text                -- 景點/餐廳/交通/住宿
  location_name   text
  map_query       text                -- 給 Google Maps 用
  lat / lng       numeric             -- 之後自動補
  notes           text
  sort_order      int
  created_by      uuid  FK members

expenses         記帳（多幣別）
  id              uuid  PK
  trip_id         uuid  FK
  paid_by         uuid  FK members    -- 誰付的
  amount          numeric             -- 原幣金額
  currency        text                -- 原幣別
  rate_to_base    numeric             -- 記帳當下對 base_currency 的匯率快照
  category        text
  description     text
  spent_at        timestamptz
  created_at      timestamptz

expense_splits   分帳（這筆誰要分攤）
  id              uuid  PK
  expense_id      uuid  FK
  member_id       uuid  FK
  share_amount    numeric             -- 原幣，攤多少

fx_cache         匯率快取（每日一筆，少打 API）
  date            date
  base            text
  rates           jsonb               -- { "JPY":..., "USD":... }
  PRIMARY KEY (date, base)
```

**多幣別 + 結算邏輯**
- 每筆 expense 存「原幣金額 + 當下對基準幣別的匯率快照」→ 之後匯率變動也不會改寫歷史帳。
- 每人餘額 = Σ(他付的，換算基準幣) − Σ(他該分攤的，換算基準幣)。
- 結算頁產生「誰該付誰多少」的最少轉帳建議。

**RLS（每張表都開）**：只有「自己是該 trip 的 member」才能讀寫該 trip 的列。
join 條件用 `members.auth_uid = auth.uid()`。

---

## 4. 外部 API

| 功能 | 來源 | 金鑰 | 備註 |
|------|------|------|------|
| 天氣 | Open-Meteo | 免 | 沿用現有 `fetchForecast`，城市改由行程地點驅動（東京/大阪/京都…） |
| 匯率 | open.er-api.com | 免 | 含 JPY/TWD/USD，每日快取進 `fx_cache` |
| 地圖 | Google Maps iframe embed | 免 | 沿用現有 `setMap()`；行程項目可一鍵帶入地圖 |
| AI | Gemini | **僅 Edge Function** | 前端→Edge Function→Gemini，金鑰不外洩 |

---

## 5. AI 設計（Supabase Edge Function `ai-assist`）

一支 Function，依 `mode` 分流，金鑰在 Function 環境變數 `GEMINI_API_KEY`：

- **mode: "suggest_itinerary"**
  輸入：城市、日期、已排項目、偏好（美食/文化/購物…）
  輸出：建議景點/餐廳 + 依地點排順的路線（回傳結構化 JSON，前端直接塞進行程）。
- **mode: "parse_expense"**
  輸入：自然語句「拉麵 1200 円 我跟小明分」+ 成員清單 + 幣別清單
  輸出：`{ amount, currency, category, paid_by, splits:[...] }` → 前端預填記帳表單讓你確認後送出。

> 都設計成「AI 產生草稿 → 你確認 → 才寫進 DB」，避免亂寫。

---

## 6. 即時多人同步

用 Supabase Realtime 訂閱 `expenses` / `itinerary_items` / `members`：
任何人新增/修改，所有在線裝置即時更新——達成「N 人同時記帳/排行程」。

---

## 7. 前端結構（零建置，直接上 GitHub Pages）

維持 vanilla 風格、不引入打包工具：
```
/index.html          進入點（行程碼 + 名字）
/config.js           Supabase URL + anon key（公開）
/css/app.css         沿用現有設計系統
/js/
  supabase.js        初始化 client + 匿名登入
  trip.js            建立/加入行程、成員
  itinerary.js       行程 CRUD + 地圖帶入
  expenses.js        多幣別記帳 + 分帳
  settle.js          結算（誰付誰）
  fx.js              匯率抓取 + 快取
  weather.js         沿用 Open-Meteo
  ai.js              呼叫 ai-assist
/supabase/
  schema.sql         建表 + RLS
  functions/ai-assist/index.ts
```
用 **Alpine.js（CDN）** 做表單與清單的響應式綁定，不需 build step。

**頁面分頁**：行程 ｜ 記帳 ｜ 結算 ｜ 天氣 ｜ 地圖 ｜ AI 助手

---

## 8. 分階段實作

| 階段 | 內容 | 產出 |
|------|------|------|
| **0 基礎** | 建 repo 結構、`schema.sql`+RLS、骨架部署上 GH Pages | 可開啟的空殼 |
| **1 加入行程** | 匿名登入、建立/加入行程碼、選名字、成員清單 | 多人可進同一趟 |
| **2 行程** | 行程項目 CRUD + Realtime + 地圖帶入 | 手動排行程 |
| **3 記帳** | 多幣別記帳 + 分帳 + 即時匯率 + 結算頁 | 核心記帳完成 |
| **4 天氣** | 移植 Open-Meteo，城市改由行程驅動 | 即時天氣 |
| **5 AI** | Edge Function（Gemini）：行程建議 + 記帳語意輸入 | AI 助手 |
| **6 收尾** | PWA 離線、日本內容種子、手機優化 | 上線 |

---

## 9. 動工前需要你提供 / 操作的東西

1. **GitHub repo**：要新建一個 public repo 開 GitHub Pages（我可以幫你把檔案準備好，建 repo / 開 Pages 需要你在 GitHub 操作或授權）。
2. **Supabase 專案**：到 supabase.com 開一個免費專案，給我 `Project URL` 和 `anon public key`（這兩個可公開）。`service_role` 金鑰請勿外流。
3. **Gemini API key**：到 Google AI Studio 申請，**之後直接設定到 Supabase Edge Function 的環境變數**，不要貼進前端或 repo。
4. 確認 **基準結算幣別**（預設 TWD）與這趟要啟用的幣別清單（預設 JPY + TWD）。

> 我會先從階段 0/1 開始，每階段做完讓你驗收再往下。

https://github.com/hank716/travel

https://supabase.com/dashboard/project/bmwzoqdypgrwmcxasxnr

anon public key: 寫在 `config.js`（公開可放，靠 RLS 保護）。

service role: ⚠️ 已移除 — 這是後門金鑰，絕不可進 repo。需要時只在本機 Supabase CLI 用。

gemini key: ⚠️ 已移除 — 只設定到 Supabase Edge Function 環境變數（`supabase secrets set GEMINI_API_KEY=...`）。建議重新產一把（舊的曾以明文寫下）。

預設 TWD，啟用幣別 JPY+TWD；每趟行程可各自設定 base_currency 與 trip_currencies，達成跨旅行復用。