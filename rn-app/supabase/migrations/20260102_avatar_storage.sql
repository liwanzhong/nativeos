-- ============================================================
-- Add avatar upload support to NativeOS
-- ============================================================
-- Apply via: Supabase dashboard → SQL Editor → New query → paste → Run
--
-- This migration:
--   1. Adds avatar_url column to public.profiles
--   2. Creates the `avatars` storage bucket (public read)
--   3. Sets RLS so users can only write to their own folder:
--      <uid>/<file>  →  user can upload/update/delete files in their own folder
--   4. Anyone (anon + authed) can read (bucket is public for avatar CDN access)
-- ============================================================

-- 1. avatar_url column
alter table public.profiles
  add column if not exists avatar_url text;

-- 2. storage bucket
insert into storage.buckets (id, name, public)
values ('avatars', 'avatars', true)
on conflict (id) do nothing;

-- 3. RLS on storage.objects
-- Path convention: <auth.uid()>/<file>
-- So the first folder segment must equal auth.uid().

drop policy if exists "avatars_select_public" on storage.objects;
create policy "avatars_select_public" on storage.objects
  for select using (bucket_id = 'avatars');

drop policy if exists "avatars_insert_own" on storage.objects;
create policy "avatars_insert_own" on storage.objects
  for insert with check (
    bucket_id = 'avatars'
    and auth.uid()::text = split_part(name, '/', 1)
  );

drop policy if exists "avatars_update_own" on storage.objects;
create policy "avatars_update_own" on storage.objects
  for update using (
    bucket_id = 'avatars'
    and auth.uid()::text = split_part(name, '/', 1)
  );

drop policy if exists "avatars_delete_own" on storage.objects;
create policy "avatars_delete_own" on storage.objects
  for delete using (
    bucket_id = 'avatars'
    and auth.uid()::text = split_part(name, '/', 1)
  );
