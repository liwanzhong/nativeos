-- ============================================================
-- Per-series video episodes (replaces OSS-hosted series.json)
-- ============================================================
-- Each row is one video inside a series. The video file itself
-- stays on OSS — this table only stores the relative filename
-- (`video_file` = "ep-01.mp4"), the same way `official_video_series`
-- stores `cover_url` as a bare filename.
--
-- Why: single source of truth. The old per-series `manifest.json`
-- had to be re-uploaded every time an episode was added/removed;
-- now the desktop admin writes here and the mobile app reads
-- from here. The OSS manifest.json files are left in place
-- (read-only legacy cache) but no new code reads them.
--
-- Apply via: Supabase dashboard → SQL Editor → New query → paste → Run
-- ============================================================

-- 1. official_video_episodes
create table if not exists public.official_video_episodes (
  id                          text not null,           -- stable id (e.g. "a1-beginner-ep-01")
  series_id                   text not null references public.official_video_series(id) on delete cascade,

  -- ordering / display
  episode_index               int  not null,           -- 1-based; used for sort + filename stem fallback
  title                       text not null,

  -- mirrors the per-series meta (denormalised for query speed; same as
  -- official_video_series. The rn-app can fall back to the series row
  -- if these are NULL, but writing them here saves a join).
  level                       text not null default 'A1',
  category                    text not null default '',
  type                        text not null default 'vlog',
  source_label                text not null default '',

  -- asset filenames, relative to `videos/<series_id>/` on OSS.
  -- These are bare filenames (not full URLs); the rn-app builds
  -- the full URL by stripping the `series.json` basename from
  -- `official_video_series.manifest_url` and appending the encoded
  -- asset path. (`manifest_url` is still set per series; it's the
  -- canonical "where the assets live" pointer.)
  video_file                  text not null,
  subtitle_json3_file         text,
  info_file                   text,
  ai_practice_file            text,
  subtitle_zh_file            text,
  subtitle_en_segmented_file  text,
  cover_file                  text,

  has_roleplay                boolean not null default true,
  duration_seconds            numeric,
  is_published                boolean not null default true,

  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now(),

  primary key (series_id, id)
);

-- Listing episodes of a series (the main read pattern)
create index if not exists idx_official_video_episodes_series
  on public.official_video_episodes (series_id, episode_index);

-- "All published episodes" (admin-side stats / future "all videos" page)
create index if not exists idx_official_video_episodes_published
  on public.official_video_episodes (is_published, series_id);


-- 2. RLS
alter table public.official_video_episodes enable row level security;

-- Anyone (anon + authed) can read published episodes of published series
drop policy if exists "official_video_episodes_select_published" on public.official_video_episodes;
create policy "official_video_episodes_select_published" on public.official_video_episodes
  for select using (is_published = true);

-- No INSERT/UPDATE/DELETE policies → RLS defaults deny.
-- Only service_role (desktop admin) can write.


-- 3. updated_at auto-maintenance
drop trigger if exists official_video_episodes_touch_updated_at on public.official_video_episodes;
create trigger official_video_episodes_touch_updated_at
  before update on public.official_video_episodes
  for each row execute function public.touch_updated_at();
