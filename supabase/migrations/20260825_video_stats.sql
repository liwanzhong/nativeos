-- 2026-08-25: 视频跟读数据统计表
-- P1 阶段:本地优先,App 不登录也能用。Supabase 同步是可选的。
-- 本地真源 = nativeos.db 的 video_stats / daily_stats,不带 user_id
-- 云端 = 这两张表(带 user_id),由 RLS 隔离不同用户

-- ── 单视频累计数据 ───────────────────────────────
create table if not exists video_stats (
  user_id          uuid        not null references auth.users(id) on delete cascade,
  video_id         text        not null,
  foreground_ms    bigint      not null default 0,  -- A: AppState=active 期间累计
  background_ms    bigint      not null default 0,  -- B: AppState≠active 期间累计
  shadowing_count  int         not null default 0,  -- C: 跟读次数(按下松开 1 次)
  updated_at       timestamptz not null default now(),
  primary key (user_id, video_id)
);

create index if not exists video_stats_user_updated_idx
  on video_stats (user_id, updated_at desc);

-- ── 日聚合数据 ───────────────────────────────────
create table if not exists daily_stats (
  user_id          uuid        not null references auth.users(id) on delete cascade,
  date             date        not null,
  foreground_ms    bigint      not null default 0,
  background_ms    bigint      not null default 0,
  shadowing_count  int         not null default 0,
  primary key (user_id, date)
);

create index if not exists daily_stats_user_date_idx
  on daily_stats (user_id, date desc);

-- ── RLS:用户只能读写自己的数据 ──────────────────
alter table video_stats enable row level security;
alter table daily_stats enable row level security;

drop policy if exists video_stats_self_select on video_stats;
create policy video_stats_self_select on video_stats
  for select using (auth.uid() = user_id);

drop policy if exists video_stats_self_insert on video_stats;
create policy video_stats_self_insert on video_stats
  for insert with check (auth.uid() = user_id);

drop policy if exists video_stats_self_update on video_stats;
create policy video_stats_self_update on video_stats
  for update using (auth.uid() = user_id);

drop policy if exists daily_stats_self_select on daily_stats;
create policy daily_stats_self_select on daily_stats
  for select using (auth.uid() = user_id);

drop policy if exists daily_stats_self_insert on daily_stats;
create policy daily_stats_self_insert on daily_stats
  for insert with check (auth.uid() = user_id);

drop policy if exists daily_stats_self_update on daily_stats;
create policy daily_stats_self_update on daily_stats
  for update using (auth.uid() = user_id);
