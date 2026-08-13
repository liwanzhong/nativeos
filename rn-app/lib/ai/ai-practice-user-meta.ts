/**
 * AI practice per-topic user meta — re-exports + builders.
 *
 * IO (list/get/markUsed/setFavorite/toggleFavorite) is SQLite-backed
 * as of schema v4 (see lib/database/ai-practice-user-meta.ts and
 * docs/2026-08-05-storage-migration-plan.md).
 *
 * This file keeps:
 *   - Type definitions (AiPracticeTopicOrigin / SourceType / Snapshot)
 *   - Sanitisers (used at data-entry time to keep DB rows clean)
 *   - Builders (buildAiPracticeTopicId / buildAiPracticeTopicSnapshot)
 *
 * Legacy store IO + sanitise-on-read helpers were removed in v4; the
 * SQLite side does its own row→record mapping.
 */

import type { ScenarioCard } from './scenario-generator';

export type AiPracticeTopicOrigin = 'recommended' | 'video' | 'from_video_chip' | 'from_recommended' | 'from_custom';
export type AiPracticeTopicSourceType = 'recommended' | 'official_video' | 'imported_video' | 'video_chip' | 'recommended_topic' | 'custom_topic';

/**
 * Re-exported for callers that only want the home origin subset.
 * @see lib/database/ai-practice-user-meta.ts
 */
export type { AiPracticeHomeOrigin } from '../database/ai-practice-user-meta';

export interface AiPracticeTopicSnapshot {
  topicId: string;
  card: ScenarioCard;
  origin: AiPracticeTopicOrigin;
  sourceType: AiPracticeTopicSourceType;
  sourceLabel: string;
  sourceId?: string;
  sceneTitle?: string;
  importSourceLabel?: string;
  title: string;
  level: string;
  category: string;
  icon: string;
  desc?: string;
  descZh?: string;
  /**
   * Timestamp the user added this topic to their AI 陪练 home.
   * Drives home grid sort order (newest on top). Optional on legacy
   * rows (no home concept before 2026-08-13 redesign).
   */
  homeAddedAt?: number;
}

export interface AiPracticeUserMetaRecord extends AiPracticeTopicSnapshot {
  isFavorite?: boolean;
  favoritedAt?: number;
  lastUsedAt?: number;
  useCount: number;
  updatedAt: number;
}

// ── Sanitisers (still useful at data-entry time) ──────────────────

function normalizeText(value?: string | null) {
  return (value || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '_')
    .replace(/[^a-z0-9_\-\u4e00-\u9fa5]/g, '')
    || 'untitled';
}

function sanitizeScenarioCard(raw: unknown): ScenarioCard | null {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  const candidate = raw as Partial<ScenarioCard>;
  if (typeof candidate.title !== 'string' || candidate.title.trim().length === 0) {
    return null;
  }
  return {
    id: typeof candidate.id === 'string' && candidate.id.trim().length > 0
      ? candidate.id
      : `ai_topic_${normalizeText(candidate.title)}`,
    sourceType: candidate.sourceType,
    icon: typeof candidate.icon === 'string' && candidate.icon.trim().length > 0 ? candidate.icon : '💬',
    category: typeof candidate.category === 'string' && candidate.category.trim().length > 0 ? candidate.category : '陪练',
    level: typeof candidate.level === 'string' && candidate.level.trim().length > 0 ? candidate.level : 'B1',
    title: candidate.title,
    desc: typeof candidate.desc === 'string' ? candidate.desc : '',
    descZh: typeof candidate.descZh === 'string' ? candidate.descZh : undefined,
    npcEmoji: typeof candidate.npcEmoji === 'string' ? candidate.npcEmoji : undefined,
    npcName: typeof candidate.npcName === 'string' ? candidate.npcName : undefined,
    npcStatus: typeof candidate.npcStatus === 'string' ? candidate.npcStatus : undefined,
    openingLine: typeof candidate.openingLine === 'string' ? candidate.openingLine : undefined,
    openingLineZh: typeof candidate.openingLineZh === 'string' ? candidate.openingLineZh : undefined,
    environmentalCue: typeof candidate.environmentalCue === 'string' ? candidate.environmentalCue : undefined,
    environmentalCueEn: typeof candidate.environmentalCueEn === 'string' ? candidate.environmentalCueEn : undefined,
    npcSystemPrompt: typeof candidate.npcSystemPrompt === 'string' ? candidate.npcSystemPrompt : undefined,
    taskContract: candidate.taskContract,
    userInitiates: candidate.userInitiates === true,
    modelUrl: typeof candidate.modelUrl === 'string' ? candidate.modelUrl : undefined,
  };
}

function sanitizeAiPracticeTopicSnapshot(raw: unknown): AiPracticeTopicSnapshot | null {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  const candidate = raw as Partial<AiPracticeTopicSnapshot>;
  const card = sanitizeScenarioCard(candidate.card);
  if (!card || typeof candidate.topicId !== 'string' || candidate.topicId.trim().length === 0) {
    return null;
  }
  const origin: AiPracticeTopicOrigin =
    candidate.origin === 'video' ? 'video'
    : candidate.origin === 'from_video_chip' ? 'from_video_chip'
    : candidate.origin === 'from_recommended' ? 'from_recommended'
    : candidate.origin === 'from_custom' ? 'from_custom'
    : 'recommended';
  const sourceType: AiPracticeTopicSourceType =
    candidate.sourceType === 'official_video' ? 'official_video'
    : candidate.sourceType === 'imported_video' ? 'imported_video'
    : candidate.sourceType === 'video_chip' ? 'video_chip'
    : candidate.sourceType === 'recommended_topic' ? 'recommended_topic'
    : candidate.sourceType === 'custom_topic' ? 'custom_topic'
    : 'recommended';
  return {
    topicId: candidate.topicId,
    card,
    origin,
    sourceType,
    sourceLabel: typeof candidate.sourceLabel === 'string' && candidate.sourceLabel.trim().length > 0
      ? candidate.sourceLabel
      : '推荐话题',
    sourceId: typeof candidate.sourceId === 'string' && candidate.sourceId.trim().length > 0
      ? candidate.sourceId
      : undefined,
    sceneTitle: typeof candidate.sceneTitle === 'string' && candidate.sceneTitle.trim().length > 0
      ? candidate.sceneTitle
      : undefined,
    importSourceLabel: typeof candidate.importSourceLabel === 'string' && candidate.importSourceLabel.trim().length > 0
      ? candidate.importSourceLabel
      : undefined,
    title: typeof candidate.title === 'string' && candidate.title.trim().length > 0
      ? candidate.title
      : card.title,
    level: typeof candidate.level === 'string' && candidate.level.trim().length > 0
      ? candidate.level
      : card.level,
    category: typeof candidate.category === 'string' && candidate.category.trim().length > 0
      ? candidate.category
      : card.category,
    icon: typeof candidate.icon === 'string' && candidate.icon.trim().length > 0
      ? candidate.icon
      : card.icon,
    desc: typeof candidate.desc === 'string' ? candidate.desc : card.desc,
    descZh: typeof candidate.descZh === 'string' ? candidate.descZh : card.descZh,
    homeAddedAt: typeof candidate.homeAddedAt === 'number' ? candidate.homeAddedAt : undefined,
  };
}

export { sanitizeAiPracticeTopicSnapshot, sanitizeScenarioCard };

// ── Builders ───────────────────────────────────────────────────────

export function buildAiPracticeTopicId(params: {
  card: ScenarioCard;
  origin: AiPracticeTopicOrigin;
  sourceType: AiPracticeTopicSourceType;
  sourceId?: string;
  title?: string;
  category?: string;
  level?: string;
}) {
  const title = normalizeText(params.title || params.card.title);
  const category = normalizeText(params.category || params.card.category);
  const level = normalizeText(params.level || params.card.level);
  if (params.origin === 'video') {
    const sourceId = normalizeText(params.sourceId || 'video');
    const cardId = normalizeText(params.card.id || `${level}_${category}_${title}`);
    return `video::${sourceId}::${cardId}`;
  }
  return `recommended::${level}::${category}::${title}`;
}

export function buildAiPracticeTopicSnapshot(params: {
  card: ScenarioCard;
  origin: AiPracticeTopicOrigin;
  sourceType: AiPracticeTopicSourceType;
  sourceLabel: string;
  sourceId?: string;
  sceneTitle?: string;
  importSourceLabel?: string;
}): AiPracticeTopicSnapshot {
  const topicId = buildAiPracticeTopicId({
    card: params.card,
    origin: params.origin,
    sourceType: params.sourceType,
    sourceId: params.sourceId,
  });
  return {
    topicId,
    card: params.card,
    origin: params.origin,
    sourceType: params.sourceType,
    sourceLabel: params.sourceLabel,
    sourceId: params.sourceId,
    sceneTitle: params.sceneTitle,
    importSourceLabel: params.importSourceLabel,
    title: params.card.title,
    level: params.card.level,
    category: params.card.category,
    icon: params.card.icon,
    desc: params.card.desc,
    descZh: params.card.descZh,
  };
}

// ── IO re-exports (SQLite-backed, schema v4) ─────────────────────

export {
  getAiPracticeUserMeta,
  listAiPracticeUserMeta,
  markAiPracticeTopicUsed,
  setAiPracticeTopicFavorite,
  toggleAiPracticeTopicFavorite,
  addAiTopicToHome,
  removeAiTopicFromHome,
  listHomeAiTopics,
} from '../database/ai-practice-user-meta';
