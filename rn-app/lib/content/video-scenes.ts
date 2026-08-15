import type { ScenarioCard } from '../ai/scenario-generator';
import { deriveTaskContract, type ScenarioTaskContract } from '../ai/conversation-runtime';
import { parseJson3Subtitles, type EnglishSegmentedSubtitles, type SubtitleTranslations } from './json3-parser';
import {
  getImportedVideoPackEntryById,
  listImportedVideoPacks,
  readImportedVideoPackJson,
  type ImportedVideoPackIndexEntry,
} from './imported-video-packs';
import {
  getDefaultCloudProvider,
  getDownloadedSceneSource,
  getOfficialSceneProviderStates,
  type CloudVideoProvider,
  type OfficialSceneAssetKeys,
  type VideoSourceProviderState,
} from './cloud-drive-bindings';
import { resolveCloudReferencedVideoSource } from './cloud-video-playback';
import {
  getUserVideoEntryById,
  listUserVideos,
  type UserVideoEntry,
} from './user-videos';
import {
  deleteSceneInfoCache,
  listCachedSceneIds,
  loadAllSceneInfoCache,
  loadCatalogCache,
  loadSceneInfoCache,
  saveCatalogCache,
  saveSceneInfoCache,
  type CachedSceneInfo,
} from '../database/video-cache';
import {
  loadEpisodeByIdFromSupabase,
  loadEpisodeSeriesIdFromSupabase,
  loadPublishedSeriesFromSupabase,
  loadSeriesByIdFromSupabase,
  loadSeriesEpisodesFromSupabase,
  listAiPracticeCardsFromSupabase,
  resolveEpisodeAssetUrl,
  resolveSeriesCoverUrl,
  type SupabaseAiPracticeRow,
  type SupabaseEpisodeRow,
  type SupabaseSeriesRow,
} from './video-series-supabase';

const OFFICIAL_VIDEO_CATALOG_URL = 'https://nativeos.oss-cn-beijing.aliyuncs.com/videos/official-video-catalog.json';
const VIDEO_SCENE_LOG_PREFIX = '[VideoScenes]';

function logVideoSceneTrace(message: string, payload?: unknown) {
  if (payload === undefined) {
    console.log(`${VIDEO_SCENE_LOG_PREFIX} ${message}`);
    return;
  }
  console.log(`${VIDEO_SCENE_LOG_PREFIX} ${message}`, payload);
}

function warnVideoSceneTrace(message: string, payload?: unknown) {
  if (payload === undefined) {
    console.warn(`${VIDEO_SCENE_LOG_PREFIX} ${message}`);
    return;
  }
  console.warn(`${VIDEO_SCENE_LOG_PREFIX} ${message}`, payload);
}

interface RemoteFetchOptions {
  forceRefresh?: boolean;
  cacheBust?: string;
}

interface OfficialVideoAssetBundle {
  video?: string;
  subtitleJson3?: string;
  subtitleEnSegmented?: string;
  subtitleZh?: string;
  info?: string;
  aiPractice?: string;
}

interface OfficialVideoCatalogSeriesEntry {
  id?: string;
  title?: string;
  level?: string;
  category?: string;
  type?: string;
  description?: string;
  coverUrl?: string;
  tags?: string[];
  sortOrder?: number;
  episodeCount?: number;
  sourceLabel?: string;
  manifestUrl?: string;
}

interface OfficialVideoCatalogStandaloneItem {
  id?: string;
  title?: string;
  level?: string;
  category?: string;
  type?: string;
  sourceLabel?: string;
  coverUrl?: string;
  hasRoleplay?: boolean;
  taskContract?: Partial<ScenarioTaskContract>;
  assets?: OfficialVideoAssetBundle;
}

interface OfficialVideoCatalog {
  version?: number;
  updatedAt?: string;
  resourceBaseUrl?: string;
  series?: OfficialVideoCatalogSeriesEntry[];
  standalone?: OfficialVideoCatalogStandaloneItem[];
  standaloneManifestUrl?: string;
}

interface OfficialVideoSeriesMeta {
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
}

interface OfficialVideoSeriesEpisode {
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
  taskContract?: Partial<ScenarioTaskContract>;
  assets?: OfficialVideoAssetBundle;
}

interface OfficialVideoSeriesManifest {
  version?: number;
  updatedAt?: string;
  resourceBaseUrl?: string;
  series?: OfficialVideoSeriesMeta;
  episodes?: OfficialVideoSeriesEpisode[];
}

interface OfficialVideoStandaloneManifest {
  version?: number;
  updatedAt?: string;
  resourceBaseUrl?: string;
  items?: OfficialVideoCatalogStandaloneItem[];
  standalone?: OfficialVideoCatalogStandaloneItem[];
}

interface OssVideoManifestItem {
  id: string;
  title: string;
  level: string;
  category: string;
  type: 'vlog' | 'dialogue' | 'lecture' | 'film' | 'interview' | string;
  sourceLabel?: string;
  assetBaseUrl?: string;
  groupId?: string;
  groupTitle?: string;
  groupLevel?: string;
  groupDescription?: string;
  groupCoverUrl?: string;
  groupTags?: string[];
  groupSortOrder?: number;
  episodeIndex?: number;
  episodeTitle?: string;
  videoKey: string;
  subtitleKey: string;
  subtitleEnSegmentedKey?: string;
  infoKey?: string;
  coverUrl?: string;
  hasRoleplay?: boolean;
  aiPracticeKey?: string;
  subtitleZhKey?: string;
  taskContract?: Partial<ScenarioTaskContract>;
}

interface OssVideoManifest {
  version: number;
  bucketBaseUrl: string;
  items: OssVideoManifestItem[];
}

interface OssAiPracticeCard {
  id?: string;
  icon?: string;
  category?: string;
  level?: string;
  title?: string;
  desc?: string;
  descZh?: string;
  npcEmoji?: string;
  npcName?: string;
  npcStatus?: string;
  openingLine?: string;
  openingLineZh?: string;
  environmentalCue?: string;
  environmentalCueEn?: string;
  npcSystemPrompt?: string;
  taskContract?: Partial<ScenarioTaskContract>;
  userInitiates?: boolean;
}

interface OssAiPracticeFile {
  items?: OssAiPracticeCard[];
  cards?: OssAiPracticeCard[];
}

interface YoutubeInfoJson {
  title?: string;
  fulltitle?: string;
  description?: string;
  thumbnail?: string;
  duration?: number;
  duration_string?: string;
  uploader?: string;
  playlist_title?: string;
}

let manifestCache: OssVideoManifest | null = null;
let featuredScenesCache: VideoSceneDetail[] | null = null;
const remoteSceneCache = new Map<string, VideoSceneDetail>();
const importedSceneCache = new Map<string, VideoSceneDetail>();
const aiPracticeCache = new Map<string, ScenarioCard[]>();
/**
 * Cache for scenes built from Supabase episode rows. The episode's
 * parent series row provides `manifest_url` (the OSS base), so we
 * can resolve subtitle/cover/AI URLs the same way the OSS-manifest
 * path does. Keyed by episode id.
 */
const supabaseSceneCache = new Map<string, VideoSceneDetail>();

export function invalidateVideoSceneCaches(ids?: string[]) {
  manifestCache = null;
  featuredScenesCache = null;
  if (!ids || ids.length === 0) {
    remoteSceneCache.clear();
    importedSceneCache.clear();
    supabaseSceneCache.clear();
    return;
  }
  ids.forEach((id) => {
    remoteSceneCache.delete(id);
    importedSceneCache.delete(id);
    supabaseSceneCache.delete(id);
  });
}

export interface VideoSceneRole {
  title: string;
  description: string;
  tone: string;
}

export interface WordTiming {
  text: string;
  startMs: number;
  endMs: number;
  charStart: number;
  charEnd: number;
}

export interface VideoSceneSegment {
  id: string;
  startMs: number;
  endMs: number;
  speaker: 'npc' | 'user' | 'narration';
  text: string;
  textZh: string;
  intent?: string;
  words?: WordTiming[];
}

export interface VideoSceneDetail {
  id: string;
  sourceLabel: string;
  durationSeconds: number;
  coverAccent: string;
  coverImageUri?: string;
  contentOrigin?: 'official' | 'imported';
  subtitleStatus?: 'none' | 'pending' | 'processing' | 'ready' | 'error';
  subtitleCursorMs?: number;
  /** 3-stage pipeline state for imported video subtitle generation. */
  subtitlePhase?: 'downloading' | 'extracting' | 'asr';
  /** 0..1 progress for the current `subtitlePhase` (best-effort). */
  subtitlePhaseProgress?: number;
  /** Human-readable progress message (e.g. "下载 88MB / 250MB"). */
  subtitlePhaseMessage?: string;
  /** Total minutes charged (rounded up) for the most recent run. */
  subtitleChargedMinutes?: number;
  /** Local cached copy of the cloud video (after download). When set,
   *  subtitle generation can run locally without re-downloading. */
  cachedLocalUri?: string;
  groupId?: string;
  groupTitle?: string;
  groupLevel?: string;
  groupDescription?: string;
  groupCoverImageUri?: string;
  groupTags?: string[];
  groupSortOrder?: number;
  episodeIndex?: number;
  episodeTitle?: string;
  totalEpisodesInGroup?: number;
  officialAssetKeys?: OfficialSceneAssetKeys;
  availableCloudProviders?: VideoSourceProviderState[];
  selectedCloudProvider?: CloudVideoProvider | null;
  videoUri?: string;
  videoHeaders?: Record<string, string>;
  videoContentType?: 'auto' | 'hls';
  videoOverrideFileExtensionAndroid?: string;
  videoAsset?: number;
  videoFileName?: string;
  subtitleFileName?: string;
  videoSourcePath?: string;
  cloudRemotePath?: string;
  subtitleSourcePath?: string;
  clipStartMs?: number;
  clipEndMs?: number;
  transcriptSource?: 'mock' | 'youtube_json3';
  card: ScenarioCard;
  aiPracticeCards?: ScenarioCard[];
  userRole: VideoSceneRole;
  npcRole: VideoSceneRole;
  goals: string[];
  segments: VideoSceneSegment[];
}

export type OfficialSceneCatalogItem = {
  id: string;
  title: string;
  level: string;
  category: string;
  type: string;
  groupId?: string;
  groupTitle?: string;
  groupLevel?: string;
  episodeIndex?: number;
  episodeTitle?: string;
  videoKey: string;
  subtitleKey: string;
  subtitleEnSegmentedKey?: string;
  subtitleZhKey?: string;
};

export async function listOfficialSceneCatalog(forceRefresh: boolean = false): Promise<OfficialSceneCatalogItem[]> {
  const cacheBust = forceRefresh ? `${Date.now()}` : undefined;
  const manifest = await getOssManifest({ forceRefresh, cacheBust });
  return manifest.items.map((item) => ({
    id: item.id,
    title: item.title,
    level: item.level,
    category: item.category,
    type: item.type,
    groupId: item.groupId,
    groupTitle: item.groupTitle,
    groupLevel: item.groupLevel,
    episodeIndex: item.episodeIndex,
    episodeTitle: item.episodeTitle,
    videoKey: item.videoKey,
    subtitleKey: item.subtitleKey,
    subtitleEnSegmentedKey: item.subtitleEnSegmentedKey,
    subtitleZhKey: item.subtitleZhKey,
  }));
}

function sanitizeUserVideoSegments(segments: VideoSceneSegment[], durationSeconds?: number) {
  const maxDurationMs = typeof durationSeconds === 'number' && durationSeconds > 0
    ? Math.round(durationSeconds * 1000)
    : null;
  return segments.filter((segment) => {
    if (!Number.isFinite(segment.startMs) || !Number.isFinite(segment.endMs)) {
      return false;
    }
    if (segment.endMs <= segment.startMs || segment.startMs < 0) {
      return false;
    }
    if (maxDurationMs == null) {
      return true;
    }
    return segment.startMs < maxDurationMs + 800 && segment.endMs <= maxDurationMs + 2000;
  });
}

function appendCacheBust(url: string, cacheBust?: string) {
  if (!cacheBust) return url;
  return `${url}${url.includes('?') ? '&' : '?'}t=${encodeURIComponent(cacheBust)}`;
}

function isAbsoluteUrl(value?: string) {
  return typeof value === 'string' && /^https?:\/\//i.test(value.trim());
}

function getUrlDirectory(url: string) {
  const withoutQuery = url.split('?')[0] || url;
  const normalized = withoutQuery.endsWith('/') ? withoutQuery.slice(0, -1) : withoutQuery;
  const slashIndex = normalized.lastIndexOf('/');
  return slashIndex >= 0 ? normalized.slice(0, slashIndex) : normalized;
}

function normalizeAssetPath(path?: string) {
  if (typeof path !== 'string') return undefined;
  const trimmed = path.trim();
  if (!trimmed) return undefined;
  return trimmed.replace(/^\/+/, '');
}

function buildOssObjectUrl(baseUrl: string, objectKey: string, cacheBust?: string) {
  if (isAbsoluteUrl(objectKey)) {
    return appendCacheBust(objectKey.trim(), cacheBust);
  }
  const normalizedKey = objectKey.replace(/^\/+/, '');
  const objectUrl = `${baseUrl}/${normalizedKey.split('/').map((part) => encodeURIComponent(part)).join('/')}`;
  return appendCacheBust(objectUrl, cacheBust);
}

function resolveUrl(baseUrl: string, maybeRelative?: string) {
  if (typeof maybeRelative !== 'string' || !maybeRelative.trim()) {
    return undefined;
  }
  return buildOssObjectUrl(baseUrl, maybeRelative.trim());
}

function normalizeSeriesEpisodeItem(
  episode: OfficialVideoSeriesEpisode,
  seriesMeta: OfficialVideoSeriesMeta | undefined,
  baseUrl: string,
): OssVideoManifestItem | null {
  const videoKey = normalizeAssetPath(episode.assets?.video);
  const subtitleKey = normalizeAssetPath(episode.assets?.subtitleJson3);
  const subtitleEnSegmentedKey = normalizeAssetPath(episode.assets?.subtitleEnSegmented);
  if (!videoKey || !subtitleKey) {
    return null;
  }
  const seriesId = typeof seriesMeta?.id === 'string' && seriesMeta.id.trim() ? seriesMeta.id.trim() : undefined;
  const seriesTitle = typeof seriesMeta?.title === 'string' && seriesMeta.title.trim() ? seriesMeta.title.trim() : undefined;
  const fallbackTitle = typeof episode.episodeTitle === 'string' && episode.episodeTitle.trim()
    ? episode.episodeTitle.trim()
    : seriesTitle || 'Official Video Episode';
  return {
    id: typeof episode.id === 'string' && episode.id.trim() ? episode.id.trim() : `${seriesId || 'series'}__${episode.episodeIndex || fallbackTitle}`,
    title: typeof episode.title === 'string' && episode.title.trim() ? episode.title.trim() : fallbackTitle,
    level: typeof episode.level === 'string' && episode.level.trim()
      ? episode.level.trim()
      : typeof seriesMeta?.level === 'string' && seriesMeta.level.trim()
        ? seriesMeta.level.trim()
        : 'B1',
    category: typeof episode.category === 'string' && episode.category.trim()
      ? episode.category.trim()
      : typeof seriesMeta?.category === 'string' && seriesMeta.category.trim()
        ? seriesMeta.category.trim()
        : '综合',
    type: typeof episode.type === 'string' && episode.type.trim()
      ? episode.type.trim()
      : typeof seriesMeta?.type === 'string' && seriesMeta.type.trim()
        ? seriesMeta.type.trim()
        : 'vlog',
    sourceLabel: typeof episode.sourceLabel === 'string' && episode.sourceLabel.trim()
      ? episode.sourceLabel.trim()
      : typeof seriesMeta?.sourceLabel === 'string' && seriesMeta.sourceLabel.trim()
        ? seriesMeta.sourceLabel.trim()
        : undefined,
    assetBaseUrl: baseUrl,
    groupId: seriesId,
    groupTitle: seriesTitle,
    groupLevel: typeof seriesMeta?.level === 'string' && seriesMeta.level.trim() ? seriesMeta.level.trim() : undefined,
    groupDescription: typeof seriesMeta?.description === 'string' && seriesMeta.description.trim() ? seriesMeta.description.trim() : undefined,
    groupCoverUrl: resolveUrl(baseUrl, seriesMeta?.coverUrl),
    groupTags: Array.isArray(seriesMeta?.tags) ? seriesMeta.tags.filter((tag): tag is string => typeof tag === 'string' && tag.trim().length > 0) : undefined,
    groupSortOrder: typeof seriesMeta?.sortOrder === 'number' && Number.isFinite(seriesMeta.sortOrder) ? seriesMeta.sortOrder : undefined,
    episodeIndex: typeof episode.episodeIndex === 'number' && Number.isFinite(episode.episodeIndex) ? episode.episodeIndex : undefined,
    episodeTitle: typeof episode.episodeTitle === 'string' && episode.episodeTitle.trim() ? episode.episodeTitle.trim() : undefined,
    videoKey,
    subtitleKey,
    subtitleEnSegmentedKey,
    infoKey: normalizeAssetPath(episode.assets?.info),
    coverUrl: resolveUrl(baseUrl, episode.coverUrl),
    hasRoleplay: episode.hasRoleplay === true,
    aiPracticeKey: normalizeAssetPath(episode.assets?.aiPractice),
    subtitleZhKey: normalizeAssetPath(episode.assets?.subtitleZh),
    taskContract: episode.taskContract,
  };
}

function normalizeStandaloneItem(item: OfficialVideoCatalogStandaloneItem, baseUrl: string): OssVideoManifestItem | null {
  const videoKey = normalizeAssetPath(item.assets?.video);
  const subtitleKey = normalizeAssetPath(item.assets?.subtitleJson3);
  const subtitleEnSegmentedKey = normalizeAssetPath(item.assets?.subtitleEnSegmented);
  if (!videoKey || !subtitleKey) {
    return null;
  }
  return {
    id: typeof item.id === 'string' && item.id.trim() ? item.id.trim() : `official-${videoKey.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`,
    title: typeof item.title === 'string' && item.title.trim() ? item.title.trim() : videoKey,
    level: typeof item.level === 'string' && item.level.trim() ? item.level.trim() : 'B1',
    category: typeof item.category === 'string' && item.category.trim() ? item.category.trim() : '综合',
    type: typeof item.type === 'string' && item.type.trim() ? item.type.trim() : 'vlog',
    sourceLabel: typeof item.sourceLabel === 'string' && item.sourceLabel.trim() ? item.sourceLabel.trim() : undefined,
    assetBaseUrl: baseUrl,
    videoKey,
    subtitleKey,
    subtitleEnSegmentedKey,
    infoKey: normalizeAssetPath(item.assets?.info),
    coverUrl: resolveUrl(baseUrl, item.coverUrl),
    hasRoleplay: item.hasRoleplay === true,
    aiPracticeKey: normalizeAssetPath(item.assets?.aiPractice),
    subtitleZhKey: normalizeAssetPath(item.assets?.subtitleZh),
    taskContract: item.taskContract,
  };
}

function inferVideoIcon(item: OssVideoManifestItem) {
  if (item.type === 'film') return '🎬';
  if (item.type === 'dialogue') return '🗣️';
  if (item.type === 'lecture') return '🎓';
  if (item.category.includes('旅行')) return '🧳';
  if (item.category.includes('社交')) return '💬';
  if (item.category.includes('学习')) return '📘';
  if (item.category.includes('影视')) return '🎞️';
  return '📹';
}

function inferCoverAccent(item: OssVideoManifestItem) {
  if (item.type === 'film') return '#F59E0B';
  if (item.type === 'dialogue') return '#3B82F6';
  if (item.type === 'lecture') return '#10B981';
  if (item.category.includes('旅行')) return '#06B6D4';
  if (item.category.includes('社交')) return '#8B5CF6';
  return '#6366F1';
}

function getItemAssetBaseUrl(item: OssVideoManifestItem, fallbackBaseUrl: string) {
  return typeof item.assetBaseUrl === 'string' && item.assetBaseUrl.trim()
    ? item.assetBaseUrl.trim().replace(/\/$/, '')
    : fallbackBaseUrl;
}

function buildDescriptionExcerpt(description?: string) {
  if (!description) return '';
  const cleaned = description.replace(/\s+/g, ' ').trim();
  if (!cleaned) return '';
  return cleaned.length > 120 ? `${cleaned.slice(0, 117).trimEnd()}...` : cleaned;
}

function mapOssAiPracticeCard(item: OssVideoManifestItem, raw: OssAiPracticeCard, index: number): ScenarioCard {
  const userInitiates = raw.userInitiates === true;
  const openingLine = userInitiates ? undefined : raw.openingLine;
  const environmentalCue = userInitiates ? raw.environmentalCue : undefined;
  const environmentalCueEn = userInitiates ? raw.environmentalCueEn : undefined;
  return {
    id: raw.id || `${item.id}__ai__${index + 1}`,
    sourceType: 'ai_scenario',
    icon: raw.icon || '💬',
    category: raw.category || item.category,
    level: raw.level || item.level,
    title: raw.title || `视频延展 ${index + 1}`,
    desc: raw.desc || `Continue the same topic after watching this ${item.category} video.`,
    descZh: raw.descZh,
    npcEmoji: raw.npcEmoji,
    npcName: raw.npcName,
    npcStatus: raw.npcStatus,
    openingLine,
    openingLineZh: userInitiates ? undefined : raw.openingLineZh,
    environmentalCue,
    environmentalCueEn,
    npcSystemPrompt: raw.npcSystemPrompt,
    taskContract: deriveTaskContract({
      title: raw.title || `视频延展 ${index + 1}`,
      desc: raw.desc || `Continue the same topic after watching this ${item.category} video.`,
      category: raw.category || item.category,
      npcName: raw.npcName,
      npcStatus: raw.npcStatus,
      npcSystemPrompt: raw.npcSystemPrompt,
      openingLine,
      environmentalCue,
      environmentalCueEn,
    }, raw.taskContract),
    userInitiates,
  };
}

/**
 * Map a `SupabaseAiPracticeRow` (snake_case) to the rn-app's
 * `ScenarioCard` shape. Mirrors `mapOssAiPracticeCard` column-by-
 * column so the player doesn't care which source the cards came
 * from.
 */
function mapSupabaseAiPracticeCard(
  item: OssVideoManifestItem,
  raw: SupabaseAiPracticeRow,
  index: number,
): ScenarioCard {
  const userInitiates = raw.user_initiates === true;
  const openingLine = userInitiates ? undefined : (raw.opening_line ?? undefined);
  const environmentalCue = userInitiates ? (raw.environmental_cue ?? undefined) : undefined;
  const environmentalCueEn = userInitiates ? (raw.environmental_cue_en ?? undefined) : undefined;
  return {
    id: raw.id || `${item.id}__ai__${index + 1}`,
    sourceType: 'ai_scenario',
    icon: raw.icon || '💬',
    category: raw.category || item.category,
    level: raw.level || item.level,
    title: raw.title || `视频延展 ${index + 1}`,
    desc: raw.description || `Continue the same topic after watching this ${item.category} video.`,
    descZh: raw.description_zh ?? undefined,
    npcEmoji: raw.npc_emoji ?? undefined,
    npcName: raw.npc_name ?? undefined,
    npcStatus: raw.npc_status ?? undefined,
    openingLine,
    openingLineZh: userInitiates ? undefined : (raw.opening_line_zh ?? undefined),
    environmentalCue,
    environmentalCueEn,
    npcSystemPrompt: raw.npc_system_prompt ?? undefined,
    taskContract: deriveTaskContract({
      title: raw.title || `视频延展 ${index + 1}`,
      desc: raw.description || `Continue the same topic after watching this ${item.category} video.`,
      category: raw.category || item.category,
      npcName: raw.npc_name ?? undefined,
      npcStatus: raw.npc_status ?? undefined,
      npcSystemPrompt: raw.npc_system_prompt ?? undefined,
      openingLine,
      environmentalCue,
      environmentalCueEn,
    }, (raw.task_contract as Partial<ScenarioTaskContract> | null) ?? undefined),
    userInitiates,
  };
}

/**
 * Supabase-first AI practice loader. Tries `official_video_ai_practice`
 * for the (series_id, episode_id) pair; if Supabase returns 0 rows
 * (e.g. the episode was migrated by the desktop but the cards weren't
 * yet, or the player is running against a pre-migration series),
 * falls back to the OSS-hosted `.ai-practice.json` so the player
 * doesn't go blank.
 */
async function loadSupabaseAiPracticeCards(
  seriesId: string,
  episodeId: string,
  baseUrl: string,
  item: OssVideoManifestItem,
): Promise<ScenarioCard[]> {
  if (!seriesId || !episodeId) return [];
  try {
    const rows = await listAiPracticeCardsFromSupabase(seriesId, episodeId);
    if (rows.length > 0) {
      return rows
        .map((row, index) => mapSupabaseAiPracticeCard(item, row, index))
        .filter((card) => Boolean(card.title));
    }
  } catch (err) {
    warnVideoSceneTrace('loadSupabaseAiPracticeCards threw, falling back to OSS', {
      seriesId,
      episodeId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  // Fallback: OSS .ai-practice.json (read-only legacy cache)
  return loadAiPracticeCards(baseUrl, item);
}

async function loadAiPracticeCards(baseUrl: string, item: OssVideoManifestItem, options?: RemoteFetchOptions): Promise<ScenarioCard[]> {
  if (!options?.forceRefresh && aiPracticeCache.has(item.id)) {
    return aiPracticeCache.get(item.id)!;
  }
  if (!item.aiPracticeKey) {
    return [];
  }

  const assetBaseUrl = getItemAssetBaseUrl(item, baseUrl);
  // v5: SQLite cache first.
  if (!options?.forceRefresh) {
    const cached = await loadSceneInfoCache(item.id);
    if (cached && cached.aiPracticeCards !== null) {
      const cards = cached.aiPracticeCards as unknown as ScenarioCard[];
      aiPracticeCache.set(item.id, cards);
      return cards;
    }
  }

  try {
    const file = await fetchJson<OssAiPracticeFile | OssAiPracticeCard[]>(buildOssObjectUrl(assetBaseUrl, item.aiPracticeKey, options?.cacheBust));
    const rawCards = Array.isArray(file)
      ? file
      : Array.isArray(file.items)
          ? file.items
          : Array.isArray(file.cards)
              ? file.cards
              : [];
    const cards = rawCards
      .map((card, index) => mapOssAiPracticeCard(item, card, index))
      .filter((card) => Boolean(card.title));
    aiPracticeCache.set(item.id, cards);
    // v5: persist alongside info cache. Keeps the two co-located
    // on one row (fire-and-forget, non-fatal).
    void saveSceneInfoCache({ sceneId: item.id, assetBaseUrl, aiPracticeCards: cards }).catch(() => { /* non-fatal */ });
    return cards;
  } catch {
    return [];
  }
}

function buildImportedManifestItem(entry: ImportedVideoPackIndexEntry): OssVideoManifestItem {
  return {
    id: entry.id,
    title: entry.title,
    level: entry.level,
    category: entry.category,
    type: entry.type,
    sourceLabel: entry.sourceLabel,
    videoKey: entry.videoFileName,
    subtitleKey: entry.subtitleJson3FileName,
    infoKey: entry.infoFileName,
    coverUrl: entry.coverUri,
    hasRoleplay: entry.hasRoleplay,
    aiPracticeKey: entry.aiPracticeFileName,
    subtitleEnSegmentedKey: entry.subtitleEnSegmentedFileName,
    subtitleZhKey: entry.subtitleZhFileName,
  };
}

function buildUserVideoManifestItem(entry: UserVideoEntry): OssVideoManifestItem {
  const fileName = entry.localFileName || entry.remoteFileName || entry.title;
  return {
    id: entry.id,
    title: entry.title,
    level: entry.level,
    category: entry.category,
    type: entry.type,
    sourceLabel: entry.sourceLabel,
    videoKey: fileName,
    subtitleKey: entry.subtitleUri || fileName,
    coverUrl: entry.coverImageUri,
    hasRoleplay: false,
  };
}

async function loadImportedInfoJson(entry: ImportedVideoPackIndexEntry) {
  return readImportedVideoPackJson<YoutubeInfoJson>(entry.infoUri);
}

async function loadImportedAiPracticeCards(entry: ImportedVideoPackIndexEntry, item: OssVideoManifestItem): Promise<ScenarioCard[]> {
  if (!entry.aiPracticeUri) {
    return [];
  }
  try {
    const file = await readImportedVideoPackJson<OssAiPracticeFile | OssAiPracticeCard[]>(entry.aiPracticeUri);
    const rawCards = Array.isArray(file)
      ? file
      : Array.isArray(file?.items)
        ? file.items
        : Array.isArray(file?.cards)
          ? file.cards
          : [];
    return rawCards
      .map((card, index) => mapOssAiPracticeCard(item, card, index))
      .filter((card) => Boolean(card.title));
  } catch {
    return [];
  }
}

async function buildImportedVideoSceneSummary(entry: ImportedVideoPackIndexEntry): Promise<VideoSceneDetail> {
  const item = buildImportedManifestItem(entry);
  const info = await loadImportedInfoJson(entry);
  const roles = buildRoles(item);
  const aiPracticeCards = await loadImportedAiPracticeCards(entry, item);
  return {
    id: entry.id,
    sourceLabel: entry.sourceLabel,
    durationSeconds: typeof entry.durationSeconds === 'number'
      ? entry.durationSeconds
      : typeof info?.duration === 'number'
        ? info.duration
        : 0,
    coverAccent: inferCoverAccent(item),
    coverImageUri: entry.coverUri || info?.thumbnail,
    contentOrigin: 'imported',
    availableCloudProviders: [],
    selectedCloudProvider: null,
    videoUri: entry.videoUri,
    videoFileName: entry.videoFileName,
    subtitleFileName: entry.subtitleJson3FileName,
    videoSourcePath: entry.videoUri,
    subtitleSourcePath: entry.subtitleJson3Uri,
    transcriptSource: 'youtube_json3',
    card: buildScenarioCard(item, info),
    aiPracticeCards,
    userRole: roles.userRole,
    npcRole: roles.npcRole,
    goals: buildGoals(item),
    segments: [],
  };
}

async function buildUserVideoSceneSummary(entry: UserVideoEntry): Promise<VideoSceneDetail> {
  const item = buildUserVideoManifestItem(entry);
  const roles = buildRoles(item);
  return {
    id: entry.id,
    sourceLabel: entry.sourceLabel,
    durationSeconds: entry.durationSeconds ?? 0,
    coverAccent: entry.sourceType === 'cloud_reference' ? '#2563EB' : '#7C3AED',
    coverImageUri: entry.coverImageUri,
    contentOrigin: 'imported',
    subtitleStatus: entry.subtitleStatus,
    subtitleCursorMs: entry.subtitleCursorMs,
    subtitlePhase: entry.subtitlePhase,
    subtitlePhaseProgress: entry.subtitlePhaseProgress,
    subtitlePhaseMessage: entry.subtitlePhaseMessage,
    subtitleChargedMinutes: entry.subtitleChargedMinutes,
    cachedLocalUri: entry.cachedLocalUri,
    availableCloudProviders: [],
    selectedCloudProvider: entry.sourceType === 'cloud_reference' ? entry.provider ?? null : null,
    videoUri: entry.localVideoUri,
    videoHeaders: undefined,
    videoContentType: undefined,
    videoOverrideFileExtensionAndroid: undefined,
    videoFileName: entry.localFileName || entry.remoteFileName || entry.title,
    subtitleFileName: entry.subtitleUri?.split('/').pop(),
    videoSourcePath: entry.localVideoUri || entry.remotePath,
    cloudRemotePath: entry.remotePath,
    subtitleSourcePath: entry.subtitleUri,
    transcriptSource: entry.subtitleUri ? 'youtube_json3' : 'mock',
    card: buildScenarioCard(item, null),
    aiPracticeCards: undefined,
    userRole: roles.userRole,
    npcRole: roles.npcRole,
    goals: buildGoals(item),
    segments: [],
  };
}

async function buildImportedVideoSceneDetail(entry: ImportedVideoPackIndexEntry): Promise<VideoSceneDetail> {
  if (importedSceneCache.has(entry.id)) {
    return importedSceneCache.get(entry.id)!;
  }

  const item = buildImportedManifestItem(entry);
  const [info, subtitleJson, englishSegments, zhTranslations, aiPracticeCards] = await Promise.all([
    loadImportedInfoJson(entry),
    readImportedVideoPackJson<Record<string, unknown>>(entry.subtitleJson3Uri),
    entry.subtitleEnSegmentedUri
      ? readImportedVideoPackJson<EnglishSegmentedSubtitles>(entry.subtitleEnSegmentedUri).catch(() => null)
      : Promise.resolve(null),
    readImportedVideoPackJson<SubtitleTranslations>(entry.subtitleZhUri),
    loadImportedAiPracticeCards(entry, item),
  ]);

  if (!subtitleJson) {
    throw new Error(`Imported subtitle json3 missing for ${entry.id}`);
  }

  const roles = buildRoles(item);
  const detail: VideoSceneDetail = {
    id: entry.id,
    sourceLabel: entry.sourceLabel,
    durationSeconds: typeof entry.durationSeconds === 'number'
      ? entry.durationSeconds
      : typeof info?.duration === 'number'
        ? info.duration
        : 0,
    coverAccent: inferCoverAccent(item),
    coverImageUri: entry.coverUri || info?.thumbnail,
    contentOrigin: 'imported',
    availableCloudProviders: [],
    selectedCloudProvider: null,
    videoUri: entry.videoUri,
    videoFileName: entry.videoFileName,
    subtitleFileName: entry.subtitleJson3FileName,
    videoSourcePath: entry.videoUri,
    subtitleSourcePath: entry.subtitleJson3Uri,
    transcriptSource: 'youtube_json3',
    card: buildScenarioCard(item, info),
    aiPracticeCards,
    userRole: roles.userRole,
    npcRole: roles.npcRole,
    goals: buildGoals(item),
    segments: parseJson3Subtitles(subtitleJson, zhTranslations ?? undefined, englishSegments ?? undefined),
  };

  importedSceneCache.set(entry.id, detail);
  return detail;
}

async function buildUserVideoSceneDetail(entry: UserVideoEntry): Promise<VideoSceneDetail> {
  const shouldUseCache = entry.subtitleStatus !== 'processing';
  if (shouldUseCache && importedSceneCache.has(entry.id)) {
    return importedSceneCache.get(entry.id)!;
  }

  const summary = await buildUserVideoSceneSummary(entry);
  let resolvedVideoUri = entry.localVideoUri;
  let resolvedVideoHeaders = summary.videoHeaders;
  let resolvedVideoContentType = summary.videoContentType;
  let resolvedVideoOverrideFileExtensionAndroid = summary.videoOverrideFileExtensionAndroid;
  let selectedCloudProvider = summary.selectedCloudProvider;
  let resolvedVideoSourcePath = summary.videoSourcePath;
  let segments: VideoSceneSegment[] = [];

  if (entry.sourceType === 'cloud_reference' && entry.provider && entry.remotePath) {
    const cachedEntry = await getDownloadedSceneSource(entry.id, entry.provider);
    if (cachedEntry?.localVideoUri && cachedEntry.status === 'completed') {
      resolvedVideoUri = cachedEntry.localVideoUri;
      resolvedVideoHeaders = undefined;
      resolvedVideoContentType = undefined;
      resolvedVideoOverrideFileExtensionAndroid = undefined;
      selectedCloudProvider = entry.provider;
      resolvedVideoSourcePath = cachedEntry.localVideoUri;
    } else {
      try {
        const resolved = await resolveCloudReferencedVideoSource({
          provider: entry.provider,
          remotePath: entry.remotePath,
        });
        resolvedVideoUri = resolved.videoUri;
        resolvedVideoHeaders = resolved.videoHeaders;
        resolvedVideoContentType = resolved.videoContentType;
        resolvedVideoOverrideFileExtensionAndroid = resolved.videoOverrideFileExtensionAndroid;
        selectedCloudProvider = resolved.provider;
        resolvedVideoSourcePath = entry.remotePath;
      } catch {
        resolvedVideoUri = undefined;
        resolvedVideoHeaders = undefined;
        resolvedVideoContentType = undefined;
        resolvedVideoOverrideFileExtensionAndroid = undefined;
        selectedCloudProvider = entry.provider;
        resolvedVideoSourcePath = entry.remotePath;
      }
    }
  }

  if (entry.subtitleUri) {
    try {
      // 2026-08-15: 显示侧只用 *.json3 切分, 不传 englishSegments.
      // 原因: 单词高亮需要 json3 的 word-level timing (每个 seg.tOffsetMs),
      // segmented.json 只是 sentence-level 引用 (startToken/endToken 回查 json3).
      // 如果 token 索引算错 / 跨段不连续, 回查就会拿到错的 words, 单词高亮直接废.
      // 安全做法: 显示侧用 json3 直接切分 (groupTokensByEvent + 标点),
      // 单词高亮永远用 json3 word timing. segmented.json 只给翻译侧用 (句子级 + 标点修过).
      const [subtitleJson, subtitleZhJson] = await Promise.all([
        readImportedVideoPackJson<Record<string, unknown>>(entry.subtitleUri),
        entry.subtitleZhUri
          ? readImportedVideoPackJson<SubtitleTranslations>(entry.subtitleZhUri).catch(() => null)
          : Promise.resolve(null),
      ]);
      if (subtitleJson) {
        segments = sanitizeUserVideoSegments(
          parseJson3Subtitles(subtitleJson, subtitleZhJson ?? undefined),
          summary.durationSeconds,
        );
      }
    } catch {
      segments = [];
    }
  }

  const detail: VideoSceneDetail = {
    ...summary,
    videoUri: resolvedVideoUri,
    videoHeaders: resolvedVideoHeaders,
    videoContentType: resolvedVideoContentType,
    videoOverrideFileExtensionAndroid: resolvedVideoOverrideFileExtensionAndroid,
    videoSourcePath: resolvedVideoSourcePath,
    selectedCloudProvider,
    segments,
  };

  if (shouldUseCache) {
    importedSceneCache.set(entry.id, detail);
  } else {
    importedSceneCache.delete(entry.id);
  }
  return detail;
}

function buildScenarioCard(item: OssVideoManifestItem, info: YoutubeInfoJson | null): ScenarioCard {
  const hasRoleplay = item.hasRoleplay === true;
  const descriptionExcerpt = buildDescriptionExcerpt(info?.description);
  const desc = hasRoleplay
    ? `Shadow the video, then continue with an AI conversation in the same ${item.category} context.`
    : descriptionExcerpt || `Shadow the video and collect natural expressions from this ${item.category} clip.`;
  const openingLine = hasRoleplay ? `Let's continue the topic from "${item.title}". Ready?` : undefined;
  const npcSystemPrompt = hasRoleplay
    ? `You are a friendly English conversation partner helping the user continue practicing the same topic as the video "${item.title}". Keep the conversation natural, practical, and CEFR-appropriate for a ${item.level} learner.`
    : undefined;
  return {
    id: item.id,
    sourceType: 'video_scene',
    icon: inferVideoIcon(item),
    category: item.category,
    level: item.level,
    title: info?.title || info?.fulltitle || item.title,
    desc,
    descZh: hasRoleplay
      ? '先跟练视频，再进入同主题 AI 对话练习。'
      : `先跟练视频，积累这个${item.category}主题里的真实表达。`,
    npcEmoji: hasRoleplay ? '🤝' : undefined,
    npcName: hasRoleplay ? 'Practice Partner' : undefined,
    npcStatus: hasRoleplay ? '正在根据视频主题和你继续对话' : undefined,
    openingLine,
    openingLineZh: hasRoleplay ? `我们接着「${item.title}」这个主题继续练，准备好了吗？` : undefined,
    npcSystemPrompt,
    taskContract: deriveTaskContract({
      title: info?.title || info?.fulltitle || item.title,
      desc,
      category: item.category,
      npcName: hasRoleplay ? 'Practice Partner' : undefined,
      npcStatus: hasRoleplay ? '正在根据视频主题和你继续对话' : undefined,
      npcSystemPrompt,
      openingLine,
    }, item.taskContract),
    userInitiates: false,
  };
}

function buildGoals(item: OssVideoManifestItem) {
  if (item.type === 'dialogue' || item.type === 'film') {
    return ['跟练视频里的真实台词节奏', '吸收同场景高频表达', '为后续 AI 对话做输入准备'];
  }
  return ['跟练真实语料的语速和停顿', '从视频里提取自然表达', '围绕同主题积累可迁移词块'];
}

function buildRoles(item: OssVideoManifestItem) {
  if (item.type === 'dialogue' || item.type === 'film') {
    return {
      userRole: {
        title: '场景参与者',
        description: `你将进入与「${item.title}」同主题的真实对话场景。`,
        tone: '自然、口语化、贴近真实场景',
      },
      npcRole: {
        title: '视频同主题对话伙伴',
        description: '对方会延续视频里的语境，和你进行自然追问与回应。',
        tone: '友好、真实、顺着话题往下聊',
      },
    };
  }

  return {
    userRole: {
      title: '视频练习者',
      description: `你将围绕「${item.title}」这个主题进行听辨与表达迁移。`,
      tone: '观察、吸收、再迁移到自己的表达',
    },
    npcRole: {
      title: '视频讲述者',
      description: '当前以视频输入训练为主，后续可扩展为同主题 AI 练嘴。',
      tone: '真实语料、偏输入型训练',
    },
  };
}

async function fetchJson<T>(url: string): Promise<T> {
  logVideoSceneTrace('fetchJson start', { url });
  const response = await fetch(url);
  if (!response.ok) {
    warnVideoSceneTrace('fetchJson failed', { url, status: response.status, statusText: response.statusText });
    throw new Error(`Failed to fetch ${url}: ${response.status}`);
  }
  logVideoSceneTrace('fetchJson success', { url, status: response.status });
  return response.json() as Promise<T>;
}

async function loadSupabaseManifest(options?: RemoteFetchOptions): Promise<OssVideoManifest | null> {
  // Reads the official video catalog from Supabase and adapts it into
  // the legacy OssVideoManifestItem shape so the rest of this file
  // (cache, asset URL resolution, detail builders) keeps working.
  //
  // - series-level fields → groupId / groupTitle / groupCoverUrl / ...
  // - episode-level fields → id / title / videoKey / subtitleKey / ...
  // - bare filenames in `subtitle_json3_file` etc. → resolved to
  //   absolute URLs via `resolveEpisodeAssetUrl(series.manifest_url, ...)`.
  const seriesRows = await loadPublishedSeriesFromSupabase(options?.forceRefresh === true);
  if (!seriesRows || seriesRows.length === 0) {
    logVideoSceneTrace('loadSupabaseManifest no series', {});
    return null;
  }
  logVideoSceneTrace('loadSupabaseManifest series loaded', { seriesCount: seriesRows.length });

  // The bucket base is the same for every series in our setup
  // (`<bucket>.oss-cn-beijing.aliyuncs.com/videos`). Derive it from
  // any series' manifest_url so the value is not hard-coded here —
  // it can drift if the OSS bucket or prefix changes.
  const bucketBaseUrl = getUrlDirectory(getUrlDirectory(seriesRows[0].manifest_url || OFFICIAL_VIDEO_CATALOG_URL));
  const items: OssVideoManifestItem[] = [];

  for (const series of seriesRows) {
    const seriesAssetBaseUrl = `${bucketBaseUrl}/${encodeURIComponent(series.id)}`;
    const episodes = await loadSeriesEpisodesFromSupabase(series.id);
    logVideoSceneTrace('loadSupabaseManifest series episodes', {
      seriesId: series.id,
      title: series.title,
      episodeCount: episodes.length,
    });
    for (const ep of episodes) {
      const item: OssVideoManifestItem = {
        id: ep.id,
        title: ep.title,
        level: ep.level,
        category: ep.category,
        type: ep.type,
        sourceLabel: ep.source_label,
        assetBaseUrl: seriesAssetBaseUrl,
        groupId: series.id,
        groupTitle: series.title,
        groupLevel: series.level,
        groupDescription: series.description || '',
        groupCoverUrl: resolveEpisodeAssetUrl(series.manifest_url, series.cover_url) || '',
        groupTags: Array.isArray(series.tags) ? series.tags : [],
        groupSortOrder: series.sort_order,
        episodeIndex: ep.episode_index,
        episodeTitle: ep.title,
        videoKey: ep.video_file,
        subtitleKey: ep.subtitle_json3_file || '',
        infoKey: ep.info_file || '',
        coverUrl: resolveEpisodeAssetUrl(series.manifest_url, ep.cover_file) || '',
        hasRoleplay: ep.has_roleplay,
        aiPracticeKey: ep.ai_practice_file || '',
        subtitleZhKey: ep.subtitle_zh_file || '',
        subtitleEnSegmentedKey: ep.subtitle_en_segmented_file || '',
      };
      items.push(item);
    }
  }

  logVideoSceneTrace('loadSupabaseManifest ready', {
    bucketBaseUrl,
    seriesCount: seriesRows.length,
    totalItems: items.length,
  });
  return {
    version: 1,
    bucketBaseUrl,
    items,
  };
}

async function getOssManifest(options?: RemoteFetchOptions) {
  // v6: bypass the legacy 'main' SQLite cache (it was written by the
  // pre-Supabase OSS-catalog reader and is missing every series that
  // was uploaded via `series_upload_tab.py` on the desktop side).
  // We still keep the in-memory `manifestCache` short-circuit for
  // same-launch repeat reads, but the cold-start path always re-reads
  // Supabase so the catalog stays in sync with the desktop uploads.
  if (!options?.forceRefresh && manifestCache) {
    logVideoSceneTrace('using cached OSS manifest', { itemCount: manifestCache.items.length, bucketBaseUrl: manifestCache.bucketBaseUrl });
    return manifestCache;
  }
  // v6: prefer Supabase (`official_video_series` + `official_video_episodes`)
  // over the legacy OSS `official-video-catalog.json`. The OSS catalog is
  // only kept as a fallback for the brief window between desktop-side
  // migration and the next app release. New series always live in
  // Supabase now, so reading the OSS catalog alone misses them.
  try {
    const supabaseManifest = await loadSupabaseManifest(options);
    if (supabaseManifest && supabaseManifest.items.length > 0) {
      manifestCache = supabaseManifest;
      void saveCatalogCache({
        key: 'main',
        bucketBaseUrl: supabaseManifest.bucketBaseUrl,
        manifest: supabaseManifest,
      }).catch((err) => {
        warnVideoSceneTrace('failed to persist Supabase manifest cache', { error: err instanceof Error ? err.message : String(err) });
      });
      return supabaseManifest;
    }
    logVideoSceneTrace('Supabase manifest empty, falling back to OSS catalog', {});
  } catch (err) {
    warnVideoSceneTrace('Supabase manifest load failed, falling back to OSS catalog', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  const catalogUrl = appendCacheBust(OFFICIAL_VIDEO_CATALOG_URL, options?.cacheBust);
  logVideoSceneTrace('loading official video catalog', { catalogUrl, forceRefresh: options?.forceRefresh === true });
  const catalog = await fetchJson<OfficialVideoCatalog>(catalogUrl);
  const catalogBaseUrl = typeof catalog.resourceBaseUrl === 'string' && catalog.resourceBaseUrl.trim()
    ? catalog.resourceBaseUrl.trim().replace(/\/$/, '')
    : getUrlDirectory(OFFICIAL_VIDEO_CATALOG_URL);
  const catalogSeriesEntries = Array.isArray(catalog.series) ? catalog.series : [];
  logVideoSceneTrace('official video catalog loaded', {
    catalogUrl,
    catalogBaseUrl,
    seriesCount: catalogSeriesEntries.length,
    standaloneInlineCount: Array.isArray(catalog.standalone) ? catalog.standalone.length : 0,
    standaloneManifestUrl: catalog.standaloneManifestUrl || '',
  });

  const seriesItems = await Promise.all(
    catalogSeriesEntries.map(async (seriesEntry, index) => {
      if (typeof seriesEntry.manifestUrl !== 'string' || !seriesEntry.manifestUrl.trim()) {
        warnVideoSceneTrace('skip series entry without manifestUrl', {
          index,
          id: seriesEntry.id || '',
          title: seriesEntry.title || '',
        });
        return [] as OssVideoManifestItem[];
      }
      const resolvedManifestUrl = buildOssObjectUrl(catalogBaseUrl, seriesEntry.manifestUrl.trim(), options?.cacheBust);
      logVideoSceneTrace('loading series manifest', {
        index,
        seriesId: seriesEntry.id || '',
        title: seriesEntry.title || '',
        manifestUrl: seriesEntry.manifestUrl,
        resolvedManifestUrl,
      });
      try {
        const seriesManifest = await fetchJson<OfficialVideoSeriesManifest>(resolvedManifestUrl);
        const seriesBaseUrl = typeof seriesManifest.resourceBaseUrl === 'string' && seriesManifest.resourceBaseUrl.trim()
          ? seriesManifest.resourceBaseUrl.trim().replace(/\/$/, '')
          : getUrlDirectory(resolvedManifestUrl);
        const fallbackSeriesMeta: OfficialVideoSeriesMeta = {
          id: seriesEntry.id,
          title: seriesEntry.title,
          level: seriesEntry.level,
          category: seriesEntry.category,
          type: seriesEntry.type,
          description: seriesEntry.description,
          coverUrl: seriesEntry.coverUrl,
          tags: seriesEntry.tags,
          sortOrder: seriesEntry.sortOrder,
          sourceLabel: seriesEntry.sourceLabel,
        };
        const normalizedItems = (Array.isArray(seriesManifest.episodes) ? seriesManifest.episodes : [])
          .map((episode) => normalizeSeriesEpisodeItem(episode, seriesManifest.series || fallbackSeriesMeta, seriesBaseUrl))
          .filter((item): item is OssVideoManifestItem => Boolean(item));
        logVideoSceneTrace('series manifest normalized', {
          index,
          seriesId: (seriesManifest.series?.id || seriesEntry.id || '').toString(),
          title: seriesManifest.series?.title || seriesEntry.title || '',
          resolvedManifestUrl,
          seriesBaseUrl,
          rawEpisodeCount: Array.isArray(seriesManifest.episodes) ? seriesManifest.episodes.length : 0,
          normalizedItemCount: normalizedItems.length,
        });
        return normalizedItems;
      } catch (error) {
        warnVideoSceneTrace('series manifest load failed', {
          index,
          seriesId: seriesEntry.id || '',
          title: seriesEntry.title || '',
          resolvedManifestUrl,
          error: error instanceof Error ? error.message : String(error),
        });
        return [] as OssVideoManifestItem[];
      }
    }),
  );

  const standaloneItemsInline = (Array.isArray(catalog.standalone) ? catalog.standalone : [])
    .map((item) => normalizeStandaloneItem(item, catalogBaseUrl))
    .filter((item): item is OssVideoManifestItem => Boolean(item));
  logVideoSceneTrace('standalone inline items normalized', {
    sourceCount: Array.isArray(catalog.standalone) ? catalog.standalone.length : 0,
    normalizedItemCount: standaloneItemsInline.length,
  });

  let standaloneItemsRemote: OssVideoManifestItem[] = [];
  if (typeof catalog.standaloneManifestUrl === 'string' && catalog.standaloneManifestUrl.trim()) {
    const standaloneManifestUrl = buildOssObjectUrl(catalogBaseUrl, catalog.standaloneManifestUrl.trim(), options?.cacheBust);
    logVideoSceneTrace('loading standalone manifest', { standaloneManifestUrl });
    try {
      const standaloneManifest = await fetchJson<OfficialVideoStandaloneManifest>(standaloneManifestUrl);
      const standaloneBaseUrl = typeof standaloneManifest.resourceBaseUrl === 'string' && standaloneManifest.resourceBaseUrl.trim()
        ? standaloneManifest.resourceBaseUrl.trim().replace(/\/$/, '')
        : getUrlDirectory(standaloneManifestUrl);
      const standaloneSource = Array.isArray(standaloneManifest.items)
        ? standaloneManifest.items
        : Array.isArray(standaloneManifest.standalone)
          ? standaloneManifest.standalone
          : [];
      standaloneItemsRemote = standaloneSource
        .map((item) => normalizeStandaloneItem(item, standaloneBaseUrl))
        .filter((item): item is OssVideoManifestItem => Boolean(item));
      logVideoSceneTrace('standalone manifest normalized', {
        standaloneManifestUrl,
        standaloneBaseUrl,
        rawItemCount: standaloneSource.length,
        normalizedItemCount: standaloneItemsRemote.length,
      });
    } catch (error) {
      warnVideoSceneTrace('standalone manifest load failed', {
        standaloneManifestUrl,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const manifest: OssVideoManifest = {
    version: typeof catalog.version === 'number' && Number.isFinite(catalog.version) ? catalog.version : 1,
    bucketBaseUrl: catalogBaseUrl,
    items: [...seriesItems.flat(), ...standaloneItemsInline, ...standaloneItemsRemote],
  };
  logVideoSceneTrace('official OSS manifest ready', {
    bucketBaseUrl: manifest.bucketBaseUrl,
    totalItems: manifest.items.length,
    seriesItemCount: seriesItems.flat().length,
    standaloneInlineCount: standaloneItemsInline.length,
    standaloneRemoteCount: standaloneItemsRemote.length,
  });
  manifestCache = manifest;
  // v5: persist to SQLite so next cold start is instant.
  void saveCatalogCache({
    key: 'main',
    bucketBaseUrl: manifest.bucketBaseUrl,
    manifest,
  }).catch((err) => {
    warnVideoSceneTrace('failed to persist OSS manifest cache', { error: err instanceof Error ? err.message : String(err) });
  });
  return manifest;
}

async function loadInfoJson(baseUrl: string, item: OssVideoManifestItem, options?: RemoteFetchOptions): Promise<YoutubeInfoJson | null> {
  if (!item.infoKey) return null;
  const assetBaseUrl = getItemAssetBaseUrl(item, baseUrl);
  // v5: SQLite cache first. Cold start reads this in O(1) instead of
  // a network round-trip. Background refreshes write back here.
  if (!options?.forceRefresh) {
    const cached = await loadSceneInfoCache(item.id);
    if (cached && cached.info !== null) {
      return cached.info as YoutubeInfoJson;
    }
  }
  try {
    const result = await fetchJson<YoutubeInfoJson>(buildOssObjectUrl(assetBaseUrl, item.infoKey, options?.cacheBust));
    // v5: persist fetched info. Failure is non-fatal — keep old row.
    void saveSceneInfoCache({
      sceneId: item.id,
      assetBaseUrl,
      info: result,
    }).catch((err) => {
      warnVideoSceneTrace('failed to persist scene info cache', {
        sceneId: item.id,
        error: err instanceof Error ? err.message : String(err),
      });
    });
    return result;
  } catch (error) {
    warnVideoSceneTrace('info json load failed', {
      sceneId: item.id,
      infoKey: item.infoKey,
      baseUrl: getItemAssetBaseUrl(item, baseUrl),
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

async function buildVideoSceneSummary(item: OssVideoManifestItem, baseUrl: string, info: YoutubeInfoJson | null, options?: RemoteFetchOptions): Promise<VideoSceneDetail> {
  const assetBaseUrl = getItemAssetBaseUrl(item, baseUrl);
  const roles = buildRoles(item);
  const [aiPracticeCards, availableCloudProviders, selectedCloudProvider] = await Promise.all([
    // aiPracticeCards cache-first even when options.forceRefresh is
    // true (the parent forceRefresh is for the manifest, not the
    // per-scene ai-practice file).
    loadAiPracticeCards(assetBaseUrl, item),
    getOfficialSceneProviderStates(item.id),
    getDefaultCloudProvider(),
  ]);
  return {
    id: item.id,
    sourceLabel: info?.playlist_title || info?.uploader || item.sourceLabel || 'Aliyun OSS Video',
    durationSeconds: typeof info?.duration === 'number' ? info.duration : 0,
    coverAccent: inferCoverAccent(item),
    coverImageUri: item.coverUrl || info?.thumbnail,
    contentOrigin: 'official',
    groupId: item.groupId,
    groupTitle: item.groupTitle,
    groupLevel: item.groupLevel,
    groupDescription: item.groupDescription,
    groupCoverImageUri: item.groupCoverUrl,
    groupTags: Array.isArray(item.groupTags) ? item.groupTags.filter((tag): tag is string => typeof tag === 'string' && tag.trim().length > 0) : undefined,
    groupSortOrder: typeof item.groupSortOrder === 'number' && Number.isFinite(item.groupSortOrder) ? item.groupSortOrder : undefined,
    episodeIndex: typeof item.episodeIndex === 'number' && Number.isFinite(item.episodeIndex) ? item.episodeIndex : undefined,
    episodeTitle: item.episodeTitle,
    officialAssetKeys: {
      videoKey: item.videoKey,
      subtitleKey: item.subtitleKey,
      subtitleEnSegmentedKey: item.subtitleEnSegmentedKey,
      subtitleZhKey: item.subtitleZhKey,
    },
    availableCloudProviders,
    selectedCloudProvider,
    videoFileName: item.videoKey,
    subtitleFileName: item.subtitleKey,
    videoSourcePath: buildOssObjectUrl(assetBaseUrl, item.videoKey),
    subtitleSourcePath: buildOssObjectUrl(assetBaseUrl, item.subtitleKey),
    transcriptSource: 'youtube_json3',
    card: buildScenarioCard(item, info),
    aiPracticeCards,
    userRole: roles.userRole,
    npcRole: roles.npcRole,
    goals: buildGoals(item),
    segments: [],
  };
}

async function buildRemoteVideoSceneDetail(item: OssVideoManifestItem, baseUrl: string, options?: RemoteFetchOptions): Promise<VideoSceneDetail> {
  if (!options?.forceRefresh && remoteSceneCache.has(item.id)) {
    return remoteSceneCache.get(item.id)!;
  }

  const assetBaseUrl = getItemAssetBaseUrl(item, baseUrl);
  const infoPromise = loadInfoJson(assetBaseUrl, item, options);
  const subtitlePromise = fetchJson<Record<string, unknown>>(buildOssObjectUrl(assetBaseUrl, item.subtitleKey, options?.cacheBust));
  const englishPromise: Promise<EnglishSegmentedSubtitles | null> = item.subtitleEnSegmentedKey
    ? fetchJson<EnglishSegmentedSubtitles>(buildOssObjectUrl(assetBaseUrl, item.subtitleEnSegmentedKey, options?.cacheBust)).catch(() => null)
    : Promise.resolve(null);
  const zhPromise: Promise<SubtitleTranslations | null> = item.subtitleZhKey
    ? fetchJson<SubtitleTranslations>(buildOssObjectUrl(assetBaseUrl, item.subtitleZhKey, options?.cacheBust)).catch(() => null)
    : Promise.resolve(null);
  const [info, subtitleJson, englishSegments, zhTranslations] = await Promise.all([infoPromise, subtitlePromise, englishPromise, zhPromise]);

  const summary = await buildVideoSceneSummary(item, assetBaseUrl, info, options);
  const detail: VideoSceneDetail = {
    ...summary,
    segments: parseJson3Subtitles(subtitleJson, zhTranslations ?? undefined, englishSegments ?? undefined),
  };

  remoteSceneCache.set(item.id, detail);
  return detail;
}

// ── Supabase-backed scenes (replaces OSS-manifest path for official
//    series managed by the desktop admin app) ────────────────────

/**
 * Derive the OSS base URL for a series. The Supabase row stores
 * `manifest_url` as a per-series base URL of the form
 *   https://nativeos.oss-cn-beijing.aliyuncs.com/videos/<series-id>/series.json
 * — the basename (`series.json`) is a legacy read-only marker; we
 * strip it and use the rest as the asset base. This mirrors the
 * legacy `getOssManifest`'s `bucketBaseUrl` semantics.
 */
function deriveSupabaseAssetBaseUrl(series: SupabaseSeriesRow): string {
  if (!series.manifest_url || !series.manifest_url.trim()) return '';
  const withoutQuery = series.manifest_url.split('?')[0] || series.manifest_url;
  const trimmed = withoutQuery.endsWith('/') ? withoutQuery.slice(0, -1) : withoutQuery;
  const slashIndex = trimmed.lastIndexOf('/');
  return slashIndex >= 0 ? trimmed.slice(0, slashIndex) : trimmed;
}

/**
 * Synthesize a `YoutubeInfoJson`-shaped object from a Supabase episode
 * row + parent series row. The legacy pipeline feeds `info` (loaded
 * from the per-episode `info.json` on OSS) into `buildVideoSceneSummary`
 * for title / thumbnail / duration / description. For Supabase, those
 * fields live in the row itself, so we project them into the same
 * shape and reuse the legacy composition logic.
 */
function synthesizeEpisodeInfo(episode: SupabaseEpisodeRow, series: SupabaseSeriesRow, coverUri: string | undefined): YoutubeInfoJson {
  return {
    title: episode.title,
    fulltitle: episode.title,
    description: series.description ?? '',
    thumbnail: coverUri,
    duration: typeof episode.duration_seconds === 'number' && Number.isFinite(episode.duration_seconds)
      ? episode.duration_seconds
      : 0,
    uploader: episode.source_label || undefined,
    playlist_title: series.title,
  };
}

/**
 * Adapter: turn a `(episode, series)` row pair into an
 * `OssVideoManifestItem` so we can reuse the existing
 * `buildVideoSceneSummary` pipeline (which expects the legacy
 * manifest item shape).
 *
 * Why an adapter instead of rewriting the composition:
 *   The player reads ~30 fields off the resulting `VideoSceneDetail`,
 *   many of them derived through the same helper chain
 *   (`buildScenarioCard` → `inferVideoIcon` / `inferCoverAccent`,
 *   `buildRoles` / `buildGoals`, `loadAiPracticeCards`,
 *   `getOfficialSceneProviderStates`, `getDefaultCloudProvider`).
 *   Rewriting all of it for one source variant would double the
 *   maintenance surface; an adapter keeps the composition in one
 *   place and just changes the input shape.
 */
function buildSupabaseVideoSceneItem(episode: SupabaseEpisodeRow, series: SupabaseSeriesRow): OssVideoManifestItem | null {
  // `video_file` is required (it's the logical mp4 name the user
  // binds to a baidu pan path). Without it the player has no
  // way to resolve a video source. `subtitle_json3_file` is also
  // required for the subtitle pipeline.
  const videoKey = typeof episode.video_file === 'string' ? episode.video_file.trim() : '';
  const subtitleKey = typeof episode.subtitle_json3_file === 'string' ? episode.subtitle_json3_file.trim() : '';
  if (!videoKey || !subtitleKey) {
    return null;
  }
  const baseUrl = deriveSupabaseAssetBaseUrl(series);
  const coverUri = resolveEpisodeAssetUrl(series.manifest_url, episode.cover_file);
  const groupCoverUri = resolveSeriesCoverUrl(series.manifest_url, series.cover_url);
  return {
    id: episode.id,
    title: episode.title,
    level: episode.level || series.level || 'B1',
    category: episode.category || series.category || '综合',
    type: episode.type || series.type || 'vlog',
    sourceLabel: episode.source_label || '',
    assetBaseUrl: baseUrl,
    groupId: series.id,
    groupTitle: series.title,
    groupLevel: series.level,
    groupDescription: series.description ?? undefined,
    groupCoverUrl: groupCoverUri,
    groupTags: Array.isArray(series.tags) ? series.tags.filter((t): t is string => typeof t === 'string' && t.trim().length > 0) : undefined,
    groupSortOrder: series.sort_order,
    episodeIndex: episode.episode_index,
    episodeTitle: episode.title,
    videoKey,
    subtitleKey,
    subtitleEnSegmentedKey: episode.subtitle_en_segmented_file?.trim() || undefined,
    infoKey: episode.info_file?.trim() || undefined,
    coverUrl: coverUri,
    hasRoleplay: episode.has_roleplay === true,
    aiPracticeKey: episode.ai_practice_file?.trim() || undefined,
    subtitleZhKey: episode.subtitle_zh_file?.trim() || undefined,
  };
}

/**
 * Supabase-path variant of `buildVideoSceneSummary`. Reuses the
 * existing composition by synthesizing an info object from the
 * episode + series rows. Returns a `VideoSceneDetail` that mirrors
 * what the OSS-manifest path produces for the same logical scene.
 */
async function buildSupabaseVideoSceneSummary(
  item: OssVideoManifestItem,
  seriesRow: SupabaseSeriesRow,
  episodeRow: SupabaseEpisodeRow,
): Promise<VideoSceneDetail> {
  const baseUrl = item.assetBaseUrl || deriveSupabaseAssetBaseUrl(seriesRow);
  const coverUri = resolveEpisodeAssetUrl(seriesRow.manifest_url, episodeRow.cover_file);
  const info = synthesizeEpisodeInfo(episodeRow, seriesRow, coverUri);

  // Compose the AI practice / cloud-provider / default-provider
  // slices the same way the OSS-manifest path does. AI practice
  // goes Supabase-first (new `official_video_ai_practice` table)
  // with an OSS fallback for episodes that haven't been migrated
  // yet.
  const [aiPracticeCards, availableCloudProviders, selectedCloudProvider] = await Promise.all([
    loadSupabaseAiPracticeCards(seriesRow.id, episodeRow.id, baseUrl, item),
    getOfficialSceneProviderStates(item.id),
    getDefaultCloudProvider(),
  ]);

  return {
    id: item.id,
    sourceLabel: info?.playlist_title || info?.uploader || item.sourceLabel || 'Official Video',
    durationSeconds: typeof info?.duration === 'number' ? info.duration : 0,
    coverAccent: inferCoverAccent(item),
    coverImageUri: item.coverUrl || info?.thumbnail,
    contentOrigin: 'official',
    groupId: item.groupId,
    groupTitle: item.groupTitle,
    groupLevel: item.groupLevel,
    groupDescription: item.groupDescription,
    groupCoverImageUri: item.groupCoverUrl,
    groupTags: Array.isArray(item.groupTags) ? item.groupTags.filter((tag): tag is string => typeof tag === 'string' && tag.trim().length > 0) : undefined,
    groupSortOrder: typeof item.groupSortOrder === 'number' && Number.isFinite(item.groupSortOrder) ? item.groupSortOrder : undefined,
    episodeIndex: typeof item.episodeIndex === 'number' && Number.isFinite(item.episodeIndex) ? item.episodeIndex : undefined,
    episodeTitle: item.episodeTitle,
    officialAssetKeys: {
      videoKey: item.videoKey,
      subtitleKey: item.subtitleKey,
      subtitleEnSegmentedKey: item.subtitleEnSegmentedKey,
      subtitleZhKey: item.subtitleZhKey,
    },
    availableCloudProviders,
    selectedCloudProvider,
    videoFileName: item.videoKey,
    subtitleFileName: item.subtitleKey,
    videoSourcePath: buildOssObjectUrl(baseUrl, item.videoKey),
    subtitleSourcePath: buildOssObjectUrl(baseUrl, item.subtitleKey),
    transcriptSource: 'youtube_json3',
    card: buildScenarioCard(item, info),
    aiPracticeCards,
    userRole: buildRoles(item).userRole,
    npcRole: buildRoles(item).npcRole,
    goals: buildGoals(item),
    segments: [],
  };
}

/**
 * Supabase-path variant of `buildRemoteVideoSceneDetail`. Loads
 * the subtitle files (json3, en-segmented, zh translations) from
 * OSS, parses them into segments, and stitches the result onto
 * the summary. Cached in `supabaseSceneCache` keyed by episode id.
 */
async function buildSupabaseVideoSceneDetail(
  item: OssVideoManifestItem,
  seriesRow: SupabaseSeriesRow,
  episodeRow: SupabaseEpisodeRow,
  options?: RemoteFetchOptions,
): Promise<VideoSceneDetail> {
  if (!options?.forceRefresh && supabaseSceneCache.has(item.id)) {
    return supabaseSceneCache.get(item.id)!;
  }
  const baseUrl = item.assetBaseUrl || deriveSupabaseAssetBaseUrl(seriesRow);
  const coverUri = resolveEpisodeAssetUrl(seriesRow.manifest_url, episodeRow.cover_file);
  const info = synthesizeEpisodeInfo(episodeRow, seriesRow, coverUri);
  const subtitlePromise = fetchJson<Record<string, unknown>>(buildOssObjectUrl(baseUrl, item.subtitleKey, options?.cacheBust));
  const englishPromise: Promise<EnglishSegmentedSubtitles | null> = item.subtitleEnSegmentedKey
    ? fetchJson<EnglishSegmentedSubtitles>(buildOssObjectUrl(baseUrl, item.subtitleEnSegmentedKey, options?.cacheBust)).catch(() => null)
    : Promise.resolve(null);
  const zhPromise: Promise<SubtitleTranslations | null> = item.subtitleZhKey
    ? fetchJson<SubtitleTranslations>(buildOssObjectUrl(baseUrl, item.subtitleZhKey, options?.cacheBust)).catch(() => null)
    : Promise.resolve(null);
  const [subtitleJson, englishSegments, zhTranslations] = await Promise.all([subtitlePromise, englishPromise, zhPromise]);

  const summary = await buildSupabaseVideoSceneSummary(item, seriesRow, episodeRow);
  const detail: VideoSceneDetail = {
    ...summary,
    segments: parseJson3Subtitles(subtitleJson, zhTranslations ?? undefined, englishSegments ?? undefined),
  };
  supabaseSceneCache.set(item.id, detail);
  return detail;
}

export async function getFeaturedVideoSceneCards(): Promise<ScenarioCard[]> {
  const scenes = await getFeaturedVideoScenes();
  return scenes.map(scene => scene.card);
}

export async function getFeaturedVideoScenes(forceRefresh: boolean = false): Promise<VideoSceneDetail[]> {
  if (!forceRefresh && featuredScenesCache) return featuredScenesCache;
  const cacheBust = forceRefresh ? `${Date.now()}` : undefined;
  const [remoteScenes, importedEntries, userVideoEntries] = await Promise.all([
    (async () => {
      try {
        const manifest = await getOssManifest({ forceRefresh, cacheBust });
        const scenes = await Promise.all(
          manifest.items.map(async (item) => {
            const assetBaseUrl = getItemAssetBaseUrl(item, manifest.bucketBaseUrl);
            // List path: per-scene info.json always cache-first, even
            // when forceRefresh=true. forceRefresh only re-fetches the
            // manifest itself; if a single scene's info actually
            // changed on OSS, the dedicated detail page (with its own
            // force flag) will pick it up. This avoids 30 network
            // round-trips on every user action that triggers force.
            return buildVideoSceneSummary(item, assetBaseUrl, await loadInfoJson(assetBaseUrl, item), { forceRefresh, cacheBust });
          }),
        );
        logVideoSceneTrace('remote official scenes prepared', {
          manifestItemCount: manifest.items.length,
          sceneCount: scenes.length,
        });
        return scenes;
      } catch (error) {
        warnVideoSceneTrace('remote official scenes load failed', {
          forceRefresh,
          error: error instanceof Error ? error.message : String(error),
        });
        return [] as VideoSceneDetail[];
      }
    })(),
    listImportedVideoPacks().catch(() => [] as ImportedVideoPackIndexEntry[]),
    listUserVideos().catch(() => [] as UserVideoEntry[]),
  ]);
  const importedScenes = (await Promise.all(importedEntries.map(async (entry) => {
    try {
      return await buildImportedVideoSceneSummary(entry);
    } catch {
      return null;
    }
  }))).filter((scene): scene is VideoSceneDetail => Boolean(scene));
  const userVideoScenes = (await Promise.all(userVideoEntries.map(async (entry) => {
    try {
      return await buildUserVideoSceneSummary(entry);
    } catch {
      return null;
    }
  }))).filter((scene): scene is VideoSceneDetail => Boolean(scene));
  const merged: VideoSceneDetail[] = [];
  const seenIds = new Set<string>();

  for (const scene of userVideoScenes) {
    if (seenIds.has(scene.id)) continue;
    seenIds.add(scene.id);
    merged.push(scene);
  }

  for (const scene of importedScenes) {
    if (seenIds.has(scene.id)) continue;
    seenIds.add(scene.id);
    merged.push(scene);
  }

  for (const scene of remoteScenes) {
    if (seenIds.has(scene.id)) continue;
    seenIds.add(scene.id);
    merged.push(scene);
  }

  logVideoSceneTrace('featured video scenes merged', {
    userVideoEntryCount: userVideoEntries.length,
    importedEntryCount: importedEntries.length,
    remoteSceneCount: remoteScenes.length,
    importedSceneCount: importedScenes.length,
    userSceneCount: userVideoScenes.length,
    mergedSceneCount: merged.length,
  });
  featuredScenesCache = merged;
  return merged;
}

export async function getVideoSceneSummaryById(id: string, forceRefresh: boolean = false): Promise<VideoSceneDetail | null> {
  // Supabase first: it's the new source of truth for official series
  // managed by the desktop admin app. Returns null if no Supabase
  // episode matches the id (e.g. user-imported or legacy OSS-only
  // scenes) so the legacy branches below get a chance.
  try {
    const supabaseScene = await getVideoSceneSummaryByIdFromSupabase(id, forceRefresh);
    if (supabaseScene) return supabaseScene;
  } catch {
  }

  try {
    const importedEntry = await getImportedVideoPackEntryById(id);
    if (importedEntry) {
      return buildImportedVideoSceneSummary(importedEntry);
    }
  } catch {
  }

  try {
    const userVideoEntry = await getUserVideoEntryById(id);
    if (userVideoEntry) {
      return buildUserVideoSceneSummary(userVideoEntry);
    }
  } catch {
  }

  try {
    const cacheBust = forceRefresh ? `${Date.now()}` : undefined;
    const manifest = await getOssManifest({ forceRefresh, cacheBust });
    const item = manifest.items.find((scene) => scene.id === id);
    if (item) {
      const assetBaseUrl = getItemAssetBaseUrl(item, manifest.bucketBaseUrl);
      return buildVideoSceneSummary(item, assetBaseUrl, await loadInfoJson(assetBaseUrl, item, { forceRefresh, cacheBust }), { forceRefresh, cacheBust });
    }
  } catch {
  }

  return null;
}

export async function getVideoSceneById(id: string, forceRefresh: boolean = false): Promise<VideoSceneDetail | null> {
  // Supabase first: same rationale as `getVideoSceneSummaryById`.
  try {
    const supabaseScene = await getVideoSceneByIdFromSupabase(id, forceRefresh);
    if (supabaseScene) return supabaseScene;
  } catch {
  }

  try {
    const importedEntry = await getImportedVideoPackEntryById(id);
    if (importedEntry) {
      if (forceRefresh) {
        importedSceneCache.delete(id);
      }
      return buildImportedVideoSceneDetail(importedEntry);
    }
  } catch {
  }

  try {
    const userVideoEntry = await getUserVideoEntryById(id);
    if (userVideoEntry) {
      if (forceRefresh) {
        importedSceneCache.delete(id);
      }
      return buildUserVideoSceneDetail(userVideoEntry);
    }
  } catch {
  }

  try {
    const cacheBust = forceRefresh ? `${Date.now()}` : undefined;
    const manifest = await getOssManifest({ forceRefresh, cacheBust });
    const item = manifest.items.find((scene) => scene.id === id);
    if (item) {
      return buildRemoteVideoSceneDetail(item, manifest.bucketBaseUrl, { forceRefresh, cacheBust });
    }
  } catch {
  }
  return null;
}

/**
 * Supabase-path entry: load the episode row + parent series row,
 * build the `OssVideoManifestItem` adapter, then run the existing
 * `buildSupabaseVideoSceneSummary` composition. Returns `null` if
 * the id doesn't match any Supabase episode (so the caller falls
 * through to the legacy paths).
 *
 * Performance: one Supabase round-trip (episode lookup) followed by
 * one Supabase round-trip (series lookup, possibly parallelized if
 * the episode has a known `series_id`). For an episode that doesn't
 * exist, the episode lookup alone is enough and the series lookup
 * is skipped.
 */
async function getVideoSceneSummaryByIdFromSupabase(
  id: string,
  forceRefresh: boolean = false,
): Promise<VideoSceneDetail | null> {
  if (!id || !id.trim()) return null;
  if (!forceRefresh && supabaseSceneCache.has(id)) {
    return supabaseSceneCache.get(id)!;
  }
  try {
    // Try the cheap "is this even a Supabase episode" probe first.
    // Skip the row fetch — go straight to series_id lookup, then full
    // row fetch once we know the series. This avoids pulling the full
    // episode row when it doesn't exist.
    const seriesId = await loadEpisodeSeriesIdFromSupabase(id);
    if (!seriesId) return null;
    const [episode, series] = await Promise.all([
      loadEpisodeByIdFromSupabase(id, seriesId),
      loadSeriesByIdFromSupabase(seriesId),
    ]);
    if (!episode || !series) return null;
    const item = buildSupabaseVideoSceneItem(episode, series);
    if (!item) return null;
    return await buildSupabaseVideoSceneSummary(item, series, episode);
  } catch (err) {
    warnVideoSceneTrace('getVideoSceneSummaryByIdFromSupabase threw', {
      id,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Supabase-path entry for the full scene (with subtitle segments
 * loaded from OSS). Same lookup pattern as the summary entry.
 */
async function getVideoSceneByIdFromSupabase(
  id: string,
  forceRefresh: boolean = false,
): Promise<VideoSceneDetail | null> {
  if (!id || !id.trim()) return null;
  if (!forceRefresh && supabaseSceneCache.has(id)) {
    return supabaseSceneCache.get(id)!;
  }
  try {
    const seriesId = await loadEpisodeSeriesIdFromSupabase(id);
    if (!seriesId) return null;
    const [episode, series] = await Promise.all([
      loadEpisodeByIdFromSupabase(id, seriesId),
      loadSeriesByIdFromSupabase(seriesId),
    ]);
    if (!episode || !series) return null;
    const item = buildSupabaseVideoSceneItem(episode, series);
    if (!item) return null;
    return await buildSupabaseVideoSceneDetail(item, series, episode, { forceRefresh, cacheBust: forceRefresh ? `${Date.now()}` : undefined });
  } catch (err) {
    warnVideoSceneTrace('getVideoSceneByIdFromSupabase threw', {
      id,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}
