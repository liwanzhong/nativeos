/**
 * Supabase data source for official video series + user-picked series
 * + per-series episodes.
 *
 * Replaces the OSS-hosted `official-video-catalog.json` with a Supabase
 * table (series metadata) and `official_video_episodes` (per-video
 * list). See `supabase/migrations/20260106_official_video_series.sql`
 * and `20260108_official_video_episodes.sql`.
 *
 * Layering:
 *   - `loadPublishedSeriesFromSupabase()`  : reads the public catalog
 *   - `loadMyPickedSeriesFromSupabase()`   : reads the user's "我的跟练" set
 *   - `loadSeriesEpisodesFromSupabase(seriesId)` : reads the per-series
 *     episode list (replaces the OSS-hosted series.json fetch)
 *   - `loadSeriesManifestFromOss(manifestUrl)`  : kept for back-compat
 *     during the transition; new callers should use
 *     `loadSeriesEpisodesFromSupabase` instead.
 *
 * Failure mode: every function returns a typed empty result on error
 * (never throws) so callers can fall back to the OSS-only path. We
 * never want a Supabase outage to take down the videos tab.
 */

import { supabase } from '../supabase';

// ── Row shapes (mirror the SQL schema) ─────────────────────────────

export interface SupabaseSeriesRow {
  id: string;
  title: string;
  level: string;
  category: string;
  type: string;
  description: string | null;
  cover_url: string | null;
  tags: string[];
  sort_order: number;
  manifest_url: string;
  resource_base_url: string | null;
  is_published: boolean;
  updated_at: string;
}

export interface SupabasePickedRow {
  id: number;
  user_id: string;
  series_id: string;
  picked_at: string;
  last_practiced_at: string | null;
  is_pinned: boolean;
}

export interface PickedSeriesDetail {
  row: SupabasePickedRow;
  series: SupabaseSeriesRow | null; // null if the series was soft-deleted
}

const SERIES_LOG_PREFIX = '[VideoSeriesSupabase]';

function logSupabaseTrace(message: string, payload?: unknown) {
  if (payload === undefined) {
    console.log(`${SERIES_LOG_PREFIX} ${message}`);
    return;
  }
  console.log(`${SERIES_LOG_PREFIX} ${message}`, payload);
}

function warnSupabaseTrace(message: string, payload?: unknown) {
  if (payload === undefined) {
    console.warn(`${SERIES_LOG_PREFIX} ${message}`);
    return;
  }
  console.warn(`${SERIES_LOG_PREFIX} ${message}`, payload);
}

// ── Public catalog ─────────────────────────────────────────────────

/**
 * Read all `is_published = true` rows from `official_video_series`.
 * Returns `[]` on any error — caller should fall back to OSS.
 */
export async function loadPublishedSeriesFromSupabase(
  forceRefresh: boolean = false,
  pagination?: { limit: number; offset: number; level?: string | null },
): Promise<SupabaseSeriesRow[]> {
  try {
    // No long-lived cache here — the caller (video-series.ts) owns the
    // in-memory cache keyed by forceRefresh. We just hit Supabase each
    // cold call. Supabase PostgREST responses are HTTP-cacheable, so
    // a warm network layer will short-circuit if the row hasn't changed.
    // 2026-08-21: 加分页参数, library 页面用数据库端 .range() 一次只取一页,
    // 避免 series 多的时候一次性拉全表 + N+1 拉 manifest 慢。
    let query = supabase
      .from('official_video_series')
      .select('id, title, level, category, type, description, cover_url, tags, sort_order, manifest_url, resource_base_url, is_published, updated_at')
      .eq('is_published', true);
    if (pagination?.level) {
      // 把 level 推到 server 端, 跟分页一起工作, 切 A1 时一次就只返 A1 系列
      query = query.eq('level', pagination.level);
    }
    query = query
      .order('sort_order', { ascending: true })
      .order('title', { ascending: true });
    if (pagination) {
      // Supabase .range 是闭区间 [from, to], 需要 offset + limit - 1
      const to = pagination.offset + pagination.limit - 1;
      query = query.range(pagination.offset, to);
    }

    const { data, error } = await query;

    if (error) {
      warnSupabaseTrace('loadPublishedSeries failed', { error: error.message });
      return [];
    }
    const rows = (data ?? []) as SupabaseSeriesRow[];
    logSupabaseTrace('loadPublishedSeries success', {
      count: rows.length,
      forceRefresh,
      pagination,
    });
    return rows;
  } catch (err) {
    warnSupabaseTrace('loadPublishedSeries threw', {
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

/**
 * 2026-08-21: library 页面分页用, 取 published series 总数, 用来判断 hasMore。
 * 用 `count: 'exact'` + `head: true` 走 HEAD-style 请求, 只取 count 不取行,
 * 避免下载完整表。
 */
export async function countPublishedSeries(level?: string | null): Promise<number> {
  try {
    let query = supabase
      .from('official_video_series')
      .select('id', { count: 'exact', head: true })
      .eq('is_published', true);
    if (level) {
      query = query.eq('level', level);
    }
    const { count, error } = await query;
    if (error) {
      warnSupabaseTrace('countPublishedSeries failed', { error: error.message });
      return 0;
    }
    return count ?? 0;
  } catch (err) {
    warnSupabaseTrace('countPublishedSeries threw', {
      error: err instanceof Error ? err.message : String(err),
    });
    return 0;
  }
}

// ── User-picked series ─────────────────────────────────────────────

/**
 * Read all series the current user has picked, joined with the
 * series metadata. Returns `[]` if the user is not signed in or
 * on any error. RLS guarantees we only see our own rows.
 */
export async function loadMyPickedSeriesFromSupabase(
  forceRefresh: boolean = false,
): Promise<PickedSeriesDetail[]> {
  try {
    const { data, error } = await supabase
      .from('user_picked_video_series')
      .select(`
        id, user_id, series_id, picked_at, last_practiced_at, is_pinned,
        series:official_video_series (
          id, title, level, category, type, description, cover_url,
          tags, sort_order, manifest_url, resource_base_url,
          is_published, updated_at
        )
      `)
      .order('is_pinned', { ascending: false })
      .order('picked_at', { ascending: false });

    if (error) {
      warnSupabaseTrace('loadMyPickedSeries failed', { error: error.message });
      return [];
    }

    const rows = (data ?? []) as Array<SupabasePickedRow & {
      series: SupabaseSeriesRow | SupabaseSeriesRow[] | null;
    }>;

    const result: PickedSeriesDetail[] = rows.map((row) => {
      // PostgREST returns a single joined row as object, multiple as array.
      // 1-to-1 FK always returns object here, but defend against [].
      const joined = Array.isArray(row.series) ? row.series[0] : row.series;
      return {
        row: {
          id: row.id,
          user_id: row.user_id,
          series_id: row.series_id,
          picked_at: row.picked_at,
          last_practiced_at: row.last_practiced_at,
          is_pinned: row.is_pinned,
        },
        series: joined ?? null,
      };
    });

    logSupabaseTrace('loadMyPickedSeries success', {
      count: result.length,
      forceRefresh,
    });
    return result;
  } catch (err) {
    warnSupabaseTrace('loadMyPickedSeries threw', {
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

/**
 * Quick check: which of the given series ids has the user picked?
 * Returns an empty Set on any error.
 */
export async function loadMyPickedSeriesIdSet(): Promise<Set<string>> {
  try {
    const { data, error } = await supabase
      .from('user_picked_video_series')
      .select('series_id');
    if (error) {
      warnSupabaseTrace('loadMyPickedSeriesIdSet failed', { error: error.message });
      return new Set();
    }
    return new Set((data ?? []).map((r) => (r as { series_id: string }).series_id));
  } catch {
    return new Set();
  }
}

/**
 * Look up a single `official_video_series` row by id, regardless of
 * `is_published` state. The list helpers always filter to published
 * rows; the detail page wants the row even if it's currently
 * unpublished (e.g. an admin previewing).
 *
 * Returns `null` if the row doesn't exist or any error occurs.
 * (Distinct from "0 rows" — both surface as `null` here; the caller
 * shouldn't try to distinguish "soft-deleted" from "unpublished".)
 */
export async function loadSeriesByIdFromSupabase(
  seriesId: string,
): Promise<SupabaseSeriesRow | null> {
  if (!seriesId || !seriesId.trim()) return null;
  try {
    const { data, error } = await supabase
      .from('official_video_series')
      .select('id, title, level, category, type, description, cover_url, tags, sort_order, manifest_url, resource_base_url, is_published, updated_at')
      .eq('id', seriesId)
      .maybeSingle();
    if (error) {
      warnSupabaseTrace('loadSeriesByIdFromSupabase failed', {
        seriesId,
        error: error.message,
      });
      return null;
    }
    return (data ?? null) as SupabaseSeriesRow | null;
  } catch (err) {
    warnSupabaseTrace('loadSeriesByIdFromSupabase threw', {
      seriesId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Look up a single `official_video_episodes` row by its primary key
 * `(series_id, id)`. Both fields are required because the table uses
 * a composite primary key — using `eq('id', ...)` alone would return
 * 0 rows for any episode whose `id` collides across different series.
 *
 * Published filter is NOT applied here: the player is the source of
 * truth for "what's playable", and unpublished episodes shouldn't
 * resolve to a playable scene. Callers that want a hard published-only
 * lookup should add `.eq('is_published', true)` themselves — but
 * since unpublished episodes are unreachable from the UI (the series
 * detail list and the library only show published series), this
 * function is safe to call as-is.
 *
 * Returns `null` if the row doesn't exist or any error occurs.
 */
export async function loadEpisodeByIdFromSupabase(
  episodeId: string,
  seriesId?: string,
): Promise<SupabaseEpisodeRow | null> {
  if (!episodeId || !episodeId.trim()) return null;
  try {
    let query = supabase
      .from('official_video_episodes')
      .select(
        'id, series_id, episode_index, title, level, category, type, source_label, video_file, subtitle_json3_file, info_file, ai_practice_file, subtitle_zh_file, subtitle_en_segmented_file, cover_file, has_roleplay, duration_seconds, is_published',
      )
      .eq('id', episodeId.trim());
    if (seriesId && seriesId.trim()) {
      query = query.eq('series_id', seriesId.trim());
    }
    const { data, error } = await query.maybeSingle();
    if (error) {
      warnSupabaseTrace('loadEpisodeByIdFromSupabase failed', {
        episodeId,
        seriesId,
        error: error.message,
      });
      return null;
    }
    return (data ?? null) as SupabaseEpisodeRow | null;
  } catch (err) {
    warnSupabaseTrace('loadEpisodeByIdFromSupabase threw', {
      episodeId,
      seriesId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Look up the series_id for a given episode id. The player URL only
 * carries the episode id (e.g. `a1-beginner-ep-01`); to compose the
 * full `VideoSceneDetail` we also need the parent series row, which
 * is keyed by `series_id` and carries `manifest_url` (the OSS base
 * for resolving subtitle/cover/AI URLs).
 *
 * This is a cheap narrow fetch: we just project `series_id`. Use
 * `loadEpisodeByIdFromSupabase` to get the full episode row in the
 * same call; this helper exists for callers that need the series_id
 * first (e.g. parallel fetching).
 */
export async function loadEpisodeSeriesIdFromSupabase(
  episodeId: string,
): Promise<string | null> {
  if (!episodeId || !episodeId.trim()) return null;
  try {
    const { data, error } = await supabase
      .from('official_video_episodes')
      .select('series_id')
      .eq('id', episodeId.trim())
      .maybeSingle();
    if (error) {
      warnSupabaseTrace('loadEpisodeSeriesIdFromSupabase failed', {
        episodeId,
        error: error.message,
      });
      return null;
    }
    if (!data) return null;
    return typeof (data as { series_id?: unknown }).series_id === 'string'
      ? (data as { series_id: string }).series_id
      : null;
  } catch (err) {
    warnSupabaseTrace('loadEpisodeSeriesIdFromSupabase threw', {
      episodeId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

// ── AI practice cards (replaces OSS-hosted .ai-practice.json) ────

/**
 * Row shape for `official_video_ai_practice`. Mirrors the SQL schema
 * in `supabase/migrations/20260108_official_video_ai_practice.sql`.
 * The rn-app's `buildSupabaseVideoSceneSummary` maps this to the
 * `ScenarioCard` shape (camelCase, with `description` and `descZh`
 * instead of `description` / `description_zh`).
 */
export interface SupabaseAiPracticeRow {
  id: string;
  series_id: string;
  episode_id: string;
  card_index: number;
  icon: string;
  category: string;
  level: string;
  title: string;
  description: string;
  description_zh: string | null;
  npc_emoji: string | null;
  npc_name: string | null;
  npc_status: string | null;
  npc_system_prompt: string | null;
  opening_line: string | null;
  opening_line_zh: string | null;
  environmental_cue: string | null;
  environmental_cue_en: string | null;
  user_initiates: boolean;
  task_contract: Record<string, unknown> | null;
  is_published: boolean;
}

/**
 * Read all practice cards for an episode from Supabase, ordered by
 * `card_index`. Returns `[]` on any error — callers fall back to
 * the OSS-hosted .ai-practice.json (legacy read-only cache) so a
 * Supabase outage doesn't break the player.
 *
 * Note: we do NOT apply the `is_published` filter here, because the
 * desktop admin only writes published cards. The RLS policy on
 * the table restricts anon/authed reads to published rows; service_role
 * (the desktop admin) sees everything. Since the rn-app reads
 * through the anon client, RLS already enforces visibility.
 */
export async function listAiPracticeCardsFromSupabase(
  seriesId: string,
  episodeId: string,
): Promise<SupabaseAiPracticeRow[]> {
  if (!seriesId || !episodeId) return [];
  try {
    const { data, error } = await supabase
      .from('official_video_ai_practice')
      .select(
        'id, series_id, episode_id, card_index, icon, category, level, title, description, description_zh, npc_emoji, npc_name, npc_status, npc_system_prompt, opening_line, opening_line_zh, environmental_cue, environmental_cue_en, user_initiates, task_contract, is_published',
      )
      .eq('series_id', seriesId)
      .eq('episode_id', episodeId)
      .order('card_index', { ascending: true });
    if (error) {
      warnSupabaseTrace('listAiPracticeCardsFromSupabase failed', {
        seriesId,
        episodeId,
        error: error.message,
      });
      return [];
    }
    return (data ?? []) as SupabaseAiPracticeRow[];
  } catch (err) {
    warnSupabaseTrace('listAiPracticeCardsFromSupabase threw', {
      seriesId,
      episodeId,
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

/**
 * Bulk-fetch every published AI practice card, ordered by
 * `(series_id, episode_id, card_index)`. Used by the local SQLite
 * cache to refresh `official_ai_practice_card_cache` in one round-trip
 * instead of N (one per episode). Returns `[]` on any error so the
 * caller can keep serving stale cache.
 */
export async function listAllPublishedAiPracticeCardsFromSupabase(): Promise<SupabaseAiPracticeRow[]> {
  try {
    const { data, error } = await supabase
      .from('official_video_ai_practice')
      .select(
        'id, series_id, episode_id, card_index, icon, category, level, title, description, description_zh, npc_emoji, npc_name, npc_status, npc_system_prompt, opening_line, opening_line_zh, environmental_cue, environmental_cue_en, user_initiates, task_contract, is_published',
      )
      .eq('is_published', true)
      .order('series_id', { ascending: true })
      .order('episode_id', { ascending: true })
      .order('card_index', { ascending: true });
    if (error) {
      warnSupabaseTrace('listAllPublishedAiPracticeCardsFromSupabase failed', {
        error: error.message,
      });
      return [];
    }
    return (data ?? []) as SupabaseAiPracticeRow[];
  } catch (err) {
    warnSupabaseTrace('listAllPublishedAiPracticeCardsFromSupabase threw', {
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

// ── OSS series manifest (heavy file list still on OSS) ─────────────

export interface RawSeriesManifest {
  version?: number;
  updatedAt?: string;
  resourceBaseUrl?: string;
  series?: {
    id?: string;
    title?: string;
    level?: string;
    category?: string;
    type?: string;
    description?: string;
    coverUrl?: string;
    tags?: string[];
    sortOrder?: number;
    sourceLabel?: string;
  };
  episodes?: Array<{
    id?: string;
    episodeIndex?: number;
    episodeTitle?: string;
    title?: string;
    level?: string;
    category?: string;
    type?: string;
    sourceLabel?: string;
    coverUrl?: string;
    hasRoleplay?: boolean;
    taskContract?: any;
    assets?: {
      video?: string;
      subtitleJson3?: string;
      subtitleEnSegmented?: string;
      subtitleZh?: string;
      info?: string;
      aiPractice?: string;
    };
  }>;
}

/**
 * Fetch the per-series manifest from OSS. Mirrors the network call
 * `video-scenes.ts::getOssManifest` already does internally — but
 * we expose it so the Supabase-driven path can reuse the same fetch
 * semantics (URL builder, cache-bust, etc.).
 */

/**
 * Resolve a series cover URL from a Supabase row's `cover_url` and
 * `manifest_url`. The `cover_url` field stores a bare filename
 * (e.g. `"00 - A1 Beginner English.jpg"`) — the full URL has to
 * be reconstructed by stripping the manifest's basename from
 * `manifest_url` and appending the encoded cover path. If the
 * cover path is already an absolute URL it's returned as-is.
 *
 * Why this lives in `video-series-supabase.ts`: the row shape
 * (`SupabaseSeriesRow`) is the canonical contract, and both the
 * home-page list and the library list read from it. Keeping the
 * resolution here means there's exactly one place to update if
 * the storage layout ever changes (e.g. to a full URL or to
 * per-bucket base URLs).
 */
export function resolveSeriesCoverUrl(
  manifestUrl: string | null | undefined,
  coverPath: string | null | undefined,
): string | undefined {
  if (!coverPath || !coverPath.trim()) return undefined;
  const trimmed = coverPath.trim();
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (!manifestUrl) return undefined;
  const baseUrl = manifestUrl.split('?')[0].split('/').slice(0, -1).join('/');
  const normalizedKey = trimmed.replace(/^\/+/, '');
  const encoded = normalizedKey
    .split('/')
    .map((part) => encodeURIComponent(part))
    .join('/');
  return `${baseUrl}/${encoded}`;
}

/**
 * Resolve an episode-level asset URL (subtitle, cover, ai-practice,
 * info json) from a bare filename stored in `official_video_episodes`.
 *
 * Same logic as `resolveSeriesCoverUrl` — the only difference is
 * what column the bare filename came from. The series-level
 * `manifest_url` is the OSS base; the bare filename is appended.
 * Returns undefined if either side is empty.
 */
export function resolveEpisodeAssetUrl(
  manifestUrl: string | null | undefined,
  assetPath: string | null | undefined,
): string | undefined {
  if (!assetPath || !assetPath.trim()) return undefined;
  const trimmed = assetPath.trim();
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (!manifestUrl) return undefined;
  return resolveSeriesCoverUrl(manifestUrl, trimmed);
}

export async function loadSeriesManifestFromOss(
  manifestUrl: string,
  cacheBust?: string,
): Promise<RawSeriesManifest | null> {
  if (!manifestUrl || !manifestUrl.trim()) return null;
  try {
    const url = cacheBust
      ? `${manifestUrl}${manifestUrl.includes('?') ? '&' : '?'}t=${encodeURIComponent(cacheBust)}`
      : manifestUrl;
    const resp = await fetch(url, { cache: 'no-store' });
    if (!resp.ok) {
      warnSupabaseTrace('loadSeriesManifestFromOss failed', {
        manifestUrl,
        status: resp.status,
      });
      return null;
    }
    return (await resp.json()) as RawSeriesManifest;
  } catch (err) {
    warnSupabaseTrace('loadSeriesManifestFromOss threw', {
      manifestUrl,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

// ── official_video_episodes (replaces the OSS series.json fetch) ────

/**
 * Row shape returned from `official_video_episodes`. Only the fields
 * the rn-app needs to resolve asset URLs + display the episode list;
 * the rest of the columns stay in Supabase and are not pulled over
 * the wire.
 */
export interface SupabaseEpisodeRow {
  id: string;
  series_id: string;
  episode_index: number;
  title: string;
  level: string;
  category: string;
  type: string;
  source_label: string;
  video_file: string;
  subtitle_json3_file: string | null;
  info_file: string | null;
  ai_practice_file: string | null;
  subtitle_zh_file: string | null;
  subtitle_en_segmented_file: string | null;
  cover_file: string | null;
  has_roleplay: boolean;
  duration_seconds: number | null;
  is_published: boolean;
}

/**
 * Read all (published) episodes for a series, ordered by episode_index.
 * Returns [] on any error — callers treat absence as "no episodes
 * known" rather than crashing the page.
 */
export async function loadSeriesEpisodesFromSupabase(
  seriesId: string,
): Promise<SupabaseEpisodeRow[]> {
  if (!seriesId || !seriesId.trim()) return [];
  try {
    const { data, error } = await supabase
      .from('official_video_episodes')
      .select(
        'id, series_id, episode_index, title, level, category, type, source_label, video_file, subtitle_json3_file, info_file, ai_practice_file, subtitle_zh_file, subtitle_en_segmented_file, cover_file, has_roleplay, duration_seconds, is_published',
      )
      .eq('series_id', seriesId)
      .eq('is_published', true)
      .order('episode_index', { ascending: true });
    if (error) {
      warnSupabaseTrace('loadSeriesEpisodesFromSupabase failed', {
        seriesId,
        error: error.message,
      });
      return [];
    }
    return (data ?? []) as SupabaseEpisodeRow[];
  } catch (err) {
    warnSupabaseTrace('loadSeriesEpisodesFromSupabase threw', {
      seriesId,
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

/**
 * Batch variant: one round-trip for many series. Returns a Map
 * keyed by series_id. Series with zero episodes are absent from
 * the map (caller can default to []).
 */
export async function loadEpisodesForSeriesBatch(
  seriesIds: ReadonlyArray<string>,
): Promise<Map<string, SupabaseEpisodeRow[]>> {
  const result = new Map<string, SupabaseEpisodeRow[]>();
  const ids = seriesIds.filter((id) => id && id.trim());
  if (ids.length === 0) return result;
  try {
    const { data, error } = await supabase
      .from('official_video_episodes')
      .select(
        'id, series_id, episode_index, title, level, category, type, source_label, video_file, subtitle_json3_file, info_file, ai_practice_file, subtitle_zh_file, subtitle_en_segmented_file, cover_file, has_roleplay, duration_seconds, is_published',
      )
      .in('series_id', ids)
      .eq('is_published', true)
      .order('episode_index', { ascending: true });
    if (error) {
      warnSupabaseTrace('loadEpisodesForSeriesBatch failed', {
        count: ids.length,
        error: error.message,
      });
      return result;
    }
    for (const row of (data ?? []) as SupabaseEpisodeRow[]) {
      const list = result.get(row.series_id) ?? [];
      list.push(row);
      result.set(row.series_id, list);
    }
    return result;
  } catch (err) {
    warnSupabaseTrace('loadEpisodesForSeriesBatch threw', {
      count: ids.length,
      error: err instanceof Error ? err.message : String(err),
    });
    return result;
  }
}
