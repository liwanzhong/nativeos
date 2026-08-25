/**
 * Stats 核心入口
 *
 * 对外 API:
 *   - recordPlayback(videoId, deltaMs, isActive)   累加播放时长(同步)
 *   - recordShadowing(videoId)                     累加跟读次数(同步)
 *   - getVideoStats(videoId)                       查询单视频
 *   - getDailyStats(startDate, endDate)            查询日期段
 *   - getAllVideoStats()                           查询所有视频
 *   - forceFlush()                                 强制 flush(切后台/退出前调)
 *   - installAppStateFlushListener()               全局监听 AppState,bg 时自动 flush + sync
 *   - installStatsSync()                           启动时拉一次云端
 *
 * 实现策略:
 *   - 写:inMemory 累加(同步、原子、无竞态)+ 5s 节流 batch UPSERT 到 SQLite
 *   - 读:优先 inMemory → 缺则 SQLite 查询
 *   - 同步:可选的 Supabase 双向同步,未登录完全静默
 *   - 本地优先:App 不登录也能用,所有数据存 nativeos.db
 *
 * 边界处理:
 *   - delta <= 0 或 > 2000ms:判定为 seek/异常,不计入
 *   - AppState 在 tick 之间变化:以该 tick 内的 isActive 为准
 */

import { AppState, type AppStateStatus } from 'react-native';
import {
  incrementVideoStats,
  incrementVideoShadowing,
  incrementDailyStats,
  incrementDailyShadowing,
  readVideoStats,
  readVideoStatsSync,
  readAllVideoStats,
  readDailyStats,
  clearAllStats as storageClearAll,
  flush as storageFlush,
  todayLocalDate,
  type VideoStats,
  type DailyStats,
} from './storage';

const SEEK_THRESHOLD_MS = 2000;

// ── 累加器(同步,无竞态) ─────────────────────────────

export function recordPlayback(
  videoId: string,
  deltaMs: number,
  isActive: boolean
): void {
  if (!videoId) return;
  if (deltaMs <= 0 || deltaMs > SEEK_THRESHOLD_MS) return;

  incrementVideoStats(videoId, deltaMs, isActive);
  const today = todayLocalDate();
  const dailyAfter = incrementDailyStats(today, deltaMs, isActive);
  console.log(
    `[stats] recordPlayback videoId=${videoId.slice(0, 20)} deltaMs=${deltaMs} isActive=${isActive} daily[${today}] now=${dailyAfter.foregroundMs}ms`
  );
}

export function recordShadowing(videoId: string): void {
  if (!videoId) return;
  incrementVideoShadowing(videoId);
  const today = todayLocalDate();
  const dailyAfter = incrementDailyShadowing(today);
  console.log(
    `[stats] recordShadowing videoId=${videoId.slice(0, 20)} daily[${today}] shadowingCount now=${dailyAfter.shadowingCount}`
  );
}

// ── 查询 ────────────────────────────────────────────

export async function getVideoStats(videoId: string): Promise<VideoStats | null> {
  return readVideoStats(videoId);
}

export async function getDailyStats(
  startDate: string,
  endDate: string
): Promise<DailyStats[]> {
  return readDailyStats(startDate, endDate);
}

export async function getAllVideoStats(): Promise<VideoStats[]> {
  return readAllVideoStats();
}

/** 清空所有统计数据(测试/调试用) */
export async function clearAllStats(): Promise<void> {
  return storageClearAll();
}

/** 同步读 inMemory 累加器(不等 DB)— 实时性高,用于 UI 展示和 toast */
export function readInMemoryVideoStats(videoId: string): VideoStats | null {
  return readVideoStatsSync(videoId);
}

// ── 强制 flush ─────────────────────────────────────

export async function forceFlush(): Promise<void> {
  console.log('[stats] forceFlush START');
  await storageFlush();
  console.log('[stats] forceFlush DONE');
}

// ── Supabase 同步(P1,可选) ────────────────────────

import { syncStats, pullFromSupabase, pushToSupabase } from './sync';

/** 完整双向同步 */
export async function forceSync(): Promise<void> {
  await storageFlush();
  return syncStats();
}

/** 启动时拉一次(后台跑) */
export function pullOnStartup(): void {
  pullFromSupabase().catch((e) =>
    console.warn('[stats] startup pull failed:', e)
  );
}

/** 主动推(forceFlush 后) */
export function pushOnFlush(): void {
  pushToSupabase().catch((e) =>
    console.warn('[stats] flush push failed:', e)
  );
}

// ── 工具导出 ───────────────────────────────────────

export { todayLocalDate };
export type { VideoStats, DailyStats } from './storage';

/**
 * 监听 AppState,切到 background 时 flush + 推 Supabase。
 * 在 App 入口(root)处调一次。
 */
export function installAppStateFlushListener(): () => void {
  const sub = AppState.addEventListener('change', (next: AppStateStatus) => {
    console.log('[stats] AppState change ->', next);
    if (next !== 'active') {
      forceFlush()
        .then(() => pushOnFlush())
        .catch((e) => console.warn('[stats] background flush failed:', e));
    }
  });
  return () => sub.remove();
}

/**
 * 启动时拉一次云端(未登录静默 skip)。
 */
export function installStatsSync(): () => void {
  pullOnStartup();
  return () => {};
}
