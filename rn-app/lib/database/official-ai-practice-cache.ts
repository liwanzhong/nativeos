/**
 * Local SQLite cache for the Supabase `official_video_ai_practice` rows.
 *
 * Why this exists:
 *   The recommend page (add-recommended.tsx) needs practice cards for
 *   every episode in the user's "我的合集". The naive path is one
 *   Supabase round-trip per episode (N+ round-trips per page load).
 *   The right path is: pull the published cards once, store them here,
 *   and serve subsequent lookups from disk.
 *
 * Lifetime:
 *   - TTL is enforced by the *caller* (loadCachedAiCardsBySeriesIds +
 *     getLatestFetchedAt) — this module just stores rows + their
 *     `fetched_at` timestamp.
 *   - `invalidateAiCardsCache()` clears the table (used by
 *     pull-to-refresh or admin actions).
 *
 * Concurrency:
 *   - Reads use simple SELECT … WHERE series_id IN (...) — concurrent
 *     with writes thanks to WAL mode (set in schema.ts).
 *   - Writes do `DELETE + INSERT` inside a single transaction so the
 *     table is always internally consistent.
 */

import { getDatabase } from './schema';
import type { SupabaseAiPracticeRow } from '../content/video-series-supabase';

const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h — official content is stable

/**
 * Bulk-fetch all cached rows for a set of series. Returns a map keyed
 * by seriesId (only series with at least one cached row appear in the
 * map; empty series are omitted, NOT mapped to []).
 *
 * Used by the recommend page: it gets back everything it needs
 * without an async waterfall.
 */
export async function loadCachedAiCardsBySeriesIds(
  seriesIds: string[],
): Promise<Map<string, SupabaseAiPracticeRow[]>> {
  const result = new Map<string, SupabaseAiPracticeRow[]>();
  if (seriesIds.length === 0) return result;
  const db = await getDatabase();
  const placeholders = seriesIds.map(() => '?').join(',');
  const rows: any[] = await db.getAllAsync(
    `SELECT id, series_id, episode_id, card_index, card_json
       FROM official_ai_practice_card_cache
      WHERE series_id IN (${placeholders})
      ORDER BY series_id, episode_id, card_index ASC`,
    seriesIds,
  );
  for (const row of rows) {
    let parsed: SupabaseAiPracticeRow;
    try {
      parsed = JSON.parse(row.card_json) as SupabaseAiPracticeRow;
    } catch {
      continue;
    }
    const bucket = result.get(row.series_id);
    if (bucket) {
      bucket.push(parsed);
    } else {
      result.set(row.series_id, [parsed]);
    }
  }
  return result;
}

/**
 * Return the set of `series_id` values that currently have at least one
 * cached row. Used as a fallback for "未登录" / "没挑合集" callers:
 * the recommend page can show topics from these series even when
 * the user hasn't picked anything yet.
 */
export async function loadCachedAiCardsSeriesIds(): Promise<Set<string>> {
  const db = await getDatabase();
  const rows: any[] = await db.getAllAsync(
    'SELECT DISTINCT series_id FROM official_ai_practice_card_cache',
  );
  return new Set(rows.map((r) => String(r.series_id)).filter((id) => id.length > 0));
}

/**
 * Used by the caller to decide whether to re-fetch from Supabase.
 * Returns the most recent `fetched_at` across all rows, or null when
 * the table is empty.
 */
export async function getLatestAiCardsFetchedAt(): Promise<number | null> {
  const db = await getDatabase();
  const row: any = await db.getFirstAsync(
    'SELECT MAX(fetched_at) AS latest FROM official_ai_practice_card_cache',
  );
  const v = row?.latest;
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

export function isAiCardsCacheStale(latestFetchedAt: number | null, now: number = Date.now()): boolean {
  if (latestFetchedAt == null) return true;
  return now - latestFetchedAt > CACHE_TTL_MS;
}

/**
 * Replace the cache contents with a fresh batch of rows. The whole
 * swap is one transaction so partial writes are never visible.
 *
 * Mirrors the proven pattern in
 * `lib/database/video-ai-practice.ts::saveGeneratedVideoAiPracticeCards`:
 * a `BEGIN`/`COMMIT` wrapper around a DELETE followed by a serial
 * `for` loop of `db.runAsync` calls. We do NOT use a multi-row VALUES
 * clause (`runAsync` parameter binding was producing `UNIQUE
 * constraint failed` on some Android emulator builds, even on a
 * freshly-DELETED table), and we do NOT use a `prepareAsync` +
 * `executeAsync` loop (`NativeStatement.finalizeAsync` is not
 * strictly serial under load, so the loop's `await`s don't guarantee
 * statement order in the underlying native code).
 *
 * 2026-08-17: the table's PRIMARY KEY is now (series_id, id) — the
 * upstream Supabase `official_video_ai_practice` table has 35
 * duplicate `id` values across different series, so an `id`-only PK
 * (v6) was silently overwriting earlier series' rows on REPLACE.
 * With the composite key, `INSERT OR REPLACE` is correct: REPLACE
 * only kicks in if the *same* (series_id, id) appears twice in the
 * batch (defensive), and cross-series duplicates coexist as distinct
 * rows.
 *
 * Pass an empty array to wipe the cache (used by invalidate).
 */
export async function replaceAiCardsCache(rows: SupabaseAiPracticeRow[]): Promise<void> {
  const db = await getDatabase();
  const now = Date.now();
  await db.execAsync('BEGIN');
  try {
    await db.runAsync('DELETE FROM official_ai_practice_card_cache');
    for (const row of rows) {
      if (!row.id || !row.series_id || !row.episode_id) continue;
      await db.runAsync(
        `INSERT OR REPLACE INTO official_ai_practice_card_cache
           (id, series_id, episode_id, card_index, card_json, fetched_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          row.id,
          row.series_id,
          row.episode_id,
          row.card_index ?? 0,
          JSON.stringify(row),
          now,
        ],
      );
    }
    await db.execAsync('COMMIT');
  } catch (e) {
    try { await db.execAsync('ROLLBACK'); } catch { /* ignore */ }
    throw e;
  }
}

/**
 * Invalidate the cache. Used by pull-to-refresh.
 */
export async function invalidateAiCardsCache(): Promise<void> {
  await replaceAiCardsCache([]);
}

export { CACHE_TTL_MS as AI_CARDS_CACHE_TTL_MS };
