/**
 * User-built collections ("我的合集" — the user-curated half of the
 * "我的合集" home page). The official half is `official_video_series`
 * in Supabase; the abstract union that powers the home page lives in
 * `lib/content/collections.ts`.
 *
 * Why a separate file:
 *   Keeps this module's scope narrow: only CRUD on the user's own
 *   collections. Cross-source joining, episode listing, etc. live in
 *   `collections.ts` so the home page only needs one entry point.
 *
 * Default collection semantics:
 *   - Each user has AT MOST ONE row with `is_default = true` (DB
 *     partial unique index enforces this).
 *   - The default row is created lazily on first import — never at
 *     signup time, because brand-new users don't need it and the
 *     migration would have to back-fill N rows.
 *   - Import flows use `getOrCreateDefaultCollection()` to find it.
 */

import { supabase } from '../supabase';

const USER_COLLECTIONS_LOG_PREFIX = '[UserCollections]';

function logUcTrace(message: string, payload?: unknown) {
  if (payload === undefined) {
    console.log(`${USER_COLLECTIONS_LOG_PREFIX} ${message}`);
    return;
  }
  console.log(`${USER_COLLECTIONS_LOG_PREFIX} ${message}`, payload);
}

function warnUcTrace(message: string, payload?: unknown) {
  if (payload === undefined) {
    console.warn(`${USER_COLLECTIONS_LOG_PREFIX} ${message}`);
    return;
  }
  console.warn(`${USER_COLLECTIONS_LOG_PREFIX} ${message}`, payload);
}

export interface UserCollectionRow {
  id: number;
  user_id: string;
  title: string;
  description: string | null;
  cover_url: string | null;
  is_default: boolean;
  created_at: string;
  updated_at: string;
}

export class NotSignedInError extends Error {
  constructor() {
    super('请先登录后再操作合集');
    this.name = 'NotSignedInError';
  }
}

async function getCurrentUserId(): Promise<string> {
  const { data, error } = await supabase.auth.getUser();
  if (error || !data?.user?.id) {
    throw new NotSignedInError();
  }
  return data.user.id;
}

// ── Reads ──────────────────────────────────────────────────────────

export async function listUserCollections(): Promise<UserCollectionRow[]> {
  try {
    const { data, error } = await supabase
      .from('user_collections')
      .select('id, user_id, title, description, cover_url, is_default, created_at, updated_at')
      .order('is_default', { ascending: false })
      .order('created_at', { ascending: false });

    if (error) {
      warnUcTrace('listUserCollections failed', { error: error.message });
      return [];
    }
    return (data ?? []) as UserCollectionRow[];
  } catch (err) {
    warnUcTrace('listUserCollections threw', {
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

/**
 * Get the user's default collection, or null if they don't have one
 * yet. Does NOT create one — use `getOrCreateDefaultCollection` for
 * the lazy-create path.
 */
export async function getDefaultCollection(): Promise<UserCollectionRow | null> {
  try {
    const { data, error } = await supabase
      .from('user_collections')
      .select('id, user_id, title, description, cover_url, is_default, created_at, updated_at')
      .eq('is_default', true)
      .limit(1);
    if (error) {
      warnUcTrace('getDefaultCollection failed', { error: error.message });
      return null;
    }
    const row = (data ?? [])[0] as UserCollectionRow | undefined;
    return row ?? null;
  } catch (err) {
    warnUcTrace('getDefaultCollection threw', {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Lazy-create path. Returns the default collection, creating it on
 * first call. Always succeeds in returning a row unless the network
 * is down.
 */
export async function getOrCreateDefaultCollection(
  defaultTitle: string = '默认合集',
): Promise<UserCollectionRow> {
  const existing = await getDefaultCollection();
  if (existing) return existing;

  const userId = await getCurrentUserId();
  const { data, error } = await supabase
    .from('user_collections')
    .insert({ user_id: userId, title: defaultTitle, is_default: true })
    .select('id, user_id, title, description, cover_url, is_default, created_at, updated_at')
    .single();

  if (error) {
    // Concurrent inserts: the partial unique index will fail one of
    // them with 23505. Re-read and return whichever row the other
    // caller won.
    if (error.code === '23505' || /duplicate key/i.test(error.message)) {
      const raceWinner = await getDefaultCollection();
      if (raceWinner) {
        logUcTrace('getOrCreateDefaultCollection race resolved', { id: raceWinner.id });
        return raceWinner;
      }
    }
    throw new Error(`创建默认合集失败：${error.message}`);
  }
  logUcTrace('getOrCreateDefaultCollection created', { id: (data as UserCollectionRow).id });
  return data as UserCollectionRow;
}

// ── Mutations ──────────────────────────────────────────────────────

export async function createUserCollection(params: {
  title: string;
  description?: string;
  coverUrl?: string;
}): Promise<UserCollectionRow> {
  const title = (params.title || '').trim();
  if (!title) {
    throw new Error('合集名不能为空');
  }
  const userId = await getCurrentUserId();

  const { data, error } = await supabase
    .from('user_collections')
    .insert({
      user_id: userId,
      title,
      description: params.description?.trim() || null,
      cover_url: params.coverUrl?.trim() || null,
      is_default: false,
    })
    .select('id, user_id, title, description, cover_url, is_default, created_at, updated_at')
    .single();

  if (error) {
    throw new Error(`创建合集失败：${error.message}`);
  }
  logUcTrace('createUserCollection success', { id: (data as UserCollectionRow).id });
  return data as UserCollectionRow;
}

export async function updateUserCollection(
  id: number,
  params: { title?: string; description?: string; coverUrl?: string },
): Promise<void> {
  const patch: Record<string, unknown> = {};
  if (typeof params.title === 'string') {
    const trimmed = params.title.trim();
    if (!trimmed) throw new Error('合集名不能为空');
    patch.title = trimmed;
  }
  if (typeof params.description === 'string') {
    patch.description = params.description.trim() || null;
  }
  if (typeof params.coverUrl === 'string') {
    patch.cover_url = params.coverUrl.trim() || null;
  }
  if (Object.keys(patch).length === 0) return;

  const userId = await getCurrentUserId();
  const { error } = await supabase
    .from('user_collections')
    .update(patch)
    .eq('id', id)
    .eq('user_id', userId);

  if (error) {
    throw new Error(`更新合集失败：${error.message}`);
  }
  logUcTrace('updateUserCollection success', { id, patchKeys: Object.keys(patch) });
}

/**
 * Delete a user collection. If it was the default, the caller should
 * have already moved its videos out (or the user accepts losing the
 * default-collection assignment — videos without a collection will
 * be surfaced under a re-created default on next import).
 */
export async function deleteUserCollection(id: number): Promise<void> {
  const userId = await getCurrentUserId();
  const { error } = await supabase
    .from('user_collections')
    .delete()
    .eq('id', id)
    .eq('user_id', userId);

  if (error) {
    throw new Error(`删除合集失败：${error.message}`);
  }
  logUcTrace('deleteUserCollection success', { id });
}

// ── ID helpers ────────────────────────────────────────────────────

/**
 * Encode a numeric user-collection id as the `collectionId` field
 * value used by `imported_video_packs` / `user_videos`. Format:
 * `"user:<id>"` so it can never collide with an official-series id
 * (which is plain text like `a1-beginner-english`).
 */
export function encodeUserCollectionId(id: number): string {
  return `user:${id}`;
}

/** Inverse of `encodeUserCollectionId`. Returns null if the format is wrong. */
export function decodeUserCollectionId(value: string): number | null {
  if (!value || !value.startsWith('user:')) return null;
  const n = Number(value.slice('user:'.length));
  return Number.isFinite(n) && n > 0 ? n : null;
}
