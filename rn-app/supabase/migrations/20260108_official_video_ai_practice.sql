-- ============================================================
-- Per-episode AI practice cards (replaces OSS-hosted .ai-practice.json)
-- ============================================================
-- One row per practice card. The card is identified by its `id`
-- field (stable across imports; comes from the AI analyzer's output
-- when the .ai-practice.json was originally generated). One episode
-- can have many cards (1:N).
--
-- Why a separate table (not a JSONB column on `official_video_episodes`):
--   - Cards are independently queryable ("all A1 reading cards
--     across all series" is a plausible future use)
--   - FSRS / user-progress can FK to individual cards later
--   - Avoids megabyte-sized rows when an episode has 10+ cards
--
-- Apply via: Supabase dashboard → SQL Editor → New query → paste → Run
-- ============================================================

create table if not exists public.official_video_ai_practice (
  id                text not null,            -- stable id from the AI analyzer (e.g. "a1-ep01-card-1")
  series_id         text not null,            -- FK to the parent episode's series
  episode_id        text not null,            -- FK to the parent episode's id (composite with series_id)

  -- ordering / display (mirrors the OSS card fields, snake_cased)
  card_index        int  not null,            -- 0-based; preserves original order in .ai-practice.json
  icon              text not null default '💬',
  category          text not null default '',
  level             text not null default 'B1',
  title             text not null,
  description       text not null default '',         -- English task description
  description_zh    text,                            -- Chinese translation (nullable)

  -- NPC persona
  npc_emoji         text,
  npc_name          text,
  npc_status        text,
  npc_system_prompt text,                            -- includes invisible FSRS injection

  -- opening line / environmental cue (one or the other set, depending on `user_initiates`)
  opening_line          text,
  opening_line_zh       text,
  environmental_cue     text,
  environmental_cue_en  text,

  -- behavior
  user_initiates    boolean not null default false,  -- true = user speaks first (npc opens with environmentalCue)
  task_contract     jsonb,                           -- derived ScenarioTaskContract (partial)

  is_published      boolean not null default true,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  primary key (series_id, id),
  foreign key (series_id, episode_id)
    references public.official_video_episodes(series_id, id)
    on delete cascade
);

-- Listing cards of an episode (the main read pattern from the player)
create index if not exists idx_official_video_ai_practice_episode
  on public.official_video_ai_practice (series_id, episode_id, card_index);

-- "All published cards by level" — a future "browse practice cards" feature
create index if not exists idx_official_video_ai_practice_level
  on public.official_video_ai_practice (level, is_published);


-- ── RLS ───────────────────────────────────────────────────────────
alter table public.official_video_ai_practice enable row level security;

-- Anyone (anon + authed) can read published cards.
drop policy if exists "official_video_ai_practice_select_published" on public.official_video_ai_practice;
create policy "official_video_ai_practice_select_published" on public.official_video_ai_practice
  for select using (is_published = true);

-- No INSERT/UPDATE/DELETE policies → RLS defaults deny.
-- Only service_role (desktop admin + one-shot importer) can write.


-- ── updated_at auto-maintenance ────────────────────────────────────
drop trigger if exists official_video_ai_practice_touch_updated_at on public.official_video_ai_practice;
create trigger official_video_ai_practice_touch_updated_at
  before update on public.official_video_ai_practice
  for each row execute function public.touch_updated_at();
