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

import { supabase } from '../supabase';
import {
  loadMyPickedSeriesFromSupabase,
  loadMyPickedSeriesIdSet,
  type PickedSeriesDetail,
} from './video-series-supabase';

const USER_PICKED_LOG_PREFIX = '[UserPickedSeries]';

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

// ── Reads ──────────────────────────────────────────────────────────

export async function listMyPickedSeries(
  forceRefresh: boolean = false,
): Promise<PickedSeriesDetail[]> {
  return loadMyPickedSeriesFromSupabase(forceRefresh);
}

export async function listMyPickedSeriesIds(): Promise<Set<string>> {
  return loadMyPickedSeriesIdSet();
}

// ── Mutations ──────────────────────────────────────────────────────

/**
 * Add a series to the user's "我的跟练" set.
 *
 * Idempotent: if the row already exists, this is a no-op (the unique
 * index on (user_id, series_id) means a duplicate insert would error,
 * so we treat that as success).
 */
export async function pickSeries(seriesId: string): Promise<void> {
  if (!seriesId || !seriesId.trim()) {
    throw new Error('seriesId 不能为空');
  }
  // We don't read the user from supabase.auth.getUser() each call —
  // that's a network round-trip. Instead, the first insert will hit
  // RLS and fail with a clear error if we're not signed in.
  const { data: { user } } = await supabase.auth.getUser();
  const userId = ensureSessionUserId(user?.id);

  const { error } = await supabase
    .from('user_picked_video_series')
    .insert({ user_id: userId, series_id: seriesId.trim() });

  if (error) {
    // Duplicate key → already picked. Treat as success.
    if (error.code === '23505' || /duplicate key/i.test(error.message)) {
      logPickedTrace('pickSeries noop (already picked)', { seriesId, userId });
      return;
    }
    warnPickedTrace('pickSeries failed', { seriesId, userId, error: error.message });
    throw new Error(`加入跟练失败：${error.message}`);
  }
  logPickedTrace('pickSeries success', { seriesId, userId });
}

/**
 * Remove a series from the user's "我的跟练" set.
 * No-op if the row doesn't exist.
 */
export async function unpickSeries(seriesId: string): Promise<void> {
  if (!seriesId || !seriesId.trim()) return;

  const { data: { user } } = await supabase.auth.getUser();
  const userId = ensureSessionUserId(user?.id);

  const { error } = await supabase
    .from('user_picked_video_series')
    .delete()
    .eq('user_id', userId)
    .eq('series_id', seriesId.trim());

  if (error) {
    warnPickedTrace('unpickSeries failed', { seriesId, userId, error: error.message });
    throw new Error(`移除跟练失败：${error.message}`);
  }
  logPickedTrace('unpickSeries success', { seriesId, userId });
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
