# 旅程規劃系統 — 架構與設計決策

> 這份文件記錄**系統實際長什麼樣、以及為什麼這樣做**。
> 想知道怎麼跑起來、demo 怎麼走，看 [`README.md`](./README.md)。

一句話：**GitHub Pages 上的零建置靜態前端 + Supabase 後端**，做出多人共用、
多幣別、即時同步的旅遊規劃與記帳工具。

---

## 1. 整體架構

```
┌──────────────────────────┐          ┌────────────────────────────────┐
│  GitHub Pages（純靜態）   │          │  Supabase                      │
│  index.html + js/ + css/ │  HTTPS   │  ┌──────────────────────────┐  │
│  · Supabase JS（CDN）    │◀────────▶│  │ Postgres + RLS（11 表）   │  │
│  · ES Modules + importmap│          │  │ Realtime（postgres_changes│ │
│  · 無 npm / 無 build     │          │  │ Auth（Email + 密碼）      │  │
└───────────┬──────────────┘          │  └──────────────────────────┘  │
            │                         │  ┌──────────────────────────┐  │
            │ 天氣 Open-Meteo（免鑰）  │  │ Edge Functions（Deno）    │  │
            │ 匯率 open.er-api（免鑰） │  │  ai-assist  ← GEMINI_KEY │  │
            │ 地圖 Google / Naver      │  │  admin-users ← service_role │
            ▼                         │  └──────────────────────────┘  │
      第三方免金鑰 API                 └────────────────────────────────┘
```

### 貫穿全案的一條原則

**GitHub Pages 是純靜態，藏不住任何祕密。**

所以前端只拿得到「本來就設計成公開」的東西——Supabase URL 與 anon key。
資料安全**完全**押在 RLS 上，不是押在「前端不顯示」上。
任何需要特權的動作（Gemini 金鑰、service_role）都推到 Edge Function 後面，
而且 Function 自己會先驗呼叫者身分，不能靠「只有我的前端會呼叫它」這種假設。

---

## 2. 認證與權限模型

> 這裡跟最初的規劃不一樣。原本設計是「共用行程碼 + 自選名字 + 匿名登入」，
> 好處是零註冊；但實際用起來，**任何拿到行程碼的人都能改別人的帳**，
> 而且換裝置就變成另一個人（uid 存在 localStorage）。改成帳號制之後這兩個問題才真的解決。

**三層身分：**

| 層級 | 是什麼 | 怎麼決定 |
|------|--------|----------|
| **系統管理員** | 唯一一人，可開帳號、建行程、指派成員 | `profiles.is_admin`，由 `handle_new_user` 觸發器比對硬編的 Email |
| **行程管理員** | 某趟行程的主揪 | `members.is_admin`（建立者自動是） |
| **成員** | 可編輯 / 唯讀兩級 | `members.can_edit` |

**成員帳號怎麼來**：管理員在後台建，只給「使用者名稱 + 密碼」，
系統合成 `<username>@guest.tripplanner.app` 當 Supabase 的帳號識別（不會真的收信）。
成員不能自行註冊，這樣才控制得住誰能進這個 Supabase 專案。

**登入流程**：`js/auth.js` 的 `toEmail()` 判斷輸入含不含 `@`——含就當真 Email（管理員），
不含就補成員網域。同一個登入框吃兩種身分。

---

## 3. 資料庫

11 張表，全部 `enable row level security`：

```
profiles          帳號檔（is_admin / username / display_name）— 跟著 auth.users 走
trips             行程主檔（code / title / 起訖日 / base_currency / map_provider）
trip_currencies   這趟啟用哪些幣別（trip_id, code）
members           這趟的成員（auth_uid / display_name / color / is_admin / can_edit）
itinerary_items   行程項目（day_date / 時間 / 標題 / 分類 / 地點 / lat,lng / sort_order）
expenses          支出（原幣 amount + currency + rate_to_base 快照 / paid_by）
expense_splits    分帳明細（expense_id, member_id, share_amount）
packing_items     行李清單
memos             備忘
memo_comments     備忘留言
fx_cache          匯率每日快取（date, base → rates jsonb）
```

### RLS 的三個關鍵設計

**(1) 用 `security definer` 函式打斷遞迴。**
「你是不是這趟的 member」這個判斷要查 `members`，但 `members` 自己也有 RLS——
直接寫在 policy 裡會無限遞迴。所以抽成 `private.is_trip_member(trip_id)` 等
`security definer` 函式，policy 只呼叫它。

**(2) 提權要靠欄位級 grant，不是靠 policy。**
Supabase 預設給 `authenticated` 整張表的 UPDATE 權限。只寫 policy「只能改自己那列」
擋不住使用者把自己那列的 `is_admin` 改成 true。正確做法是
`revoke update on profiles from authenticated` 之後，只 `grant update (display_name)`。
`members` 同理。

**(3) `revoke from public`，不是 `from anon`。**
函式的預設執行權限來自 `PUBLIC`；`revoke ... from anon` 是無效的，
必須 revoke from `PUBLIC` 再明確 grant 回 `authenticated`。

### 相容性寫法
`schema.sql` 設計成**可重複執行**：新欄位一律用 `alter table ... add column if not exists`。
唯一的例外是 `check constraint`（`alter add constraint` 沒有 `if not exists`），
所以 `map_provider` 的合法值改由前端下拉選單保證，不加 constraint。

---

## 4. 多幣別與結算

**每筆支出存三件事**：原幣金額、幣別、**記帳當下對基準幣別的匯率 `rate_to_base`**。

存快照而不是每次重算，是因為帳要能對——半年後匯率變了，
去年那頓拉麵折合台幣多少不應該跟著變。

**匯率取得**（`js/fx.js`）三層快取，由近到遠：
記憶體 Map → Supabase `fx_cache`（每日一筆，**跨裝置共用**）→ open.er-api。
`fx_cache` 這層讓同行的四個人一天只打一次外部 API。

**結算**（`js/settle.js`，純函式好測）：
1. `computeBalances` — 全部換算到基準幣，每人 `net = 付出 − 應攤`
2. `settleUp` — 貪婪法：欠最多的付給被欠最多的，逐筆抵銷，得到**最少轉帳筆數**
3. `splitEqually` — 均分時最後一人吸收四捨五入餘數，保證分帳總和 = 原金額
   （零小數幣別如 JPY 走 `zeroDecimal` 分支）

---

## 5. 地圖：為什麼要抽象層

Google Maps 免金鑰的 iframe embed 很好用——吃地名字串就能畫、多點路線一條網址搞定。
但**韓國政府限制圖資輸出**，Google 在韓國沒有步行/大眾運輸路線、店家資料也殘缺，
排韓國行程幾乎沒用。

Naver 有完整韓國圖資，但：
- **不能 iframe**（`X-Frame-Options`）
- 想內嵌只能用官方 JS SDK，而那個 `ncpKeyId` 申請不到

所以兩家的互動模式**本質上不一樣**，不是換個網域就好。
`js/maps.js` 把差異收斂成三個問題讓 `app.js` 去問：

| 問題 | Google | Naver |
|------|--------|-------|
| `hasEmbed()` 能不能畫在頁面裡 | ✅ | ❌（隱藏整張地圖卡） |
| `itemMapUrl()` 單點跳去哪 | maps 搜尋 | Naver 搜尋 |
| 整天路線 | ✅ 一條 URL 串起來 | ❌ 只能逐點跳 |

`map_provider` 存在 `trips` 上，**每趟行程各自選**。

**地名處理**：Naver 搜不到中文地名，所以要轉。但轉成什麼有講究——
Naver 的店家資料本來就登錄了**官方英文名**，而使用者手機的 Naver App 若設成英文，
送韓文進 `nmap://` 會整頁顯示看不懂的字（App 照給的字顯示，不會自己翻譯）。

所以 `naverSearchable()` 的規則是**英文與韓文都放行**，只擋兩種：
中文（Naver 真的查無結果），以及「韓文夾雜獨立英文單字」的混雜寫法
（`뼈다귀에반하다 Jeju` 那條英文尾巴會讓 Naver 搜不到）。
擋下來的才丟給 `ai-assist` 的 `resolve_naver_queries` mode 轉韓文，
結果存進 `itinerary_items.naver_query` 當永久快取，同行夥伴共用、不重複花配額。

> 陷阱：`stripRegionTail()`（砍地名尾巴）**不能套在純英文名上**。
> 官方英文名很多本來就以地名結尾，`Lotte City Hotel Jeju` 砍成
> `Lotte City Hotel` 會跑到首爾或大田的同名飯店。純拉丁字串直接跳過清理。

地點改掉時 `naver_query` 要一併清成 null，否則地圖會指著舊地點。

---

## 6. 天氣

`js/weather.js`：行程項目的地點字串 → 用 AI 推斷行政區（`resolve_districts` mode）
→ 地理編碼 → Open-Meteo 逐日預報。

解析出來的 `weather_area` / `lat` / `lng` **寫回 `itinerary_items` 快取**，
不用每次重新問 AI。

超出 Open-Meteo 預報範圍（約 16 天）的日期，改抓**去年同期**的歷史資料當參考，
畫面上會標明這是參考值不是預報。

> **踩過的坑**：`lat` / `lng` 是跟 `maps.js` 共用的欄位（Naver 路線、`nmap://`
> 深連結、內嵌地圖都讀它），而天氣這邊的地名是 AI 猜的羅馬拼音、又只取地理編碼
> 第一名——猜錯的代價不是天氣不準，是整條路線被帶到別的國家
> （真的發生過：AI 回 `"Jeju"`，寫進去的是衣索比亞的座標）。
>
> 修法不是拆欄位，是**加驗證關卡**：只有在「AI 有給國碼」且「地理編碼結果的國家
> 對得上」兩者都成立時才寫座標；對不上就只留行政區標籤，座標留空讓 `maps.js`
> 自己用真正的地名去查。天氣本次仍照常顯示，代價只是下次重查一次。

---

## 7. AI 助手（Edge Function `ai-assist`）

一支 Function，依 `mode` 分流，Gemini 金鑰只存在於它的環境變數。

| mode | 用途 |
|------|------|
| `suggest_itinerary` | 依城市/日期/偏好產生行程草稿 |
| `edit_itinerary` | 對話式修改現有行程 |
| `edit_expenses` | 記帳語意輸入（「拉麵 1200 円我跟小明分」） |
| `edit_packing` | 對話式增刪行李 |
| `weather_suggest` | 依預報給穿著/行程建議 |
| `resolve_districts` | 地點 → 行政區（餵給天氣） |
| `resolve_naver_queries` | 地點 → Naver 搜得到的字串 |
| `diag` | 模型探測排障，**限管理員** |

**兩個安全設計**：
- 呼叫者必須帶**使用者 JWT**，`auth.getUser()` 會把光拿 anon key 的請求打回 401。
  否則這支 Function 就是一個公開的免費 LLM proxy，Gemini 配額很快會被燒光。
- AI **一律只產生草稿，經使用者確認才寫進 DB**。不給 AI 直接寫入權。

**模型策略**：`gemini-flash-latest` → `gemini-flash-lite-latest` → `gemini-2.5-flash` 逐級 fallback，
每級重試 3 次。最後一個釘死版號當保險——`-latest` 別名曾經飄到 3.x，
導致舊的 `thinkingBudget` 參數直接 400，整個 AI 功能全掛。

---

## 8. 管理後台（Edge Function `admin-users`）

需要 `service_role`（建帳號、重設密碼、列出 auth.users）的動作全在這裡。
Supabase 會自動把 `SUPABASE_SERVICE_ROLE_KEY` 注入 Function 環境，不必手動設。

入口第一件事就是驗 `profiles.is_admin`，不是管理員直接 403。

支援：`list_users` / `create_member` / `set_display_name` / `reset_password` /
`delete_user` / `assign_trip` / `unassign_trip` / `set_trip_admin` / `set_member_can_edit`。

**一個資料一致性細節**：`profiles.display_name` 是唯一來源，
`members.display_name` 只是快取副本。改名時兩邊要一起改，
否則成員清單、付款人、分帳、行李歸屬還會停在舊名字。

---

## 9. 即時同步

`js/supabase.js` 包了一層 `postgres_changes` 訂閱工具，
`itinerary_items` / `expenses` / `members` / `packing_items` / `memos` 都訂。

**channel 名稱要帶遞增序號**（`` `${name}#${++channelSeq}` ``）。
原因：`removeChannel()` 是非同步的，同名 channel 在還沒真的移除時
`supabase.channel(name)` 會把舊的原封不動還回來，這時再 `.on("postgres_changes")`
就會丟 `cannot add postgres_changes callbacks after subscribe()`。

---

## 10. 前端：為什麼不用框架

沒有 npm、沒有打包工具、沒有 build step——`index.html` 直接開就能跑，
push 到 GitHub Pages 就是部署。對這個規模的專案，build pipeline 的成本高過收益。

用 **ES Modules + importmap**，`@/xxx.js` 的別名讓 import 路徑乾淨。

### 快取版本號（踩過的坑）

`index.html` 對 `app.js` / `app.css` / `config.js` 都加 `?v=YYYYMMDDx`。

關鍵是：**ES module 的 `import` 不會繼承 `<script src>` 的 `?v=`**。
漏掉子模組的版本號，就會變成「新的 `app.js` ＋ 舊快取的子模組」→
匯出對不起來、整頁停在載入中。所以 importmap 裡每支模組都各自帶版本，
改前端資產時把整份 `index.html` 的 `?v=` 一起換掉。

### 左滑刪除 vs 反白選字

`js/swipe.js`：左滑刪除**只吃觸控事件、且只認往左的位移**。
整列可點的清單還要先檢查 `hasTextSelectionIn()`——
否則使用者想反白選一段文字，手勢會被當成滑動吃掉。

---

## 11. 維運

**Supabase 免費方案連續 7 天沒有 API 活動就會被暫停。**
`.github/workflows/keepalive.yml` 每天 03:00 UTC 打一次 `fx_cache` 的 REST 查詢
當心跳——重點是要打**真的會進 Postgres** 的查詢，RLS 讓 anon 拿到空陣列沒關係，
請求有進到資料庫就算活動。

還有一層套娃：**GitHub 的 repo 連續 60 天沒活動會自動停用排程 workflow**，
那會諷刺地讓上面的心跳自己失效。所以每月 1 號多推一個空 commit 重置計時器。

`supabase/reset.sql` 提供兩個重來選項：A 只清行程資料保留帳號、B 連帳號清光。

---

## 12. 現況與後續

**已完成**

- 帳號制認證（單一管理員 + 成員帳號 + 唯讀權限）
- 管理後台（帳號 / 行程）
- 行程規劃 CRUD + Realtime + 雙地圖供應商
- 多幣別記帳 + 分帳 + 即時匯率 + 結算
- 天氣、行李、備忘 + 留言
- AI 助手（排行程 / 記帳語意 / 對話式編輯 / 天氣建議）
- 多頁面 + RWD（桌機側欄 / 手機抽屜）
- 新手上手：說明頁、空狀態依權限分流、一鍵示範行程

**待辦**

| 項目 | 說明 |
|------|------|
| PWA 離線 | Service worker + manifest，行程表離線可看 |
| 管理員 Email 解硬編 | 目前 `config.js` 與 `schema.sql` 各硬編一份，換人要改兩處 |
| 行程項目照片 | Supabase Storage |
| 匯出 | 行程表 PDF / 帳目 CSV |
