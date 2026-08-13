/**
 * Supabase data source for official video series + user-picked series.
 *
 * Replaces the OSS-hosted `official-video-catalog.json` with a Supabase
 * table. See `supabase/migrations/20260106_official_video_series.sql`.
 *
 * Layering:
 *   - `loadPublishedSeriesFromSupabase()`  : reads the public catalog
 *   - `loadMyPickedSeriesFromSupabase()`   : reads the user's "我的跟练" set
 *   - `loadSeriesManifestFromOss(manifestUrl)` : fetches the per-series
 *     manifest from OSS (the heavy file list still lives on OSS)
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
): Promise<SupabaseSeriesRow[]> {
  try {
    // No long-lived cache here — the caller (video-series.ts) owns the
    // in-memory cache keyed by forceRefresh. We just hit Supabase each
    // cold call. Supabase PostgREST responses are HTTP-cacheable, so
    // a warm network layer will short-circuit if the row hasn't changed.
    const { data, error } = await supabase
      .from('official_video_series')
      .select('id, title, level, category, type, description, cover_url, tags, sort_order, manifest_url, resource_base_url, is_published, updated_at')
      .eq('is_published', true)
      .order('sort_order', { ascending: true })
      .order('title', { ascending: true });

    if (error) {
      warnSupabaseTrace('loadPublishedSeries failed', { error: error.message });
      return [];
    }
    const rows = (data ?? []) as SupabaseSeriesRow[];
    logSupabaseTrace('loadPublishedSeries success', {
      count: rows.length,
      forceRefresh,
    });
    return rows;
  } catch (err) {
    warnSupabaseTrace('loadPublishedSeries threw', {
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
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
