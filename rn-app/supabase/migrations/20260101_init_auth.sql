-- ============================================================
-- Initial auth + profiles schema for NativeOS mobile app
-- ============================================================
-- Apply via: Supabase dashboard → SQL Editor → New query → paste → Run
--
-- This migration:
--   1. Creates public.profiles (one row per auth.users)
--   2. Enables RLS so users can only read/edit their own row
--   3. Auto-creates a profile row on signup via trigger
--      (so "login is registration" works — first signInWithOtp on
--       a new email auto-creates the auth.users row, and the trigger
--       then creates the matching profiles row)
-- ============================================================

-- 1. profiles table
create table if not exists public.profiles (
  id           uuid primary key references auth.users(id) on delete cascade,
  email        text not null,
  display_name text,
  level        text not null default 'B1',
  interests    text[] not null default '{}',
  profession   text,
  -- Stats mirrored from local SQLite (best-effort, not source of truth)
  card_count   int not null default 0,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index if not exists idx_profiles_email on public.profiles (email);

-- 2. RLS
alter table public.profiles enable row level security;

-- Users can read their own profile
drop policy if exists "profiles_select_own" on public.profiles;
create policy "profiles_select_own" on public.profiles
  for select using (auth.uid() = id);

-- Users can insert their own profile (defensive — trigger usually handles this)
drop policy if exists "profiles_insert_own" on public.profiles;
create policy "profiles_insert_own" on public.profiles
  for insert with check (auth.uid() = id);

-- Users can update their own profile
drop policy if exists "profiles_update_own" on public.profiles;
create policy "profiles_update_own" on public.profiles
  for update using (auth.uid() = id);

-- 3. Auto-create profile on signup
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email, display_name)
  values (new.id, new.email, split_part(new.email, '@', 1))
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- 4. updated_at auto-touch on update
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists profiles_touch_updated_at on public.profiles;
create trigger profiles_touch_updated_at
  before update on public.profiles
  for each row execute function public.touch_updated_at();
