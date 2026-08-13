/**
 * Supabase-driven views over the official video series.
 *
 * Two read paths, both independent of `getFeaturedVideoScenes` (which
 * still reads the OSS catalog):
 *
 *   - `getOfficialVideoSeriesListFromSupabase()`
 *       → "资源库" tab. Reads `official_video_series`, fetches each
 *         series manifest from OSS, builds `OfficialVideoSeriesSummary`.
 *       → Falls back to the legacy `getOfficialVideoSeriesList()` if
 *         Supabase returns 0 rows or throws.
 *
 *   - `getMyPickedVideoSeriesListFromSupabase()`
 *       → "我的跟练" tab. Same shape, but filtered by what the user
 *         has picked. Falls back to [] on any error (an empty
 *         "我的跟练" is the correct UX while the data source recovers).
 *
 * Why a separate file:
 *   Keeps the original `video-series.ts` (and its OSS-catalog path)
 *   unchanged. The "资源库" and "我的跟练" tabs are the new code;
 *   "导入" / "历史" / "收藏" still go through the old path that
 *   feeds off `getFeaturedVideoScenes`.
 *
 * Caching:
 *   We keep an in-memory cache + a small TTL so repeat focus /
 *   pull-to-refresh doesn't hammer Supabase. The cache key includes
 *   `forceRefresh` to make bypass explicit.
 */

import {
  loadPublishedSeriesFromSupabase,
  loadMyPickedSeriesFromSupabase,
  loadSeriesManifestFromOss,
  resolveSeriesCoverUrl,
  type SupabaseSeriesRow,
  type PickedSeriesDetail,
  type RawSeriesManifest,
} from './video-series-supabase';
import {
  getOfficialVideoSeriesList,
  type OfficialVideoSeriesSummary,
} from './video-series';
import { listVideoUserMeta, type VideoUserMetaRecord } from './video-user-meta';

const VIDEO_SERIES_VIEWS_LOG_PREFIX = '[VideoSeriesViews]';

function logViewsTrace(message: string, payload?: unknown) {
  if (payload === undefined) {
    console.log(`${VIDEO_SERIES_VIEWS_LOG_PREFIX} ${message}`);
    return;
  }
  console.log(`${VIDEO_SERIES_VIEWS_LOG_PREFIX} ${message}`, payload);
}

function warnViewsTrace(message: string, payload?: unknown) {
  if (payload === undefined) {
    console.warn(`${VIDEO_SERIES_VIEWS_LOG_PREFIX} ${message}`);
    return;
  }
  console.warn(`${VIDEO_SERIES_VIEWS_LOG_PREFIX} ${message}`, payload);
}

// ── In-memory cache (keyed by source + forceRefresh) ───────────────

interface CacheEntry<T> {
  ts: number;
  data: T;
}

const CACHE_TTL_MS = 60_000; // 1 min; pull-to-refresh uses forceRefresh

const libraryCache: { entry: CacheEntry<OfficialVideoSeriesSummary[]> | null } = { entry: null };
const myPickedCache: { entry: CacheEntry<OfficialVideoSeriesSummary[]> | null } = { entry: null };

function readCache<T>(entry: CacheEntry<T> | null, forceRefresh: boolean): T | null {
  if (forceRefresh || !entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL_MS) return null;
  return entry.data;
}

function writeCache<T>(slot: { entry: CacheEntry<T> | null }, data: T) {
  slot.entry = { ts: Date.now(), data };
}

// ── Per-series manifest fetch (concurrent) ─────────────────────────

interface NormalizedEpisode {
  id: string;
  episodeIndex?: number;
}

interface NormalizedSeriesManifest {
  seriesBaseUrl: string;
  episodes: NormalizedEpisode[];
  // Future: surface cover/level overrides from manifest if Supabase row is sparse.
  seriesMeta?: {
    id?: string;
    title?: string;
    level?: string;
    description?: string;
    coverUrl?: string;
    tags?: string[];
    sortOrder?: number;
  };
}

async function fetchSeriesManifest(manifestUrl: string, cacheBust?: string): Promise<NormalizedSeriesManifest | null> {
  const raw = await loadSeriesManifestFromOss(manifestUrl, cacheBust);
  if (!raw) return null;
  return normalizeSeriesManifest(raw, manifestUrl);
}

function normalizeSeriesManifest(raw: RawSeriesManifest, manifestUrl: string): NormalizedSeriesManifest {
  const fallbackBaseUrl = manifestUrl.split('?')[0].split('/').slice(0, -1).join('/');
  const baseUrl = (raw.resourceBaseUrl && raw.resourceBaseUrl.trim())
    ? raw.resourceBaseUrl.trim().replace(/\/$/, '')
    : fallbackBaseUrl;

  const episodes: NormalizedEpisode[] = (Array.isArray(raw.episodes) ? raw.episodes : [])
    .map((ep): NormalizedEpisode | null => {
      const id = typeof ep.id === 'string' && ep.id.trim() ? ep.id.trim() : null;
      if (!id) return null;
      return {
        id,
        episodeIndex: typeof ep.episodeIndex === 'number' && Number.isFinite(ep.episodeIndex)
          ? ep.episodeIndex
          : undefined,
      };
    })
    .filter((ep): ep is NormalizedEpisode => ep !== null);

  return {
    seriesBaseUrl: baseUrl,
    episodes,
    seriesMeta: raw.series,
  };
}

// ── Build OfficialVideoSeriesSummary from Supabase row + manifest ──

function buildSummaryFromSupabase(
  row: SupabaseSeriesRow,
  manifest: NormalizedSeriesManifest | null,
  metaList: VideoUserMetaRecord[],
): OfficialVideoSeriesSummary {
  const metaMap = Object.fromEntries(metaList.map((m) => [m.sceneId, m]));
  const episodes = manifest?.episodes ?? [];
  const sortedEpisodes = [...episodes].sort((a, b) => {
    const aIndex = typeof a.episodeIndex === 'number' ? a.episodeIndex : Number.MAX_SAFE_INTEGER;
    const bIndex = typeof b.episodeIndex === 'number' ? b.episodeIndex : Number.MAX_SAFE_INTEGER;
    if (aIndex !== bIndex) return aIndex - bIndex;
    return a.id.localeCompare(b.id, 'zh-Hans-CN');
  });

  const firstEpisode = sortedEpisodes[0];

  // "practiced" = any episode has a lastPracticedAt in the local video_user_meta
  let lastPracticedAt: number | undefined;
  let lastPracticedEpisodeId: string | undefined;
  for (const ep of sortedEpisodes) {
    const ts = metaMap[ep.id]?.lastPracticedAt;
    if (typeof ts === 'number' && (lastPracticedAt == null || ts > lastPracticedAt)) {
      lastPracticedAt = ts;
      lastPracticedEpisodeId = ep.id;
    }
  }
  const practicedEpisodeCount = sortedEpisodes.filter((ep) => typeof metaMap[ep.id]?.lastPracticedAt === 'number').length;

  const resumeEpisode = lastPracticedEpisodeId
    ? sortedEpisodes.find((ep) => ep.id === lastPracticedEpisodeId)
    : firstEpisode;

  // Tags: prefer Supabase row tags, fall back to manifest's series tags.
  const tags = (row.tags && row.tags.length > 0
    ? row.tags
    : (manifest?.seriesMeta?.tags ?? [])
  ).filter((t) => typeof t === 'string' && t.trim()).slice(0, 4);

  return {
    id: row.id,
    title: row.title,
    level: row.level,
    description: row.description ?? manifest?.seriesMeta?.description ?? undefined,
    // `cover_url` on the Supabase row is a bare filename. The
    // library card and the home card both need a fully-loadable
    // URL — resolve via the manifest URL so the Image component
    // doesn't fall through to the fallback tile.
    coverImageUri: resolveSeriesCoverUrl(row.manifest_url, row.cover_url),
    tags,
    category: row.category,
    episodeCount: sortedEpisodes.length,
    completedEpisodeCount: practicedEpisodeCount,
    lastPracticedAt,
    resumeSceneId: resumeEpisode?.id,
    resumeEpisodeIndex: resumeEpisode?.episodeIndex,
    firstSceneId: firstEpisode?.id,
    firstEpisodeIndex: firstEpisode?.episodeIndex,
    sortOrder: row.sort_order,
  };
}

// ── Public: 资源库 (full library) ──────────────────────────────────

/**
 * Read every published series from Supabase, then fetch each
 * series manifest from OSS to count + sort episodes.
 *
 * If Supabase returns 0 rows (e.g. first run, or table not seeded
 * yet), fall back to the legacy OSS-catalog path so the tab is
 * never empty in production.
 */
export async function getOfficialVideoSeriesListFromSupabase(
  forceRefresh: boolean = false,
): Promise<OfficialVideoSeriesSummary[]> {
  const cached = readCache(libraryCache.entry, forceRefresh);
  if (cached) {
    logViewsTrace('library cache hit', { count: cached.length });
    return cached;
  }

  const cacheBust = forceRefresh ? `${Date.now()}` : undefined;

  const [rows, metaList] = await Promise.all([
    loadPublishedSeriesFromSupabase(forceRefresh),
    listVideoUserMeta().catch(() => [] as VideoUserMetaRecord[]),
  ]);

  if (rows.length === 0) {
    logViewsTrace('Supabase empty, falling back to OSS catalog', { forceRefresh });
    const legacy = await getOfficialVideoSeriesList(forceRefresh);
    if (legacy.length > 0) {
      writeCache(libraryCache, legacy);
    }
    return legacy;
  }

  // Per-series manifest fetch (concurrent)
  const summaries: OfficialVideoSeriesSummary[] = (await Promise.all(
    rows.map(async (row) => {
      const manifest = await fetchSeriesManifest(row.manifest_url, cacheBust);
      return buildSummaryFromSupabase(row, manifest, metaList);
    }),
  )).sort((a, b) => {
    if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
    if ((b.lastPracticedAt ?? 0) !== (a.lastPracticedAt ?? 0)) {
      return (b.lastPracticedAt ?? 0) - (a.lastPracticedAt ?? 0);
    }
    return a.level.localeCompare(b.level, 'zh-Hans-CN') || a.title.localeCompare(b.title, 'zh-Hans-CN');
  });

  logViewsTrace('library built from Supabase', {
    count: summaries.length,
    forceRefresh,
  });
  writeCache(libraryCache, summaries);
  return summaries;
}

// ── Public: 我的跟练 (user-picked) ─────────────────────────────────

/**
 * Read the user's picked series joined with their metadata,
 * then fetch each manifest to count + sort episodes.
 *
 * Returns [] on any error. Does NOT fall back to the legacy path
 * because "我的跟练" is empty by design for a brand-new user.
 */
export async function getMyPickedVideoSeriesListFromSupabase(
  forceRefresh: boolean = false,
): Promise<OfficialVideoSeriesSummary[]> {
  const cached = readCache(myPickedCache.entry, forceRefresh);
  if (cached) {
    logViewsTrace('my_picked cache hit', { count: cached.length });
    return cached;
  }

  const cacheBust = forceRefresh ? `${Date.now()}` : undefined;

  const [picked, metaList] = await Promise.all([
    loadMyPickedSeriesFromSupabase(forceRefresh),
    listVideoUserMeta().catch(() => [] as VideoUserMetaRecord[]),
  ]);

  if (picked.length === 0) {
    logViewsTrace('my_picked empty', { forceRefresh });
    writeCache(myPickedCache, []);
    return [];
  }

  // Only keep rows whose joined series is still published. If a
  // series was soft-deleted, the joined object is null — drop it.
  const liveRows: Array<{ row: PickedSeriesDetail['row']; series: SupabaseSeriesRow }> = [];
  for (const p of picked) {
    if (p.series && p.series.is_published) {
      liveRows.push({ row: p.row, series: p.series });
    }
  }

  const summaries: OfficialVideoSeriesSummary[] = (await Promise.all(
    liveRows.map(async ({ row: pickedRow, series }) => {
      const manifest = await fetchSeriesManifest(series.manifest_url, cacheBust);
      const summary = buildSummaryFromSupabase(series, manifest, metaList);
      // Use the Supabase last_practiced_at as a fallback when the
      // local video_user_meta hasn't been touched yet (e.g. series
      // picked but no episode opened).
      if (summary.lastPracticedAt == null && pickedRow.last_practiced_at) {
        const ts = Date.parse(pickedRow.last_practiced_at);
        if (Number.isFinite(ts)) summary.lastPracticedAt = ts;
      }
      return summary;
    }),
  )).sort((a, b) => {
    // Pinned > picked_at desc. We rebuild this from the picked rows.
    const aRow = liveRows.find((r) => r.series.id === a.id)?.row;
    const bRow = liveRows.find((r) => r.series.id === b.id)?.row;
    if ((aRow?.is_pinned ?? false) !== (bRow?.is_pinned ?? false)) {
      return aRow?.is_pinned ? -1 : 1;
    }
    const aTs = aRow ? Date.parse(aRow.picked_at) : 0;
    const bTs = bRow ? Date.parse(bRow.picked_at) : 0;
    return bTs - aTs;
  });

  logViewsTrace('my_picked built from Supabase', {
    rawCount: picked.length,
    liveCount: liveRows.length,
    summaryCount: summaries.length,
    forceRefresh,
  });
  writeCache(myPickedCache, summaries);
  return summaries;
}

/**
 * Invalidate both caches. Call after pickSeries/unpickSeries so the
 * next read pulls fresh data.
 */
export function invalidateVideoSeriesViewsCache() {
  libraryCache.entry = null;
  myPickedCache.entry = null;
}
