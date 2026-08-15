/**
 * Collection abstraction — the "我的合集" home page is a single
 * grid that unions two data sources:
 *
 *   - **Official**    : `official_video_series` (Supabase) — what
 *                        the user has subscribed to via
 *                        `user_picked_video_series`.
 *   - **User-built**  : `user_collections` (Supabase) — collections
 *                        the user created, including the auto-created
 *                        "默认合集" that all imports land in by
 *                        default.
 *
 * Both shapes collapse into `CollectionSummary` so the home page can
 * render them with a single card component and no source branching.
 * Detail pages branch on `kind` because the underlying data is
 * genuinely different (OSS manifest vs. local SQLite entries).
 *
 * ID encoding on the wire:
 *   `official:<id>`  → official series, the tail is the row id
 *                       in `official_video_series`.
 *   `user:<bigserial>` → user-built collection, the tail is the
 *                       row id in `user_collections`.
 *
 * This format is also what we persist in
 * `imported_video_packs.collectionId` /
 * `user_videos.collectionId`, so the rest of the app can stay
 * source-agnostic until it actually has to render a detail page.
 */

import {
  loadPublishedSeriesFromSupabase,
  loadMyPickedSeriesFromSupabase,
  loadSeriesEpisodesFromSupabase,
  resolveSeriesCoverUrl,
  type SupabaseSeriesRow,
  type SupabaseEpisodeRow,
  type PickedSeriesDetail,
} from './video-series-supabase';
import { getOfficialVideoSeriesById } from './video-series';
import {
  listUserCollections,
  getOrCreateDefaultCollection,
  type UserCollectionRow,
  encodeUserCollectionId,
  decodeUserCollectionId,
} from './user-collections';
import { listVideoUserMeta, type VideoUserMetaRecord } from './video-user-meta';
import { listImportedVideoPacks, type ImportedVideoPackIndexEntry } from './imported-video-packs';
import { listUserVideos, type UserVideoEntry } from './user-videos';

const COLLECTIONS_LOG_PREFIX = '[Collections]';

function logColTrace(message: string, payload?: unknown) {
  if (payload === undefined) {
    console.log(`${COLLECTIONS_LOG_PREFIX} ${message}`);
    return;
  }
  console.log(`${COLLECTIONS_LOG_PREFIX} ${message}`, payload);
}

function warnColTrace(message: string, payload?: unknown) {
  if (payload === undefined) {
    console.warn(`${COLLECTIONS_LOG_PREFIX} ${message}`);
    return;
  }
  console.warn(`${COLLECTIONS_LOG_PREFIX} ${message}`, payload);
}

// ── Wire ID format ─────────────────────────────────────────────────

export type CollectionKind = 'official' | 'user';

export interface CollectionId {
  kind: CollectionKind;
  rawId: string;          // original id (e.g. "a1-beginner-english" or "42")
  wireId: string;         // "official:xxx" or "user:N"
}

export function encodeCollectionId(kind: CollectionKind, rawId: string | number): string {
  if (kind === 'user') {
    return encodeUserCollectionId(typeof rawId === 'number' ? rawId : Number(rawId));
  }
  return `official:${rawId}`;
}

export function decodeCollectionId(wireId: string): CollectionId | null {
  if (!wireId) return null;
  if (wireId.startsWith('official:')) {
    return { kind: 'official', rawId: wireId.slice('official:'.length), wireId };
  }
  if (wireId.startsWith('user:')) {
    const n = decodeUserCollectionId(wireId);
    if (n == null) return null;
    return { kind: 'user', rawId: String(n), wireId };
  }
  return null;
}

// ── Summary (home page card shape) ─────────────────────────────────

export interface CollectionSummary {
  id: string;                      // wire id
  kind: CollectionKind;
  title: string;
  description?: string;
  coverImageUri?: string;
  videoCount: number;              // episodes (official) or videos (user)
  completedCount: number;
  lastActivityAt?: number;
  isDefault?: boolean;             // user only
  sortOrder: number;
}

// ── Detail (one collection's contents) ─────────────────────────────

export interface CollectionVideoItem {
  // For official: this is an episode id (e.g. "travel-bucket-list__1").
  // For user: this is the imported / user video id (e.g. "user_video_xxx").
  id: string;
  title: string;
  coverImageUri?: string;
  durationSeconds?: number;
  /**
   * 1-based episode index, set for official series where the
   * list is inherently ordered. User-built collections don't set
   * this — the row can fall back to a generic position badge or
   * omit the number entirely.
   */
  episodeIndex?: number;
  /**
   * Where this row's underlying entry lives. Drives which CRUD
   * hooks the detail page can offer:
   *   - 'official'   — read-only (managed by NativeOS)
   *   - 'pack'       — entry is in `imported_video_packs`
   *   - 'user-video' — entry is in `user_videos` (local or cloud)
   * Optional on purpose so older detail payloads from before this
   * field existed still parse; UI defaults to "no actions".
   */
  source?: 'official' | 'pack' | 'user-video';

  // ── Origin / cache / AI-topic state ──
  // Drives the row's status chips. Packs and official episodes
  // pre-fill these; user-videos fill from their entry fields.

  /**
   * Where the underlying video bytes live.
   *   - 'official'   — OSS / scene host (NativeOS recommended)
   *   - 'baidu-pan'  — user video sourced from a Baidu cloud drive
   *   - 'local'      — user video imported as a local file
   *   - 'pack'       — user video imported as a .deckpack bundle
   * Drives the "来源" chip (icon + label).
   */
  origin?: 'official' | 'baidu-pan' | 'local' | 'pack';
  /**
   * Local-cache status. Independent of origin: a 'local' entry is
   * always cached, an 'official' one is never cacheable, a
   * 'baidu-pan' / 'pack' entry can be in either state.
   *   - 'remote'      — bytes live off-device; row can offer a
   *                     "缓存" shortcut
   *   - 'downloading' — a download is in progress; chip is a
   *                     progress-style indicator with no action
   *   - 'cached'      — local copy is the source of truth
   */
  cacheStatus?: 'remote' | 'downloading' | 'cached' | 'error';
  /**
   * AI practice topic status. Official / pack entries ship with
   * pre-generated topic cards and stay 'pre-shipped'. User videos
   * start as 'none'; the row can offer a "生成 AI 话题" shortcut
   * that requires both `cacheStatus === 'cached'` and
   * `subtitleStatus === 'ready'` to actually run.
   *   - 'pre-shipped' — pre-generated cards included (no work needed)
   *   - 'ready'       — user video has user-generated cards saved
   *   - 'processing'  — generation is in progress (paired with
   *                     `aiTopicProgress` + `aiTopicProgressMessage`
   *                     for a live status message)
   *   - 'pending'     — accepted, queued but not yet running
   *                     (transient; treated the same as
   *                     'processing' on the chip)
   *   - 'error'       — last run failed; row offers a "重试"
   *                     shortcut (same gate as 'none')
   *   - 'none'        — no AI topics yet (eligible to generate)
   */
  aiTopicStatus?: 'pre-shipped' | 'ready' | 'processing' | 'pending' | 'error' | 'none';
  /** 0..1 progress for the current AI topic run. */
  aiTopicProgress?: number;
  /** Human-readable progress message ("整理字幕上下文…" / "解析 3/5 个场景…"). */
  aiTopicProgressMessage?: string;
  /** Card count once ready. */
  aiTopicCount?: number;

  // ── Cloud-drive binding (official scenes only) ──
  // Whether the user has a cloud-drive copy of this scene bound
  // to their account via the `OfficialSceneSyncRecord` table.
  // Official video rows can offer a "play from my cloud drive"
  // shortcut when bound, so the user doesn't burn NativeOS
  // egress on every playback. Only set for `source: 'official'`;
  // user-built collections don't have cloud-drive bindings.
  //   - 'bound'      — the user's drive has a matching file
  //   - 'stale'      — bound but the local sync record is older
  //                    than the series's expected video key
  //                    (likely a re-upload on the NativeOS side)
  //   - 'error'      — last sync attempt failed; row offers a
  //                    "重新扫描" shortcut
  //   - 'unbound'    — provider is configured but this scene
  //                    has no matching file in the user's drive
  //   - 'not_synced' — no record yet (provider may or may not
  //                    be configured; the row's chip copy
  //                    reflects the latter case)
  bindingStatus?: 'bound' | 'stale' | 'error' | 'unbound' | 'not_synced';
  /** Cloud drive provider this binding is for (typically
   *  'baidu_pan'). Undefined when not bound. */
  bindingProvider?: 'baidu_pan';
  /** Remote path on the cloud drive (only set when bound). */
  bindingRemotePath?: string;

  // ── Subtitle state (user-video only) ──
  /**
   * 3-stage subtitle pipeline status. The detail row renders
   * different chips/labels per state:
   *   - 'none'       — no subtitle was ever requested (or it's
   *                    been cleared); row shows nothing extra
   *   - 'pending'    — accepted, waiting to be picked up
   *   - 'processing' — actively running, paired with `subtitlePhase`
   *                    and `subtitlePhaseProgress` for a precise
   *                    "下载 88MB / 250MB"-style message
   *   - 'ready'      — generated successfully; row gets a "字幕 ✓"
   *                    green chip
   *   - 'error'      — generation failed; row gets a "字幕失败"
   *                    red chip (the user can retry from the
   *                    video detail page)
   * Packs have their subtitles pre-shipped and don't need this
   * state. Official episodes are hosted and don't either — both
   * paths leave these fields undefined.
   */
  subtitleStatus?: 'none' | 'pending' | 'processing' | 'ready' | 'error';
  subtitlePhase?: 'downloading' | 'extracting' | 'asr';
  subtitlePhaseProgress?: number;  // 0..1
  subtitlePhaseMessage?: string;
  /**
   * When set, the cloud video has been downloaded into the local
   * cache and is ready to play offline. The row can show a small
   * "已缓存" indicator so the user knows it's not dependent on
   * network for this entry.
   */
  cachedLocalUri?: string;
}

export interface CollectionDetail {
  id: string;                      // wire id
  kind: CollectionKind;
  title: string;
  description?: string;
  coverImageUri?: string;
  videoCount: number;
  isLocked: boolean;               // true for official, false for user
  /**
   * True for the user's default collection ("我的默认合集" /
   * catch-all). Drives the destructive vs. non-destructive
   * "从合集移除" flow on the detail page.
   */
  isDefault?: boolean;
  videos: CollectionVideoItem[];
}

// ── Home page listing (union) ──────────────────────────────────────

let homeCache: { ts: number; data: CollectionSummary[] } | null = null;
const HOME_CACHE_TTL_MS = 60_000;

function readHomeCache(forceRefresh: boolean): CollectionSummary[] | null {
  if (forceRefresh || !homeCache) return null;
  if (Date.now() - homeCache.ts > HOME_CACHE_TTL_MS) return null;
  return homeCache.data;
}

export function invalidateCollectionsCache() {
  homeCache = null;
}

/**
 * Read all collections the user sees on the home page.
 *
 *   - Subscribed official series (from `user_picked_video_series`,
 *     joined with `official_video_series`).
 *   - User-built collections (from `user_collections`).
 *
 * The two sets are interleaved by `sortOrder` (lower first). The
 * default user collection — when present — is always sorted last as
 * a "catch-all" rather than a featured item.
 *
 * On any error from a single source, that source contributes `[]`
 * rather than failing the whole call.
 */
export async function listMyCollections(forceRefresh: boolean = false): Promise<CollectionSummary[]> {
  const cached = readHomeCache(forceRefresh);
  if (cached) {
    logColTrace('home cache hit', { count: cached.length });
    return cached;
  }

  const [pickedResult, userColsResult, metaList] = await Promise.allSettled([
    loadMyPickedSeriesFromSupabase(forceRefresh),
    listUserCollections(),
    listVideoUserMeta().catch(() => [] as VideoUserMetaRecord[]),
  ]);

  const picked = pickedResult.status === 'fulfilled' ? pickedResult.value : [];
  const userCols = userColsResult.status === 'fulfilled' ? userColsResult.value : [];
  const meta = metaList.status === 'fulfilled' ? metaList.value : [];

  const metaMap = Object.fromEntries(meta.map((m) => [m.sceneId, m]));

  // Pull every imported / user video up front so the home page can
  // detect orphan collectionIds (entries whose owning collection
  // was deleted on Supabase). Rescuing them to the default keeps
  // them visible — and lets the user re-import / clean up — instead
  // of leaving them as invisible ghosts that also block dedup.
  const [importedAll, userVideosAll] = await Promise.all([
    listImportedVideoPacks().catch(() => [] as ImportedVideoPackIndexEntry[]),
    listUserVideos().catch(() => [] as UserVideoEntry[]),
  ]);
  const validUserWireIds = new Set<string>(userCols.map((row) => encodeUserCollectionId(row.id)));
  const orphanCollectionIds = buildOrphanUserCollectionIds(
    [
      ...importedAll.map((e) => e.collectionId),
      ...userVideosAll.map((e) => e.collectionId),
    ],
    validUserWireIds,
  );
  if (orphanCollectionIds.size > 0) {
    logColTrace('orphan collectionIds rescued to default', {
      orphans: Array.from(orphanCollectionIds),
      rescuedCount: [
        ...importedAll.filter((e) => e.collectionId && orphanCollectionIds.has(e.collectionId)),
        ...userVideosAll.filter((e) => e.collectionId && orphanCollectionIds.has(e.collectionId)),
      ].length,
    });
  }

  // ── Official: enrich each subscribed row with episode count ──
  const officialSummaries: CollectionSummary[] = [];
  for (const p of picked) {
    if (!p.series || !p.series.is_published) continue;
    const episodes = await loadSeriesEpisodesFromSupabase(p.series.id);
    const summary = officialToSummary(p.series, episodes, metaMap, p);
    if (summary) officialSummaries.push(summary);
  }

  // ── User: enrich each collection with its video count from local SQLite ──
  const userSummaries: CollectionSummary[] = await Promise.all(userCols.map(async (uc) => {
    return await userCollectionToSummary(uc, metaMap, validUserWireIds, orphanCollectionIds);
  }));

  // Union + sort
  const combined = [...officialSummaries, ...userSummaries].sort((a, b) => {
    // Default user collection always last.
    if (a.isDefault && !b.isDefault) return 1;
    if (b.isDefault && !a.isDefault) return -1;
    if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
    return a.title.localeCompare(b.title, 'zh-Hans-CN');
  });

  logColTrace('home built', {
    officialCount: officialSummaries.length,
    userCount: userSummaries.length,
  });
  homeCache = { ts: Date.now(), data: combined };
  return combined;
}

// ── Internal: build CollectionSummary from a Supabase row + manifest ──

function officialToSummary(
  series: SupabaseSeriesRow,
  episodes: SupabaseEpisodeRow[],
  metaMap: Record<string, VideoUserMetaRecord>,
  picked: PickedSeriesDetail,
): CollectionSummary | null {
  const episodeIds = episodes
    .map((ep) => typeof ep.id === 'string' && ep.id.trim() ? ep.id.trim() : null)
    .filter((id): id is string => Boolean(id));

  let lastPracticedAt: number | undefined;
  let completedCount = 0;
  for (const epId of episodeIds) {
    const m = metaMap[epId];
    if (!m) continue;
    if (typeof m.lastPracticedAt === 'number') {
      if (lastPracticedAt == null || m.lastPracticedAt > lastPracticedAt) {
        lastPracticedAt = m.lastPracticedAt;
      }
      // video_user_meta doesn't track a "completed" boolean today;
      // we treat any recorded lastPracticedAt as a completion
      // signal for the per-episode progress bar. This will be
      // refined when the meta schema gains an explicit completedAt.
      completedCount += 1;
    }
  }
  if (lastPracticedAt == null && picked.row.last_practiced_at) {
    const ts = Date.parse(picked.row.last_practiced_at);
    if (Number.isFinite(ts)) lastPracticedAt = ts;
  }

  return {
    id: encodeCollectionId('official', series.id),
    kind: 'official',
    title: series.title,
    description: series.description ?? undefined,
    // `cover_url` on the Supabase row is a bare filename; the
    // manifest URL gives us the bucket + path prefix. Resolve
    // here so the card receives a fully-loadable image URL.
    coverImageUri: resolveSeriesCoverUrl(series.manifest_url, series.cover_url),
    videoCount: episodeIds.length,
    completedCount,
    lastActivityAt: lastPracticedAt,
    sortOrder: series.sort_order,
  };
}

async function userCollectionToSummary(
  uc: UserCollectionRow,
  metaMap: Record<string, VideoUserMetaRecord>,
  validUserWireIds: ReadonlySet<string>,
  orphanCollectionIds: ReadonlySet<string>,
): Promise<CollectionSummary> {
  // Pull every imported / user video and filter by collectionId.
  // Heavy — for the home page this only runs once per cache window
  // (60s), so it stays cheap.
  const [importedEntries, userVideoEntries] = await Promise.all([
    listImportedVideoPacks().catch(() => [] as ImportedVideoPackIndexEntry[]),
    listUserVideos().catch(() => [] as UserVideoEntry[]),
  ]);

  const ownId = encodeUserCollectionId(uc.id);
  const isDefault = uc.is_default;
  // Silence the unused-var linter — the parameter is reserved for
  // future use (e.g. when callers want a more specific filter).
  void validUserWireIds;

  let videoCount = 0;
  let completedCount = 0;
  let lastActivityAt: number | undefined;
  const consider = (videoId: string) => {
    videoCount += 1;
    const m = metaMap[videoId];
    if (m?.lastPracticedAt) {
      if (lastActivityAt == null || m.lastPracticedAt > lastActivityAt) {
        lastActivityAt = m.lastPracticedAt;
      }
      completedCount += 1;
    }
  };

  for (const entry of importedEntries) {
    if (matchesCollection(entry.collectionId, ownId, isDefault, orphanCollectionIds)) {
      consider(entry.id);
    }
  }
  for (const entry of userVideoEntries) {
    if (matchesCollection(entry.collectionId, ownId, isDefault, orphanCollectionIds)) {
      consider(entry.id);
    }
  }

  return {
    id: ownId,
    kind: 'user',
    title: uc.title,
    description: uc.description ?? undefined,
    coverImageUri: uc.cover_url ?? undefined,
    videoCount,
    completedCount,
    lastActivityAt,
    isDefault: uc.is_default,
    // User collections sort by creation; the default sinks to the
    // bottom by the comparator above.
    sortOrder: uc.is_default ? Number.MAX_SAFE_INTEGER : -Date.parse(uc.created_at),
  };
}

function matchesCollection(
  videoCollectionId: string | undefined,
  collectionWireId: string,
  isDefault: boolean,
  /**
   * Wire ids of user collections that USED to exist but no longer
   * do (e.g. deleted on Supabase, or belong to a different user_id
   * after a logout/login cycle). Entries whose `collectionId` is
   * in this set are "orphan" — they have no real owner, so we
   * re-bucket them under the default collection. This rescues
   * entries that pre-date the `collectionId` plumbing fix; without
   * this, they'd be invisible everywhere AND still match
   * `findDuplicateLocalVideoEntry` (blocking re-imports).
   */
  orphanCollectionIds: ReadonlySet<string> = new Set(),
): boolean {
  if (videoCollectionId && videoCollectionId === collectionWireId) return true;
  if (videoCollectionId && orphanCollectionIds.has(videoCollectionId)) {
    // Orphan: stale collectionId points to a deleted user
    // collection. Treat as uncategorized and fall through.
    return isDefault;
  }
  // Videos without a collectionId bucket under the default collection.
  if (!videoCollectionId && isDefault) return true;
  return false;
}

/**
 * Build the set of `user:N` wire ids that appear on video entries
 * but are NOT in `validUserWireIds`. These are the "orphans" —
 * entries whose owning collection was deleted (or never made it to
 * Supabase, e.g. left over from a previous build where the
 * `collectionId` plumbing was incomplete). They're rescued to the
 * default collection at read time.
 */
function buildOrphanUserCollectionIds(
  allVideoCollectionIds: Array<string | undefined>,
  validUserWireIds: ReadonlySet<string>,
): Set<string> {
  const orphans = new Set<string>();
  for (const id of allVideoCollectionIds) {
    if (typeof id !== 'string') continue;
    if (!id.startsWith('user:')) continue;
    if (validUserWireIds.has(id)) continue;
    orphans.add(id);
  }
  return orphans;
}

// ── Detail (one collection's contents) ─────────────────────────────

/**
 * Read the full content of a single collection. Branches on `kind`:
 *
 *   - `official`: reads the Supabase row, fetches the OSS manifest,
 *     expands each episode into a `CollectionVideoItem` with cover
 *     and duration.
 *   - `user`:     reads `user_collections` row, pulls every local
 *     video whose `collectionId` matches. User videos carry their
 *     full subtitle pipeline state on each item so the detail
 *     list can show progress / failure without an extra round
 *     trip to the index.
 *
 * Returns `null` if the collection doesn't exist or the user has no
 * access to it (e.g. official series that has been soft-deleted).
 */
export async function getCollectionDetail(
  wireId: string,
  forceRefresh: boolean = false,
): Promise<CollectionDetail | null> {
  const parsed = decodeCollectionId(wireId);
  if (!parsed) {
    warnColTrace('getCollectionDetail: bad wire id', { wireId });
    return null;
  }

  if (parsed.kind === 'official') {
    return getOfficialDetail(parsed.rawId, forceRefresh);
  }
  return getUserDetail(Number(parsed.rawId), forceRefresh);
}

async function getOfficialDetail(seriesId: string, forceRefresh: boolean): Promise<CollectionDetail | null> {
  const series = await getOfficialVideoSeriesById(seriesId, forceRefresh);
  if (!series) return null;

  // `getOfficialVideoSeriesById` already merges the OSS manifest
  // with the local `VideoSceneDetail` cache, so each episode here
  // has the full metadata (duration, cover, etc.). We re-sort by
  // episode index so the detail list matches the order the
  // series presents in the library.
  const sortedEpisodes = [...series.episodes].sort(
    (a, b) => (a.episodeIndex ?? 0) - (b.episodeIndex ?? 0),
  );
  // Pull per-scene binding + cache state from SQLite in one go.
  // Both queries are independent and small (<= 17 rows for the
  // current series), so we batch them. Errors are swallowed —
  // an unconfigured cloud drive just leaves the rows with no
  // binding data and the row chips fall back to the default
  // "未绑定 / 远端" copy.
  const sceneIdsForBinding = sortedEpisodes
    .map((ep) => (typeof ep.id === 'string' && ep.id.trim()) ? ep.id.trim() : null)
    .filter((id): id is string => Boolean(id));
  const { getOfficialSceneBindingStatusByScene } = await import('./cloud-binding-summary');
  const sceneBindingMap = await getOfficialSceneBindingStatusByScene(sceneIdsForBinding);

  const videos: CollectionVideoItem[] = sortedEpisodes
    .map((ep, index): CollectionVideoItem | null => {
      const id = typeof ep.id === 'string' && ep.id.trim() ? ep.id.trim() : null;
      if (!id) return null;
      const binding = sceneBindingMap[id];
      return {
        id,
        title: (typeof ep.episodeTitle === 'string' && ep.episodeTitle.trim())
          || id,
        coverImageUri: ep.coverImageUri,
        durationSeconds: ep.durationSeconds > 0 ? ep.durationSeconds : undefined,
        episodeIndex: index + 1,
        source: 'official',
        // Official series always: pre-shipped subtitle, pre-shipped
        // AI topics. Origin is always 'official'. Cache + binding
        // status come from the per-scene binding lookup above —
        // an unbound scene defaults to 'remote' for cache and
        // 'not_synced' for binding (so the row's chips show
        // "未绑定 / 远端" until the user authorises Baidu pan and
        // runs a rescan).
        origin: 'official',
        cacheStatus: binding?.cached ?? 'remote',
        subtitleStatus: 'ready',
        aiTopicStatus: 'pre-shipped',
        bindingStatus: binding?.bound ?? 'not_synced',
        bindingProvider: binding?.provider,
        bindingRemotePath: binding?.remotePath,
      };
    })
    .filter((v): v is CollectionVideoItem => v !== null);

  return {
    id: encodeCollectionId('official', seriesId),
    kind: 'official',
    title: series.title,
    description: series.description,
    coverImageUri: series.coverImageUri,
    videoCount: videos.length,
    isLocked: true,
    videos,
  };
}

async function getUserDetail(id: number, forceRefresh: boolean): Promise<CollectionDetail | null> {
  const all = await listUserCollections();
  const uc = all.find((row) => row.id === id);
  if (!uc) return null;

  const [importedEntries, userVideoEntries] = await Promise.all([
    listImportedVideoPacks().catch(() => [] as ImportedVideoPackIndexEntry[]),
    listUserVideos().catch(() => [] as UserVideoEntry[]),
  ]);

  // Build the set of currently-valid user collection wire ids so
  // we can detect orphan `user:N` references (entries whose
  // collectionId points to a deleted collection) and rescue them
  // to the default bucket. Without this, those entries are
  // invisible everywhere AND still block re-imports via dedup.
  const validUserWireIds = new Set<string>(all.map((row) => encodeUserCollectionId(row.id)));
  const orphanCollectionIds = buildOrphanUserCollectionIds(
    [
      ...importedEntries.map((e) => e.collectionId),
      ...userVideoEntries.map((e) => e.collectionId),
    ],
    validUserWireIds,
  );

  const ownId = encodeUserCollectionId(uc.id);
  const isDefault = uc.is_default;
  const videos: CollectionVideoItem[] = [];

  const push = (videoId: string, title: string, cover: string | undefined, duration: number | undefined, source: 'pack' | 'user-video', origin: 'pack' | 'baidu-pan' | 'local', cacheStatus: 'remote' | 'downloading' | 'cached', aiTopicStatus: 'pre-shipped' | 'ready' | 'none', subtitleStatus?: 'ready') => {
    // Caller has already filtered by `matchesCollection`; this is
    // a thin mapping helper. Packs always have their bundle on
    // local storage (cacheStatus='cached') and pre-shipped subtitle
    // / AI topic cards; user-video entries fill those from the
    // entry's runtime state.
    videos.push({
      id: videoId,
      title,
      coverImageUri: cover,
      durationSeconds: duration,
      source,
      origin,
      cacheStatus,
      aiTopicStatus,
      subtitleStatus,
    });
  };

  for (const entry of importedEntries) {
    if (matchesCollection(entry.collectionId, ownId, isDefault, orphanCollectionIds)) {
      // Packs: always local, pre-shipped subtitle + AI topics.
      push(
        entry.id,
        entry.title,
        entry.coverUri,
        entry.durationSeconds,
        'pack',
        'pack',
        'cached',
        entry.aiPracticeUri ? 'pre-shipped' : 'none',
        'ready',
      );
    }
  }
  for (const entry of userVideoEntries) {
    if (matchesCollection(entry.collectionId, ownId, isDefault, orphanCollectionIds)) {
      // User videos expose the 3-stage subtitle pipeline state on
      // the row so the list can show "生成中 32%" / "字幕 ✓" /
      // "字幕失败" without the user opening the detail page.
      // Packs have their subtitles pre-shipped and don't need any
      // of this state.
      // Cache status: local files are always cached; cloud
      // references depend on `cachedLocalUri`. (Downloads are not
      // surfaced as 'downloading' in the row yet — the user-video
      // entry doesn't track in-flight download progress; this
      // lights up in a follow-up when we add that state.)
      const origin: 'local' | 'baidu-pan' =
        entry.sourceType === 'local_file' ? 'local' : 'baidu-pan';
      const cacheStatus: 'remote' | 'cached' =
        origin === 'local' || entry.cachedLocalUri ? 'cached' : 'remote';
      videos.push({
        id: entry.id,
        title: entry.title,
        coverImageUri: entry.coverImageUri,
        durationSeconds: entry.durationSeconds,
        subtitleStatus: entry.subtitleStatus,
        subtitlePhase: entry.subtitlePhase,
        subtitlePhaseProgress: entry.subtitlePhaseProgress,
        subtitlePhaseMessage: entry.subtitlePhaseMessage,
        cachedLocalUri: entry.cachedLocalUri,
        source: 'user-video',
        origin,
        cacheStatus,
        // Mirror the entry's AI topic state onto the row so the
        // chip can show "生成中 32%" / "AI 话题失败" without the
        // user opening the detail page. Default 'none' for new
        // entries (the entry might not even have the field set
        // — zod leaves the optional field undefined and we want
        // the chip to light up as the actionable "AI 话题"
        // shortcut).
        aiTopicStatus: entry.aiPracticeStatus ?? 'none',
        aiTopicProgress: entry.aiPracticeProgress,
        aiTopicProgressMessage: entry.aiPracticeProgressMessage,
        aiTopicCount: entry.aiPracticeCount,
      });
    }
  }

  return {
    id: ownId,
    kind: 'user',
    title: uc.title,
    description: uc.description ?? undefined,
    coverImageUri: uc.cover_url ?? undefined,
    videoCount: videos.length,
    isLocked: false,
    isDefault: uc.is_default,
    videos,
  };
}

// ── Lookup helpers (for the import flow) ────────────────────────────

/**
 * Return the wire id that a freshly imported video should be tagged
 * with. Always returns the user's default collection (creating it
 * lazily on first import).
 */
export async function getDefaultCollectionWireId(): Promise<string> {
  const row = await getOrCreateDefaultCollection();
  return encodeUserCollectionId(row.id);
}

export { listUserCollections };
