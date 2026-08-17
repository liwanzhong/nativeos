/**
 * User-video AI practice topic generation.
 *
 * Parallel of `video-ai-practice.ts` but for entries stored in
 * `user-videos/index.json` (local imports + cloud references +
 * the .deckpack flow when it lives there). The data flow is the
 * same shape:
 *
 *   1. Read the saved subtitle JSON3 for the entry.
 *   2. Extract a short transcript (first ~40 lines) and feed it
 *      to the LLM via the existing `callAIProxy` 'generate-card'
 *      prompt (re-using `buildPracticePrompt` / `getUserFirstRatio`
 *      / `computeCardCount` from `video-ai-practice.ts` so the
 *      user-video and official scenes produce the same kind of
 *      scenario cards).
 *   3. Persist the generated cards to a per-entry JSON file under
 *      `user-videos/ai-practice/<entryId>.json`.
 *   4. Patch the entry's `aiPractice*` fields so the index row
 *      carries the latest status / count / updatedAt / etc.
 *
 * The state machine (idle → processing → ready / error) is
 * in-memory + entry-persisted, mirroring the scene-side flow but
 * the source of truth is the user-videos index, not a separate
 * SQLite table.
 */

import { readAsStringAsync, writeAsStringAsync } from 'expo-file-system/legacy';
import type { ScenarioCard } from '../ai/scenario-generator';
import { deriveTaskContract, type ScenarioTaskContract } from '../ai/conversation-runtime';
import { callAIProxy, callAIProxyStream } from '../api-client';
import {
  buildPracticePrompt,
  getUserFirstRatio,
  computeCardCount,
} from './video-ai-practice';
import {
  getUserVideoEntryById,
  updateUserVideoEntryFields,
  type UserVideoEntry,
} from './user-videos';
import { consumeAndNotify, isByokEnabled, type ConsumeResult } from '../quota';

/**
 * Thrown by `generateUserVideoAiPracticeCards` when the daily
 * `ai_rounds` quota is already exhausted. Carries the verdict so
 * the caller can hand it straight to `quotaDialog.show(...)`.
 */
export class QuotaBlockedError extends Error {
  verdict: ConsumeResult;
  constructor(verdict: ConsumeResult) {
    super(`ai_rounds quota exhausted (${verdict.used}/${verdict.hard})`);
    this.name = 'QuotaBlockedError';
    this.verdict = verdict;
  }
}

const USER_VIDEOS_ROOT_DIR = `${userVideosRootDir()}`;
const USER_VIDEOS_AI_PRACTICE_DIR = `${USER_VIDEOS_ROOT_DIR}/ai-practice`;

function userVideosRootDir() {
  // Lazily require expo-file-system/legacy so this module can be
  // imported in test environments without an immediate crash.
  // (The actual runtime always has `documentDirectory` set.)
  const { documentDirectory } = require('expo-file-system/legacy') as { documentDirectory?: string | null };
  return `${documentDirectory ?? ''}user-videos`;
}

const GENERATION_PENDING = 'idle' as const;
const GENERATION_PROCESSING = 'processing' as const;
const GENERATION_READY = 'ready' as const;
const GENERATION_ERROR = 'error' as const;

export type UserVideoAiPracticeStatus = 'none' | 'pending' | 'processing' | 'ready' | 'error';

export interface UserVideoAiPracticeState {
  entryId: string;
  status: 'idle' | 'processing' | 'ready' | 'error';
  phase?: 'preparing' | 'extracting-subtitle' | 'calling-llm' | 'saving';
  progress?: number;          // 0..1
  progressText?: string;
  parsedCount: number;
  targetCount: number;
  cards: ScenarioCard[];
  errorMessage?: string;
  updatedAt: number;
}

type UserVideoAiPracticeListener = (state: UserVideoAiPracticeState | null) => void;

const generationPromiseStore = new Map<string, Promise<ScenarioCard[]>>();
const generationStateCache = new Map<string, UserVideoAiPracticeState>();
const generationListenerStore = new Map<string, Set<UserVideoAiPracticeListener>>();

// ── State machine helpers ─────────────────────────────────────────

function aiPracticeDirUri() {
  return USER_VIDEOS_AI_PRACTICE_DIR;
}

function aiPracticeFileUri(entryId: string) {
  return `${aiPracticeDirUri()}/${entryId}.json`;
}

async function ensureAiPracticeDir() {
  const { documentDirectory } = require('expo-file-system/legacy') as { documentDirectory?: string | null };
  if (!documentDirectory) {
    throw new Error('当前设备不支持本地 AI 话题文件');
  }
  // Lazy require the directory helper to keep this module's
  // top-level imports slim.
  const fs = require('expo-file-system/legacy') as typeof import('expo-file-system/legacy');
  const info = await fs.getInfoAsync(aiPracticeDirUri());
  if (!info.exists) {
    await fs.makeDirectoryAsync(aiPracticeDirUri(), { intermediates: true });
  }
}

function buildState(entryId: string, partial: Partial<UserVideoAiPracticeState>): UserVideoAiPracticeState {
  const current = generationStateCache.get(entryId);
  return {
    entryId,
    status: partial.status ?? current?.status ?? 'idle',
    phase: partial.phase ?? current?.phase,
    progress: partial.progress ?? current?.progress,
    progressText: partial.progressText ?? current?.progressText ?? '正在准备 AI 话题…',
    parsedCount: partial.parsedCount ?? current?.parsedCount ?? 0,
    targetCount: partial.targetCount ?? current?.targetCount ?? 0,
    cards: partial.cards ?? current?.cards ?? [],
    errorMessage: partial.errorMessage,
    updatedAt: partial.updatedAt ?? Date.now(),
  };
}

function notifyGenerationState(entryId: string, state: UserVideoAiPracticeState | null) {
  const listeners = generationListenerStore.get(entryId);
  if (!listeners) return;
  listeners.forEach((listener) => {
    try { listener(state); } catch { /* listener errors are non-fatal */ }
  });
}

function publishGenerationState(entryId: string, state: UserVideoAiPracticeState | null) {
  if (state) {
    generationStateCache.set(entryId, state);
  } else {
    generationStateCache.delete(entryId);
  }
  notifyGenerationState(entryId, state);
  // Fire-and-forget entry persistence. The entry is the source of
  // truth across app restarts; the in-memory cache is just a
  // short-lived fast path.
  if (state) {
    void patchEntryFromState(state).catch((err) => {
      console.warn('[UserVideoAiPractice] persist state failed', { entryId, err });
    });
  }
}

function normalizePersistedState(state: UserVideoAiPracticeState | null): UserVideoAiPracticeState | null {
  if (!state) return null;
  // Same orphan-run guard as `video-ai-practice`: if the app died
  // mid-generation (status='processing' with no live promise),
  // downgrade to 'error' so the UI doesn't get stuck.
  if (state.status === 'processing' && !generationPromiseStore.has(state.entryId)) {
    return {
      ...state,
      status: 'error',
      progressText: state.cards.length > 0
        ? '上次生成已中断，可重新开始。'
        : '上次生成未完成，请重新开始。',
      errorMessage: state.errorMessage || 'generation_interrupted',
      updatedAt: Date.now(),
    };
  }
  return state;
}

async function patchEntryFromState(state: UserVideoAiPracticeState) {
  const status: UserVideoAiPracticeStatus =
    state.status === 'idle' ? 'none'
    : state.status === 'processing' ? 'processing'
    : state.status === 'ready' ? 'ready'
    : state.status === 'error' ? 'error'
    : 'none';
  await updateUserVideoEntryFields(state.entryId, {
    aiPracticeStatus: status,
    aiPracticePhase: state.phase,
    aiPracticeProgress: state.progress,
    aiPracticeProgressMessage: state.progressText,
    aiPracticeCount: state.cards.length,
    aiPracticeErrorMessage: state.errorMessage,
    // aiPracticeUri and aiPracticeUpdatedAt are set on the
    // 'ready' path; here we just track the live count + status.
  });
}

// ── JSON3 transcript extraction ──────────────────────────────────

interface Json3Event {
  tStartMs: number;
  dDurationMs: number;
  segs: Array<{ utf8: string }>;
}

interface Json3File {
  wireMagic?: string;
  events: Json3Event[];
}

function extractTranscriptFromJson3(json3: Json3File): string[] {
  return json3.events
    .flatMap((event) => event.segs?.map((seg) => (seg.utf8 || '').trim()) ?? [])
    .filter(Boolean)
    .slice(0, 40);
}

async function readTranscriptForEntry(entry: UserVideoEntry): Promise<string[]> {
  if (!entry.subtitleUri) {
    throw new Error('尚未生成字幕,无法生成 AI 话题');
  }
  const raw = await readAsStringAsync(entry.subtitleUri);
  if (!raw.trim()) {
    throw new Error('字幕文件为空,无法生成 AI 话题');
  }
  const parsed = JSON.parse(raw) as Json3File;
  if (!Array.isArray(parsed?.events)) {
    throw new Error('字幕文件格式不正确,无法生成 AI 话题');
  }
  return extractTranscriptFromJson3(parsed);
}

// ── Card normalization (mirror of `video-ai-practice` but for user-video metadata) ──

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

interface CardSourceContext {
  entryId: string;
  title: string;
  category: string;
  level: string;
}

function normalizeUserVideoCard(ctx: CardSourceContext, raw: RawGeneratedAiPracticeCard, index: number): ScenarioCard {
  const userInitiates = raw.userInitiates === true;
  const openingLine = userInitiates ? undefined : raw.openingLine || undefined;
  const openingLineZh = userInitiates ? undefined : raw.openingLineZh || undefined;
  const environmentalCue = userInitiates ? raw.environmentalCue || undefined : undefined;
  const environmentalCueEn = userInitiates ? raw.environmentalCueEn || undefined : undefined;
  const title = (raw.title || `视频拓展 ${index + 1}`).trim();
  const desc = (raw.desc || `Continue practicing after watching ${ctx.title}.`).trim();
  const category = (raw.category || ctx.category || '视频拓展').trim();
  const npcName = (raw.npcName || 'Practice Partner').trim();
  const npcStatus = raw.npcStatus?.trim() || undefined;
  const npcSystemPrompt = raw.npcSystemPrompt?.trim() || undefined;
  return {
    id: raw.id?.trim() || `${ctx.entryId}__ai_gen__${index + 1}`,
    sourceType: 'ai_scenario',
    icon: raw.icon?.trim() || '💬',
    category,
    level: (raw.level || ctx.level || 'B1').trim(),
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

function getRawCardKey(raw: RawGeneratedAiPracticeCard): string {
  return raw.id?.trim()
    || `${raw.title?.trim().toLowerCase() || ''}__${raw.desc?.trim().toLowerCase() || ''}`
    || `raw_${Math.random().toString(36).slice(2, 8)}`;
}

function appendNormalizedCard(
  ctx: CardSourceContext,
  raw: RawGeneratedAiPracticeCard,
  cards: ScenarioCard[],
  seenKeys: Set<string>,
): boolean {
  const key = getRawCardKey(raw);
  if (seenKeys.has(key)) return false;
  const normalized = normalizeUserVideoCard(ctx, raw, cards.length);
  if (!(normalized.npcSystemPrompt || normalized.openingLine || normalized.npcName)) {
    return false;
  }
  cards.push(normalized);
  seenKeys.add(key);
  return true;
}

function extractRawCards(result: unknown): RawGeneratedAiPracticeCard[] {
  if (Array.isArray(result)) return result as RawGeneratedAiPracticeCard[];
  if (result && typeof result === 'object') {
    const scenarios = (result as { scenarios?: unknown }).scenarios;
    if (Array.isArray(scenarios)) return scenarios as RawGeneratedAiPracticeCard[];
    const cards = (result as { cards?: unknown }).cards;
    if (Array.isArray(cards)) return cards as RawGeneratedAiPracticeCard[];
  }
  throw new Error('AI 返回的 AI 话题卡片格式不正确');
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
    if (isEscaping) { isEscaping = false; continue; }
    if (char === '\\' && inString) { isEscaping = true; continue; }
    if (char === '"') { inString = !inString; continue; }
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
    if (char === ']' && depth === 0) break;
  }
  return objects;
}

// ── Prompt assembly ──────────────────────────────────────────────

function buildUserPrompt(
  ctx: CardSourceContext,
  transcriptLines: string[],
  sourceLabel: string,
  excludeTitles: readonly string[] = [],
): string {
  const description = [
    ctx.title,
    `Source: ${sourceLabel}`,
  ].filter(Boolean).join('\n');
  // When the user explicitly asks to regenerate, the previously
  // shown titles are fed back to the model as "avoid these" so
  // the new batch leans into fresh angles rather than re-running
  // near-duplicates of the first run. Capped at 10 to keep the
  // user prompt from getting too long.
  const avoidSection = excludeTitles.length > 0
    ? `\nAvoid generating topics similar to these (the user already saw them): ${excludeTitles.slice(0, 10).join(' | ')}`
    : '';
  return `Video title: ${ctx.title}\nDescription: ${description.slice(0, 900)}\nTranscript (first 40 lines):\n${transcriptLines.join('\n')}${avoidSection}`;
}

// ── Persistence (cards JSON file) ────────────────────────────────

async function saveCardsToFile(entryId: string, cards: ScenarioCard[]): Promise<string> {
  await ensureAiPracticeDir();
  const uri = aiPracticeFileUri(entryId);
  await writeAsStringAsync(uri, JSON.stringify(cards, null, 2));
  return uri;
}

export async function loadGeneratedUserVideoAiPracticeCards(entryId: string): Promise<ScenarioCard[]> {
  try {
    const raw = await readAsStringAsync(aiPracticeFileUri(entryId));
    if (!raw.trim()) return [];
    const parsed = JSON.parse(raw) as ScenarioCard[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// ── Public API ───────────────────────────────────────────────────

export async function getUserVideoAiPracticeState(entryId: string): Promise<UserVideoAiPracticeState | null> {
  const cached = generationStateCache.get(entryId);
  if (cached) {
    const normalized = normalizePersistedState(cached);
    if (normalized !== cached) publishGenerationState(entryId, normalized);
    return normalized;
  }
  // Fall back to the entry's persisted fields. We DON'T have
  // cards here (they live in the JSON file); we surface count +
  // status from the entry and skip the cards payload to avoid
  // loading the file on every read.
  const entry = await getUserVideoEntryById(entryId);
  if (!entry || !entry.aiPracticeStatus || entry.aiPracticeStatus === 'none') {
    return null;
  }
  const status: UserVideoAiPracticeState['status'] =
    entry.aiPracticeStatus === 'processing' ? 'processing'
    : entry.aiPracticeStatus === 'ready' ? 'ready'
    : entry.aiPracticeStatus === 'error' ? 'error'
    : 'idle';
  const state: UserVideoAiPracticeState = {
    entryId,
    status,
    phase: entry.aiPracticePhase,
    progress: entry.aiPracticeProgress,
    progressText: entry.aiPracticeProgressMessage,
    parsedCount: entry.aiPracticeCount ?? 0,
    targetCount: entry.aiPracticeCount ?? 0,
    cards: [],
    errorMessage: entry.aiPracticeErrorMessage,
    updatedAt: entry.aiPracticeUpdatedAt ? Date.parse(entry.aiPracticeUpdatedAt) : Date.now(),
  };
  const normalized = normalizePersistedState(state);
  if (normalized) generationStateCache.set(entryId, normalized);
  return normalized;
}

export function subscribeUserVideoAiPracticeState(
  entryId: string,
  listener: UserVideoAiPracticeListener,
): () => void {
  const listeners = generationListenerStore.get(entryId) ?? new Set<UserVideoAiPracticeListener>();
  listeners.add(listener);
  generationListenerStore.set(entryId, listeners);
  return () => {
    const current = generationListenerStore.get(entryId);
    if (!current) return;
    current.delete(listener);
    if (current.size === 0) generationListenerStore.delete(entryId);
  };
}

// ── Main entry point: trigger generation ─────────────────────────

/**
 * Kick off AI practice topic generation for a user-video entry.
 * Idempotent: if a generation is already in flight for the same
 * entry, the existing promise is returned (matches the
 * `video-ai-practice` semantics).
 *
 * Caller is responsible for having already verified
 * `cacheStatus === 'cached'` and `subtitleStatus === 'ready'`.
 * This function still asserts both — defence in depth — and
 * throws a clear error so the UI can surface the right copy.
 */
export async function generateUserVideoAiPracticeCards(
  entryId: string,
  options?: { excludeTitles?: string[] },
): Promise<ScenarioCard[]> {
  const existing = generationPromiseStore.get(entryId);
  if (existing) return existing;

  // 2026-08-17: Pro gate. One generation = one ai_rounds charge (the
  // work is a single LLM call, regardless of how many cards come
  // back). BYOK users skip the NativeOS counter. Idempotency note:
  // the in-flight check above means a re-tap during an in-flight
  // generation returns the cached promise WITHOUT re-charging —
  // exactly what we want.
  const byokOn = await isByokEnabled();
  if (!byokOn) {
    const verdict = await consumeAndNotify('ai_rounds');
    if (!verdict.allowed) {
      throw new QuotaBlockedError(verdict);
    }
  }

  const entry = await getUserVideoEntryById(entryId);
  if (!entry) throw new Error('视频记录不存在');

  // Gate on cached + subtitle-ready. Mirrors the user-facing
  // preconditions; the row's "AI 话题" chip relies on these too.
  if (entry.sourceType === 'cloud_reference' && !entry.cachedLocalUri) {
    throw new Error('需要先缓存到本地,才能生成 AI 话题');
  }
  if (entry.subtitleStatus !== 'ready' || !entry.subtitleUri) {
    throw new Error('需要先生成字幕,才能生成 AI 话题');
  }

  const promise = (async () => {
    const ctx: CardSourceContext = {
      entryId,
      title: entry.title,
      category: entry.category,
      level: entry.level,
    };
    try {
      // Phase 1: prepare — load transcript, decide card count.
      publishGenerationState(entryId, buildState(entryId, {
        status: 'processing',
        phase: 'preparing',
        progress: 0.05,
        progressText: '正在准备字幕内容…',
        cards: [],
        parsedCount: 0,
        targetCount: 0,
        errorMessage: undefined,
      }));
      const transcriptLines = await readTranscriptForEntry(entry);
      if (transcriptLines.length === 0) {
        throw new Error('字幕内容为空,无法生成 AI 话题');
      }
      const level = entry.level || 'B1';
      const count = computeCardCount(transcriptLines);
      const userFirstCount = Math.round(count * getUserFirstRatio(level));
      const npcFirstCount = count - userFirstCount;
      const excludeTitles = options?.excludeTitles ?? [];
      const prompt = buildUserPrompt(ctx, transcriptLines, entry.sourceLabel, excludeTitles);
      const systemMessage = buildPracticePrompt(level, count, npcFirstCount, userFirstCount);

      // Phase 2: call LLM (streaming with non-streaming fallback).
      publishGenerationState(entryId, buildState(entryId, {
        status: 'processing',
        phase: 'extracting-subtitle',
        progress: 0.15,
        progressText: '正在整理字幕上下文…',
        targetCount: count,
        parsedCount: 0,
        cards: [],
      }));

      const cards: ScenarioCard[] = [];
      const seenKeys = new Set<string>();
      let streamedObjectCount = 0;
      let streamFullText = '';

      const syncProgress = (message: string) => {
        publishGenerationState(entryId, buildState(entryId, {
          status: 'processing',
          phase: 'calling-llm',
          progressText: message,
          targetCount: count,
          parsedCount: cards.length,
          cards: cards.slice(),
        }));
      };

      const syncStreamCards = () => {
        publishGenerationState(entryId, buildState(entryId, {
          status: 'processing',
          phase: 'calling-llm',
          progressText: generationStateCache.get(entryId)?.progressText ?? '正在生成 AI 话题…',
          targetCount: count,
          parsedCount: cards.length,
          cards: cards.slice(),
        }));
      };

      syncProgress('正在建立实时生成连接…');
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
              if (appendNormalizedCard(ctx, raw, cards, seenKeys)) {
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
                ? `已实时解析 ${cards.length}/${count} 个场景,正在整理剩余输出…`
                : `已实时解析 ${cards.length}/${count} 个场景…`,
            );
          }
        });
      } catch {
        syncProgress('流式生成中断,正在切换到兼容模式…');
        const fallback = await callAIProxy({
          type: 'generate-card',
          prompt,
          systemMessage,
          userLevel: level,
          maxTokens: 5200,
        });
        syncProgress('正在整理生成结果…');
        extractRawCards(fallback).forEach((raw) => {
          appendNormalizedCard(ctx, raw, cards, seenKeys);
        });
      }

      if (cards.length === 0) {
        // Last-ditch attempt: parse the full stream text once.
        try {
          const parsed = JSON.parse(streamFullText);
          extractRawCards(parsed).forEach((raw) => {
            appendNormalizedCard(ctx, raw, cards, seenKeys);
          });
        } catch {
          // fall through to the error below
        }
      }
      if (cards.length === 0) {
        throw new Error('AI 没有返回可用的 AI 话题卡片');
      }

      // Phase 3: save + finalize.
      publishGenerationState(entryId, buildState(entryId, {
        status: 'processing',
        phase: 'saving',
        progress: 0.9,
        progressText: '正在写入本地缓存…',
        targetCount: count,
        parsedCount: cards.length,
        cards: cards.slice(),
      }));
      const uri = await saveCardsToFile(entryId, cards);
      const now = new Date().toISOString();
      await updateUserVideoEntryFields(entryId, {
        aiPracticeUri: uri,
        aiPracticeUpdatedAt: now,
        aiPracticeCount: cards.length,
        aiPracticeStatus: 'ready',
        aiPracticePhase: undefined,
        aiPracticeProgress: 1,
        aiPracticeProgressMessage: 'AI 话题已生成',
        aiPracticeErrorMessage: undefined,
      });
      publishGenerationState(entryId, buildState(entryId, {
        status: 'ready',
        progress: 1,
        progressText: 'AI 话题已生成,等待选择主题…',
        parsedCount: cards.length,
        targetCount: count,
        cards: cards.slice(),
        errorMessage: undefined,
      }));
      return cards;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'AI 话题生成失败';
      await updateUserVideoEntryFields(entryId, {
        aiPracticeStatus: 'error',
        aiPracticePhase: undefined,
        aiPracticeErrorMessage: message,
      }).catch(() => undefined);
      publishGenerationState(entryId, buildState(entryId, {
        status: 'error',
        progressText: message,
        errorMessage: message,
      }));
      throw err;
    } finally {
      generationPromiseStore.delete(entryId);
    }
  })();

  generationPromiseStore.set(entryId, promise);
  return promise;
}
