-- ============================================================
-- User-created collections ("我的合集")
-- ============================================================
-- Adds:
--   1. public.user_collections — user-owned collections.
--      The "default collection" (auto-created on first import) is
--      flagged via is_default = true and used as the catch-all sink
--      for imported videos. Each user can have AT MOST one default
--      collection (enforced by a partial unique index).
--   2. RLS — users can only read/write their own collections.
--   3. updated_at trigger (uses the touch_updated_at() from 20260101).
--
-- Why a separate table from user_picked_video_series:
--   user_picked_video_series records the user's subscription to
--   OFFICIAL series (managed by NativeOS, locked from the user).
--   user_collections is the user's own curated collections —
--   title / cover / what videos belong to them are all user-driven.
--   The home page unions both into a single "我的合集" grid.
-- ============================================================

create table if not exists public.user_collections (
  id           bigserial primary key,
  user_id      uuid not null references auth.users(id) on delete cascade,
  title        text not null,
  description  text,
  cover_url    text,
  -- The "default collection" is auto-created the first time a user
  -- imports a video (and re-used on every subsequent import until
  -- the user explicitly moves things elsewhere). Each user has at
  -- most ONE default collection — enforced by the partial unique
  -- index below.
  is_default   boolean not null default false,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- Listing: most-recent first per user.
create index if not exists idx_user_collections_user_created
  on public.user_collections (user_id, created_at desc);

-- At most one default per user.
create unique index if not exists idx_user_collections_default_per_user
  on public.user_collections (user_id)
  where is_default = true;

-- RLS
alter table public.user_collections enable row level security;

drop policy if exists "user_collections_select_own" on public.user_collections;
create policy "user_collections_select_own" on public.user_collections
  for select using (auth.uid() = user_id);

drop policy if exists "user_collections_insert_own" on public.user_collections;
create policy "user_collections_insert_own" on public.user_collections
  for insert with check (auth.uid() = user_id);

drop policy if exists "user_collections_update_own" on public.user_collections;
create policy "user_collections_update_own" on public.user_collections
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "user_collections_delete_own" on public.user_collections;
create policy "user_collections_delete_own" on public.user_collections
  for delete using (auth.uid() = user_id);

-- updated_at trigger
drop trigger if exists user_collections_touch_updated_at on public.user_collections;
create trigger user_collections_touch_updated_at
  before update on public.user_collections
  for each row execute function public.touch_updated_at();
