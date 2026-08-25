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
  countPublishedSeries,
  loadMyPickedSeriesFromSupabase,
  loadSeriesEpisodesFromSupabase,
  loadEpisodesForSeriesBatch,
  loadSeriesManifestFromOss,
  loadSeriesByIdFromSupabase,
  resolveSeriesCoverUrl,
  resolveEpisodeAssetUrl,
  type SupabaseSeriesRow,
  type SupabaseEpisodeRow,
  type PickedSeriesDetail,
  type RawSeriesManifest,
} from './video-series-supabase';
import {
  getOfficialVideoSeriesList,
  type OfficialVideoSeriesDetail,
  type OfficialVideoSeriesSummary,
} from './video-series';
import { listVideoUserMeta, type VideoUserMetaRecord } from './video-user-meta';
import type { VideoSceneDetail, VideoSceneRole } from './video-scenes';
import type { ScenarioCard } from '../ai/scenario-generator';

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

/**
 * Build a `NormalizedSeriesManifest`-shaped object from the Supabase
 * episode rows. The shape matches the OSS-manifest path so the rest
 * of the file (buildSummaryFromSupabase etc.) doesn't have to branch.
 *
 * `manifestUrl` is still required to derive `seriesBaseUrl` (the
 * bucket + path prefix) — every row in the Supabase `official_video_series`
 * table has a `manifest_url` field even though we no longer fetch
 * the manifest itself; the desktop admin writes it as a per-series
 * base URL when uploading.
 */
function buildNormalizedFromEpisodes(
  episodes: SupabaseEpisodeRow[],
  manifestUrl: string | null | undefined,
): NormalizedSeriesManifest {
  const fallbackBaseUrl = manifestUrl
    ? manifestUrl.split('?')[0].split('/').slice(0, -1).join('/')
    : '';
  return {
    seriesBaseUrl: fallbackBaseUrl,
    episodes: episodes
      .map((ep): NormalizedEpisode | null => {
        const id = typeof ep.id === 'string' && ep.id.trim() ? ep.id.trim() : null;
        if (!id) return null;
        return {
          id,
          episodeIndex: typeof ep.episode_index === 'number' && Number.isFinite(ep.episode_index)
            ? ep.episode_index
            : undefined,
        };
      })
      .filter((ep): ep is NormalizedEpisode => ep !== null),
  };
}

async function fetchSeriesEpisodesFromSupabase(
  seriesId: string,
  manifestUrl: string | null | undefined,
): Promise<NormalizedSeriesManifest | null> {
  const rows = await loadSeriesEpisodesFromSupabase(seriesId);
  if (rows.length === 0) return null;
  return buildNormalizedFromEpisodes(rows, manifestUrl);
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

  // 2026-08-21: list 页 (library / 我的合集) 传 manifest=null, 此时:
  // - episodeCount = 0 (详情页 library/[id] 会单独查真值)
  // - completedEpisodeCount = 0 (没有 episode 数据算不出来)
  // - lastPracticedAt / resumeSceneId 也不可靠
  // - 封面/标题/level/category/tags/description 仍然正常 (从 row 拿)
  // 这样 list 页只查 official_video_series 单次 query, 不再 N+1 拉 episodes.
  const isListOnlyMode = manifest == null;

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
    episodeCount: isListOnlyMode ? 0 : sortedEpisodes.length,
    completedEpisodeCount: isListOnlyMode ? 0 : practicedEpisodeCount,
    lastPracticedAt: isListOnlyMode ? undefined : lastPracticedAt,
    resumeSceneId: isListOnlyMode ? undefined : resumeEpisode?.id,
    resumeEpisodeIndex: isListOnlyMode ? undefined : resumeEpisode?.episodeIndex,
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

  // Per-series episode fetch (concurrent, from Supabase — the
  // per-series `manifest.json` on OSS is now a legacy read-only
  // cache; the rn-app's source of truth is `official_video_episodes`)
  const summaries: OfficialVideoSeriesSummary[] = (await Promise.all(
    rows.map(async (row) => {
      const manifest = await fetchSeriesEpisodesFromSupabase(row.id, row.manifest_url);
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

// ── Public: 分页版 (library 页面用) ─────────────────────────────────

/**
 * 2026-08-21: library 页面分页加载专用。
 *
 * 跟 getOfficialVideoSeriesListFromSupabase 的区别:
 *   - 这个**不缓存**, 每次调用都走 DB, 适合分页按需加载
 *   - 数据库端 .range() 一次只取 limit 条, 避免拉全表
 *   - 同样并发拉每条 series 的 manifest, 但 N+1 范围限制在 limit 个内
 *
 * Returns: { items, total, hasMore }
 *   - items: 这一页的 OfficialVideoSeriesSummary (排序跟全量版一致: sortOrder, lastPracticedAt, level, title)
 *   - total: published series 总数 (用于分页进度显示)
 *   - hasMore: offset + items.length < total
 *
 * 失败返回空结果, total=0, hasMore=false. 不抛错 (UI 容错用)。
 */
export interface PaginatedSeriesResult {
  items: OfficialVideoSeriesSummary[];
  total: number;
  hasMore: boolean;
}

export async function getOfficialVideoSeriesPageFromSupabase(
  pagination: { limit: number; offset: number; level?: string | null },
): Promise<PaginatedSeriesResult> {
  const { limit, offset } = pagination;
  const level = pagination.level ?? null;
  try {
    // 2026-08-21: list 页只查 official_video_series 单次 query, 不再 N+1 拉 episodes.
    // 详情页 library/[id] 会通过 getOfficialVideoSeriesDetailFromSupabase(seriesId)
    // 单独查 (走 episodes 表 + manifest, 单个 series 不存在 N+1 问题).
    // user_meta 也要查, 因为 completedEpisodeCount / lastPracticedAt / resumeSceneId
    // 需要它. 但 list 页传 manifest=null 时这些字段都填 0 / undefined, 所以
    // user_meta 这次也省了 — 直接空数组.
    const [rows, total] = await Promise.all([
      loadPublishedSeriesFromSupabase(false, { limit, offset, level }),
      countPublishedSeries(level),
    ]);

    if (rows.length === 0) {
      // 一页都没有: 直接返空, 不走 legacy fallback
      // (分页场景下没必要全量 fallback, 没数据就是没数据)
      logViewsTrace('library page empty', { offset, limit, level, total });
      return { items: [], total, hasMore: offset < total };
    }

    // 不再 N+1 调 fetchSeriesEpisodesFromSupabase. buildSummaryFromSupabase
    // 接受 manifest=null 时 episodeCount/completedEpisodeCount 等填 0,
    // UI 显示 "—" 即可, 真值在用户点进详情页时才查.
    const items: OfficialVideoSeriesSummary[] = rows.map((row) =>
      buildSummaryFromSupabase(row, null, []),
    );

    // 排序保留: sortOrder, title (lastPracticedAt 不可靠, list 模式下全 undefined)
    items.sort((a, b) => {
      if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
      return a.level.localeCompare(b.level, 'zh-Hans-CN') || a.title.localeCompare(b.title, 'zh-Hans-CN');
    });

    const hasMore = offset + items.length < total;
    logViewsTrace('library page loaded', {
      offset,
      limit,
      level,
      returned: items.length,
      total,
      hasMore,
    });
    return { items, total, hasMore };
  } catch (err) {
    logViewsTrace('library page failed', {
      offset,
      limit,
      level,
      error: err instanceof Error ? err.message : String(err),
    });
    return { items: [], total: 0, hasMore: false };
  }
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
      const manifest = await fetchSeriesEpisodesFromSupabase(series.id, series.manifest_url);
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
  detailCache.clear();
  officialScenesCache.entry = null;
}

// ── Per-series detail (Supabase series row + per-episode rows) ─────

/**
 * Per-seriesId cache for the detail view. Same 60s TTL as the list
 * cache — detail pages re-fetch on focus, and we don't want to
 * hammer Supabase when the user pops in and out.
 */
const detailCache = new Map<string, CacheEntry<OfficialVideoSeriesDetail | null>>();

function readDetailCache(seriesId: string, forceRefresh: boolean): OfficialVideoSeriesDetail | null | undefined {
  if (forceRefresh) return undefined;
  const entry = detailCache.get(seriesId);
  if (!entry) return undefined;
  if (Date.now() - entry.ts > CACHE_TTL_MS) return undefined;
  return entry.data;
}

function writeDetailCache(seriesId: string, data: OfficialVideoSeriesDetail | null) {
  detailCache.set(seriesId, { ts: Date.now(), data });
}

/**
 * Color hint for the episode cover. The detail-page list doesn't
 * actually read this, but `VideoSceneDetail` requires it, so we
 * derive something stable from the series category.
 */
function pickCoverAccent(category: string, type: string): string {
  if (type === 'film') return '#F59E0B';
  if (type === 'dialogue') return '#3B82F6';
  if (type === 'lecture') return '#10B981';
  if (category.includes('旅行')) return '#06B6D4';
  if (category.includes('社交')) return '#8B5CF6';
  if (category.includes('学习')) return '#6366F1';
  return '#6366F1';
}

function buildEmptyRoles(): { userRole: VideoSceneRole; npcRole: VideoSceneRole } {
  return {
    userRole: { title: '学习者', description: '正在练习英语口语', tone: '友好' },
    npcRole: { title: '视频角色', description: '视频中的对话对象', tone: '自然' },
  };
}

/**
 * Build a skeleton `VideoSceneDetail` from a single Supabase episode row.
 * This is the "summary view" used by the detail page lists — not the
 * full composition the player needs. The player does its own lazy
 * enrichment (separate function, step 2) when the user actually
 * opens a video.
 *
 * Fields populated here are the ones the detail page reads:
 *   - id, coverImageUri, durationSeconds, episodeIndex, episodeTitle
 *   - card.title, card.category
 *   - groupId/groupTitle/groupLevel/groupCoverImageUri (from series row)
 *   - sourceLabel, coverAccent, contentOrigin
 * Fields left as placeholders / empty (player will hydrate):
 *   - goals=[], segments=[], aiPracticeCards=undefined
 *   - videoUri, cloudRemotePath, subtitleFileName, etc. (resolved on play)
 */
function buildSkeletonSceneFromEpisode(
  episode: SupabaseEpisodeRow,
  series: SupabaseSeriesRow,
  practicedEpisodeIds: ReadonlySet<string>,
  completedEpisodeCount: number,
): VideoSceneDetail {
  const manifestUrl = series.manifest_url;
  const coverUri = resolveEpisodeAssetUrl(manifestUrl, episode.cover_file);
  const category = episode.category || series.category || '综合';
  const level = episode.level || series.level || 'B1';
  const type = episode.type || series.type || 'vlog';
  const title = episode.title || `Episode ${episode.episode_index}`;
  const roles = buildEmptyRoles();
  const isPracticed = practicedEpisodeIds.has(episode.id);

  const card: ScenarioCard = {
    id: `${episode.id}__card`,
    sourceType: 'video_scene',
    icon: '📹',
    category,
    level,
    title,
    desc: `Practice English with the "${title}" episode from ${series.title}.`,
  };

  // Stash the practice state on the scene for detail-page rendering
  // (e.g. the "已学习" badge in `app/series/[id].tsx`). We don't
  // touch the official VideoSceneDetail type — just attach a hidden
  // marker via a metadata field. The detail page reads
  // `series.completedEpisodeCount` for the badge, so this is
  // belt-and-suspenders; the only purpose is to make the skeleton
  // visually consistent if anything ever introspects it.
  void isPracticed;
  void completedEpisodeCount;

  return {
    id: episode.id,
    sourceLabel: episode.source_label || '',
    durationSeconds: typeof episode.duration_seconds === 'number' && Number.isFinite(episode.duration_seconds)
      ? Math.max(0, episode.duration_seconds)
      : 0,
    coverAccent: pickCoverAccent(category, type),
    coverImageUri: coverUri,
    contentOrigin: 'official',
    // Per-series context (lifted from the Supabase series row)
    groupId: series.id,
    groupTitle: series.title,
    groupLevel: series.level,
    groupDescription: series.description ?? undefined,
    groupCoverImageUri: resolveSeriesCoverUrl(manifestUrl, series.cover_url),
    groupTags: Array.isArray(series.tags) ? series.tags.filter((t) => typeof t === 'string' && t.trim()) : undefined,
    groupSortOrder: series.sort_order,
    // Per-episode context
    episodeIndex: episode.episode_index,
    episodeTitle: title,
    totalEpisodesInGroup: undefined, // filled by caller
    // Skeleton card + roles — the player will replace these with
    // a real composition on focus.
    card,
    ...roles,
    goals: [],
    segments: [],
  };
}

/**
 * Load one official series (with its full episode list) from Supabase.
 * Returns `null` if the series isn't found in `official_video_series`
 * — the caller can fall back to the legacy OSS-catalog path.
 *
 * Unlike the list helpers, this does NOT fall back internally: detail
 * pages deserve to know whether the data really came from Supabase
 * (for cache invalidation, debug logging, and future migration tracking).
 *
 * Episode `VideoSceneDetail` objects here are skeletons — the detail
 * page list uses them to render title/cover/duration, and the player
 * does its own full composition when the user opens a video. Don't
 * try to use the skeleton to drive playback.
 */
export async function getOfficialVideoSeriesDetailFromSupabase(
  seriesId: string,
  forceRefresh: boolean = false,
): Promise<OfficialVideoSeriesDetail | null> {
  if (!seriesId || !seriesId.trim()) return null;
  const trimmedId = seriesId.trim();
  const cached = readDetailCache(trimmedId, forceRefresh);
  if (cached !== undefined) {
    logViewsTrace('detail cache hit', { seriesId: trimmedId });
    return cached;
  }

  try {
    const [seriesRow, episodeRows, metaList] = await Promise.all([
      loadSeriesByIdFromSupabase(trimmedId),
      loadSeriesEpisodesFromSupabase(trimmedId),
      listVideoUserMeta().catch(() => [] as VideoUserMetaRecord[]),
    ]);

    if (!seriesRow) {
      logViewsTrace('detail series not found', { seriesId: trimmedId });
      writeDetailCache(trimmedId, null);
      return null;
    }

    const metaMap = Object.fromEntries(metaList.map((m) => [m.sceneId, m]));
    const practicedEpisodeIds = new Set(
      Object.entries(metaMap)
        .filter(([, m]) => typeof m.lastPracticedAt === 'number')
        .map(([id]) => id),
    );
    const completedEpisodeCount = practicedEpisodeIds.size;

    const sortedEpisodes = [...episodeRows].sort((a, b) => a.episode_index - b.episode_index);
    const totalEpisodes = sortedEpisodes.length;
    const scenes: VideoSceneDetail[] = sortedEpisodes.map((ep) => {
      const scene = buildSkeletonSceneFromEpisode(ep, seriesRow, practicedEpisodeIds, completedEpisodeCount);
      scene.totalEpisodesInGroup = totalEpisodes;
      return scene;
    });

    // Build the summary shape the detail page uses.
    // Prefer Supabase series fields; fall back to series-episode aggregates.
    const tags = (Array.isArray(seriesRow.tags) ? seriesRow.tags : []).filter((t) => typeof t === 'string' && t.trim()).slice(0, 4);
    const firstScene = scenes[0];
    const lastPracticedScene = scenes
      .map((s) => ({ scene: s, ts: metaMap[s.id]?.lastPracticedAt as number | undefined }))
      .filter((x): x is { scene: VideoSceneDetail; ts: number } => typeof x.ts === 'number')
      .sort((a, b) => b.ts - a.ts)[0]?.scene ?? null;
    const resumeScene = lastPracticedScene ?? firstScene;

    const detail: OfficialVideoSeriesDetail = {
      id: seriesRow.id,
      title: seriesRow.title,
      level: seriesRow.level,
      description: seriesRow.description ?? undefined,
      coverImageUri: resolveSeriesCoverUrl(seriesRow.manifest_url, seriesRow.cover_url),
      tags,
      category: seriesRow.category || (scenes[0]?.card.category ?? '综合'),
      episodeCount: totalEpisodes,
      completedEpisodeCount,
      lastPracticedAt: lastPracticedScene
        ? (metaMap[lastPracticedScene.id]?.lastPracticedAt as number | undefined)
        : undefined,
      resumeSceneId: resumeScene?.id,
      resumeEpisodeIndex: resumeScene?.episodeIndex,
      firstSceneId: firstScene?.id,
      firstEpisodeIndex: firstScene?.episodeIndex,
      sortOrder: seriesRow.sort_order,
      episodes: scenes,
    };

    logViewsTrace('detail built from Supabase', {
      seriesId: trimmedId,
      episodeCount: totalEpisodes,
    });
    writeDetailCache(trimmedId, detail);
    return detail;
  } catch (err) {
    warnViewsTrace('getOfficialVideoSeriesDetailFromSupabase threw', {
      seriesId: trimmedId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

// ── Flat scene list (used by the AI 陪练 hub) ─────────────────────

/**
 * In-memory cache for the flat official-scene list. The AI 陪练
 * tab calls this on focus; the 60s TTL matches the list-page
 * cache so the user doesn't refetch on every keystroke or
 * tab-switch, but stale data never lingers longer than a minute.
 */
const officialScenesCache: { entry: CacheEntry<VideoSceneDetail[]> | null } = { entry: null };

/**
 * Build a skeleton `VideoSceneDetail` from a Supabase episode row,
 * with the parent series row lifting `groupId` / `groupTitle` /
 * `groupLevel` etc. Same shape as the per-series detail skeleton
 * (the AI 陪练 hub only reads `id`, `contentOrigin`, `groupId`,
 * `card.title`, `sourceLabel`, and `aiPracticeCards` — all populated
 * here).
 */
function buildSkeletonSceneForList(
  episode: SupabaseEpisodeRow,
  series: SupabaseSeriesRow,
): VideoSceneDetail {
  const manifestUrl = series.manifest_url;
  const coverUri = resolveEpisodeAssetUrl(manifestUrl, episode.cover_file);
  const category = episode.category || series.category || '综合';
  const level = episode.level || series.level || 'B1';
  const type = episode.type || series.type || 'vlog';
  const title = episode.title || `Episode ${episode.episode_index}`;
  const roles = {
    userRole: { title: '学习者', description: '正在练习英语口语', tone: '友好' },
    npcRole: { title: '视频角色', description: '视频中的对话对象', tone: '自然' },
  };
  const card: ScenarioCard = {
    id: `${episode.id}__card`,
    sourceType: 'video_scene',
    icon: '📹',
    category,
    level,
    title,
    desc: `Practice English with the "${title}" episode from ${series.title}.`,
  };
  return {
    id: episode.id,
    sourceLabel: episode.source_label || '',
    durationSeconds: typeof episode.duration_seconds === 'number' && Number.isFinite(episode.duration_seconds)
      ? Math.max(0, episode.duration_seconds)
      : 0,
    coverAccent: '#6366F1',
    coverImageUri: coverUri,
    contentOrigin: 'official',
    groupId: series.id,
    groupTitle: series.title,
    groupLevel: series.level,
    groupDescription: series.description ?? undefined,
    groupCoverImageUri: resolveSeriesCoverUrl(manifestUrl, series.cover_url),
    episodeIndex: episode.episode_index,
    episodeTitle: title,
    card,
    ...roles,
    goals: [],
    segments: [],
    // AI practice cards are loaded on-demand by `loadSceneAiCards` in
    // `ai-practice-hub.ts` — the skeleton is enough to dispatch the
    // load (the hub falls back to `loadGeneratedVideoAiPracticeCards`
    // when this is empty).
    aiPracticeCards: [],
  };
}

/**
 * Flat list of all published official scenes (one per episode,
 * across every published series). The shape matches the legacy
 * `getFeaturedVideoScenes()` output so callers — currently only the
 * AI 陪练 hub — can swap one for the other without code changes
 * elsewhere.
 *
 * Returns `[]` on any Supabase error. The caller should fall back
 * to the legacy `getFeaturedVideoScenes()` so an outage doesn't
 * black out the AI 陪练 tab.
 *
 * Performance: two Supabase round-trips (series list, episodes
 * batch) and N skeleton constructions. 1-min cache shared with the
 * rest of the views file.
 */
export async function listOfficialScenesFromSupabase(
  forceRefresh: boolean = false,
): Promise<VideoSceneDetail[]> {
  const cached = readCache(officialScenesCache.entry, forceRefresh);
  if (cached) {
    logViewsTrace('official_scenes cache hit', { count: cached.length });
    return cached;
  }

  try {
    // One series-list call feeds both the cache-content decision
    // (empty → bail) and the episodes-batch ids, so we fetch it
    // once and reuse the result.
    const rows = await loadPublishedSeriesFromSupabase(forceRefresh);
    if (rows.length === 0) {
      logViewsTrace('official_scenes empty (no published series)', { forceRefresh });
      writeCache(officialScenesCache, []);
      return [];
    }

    const ids = rows.map((r) => r.id);
    const episodesBySeries = await loadEpisodesForSeriesBatch(ids);

    const seriesById = new Map<string, SupabaseSeriesRow>(rows.map((r) => [r.id, r]));
    const scenes: VideoSceneDetail[] = [];
    for (const [seriesId, episodes] of episodesBySeries.entries()) {
      const series = seriesById.get(seriesId);
      if (!series) continue;
      for (const ep of episodes) {
        scenes.push(buildSkeletonSceneForList(ep, series));
      }
    }

    logViewsTrace('official_scenes built from Supabase', {
      sceneCount: scenes.length,
      forceRefresh,
    });
    writeCache(officialScenesCache, scenes);
    return scenes;
  } catch (err) {
    warnViewsTrace('listOfficialScenesFromSupabase threw', {
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}
