/**
 * Async Evaluator — Dual-Task Background Engine
 *
 * Triggered after sandbox session completes (fire-and-forget).
 *
 * Task 1 (Injected Words Evaluation):
 *   - Reads which words were injected into this session's NPC prompt
 *   - AI scores each word 1-4 based on user's actual performance
 *   - Calls scheduleReview() to update FSRS due dates
 *
 * Task 2 (New Bottleneck Capture):
 *   - AI finds 1-3 friction points from user turns
 *   - Each new card includes user_failed_sentence, native_correction, cognitive_type
 *   - Auto-save intentionally disabled (see saveCapturedCards).
 *
 * Key principles:
 *  - NEVER throws to the caller; all errors are swallowed silently
 *  - Does NOT block user navigation
 */

import { Platform } from 'react-native';
import type { ChatSession } from './sessions';
import { callAIProxy } from '../api-client';
import { findCardIdByWord, scheduleReview } from '../database';
import { Rating } from 'ts-fsrs';
import type { CEFRLevel } from '../../types';

const EVALUATED_KEY = 'evaluated_sessions';
const INJECTED_WORDS_KEY = 'fsrs_inject_cache';
const BADGE_KEY = 'library_badge_count';

interface InjectedWordRating {
  word: string;
  rating: 1 | 2 | 3 | 4;
  reason: string;
}

interface CapturedCard {
  target_word: string;
  user_failed_sentence: string;
  native_correction: string;
  cognitive_type: string;
}

interface EvalResult {
  injected_words_evaluation: InjectedWordRating[];
  new_cards_captured: CapturedCard[];
}

/**
 * Format transcript for the evaluator prompt.
 */
function formatTranscript(session: ChatSession): string {
  return session.transcript
    .map(t => `${t.role === 'npc' ? 'NPC' : 'User'}: ${t.text}`)
    .join('\n');
}

/**
 * Read today's injected words from the injection cache.
 */
async function getInjectedWords(): Promise<string[]> {
  try {
    const AsyncStorage = (await import('@react-native-async-storage/async-storage')).default;
    const raw = await AsyncStorage.getItem(INJECTED_WORDS_KEY);
    if (!raw) return [];
    const cache = JSON.parse(raw);
    const today = new Date().toISOString().slice(0, 10);
    if (cache.date === today && Array.isArray(cache.words)) return cache.words;
    return [];
  } catch {
    return [];
  }
}

/**
 * Get card IDs for injected words (to call scheduleReview on them).
 * v3: looks up the SQLite learning_cards table directly — the old
 * `web_cards` AsyncStorage key is gone (FSRS has been the source of
 * truth for a while now).
 */
async function getCardIdForWord(word: string): Promise<string | null> {
  try {
    return await findCardIdByWord(word);
  } catch {
    return null;
  }
}

/**
 * Call the dual-task AI evaluator.
 */
async function callEvaluatorAI(
  session: ChatSession,
  injectedWords: string[],
  userLevel: CEFRLevel,
): Promise<EvalResult | null> {
  const transcript = formatTranscript(session);
  if (!transcript.trim()) return null;

  const injectedList = injectedWords.length > 0
    ? JSON.stringify(injectedWords)
    : '[]';

  const systemPrompt = `你是一名极其严苛的顶尖语言学诊断专家 (Linguistic Evaluator)。
你正在审查一份非母语学习者 (User) 与 NPC 刚完成的英语沙盒对话记录 (Transcript)。

# Tasks
你拥有两项核心任务，必须在同一个 JSON 中输出结果：

## Task 1: 隐形注入词考核 (Injected Words Evaluation)
本次沙盒中，系统预先向 NPC 注入了以下需要考核的复习词汇：${injectedList}
你需要纵观全局，分析 User 对这些词的掌握程度，并给出 1-4 的 FSRS 评分。

评分铁律：
- 4 (Easy): User 主动且准确地使用了该词（包含合理的时态/词性变化）。⚠️ 只是照抄 NPC 刚说过的话只能算 3。
- 3 (Good): NPC 使用了该词，User 虽未主动使用但完全听懂，剧情顺利推进。
- 2 (Hard): User 对包含该词的句子理解偏差，磕磕巴巴，勉强推进。
- 1 (Again): 完全没听懂，剧情卡死，答非所问，或触发 SOS 求助。

## Task 2: 捕获新卡壳点 (New Bottleneck Capture)
审查 User 在整场对话中暴露出的最致命的 1-3 个生硬表达或中式英语，提取成新复习卡片。

制卡铁律：
- 必须包含 User 说的原始散装原话 (user_failed_sentence)
- 必须提供极具场景感的地道母语级替换表达 (native_correction)
- 按认知矩阵分类 (cognitive_type，如 M5_词汇降维, M7_语法骨架, M11_逆向映射)

# Output
严格输出以下 JSON，禁止任何 Markdown 或额外解释：`;

  const userPrompt = `场景：${session.scenario_title}\n用户水平：${userLevel}\n\nTranscript:\n${transcript}`;

  const schemaHint = `{
  "injected_words_evaluation": [{"word": string, "rating": 1|2|3|4, "reason": string}],
  "new_cards_captured": [{"target_word": string, "user_failed_sentence": string, "native_correction": string, "cognitive_type": string}]
}`;

  try {
    const result = await callAIProxy({
      type: 'evaluate-session',
      prompt: userPrompt + '\n\nJSON Schema:\n' + schemaHint,
      userLevel,
      systemMessage: systemPrompt,
    });
    if (!result) return null;
    // callAIProxy may return the parsed object directly or nested
    const data = result.injected_words_evaluation ? result : result.data ?? null;
    if (!data?.injected_words_evaluation) return null;
    return data as EvalResult;
  } catch {
    return null;
  }
}

/**
 * Increment the Library tab badge count in AsyncStorage.
 */
async function incrementBadge(count: number): Promise<void> {
  try {
    const AsyncStorage = (await import('@react-native-async-storage/async-storage')).default;
    const raw = await AsyncStorage.getItem(BADGE_KEY);
    const current = raw ? parseInt(raw, 10) : 0;
    await AsyncStorage.setItem(BADGE_KEY, String(current + count));
  } catch {
    // ignore
  }
}

/**
 * Save captured bottleneck cards.
 * Auto-save is intentionally disabled: the user adds cards manually via
 * the word/sentence entry points in the video page and the AI practice
 * sandbox. This stub remains so the session-evaluator call site compiles.
 */
async function saveCapturedCards(_cards: CapturedCard[], _scenarioTitle: string): Promise<number> {
  return 0;
}

/**
 * Mark this session as already evaluated to avoid duplicate runs.
 */
async function markEvaluated(sessionId: string): Promise<void> {
  try {
    const AsyncStorage = (await import('@react-native-async-storage/async-storage')).default;
    const raw = await AsyncStorage.getItem(EVALUATED_KEY);
    const ids: string[] = raw ? JSON.parse(raw) : [];
    if (!ids.includes(sessionId)) {
      ids.push(sessionId);
      // Keep only the last 200 evaluated session ids
      await AsyncStorage.setItem(EVALUATED_KEY, JSON.stringify(ids.slice(-200)));
    }
  } catch {
    // ignore
  }
}

async function wasAlreadyEvaluated(sessionId: string): Promise<boolean> {
  try {
    const AsyncStorage = (await import('@react-native-async-storage/async-storage')).default;
    const raw = await AsyncStorage.getItem(EVALUATED_KEY);
    const ids: string[] = raw ? JSON.parse(raw) : [];
    return ids.includes(sessionId);
  } catch {
    return false;
  }
}

/**
 * Get user level from AsyncStorage (web) for personalized card generation.
 */
async function getUserLevel(): Promise<CEFRLevel> {
  try {
    if (Platform.OS === 'web') {
      const AsyncStorage = (await import('@react-native-async-storage/async-storage')).default;
      const lv = await AsyncStorage.getItem('user_level');
      return (lv as CEFRLevel) || 'B1';
    }
    return 'B1';
  } catch {
    return 'B1';
  }
}

/**
 * Main entry point. Called by session-manager after session.status = completed.
 * Completely fire-and-forget — the caller does .catch(() => {}).
 */
export async function runEvaluator(session: ChatSession): Promise<void> {
  if (await wasAlreadyEvaluated(session.session_id)) return;

  const userLevel = await getUserLevel();
  const injectedWords = await getInjectedWords();

  const evalResult = await callEvaluatorAI(session, injectedWords, userLevel);
  if (!evalResult) {
    await markEvaluated(session.session_id);
    return;
  }

  // ── Task 1: Update FSRS schedules for injected words ──────────────────
  let ratingCount = 0;
  for (const item of evalResult.injected_words_evaluation) {
    try {
      const ratingMap: Record<number, Rating> = {
        1: Rating.Again,
        2: Rating.Hard,
        3: Rating.Good,
        4: Rating.Easy,
      };
      const fsrsRating = ratingMap[item.rating] ?? Rating.Good;
      const cardId = await getCardIdForWord(item.word);
      if (cardId) {
        await scheduleReview(cardId, fsrsRating);
        ratingCount++;
        console.log(`[Evaluator] ${item.word} → Rating ${item.rating} (${item.reason})`);
      } else {
        console.log(`[Evaluator] No card found for injected word: ${item.word}`);
      }
    } catch (e) {
      console.warn(`[Evaluator] scheduleReview failed for ${item.word}:`, e);
    }
  }

  // ── Task 2: Save newly captured bottleneck cards ───────────────────────
  const saved = await saveCapturedCards(evalResult.new_cards_captured, session.scenario_title);
  if (saved > 0) {
    await incrementBadge(saved);
  }

  await markEvaluated(session.session_id);
  console.log(`[Evaluator] Session ${session.session_id}: rated ${ratingCount} injected words, captured ${saved} new cards.`);
}
