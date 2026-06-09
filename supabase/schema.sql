-- =============================================================================
-- 日本旅遊規劃系統 — 資料庫 Schema（Postgres / Supabase）
-- 在 Supabase Dashboard → SQL Editor 貼上整份執行即可（可重複執行）。
--
-- 安全模型：共用「行程碼」加入；背後用 Supabase 匿名登入(auth.uid)綁定成員，
-- 由 RLS 確保「只有該行程的成員」能讀寫該行程的資料。
-- 加入/建立行程一律走 SECURITY DEFINER 的 RPC，避免把所有 trips 暴露出去。
-- =============================================================================

-- 需要產生隨機行程碼
create extension if not exists pgcrypto;

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
  auth_uid     uuid not null default auth.uid(),      -- 來自匿名登入
  display_name text not null,
  color        text not null default '#E66F4B',
  created_at   timestamptz not null default now(),
  unique (trip_id, auth_uid)
);

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

-- -----------------------------------------------------------------------------
-- 輔助函式
-- -----------------------------------------------------------------------------

-- 判斷目前登入者是否為某行程的成員（SECURITY DEFINER 避開 members 自身 RLS 遞迴）
create or replace function public.is_trip_member(p_trip_id uuid)
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

-- 產生一組未被使用的行程碼（6 碼，去掉易混淆字元）
create or replace function public.gen_trip_code()
returns text
language plpgsql
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

-- 建立新行程 + 把建立者加為第一個成員。可帶自訂行程碼 p_code（留空自動產生）。
-- 注意：新增了 p_code 參數 → 是新的函式簽章，需先 drop 舊版避免重載衝突。
drop function if exists public.create_trip(text, date, date, text, text[], text, text);

create or replace function public.create_trip(
  p_title      text,
  p_start      date,
  p_end        date,
  p_base       text,
  p_currencies text[],
  p_name       text,
  p_color      text default '#E66F4B',
  p_code       text default null
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
    v_code := public.gen_trip_code();
  end if;

  insert into public.trips (code, title, start_date, end_date, base_currency)
  values (v_code, coalesce(p_title, '未命名行程'), p_start, p_end, coalesce(p_base, 'TWD'))
  returning * into v_trip;

  foreach c in array coalesce(p_currencies, array['TWD'])
  loop
    insert into public.trip_currencies (trip_id, code) values (v_trip.id, c)
    on conflict do nothing;
  end loop;

  insert into public.members (trip_id, auth_uid, display_name, color)
  values (v_trip.id, auth.uid(), coalesce(nullif(trim(p_name), ''), '我'), coalesce(p_color, '#E66F4B'));

  return v_trip;
end;
$$;

-- 以行程碼加入。名字即身份：若該行程已有同名成員，就把此名字「認領」到目前裝置
-- （不再新增重複的人）；否則沿用目前裝置在本行程的身份改名，或新增成員。回傳該 trip。
create or replace function public.join_trip(
  p_code  text,
  p_name  text,
  p_color text default '#5E7C58'
)
returns public.trips
language plpgsql
security definer
set search_path = public
as $$
declare
  v_trip     public.trips;
  v_existing public.members;
  v_name     text;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;

  v_name := nullif(trim(p_name), '');
  if v_name is null then
    raise exception 'name required';
  end if;

  select * into v_trip from public.trips where code = upper(trim(p_code));
  if not found then
    raise exception 'trip code not found';
  end if;

  select * into v_existing from public.members
   where trip_id = v_trip.id and lower(display_name) = lower(v_name)
   limit 1;

  if found then
    -- 認領既有同名成員：先移除目前裝置在本行程的其他身份，避免重複
    delete from public.members
     where trip_id = v_trip.id and auth_uid = auth.uid() and id <> v_existing.id;
    update public.members
       set auth_uid = auth.uid(), color = coalesce(p_color, color)
     where id = v_existing.id;
  elsif exists (select 1 from public.members where trip_id = v_trip.id and auth_uid = auth.uid()) then
    -- 目前裝置已在本行程：改名
    update public.members
       set display_name = v_name, color = coalesce(p_color, color)
     where trip_id = v_trip.id and auth_uid = auth.uid();
  else
    insert into public.members (trip_id, auth_uid, display_name, color)
    values (v_trip.id, auth.uid(), v_name, coalesce(p_color, '#5E7C58'));
  end if;

  return v_trip;
end;
$$;

-- -----------------------------------------------------------------------------
-- Row Level Security
-- -----------------------------------------------------------------------------

alter table public.trips           enable row level security;
alter table public.trip_currencies enable row level security;
alter table public.members         enable row level security;
alter table public.itinerary_items enable row level security;
alter table public.expenses        enable row level security;
alter table public.expense_splits  enable row level security;
alter table public.fx_cache        enable row level security;

-- trips：成員可讀、可改設定（base/title 等）；建立走 RPC，不開放直接 INSERT。
drop policy if exists trips_select on public.trips;
create policy trips_select on public.trips for select
  using (public.is_trip_member(id));
drop policy if exists trips_update on public.trips;
create policy trips_update on public.trips for update
  using (public.is_trip_member(id)) with check (public.is_trip_member(id));
drop policy if exists trips_delete on public.trips;
create policy trips_delete on public.trips for delete
  using (public.is_trip_member(id));   -- 成員可刪除整趟（cascade 連帶清掉項目/記帳）

-- trip_currencies：成員可讀寫（讓使用者自由增減幣別）。
drop policy if exists tc_all on public.trip_currencies;
create policy tc_all on public.trip_currencies for all
  using (public.is_trip_member(trip_id)) with check (public.is_trip_member(trip_id));

-- members：同行程成員可讀；只能改/刪自己的列；加入走 RPC。
drop policy if exists members_select on public.members;
create policy members_select on public.members for select
  using (public.is_trip_member(trip_id));
drop policy if exists members_update_own on public.members;
create policy members_update_own on public.members for update
  using (auth_uid = auth.uid()) with check (auth_uid = auth.uid());
drop policy if exists members_delete_own on public.members;
create policy members_delete_own on public.members for delete
  using (auth_uid = auth.uid());

-- itinerary / expenses：成員對該行程完整讀寫。
drop policy if exists itinerary_all on public.itinerary_items;
create policy itinerary_all on public.itinerary_items for all
  using (public.is_trip_member(trip_id)) with check (public.is_trip_member(trip_id));

drop policy if exists expenses_all on public.expenses;
create policy expenses_all on public.expenses for all
  using (public.is_trip_member(trip_id)) with check (public.is_trip_member(trip_id));

-- expense_splits：依母 expense 的行程判斷。
drop policy if exists splits_all on public.expense_splits;
create policy splits_all on public.expense_splits for all
  using (exists (select 1 from public.expenses e
                 where e.id = expense_id and public.is_trip_member(e.trip_id)))
  with check (exists (select 1 from public.expenses e
                 where e.id = expense_id and public.is_trip_member(e.trip_id)));

-- fx_cache：所有登入者可讀寫（純快取，非機密）。
drop policy if exists fx_select on public.fx_cache;
create policy fx_select on public.fx_cache for select
  using (auth.role() = 'authenticated');
drop policy if exists fx_insert on public.fx_cache;
create policy fx_insert on public.fx_cache for insert
  with check (auth.role() = 'authenticated');

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
