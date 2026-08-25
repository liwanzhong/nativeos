/**
 * Stats 同步层 · Supabase 双向同步(本地优先)
 *
 * 触发时机:
 *   - 启动时(应用初始化 root 处)— pullOnStartup
 *   - AppState 切到 background — pushOnFlush
 *
 * 核心策略:**本地是真源,远端是补全**
 *   - 未登录 / supabase 未配置 → 静默 skip,完全不影响本地
 *   - 推:本地所有 video_stats / daily_stats upsert 到 Supabase
 *   - 拉:远端数据**只补全本地没有的 video_id / date**,绝不覆盖
 *
 * 为什么是"只补全不覆盖"而不是 last-write-wins:
 *   App 不登录也能用,本地累积才是用户真实投入。
 *   如果用户先不登录用了 3 天,登录后远端有 1 天旧数据,
 *   覆盖会丢失 2 天;补全则 3 天完整保留。
 */

import { supabase } from '../supabase';
import {
  readAllVideoStats,
  readDailyStats,
  writeVideoStatsIfMissing,
  writeDailyStatsIfMissing,
  type VideoStats,
  type DailyStats,
} from './storage';

// ── 工具 ───────────────────────────────────────

async function getUserId(): Promise<string | null> {
  try {
    const { data } = await supabase.auth.getSession();
    return data?.session?.user?.id ?? null;
  } catch {
    return null;
  }
}

// ── 推:本地推到 Supabase ─────────────────────

/**
 * P1 阶段推送功能未启用:
 *   本地表 video_stats / daily_stats 没有 user_id 列,
 *   要推送必须先扩 v9 migration 加 user_id,然后改所有写入路径。
 *   留到 P2 阶段。
 */
export async function pushToSupabase(): Promise<void> {
  // no-op for P1
}

// ── 拉:从 Supabase 补全本地 ───────────────────

export async function pullFromSupabase(): Promise<void> {
  const userId = await getUserId();
  if (!userId) return; // 未登录,静默跳过

  // 1. video_stats — 拉远端,只补本地没有的
  try {
    const { data: remoteVideos, error } = await supabase
      .from('video_stats')
      .select('video_id, foreground_ms, background_ms, shadowing_count, updated_at')
      .eq('user_id', userId);
    if (error) {
      console.warn('[stats/sync] pull video_stats failed:', error.message);
    } else if (remoteVideos && remoteVideos.length > 0) {
      for (const r of remoteVideos) {
        const stats: VideoStats = {
          videoId: r.video_id,
          foregroundMs: Number(r.foreground_ms),
          backgroundMs: Number(r.background_ms),
          shadowingCount: Number(r.shadowing_count),
          updatedAt: new Date(r.updated_at).getTime(),
        };
        await writeVideoStatsIfMissing(stats);
      }
    }
  } catch (e) {
    console.warn('[stats/sync] pull video_stats threw:', e);
  }

  // 2. daily_stats — 拉最近 90 天,只补本地没有的
  try {
    const ninetyDaysAgo = new Date();
    ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);
    const startDate = ninetyDaysAgo.toISOString().slice(0, 10);

    const { data: remoteDaily, error } = await supabase
      .from('daily_stats')
      .select('date, foreground_ms, background_ms, shadowing_count')
      .eq('user_id', userId)
      .gte('date', startDate);
    if (error) {
      console.warn('[stats/sync] pull daily_stats failed:', error.message);
    } else if (remoteDaily && remoteDaily.length > 0) {
      for (const r of remoteDaily) {
        const stats: DailyStats = {
          date: r.date,
          foregroundMs: Number(r.foreground_ms),
          backgroundMs: Number(r.background_ms),
          shadowingCount: Number(r.shadowing_count),
        };
        await writeDailyStatsIfMissing(stats);
      }
    }
  } catch (e) {
    console.warn('[stats/sync] pull daily_stats threw:', e);
  }
}

// ── 完整同步(只拉不推,P1) ─────────────────────

let syncInFlight: Promise<void> | null = null;

export async function syncStats(): Promise<void> {
  if (syncInFlight) return syncInFlight;
  syncInFlight = (async () => {
    // P1 阶段:只拉不推。推送要等 v9 加 user_id 列。
    await pullFromSupabase();
  })().finally(() => {
    syncInFlight = null;
  });
  return syncInFlight;
}
