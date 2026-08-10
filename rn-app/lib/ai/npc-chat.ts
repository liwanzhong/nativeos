/**
 * NPC Chat — Real AI conversational replies for sandbox scenarios.
 *
 * Unlike callAIProxy (which forces JSON output for card generation),
 * this module uses free-text chat completions so the NPC speaks naturally.
 *
 * System prompt strategy (参考 scenario-generator.ts prompt 结构):
 *   1. Role setup — who the NPC is, what the scenario is
 *   2. Resistance layer — NPC has reasonable objections/friction to make learner practice
 *   3. FSRS injection — invisible due-words woven into NPC speech naturally
 *   4. Output constraints — short replies (1-3 sentences), pure English, no meta-commentary
 */

import {
  contractToPromptBlock,
  normalizeConversationRuntime,
  runtimeToPromptBlock,
  type ConversationRuntimeState,
  type ScenarioTaskContract,
} from './conversation-runtime';

const QWEN_API_KEY = process.env.EXPO_PUBLIC_QWEN_API_KEY || '';
const QWEN_BASE_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1';
const QWEN_MODEL = 'qwen-plus';

/** Truncate an API key to a non-reversible debug form for logcat. */
function maskApiKey(key: string): string {
  if (!key) return '<empty>';
  if (key.length <= 8) return `<len=${key.length}>`;
  return `${key.slice(0, 4)}…${key.slice(-4)}<len=${key.length}>`;
}

export interface ChatTurn {
  role: 'user' | 'npc';
  text: string;
}

export interface NPCChatInput {
  scenarioTitle: string;
  scenarioCategory: string;
  scenarioDesc?: string;
  npcName?: string;
  npcStatus?: string;
  environmentalCue?: string;
  npcSystemPrompt?: string;   // Contains FSRS invisible injection
  taskContract: ScenarioTaskContract;
  runtimeState?: Partial<ConversationRuntimeState> | null;
  history: ChatTurn[];        // Full conversation so far
  userMessage: string;        // Latest user input
  userLevel?: string;         // CEFR level for calibrating reply complexity
  npcDifficulty?: 'B1' | 'B2' | 'C1'; // NPC challenge level
}

/**
 * Build the NPC system prompt.
 * Structure mirrors scenario-generator.ts prompt approach:
 * — Identity → Scenario context → Resistance layer → FSRS injection → Output rules
 */
export interface NPCReplyResult {
  text: string;         // English NPC dialogue
  translation: string;  // Chinese translation (bundled in same API call)
  runtimeState: ConversationRuntimeState;
  status: 'ok' | 'fallback';
  fallbackReason?: string;
}

function extractJsonStringField(source: string, fieldName: string): string {
  const pattern = new RegExp(`"${fieldName}"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)"`, 's');
  const match = source.match(pattern);
  if (!match?.[1]) return '';
  try {
    return JSON.parse(`"${match[1]}"`);
  } catch {
    return match[1];
  }
}

function parseNpcReplyContent(content: string): {
  text: string;
  translation: string;
  stateUpdate?: Partial<ConversationRuntimeState>;
} | null {
  const trimmed = content.trim();
  if (!trimmed) return null;

  const fencedMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  const extractedObject = (() => {
    const firstBrace = trimmed.indexOf('{');
    const lastBrace = trimmed.lastIndexOf('}');
    if (firstBrace >= 0 && lastBrace > firstBrace) {
      return trimmed.slice(firstBrace, lastBrace + 1).trim();
    }
    return '';
  })();

  const candidates = [trimmed, fencedMatch?.[1]?.trim() ?? '', extractedObject].filter(Boolean);

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (!parsed || typeof parsed !== 'object') continue;
      const text = typeof parsed.text === 'string' ? parsed.text.trim() : '';
      const translation = typeof parsed.translation === 'string' ? parsed.translation.trim() : '';
      const stateUpdate = parsed.stateUpdate && typeof parsed.stateUpdate === 'object'
        ? parsed.stateUpdate as Partial<ConversationRuntimeState>
        : undefined;
      if (!text) continue;
      return { text, translation, stateUpdate };
    } catch {
      continue;
    }
  }

  const recoveredText = extractJsonStringField(trimmed, 'text').trim();
  if (!recoveredText) return null;

  return {
    text: recoveredText,
    translation: extractJsonStringField(trimmed, 'translation').trim(),
  };
}

function sanitizeNpcDialogueText(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/_([^_]+)_/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\s+([,.!?;:])/g, '$1')
    .trim();
}

function buildSystemPrompt(input: NPCChatInput): string {
  const {
    scenarioTitle,
    scenarioCategory,
    scenarioDesc,
    npcName,
    npcStatus,
    environmentalCue,
    npcSystemPrompt,
    taskContract,
    runtimeState,
    userLevel = 'B1',
    npcDifficulty = 'B2',
  } = input;
  const normalizedRuntime = normalizeConversationRuntime(taskContract, runtimeState);

  // NOTE: difficulty controls NPC cooperation level only, NOT language complexity.
  // NPC speech complexity always matches userLevel regardless of difficulty.
  const resistanceLayer = npcDifficulty === 'B1'
    ? `## Resistance Layer (B1 宽容模式)
- Be helpful and cooperative. Give the learner what they want with minimal friction.
- If their English is unclear, interpret charitably and respond naturally.
- Keep the conversation moving forward smoothly.
- NEVER invent reasons to push back if the request is reasonable and clear.`
    : npcDifficulty === 'C1'
    ? `## Resistance Layer (C1 地狱模式)
- Be difficult and demanding — but only in ways that make sense for THIS specific scenario.
- Push back by asking for clarification, offering alternatives, or raising scenario-relevant complications.
- NEVER invent fake policies, rules, or restrictions that don't logically exist in this scenario.
- React with confusion or mild impatience if their message is genuinely ambiguous.
- Only yield when they communicate clearly and specifically.
- IMPORTANT: Your language complexity must still match the learner's level (${userLevel}).`
    : `## Resistance Layer (B2 标准模式)
- Create natural friction that is logical within the scenario (e.g. ask for clarification, offer alternatives, raise realistic complications).
- NEVER use generic pushback phrases like "I have policies to follow" or "I can't do that" unless there is a real, scenario-specific reason.
- React authentically — if they're rude, show mild displeasure.
- If their English is unclear, ask them to clarify naturally.
- If the request is reasonable and clear, move the scenario forward.`;

  return `You are a native English speaker playing a role in an immersive language learning scenario.

## Scenario
Category: ${scenarioCategory}
Title: ${scenarioTitle}
${scenarioDesc ? `Task Description: ${scenarioDesc}` : ''}
${npcName ? `NPC Name: ${npcName}` : ''}
${npcStatus ? `NPC Status: ${npcStatus}` : ''}
${environmentalCue ? `Scene Cue: ${environmentalCue}` : ''}

## Your Role
You are a realistic character in this scenario. Stay fully in character at all times.
The learner's English level is approximately ${userLevel}.
${npcSystemPrompt ? `
## Scenario Role Context
${npcSystemPrompt}` : ''}
## Task Contract
${contractToPromptBlock(taskContract)}
## Runtime State
${runtimeToPromptBlock(normalizedRuntime)}

${resistanceLayer}

## Turn Planning Rules
- First decide whether the learner is still on the main task, making an adjacent shift, or attempting a true task switch.
- If the learner makes an adjacent shift, acknowledge it briefly and keep the broader task coherent.
- If the learner tries to replace the main task, confirm the switch explicitly before abandoning the original objective.
- Prefer clarifying the next missing required slot over improvising a new branch.
- Never silently invent a new subtask that the learner did not ask for.

## Output Rules
- Reply in 1–3 short sentences maximum. Keep it conversational.
- NEVER break character. NEVER say you're an AI or a tutor.
- NEVER use markdown, asterisks, or emoji in your reply.
- Respond ONLY with valid JSON: {"text": "<NPC English dialogue>", "translation": "<accurate Chinese translation>", "stateUpdate": {"currentStage": "<snake_case_stage>", "topicStatus": "on_track|adjacent_shift|task_switch|off_track", "activeObjective": "<current objective>", "lastUserIntent": "<brief intent>", "filledSlots": {"slot": "value"}, "pendingSlots": ["slot_key"], "suggestedNpcAction": "<brief action>", "shouldConfirmTaskSwitch": false, "summary": "<short runtime summary>"}}`;
}

function buildContextualFallbackReply(input: NPCChatInput, reason: string): NPCReplyResult {
  const runtimeState = normalizeConversationRuntime(input.taskContract, input.runtimeState);
  const nextPendingSlot = input.taskContract.requiredSlots.find((slot) => runtimeState.pendingSlots.includes(slot.key));
  let text = 'Let me make sure I understood. What do you need help with right now?';

  if (runtimeState.shouldConfirmTaskSwitch || runtimeState.topicStatus === 'task_switch') {
    text = `Just to make sure I'm helping with the right thing, are you still working on ${input.taskContract.objective.toLowerCase()} or do you want to switch to something else?`;
  } else if (runtimeState.topicStatus === 'adjacent_shift' && input.taskContract.allowedTopicExtensions[0]) {
    text = `I can help with that too. Do you want to stay focused on ${input.taskContract.objective.toLowerCase()}, or switch to ${input.taskContract.allowedTopicExtensions[0]}?`;
  } else if (nextPendingSlot) {
    text = `Sure — before I guide you further, could you clarify the ${nextPendingSlot.label.toLowerCase()}?`;
  }

  return {
    text,
    translation: '',
    runtimeState,
    status: 'fallback',
    fallbackReason: reason,
  };
}

/**
 * Call the configured AI backend for an NPC reply. When the user has
 * enabled BYOK (Bring Your Own Key), call their provider directly with
 * their key. Otherwise call the shared Qwen proxy.
 */
export async function getNPCReply(input: NPCChatInput): Promise<NPCReplyResult> {
  const systemPrompt = buildSystemPrompt(input);
  const currentRuntime = normalizeConversationRuntime(input.taskContract, input.runtimeState);

  console.log('[NPC Chat] Prompt debug', {
    scenarioTitle: input.scenarioTitle,
    scenarioCategory: input.scenarioCategory,
    scenarioDesc: input.scenarioDesc,
    hasNpcSystemPrompt: Boolean(input.npcSystemPrompt),
    hasLegacyDirective: Boolean(input.npcSystemPrompt?.includes('【强制指令】')),
    runtimeSummary: currentRuntime.summary,
    npcSystemPromptPreview: input.npcSystemPrompt?.slice(0, 300),
    systemPromptPreview: systemPrompt.slice(0, 600),
  });

  // BYOK path — use the user's own provider / key.
  // Read lazily to avoid a circular import (byok.ts pulls in ./database).
  try {
    const { getActiveByok, BYOK_PROVIDERS } = await import('../byok');
    const byok = await getActiveByok();
    if (byok) {
      const preset = BYOK_PROVIDERS[byok.provider];
      console.log('[BYOK-AI] getNPCReply routing → BYOK', {
        provider: byok.provider,
        wire: preset.wire,
        baseUrl: byok.baseUrl || preset.baseUrl,
        model: byok.model,
        apiKeyMasked: maskApiKey(byok.apiKeyB64),
        historyTurns: input.history.length,
        userMessagePreview: input.userMessage.slice(0, 120),
      });
      const content = await callByokProvider(
        byok.baseUrl || preset.baseUrl,
        preset.wire,
        byok.apiKeyB64,
        byok.model,
        systemPrompt,
        input.history,
        input.userMessage,
      );
      console.log('[BYOK-AI] getNPCReply BYOK result', {
        provider: byok.provider,
        responseLen: content.length,
        responsePreview: content.slice(0, 200),
      });
      return processNpcContent(content, input, currentRuntime, `byok_${byok.provider}`);
    }
    console.log('[BYOK-AI] getNPCReply routing → SHARED QWEN (BYOK not active / disabled / missing key)');
  } catch (e) {
    console.warn('[NPC Chat] BYOK dispatch failed, falling back to shared', e);
    console.log('[BYOK-AI] getNPCReply routing → SHARED QWEN (after BYOK error)');
  }

  // Shared NativeOS path (Qwen).
  if (!QWEN_API_KEY) {
    return buildContextualFallbackReply(input, 'missing_api_key');
  }

  const historyMessages = input.history.map(turn => ({
    role: turn.role === 'user' ? 'user' : ('assistant' as const),
    content: turn.text,
  }));

  try {
    const response = await fetch(`${QWEN_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${QWEN_API_KEY}`,
      },
      body: JSON.stringify({
        model: QWEN_MODEL,
        messages: [
          { role: 'system', content: systemPrompt },
          ...historyMessages,
          { role: 'user', content: input.userMessage },
        ],
        temperature: 0.55,
        max_tokens: 200,
        response_format: { type: 'json_object' },
      }),
    });

    if (!response.ok) {
      return buildContextualFallbackReply(input, `http_${response.status}`);
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content?.trim() ?? '';
    return processNpcContent(content, input, currentRuntime, undefined);
  } catch (err) {
    return buildContextualFallbackReply(input, 'fetch_failed');
  }
}

/**
 * Dispatch a single chat-completion call to the right adapter based on
 * the BYOK provider's wire format. Returns the raw assistant text (or
 * an empty string on failure — the caller falls back).
 */
async function callByokProvider(
  baseUrl: string,
  wire: 'openai' | 'anthropic',
  apiKey: string,
  model: string,
  systemPrompt: string,
  history: ChatTurn[],
  userMessage: string,
): Promise<string> {
  console.log('[BYOK-AI] callByokProvider dispatch', {
    wire,
    baseUrl,
    model,
    apiKeyMasked: maskApiKey(apiKey),
    historyTurns: history.length,
  });
  if (wire === 'anthropic') {
    const { callAnthropic } = await import('./anthropic');
    const res = await callAnthropic({
      baseUrl,
      apiKey,
      model,
      systemPrompt,
      history,
      userMessage,
      temperature: 0.55,
      maxTokens: 240,
    });
    if (!res.ok) {
      console.warn('[NPC Chat] BYOK anthropic failed', res.reason, res.status, res.message);
      return '';
    }
    return res.text;
  }
  // OpenAI-compatible (covers OpenAI, DeepSeek, Doubao, Zhipu, Moonshot, custom)
  const { callOpenAiCompatible } = await import('./openai-compatible');
  const res = await callOpenAiCompatible({
    baseUrl,
    apiKey,
    model,
    systemPrompt,
    history,
    userMessage,
    temperature: 0.55,
    maxTokens: 240,
    jsonMode: true,
  });
  if (!res.ok) {
    console.warn('[NPC Chat] BYOK openai-compat failed', res.reason, res.status, res.message);
    return '';
  }
  return res.text;
}

/**
 * Shared parse-and-shape for both BYOK and shared-Qwen paths. Pulled
 * out so the BYOK branch doesn't have to duplicate the JSON-extract
 * dance and runtime-state merge.
 */
function processNpcContent(
  content: string,
  input: NPCChatInput,
  currentRuntime: ReturnType<typeof normalizeConversationRuntime>,
  fallbackPrefix?: string,
): NPCReplyResult {
  const parsedPayload = parseNpcReplyContent(content);
  if (parsedPayload) {
    const cleanText = sanitizeNpcDialogueText(parsedPayload.text);
    return {
      text: cleanText || buildContextualFallbackReply(input, 'empty_text').text,
      translation: parsedPayload.translation,
      runtimeState: normalizeConversationRuntime(input.taskContract, parsedPayload.stateUpdate ?? currentRuntime),
      status: cleanText ? 'ok' : 'fallback',
      fallbackReason: cleanText ? undefined : (fallbackPrefix ? `${fallbackPrefix}_empty` : 'empty_text'),
    };
  }

  const looksStructured = content.includes('"text"') || (content.trim().startsWith('{') && content.includes('"translation"'));
  if (looksStructured) {
    return buildContextualFallbackReply(input, fallbackPrefix ? `${fallbackPrefix}_invalid_json` : 'invalid_json');
  }

  const cleanContent = sanitizeNpcDialogueText(content);
  return {
    text: cleanContent || buildContextualFallbackReply(input, fallbackPrefix ? `${fallbackPrefix}_invalid_json` : 'invalid_json').text,
    translation: '',
    runtimeState: currentRuntime,
    status: cleanContent ? 'ok' : 'fallback',
    fallbackReason: cleanContent ? undefined : (fallbackPrefix ? `${fallbackPrefix}_invalid_json` : 'invalid_json'),
  };
}

/**
 * Offline / API-key-missing fallback replies.
 */
function getFallbackReply(_scenarioTitle: string): string {
  return 'Let me make sure I understood. What do you need help with right now?';
}

export interface HintSuggestion {
  id: number;
  text: string;
  translation: string;
  style: string;
}

/**
 * Dynamically generate 2-3 contextual reply hints for the learner.
 * The hints are based on the current scenario + last NPC message,
 * so they are always relevant rather than hardcoded.
 */
export async function generateHints(input: {
  scenarioTitle: string;
  scenarioCategory: string;
  scenarioDesc?: string;
  history: ChatTurn[];
  taskContract?: ScenarioTaskContract;
  runtimeState?: Partial<ConversationRuntimeState> | null;
  userLevel?: string;
  environmentalCue?: string;
}): Promise<HintSuggestion[]> {
  const { scenarioTitle, scenarioCategory, scenarioDesc, history, taskContract, runtimeState, userLevel = 'B1', environmentalCue } = input;

  const lastNPCMsg = [...history].reverse().find(t => t.role === 'npc')?.text ?? '';
  const hasNPCSpoken = lastNPCMsg.length > 0;

  const recentHistory = history
    .map(t => `${t.role === 'user' ? 'Learner' : 'NPC'}: ${t.text}`)
    .join('\n');
  const runtimeBlock = taskContract
    ? `\n\n## Task Contract\n${contractToPromptBlock(taskContract)}\n\n## Runtime State\n${runtimeToPromptBlock(normalizeConversationRuntime(taskContract, runtimeState))}`
    : '';

  const prompt = hasNPCSpoken
    ? `You are a language coach helping a ${userLevel} English learner practice a scenario.

Scenario: "${scenarioTitle}" (category: ${scenarioCategory})
${scenarioDesc ? `Task Description: ${scenarioDesc}\n` : ''}${runtimeBlock}

## Recent Conversation (use this as full context)
${recentHistory}

## NPC's last message (what the learner needs to respond to)
"${lastNPCMsg}"

Generate exactly 3 natural English replies the learner could say next.
Each reply should use a DIFFERENT communication strategy (e.g. assertive, empathetic, creative alternative).
Each reply should be realistic, natural, and appropriately challenging for ${userLevel} level.

CRITICAL: Every reply MUST satisfy ALL of the following:
1. Grammatically correct native English — double-check tenses, articles, prepositions. For example, use "I'll take" not "I take" for spontaneous purchase decisions; use "Can I have" not "Can you give" for requests.
2. Genuinely feasible and socially acceptable within this specific scenario context. Do NOT suggest actions or requests that would be impossible, unreasonable, or inappropriate given the scenario setting.
3. Something the learner can actually say right now without violating the scenario's logic.
4. If there is an unfinished required slot or a pending task switch confirmation, at least one hint should help the learner handle that directly.

Return ONLY valid JSON:
{
  "hints": [
    {
      "text": "<English reply, 1 sentence>",
      "translation": "<accurate Chinese translation>",
      "style": "<2-4 Chinese chars style label, e.g. 直接争取/共情路线/另辟蹊径>"
    }
  ]
}`
    : `You are a language coach helping a ${userLevel} English learner practice a scenario where THEY must speak first.

Scenario: "${scenarioTitle}" (category: ${scenarioCategory})
${scenarioDesc ? `Task Description: ${scenarioDesc}\n` : ''}${runtimeBlock}
${environmentalCue ? `\nSetting: ${environmentalCue}` : ''}

The NPC has NOT spoken yet. The learner needs to initiate the conversation.
Generate exactly 3 natural English opening lines the learner could use to start the interaction.
Each should use a DIFFERENT approach (e.g. direct request, casual greeting + request, polite opener).
Each should be realistic, natural, and appropriate for ${userLevel} level and this specific setting.

CRITICAL: Generate ONLY opening lines that make sense for someone initiating this scenario — not responses to something already said.

Return ONLY valid JSON:
{
  "hints": [
    {
      "text": "<English opening line, 1 sentence>",
      "translation": "<accurate Chinese translation>",
      "style": "<2-4 Chinese chars style label, e.g. 直接开口/礼貌铺垫/轻松搭话>"
    }
  ]
}`;

  // BYOK fast-path — honor the user's configured provider so the lightbulb
  // (hint) actually hits DeepSeek / OpenAI / etc. when BYOK is active.
  // Falls through to the shared Qwen path on any failure.
  try {
    const { getActiveByok, BYOK_PROVIDERS } = await import('../byok');
    const byok = await getActiveByok();
    if (byok) {
      const preset = BYOK_PROVIDERS[byok.provider];
      console.log('[BYOK-AI] generateHints routing → BYOK', {
        provider: byok.provider,
        wire: preset.wire,
        baseUrl: byok.baseUrl || preset.baseUrl,
        model: byok.model,
        apiKeyMasked: maskApiKey(byok.apiKeyB64),
        historyTurns: history.length,
        hasNpcSpoken: hasNPCSpoken,
        promptChars: prompt.length,
      });
      const content = await callByokProvider(
        byok.baseUrl || preset.baseUrl,
        preset.wire,
        byok.apiKeyB64,
        byok.model,
        'You are a language coach. Always respond with valid JSON only, no markdown.',
        [],
        prompt,
      );
      console.log('[BYOK-AI] generateHints BYOK result', {
        provider: byok.provider,
        responseLen: content.length,
        responsePreview: content.slice(0, 200),
      });
      const hints = parseHintsContent(content);
      if (hints.length) return hints;
      // Empty parse → fall through to shared Qwen for a sane answer.
    } else {
      console.log('[BYOK-AI] generateHints routing → SHARED QWEN (BYOK not active / disabled / missing key)');
    }
  } catch (e) {
    console.warn('[NPC Chat] generateHints BYOK dispatch failed, falling back to shared', e);
    console.log('[BYOK-AI] generateHints routing → SHARED QWEN (after BYOK error)');
  }

  if (!QWEN_API_KEY) return getFallbackHints(lastNPCMsg);

  try {
    const response = await fetch(`${QWEN_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${QWEN_API_KEY}`,
      },
      body: JSON.stringify({
        model: QWEN_MODEL,
        messages: [
          { role: 'system', content: 'You are a language coach. Always respond with valid JSON only, no markdown.' },
          { role: 'user', content: prompt },
        ],
        temperature: 0.8,
        max_tokens: 400,
        response_format: { type: 'json_object' },
      }),
    });

    if (!response.ok) return getFallbackHints(lastNPCMsg);

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content;
    const hints = parseHintsContent(typeof content === 'string' ? content : '');
    if (hints.length) return hints;
    return getFallbackHints(lastNPCMsg);
  } catch {
    return getFallbackHints(lastNPCMsg);
  }
}

function parseHintsContent(content: string): HintSuggestion[] {
  if (!content) return [];
  try {
    const parsed = JSON.parse(content);
    const raw: Array<{ text: string; translation: string; style: string }> = parsed?.hints ?? [];
    if (!raw.length) return [];
    return raw.slice(0, 3).map((h, i) => ({
      id: i + 1,
      text: h.text ?? '',
      translation: h.translation ?? '',
      style: h.style ?? '建议回复',
    }));
  } catch {
    return [];
  }
}

function getFallbackHints(_lastNPC: string): HintSuggestion[] {
  return [
    { id: 1, text: "Is there anything you can do to help me with this situation?", translation: "你有什么办法能帮我解决这个情况吗？", style: "直接争取" },
    { id: 2, text: "I completely understand, but could we find a compromise?", translation: "我完全理解，但我们能找到一个折中方案吗？", style: "共情路线" },
    { id: 3, text: "What are my options here?", translation: "我现在有哪些选择？", style: "探索方案" },
  ];
}

/**
 * Translate an English sentence to Chinese.
 */
export async function translateText(text: string): Promise<string> {
  const res = await fetch(`${QWEN_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${QWEN_API_KEY}` },
    body: JSON.stringify({
      model: QWEN_MODEL,
      messages: [
        { role: 'system', content: '你是一个翻译助手。将用户提供的英语句子翻译成自然流畅的中文，只输出翻译结果，不要加任何解释。' },
        { role: 'user', content: text },
      ],
      max_tokens: 200,
    }),
  });
  if (!res.ok) throw new Error('translate failed');
  const data = await res.json();
  return data.choices?.[0]?.message?.content?.trim() ?? '';
}
