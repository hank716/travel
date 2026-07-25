-- =============================================================================
-- 示範行程（Demo）：一鍵建立一趟「資料完整」的假行程，讓每一頁都有東西可看。
--
-- 用法：
--   1. 這份 SQL 在 Supabase SQL Editor 跑一次（安裝函式，可重複執行）。
--   2. 之後在網站「⚙️ 管理 → 行程管理 → 🎌 示範行程」按鈕呼叫；
--      或直接在 SQL Editor 執行 select public.seed_demo_trip();（需以管理員身分）。
--
-- 涵蓋範圍（對照側欄每一頁）：
--   總覽 —— 4 位成員（含唯讀）、3 種幣別、統計數字、接下來的行程
--   行程 —— 5 天 24 個項目，六種分類都有，附座標可直接帶入地圖
--   記帳 —— 14 筆支出 / 3 種幣別 / 均分 + 部分人分攤 + 非均分 → 結算有得算
--   天氣 —— 每天第一個項目都有座標與行政區（東京 / 箱根 / 鎌倉），免呼叫 AI
--   行李 —— 六種分類、共用品與個人品、部分已打包 → 進度條非 0 非滿
--   備忘 —— 4 則筆記（含置頂）與多人留言
--
-- 出發日固定是「執行當下 + 7 天」，所以天氣頁永遠落在 Open-Meteo 預報範圍內。
-- 重複執行 = 砍掉重建（同一組行程碼），可以拿來當「重置示範資料」。
-- =============================================================================

create or replace function public.seed_demo_trip(p_code text default 'DEMO')
returns public.trips
language plpgsql
security definer
set search_path = public
as $$
declare
  v_code text := upper(coalesce(nullif(regexp_replace(trim(p_code), '\s', '', 'g'), ''), 'DEMO'));
  v_trip public.trips;
  v_d0   date := current_date + 7;      -- 出發日：永遠是一週後（天氣才抓得到預報）
  -- 成員
  v_me   uuid;   -- 呼叫者本人（行程管理員）
  v_mei  uuid;   -- 阿美（可編輯）
  v_zhe  uuid;   -- 阿哲（可編輯）
  v_yuan uuid;   -- 小圓（唯讀）
  v_name text;
  -- 匯率快照：有 fx_cache 就用真的，否則用合理的回退值
  v_jpy  numeric;
  v_usd  numeric;
  v_r    numeric;
  -- 備忘錄
  v_m1 uuid; v_m2 uuid; v_m3 uuid; v_m4 uuid;
  -- 支出
  v_e uuid;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;
  if not private.is_admin() then
    raise exception 'admin only';
  end if;

  -- 砍掉重建：同一組行程碼永遠只有一趟示範資料（cascade 連帶清乾淨）
  delete from public.trips t where t.code = v_code;

  insert into public.trips (code, title, start_date, end_date, base_currency)
  values (v_code, '🎌 示範行程 · 東京箱根鎌倉 5 日', v_d0, v_d0 + 4, 'TWD')
  returning * into v_trip;

  insert into public.trip_currencies (trip_id, code)
  values (v_trip.id, 'TWD'), (v_trip.id, 'JPY'), (v_trip.id, 'USD');

  -- 匯率：fx_cache 存的是「1 base 等於多少 X」，記帳要的是反過來
  select (f.rates->>'JPY')::numeric into v_r
    from public.fx_cache f where f.base = 'TWD' order by f.date desc limit 1;
  v_jpy := case when coalesce(v_r, 0) > 0 then round(1 / v_r, 6) else 0.213 end;
  select (f.rates->>'USD')::numeric into v_r
    from public.fx_cache f where f.base = 'TWD' order by f.date desc limit 1;
  v_usd := case when coalesce(v_r, 0) > 0 then round(1 / v_r, 6) else 31.5 end;

  -- ---------------------------------------------------------------------------
  -- 成員：本人是行程管理員；其餘三位是「管理員預建、尚未綁帳號」的成員，
  -- 想讓真人進來就到管理頁把帳號指派進這趟。小圓刻意設唯讀，展示權限分級。
  -- ---------------------------------------------------------------------------
  select coalesce(nullif(trim(p.display_name), ''), nullif(trim(p.username), ''), '我')
    into v_name from public.profiles p where p.id = auth.uid();

  insert into public.members (trip_id, auth_uid, display_name, color, is_admin, can_edit)
  values (v_trip.id, auth.uid(), coalesce(v_name, '我'), '#E66F4B', true, true)
  returning id into v_me;

  insert into public.members (trip_id, display_name, color, can_edit)
  values (v_trip.id, '阿美', '#5E7C58', true) returning id into v_mei;
  insert into public.members (trip_id, display_name, color, can_edit)
  values (v_trip.id, '阿哲', '#D59A39', true) returning id into v_zhe;
  insert into public.members (trip_id, display_name, color, can_edit)
  values (v_trip.id, '小圓', '#4B79E6', false) returning id into v_yuan;

  -- ---------------------------------------------------------------------------
  -- 行程項目：每天第一筆都帶座標與行政區，天氣頁不必呼叫 AI 就能直接跑。
  -- 交通類的地點一律填「目的地」，天氣才會落在當天真正待的城市。
  -- ---------------------------------------------------------------------------
  insert into public.itinerary_items
    (trip_id, day_date, start_time, end_time, title, category,
     location_name, map_query, lat, lng, weather_area, notes, sort_order, created_by)
  values
  -- Day 1 抵達東京
  (v_trip.id, v_d0, '09:40', '14:20', '桃園 TPE → 成田 NRT（BR2198）', '交通',
   '成田國際機場', '成田国際空港', 35.7720, 140.3929, '千葉縣 成田市',
   '線上 check-in 起飛前 48 小時開放；托運行李 23kg × 1', 0, v_me),
  (v_trip.id, v_d0, '15:00', '16:10', 'N''EX 成田特快 → 新宿', '交通',
   '新宿站', '新宿駅', 35.6896, 139.7006, '東京都 新宿區',
   'JR Pass 可劃位，出關後在 B1 JR 售票處換票', 1, v_me),
  (v_trip.id, v_d0, '16:30', '17:00', '新宿華盛頓飯店 Check-in', '住宿',
   '新宿華盛頓飯店', '新宿ワシントンホテル', 35.6893, 139.6935, '東京都 新宿區',
   '訂房編號 DEMO-88213，雙人房 × 2，可提早寄放行李', 2, v_me),
  (v_trip.id, v_d0, '18:30', '20:30', '思い出橫丁 串燒晚餐', '餐廳',
   '思い出橫丁', '思い出横丁 新宿', 35.6938, 139.6996, '東京都 新宿區',
   '小店多半只收現金，六點後要排隊', 3, v_mei),

  -- Day 2 淺草・晴空塔
  (v_trip.id, v_d0 + 1, '09:30', '11:00', '淺草寺・雷門', '景點',
   '淺草寺', '浅草寺', 35.7148, 139.7967, '東京都 台東區',
   '早上人少好拍；抽籤 100 円，凶籤綁在架上就好', 0, v_me),
  (v_trip.id, v_d0 + 1, '11:00', '12:30', '仲見世通り 伴手禮', '購物',
   '仲見世通り', '仲見世通り 浅草', 35.7112, 139.7967, '東京都 台東區',
   '人形燒、雷おこし；免稅門檻 5,000 円，集中一家結帳', 1, v_mei),
  (v_trip.id, v_d0 + 1, '12:30', '14:00', '淺草今半 壽喜燒', '餐廳',
   '淺草今半 國際通本店', '浅草今半 国際通り本店', 35.7146, 139.7913, '東京都 台東區',
   '已訂位 12:30 / 4 位，午間套餐比晚餐便宜一半', 2, v_me),
  (v_trip.id, v_d0 + 1, '15:00', '17:00', '東京晴空塔 天望甲板', '景點',
   '東京晴空塔', '東京スカイツリー', 35.7101, 139.8107, '東京都 墨田區',
   '已買電子票（QR 在手機相簿），走預約通道免排隊', 3, v_zhe),
  (v_trip.id, v_d0 + 1, '18:00', '19:30', '隅田川日落遊船', '其他',
   '吾妻橋乘船場', '吾妻橋 乗船場', 35.7106, 139.7967, '東京都 墨田區',
   '日落班次最漂亮，1,000 円/人，現場買票', 4, v_zhe),

  -- Day 3 箱根溫泉
  (v_trip.id, v_d0 + 2, '08:20', '09:55', '小田急浪漫特快 → 箱根湯本', '交通',
   '箱根湯本站', '箱根湯本駅', 35.2324, 139.1069, '神奈川縣 箱根町',
   '指定席已劃位（車廂 3 / 座位 5A-6B）；大件行李先寄旅館', 0, v_me),
  (v_trip.id, v_d0 + 2, '11:00', '12:30', '大涌谷 黑玉子', '景點',
   '大涌谷', '大涌谷', 35.2440, 139.0200, '神奈川縣 箱根町',
   '硫磺味重，呼吸道敏感要注意；黑蛋一袋 5 顆 500 円', 1, v_zhe),
  (v_trip.id, v_d0 + 2, '12:45', '14:00', '蘆之湖畔 湖景午餐', '餐廳',
   '蘆之湖', '芦ノ湖', 35.2065, 139.0225, '神奈川縣 箱根町',
   '海賊船碼頭旁邊那家，窗邊位要早點到', 2, v_mei),
  (v_trip.id, v_d0 + 2, '15:00', '16:00', '箱根神社 平和鳥居', '景點',
   '箱根神社', '箱根神社', 35.2048, 139.0257, '神奈川縣 箱根町',
   '湖中鳥居拍照要排隊，約 20 分鐘', 3, v_yuan),
  (v_trip.id, v_d0 + 2, '16:30', null, '箱根溫泉旅館 Check-in（一泊二食）', '住宿',
   '箱根湯本溫泉', '箱根湯本温泉', 35.2324, 139.1069, '神奈川縣 箱根町',
   '晚餐 18:30 會席料理；有刺青請用包租風呂（需前一天預約）', 4, v_me),

  -- Day 4 鎌倉
  (v_trip.id, v_d0 + 3, '09:00', '11:00', '箱根 → 鎌倉（小田急 + 江之電）', '交通',
   '鎌倉站', '鎌倉駅', 35.3192, 139.5504, '神奈川縣 鎌倉市',
   '藤澤站換江之電，江之島 1 日券比單程划算', 0, v_me),
  (v_trip.id, v_d0 + 3, '11:15', '12:15', '鎌倉大佛（高德院）', '景點',
   '高德院', '高徳院', 35.3167, 139.5355, '神奈川縣 鎌倉市',
   '拜觀 300 円；進大佛內部再加 50 円', 1, v_zhe),
  (v_trip.id, v_d0 + 3, '12:30', '14:00', '小町通り 生しらす丼', '餐廳',
   '小町通り', '小町通り 鎌倉', 35.3196, 139.5518, '神奈川縣 鎌倉市',
   '生魩仔魚看當天有沒有出海，沒有就改釜揚げ', 2, v_mei),
  (v_trip.id, v_d0 + 3, '14:30', '15:30', '鎌倉高校前 平交道', '景點',
   '鎌倉高校前站', '鎌倉高校前駅', 35.3067, 139.5019, '神奈川縣 鎌倉市',
   '灌籃高手場景；站在人行道上拍，別擋電車與住戶', 3, v_yuan),
  (v_trip.id, v_d0 + 3, '18:00', null, '回新宿飯店（同一家）', '住宿',
   '新宿華盛頓飯店', '新宿ワシントンホテル', 35.6893, 139.6935, '東京都 新宿區',
   '訂房編號 DEMO-88214；行李已從箱根宅配過去', 4, v_me),

  -- Day 5 購物・回程
  (v_trip.id, v_d0 + 4, '09:30', '11:30', '伊勢丹 + 唐吉訶德 掃貨', '購物',
   '伊勢丹新宿店', '伊勢丹新宿店', 35.6917, 139.7047, '東京都 新宿區',
   '免稅櫃台在 7F，記得帶護照本人；退稅單別拆', 0, v_mei),
  (v_trip.id, v_d0 + 4, '12:00', '13:00', '一蘭拉麵 新宿中央東口店', '餐廳',
   '一蘭 新宿中央東口店', '一蘭 新宿中央東口店', 35.6915, 139.7005, '東京都 新宿區',
   '點餐單上「麵硬度」選普通就好', 1, v_me),
  (v_trip.id, v_d0 + 4, '13:30', '14:00', '飯店取行李 → 新宿站', '其他',
   '新宿站', '新宿駅', 35.6896, 139.7006, '東京都 新宿區',
   '行李寄放到 14:00 為止，晚了要加錢', 2, v_me),
  (v_trip.id, v_d0 + 4, '14:30', '15:40', 'N''EX → 成田第二航廈', '交通',
   '成田國際機場 第二航廈', '成田国際空港 第2ターミナル', 35.7735, 140.3860, '千葉縣 成田市',
   '起飛前 2.5 小時到；退稅要在出境查驗前辦完', 3, v_me),
  (v_trip.id, v_d0 + 4, '18:05', '20:55', '成田 NRT → 桃園 TPE（BR2197）', '交通',
   '成田國際機場', '成田国際空港', 35.7720, 140.3929, '千葉縣 成田市',
   '手提行李液體 100ml 限制，藥妝先托運', 4, v_me);

  -- ---------------------------------------------------------------------------
  -- 記帳：三種幣別 + 六種分類；含「全員均分」「只有兩人分」「金額不均分」三種分帳，
  -- 結算頁才會出現有意義的餘額與轉帳建議。
  -- ---------------------------------------------------------------------------
  -- 1 機票（行前刷卡，TWD）
  insert into public.expenses (trip_id, paid_by, amount, currency, rate_to_base, category, description, spent_at)
  values (v_trip.id, v_mei, 62000, 'TWD', 1, '交通', '長榮來回機票 × 4', (v_d0 - 30)::timestamptz)
  returning id into v_e;
  insert into public.expense_splits (expense_id, member_id, share_amount) values
    (v_e, v_me, 15500), (v_e, v_mei, 15500), (v_e, v_zhe, 15500), (v_e, v_yuan, 15500);

  -- 2 eSIM（USD，展示第三種幣別）
  insert into public.expenses (trip_id, paid_by, amount, currency, rate_to_base, category, description, spent_at)
  values (v_trip.id, v_zhe, 39.60, 'USD', v_usd, '其他', 'eSIM 上網卡 × 4', (v_d0 - 3)::timestamptz)
  returning id into v_e;
  insert into public.expense_splits (expense_id, member_id, share_amount) values
    (v_e, v_me, 9.90), (v_e, v_mei, 9.90), (v_e, v_zhe, 9.90), (v_e, v_yuan, 9.90);

  -- 3 N'EX 車票
  insert into public.expenses (trip_id, paid_by, amount, currency, rate_to_base, category, description, spent_at)
  values (v_trip.id, v_zhe, 12440, 'JPY', v_jpy, '交通', 'N''EX 成田特快 × 4', (v_d0 + interval '15 hour'))
  returning id into v_e;
  insert into public.expense_splits (expense_id, member_id, share_amount) values
    (v_e, v_me, 3110), (v_e, v_mei, 3110), (v_e, v_zhe, 3110), (v_e, v_yuan, 3110);

  -- 4 新宿飯店 2 晚
  insert into public.expenses (trip_id, paid_by, amount, currency, rate_to_base, category, description, spent_at)
  values (v_trip.id, v_me, 96000, 'JPY', v_jpy, '住宿', '新宿飯店 2 晚（雙人房 × 2）', (v_d0 + interval '17 hour'))
  returning id into v_e;
  insert into public.expense_splits (expense_id, member_id, share_amount) values
    (v_e, v_me, 24000), (v_e, v_mei, 24000), (v_e, v_zhe, 24000), (v_e, v_yuan, 24000);

  -- 5 串燒晚餐
  insert into public.expenses (trip_id, paid_by, amount, currency, rate_to_base, category, description, spent_at)
  values (v_trip.id, v_me, 13600, 'JPY', v_jpy, '餐飲', '思い出橫丁 串燒', (v_d0 + interval '20 hour'))
  returning id into v_e;
  insert into public.expense_splits (expense_id, member_id, share_amount) values
    (v_e, v_me, 3400), (v_e, v_mei, 3400), (v_e, v_zhe, 3400), (v_e, v_yuan, 3400);

  -- 6 伴手禮（只有兩個人分）
  insert into public.expenses (trip_id, paid_by, amount, currency, rate_to_base, category, description, spent_at)
  values (v_trip.id, v_me, 8200, 'JPY', v_jpy, '購物', '仲見世 伴手禮（我和阿美分）', (v_d0 + interval '1 day 12 hour'))
  returning id into v_e;
  insert into public.expense_splits (expense_id, member_id, share_amount) values
    (v_e, v_me, 4100), (v_e, v_mei, 4100);

  -- 7 壽喜燒
  insert into public.expenses (trip_id, paid_by, amount, currency, rate_to_base, category, description, spent_at)
  values (v_trip.id, v_yuan, 18800, 'JPY', v_jpy, '餐飲', '淺草今半 壽喜燒午餐', (v_d0 + interval '1 day 13 hour'))
  returning id into v_e;
  insert into public.expense_splits (expense_id, member_id, share_amount) values
    (v_e, v_me, 4700), (v_e, v_mei, 4700), (v_e, v_zhe, 4700), (v_e, v_yuan, 4700);

  -- 8 晴空塔門票
  insert into public.expenses (trip_id, paid_by, amount, currency, rate_to_base, category, description, spent_at)
  values (v_trip.id, v_mei, 9600, 'JPY', v_jpy, '門票', '晴空塔天望甲板 × 4', (v_d0 + interval '1 day 15 hour'))
  returning id into v_e;
  insert into public.expense_splits (expense_id, member_id, share_amount) values
    (v_e, v_me, 2400), (v_e, v_mei, 2400), (v_e, v_zhe, 2400), (v_e, v_yuan, 2400);

  -- 9 隅田川遊船
  insert into public.expenses (trip_id, paid_by, amount, currency, rate_to_base, category, description, spent_at)
  values (v_trip.id, v_zhe, 4000, 'JPY', v_jpy, '其他', '隅田川遊船 × 4', (v_d0 + interval '1 day 18 hour'))
  returning id into v_e;
  insert into public.expense_splits (expense_id, member_id, share_amount) values
    (v_e, v_me, 1000), (v_e, v_mei, 1000), (v_e, v_zhe, 1000), (v_e, v_yuan, 1000);

  -- 10 浪漫特快
  insert into public.expenses (trip_id, paid_by, amount, currency, rate_to_base, category, description, spent_at)
  values (v_trip.id, v_mei, 9560, 'JPY', v_jpy, '交通', '浪漫特快指定席 × 4', (v_d0 + interval '2 day 8 hour'))
  returning id into v_e;
  insert into public.expense_splits (expense_id, member_id, share_amount) values
    (v_e, v_me, 2390), (v_e, v_mei, 2390), (v_e, v_zhe, 2390), (v_e, v_yuan, 2390);

  -- 11 箱根旅館
  insert into public.expenses (trip_id, paid_by, amount, currency, rate_to_base, category, description, spent_at)
  values (v_trip.id, v_me, 92000, 'JPY', v_jpy, '住宿', '箱根溫泉旅館 一泊二食 × 4', (v_d0 + interval '2 day 17 hour'))
  returning id into v_e;
  insert into public.expense_splits (expense_id, member_id, share_amount) values
    (v_e, v_me, 23000), (v_e, v_mei, 23000), (v_e, v_zhe, 23000), (v_e, v_yuan, 23000);

  -- 12 鎌倉午餐
  insert into public.expenses (trip_id, paid_by, amount, currency, rate_to_base, category, description, spent_at)
  values (v_trip.id, v_yuan, 6400, 'JPY', v_jpy, '餐飲', '小町通り 生しらす丼', (v_d0 + interval '3 day 13 hour'))
  returning id into v_e;
  insert into public.expense_splits (expense_id, member_id, share_amount) values
    (v_e, v_me, 1600), (v_e, v_mei, 1600), (v_e, v_zhe, 1600), (v_e, v_yuan, 1600);

  -- 13 藥妝掃貨（各買各的，金額不均分）
  insert into public.expenses (trip_id, paid_by, amount, currency, rate_to_base, category, description, spent_at)
  values (v_trip.id, v_mei, 34500, 'JPY', v_jpy, '購物', '藥妝 + 伊勢丹（一起結帳，各買各的）', (v_d0 + interval '4 day 11 hour'))
  returning id into v_e;
  insert into public.expense_splits (expense_id, member_id, share_amount) values
    (v_e, v_me, 6000), (v_e, v_mei, 20000), (v_e, v_zhe, 5000), (v_e, v_yuan, 3500);

  -- 14 一蘭（只有兩個人吃）
  insert into public.expenses (trip_id, paid_by, amount, currency, rate_to_base, category, description, spent_at)
  values (v_trip.id, v_me, 4380, 'JPY', v_jpy, '餐飲', '一蘭拉麵（我和阿哲）', (v_d0 + interval '4 day 12 hour'))
  returning id into v_e;
  insert into public.expense_splits (expense_id, member_id, share_amount) values
    (v_e, v_me, 2190), (v_e, v_zhe, 2190);

  -- ---------------------------------------------------------------------------
  -- 行李：六種分類都有；member_id 為 null = 共用品；部分已打勾 → 進度條不是 0% 也不是 100%
  -- ---------------------------------------------------------------------------
  insert into public.packing_items (trip_id, member_id, name, category, qty, checked, note, sort_order, created_by)
  values
    (v_trip.id, null,   '護照影本 + 大頭照',   '證件', 4, true,  '護照掉了補辦要用',        0, v_me),
    (v_trip.id, null,   '常備藥包',           '藥品', 1, true,  '腸胃藥、退燒藥、OK 繃',   1, v_me),
    (v_trip.id, null,   '摺疊傘',             '其他', 2, false, '八月午後雷陣雨機率高',    2, v_mei),
    (v_trip.id, null,   '萬用轉接頭',         '電子', 2, true,  '日本是 A 型 100V，可共用', 3, v_zhe),
    (v_trip.id, null,   '行動電源',           '電子', 2, false, '只能手提，不可托運',      4, v_zhe),
    (v_trip.id, v_me,   '護照',               '證件', 1, true,  null,                     5, v_me),
    (v_trip.id, v_me,   '相機 + 備用電池',     '電子', 1, false, null,                     6, v_me),
    (v_trip.id, v_me,   '薄外套',             '衣物', 1, false, '冷氣車廂和早晚溫差',      7, v_me),
    (v_trip.id, v_mei,  '護照',               '證件', 1, true,  null,                     8, v_mei),
    (v_trip.id, v_mei,  '卸妝 + 保養品',       '盥洗', 1, false, '分裝到 100ml 以下',       9, v_mei),
    (v_trip.id, v_mei,  '洋裝',               '衣物', 2, false, null,                    10, v_mei),
    (v_trip.id, v_zhe,  '護照',               '證件', 1, false, null,                    11, v_zhe),
    (v_trip.id, v_zhe,  '泳褲',               '衣物', 1, false, '箱根旅館有露天風呂',      12, v_zhe),
    (v_trip.id, v_zhe,  '隱形眼鏡藥水',        '盥洗', 1, false, null,                    13, v_zhe),
    (v_trip.id, v_yuan, '護照',               '證件', 1, true,  null,                    14, v_me),
    (v_trip.id, v_yuan, '暈車藥',             '藥品', 1, false, '箱根登山路段很彎',        15, v_me),
    (v_trip.id, v_yuan, '泡湯用毛巾',          '其他', 1, false, null,                    16, v_me);

  -- ---------------------------------------------------------------------------
  -- 備忘錄：一則置頂 + 多人留言（唯讀成員也能留言，這裡刻意讓小圓發言）
  -- ---------------------------------------------------------------------------
  insert into public.memos (trip_id, title, body, pinned, created_by) values
    (v_trip.id, '✈️ 航班與訂房編號',
     E'去程 BR2198　TPE 09:40 → NRT 14:20\n回程 BR2197　NRT 18:05 → TPE 20:55\n\n新宿華盛頓飯店　訂房編號 DEMO-88213 / DEMO-88214\n箱根溫泉旅館　訂房編號 HKN-2077，電話 +81-460-85-xxxx\n\n※ 訂房確認信都轉寄到大家信箱了',
     true, v_me)
    returning id into v_m1;
  insert into public.memos (trip_id, title, body, pinned, created_by) values
    (v_trip.id, '🎁 伴手禮清單',
     E'· 東京香蕉（機場也有，最後一天買比較不會壓壞）\n· 資生堂洗面乳 × 3（同事託買）\n· 抹茶 KitKat 大包裝\n· 白色戀人是北海道限定，東京買不到，別找了',
     false, v_mei)
    returning id into v_m2;
  insert into public.memos (trip_id, title, body, pinned, created_by) values
    (v_trip.id, '💡 待確認事項',
     E'□ 箱根旅館晚餐時段要在出發前三天回覆（18:30 或 19:00）\n□ 鎌倉那天要不要加江之島？江之電一日券才划算\n□ 最後一天行李寄放：飯店只到 14:00，晚了要加錢',
     false, v_me)
    returning id into v_m3;
  insert into public.memos (trip_id, title, body, pinned, created_by) values
    (v_trip.id, '🚇 交通備忘',
     E'· Suica 先在手機錢包開好，每人先儲 3,000 円\n· JR Pass 不含小田急，去箱根要另外買票\n· 新宿末班車約 00:30，晚上別喝過頭',
     false, v_zhe)
    returning id into v_m4;

  insert into public.memo_comments (memo_id, trip_id, member_id, body) values
    (v_m1, v_trip.id, v_mei,  '回程記得提前 3 小時到機場，八月旅客超多'),
    (v_m1, v_trip.id, v_yuan, '我的訂房確認信沒收到，可以再轉一次嗎？'),
    (v_m2, v_trip.id, v_zhe,  '幫我帶一組抹茶 KitKat，錢我先轉給你'),
    (v_m2, v_trip.id, v_yuan, '藥妝店要滿 5,000 円才免稅，我們一起結帳比較划算'),
    (v_m3, v_trip.id, v_mei,  '晚餐我投 18:30，早點吃完可以去泡湯'),
    (v_m4, v_trip.id, v_me,   '浪漫特快除了車票還要買特急券，別只刷 Suica 進站');

  return v_trip;
end;
$$;

-- schema.sql 尾端把 public 底下所有函式的 execute 收掉了，這支要明確 grant 回去。
grant execute on function public.seed_demo_trip(text) to authenticated;
