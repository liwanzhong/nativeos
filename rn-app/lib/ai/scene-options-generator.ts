/**
 * AI-driven option generator for the multi-turn 自定义话题 guide
 * (`/ai-practice/add-custom-guide`).
 *
 * Why AI-driven (and not a hard-coded map)?
 *   1. Flexibility — the LLM can suggest contexts the product team
 *      never thought of ("健身房教练" / "宠物医院" / "二手车行").
 *   2. No maintenance — a hard-coded map has to be updated every
 *      time the product wants a new scene or situation.
 *   3. Better UX — options stay contextually relevant because the
 *      LLM sees the prior turns when generating the next turn.
 *
 * Three turns, three prompt shapes:
 *   - 'scene'      — 6-8 distinct real-life locations
 *   - 'person'     — 4-5 people the learner might talk to in the scene
 *   - 'situation'  — 3-4 specific events with that person in that scene
 *
 * Output format: `{ options: [{ key, label, emoji }] }` — strictly
 * enforced by the LLM `response_format: json_object` mode.
 *
 * On failure: returns a small hard-coded FALLBACK so the UI is never
 * dead. The fallback is intentionally generic and only used as a
 * safety net.
 */

import { callAIProxy } from '../api-client';

export interface SceneOption {
  key: string;
  label: string;
  emoji: string;
}

export type OptionsTurn = 'scene' | 'person' | 'situation';

const SYSTEM_MESSAGE =
  'You are NativeOS, an English learning scene designer. ' +
  'Always respond with a single valid JSON object. ' +
  'No markdown, no commentary, no extra fields.';

function buildPrompt(
  turn: OptionsTurn,
  context: { scene?: string; person?: string },
  userLevel: string,
  avoidList: ReadonlyArray<string>,
): string {
  // Random seed nudges the LLM to give a different set on each
  // visit. Combined with temperature=0.7 this gives meaningful
  // variation between invocations. Without it, the LLM defaults
  // to the same "obvious 5" set every time.
  //
  // CRITICAL: do NOT list specific example options in the prompt.
  // Few-shot examples get treated as "the correct answer template"
  // and the LLM returns essentially the same set every call. We
  // steer via CATEGORIES (transport, leisure, etc.) instead of
  // naming specific places.
  const seed = Math.floor(Math.random() * 100000);
  const avoidBlock = avoidList.length > 0
    ? ` HARD CONSTRAINT: do NOT generate any of these (already shown in this session): ${avoidList.join('、')}.`
    : '';
  if (turn === 'scene') {
    return (
      `Generate 6-8 distinct real-life locations for English conversation practice. ` +
      `Rules:\n` +
      `- Each option: 2-4 char Chinese noun naming a specific physical location.\n` +
      `- Spread across CATEGORIES (transport / vehicle services, leisure / hobbies, shopping / retail, food / dining, education / training, government / public services, home / living, etc.) — do NOT concentrate on one category.\n` +
      `- Skip the most obvious 5 (餐厅, 医院, 银行, 学校, 咖啡店) — substitute with less-common but real places a learner might actually visit.\n` +
      `- At least 4 of the 8 should be uncommon enough that a typical Chinese learner would not think of them first.\n` +
      `- NO pure-online scenes (no video call / chat / streaming). Focus on physical-world English.\n` +
      `- Do NOT repeat any name you have given in earlier calls.${avoidList.length > 0 ? '' : ''}\n` +
      `User CEFR level: ${userLevel}. ` +
      `Variation seed: ${seed}.${avoidBlock} ` +
      `Return JSON only: {"options":[{"key":"<2-4 char Chinese noun>","label":"<same as key>","emoji":"<single non-ZWJ emoji>"}, ...]}.`
    );
  }
  if (turn === 'person') {
    return (
      `Generate 4-5 distinct people the learner might talk to in this scene. ` +
      `Scene: ${context.scene ?? 'unknown'}. ` +
      `Rules:\n` +
      `- Each option: 2-4 char Chinese noun naming a real role in this scene.\n` +
      `- Mix the standard 2-3 roles with at least 1-2 less-obvious but real ones that fit the scene.\n` +
      `- Do NOT repeat any name you have given in earlier calls for the same scene.\n` +
      `Variation seed: ${seed}.${avoidBlock} ` +
      `Return JSON only: {"options":[{"key":"<2-4 char Chinese noun>","label":"<same>","emoji":"<single non-ZWJ emoji>"}, ...]}.`
    );
  }
  // situation
  return (
    `Generate 3-4 specific situations the learner might encounter with this person in this scene. ` +
    `Scene: ${context.scene ?? 'unknown'}. ` +
      `Person: ${context.person ?? 'unknown'}. ` +
      `Rules:\n` +
      `- Each option: short Chinese phrase describing a CONCRETE actionable event (e.g. "描述过敏症状" not "医疗咨询").\n` +
      `- Skip abstract moods / generic states. No two options should be near-synonyms.\n` +
      `- Do NOT repeat any phrase you have given in earlier calls for the same (scene, person).\n` +
      `Variation seed: ${seed}.${avoidBlock} ` +
      `Return JSON only: {"options":[{"key":"<short Chinese phrase>","label":"<same as key>","emoji":"<single non-ZWJ emoji>"}, ...]}.`
  );
}

const FALLBACK_SCENE_OPTIONS: SceneOption[] = [
  { key: '医院', label: '医院', emoji: '🏥' },
  { key: '餐厅', label: '餐厅', emoji: '🍔' },
  { key: '咖啡店', label: '咖啡店', emoji: '☕' },
  { key: '旅行', label: '旅行', emoji: '✈️' },
  { key: '职场', label: '职场', emoji: '💼' },
  { key: '学校', label: '学校', emoji: '🏫' },
];

const FALLBACK_PERSON_OPTIONS: SceneOption[] = [
  { key: '陌生人', label: '陌生人', emoji: '👤' },
  { key: '朋友', label: '朋友', emoji: '🧑‍🤝‍🧑' },
  { key: '服务员', label: '服务员', emoji: '🧑‍🍳' },
  { key: '同事', label: '同事', emoji: '💼' },
];

const FALLBACK_SITUATION_OPTIONS: SceneOption[] = [
  { key: '问路', label: '问路', emoji: '🗺️' },
  { key: '求助', label: '求助', emoji: '🆘' },
  { key: '闲聊', label: '闲聊', emoji: '💬' },
  { key: '确认信息', label: '确认信息', emoji: '❓' },
];

function fallbackFor(turn: OptionsTurn): SceneOption[] {
  if (turn === 'scene') return FALLBACK_SCENE_OPTIONS;
  if (turn === 'person') return FALLBACK_PERSON_OPTIONS;
  return FALLBACK_SITUATION_OPTIONS;
}

function safeEmoji(input: unknown, fallback: string): string {
  if (typeof input !== 'string') return fallback;
  const trimmed = input.trim();
  if (!trimmed) return fallback;
  // Strip ZWJ / variation selectors to avoid render glitches on
  // older Android — fall back to the default if we see them.
  if (/[\u200D\uFE0F]/.test(trimmed)) return fallback;
  return trimmed;
}

function normalize(raw: unknown): SceneOption[] {
  if (!Array.isArray(raw)) return [];
  const out: SceneOption[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const candidate = item as Record<string, unknown>;
    const keyRaw = candidate.key;
    const labelRaw = candidate.label;
    if (typeof keyRaw !== 'string' || typeof labelRaw !== 'string') continue;
    const key = keyRaw.trim();
    const label = labelRaw.trim();
    if (!key || !label) continue;
    out.push({
      key: key.slice(0, 12),
      label: label.slice(0, 16),
      emoji: safeEmoji(candidate.emoji, '💬'),
    });
  }
  return out;
}

export async function generateSceneOptions(input: {
  turn: OptionsTurn;
  context: { scene?: string; person?: string };
  userLevel: string;
  /**
   * Already-shown option keys to avoid. Sent to the LLM as
   * "AVOID generating these" so re-runs in the same session don't
   * produce the same 5 common options.
   */
  avoidList?: ReadonlyArray<string>;
}): Promise<SceneOption[]> {
  const prompt = buildPrompt(input.turn, input.context, input.userLevel, input.avoidList ?? []);
  console.log(`[scene-options] === TURN=${input.turn} ===\n` +
    `CONTEXT: ${JSON.stringify(input.context)}\n` +
    `AVOID LIST: ${JSON.stringify(input.avoidList ?? [])}\n` +
    `PROMPT:\n${prompt}\n` +
    `=== END PROMPT ===`);
  try {
    const result = await callAIProxy({
      type: 'generate-card',
      prompt,
      userLevel: input.userLevel as any,
      maxTokens: 600,
      systemMessage: SYSTEM_MESSAGE,
    });
    console.log(`[scene-options] === TURN=${input.turn} RAW RESPONSE ===\n` +
      `${JSON.stringify(result, null, 2)}\n` +
      `=== END RAW ===`);
    // The proxy returns the parsed JSON object. Our schema is
    // { options: [...] }; accept either that or a raw array (LLM
    // sometimes drops the wrapper).
    if (result && typeof result === 'object') {
      const raw = Array.isArray(result) ? result : (result as any).options;
      const normalised = normalize(raw);
      console.log(`[scene-options] TURN=${input.turn} NORMALISED: ${JSON.stringify(normalised.map(o => typeof o === 'number' ? o : o.key))}`);
      if (normalised.length > 0) return normalised;
    }
  } catch (error) {
    console.warn('[scene-options] LLM call failed', error);
  }
  const fallback = fallbackFor(input.turn);
  console.log(`[scene-options] TURN=${input.turn} USING FALLBACK: ${JSON.stringify(fallback.map(o => o.key))}`);
  return fallback;
}
