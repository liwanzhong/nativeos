import AsyncStorage from '@react-native-async-storage/async-storage';
import type { ScenarioCard } from './scenario-generator';
import { deriveTaskContract } from './conversation-runtime';
import { getFeaturedVideoScenes, type VideoSceneDetail } from '../content/video-scenes';
import { listOfficialScenesFromSupabase } from '../content/video-series-supabase-views';
import {
  listAiPracticeCardsFromSupabase,
  listAllPublishedAiPracticeCardsFromSupabase,
  type SupabaseAiPracticeRow,
} from '../content/video-series-supabase';
import { loadGeneratedVideoAiPracticeCards } from '../content/video-ai-practice';
import {
  getLatestAiCardsFetchedAt,
  isAiCardsCacheStale,
  loadCachedAiCardsBySeriesIds,
  loadCachedAiCardsSeriesIds,
  replaceAiCardsCache,
} from '../database/official-ai-practice-cache';
import {
  buildAiPracticeTopicSnapshot,
  buildAiPracticeTopicId,
  type AiPracticeTopicSnapshot,
  type AiPracticeTopicSourceType,
} from './ai-practice-user-meta';

export type AiPracticeFitBand = 'fit' | 'challenge' | 'easy' | 'all';
export type AiPracticeHistoryTimeFilter = 'today' | 'week' | 'month' | 'older' | 'all';

const RECOMMENDED_TOPIC_CACHE_VERSION = 'v2';

export interface RecommendedAiTopicItem {
  topicId: string;
  card: ScenarioCard;
  snapshot: AiPracticeTopicSnapshot;
  fitBand: AiPracticeFitBand;
  fitScore: number;
}

export interface VideoAiTopicItem {
  topicId: string;
  card: ScenarioCard;
  snapshot: AiPracticeTopicSnapshot;
  fitBand: AiPracticeFitBand;
  fitScore: number;
}

export interface VideoAiTopicGroup {
  sceneId: string;
  sceneTitle: string;
  sceneLevel: string;
  sceneCategory: string;
  sceneCoverImageUri?: string;
  sceneSourceLabel: string;
  sceneSourceType: AiPracticeTopicSourceType;
  importSourceLabel?: string;
  topicCount: number;
  previewTopic: VideoAiTopicItem;
  topics: VideoAiTopicItem[];
}

function getLevelIndex(level: string) {
  return ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'].indexOf(level);
}

export function getAiPracticeFitBand(level: string, userLevel: string): AiPracticeFitBand {
  const topicIndex = getLevelIndex(level);
  const userIndex = getLevelIndex(userLevel);
  if (topicIndex < 0 || userIndex < 0) {
    return 'all';
  }
  const diff = topicIndex - userIndex;
  if (Math.abs(diff) <= 1) {
    return 'fit';
  }
  if (diff > 1) {
    return 'challenge';
  }
  return 'easy';
}

export function getAiPracticeFitScore(level: string, userLevel: string) {
  const topicIndex = getLevelIndex(level);
  const userIndex = getLevelIndex(userLevel);
  if (topicIndex < 0 || userIndex < 0) {
    return 0;
  }
  return 100 - Math.abs(topicIndex - userIndex) * 20;
}

function filterValidAiCards(cards?: ScenarioCard[]) {
  return (cards || []).filter((card) => Boolean(card?.npcSystemPrompt || card?.openingLine || card?.npcName));
}

export async function getAiPracticeUserLevel(): Promise<string> {
  const level = await AsyncStorage.getItem('user_level');
  return level || 'B1';
}

export async function getRecommendedAiTopics(forceRefresh: boolean = false): Promise<ScenarioCard[]> {
  const AsyncStorageModule = (await import('@react-native-async-storage/async-storage')).default;
  const level = (await AsyncStorageModule.getItem('user_level')) || 'B1';
  const interestsRaw = await AsyncStorageModule.getItem('user_interests') ?? '[]';
  const today = new Date().toISOString().slice(0, 10);
  const cacheKey = `daily_scenarios__${today}__${level}__${interestsRaw}__${RECOMMENDED_TOPIC_CACHE_VERSION}`;
  if (forceRefresh) {
    return [];
  }
  try {
    const raw = await AsyncStorageModule.getItem(cacheKey);
    if (!raw) {
      return [];
    }
    const parsed = JSON.parse(raw) as ScenarioCard[];
    return (parsed || []).filter(Boolean);
  } catch {
    return [];
  }
}

export function buildRecommendedAiTopicItems(cards: ScenarioCard[], userLevel: string): RecommendedAiTopicItem[] {
  return cards.map((card) => {
    const snapshot = buildAiPracticeTopicSnapshot({
      card,
      origin: 'recommended',
      sourceType: 'recommended',
      sourceLabel: '推荐话题',
    });
    return {
      topicId: snapshot.topicId,
      card,
      snapshot,
      fitBand: getAiPracticeFitBand(card.level, userLevel),
      fitScore: getAiPracticeFitScore(card.level, userLevel),
    };
  });
}

// 2026-08-17 改: 推荐话题入口之前每次进 page 都 N 次 round-trip, 加 SQLite 持久化缓存.
// 三层 fallback: scene.aiPracticeCards (内存) → 本地 SQLite cache (持久化) → app-generated SQLite.
// 缓存 TTL 24h, 过期或空时触发 listAllPublishedAiPracticeCardsFromSupabase 1 次批量拉 → 写盘.
let _aiCardsRefreshPromise: Promise<void> | null = null;

async function ensureAiCardsCacheFresh(): Promise<void> {
  // 单飞: 同一时刻多个 caller 只允许 1 个 supabase 拉取
  if (_aiCardsRefreshPromise) return _aiCardsRefreshPromise;
  _aiCardsRefreshPromise = (async () => {
    const latest = await getLatestAiCardsFetchedAt();
    if (!isAiCardsCacheStale(latest)) {
      console.log('[AiPracticeHub] ai cards cache fresh', {
        latestFetchedAt: latest,
        ageMs: latest == null ? null : Date.now() - latest,
      });
      return;
    }
    console.log('[AiPracticeHub] ai cards cache stale, refreshing', { latestFetchedAt: latest });
    // 2026-08-25: retry once if first fetch returns 0 rows (网络抖动 / supabase
    // 端临时 schema 问题都不该把 cache 冻死). 已确认 RLS 允许 anon 读
    // published,0 rows 一定是临时问题.
    let rows = await listAllPublishedAiPracticeCardsFromSupabase();
    if (rows.length === 0) {
      console.warn('[AiPracticeHub] ai cards refresh returned 0 rows, retrying in 1.5s');
      await new Promise<void>((r) => setTimeout(r, 1500));
      rows = await listAllPublishedAiPracticeCardsFromSupabase();
    }
    if (rows.length === 0) {
      console.warn('[AiPracticeHub] ai cards refresh returned 0 rows after retry, keeping existing cache');
      return;
    }
    await replaceAiCardsCache(rows);
    console.log('[AiPracticeHub] ai cards cache replaced', { count: rows.length });
  })().finally(() => {
    _aiCardsRefreshPromise = null;
  });
  return _aiCardsRefreshPromise;
}

async function loadSceneAiCards(scene: VideoSceneDetail): Promise<ScenarioCard[]> {
  const builtInCards = filterValidAiCards(scene.aiPracticeCards);
  if (builtInCards.length > 0) {
    return builtInCards;
  }
  if (typeof scene.groupId === 'string' && scene.groupId.length > 0) {
    // 触发 (必要时) 批量拉取 + 写盘, 单飞
    await ensureAiCardsCacheFresh();
    const bySeries = await loadCachedAiCardsBySeriesIds([scene.groupId]);
    const rows = bySeries.get(scene.groupId)?.filter((r) => r.episode_id === scene.id) ?? [];
    if (rows.length > 0) {
      const cards = filterValidAiCards(
        rows.map((row, index) => mapSupabaseRowToScenarioCard(row, index, scene)),
      );
      if (cards.length > 0) {
        console.log('[AiPracticeHub] loadSceneAiCards', { sceneId: scene.id, source: 'localCache', count: cards.length });
        return cards;
      }
    }
  }
  const generated = filterValidAiCards(await loadGeneratedVideoAiPracticeCards(scene.id));
  console.log('[AiPracticeHub] loadSceneAiCards', { sceneId: scene.id, source: 'generatedSqlite', count: generated.length });
  return generated;
}

// 保留旧函数供 single-episode 兜底 (e.g. video detail 屏已经在用 loadSupabaseAiPracticeCards).
async function loadSceneAiCardsFromSupabase(
  seriesId: string,
  episodeId: string,
  scene: VideoSceneDetail,
): Promise<ScenarioCard[]> {
  const rows = await listAiPracticeCardsFromSupabase(seriesId, episodeId);
  if (rows.length === 0) return [];
  return rows
    .map((row, index) => mapSupabaseRowToScenarioCard(row, index, scene))
    .filter((card) => Boolean(card.title));
}

function mapSupabaseRowToScenarioCard(
  row: SupabaseAiPracticeRow,
  index: number,
  scene: VideoSceneDetail,
): ScenarioCard {
  const userInitiates = row.user_initiates === true;
  const openingLine = userInitiates ? undefined : (row.opening_line ?? undefined);
  const environmentalCue = userInitiates ? (row.environmental_cue ?? undefined) : undefined;
  const environmentalCueEn = userInitiates ? (row.environmental_cue_en ?? undefined) : undefined;
  const title = row.title || `视频延展 ${index + 1}`;
  const desc = row.description || `Continue the same topic after watching this video.`;
  const fallbackCategory = scene.card?.category || '综合';
  const fallbackLevel = scene.card?.level || 'B1';
  return {
    id: row.id || `${scene.id}__ai__${index + 1}`,
    sourceType: 'ai_scenario',
    icon: row.icon || '💬',
    category: row.category || fallbackCategory,
    level: row.level || fallbackLevel,
    title,
    desc,
    descZh: row.description_zh ?? undefined,
    npcEmoji: row.npc_emoji ?? undefined,
    npcName: row.npc_name ?? undefined,
    npcStatus: row.npc_status ?? undefined,
    openingLine,
    openingLineZh: userInitiates ? undefined : (row.opening_line_zh ?? undefined),
    environmentalCue,
    environmentalCueEn,
    npcSystemPrompt: row.npc_system_prompt ?? undefined,
    taskContract: deriveTaskContract(
      {
        title,
        desc,
        category: row.category || fallbackCategory,
        npcName: row.npc_name ?? undefined,
        npcStatus: row.npc_status ?? undefined,
        npcSystemPrompt: row.npc_system_prompt ?? undefined,
        openingLine,
        environmentalCue,
        environmentalCueEn,
      },
      (row.task_contract as Record<string, unknown> | null) ?? undefined,
    ),
    userInitiates,
  };
}

function mapSceneSourceType(scene: VideoSceneDetail): AiPracticeTopicSourceType {
  return scene.contentOrigin === 'imported' ? 'imported_video' : 'official_video';
}

// 2026-08-17: 同步从 in-memory cache 读 cards (不走 async SQL). 调用方
// listVideoAiTopicGroups 已经在前面 batch load 一次了.
function readCardsForScene(
  scene: VideoSceneDetail,
  cacheBySeries: Map<string, SupabaseAiPracticeRow[]>,
): ScenarioCard[] {
  const builtIn = filterValidAiCards(scene.aiPracticeCards);
  if (builtIn.length > 0) return builtIn;
  const groupId = scene.groupId;
  if (typeof groupId !== 'string' || groupId.length === 0) return [];
  const rows = cacheBySeries.get(groupId)?.filter((r) => r.episode_id === scene.id) ?? [];
  if (rows.length === 0) return [];
  return filterValidAiCards(
    rows.map((row, index) => mapSupabaseRowToScenarioCard(row, index, scene)),
  );
}

function buildVideoTopicItem(scene: VideoSceneDetail, card: ScenarioCard, userLevel: string): VideoAiTopicItem {
  const snapshot = buildAiPracticeTopicSnapshot({
    card: {
      ...card,
      id: buildAiPracticeTopicId({
        card,
        origin: 'video',
        sourceType: mapSceneSourceType(scene),
        sourceId: scene.id,
      }),
    },
    origin: 'video',
    sourceType: mapSceneSourceType(scene),
    sourceLabel: scene.contentOrigin === 'imported' ? '跟练话题' : '推荐视频',
    sourceId: scene.id,
    sceneTitle: scene.card.title,
    importSourceLabel: scene.contentOrigin === 'imported' ? scene.sourceLabel : undefined,
  });
  return {
    topicId: snapshot.topicId,
    card: snapshot.card,
    snapshot,
    fitBand: getAiPracticeFitBand(card.level, userLevel),
    fitScore: getAiPracticeFitScore(card.level, userLevel),
  };
}

export async function listVideoAiTopicGroups(
  userLevel: string,
  forceRefresh: boolean = false,
  pickedSeriesIds: Set<string> | null = null,
): Promise<VideoAiTopicGroup[]> {
  console.log('[AiPracticeHub] listVideoAiTopicGroups start', { userLevel, pickedCount: pickedSeriesIds?.size ?? 'null' });
  // Supabase first: same shape as the legacy OSS path (`getFeaturedVideoScenes`
  // returns the same `VideoSceneDetail[]` fields the rest of this
  // function reads — `id`, `contentOrigin`, `groupId`, `card.title`,
  // `sourceLabel`, plus `aiPracticeCards` for the on-demand load).
  // Fall back to OSS if Supabase is empty (e.g. user hasn't been
  // migrated, or the per-series detail path is mid-migration for a
  // brand-new series).
  let scenes = await listOfficialScenesFromSupabase(forceRefresh);
  console.log('[AiPracticeHub] official scenes from supabase', { count: scenes.length });
  if (scenes.length === 0) {
    scenes = await getFeaturedVideoScenes(forceRefresh);
    console.log('[AiPracticeHub] fell back to OSS featured scenes', { count: scenes.length });
  }

  // After the videos-tab redesign ("我的跟练" entry), the AI practice
  // tab only shows topics derived from series the user has explicitly
  // picked. Pass `pickedSeriesIds = null` to keep the legacy behaviour
  // (show every official scene's topics) — used by previews, debug
  // screens, and the initial 0.5 release while we ship the picker.
  //
  // An empty Set is NOT the same as null: empty = "user is signed in
  // but hasn't picked anything yet, so this section should be empty".
  const isOfficial = (scene: VideoSceneDetail) =>
    scene.contentOrigin !== 'imported' && typeof scene.groupId === 'string' && scene.groupId.length > 0;

  // 2026-08-25: 未登录 / 没挑合集 (pickedSeriesIds === null) 场景下, 直接返回
  // 全部 official scenes 会让 filteredScenes 包含 414 个 scene, 但 cards cache
  // 经常只覆盖 4 个 series (supabase 表里就只 published 了 4 series 的 cards).
  // 为了让未登录态下也能加载, 这里降级: 拿 cache 里所有有 cards 的 series id
  // 当默认 picked, 保证 "看到的 scene 都有 cards". 登录态下用户已挑则不受影响.
  let effectivePickedIds = pickedSeriesIds;
  if (pickedSeriesIds === null) {
    // 先确保 cache fresh (但不阻塞 — 用 await, 反正下游 loadCachedAiCardsBySeriesIds 也要)
    await ensureAiCardsCacheFresh();
    const cachedSeries = await loadCachedAiCardsSeriesIds();
    if (cachedSeries.size > 0) {
      effectivePickedIds = cachedSeries;
      console.log('[AiPracticeHub] null picked → fallback to cached series', { count: cachedSeries.size });
    }
  }

  const filteredScenes = effectivePickedIds === null
    ? scenes
    : scenes.filter((scene) => {
        if (!isOfficial(scene)) return false;
        return (effectivePickedIds as Set<string>).has(scene.groupId as string);
      });
  console.log('[AiPracticeHub] filteredScenes', {
    totalScenes: scenes.length,
    filteredCount: filteredScenes.length,
    pickedSeriesIdsSize: effectivePickedIds?.size ?? 'null',
    isNullPicked: pickedSeriesIds === null,
    isFallbackToCache: pickedSeriesIds === null && effectivePickedIds !== null,
  });

  // 2026-08-17 优化: 把 cards 的 SQLite 读从 N 次降到 1 次. 先 batch 读所有挑中 series 的
  // 缓存, 再 in-memory filter. 缓存空/过期时由 ensureAiCardsCacheFresh 触发 1 次 supabase 拉.
  await ensureAiCardsCacheFresh();
  const cacheBySeries = await loadCachedAiCardsBySeriesIds(
    Array.from(new Set(
      filteredScenes
        .map((s) => s.groupId)
        .filter((id): id is string => typeof id === 'string' && id.length > 0),
    )),
  );
  console.log('[AiPracticeHub] ai cards cache loaded', { seriesCount: cacheBySeries.size });

  const groups: Array<VideoAiTopicGroup | null> = filteredScenes.map((scene) => {
    const cards = readCardsForScene(scene, cacheBySeries);
    if (cards.length === 0) {
      return null;
    }
    // 调试: 打印每个 scene 的 cards 数, 定位为什么 groups 是 0
    console.log('[AiPracticeHub] scene cards', {
      sceneId: scene.id,
      sceneTitle: scene.card.title,
      groupId: scene.groupId,
      cardCount: cards.length,
      cacheHit: cards.length > 0 && scene.aiPracticeCards.length === 0,
    });
    const topics = cards.map((card) => buildVideoTopicItem(scene, card, userLevel))
      .sort((a, b) => b.fitScore - a.fitScore);
    if (topics.length === 0) {
      return null;
    }
    return {
      sceneId: scene.id,
      sceneTitle: scene.card.title,
      sceneLevel: scene.card.level,
      sceneCategory: scene.card.category,
      sceneCoverImageUri: scene.coverImageUri,
      sceneSourceLabel: scene.contentOrigin === 'imported' ? '导入视频' : '推荐视频',
      sceneSourceType: mapSceneSourceType(scene),
      importSourceLabel: scene.contentOrigin === 'imported' ? scene.sourceLabel : undefined,
      topicCount: topics.length,
      previewTopic: topics[0],
      topics,
    } satisfies VideoAiTopicGroup;
  });
  const validGroups = groups.filter((item): item is VideoAiTopicGroup => Boolean(item));
  console.log('[AiPracticeHub] groups final', {
    filteredScenesCount: filteredScenes.length,
    rawGroupsCount: groups.length,
    nullGroupsCount: groups.length - validGroups.length,
    validGroupsCount: validGroups.length,
  });
  return validGroups
    .sort((a, b) => b.previewTopic.fitScore - a.previewTopic.fitScore);
    // (intentionally no console here; per-group loadSceneAiCards log already shows counts)
}

export function isTimestampInHistoryFilter(timestamp: number | undefined, filter: AiPracticeHistoryTimeFilter) {
  if (filter === 'all') {
    return true;
  }
  if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) {
    return false;
  }
  const dayMs = 24 * 60 * 60 * 1000;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayStart = today.getTime();
  const weekStart = todayStart - 7 * dayMs;
  const monthStart = todayStart - 30 * dayMs;
  if (filter === 'today') {
    return timestamp >= todayStart;
  }
  if (filter === 'week') {
    return timestamp >= weekStart;
  }
  if (filter === 'month') {
    return timestamp >= monthStart;
  }
  return timestamp < monthStart;
}
