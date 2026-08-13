-- ============================================================
-- Official video series + user-picked series
-- ============================================================
-- Replaces the OSS-hosted official-video-catalog.json with a
-- Supabase-backed table. Series metadata lives here; video files
-- themselves stay on OSS (series.manifest_url points at the
-- series manifest in the OSS bucket).
--
-- Why: maintenance. Editing a Supabase row is cheaper than
-- shipping a JSON file every time content changes. Also enables
-- a per-user "my picked series" collection that drives the new
-- "我的跟练" tab — without this table the resource-library UX
-- can't distinguish "user opted in" from "catalog said so".
--
-- Apply via: Supabase dashboard → SQL Editor → New query → paste → Run
-- ============================================================

-- 1. official_video_series
-- Replaces the `series[]` array inside official-video-catalog.json
create table if not exists public.official_video_series (
  id                  text primary key,
  title               text not null,
  level               text not null,                 -- A1..C2 (string, not enum — easier to extend)
  category            text not null,                 -- 综合 / 旅行 / 社交 ...
  type                text not null default 'vlog',  -- vlog / dialogue / lecture / film / interview
  description         text,
  cover_url           text,
  tags                text[] not null default '{}',
  sort_order          int  not null default 0,       -- admin manual sort, lower = first
  manifest_url        text not null,                 -- 该 series 自己的 manifest (OSS)
  resource_base_url   text,                          -- series 资源根 URL,fallback 到 OSS bucket 根
  is_published        boolean not null default true, -- 软下架:false 时前端过滤掉
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create index if not exists idx_official_video_series_published
  on public.official_video_series (is_published, sort_order, level);

-- 2. user_picked_video_series
-- "我的跟练" = 用户从资源库里挑的 series 集合
create table if not exists public.user_picked_video_series (
  id                  bigserial primary key,
  user_id             uuid not null references auth.users(id) on delete cascade,
  series_id           text not null references public.official_video_series(id) on delete cascade,
  picked_at           timestamptz not null default now(),
  last_practiced_at   timestamptz,
  is_pinned           boolean not null default false
);

-- 一个 user 不能重复挑同一个 series
create unique index if not exists idx_user_picked_video_series_unique
  on public.user_picked_video_series (user_id, series_id);

-- 排序辅助:按加入时间倒序
create index if not exists idx_user_picked_video_series_user_picked
  on public.user_picked_video_series (user_id, picked_at desc);

-- 3. RLS

-- 3.1 official_video_series: 任何人(anon + authed)可以读已发布的;写入走 service_role(导入脚本)
alter table public.official_video_series enable row level security;

drop policy if exists "official_video_series_select_published" on public.official_video_series;
create policy "official_video_series_select_published" on public.official_video_series
  for select using (is_published = true);

-- 不创建 INSERT/UPDATE/DELETE policy → RLS 默认拒绝(只有 service_role 能改)

-- 3.2 user_picked_video_series: 用户只能看/改/删自己的行
alter table public.user_picked_video_series enable row level security;

drop policy if exists "user_picked_video_series_select_own" on public.user_picked_video_series;
create policy "user_picked_video_series_select_own" on public.user_picked_video_series
  for select using (auth.uid() = user_id);

drop policy if exists "user_picked_video_series_insert_own" on public.user_picked_video_series;
create policy "user_picked_video_series_insert_own" on public.user_picked_video_series
  for insert with check (auth.uid() = user_id);

drop policy if exists "user_picked_video_series_update_own" on public.user_picked_video_series;
create policy "user_picked_video_series_update_own" on public.user_picked_video_series
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "user_picked_video_series_delete_own" on public.user_picked_video_series;
create policy "user_picked_video_series_delete_own" on public.user_picked_video_series
  for delete using (auth.uid() = user_id);

-- 4. updated_at 自动维护 (official_video_series)
drop trigger if exists official_video_series_touch_updated_at on public.official_video_series;
create trigger official_video_series_touch_updated_at
  before update on public.official_video_series
  for each row execute function public.touch_updated_at();
