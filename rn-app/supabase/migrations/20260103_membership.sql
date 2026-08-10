-- ============================================================
-- Membership system schema for NativeOS
-- ============================================================
-- Apply via: Supabase dashboard → SQL Editor → New query → paste → Run
--
-- Adds:
--   1. profiles.is_pro / pro_expires_at — Pro membership status
--   2. profiles.quota_config — adjustable quota limits (free + pro)
--   3. profiles.quota_snapshot — last-synced local usage (cross-device merge)
--   4. pro_codes — redemption code table (single-redeem, time-bounded)
-- ============================================================

-- 1. Pro status on profiles
alter table public.profiles
  add column if not exists is_pro boolean not null default false,
  add column if not exists pro_expires_at timestamptz;

-- 2. Adjustable quota config (free / pro soft+hard limits)
-- Shape mirrors local app_config 'quota_config' key, see lib/quota.ts DEFAULT_CONFIG.
alter table public.profiles
  add column if not exists quota_config jsonb not null default '{
    "free": {
      "ai_rounds": {"soft": 10, "hard": 30},
      "asr":      {"soft": 20, "hard": 60},
      "tts":      {"soft": 50, "hard": 150}
    },
    "pro": {
      "ai_rounds": {"soft": 200, "hard": 1000},
      "asr":      {"soft": 500, "hard": 2500},
      "tts":      {"soft": 2000, "hard": 10000}
    }
  }'::jsonb;

-- 3. Quota snapshot — last push from client (merge target on relogin/reinstall)
-- Shape: { "YYYY-MM-DD": { "ai_rounds": N, "asr": N, "tts": N }, ... } keyed by date
alter table public.profiles
  add column if not exists quota_snapshot jsonb not null default '{}'::jsonb;

-- 4. Pro redemption codes
create table if not exists public.pro_codes (
  code             text primary key,
  duration_days    int  not null check (duration_days > 0),
  used_by          uuid references auth.users(id) on delete set null,
  used_at          timestamptz,
  -- code itself expires (independent of who redeems it). After this date
  -- the code cannot be redeemed even if unused.
  expires_at       timestamptz not null,
  created_at       timestamptz not null default now()
);

create index if not exists idx_pro_codes_unused on public.pro_codes(used_by) where used_by is null;

alter table public.pro_codes enable row level security;

-- Anyone (anon + authed) can attempt to redeem — the redemption is a single
-- UPDATE that fails if the code is already used. We restrict SELECT to hide
-- which codes are unused (avoid leaking them publicly).
drop policy if exists "pro_codes_select_own" on public.pro_codes;
create policy "pro_codes_select_own" on public.pro_codes
  for select using (used_by = auth.uid());

-- Redemption is a single UPDATE: only unused + unexpired codes can be
-- flipped to (auth.uid, now()). Atomic via the where clause — concurrent
-- redeemers can't both succeed.
drop policy if exists "pro_codes_redeem" on public.pro_codes;
create policy "pro_codes_redeem" on public.pro_codes
  for update using (used_by is null and expires_at > now())
       with check (used_by = auth.uid() and used_at is not null);

-- updated_at style trigger is unnecessary — used_at is the redemption stamp.
-- 5. touch updated_at already on profiles (set in 20260101_init_auth.sql) — no change.
