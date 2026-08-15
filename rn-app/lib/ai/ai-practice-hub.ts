import AsyncStorage from '@react-native-async-storage/async-storage';
import type { ScenarioCard } from './scenario-generator';
import { getFeaturedVideoScenes, type VideoSceneDetail } from '../content/video-scenes';
import { listOfficialScenesFromSupabase } from '../content/video-series-supabase-views';
import { loadGeneratedVideoAiPracticeCards } from '../content/video-ai-practice';
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

async function loadSceneAiCards(scene: VideoSceneDetail): Promise<ScenarioCard[]> {
  const builtInCards = filterValidAiCards(scene.aiPracticeCards);
  if (builtInCards.length > 0) {
    return builtInCards;
  }
  return filterValidAiCards(await loadGeneratedVideoAiPracticeCards(scene.id));
}

function mapSceneSourceType(scene: VideoSceneDetail): AiPracticeTopicSourceType {
  return scene.contentOrigin === 'imported' ? 'imported_video' : 'official_video';
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
  // Supabase first: same shape as the legacy OSS path (`getFeaturedVideoScenes`
  // returns the same `VideoSceneDetail[]` fields the rest of this
  // function reads — `id`, `contentOrigin`, `groupId`, `card.title`,
  // `sourceLabel`, plus `aiPracticeCards` for the on-demand load).
  // Fall back to OSS if Supabase is empty (e.g. user hasn't been
  // migrated, or the per-series detail path is mid-migration for a
  // brand-new series).
  let scenes = await listOfficialScenesFromSupabase(forceRefresh);
  if (scenes.length === 0) {
    scenes = await getFeaturedVideoScenes(forceRefresh);
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

  const filteredScenes = pickedSeriesIds === null
    ? scenes
    : scenes.filter((scene) => {
        if (!isOfficial(scene)) return false;
        return pickedSeriesIds.has(scene.groupId as string);
      });

  const groups: Array<VideoAiTopicGroup | null> = await Promise.all(filteredScenes.map(async (scene) => {
    const cards = await loadSceneAiCards(scene);
    if (cards.length === 0) {
      return null;
    }
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
  }));
  return groups
    .filter((item): item is VideoAiTopicGroup => Boolean(item))
    .sort((a, b) => b.previewTopic.fitScore - a.previewTopic.fitScore);
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
