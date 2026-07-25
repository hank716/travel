-- =============================================================================
-- 日本旅遊規劃系統 — 資料庫 Schema（Postgres / Supabase）
-- 在 Supabase Dashboard → SQL Editor 貼上整份執行即可（可重複執行）。
--
-- 安全模型：Email/密碼帳號制（管理員建立成員帳號並指派行程），auth.uid() 綁定成員，
-- 由 RLS 確保「只有該行程的成員」能讀寫該行程的資料。
-- 建立行程走 SECURITY DEFINER 的 RPC，避免把所有 trips 暴露出去。
-- 所有 policy 一律 `to authenticated`：未登入的 anon 不該碰到 public schema 的任何東西
-- （登入/註冊走 GoTrue 的 /auth/v1/*，不經 anon 的 SQL 權限）。
-- =============================================================================

-- 需要產生隨機行程碼
create extension if not exists pgcrypto;

-- -----------------------------------------------------------------------------
-- private schema：放「前端不會、也不該直接呼叫」的函式。
-- PostgREST 只曝出 exposed schema（public / graphql_public），所以放這裡的東西
-- 不會變成 /rest/v1/rpc/*，也就不會被 linter 標成「anon/authenticated 可執行
-- 的 SECURITY DEFINER 函式」。public 只留前端真的會呼叫的三個 RPC。
-- -----------------------------------------------------------------------------
create schema if not exists private;

-- -----------------------------------------------------------------------------
-- 帳號 profiles（單一管理員制）：第一個註冊者自動成為管理員
-- -----------------------------------------------------------------------------
create table if not exists public.profiles (
  id         uuid primary key references auth.users(id) on delete cascade,
  username   text unique,
  is_admin   boolean not null default false,
  created_at timestamptz not null default now()
);

-- 顯示名稱＝帳號層級的「人看的名字」（username 是登入用的帳號，不該拿來當稱呼）。
-- members.display_name 從此只是這裡的快取副本：建立成員列時帶入，改名時串接更新。
alter table public.profiles add column if not exists display_name text;
update public.profiles set display_name = username where display_name is null;

-- 唯一管理員（寫死）。若要更換，改這裡 + config.js 的 ADMIN_EMAIL。
-- 新使用者註冊 → 建立 profile；只有寫死的 Email 會是管理員，其餘一律 false。
create or replace function private.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, username, is_admin, display_name)
  values (
    new.id,
    new.raw_user_meta_data ->> 'username',
    lower(new.email) = 'hank.wang.716@gmail.com',
    coalesce(new.raw_user_meta_data ->> 'display_name', new.raw_user_meta_data ->> 'username')
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function private.handle_new_user();

-- 一次性校正：依 auth.users.email 重設既有 profiles 的 is_admin（確保只有寫死 Email 是 admin）
update public.profiles p
  set is_admin = (lower(u.email) = 'hank.wang.716@gmail.com')
  from auth.users u where u.id = p.id;

-- 目前登入者是否為（全域）管理員
create or replace function private.is_admin()
returns boolean
language sql security definer stable
set search_path = public
as $$
  select coalesce((select p.is_admin from public.profiles p where p.id = auth.uid()), false);
$$;

-- -----------------------------------------------------------------------------
-- 資料表
-- -----------------------------------------------------------------------------

create table if not exists public.trips (
  id            uuid primary key default gen_random_uuid(),
  code          text unique not null,                 -- 行程碼（如 JP4F2K）
  title         text not null,
  start_date    date,
  end_date      date,
  base_currency text not null default 'TWD',          -- 結算基準幣別（可改，跨旅行復用）
  created_at    timestamptz not null default now()
);

create table if not exists public.trip_currencies (
  trip_id uuid not null references public.trips(id) on delete cascade,
  code    text not null,                              -- JPY / TWD / USD ...
  primary key (trip_id, code)
);

create table if not exists public.members (
  id           uuid primary key default gen_random_uuid(),
  trip_id      uuid not null references public.trips(id) on delete cascade,
  auth_uid     uuid,                                  -- 來自匿名登入；null = 管理員預建、尚未登入
  display_name text not null,
  color        text not null default '#E66F4B',
  is_admin     boolean not null default false,        -- 建立者為管理員，可管理名單
  can_edit     boolean not null default true,          -- 可編輯 / 唯讀（唯讀者只能看不能改）
  created_at   timestamptz not null default now(),
  unique (trip_id, auth_uid)
);

-- 既有資料庫的相容性調整（可重複執行）
alter table public.members alter column auth_uid drop not null;
alter table public.members alter column auth_uid drop default;
alter table public.members add column if not exists is_admin boolean not null default false;
-- 權限分級：可編輯 / 唯讀（既有成員預設可編輯，不影響現狀）
alter table public.members add column if not exists can_edit boolean not null default true;
-- 天氣用：快取每個項目解析到的行政區（避免重複呼叫 AI）
alter table public.itinerary_items add column if not exists weather_area text;

create table if not exists public.itinerary_items (
  id            uuid primary key default gen_random_uuid(),
  trip_id       uuid not null references public.trips(id) on delete cascade,
  day_date      date,
  start_time    time,
  end_time      time,
  title         text not null,
  category      text,                                 -- 景點/餐廳/交通/住宿
  location_name text,
  map_query     text,                                 -- 給 Google Maps 用
  lat           numeric,
  lng           numeric,
  notes         text,
  sort_order    int not null default 0,
  created_by    uuid references public.members(id) on delete set null,
  created_at    timestamptz not null default now()
);

create table if not exists public.expenses (
  id           uuid primary key default gen_random_uuid(),
  trip_id      uuid not null references public.trips(id) on delete cascade,
  paid_by      uuid references public.members(id) on delete set null,
  amount       numeric not null check (amount >= 0),  -- 原幣金額
  currency     text not null,                         -- 原幣別
  rate_to_base numeric not null default 1,            -- 記帳當下對 base_currency 的匯率快照
  category     text,
  description  text,
  spent_at     timestamptz not null default now(),
  created_at   timestamptz not null default now()
);

create table if not exists public.expense_splits (
  id           uuid primary key default gen_random_uuid(),
  expense_id   uuid not null references public.expenses(id) on delete cascade,
  member_id    uuid not null references public.members(id) on delete cascade,
  share_amount numeric not null check (share_amount >= 0)   -- 原幣，攤多少
);

-- 行李清單：弱連結行程(trip_id)與成員(member_id)。member_id 為 null = 共用/全體；
-- 刪某成員時其行李改為共用（on delete set null），資料不消失。不引用行程/天氣表。
create table if not exists public.packing_items (
  id         uuid primary key default gen_random_uuid(),
  trip_id    uuid not null references public.trips(id) on delete cascade,
  member_id  uuid references public.members(id) on delete set null,  -- null = 共用/全體
  name       text not null,
  category   text,                                  -- 衣物/證件/電子/盥洗/藥品/其他
  qty        int not null default 1,
  checked    boolean not null default false,        -- 已打包
  note       text,                                  -- AI 建議原因等
  sort_order int not null default 0,
  created_by uuid references public.members(id) on delete set null,
  created_at timestamptz not null default now()
);

-- 備忘錄：每趟行程的共筆筆記。筆記本身只有可編輯成員能動，
-- 但底下的留言是給全體同行者討論用的（唯讀成員也能發言）。
create table if not exists public.memos (
  id         uuid primary key default gen_random_uuid(),
  trip_id    uuid not null references public.trips(id) on delete cascade,
  title      text,
  body       text not null default '',
  pinned     boolean not null default false,          -- 置頂（重要事項壓在最上面）
  created_by uuid references public.members(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- 留言。trip_id 刻意跟著存一份（非正規化）：RLS 與 realtime filter 都能直接用 trip_id，
-- 不必像 expense_splits 那樣每條 policy 都回頭 join 母表。
create table if not exists public.memo_comments (
  id         uuid primary key default gen_random_uuid(),
  memo_id    uuid not null references public.memos(id) on delete cascade,
  trip_id    uuid not null references public.trips(id) on delete cascade,
  member_id  uuid references public.members(id) on delete set null,
  body       text not null,
  created_at timestamptz not null default now()
);

-- 匯率每日快取（公開資料，所有登入者可讀寫，少打外部 API）
create table if not exists public.fx_cache (
  date  date not null,
  base  text not null,
  rates jsonb not null,
  primary key (date, base)
);

create index if not exists idx_members_trip       on public.members(trip_id);
create index if not exists idx_itinerary_trip      on public.itinerary_items(trip_id);
create index if not exists idx_expenses_trip       on public.expenses(trip_id);
create index if not exists idx_splits_expense      on public.expense_splits(expense_id);
create index if not exists idx_packing_trip        on public.packing_items(trip_id);
create index if not exists idx_memos_trip          on public.memos(trip_id);
create index if not exists idx_memo_comments_memo  on public.memo_comments(memo_id);

-- -----------------------------------------------------------------------------
-- 輔助函式
-- -----------------------------------------------------------------------------

-- 判斷目前登入者是否為某行程的成員（SECURITY DEFINER 避開 members 自身 RLS 遞迴）
create or replace function private.is_trip_member(p_trip_id uuid)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1 from public.members m
    where m.trip_id = p_trip_id and m.auth_uid = auth.uid()
  );
$$;

-- 目前登入者是否為某行程「可編輯」的成員（成員 且 (can_edit 或 is_admin)）。
-- 唯讀成員 → false；行程管理員一律可編輯。寫入類 RLS 用這個把關。
create or replace function private.is_trip_editor(p_trip_id uuid)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1 from public.members m
    where m.trip_id = p_trip_id and m.auth_uid = auth.uid()
      and (m.can_edit or m.is_admin)
  );
$$;

-- 產生一組未被使用的行程碼（6 碼，去掉易混淆字元）
create or replace function private.gen_trip_code()
returns text
language plpgsql
set search_path = public
as $$
declare
  alphabet text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  v_code text;          -- 不可叫 code：會與 trips.code 欄位衝突 → ambiguous
  i int;
begin
  loop
    v_code := '';
    for i in 1..6 loop
      v_code := v_code || substr(alphabet, 1 + floor(random() * length(alphabet))::int, 1);
    end loop;
    exit when not exists (select 1 from public.trips t where t.code = v_code);
  end loop;
  return v_code;
end;
$$;

-- 建立新行程。p_join = true（預設）→ 把建立者加為第一個成員(管理員)；
-- p_join = false → 建立者不參加（不進名單、不分帳），之後由後台指派家人並指定行程管理員。
-- 可帶自訂行程碼 p_code（留空自動產生）。
-- 注意：新增參數 → 是新的函式簽章，需先 drop 舊版避免重載衝突。
drop function if exists public.create_trip(text, date, date, text, text[], text, text);
drop function if exists public.create_trip(text, date, date, text, text[], text, text, text);

create or replace function public.create_trip(
  p_title      text,
  p_start      date,
  p_end        date,
  p_base       text,
  p_currencies text[],
  p_name       text,
  p_color      text default '#E66F4B',
  p_code       text default null,
  p_join       boolean default true
)
returns public.trips
language plpgsql
security definer
set search_path = public
as $$
declare
  v_trip public.trips;
  v_code text;
  c text;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;
  if not private.is_admin() then
    raise exception 'admin only';
  end if;

  -- 自訂行程碼：正規化 + 驗證 + 查重；留空則自動產生
  if p_code is not null and length(trim(p_code)) > 0 then
    v_code := upper(regexp_replace(trim(p_code), '\s', '', 'g'));
    if v_code !~ '^[A-Z0-9]{3,12}$' then
      raise exception 'invalid code';
    end if;
    if exists (select 1 from public.trips t where t.code = v_code) then
      raise exception 'code taken';
    end if;
  else
    v_code := private.gen_trip_code();
  end if;

  insert into public.trips (code, title, start_date, end_date, base_currency)
  values (v_code, coalesce(p_title, '未命名行程'), p_start, p_end, coalesce(p_base, 'TWD'))
  returning * into v_trip;

  foreach c in array coalesce(p_currencies, array['TWD'])
  loop
    insert into public.trip_currencies (trip_id, code) values (v_trip.id, c)
    on conflict do nothing;
  end loop;

  -- p_join = true：建立者即行程管理員（可編輯）；false：建立者不參加（不進名單）。
  if p_join then
    insert into public.members (trip_id, auth_uid, display_name, color, is_admin, can_edit)
    values (v_trip.id, auth.uid(), coalesce(nullif(trim(p_name), ''), '我'), coalesce(p_color, '#E66F4B'), true, true);
  end if;

  return v_trip;
end;
$$;

-- 目前登入者是否為某行程的管理員
create or replace function private.is_trip_admin(p_trip_id uuid)
returns boolean
language sql security definer stable
set search_path = public
as $$
  select exists (
    select 1 from public.members m
    where m.trip_id = p_trip_id and m.auth_uid = auth.uid() and m.is_admin
  );
$$;

-- 指定某成員為行程管理員（單一管理員：同行程其他人取消 is_admin）。
-- 授權：全域 admin 或該行程現任管理員。供 admin 不參加時把一位家人升為管理員。
create or replace function public.set_trip_admin(p_trip_id uuid, p_member_id uuid)
returns public.members
language plpgsql
security definer
set search_path = public
as $$
declare
  v_member public.members;
begin
  if not (private.is_admin() or private.is_trip_admin(p_trip_id)) then
    raise exception 'admin only';
  end if;
  if not exists (select 1 from public.members m where m.id = p_member_id and m.trip_id = p_trip_id) then
    raise exception 'member not in trip';
  end if;
  update public.members set is_admin = false where trip_id = p_trip_id;
  update public.members set is_admin = true, can_edit = true
   where id = p_member_id returning * into v_member;
  return v_member;
end;
$$;

-- 設定某成員為可編輯 / 唯讀。授權：全域 admin 或該成員所屬行程的管理員。
create or replace function public.set_member_can_edit(p_member_id uuid, p_can_edit boolean)
returns public.members
language plpgsql
security definer
set search_path = public
as $$
declare
  v_member public.members;
  v_trip   uuid;
begin
  select trip_id into v_trip from public.members where id = p_member_id;
  if v_trip is null then
    raise exception 'member not found';
  end if;
  if not (private.is_admin() or private.is_trip_admin(v_trip)) then
    raise exception 'admin only';
  end if;
  update public.members set can_edit = coalesce(p_can_edit, true)
   where id = p_member_id returning * into v_member;
  return v_member;
end;
$$;

-- -----------------------------------------------------------------------------
-- 舊「行程碼加入」模式的殘留，改成帳號制後前端已無任何呼叫端，一併移除以縮小 API 面積。
-- 其中 get_roster 完全沒有授權檢查：猜到 6 碼行程碼就能拿到整份成員名單，一定要拔掉。
-- -----------------------------------------------------------------------------
drop function if exists public.get_roster(text);
drop function if exists public.add_member(uuid, text, text);
drop function if exists public.join_trip(text, text, text);

-- -----------------------------------------------------------------------------
-- 函式權限：PostgREST 會把 public schema 的函式全部曝成 /rest/v1/rpc/*。
--
-- ⚠️ 關鍵：Postgres 建立函式時預設把 EXECUTE 授予 **PUBLIC**（ACL 顯示為 `=X/postgres`），
-- anon / authenticated 是「透過 PUBLIC 繼承」而不是各自持有。所以
-- `revoke ... from anon` 是無效的——必須 revoke from PUBLIC，再明確 grant 回去。
-- 作法：全部收掉 → 只把真的需要的授予 authenticated。
-- -----------------------------------------------------------------------------

revoke execute on all functions in schema public  from public, anon, authenticated;
revoke execute on all functions in schema private from public, anon, authenticated;
revoke all     on schema private                  from public, anon;
-- 之後新增的函式也不要自動給出去
alter default privileges in schema public  revoke execute on functions from public;
alter default privileges in schema private revoke execute on functions from public;

-- 前端真的會呼叫的 RPC（三個內部都有 admin 檢查）。public 只留這三個。
grant execute on function public.create_trip(text, date, date, text, text[], text, text, text, boolean) to authenticated;
grant execute on function public.set_trip_admin(uuid, uuid)          to authenticated;
grant execute on function public.set_member_can_edit(uuid, boolean)  to authenticated;

-- RLS policy 是以「查詢者身分」求值，所以 authenticated 必須摸得到這四個 helper。
-- 但 private 不在 PostgREST 的 exposed schema 內，不會變成 /rest/v1/rpc/*。
grant usage on schema private to authenticated;
grant execute on function private.is_admin()             to authenticated;
grant execute on function private.is_trip_member(uuid)   to authenticated;
grant execute on function private.is_trip_editor(uuid)   to authenticated;
grant execute on function private.is_trip_admin(uuid)    to authenticated;

-- 刻意不授予任何人：
--   gen_trip_code()   只被 create_trip（SECURITY DEFINER，以 owner 身分跑）內部呼叫
--   handle_new_user() 是 auth.users 的 trigger 函式，trigger 觸發不看呼叫者的 EXECUTE

-- -----------------------------------------------------------------------------
-- Row Level Security
-- -----------------------------------------------------------------------------

alter table public.profiles        enable row level security;
alter table public.trips           enable row level security;
alter table public.trip_currencies enable row level security;
alter table public.members         enable row level security;
alter table public.itinerary_items enable row level security;
alter table public.expenses        enable row level security;
alter table public.expense_splits  enable row level security;
alter table public.packing_items   enable row level security;
alter table public.memos           enable row level security;
alter table public.memo_comments   enable row level security;
alter table public.fx_cache        enable row level security;

-- profiles：本人可讀自己；管理員可讀全部（列成員帳號用）。
drop policy if exists profiles_self on public.profiles;
create policy profiles_self on public.profiles for select
  to authenticated
  using (id = auth.uid() or private.is_admin());

-- 本人可改自己的 profile（帳號設定改顯示名稱用）。
-- ⚠️ RLS 是「整列」層級的，擋不住欄位——光有這條政策，使用者就能自己把 is_admin 設成 true。
-- Supabase 預設給 authenticated 整張表的 UPDATE，所以必須收掉再用欄位層級 grant 只放行 display_name。
-- 管理員改別人的名字走 admin-users Edge Function（service_role），不靠這條。
drop policy if exists profiles_update_self on public.profiles;
create policy profiles_update_self on public.profiles for update
  to authenticated
  using (id = auth.uid())
  with check (id = auth.uid());

revoke update on public.profiles from authenticated;
grant  update (display_name) on public.profiles to authenticated;

-- trips：成員可讀；全域 admin 唯讀可視（即使不參加也看得到）；可編輯成員可改設定；
-- 建立走 RPC，不開放直接 INSERT。
drop policy if exists trips_select on public.trips;
create policy trips_select on public.trips for select
  to authenticated
  using (private.is_trip_member(id) or private.is_admin());
drop policy if exists trips_update on public.trips;
create policy trips_update on public.trips for update
  to authenticated
  using (private.is_trip_editor(id)) with check (private.is_trip_editor(id));
drop policy if exists trips_delete on public.trips;
create policy trips_delete on public.trips for delete
  to authenticated
  using (private.is_admin());           -- 僅管理員可刪除整趟（cascade 連帶清掉項目/記帳）

-- trip_currencies：成員/admin 可讀；可編輯成員可增減幣別。
drop policy if exists tc_select on public.trip_currencies;
create policy tc_select on public.trip_currencies for select
  to authenticated
  using (private.is_trip_member(trip_id) or private.is_admin());
drop policy if exists tc_all on public.trip_currencies;
create policy tc_all on public.trip_currencies for all
  to authenticated
  using (private.is_trip_editor(trip_id)) with check (private.is_trip_editor(trip_id));

-- members：同行程成員/admin 可讀；只能改/刪自己的列；成員由管理員經 admin-users 建立。
drop policy if exists members_select on public.members;
create policy members_select on public.members for select
  to authenticated
  using (private.is_trip_member(trip_id) or private.is_admin());
drop policy if exists members_update_own on public.members;
create policy members_update_own on public.members for update
  to authenticated
  using (auth_uid = auth.uid()) with check (auth_uid = auth.uid());
drop policy if exists members_delete_own on public.members;
create policy members_delete_own on public.members for delete
  to authenticated
  using (auth_uid = auth.uid());
-- 管理員可管理（改名/移除）同行程任何成員
drop policy if exists members_admin_update on public.members;
create policy members_admin_update on public.members for update
  to authenticated
  using (private.is_trip_admin(trip_id)) with check (private.is_trip_admin(trip_id));
drop policy if exists members_admin_delete on public.members;
create policy members_admin_delete on public.members for delete
  to authenticated
  using (private.is_trip_admin(trip_id));

-- itinerary / expenses：成員/admin 可讀；可編輯成員可寫。
drop policy if exists itinerary_select on public.itinerary_items;
create policy itinerary_select on public.itinerary_items for select
  to authenticated
  using (private.is_trip_member(trip_id) or private.is_admin());
drop policy if exists itinerary_all on public.itinerary_items;
create policy itinerary_all on public.itinerary_items for all
  to authenticated
  using (private.is_trip_editor(trip_id)) with check (private.is_trip_editor(trip_id));

drop policy if exists expenses_select on public.expenses;
create policy expenses_select on public.expenses for select
  to authenticated
  using (private.is_trip_member(trip_id) or private.is_admin());
drop policy if exists expenses_all on public.expenses;
create policy expenses_all on public.expenses for all
  to authenticated
  using (private.is_trip_editor(trip_id)) with check (private.is_trip_editor(trip_id));

-- expense_splits：依母 expense 的行程判斷（讀：成員/admin；寫：可編輯成員）。
drop policy if exists splits_select on public.expense_splits;
create policy splits_select on public.expense_splits for select
  to authenticated
  using (exists (select 1 from public.expenses e
                 where e.id = expense_id and (private.is_trip_member(e.trip_id) or private.is_admin())));
drop policy if exists splits_all on public.expense_splits;
create policy splits_all on public.expense_splits for all
  to authenticated
  using (exists (select 1 from public.expenses e
                 where e.id = expense_id and private.is_trip_editor(e.trip_id)))
  with check (exists (select 1 from public.expenses e
                 where e.id = expense_id and private.is_trip_editor(e.trip_id)));

-- packing_items：成員/admin 可讀；可編輯成員可寫。
drop policy if exists packing_select on public.packing_items;
create policy packing_select on public.packing_items for select
  to authenticated
  using (private.is_trip_member(trip_id) or private.is_admin());
drop policy if exists packing_all on public.packing_items;
create policy packing_all on public.packing_items for all
  to authenticated
  using (private.is_trip_editor(trip_id)) with check (private.is_trip_editor(trip_id));

-- memos：成員/admin 可讀；可編輯成員可寫（比照行程與記帳）。
drop policy if exists memos_select on public.memos;
create policy memos_select on public.memos for select
  to authenticated
  using (private.is_trip_member(trip_id) or private.is_admin());
drop policy if exists memos_all on public.memos;
create policy memos_all on public.memos for all
  to authenticated
  using (private.is_trip_editor(trip_id)) with check (private.is_trip_editor(trip_id));

-- memo_comments：留言是討論用的，所以**唯讀成員也能發**（用 is_trip_member 而非 is_trip_editor），
-- 但只能以自己的成員身分留言；刪改限作者本人或行程管理員。
drop policy if exists memo_comments_select on public.memo_comments;
create policy memo_comments_select on public.memo_comments for select
  to authenticated
  using (private.is_trip_member(trip_id) or private.is_admin());
drop policy if exists memo_comments_insert on public.memo_comments;
create policy memo_comments_insert on public.memo_comments for insert
  to authenticated
  with check (
    private.is_trip_member(trip_id)
    and exists (select 1 from public.members m
                where m.id = member_id and m.trip_id = memo_comments.trip_id
                  and m.auth_uid = auth.uid())
  );
drop policy if exists memo_comments_update on public.memo_comments;
create policy memo_comments_update on public.memo_comments for update
  to authenticated
  using (private.is_trip_admin(trip_id)
         or exists (select 1 from public.members m
                    where m.id = member_id and m.auth_uid = auth.uid()))
  with check (private.is_trip_admin(trip_id)
         or exists (select 1 from public.members m
                    where m.id = member_id and m.auth_uid = auth.uid()));
drop policy if exists memo_comments_delete on public.memo_comments;
create policy memo_comments_delete on public.memo_comments for delete
  to authenticated
  using (private.is_trip_admin(trip_id)
         or exists (select 1 from public.members m
                    where m.id = member_id and m.auth_uid = auth.uid()));

-- fx_cache：所有登入者可讀寫（純快取，非機密）。
-- `to authenticated` 已經表達了原本 auth.role() = 'authenticated' 的意思，不必重複判斷。
drop policy if exists fx_select on public.fx_cache;
create policy fx_select on public.fx_cache for select
  to authenticated
  using (true);
-- INSERT 不寫 `with check (true)`：那等於對登入者完全不設防（linter 也會標）。
-- 這張表是公開匯率的快取，寫入端只有 js/fx.js，就照它實際會寫的形狀限制住，
-- 至少擋掉塞歷史/未來日期或亂七八糟 payload 的行為。
drop policy if exists fx_insert on public.fx_cache;
create policy fx_insert on public.fx_cache for insert
  to authenticated
  with check (
    date between current_date - 1 and current_date + 1   -- js/fx.js 用 UTC 日期，容錯 ±1 天
    and base ~ '^[A-Z]{3}$'
    and jsonb_typeof(rates) = 'object'
  );

-- -----------------------------------------------------------------------------
-- Realtime（即時多人同步）
-- -----------------------------------------------------------------------------
do $$
begin
  alter publication supabase_realtime add table public.members;
  alter publication supabase_realtime add table public.itinerary_items;
  alter publication supabase_realtime add table public.expenses;
  alter publication supabase_realtime add table public.expense_splits;
  alter publication supabase_realtime add table public.trip_currencies;
exception when duplicate_object then null;
end $$;

-- packing_items 獨立一個區塊：避免上面任一 add 先丟 duplicate_object 後，整個區塊提早結束
-- 導致 packing_items 在既有 DB 重跑時被略過。
do $$
begin
  alter publication supabase_realtime add table public.packing_items;
exception when duplicate_object then null;
end $$;

-- 備忘錄同理，各自一個區塊，既有 DB 重跑時才不會被前面的 duplicate_object 擋掉。
do $$
begin
  alter publication supabase_realtime add table public.memos;
exception when duplicate_object then null;
end $$;

do $$
begin
  alter publication supabase_realtime add table public.memo_comments;
exception when duplicate_object then null;
end $$;

-- -----------------------------------------------------------------------------
-- 收尾：移除 public 裡的舊 helper（現在都住在 private）。
-- 必須放在最尾端——上面的 trigger 與 21 條 policy 已全數改指向 private.*，
-- 這時候才沒有依賴。刻意不加 cascade：真有殘留依賴要直接報錯，
-- 而不是靜默把 policy 一起砍掉。
-- -----------------------------------------------------------------------------
drop function if exists public.is_admin();
drop function if exists public.is_trip_member(uuid);
drop function if exists public.is_trip_editor(uuid);
drop function if exists public.is_trip_admin(uuid);
drop function if exists public.gen_trip_code();
drop function if exists public.handle_new_user();
