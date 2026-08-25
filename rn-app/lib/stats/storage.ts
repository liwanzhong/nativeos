/**
 * Stats 本地存储层 · SQLite (expo-sqlite)
 *
 * 设计要点:
 *   1. 本地优先,所有累加都直接落到 nativeos.db 的 video_stats / daily_stats 表
 *   2. inMemory 累加器 — timeUpdate 触发频率约 10Hz,直接 SQL UPSERT 会卡 UI
 *      → 内存累加 + 5 秒节流 batch UPSERT,原子性靠 SQLite WAL + 单条 UPSERT 保证
 *   3. 失败容忍 — 写盘失败只在 console.warn,不影响主流程
 *
 * 不再使用 AsyncStorage(本模块 v2 起) — 统计信息应该走 nativeos.db,
 * 与其他学习数据放在一起,App 备份/迁移时一起处理。
 */

import { getDatabase } from '../database';

export interface VideoStats {
  videoId: string;
  foregroundMs: number;
  backgroundMs: number;
  shadowingCount: number;
  updatedAt: number;
}

export interface DailyStats {
  date: string; // 'YYYY-MM-DD' 本地时区
  foregroundMs: number;
  backgroundMs: number;
  shadowingCount: number;
}

// ── 内存缓冲层 ────────────────────────────────────────────
const videoBuffer = new Map<string, VideoStats>();
const dailyBuffer = new Map<string, DailyStats>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let flushInFlight: Promise<void> | null = null;

const FLUSH_INTERVAL_MS = 5000;

// 同步内存副本,用于"先读后写"的原子累加,避免 read-then-write 竞态
const inMemoryVideo = new Map<string, VideoStats>();
const inMemoryDaily = new Map<string, DailyStats>();

function todayLocalDate(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// ── DB 写入(UPSERT) ───────────────────────────────────

async function upsertVideoStats(stats: VideoStats): Promise<void> {
  const db = await getDatabase();
  // ⭐ 关键:绝对值覆盖,不是累加
  // inMemoryVideo 始终是最新累计值,直接覆盖 DB
  // (之前的累加模式会导致每次 flush 把累计值当增量加,数字越累越大)
  await db.runAsync(
    `INSERT INTO video_stats (video_id, foreground_ms, background_ms, shadowing_count, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(video_id) DO UPDATE SET
       foreground_ms   = excluded.foreground_ms,
       background_ms   = excluded.background_ms,
       shadowing_count = excluded.shadowing_count,
       updated_at      = excluded.updated_at`,
    [stats.videoId, stats.foregroundMs, stats.backgroundMs, stats.shadowingCount, stats.updatedAt]
  );
}

async function upsertDailyStats(stats: DailyStats): Promise<void> {
  const db = await getDatabase();
  // ⭐ 同上,绝对值覆盖
  await db.runAsync(
    `INSERT INTO daily_stats (date, foreground_ms, background_ms, shadowing_count)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(date) DO UPDATE SET
       foreground_ms   = excluded.foreground_ms,
       background_ms   = excluded.background_ms,
       shadowing_count = excluded.shadowing_count`,
    [stats.date, stats.foregroundMs, stats.backgroundMs, stats.shadowingCount]
  );
}

async function setVideoStatsAbsolute(stats: VideoStats): Promise<void> {
  // 用于 sync 拉远端数据时"覆盖式"写入(本地没有才调)
  const db = await getDatabase();
  await db.runAsync(
    `INSERT INTO video_stats (video_id, foreground_ms, background_ms, shadowing_count, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(video_id) DO UPDATE SET
       foreground_ms   = excluded.foreground_ms,
       background_ms   = excluded.background_ms,
       shadowing_count = excluded.shadowing_count,
       updated_at      = excluded.updated_at`,
    [stats.videoId, stats.foregroundMs, stats.backgroundMs, stats.shadowingCount, stats.updatedAt]
  );
}

async function setDailyStatsAbsolute(stats: DailyStats): Promise<void> {
  const db = await getDatabase();
  await db.runAsync(
    `INSERT INTO daily_stats (date, foreground_ms, background_ms, shadowing_count)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(date) DO UPDATE SET
       foreground_ms   = excluded.foreground_ms,
       background_ms   = excluded.background_ms,
       shadowing_count = excluded.shadowing_count`,
    [stats.date, stats.foregroundMs, stats.backgroundMs, stats.shadowingCount]
  );
}

// ── 同步累加 API(无竞态) ──────────────────────────

export function incrementVideoStats(
  videoId: string,
  deltaMs: number,
  isActive: boolean
): VideoStats {
  const now = Date.now();
  const existing = inMemoryVideo.get(videoId) ?? {
    videoId,
    foregroundMs: 0,
    backgroundMs: 0,
    shadowingCount: 0,
    updatedAt: now,
  };
  const next: VideoStats = {
    ...existing,
    foregroundMs: existing.foregroundMs + (isActive ? deltaMs : 0),
    backgroundMs: existing.backgroundMs + (isActive ? 0 : deltaMs),
    updatedAt: now,
  };
  inMemoryVideo.set(videoId, next);
  videoBuffer.set(videoId, next);
  scheduleFlush();
  return next;
}

export function incrementVideoShadowing(videoId: string): VideoStats {
  const now = Date.now();
  const existing = inMemoryVideo.get(videoId) ?? {
    videoId,
    foregroundMs: 0,
    backgroundMs: 0,
    shadowingCount: 0,
    updatedAt: now,
  };
  const next: VideoStats = {
    ...existing,
    shadowingCount: existing.shadowingCount + 1,
    updatedAt: now,
  };
  inMemoryVideo.set(videoId, next);
  videoBuffer.set(videoId, next);
  scheduleFlush();
  return next;
}

export function incrementDailyStats(
  date: string,
  deltaMs: number,
  isActive: boolean
): DailyStats {
  const existing = inMemoryDaily.get(date) ?? {
    date,
    foregroundMs: 0,
    backgroundMs: 0,
    shadowingCount: 0,
  };
  const next: DailyStats = {
    ...existing,
    foregroundMs: existing.foregroundMs + (isActive ? deltaMs : 0),
    backgroundMs: existing.backgroundMs + (isActive ? 0 : deltaMs),
  };
  inMemoryDaily.set(date, next);
  dailyBuffer.set(date, next);
  scheduleFlush();
  return next;
}

export function incrementDailyShadowing(date: string): DailyStats {
  const existing = inMemoryDaily.get(date) ?? {
    date,
    foregroundMs: 0,
    backgroundMs: 0,
    shadowingCount: 0,
  };
  const next: DailyStats = {
    ...existing,
    shadowingCount: existing.shadowingCount + 1,
  };
  inMemoryDaily.set(date, next);
  dailyBuffer.set(date, next);
  scheduleFlush();
  return next;
}

// ── 同步读 API ───────────────────────────────────────

export function readVideoStatsSync(videoId: string): VideoStats | null {
  return inMemoryVideo.get(videoId) ?? null;
}

// ── 异步读 API ───────────────────────────────────────

export async function readVideoStats(videoId: string): Promise<VideoStats | null> {
  // 优先读 inMemory(累加器维护的最新值,可能比 DB 更准)
  const inMem = inMemoryVideo.get(videoId);
  if (inMem) return inMem;
  try {
    const db = await getDatabase();
    const row: any = await db.getFirstAsync(
      'SELECT video_id, foreground_ms, background_ms, shadowing_count, updated_at FROM video_stats WHERE video_id = ?',
      [videoId]
    );
    if (!row) return null;
    const stats: VideoStats = {
      videoId: row.video_id,
      foregroundMs: Number(row.foreground_ms),
      backgroundMs: Number(row.background_ms),
      shadowingCount: Number(row.shadowing_count),
      updatedAt: Number(row.updated_at),
    };
    inMemoryVideo.set(videoId, stats);
    return stats;
  } catch (e) {
    console.warn('[stats/storage] readVideoStats failed:', videoId, e);
    return null;
  }
}

export async function readAllVideoStats(): Promise<VideoStats[]> {
  try {
    const db = await getDatabase();
    const rows: any[] = await db.getAllAsync(
      'SELECT video_id, foreground_ms, background_ms, shadowing_count, updated_at FROM video_stats'
    );
    return rows.map((row) => ({
      videoId: row.video_id,
      foregroundMs: Number(row.foreground_ms),
      backgroundMs: Number(row.background_ms),
      shadowingCount: Number(row.shadowing_count),
      updatedAt: Number(row.updated_at),
    }));
  } catch (e) {
    console.warn('[stats/storage] readAllVideoStats failed:', e);
    return [];
  }
}

export async function readDailyStats(
  startDate: string,
  endDate: string
): Promise<DailyStats[]> {
  try {
    const db = await getDatabase();
    // 1. 拉范围内已有的行
    const rows: any[] = await db.getAllAsync(
      'SELECT date, foreground_ms, background_ms, shadowing_count FROM daily_stats WHERE date >= ? AND date <= ? ORDER BY date ASC',
      [startDate, endDate]
    );
    const map = new Map<string, DailyStats>();
    for (const row of rows) {
      map.set(row.date, {
        date: row.date,
        foregroundMs: Number(row.foreground_ms),
        backgroundMs: Number(row.background_ms),
        shadowingCount: Number(row.shadowing_count),
      });
    }
    // 2. 填充没数据的日期(柱状图 30 天不能有空洞)
    const dates: string[] = [];
    const start = new Date(startDate + 'T00:00:00');
    const end = new Date(endDate + 'T00:00:00');
    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, '0');
      const day = String(d.getDate()).padStart(2, '0');
      dates.push(`${y}-${m}-${day}`);
    }
    return dates.map((date) => map.get(date) ?? { date, foregroundMs: 0, backgroundMs: 0, shadowingCount: 0 });
  } catch (e) {
    console.warn('[stats/storage] readDailyStats failed:', e);
    return [];
  }
}

// ── 绝对值写入(供 sync 层用) ────────────────────────

export async function writeVideoStatsIfMissing(stats: VideoStats): Promise<boolean> {
  // 仅在本地不存在该 videoId 时写入。返回 true 表示新写入,false 表示已存在跳过
  if (inMemoryVideo.has(stats.videoId)) return false;
  try {
    const db = await getDatabase();
    const existing = await db.getFirstAsync(
      'SELECT video_id FROM video_stats WHERE video_id = ?',
      [stats.videoId]
    );
    if (existing) {
      inMemoryVideo.set(stats.videoId, stats);
      return false;
    }
    await setVideoStatsAbsolute(stats);
    inMemoryVideo.set(stats.videoId, stats);
    return true;
  } catch (e) {
    console.warn('[stats/storage] writeVideoStatsIfMissing failed:', stats.videoId, e);
    return false;
  }
}

export async function writeDailyStatsIfMissing(stats: DailyStats): Promise<boolean> {
  if (inMemoryDaily.has(stats.date)) return false;
  try {
    const db = await getDatabase();
    const existing = await db.getFirstAsync(
      'SELECT date FROM daily_stats WHERE date = ?',
      [stats.date]
    );
    if (existing) {
      inMemoryDaily.set(stats.date, stats);
      return false;
    }
    await setDailyStatsAbsolute(stats);
    inMemoryDaily.set(stats.date, stats);
    return true;
  } catch (e) {
    console.warn('[stats/storage] writeDailyStatsIfMissing failed:', stats.date, e);
    return false;
  }
}

// ── Flush 机制 ───────────────────────────────────────

function scheduleFlush(): void {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flush().catch((e) => console.warn('[stats/storage] flush failed:', e));
  }, FLUSH_INTERVAL_MS);
}

export async function flush(): Promise<void> {
  if (flushInFlight) return flushInFlight;
  flushInFlight = doFlush().finally(() => {
    flushInFlight = null;
  });
  return flushInFlight;
}

async function flushIfPending(): Promise<void> {
  if (videoBuffer.size > 0 || dailyBuffer.size > 0 || flushTimer) {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    await flush();
  }
}

async function doFlush(): Promise<void> {
  const videosToWrite = Array.from(videoBuffer.entries());
  const dailiesToWrite = Array.from(dailyBuffer.entries());
  if (videosToWrite.length === 0 && dailiesToWrite.length === 0) return;

  videoBuffer.clear();
  dailyBuffer.clear();

  try {
    if (videosToWrite.length > 0) {
      // 串行 UPSERT(SQLite 单连接,本质就是串行的)
      for (const [, stats] of videosToWrite) {
        await upsertVideoStats(stats);
      }
    }
    if (dailiesToWrite.length > 0) {
      for (const [, stats] of dailiesToWrite) {
        await upsertDailyStats(stats);
      }
    }
  } catch (e) {
    console.warn('[stats/storage] doFlush failed:', e);
    // 失败时把数据放回 buffer,下次重试
    for (const [id, stats] of videosToWrite) {
      const existing = videoBuffer.get(id);
      if (!existing) videoBuffer.set(id, stats);
    }
    for (const [date, stats] of dailiesToWrite) {
      const existing = dailyBuffer.get(date);
      if (!existing) dailyBuffer.set(date, stats);
    }
  }
}

// ── 测试/调试用:清空本地统计 ─────────────────────────

export async function clearAllStats(): Promise<void> {
  const db = await getDatabase();
  await db.runAsync('DELETE FROM video_stats');
  await db.runAsync('DELETE FROM daily_stats');
  inMemoryVideo.clear();
  inMemoryDaily.clear();
  videoBuffer.clear();
  dailyBuffer.clear();
}

// ── 导出 today 辅助 ───────────────────────────────────

export { todayLocalDate };
