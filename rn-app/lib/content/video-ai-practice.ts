import type { ScenarioCard } from '../ai/scenario-generator';
import { deriveTaskContract, type ScenarioTaskContract } from '../ai/conversation-runtime';
import { callAIProxy, callAIProxyStream } from '../api-client';
import type { VideoSceneDetail } from './video-scenes';
import {
  loadVideoAiPracticeCards,
  saveVideoAiPracticeCards,
  loadVideoAiPracticeState,
  saveVideoAiPracticeState,
} from '../database/video-ai-practice';

export type VideoAiPracticeGenerationStatus = 'idle' | 'generating' | 'completed' | 'failed';

export interface VideoAiPracticeGenerationState {
  sceneId: string;
  status: VideoAiPracticeGenerationStatus;
  progressText: string;
  parsedCount: number;
  targetCount: number;
  cards: ScenarioCard[];
  errorMessage?: string;
  updatedAt: number;
}

type VideoAiPracticeGenerationListener = (state: VideoAiPracticeGenerationState | null) => void;

const generationPromiseStore = new Map<string, Promise<ScenarioCard[]>>();
const generationStateCache = new Map<string, VideoAiPracticeGenerationState>();
const generationListenerStore = new Map<string, Set<VideoAiPracticeGenerationListener>>();

interface RawGeneratedAiPracticeCard {
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
  userInitiates?: boolean;
  openingLine?: string | null;
  openingLineZh?: string | null;
  environmentalCue?: string | null;
  environmentalCueEn?: string | null;
  npcSystemPrompt?: string;
  taskContract?: Partial<ScenarioTaskContract>;
}

interface GenerateVideoAiPracticeOptions {
  onProgress?: (message: string) => void;
  onStreamUpdate?: (payload: {
    cards: ScenarioCard[];
    parsedCount: number;
    targetCount: number;
    titles: string[];
  }) => void;
  /**
   * Titles the user has already seen for this scene. When set,
   * they're injected into the user prompt so the model steers
   * toward fresh angles instead of regenerating near-duplicates.
   * The picker UI uses this when the user taps "换一组" — the
   * previously-displayed titles get fed back to the LLM as
   * "avoid these" context.
   */
  excludeTitles?: string[];
}

export function buildPracticePrompt(level: string, count: number, npcFirstCount: number, userFirstCount: number) {
  return `You are NativeOS, an immersive English learning scenario designer.
Given a video's title, description, and transcript excerpts, generate exactly ${count} real-life English practice scenario cards.

Each card is a conversation scenario where a Chinese learner practises spoken English around topics and scenes extracted from the video.

Learner CEFR level: ${level}

## Dual-Initiation Engine
Every scenario belongs to one of two tracks. The track determines exactly which fields are filled.

### Track A — npc_first (${npcFirstCount} scenarios): NPC speaks first
When: The NPC naturally initiates (e.g. shopkeeper greets a customer, receptionist asks how to help).
Field rules:
- userInitiates = false
- openingLine = NPC's first English sentence (grammatically correct, in-character, appropriate to NPC's role)
- openingLineZh = accurate Chinese translation of openingLine
- environmentalCue = null
- environmentalCueEn = null

### Track B — user_first (${userFirstCount} scenarios): User speaks first
When: The NPC is busy/occupied — user must break the silence to initiate.
Field rules:
- userInitiates = true
- openingLine = null
- openingLineZh = null
- environmentalCue = Chinese-only narration (普通话, 2-3 sentences): describe the scene vividly, what the NPC is doing, and give the user a subtle hint about how to start. NEVER write English here.
- environmentalCueEn = English-only narration: same content as environmentalCue translated to English, CEFR-appropriate for ${level}. NEVER write Chinese here.

### npcSystemPrompt (both tracks)
1-2 English sentences that:
1. Clearly state the NPC's role
2. Clearly state the learner's role
3. Add scenario-appropriate friction
IMPORTANT: Role assignments MUST be logically consistent with the scenario title and desc.

### taskContract (both tracks)
Return a structured conversation contract object that makes the scenario executable across multiple turns:
- objective: one sentence describing the real-world task outcome
- learnerGoal: what the learner is trying to achieve right now
- npcRole: the NPC's responsibility boundary in this scenario
- sceneFrame: the immediate situation or context the conversation starts in
- initialStage: a short snake_case stage name for the first phase of the task
- requiredSlots: 2-4 slot objects with key, label, description, required
- allowedTopicExtensions: realistic adjacent subtopics the NPC may help with after confirming the shift
- outOfScopeTopics: topics that should not replace the main task without confirmation
- completionCriteria: 2-4 concrete conditions for considering the interaction successful

## Other field rules
- desc must be English only and CEFR-matched.
- descZh must be the Chinese translation of desc.
- npcStatus must be a short Chinese phrase describing what the NPC is currently doing.

## Content Rules
- Each card MUST cover a DIFFERENT aspect, scene, or angle extracted from the video transcript.
- Scenarios should be grounded in the video content — use real topics, vocabulary, and situations from the transcript.
- Keep the language natural and conversational, NOT textbook-like.
- Scenarios can extend naturally beyond the video but must stay connected.
- openingLine language complexity must match ${level}.

Return ONLY valid JSON, no markdown:
{
  "scenarios": [
    {
      "id": "ai-<unique 6 chars>",
      "icon": "<single emoji>",
      "category": "<2-4 Chinese chars>",
      "level": "${level}",
      "title": "<Chinese title ≤10 chars>",
      "desc": "<English task description, CEFR-appropriate for ${level}>",
      "descZh": "<Chinese translation of desc ≤30 chars>",
      "npcEmoji": "<single emoji>",
      "npcName": "<NPC first name, English>",
      "npcStatus": "<short Chinese phrase describing what NPC is doing>",
      "userInitiates": true,
      "openingLine": null,
      "openingLineZh": null,
      "environmentalCue": null,
      "environmentalCueEn": null,
      "npcSystemPrompt": "<1-2 English sentences about NPC role, learner role, and friction>",
      "taskContract": {
        "objective": "<one-sentence task objective>",
        "learnerGoal": "<what the learner wants>",
        "npcRole": "<NPC role boundary>",
        "sceneFrame": "<immediate conversation context>",
        "initialStage": "<snake_case stage>",
        "requiredSlots": [
          {
            "key": "<slot_key>",
            "label": "<human label>",
            "description": "<what must be clarified>",
            "required": true
          }
        ],
        "allowedTopicExtensions": ["<adjacent topic>"],
        "outOfScopeTopics": ["<out of scope topic>"],
        "completionCriteria": ["<success condition>"]
      }
    }
  ]
}`;
}

export function getUserFirstRatio(level: string) {
  if (level === 'A1' || level === 'A2') return 0.35;
  if (level === 'B1' || level === 'B2') return 0.65;
  return 0.8;
}

export function computeCardCount(transcriptLines: string[]) {
  const lineCount = transcriptLines.length;
  if (lineCount <= 15) return 3;
  if (lineCount <= 50) return 5;
  return Math.min(8, 3 + Math.floor(lineCount / 20));
}

function extractTranscriptLines(scene: VideoSceneDetail) {
  return scene.segments
    .map((segment) => segment.text.trim())
    .filter(Boolean)
    .slice(0, 40);
}

function buildUserPrompt(
  scene: VideoSceneDetail,
  transcriptLines: string[],
  excludeTitles: readonly string[] = [],
) {
  const description = [
    scene.card.desc,
    scene.card.descZh,
    scene.sourceLabel ? `Source: ${scene.sourceLabel}` : '',
    Array.isArray(scene.goals) && scene.goals.length > 0 ? `Goals: ${scene.goals.join(' / ')}` : '',
  ].filter(Boolean).join('\n');
  // When the user explicitly asks to regenerate topics, we feed
  // the previously-generated titles back into the prompt so the
  // model can steer away from them. The list is bounded — the
  // transcript excerpt is already capped at 900 chars; we cap
  // the avoid list at ~400 chars (≈10 short titles) so it doesn't
  // crowd the prompt.
  const avoidSection = excludeTitles.length > 0
    ? `\nAvoid generating topics similar to these (the user already saw them): ${excludeTitles.slice(0, 10).join(' | ')}`
    : '';
  return `Video title: ${scene.card.title}\nDescription: ${description.slice(0, 900)}\nTranscript (first 40 lines):\n${transcriptLines.join('\n')}${avoidSection}`;
}





async function persistGenerationState(sceneId: string, state: VideoAiPracticeGenerationState | null) {
  // v3: per-scene row in video_ai_practice_state, NULL removes the row.
  if (!state) {
    await saveVideoAiPracticeState(sceneId, null);
    return;
  }
  await saveVideoAiPracticeState(sceneId, { ...state, sceneId });
}

function notifyGenerationState(sceneId: string, state: VideoAiPracticeGenerationState | null) {
  const listeners = generationListenerStore.get(sceneId);
  if (!listeners) {
    return;
  }
  listeners.forEach((listener) => {
    try {
      listener(state);
    } catch {
    }
  });
}

function publishGenerationState(sceneId: string, state: VideoAiPracticeGenerationState | null) {
  if (state) {
    generationStateCache.set(sceneId, state);
  } else {
    generationStateCache.delete(sceneId);
  }
  notifyGenerationState(sceneId, state);
  void persistGenerationState(sceneId, state);
}

function normalizeGenerationState(state: VideoAiPracticeGenerationState | null) {
  if (!state) {
    return null;
  }
  // Only the business side knows whether a live generation promise is
  // running (generationPromiseStore is module-local). If not, a
  // long-running "generating" state means the app died mid-generation.
  if (
    state.status === 'generating'
    && !generationPromiseStore.has(state.sceneId)
  ) {
    return {
      ...state,
      status: 'failed' as const,
      progressText: state.cards.length > 0 ? '上次生成已中断，可重新开始生成。' : '上次生成未完成，请重新开始。',
      errorMessage: state.errorMessage || 'generation_interrupted',
      updatedAt: Date.now(),
    };
  }
  return state;
}

function buildGenerationState(sceneId: string, partial: Partial<VideoAiPracticeGenerationState>): VideoAiPracticeGenerationState {
  const current = generationStateCache.get(sceneId);
  return {
    sceneId,
    status: partial.status ?? current?.status ?? 'idle',
    progressText: partial.progressText ?? current?.progressText ?? '正在准备生成 AI陪练...',
    parsedCount: partial.parsedCount ?? current?.parsedCount ?? 0,
    targetCount: partial.targetCount ?? current?.targetCount ?? 0,
    cards: partial.cards ?? current?.cards ?? [],
    errorMessage: partial.errorMessage,
    updatedAt: partial.updatedAt ?? Date.now(),
  };
}

export async function getVideoAiPracticeGenerationState(sceneId: string): Promise<VideoAiPracticeGenerationState | null> {
  const cached = generationStateCache.get(sceneId);
  if (cached) {
    const normalizedCached = normalizeGenerationState(cached);
    if (normalizedCached !== cached) {
      publishGenerationState(sceneId, normalizedCached);
    }
    return normalizedCached;
  }
  const persisted = normalizeGenerationState(await loadVideoAiPracticeState(sceneId));
  if (persisted) {
    generationStateCache.set(sceneId, persisted);
  }
  return persisted;
}

export function subscribeVideoAiPracticeGenerationState(
  sceneId: string,
  listener: VideoAiPracticeGenerationListener,
) {
  const listeners = generationListenerStore.get(sceneId) ?? new Set<VideoAiPracticeGenerationListener>();
  listeners.add(listener);
  generationListenerStore.set(sceneId, listeners);
  return () => {
    const current = generationListenerStore.get(sceneId);
    if (!current) {
      return;
    }
    current.delete(listener);
    if (current.size === 0) {
      generationListenerStore.delete(sceneId);
    }
  };
}

function extractScenarioObjectsFromPartial(partial: string): string[] {
  const scenariosKeyIndex = partial.indexOf('"scenarios"');
  if (scenariosKeyIndex < 0) return [];

  const arrayStartIndex = partial.indexOf('[', scenariosKeyIndex);
  if (arrayStartIndex < 0) return [];

  const objects: string[] = [];
  let depth = 0;
  let objectStart = -1;
  let inString = false;
  let isEscaping = false;

  for (let index = arrayStartIndex + 1; index < partial.length; index += 1) {
    const char = partial[index];

    if (isEscaping) {
      isEscaping = false;
      continue;
    }

    if (char === '\\' && inString) {
      isEscaping = true;
      continue;
    }

    if (char === '"') {
      inString = !inString;
      continue;
    }

    if (inString) continue;

    if (char === '{') {
      if (depth === 0) objectStart = index;
      depth += 1;
      continue;
    }

    if (char === '}') {
      depth -= 1;
      if (depth === 0 && objectStart >= 0) {
        objects.push(partial.slice(objectStart, index + 1));
        objectStart = -1;
      }
      continue;
    }

    if (char === ']' && depth === 0) {
      break;
    }
  }

  return objects;
}

function extractRawCards(result: unknown): RawGeneratedAiPracticeCard[] {
  if (Array.isArray(result)) {
    return result as RawGeneratedAiPracticeCard[];
  }
  if (result && typeof result === 'object') {
    const scenarios = (result as { scenarios?: unknown }).scenarios;
    if (Array.isArray(scenarios)) {
      return scenarios as RawGeneratedAiPracticeCard[];
    }
    const cards = (result as { cards?: unknown }).cards;
    if (Array.isArray(cards)) {
      return cards as RawGeneratedAiPracticeCard[];
    }
  }
  throw new Error('AI 返回的陪练卡片格式不正确');
}

function normalizeGeneratedCard(scene: VideoSceneDetail, raw: RawGeneratedAiPracticeCard, index: number): ScenarioCard {
  const userInitiates = raw.userInitiates === true;
  const openingLine = userInitiates ? undefined : raw.openingLine || undefined;
  const openingLineZh = userInitiates ? undefined : raw.openingLineZh || undefined;
  const environmentalCue = userInitiates ? raw.environmentalCue || undefined : undefined;
  const environmentalCueEn = userInitiates ? raw.environmentalCueEn || undefined : undefined;
  const title = (raw.title || `视频延展 ${index + 1}`).trim();
  const desc = (raw.desc || `Continue practicing after watching ${scene.card.title}.`).trim();
  const category = (raw.category || scene.card.category || '视频延展').trim();
  const npcName = (raw.npcName || 'Practice Partner').trim();
  const npcStatus = raw.npcStatus?.trim() || undefined;
  const npcSystemPrompt = raw.npcSystemPrompt?.trim() || undefined;
  return {
    id: raw.id?.trim() || `${scene.id}__ai_gen__${index + 1}`,
    sourceType: 'ai_scenario',
    icon: raw.icon?.trim() || '💬',
    category,
    level: (raw.level || scene.card.level || 'B1').trim(),
    title,
    desc,
    descZh: raw.descZh?.trim() || undefined,
    npcEmoji: raw.npcEmoji?.trim() || '💬',
    npcName,
    npcStatus,
    openingLine,
    openingLineZh,
    environmentalCue,
    environmentalCueEn,
    npcSystemPrompt,
    taskContract: deriveTaskContract({
      title,
      desc,
      category,
      npcName,
      npcStatus,
      npcSystemPrompt,
      openingLine,
      environmentalCue,
      environmentalCueEn,
    }, raw.taskContract),
    userInitiates,
  };
}

function getRawCardKey(raw: RawGeneratedAiPracticeCard) {
  return (raw.id?.trim()
    || `${raw.title?.trim().toLowerCase() || ''}__${raw.desc?.trim().toLowerCase() || ''}`
    || `raw_${Math.random().toString(36).slice(2, 8)}`);
}

function emitStreamUpdate(
  options: GenerateVideoAiPracticeOptions | undefined,
  cards: ScenarioCard[],
  targetCount: number,
) {
  options?.onStreamUpdate?.({
    cards: cards.slice(),
    parsedCount: cards.length,
    targetCount,
    titles: cards.map((card) => card.title).slice(0, 8),
  });
}

function appendNormalizedCard(
  scene: VideoSceneDetail,
  raw: RawGeneratedAiPracticeCard,
  cards: ScenarioCard[],
  seenKeys: Set<string>,
) {
  const key = getRawCardKey(raw);
  if (seenKeys.has(key)) {
    return false;
  }
  const normalized = normalizeGeneratedCard(scene, raw, cards.length);
  if (!(normalized.npcSystemPrompt || normalized.openingLine || normalized.npcName)) {
    return false;
  }
  seenKeys.add(key);
  cards.push(normalized);
  return true;
}

async function generateVideoAiPracticeCardsNonStreaming(
  scene: VideoSceneDetail,
  transcriptLines: string[],
  level: string,
  count: number,
  npcFirstCount: number,
  userFirstCount: number,
  options?: GenerateVideoAiPracticeOptions,
) {
  options?.onProgress?.('正在兼容模式下生成 AI陪练场景...');
  const excludeTitles = options?.excludeTitles ?? [];
  const result = await callAIProxy({
    type: 'generate-card',
    prompt: buildUserPrompt(scene, transcriptLines, excludeTitles),
    systemMessage: buildPracticePrompt(level, count, npcFirstCount, userFirstCount),
    userLevel: level,
    maxTokens: 5200,
  });
  options?.onProgress?.('正在整理生成结果...');
  const seenKeys = new Set<string>();
  const normalized: ScenarioCard[] = [];
  extractRawCards(result).forEach((raw) => {
    appendNormalizedCard(scene, raw, normalized, seenKeys);
  });
  emitStreamUpdate(options, normalized, count);
  if (normalized.length === 0) {
    throw new Error('AI 没有返回可用的陪练卡片');
  }
  return normalized;
}

export async function loadGeneratedVideoAiPracticeCards(sceneId: string): Promise<ScenarioCard[]> {
  return await loadVideoAiPracticeCards(sceneId);
}

export async function saveGeneratedVideoAiPracticeCards(sceneId: string, cards: ScenarioCard[]): Promise<void> {
  await saveVideoAiPracticeCards(sceneId, cards);
}

export async function generateVideoAiPracticeCards(
  scene: VideoSceneDetail,
  options?: GenerateVideoAiPracticeOptions,
): Promise<ScenarioCard[]> {
  const existingPromise = generationPromiseStore.get(scene.id);
  if (existingPromise) {
    return existingPromise;
  }

  const transcriptLines = extractTranscriptLines(scene);
  const level = scene.card.level || 'B1';
  const count = computeCardCount(transcriptLines);
  const userFirstCount = Math.round(count * getUserFirstRatio(level));
  const npcFirstCount = count - userFirstCount;
  const excludeTitles = options?.excludeTitles ?? [];
  const prompt = buildUserPrompt(scene, transcriptLines, excludeTitles);
  const systemMessage = buildPracticePrompt(level, count, npcFirstCount, userFirstCount);
  const cards: ScenarioCard[] = [];
  const seenKeys = new Set<string>();
  let streamedObjectCount = 0;
  let streamFullText = '';

  const syncProgress = (message: string) => {
    options?.onProgress?.(message);
    publishGenerationState(scene.id, buildGenerationState(scene.id, {
      status: 'generating',
      progressText: message,
      targetCount: count,
      parsedCount: cards.length,
      cards: cards.slice(),
      errorMessage: undefined,
    }));
  };

  const syncStreamCards = () => {
    emitStreamUpdate(options, cards, count);
    publishGenerationState(scene.id, buildGenerationState(scene.id, {
      status: 'generating',
      progressText: generationStateCache.get(scene.id)?.progressText ?? '正在生成 AI陪练...',
      parsedCount: cards.length,
      targetCount: count,
      cards: cards.slice(),
      errorMessage: undefined,
    }));
  };

  emitStreamUpdate(options, cards, count);
  publishGenerationState(scene.id, buildGenerationState(scene.id, {
    status: 'generating',
    progressText: '正在整理视频字幕与上下文...',
    parsedCount: 0,
    targetCount: count,
    cards: [],
    errorMessage: undefined,
  }));

  const generationPromise = (async () => {
    try {
      syncProgress('正在建立实时生成连接...');
      try {
        streamFullText = await callAIProxyStream({
          type: 'generate-card',
          prompt,
          systemMessage,
          userLevel: level,
          maxTokens: 5200,
        }, (partial) => {
          const objects = extractScenarioObjectsFromPartial(partial);
          let appendedCount = 0;
          for (let index = streamedObjectCount; index < objects.length; index += 1) {
            try {
              const raw = JSON.parse(objects[index]) as RawGeneratedAiPracticeCard;
              if (appendNormalizedCard(scene, raw, cards, seenKeys)) {
                appendedCount += 1;
              }
              streamedObjectCount = index + 1;
            } catch {
              break;
            }
          }
          if (appendedCount > 0) {
            syncStreamCards();
            syncProgress(
              cards.length >= count
                ? `已实时解析 ${cards.length}/${count} 个场景，正在整理剩余输出...`
                : `已实时解析 ${cards.length}/${count} 个场景...`,
            );
          }
        });
      } catch {
        syncProgress('流式生成中断，正在切换兼容模式...');
        const fallbackCards = await generateVideoAiPracticeCardsNonStreaming(
          scene,
          transcriptLines,
          level,
          count,
          npcFirstCount,
          userFirstCount,
          options,
        );
        syncProgress('正在写入本地缓存...');
        await saveGeneratedVideoAiPracticeCards(scene.id, fallbackCards);
        publishGenerationState(scene.id, buildGenerationState(scene.id, {
          status: 'completed',
          progressText: 'AI陪练已生成，等待选择主题...',
          parsedCount: fallbackCards.length,
          targetCount: count,
          cards: fallbackCards.slice(),
          errorMessage: undefined,
        }));
        options?.onProgress?.('AI陪练已生成，正在准备打开...');
        return fallbackCards;
      }

      syncProgress('正在整理生成结果...');
      try {
        const parsed = JSON.parse(streamFullText);
        extractRawCards(parsed).forEach((raw) => {
          appendNormalizedCard(scene, raw, cards, seenKeys);
        });
      } catch {
        if (cards.length === 0) {
          throw new Error('AI 返回的陪练卡片格式不正确');
        }
      }

      syncStreamCards();

      if (cards.length === 0) {
        throw new Error('AI 没有返回可用的陪练卡片');
      }
      syncProgress('正在写入本地缓存...');
      await saveGeneratedVideoAiPracticeCards(scene.id, cards);
      publishGenerationState(scene.id, buildGenerationState(scene.id, {
        status: 'completed',
        progressText: 'AI陪练已生成，等待选择主题...',
        parsedCount: cards.length,
        targetCount: count,
        cards: cards.slice(),
        errorMessage: undefined,
      }));
      options?.onProgress?.('AI陪练已生成，正在准备打开...');
      return cards;
    } catch (error) {
      publishGenerationState(scene.id, buildGenerationState(scene.id, {
        status: 'failed',
        progressText: cards.length > 0 ? '生成中断了，你可以重新开始生成。' : '生成失败，请重试。',
        parsedCount: cards.length,
        targetCount: count,
        cards: cards.slice(),
        errorMessage: error instanceof Error ? error.message : 'AI陪练生成失败',
      }));
      throw error;
    } finally {
      generationPromiseStore.delete(scene.id);
    }
  })();

  generationPromiseStore.set(scene.id, generationPromise);
  return generationPromise;
}
