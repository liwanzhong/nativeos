/**
 * User-picked video series ("我的跟练") API.
 *
 * Wraps the four mutations the videos tab needs:
 *   - pickSeries      : add an official series to "我的跟练"
 *   - unpickSeries    : remove it
 *   - pinSeries       : toggle the pin flag (sort key in "我的跟练")
 *   - touchLastPracticed : bump last_practiced_at when user starts a video
 *
 * Plus a couple of read helpers reused by the AI practice home.
 *
 * All mutations are RLS-gated: auth.uid() must equal row.user_id.
 * On any error we surface it; on success we invalidate the
 * in-memory caches so the next read pulls fresh data.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { supabase } from '../supabase';
import {
  loadMyPickedSeriesFromSupabase,
  loadMyPickedSeriesIdSet,
  type PickedSeriesDetail,
} from './video-series-supabase';

const USER_PICKED_LOG_PREFIX = '[UserPickedSeries]';
// 2026-08-17: 未登录时把 picked 存到 AsyncStorage (per-device). 登录后保留 (后续
// 想做 "登录时把 local 合并到 supabase" 的迁移时, 只需读这个 key).
const LOCAL_PICKED_KEY = 'local_picked_video_series_v1';

function logPickedTrace(message: string, payload?: unknown) {
  if (payload === undefined) {
    console.log(`${USER_PICKED_LOG_PREFIX} ${message}`);
    return;
  }
  console.log(`${USER_PICKED_LOG_PREFIX} ${message}`, payload);
}

function warnPickedTrace(message: string, payload?: unknown) {
  if (payload === undefined) {
    console.warn(`${USER_PICKED_LOG_PREFIX} ${message}`);
    return;
  }
  console.warn(`${USER_PICKED_LOG_PREFIX} ${message}`, payload);
}

export class NotSignedInError extends Error {
  constructor() {
    super('请先登录后再添加跟练视频');
    this.name = 'NotSignedInError';
  }
}

function ensureSessionUserId(userId: string | null | undefined): string {
  if (!userId) {
    throw new NotSignedInError();
  }
  return userId;
}

// ── Local picked store (per-device, used when signed-out) ───────

export async function loadLocalPickedIds(): Promise<Set<string>> {
  try {
    const raw = await AsyncStorage.getItem(LOCAL_PICKED_KEY);
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    return new Set(Array.isArray(arr) ? arr.filter((s) => typeof s === 'string') : []);
  } catch {
    return new Set();
  }
}

async function saveLocalPickedIds(set: Set<string>): Promise<void> {
  try {
    await AsyncStorage.setItem(LOCAL_PICKED_KEY, JSON.stringify(Array.from(set)));
  } catch (e) {
    warnPickedTrace('saveLocalPickedIds failed', { error: String(e) });
  }
}

// ── Reads ──────────────────────────────────────────────────────────

export async function listMyPickedSeries(
  forceRefresh: boolean = false,
): Promise<PickedSeriesDetail[]> {
  // 2026-08-17: 未登录时 supabase 返回空, 也返回 local 的 (虽然 local 不会
  // 有 series detail, 只有 ids — caller 看场景怎么用).
  const { data: { user } } = await supabase.auth.getUser();
  if (!user?.id) {
    return [];
  }
  return loadMyPickedSeriesFromSupabase(forceRefresh);
}

export async function listMyPickedSeriesIds(): Promise<Set<string>> {
  // 2026-08-17: 合并 supabase + AsyncStorage local. 登录看 supabase, 未登录
  // 看 local; 双登录状态 (signed-in + local) 都返回合并 set.
  const remote = await loadMyPickedSeriesIdSet();
  const local = await loadLocalPickedIds();
  const merged = new Set<string>(remote);
  for (const id of local) merged.add(id);
  return merged;
}

// ── Mutations ──────────────────────────────────────────────────────

/**
 * Add a series to the user's "我的跟练" set.
 *
 * Idempotent: if the row already exists, this is a no-op (the unique
 * index on (user_id, series_id) means a duplicate insert would error,
 * so we treat that as success).
 *
 * 2026-08-17: 未登录时把 seriesId 加到 AsyncStorage (per-device). 登录后
 * 走 supabase. listMyPickedSeriesIds() 会自动合并两边.
 */
export async function pickSeries(seriesId: string): Promise<void> {
  if (!seriesId || !seriesId.trim()) {
    throw new Error('seriesId 不能为空');
  }
  const sid = seriesId.trim();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user?.id) {
    const local = await loadLocalPickedIds();
    if (!local.has(sid)) {
      local.add(sid);
      await saveLocalPickedIds(local);
    }
    logPickedTrace('pickSeries local (signed-out)', { seriesId: sid });
    return;
  }
  const userId = user.id;

  const { error } = await supabase
    .from('user_picked_video_series')
    .insert({ user_id: userId, series_id: sid });

  if (error) {
    // Duplicate key → already picked. Treat as success.
    if (error.code === '23505' || /duplicate key/i.test(error.message)) {
      logPickedTrace('pickSeries noop (already picked)', { seriesId: sid, userId });
      return;
    }
    warnPickedTrace('pickSeries failed', { seriesId: sid, userId, error: error.message });
    throw new Error(`加入跟练失败：${error.message}`);
  }
  logPickedTrace('pickSeries success', { seriesId: sid, userId });
}

/**
 * Remove a series from the user's "我的跟练" set.
 * No-op if the row doesn't exist.
 */
export async function unpickSeries(seriesId: string): Promise<void> {
  if (!seriesId || !seriesId.trim()) return;
  const sid = seriesId.trim();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user?.id) {
    const local = await loadLocalPickedIds();
    if (local.delete(sid)) {
      await saveLocalPickedIds(local);
    }
    logPickedTrace('unpickSeries local (signed-out)', { seriesId: sid });
    return;
  }
  const userId = user.id;

  const { error } = await supabase
    .from('user_picked_video_series')
    .delete()
    .eq('user_id', userId)
    .eq('series_id', sid);

  if (error) {
    warnPickedTrace('unpickSeries failed', { seriesId: sid, userId, error: error.message });
    throw new Error(`移除跟练失败：${error.message}`);
  }
  logPickedTrace('unpickSeries success', { seriesId: sid, userId });
}

/**
 * Toggle the pin flag on a picked series. Pin = "always at the top
 * of 我的跟练". Returns the new pinned state.
 */
export async function pinSeries(seriesId: string, nextPinned: boolean): Promise<void> {
  if (!seriesId || !seriesId.trim()) {
    throw new Error('seriesId 不能为空');
  }
  const { data: { user } } = await supabase.auth.getUser();
  const userId = ensureSessionUserId(user?.id);

  const { error } = await supabase
    .from('user_picked_video_series')
    .update({ is_pinned: nextPinned })
    .eq('user_id', userId)
    .eq('series_id', seriesId.trim());

  if (error) {
    warnPickedTrace('pinSeries failed', { seriesId, userId, error: error.message });
    throw new Error(`更新置顶状态失败：${error.message}`);
  }
  logPickedTrace('pinSeries success', { seriesId, userId, nextPinned });
}

/**
 * Bump `last_practiced_at = now()` for a picked series. Called from
 * the video detail page when the user starts a video.
 *
 * Fire-and-forget friendly: we never throw, just log on error.
 */
export async function touchSeriesLastPracticed(seriesId: string): Promise<void> {
  if (!seriesId || !seriesId.trim()) return;
  try {
    const { data: { user } } = await supabase.auth.getUser();
    const userId = user?.id;
    if (!userId) return;

    const { error } = await supabase
      .from('user_picked_video_series')
      .update({ last_practiced_at: new Date().toISOString() })
      .eq('user_id', userId)
      .eq('series_id', seriesId.trim());

    if (error) {
      warnPickedTrace('touchSeriesLastPracticed failed', {
        seriesId,
        userId,
        error: error.message,
      });
    }
  } catch (err) {
    warnPickedTrace('touchSeriesLastPracticed threw', {
      seriesId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
