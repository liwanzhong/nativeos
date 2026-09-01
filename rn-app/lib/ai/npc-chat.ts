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

  // ── Script-driven fields (2026-09-01, optional) ─────────────────────────
  // When ALL of these are present, buildSystemPrompt uses the script-driven
  // path (narrative beats) instead of the legacy path (deriveTaskContract).
  npcPersona?: string;
  learnerPersona?: string;
  interactionRules?: string[];
  scriptNodes?: Array<{ id: string; name: string; description: string; minTurns?: number }>;
  endings?: Array<{ type: 'success' | 'failure' | 'branch'; trigger: string; npcFinalLine?: string; branchSetup?: string }>;

  // ── Conversation-goal fields (2026-09-01 depth upgrade, optional) ─────
  // When these are present, buildSystemPrompt uses the new "agent loop"
  // path: the LLM itself decides each turn which goal to advance, when
  // to follow up, when to handle friction. conversationGoals REPLACES
  // scriptNodes semantically (topics to cover, not stages in order).
  conversationGoals?: Array<{
    id: string;
    name: string;
    description: string;
    priority?: number;
    edgeCases?: string[];
  }>;

  // ── Dynamic conversation state (recomputed each turn) ─────────────────
  // The prompt engine infers these from the history and surfaces them
  // to the LLM so it can plan its next move. Optional — when absent the
  // runtime infers them inside buildSystemPrompt.
  conversationState?: {
    /** User's apparent emotional state in their most recent reply. */
    userEmotion?: 'relaxed' | 'nervous' | 'confused' | 'frustrated' | 'rushed' | 'engaged' | 'silence';
    /** The rhythm of the last 2-3 exchanges. */
    recentRhythm?: 'q_a' | 'q_q_a' | 'npc_explains' | 'user_storytelling' | 'friction' | 'silence';
    /** ids of goals that have been substantially covered. */
    touchedGoalIds?: string[];
    /** ids of goals that still need to be covered. */
    pendingGoalIds?: string[];
    /** A short hint of what the LLM should consider doing next turn. */
    lastNextAction?: 'ask_followup' | 'advance_goal' | 'handle_friction' | 'wrap_up' | 'give_hint';
  };
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

/**
 * Build the NPC system prompt.
 * Exported (2026-09-01) so dev verification scripts can call it directly
 * without going through the HTTP request path. Safe to use at runtime.
 */
// 2026-09-01 v5: hard-cap any string to N characters. If truncated, append
// a marker so 千问 knows the content was deliberately shortened, not cut by
// a tokenization glitch. We trim at the nearest word boundary to avoid
// dangling partial words.
function capChars(s: string, max: number, marker: string): string {
  if (!s) return s;
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  const safe = lastSpace > max * 0.7 ? cut.slice(0, lastSpace) : cut;
  return marker ? `${safe} ${marker}` : safe;
}

export function buildSystemPrompt(input: NPCChatInput): string {
  let {
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
    npcPersona,
    learnerPersona,
    interactionRules,
    scriptNodes,
    endings,
    conversationGoals,
    conversationState,
  } = input;
  const normalizedRuntime = normalizeConversationRuntime(taskContract, runtimeState);

  // 2026-09-01 v5: ROOT FIX for 千问 "long-prompt attention collapse".
  // 千问 reads at most ~6K characters of a system prompt reliably. Past
  // that, it falls back to its RLHF default behavior (repeating persona
  // samples, wrapping up early, looping on numbers, ignoring detail rules).
  // The previous approach was to detect each symptom and add a fallback /
  // guard. That was "托举". This is the actual fix: cap the prompt budget
  // at the SOURCE so 千问 can actually read all of it. Symptoms should
  // fade naturally once prompt is ≤ 6K chars.
  const before = {
    personaLen: npcPersona?.length ?? 0,
    learnerLen: learnerPersona?.length ?? 0,
    rulesLen: interactionRules?.reduce((s, r) => s + r.length, 0) ?? 0,
    goalCount: conversationGoals?.length ?? 0,
  };
  if (npcPersona) npcPersona = capChars(npcPersona, 600, '[persona truncated to 600 chars]');
  if (learnerPersona) learnerPersona = capChars(learnerPersona, 250, '[learner truncated]');
  if (interactionRules) interactionRules = interactionRules
    .slice(0, 5)
    .map(r => capChars(r, 120, ''));
  if (conversationGoals) conversationGoals = conversationGoals
    .map(g => ({
      ...g,
      description: capChars(g.description, 200, ''),
      edgeCases: g.edgeCases?.slice(0, 3).map(e => capChars(e, 80, '')),
    }));

  // Decide which prompt path to use. The 2026-09-01 priority order is:
  //   1. conversationGoals present (agent-loop path, LLM plans dynamically)
  //   2. scriptNodes + ends + persona (legacy script-driven path, fixed sequence)
  //   3. legacy deriveTaskContract path (no 5 fields)
  const hasGoalsPath = Boolean(
    conversationGoals && conversationGoals.length > 0
      && npcPersona && learnerPersona && interactionRules && interactionRules.length > 0
      && endings && endings.length > 0
  );
  const hasScriptPath = !hasGoalsPath && Boolean(
    npcPersona && learnerPersona && interactionRules && interactionRules.length > 0
      && scriptNodes && scriptNodes.length > 0 && endings && endings.length > 0
  );

  console.log('[NPC Chat] buildSystemPrompt routing', {
    scenarioTitle,
    promptPath: hasGoalsPath ? 'agent-loop' : (hasScriptPath ? 'script-driven' : 'legacy'),
    hasGoalsPath,
    hasScriptPath,
    personaLen: npcPersona?.length ?? 0,
    rulesCount: interactionRules?.length ?? 0,
    goalsCount: conversationGoals?.length ?? 0,
    nodesCount: scriptNodes?.length ?? 0,
    endingsCount: endings?.length ?? 0,
    npcSystemPromptLen: npcSystemPrompt?.length ?? 0,
  });

  // 2026-09-01 v5: log the v5 truncation budget so we can see in logcat
  // whether 千问 is actually getting a small prompt or whether the
  // upstream content (backfill / scenario generator) is producing bloat.
  console.log('[NPC Chat] v5 prompt budget applied', {
    before,
    after: {
      personaLen: npcPersona?.length ?? 0,
      learnerLen: learnerPersona?.length ?? 0,
      rulesLen: interactionRules?.reduce((s, r) => s + r.length, 0) ?? 0,
      goalCount: conversationGoals?.length ?? 0,
    },
    truncated: {
      persona: before.personaLen > (npcPersona?.length ?? 0),
      learner: before.learnerLen > (learnerPersona?.length ?? 0),
      rules: before.rulesLen > (interactionRules?.reduce((s, r) => s + r.length, 0) ?? 0),
    },
  });

  // 2026-09-01: explicit 5-field completeness check. Surfaces in logcat so
  // the user can see at a glance whether the card is fully populated or
  // running on a partial backfill. When a card only has 1-2 fields, the
  // prompt will fall through to legacy and lose the agent-loop benefits.
  const fieldMap = {
    npcPersona: !!npcPersona,
    learnerPersona: !!learnerPersona,
    interactionRules: (interactionRules?.length ?? 0) > 0,
    endings: (endings?.length ?? 0) > 0,
    hasGoals: (conversationGoals?.length ?? 0) > 0,
    hasNodes: (scriptNodes?.length ?? 0) > 0,
  };
  const missingFields = Object.entries(fieldMap)
    .filter(([_, present]) => !present)
    .map(([k]) => k);
  if (missingFields.length > 0) {
    console.warn('[NPC Chat] buildSystemPrompt → 5-field completeness', {
      present: fieldMap,
      missing: missingFields,
      fallbackReason: 'missing fields will route to legacy',
    });
  }

  // NOTE: difficulty controls NPC cooperation level only, NOT language complexity.
  // NPC speech complexity always matches userLevel regardless of difficulty.
  const resistanceLayer = npcDifficulty === 'B1'
    ? `## Cooperation Level (B1 — easy)
- Be helpful and cooperative. Give the learner what they want with minimal friction.
- If their English is unclear, interpret charitably and respond naturally.
- Keep the conversation moving forward smoothly.
- NEVER invent reasons to push back if the request is reasonable and clear.`
    : npcDifficulty === 'C1'
    ? `## Cooperation Level (C1 — strict)
- Be difficult and demanding — but only in ways that make sense for THIS specific scenario.
- Push back by asking for clarification, offering alternatives, or raising scenario-relevant complications.
- NEVER invent fake policies, rules, or restrictions that don't logically exist in this scenario.
- React with confusion or mild impatience if their message is genuinely ambiguous.
- Only yield when they communicate clearly and specifically.
- IMPORTANT: Your language complexity must still match the learner's level (${userLevel}).`
    : `## Cooperation Level (B2 — standard)
- Create natural friction that is logical within the scenario (e.g. ask for clarification, offer alternatives, raise realistic complications).
- NEVER use generic pushback phrases like "I have policies to follow" or "I can't do that" unless there is a real, scenario-specific reason.
- React authentically — if they're rude, show mild displeasure.
- If their English is unclear, ask them to clarify naturally.
- If the request is reasonable and clear, move the scenario forward.`;

  if (hasGoalsPath) {
    // ── Agent-loop prompt (2026-09-01) — conversationGoals driven ───────
    // The LLM is the conversation planner. Each turn it must:
    //   1. OBSERVE: read stateUpdate (lastUserIntent, touchedGoals, pendingGoals)
    //   2. THINK: decide nextAction (ask_followup / advance_goal / handle_friction / wrap_up / give_hint)
    //   3. ACT: write the NPC's English reply that reflects the decision
    // conversationGoals are TOPICS to cover, NOT a sequence to perform.
    const goalsBlock = conversationGoals!.map((g, i) => {
      const priority = g.priority ?? 1;
      const edgeCasesBlock = g.edgeCases && g.edgeCases.length > 0
        ? `\n  Possible edge cases (use if the learner gives an opening):\n    - ${g.edgeCases.join('\n    - ')}`
        : '';
      return `${i + 1}. ${g.id} (${g.name}, priority ${priority}): ${g.description}${edgeCasesBlock}`;
    }).join('\n');

    const dynamicState = conversationState ?? {};
    const stateBlock = `[Current state (recomputed each turn)]
- User emotion this turn: ${dynamicState.userEmotion ?? 'unknown'}
- Recent exchange rhythm: ${dynamicState.recentRhythm ?? 'unknown'}
- Touched goals (substantially covered): ${dynamicState.touchedGoalIds && dynamicState.touchedGoalIds.length > 0 ? dynamicState.touchedGoalIds.join(', ') : 'none yet'}
- Pending goals (still need to be covered): ${dynamicState.pendingGoalIds && dynamicState.pendingGoalIds.length > 0 ? dynamicState.pendingGoalIds.join(', ') : 'all touched'}
- Last NPC action hint: ${dynamicState.lastNextAction ?? '(none)'}`;

    return `=== OUTPUT FORMAT (CRITICAL — READ FIRST) ===
Your response MUST be a single valid JSON object. No preamble, no markdown, no code fence, no trailing prose, no plain text, no truncated output.
Required schema:
{
  "text": "<your English reply, 1-4 sentences — must serve a goal and react to the learner's latest turn>",
  "translation": "<accurate Chinese translation of text>",
  "stateUpdate": {
    "topicStatus": "on_track|adjacent_shift|task_switch|off_track",
    "activeGoal": "<goal_id from [Goals] below, or empty if wrapping up>",
    "lastUserIntent": "<3-6 word summary of the learner's reply>",
    "suggestedNpcAction": "ask_followup|advance_goal|handle_friction|wrap_up|give_hint",
    "touchedGoalIds": ["<goal ids covered so far>"],
    "pendingGoalIds": ["<goal ids still to cover>"],
    "shouldConfirmTaskSwitch": false,
    "summary": "<one-line state of the conversation>"
  }
}
If your response is not a parseable JSON object with all the fields above, the system treats it as a failure. NEVER output a single word, a quote, or a truncated JSON. NEVER stop after the first token.

[Role]
You are ${npcName || 'an NPC'}.
${npcPersona}

DO NOT anchor on any single persona behavior sample as your "main" reply pattern. The persona describes many possible behaviors across the conversation — pick the one that serves the current goal + state, not the one most prominently written.

[Opponent — the learner]
${learnerPersona}

[Hard Rules — must follow]
${interactionRules!.map((r, i) => `${i + 1}. ${r}`).join('\n')}

[Goals — topics the NPC must eventually cover]
These are NOT a sequence. The LLM decides each turn WHEN to advance to a new goal, WHEN to dig deeper into the current one, WHEN to follow up, and WHEN to wrap up. The order is yours to choose.
${goalsBlock}

[Endings — when these conditions are met, deliver the ending in character]
${endings!.map((e) => {
  const baseLine = `- ${e.type.toUpperCase()}: when ${e.trigger}${e.npcFinalLine ? ` → "${e.npcFinalLine}"` : ' → improvise a closing line in character'}`;
  return e.type === 'branch' && e.branchSetup ? `${baseLine} | BRANCH SETUP: ${e.branchSetup}` : baseLine;
}).join('\n')}

${stateBlock}

[Agent Loop — 2026-09-01 (replaces the old "follow script" model)]
This is NOT a script you read in order. Each turn you are a conversation planner. Run this loop:

1. OBSERVE: read [Current state] above. What did the learner just say? What emotion? What did the previous turn cover? Are there pending goals the learner hasn't engaged with yet?

2. THINK (decide your nextAction — pick ONE):
   - ask_followup: The learner gave a partial answer on the current goal. Ask 1-2 specific follow-up questions (clarification, detail, a "real" angle) before advancing.
   - advance_goal: The current goal is fully covered (you have enough info to act on it). Move to a higher-priority pending goal naturally (use a "By the way" or "OK... and..." bridge — never say "next question").
   - handle_friction: The learner's reply shows real-world friction (vague, contradicted earlier, fumbled, went off-topic, native language, long silence, emotional). React in character per your persona's "real-life friction" rules. Do NOT politely ask the same question again. Do NOT snap back to the next goal as if nothing happened.
   - give_hint: The learner is stuck or wrong. Give a soft nudge ("If I were you I'd mention..." or "Try saying...") — but stay in character, do not break the fourth wall.
   - wrap_up: All goals are covered. Set the right ending type and deliver a natural close (success/failure/branch).

3. ACT: write your English reply (1-4 sentences) that EXECUTES the action you chose. Stay fully in character. Never break the fourth wall. Never use markdown/asterisks/emoji.

4. UPDATE state: in stateUpdate, set:
   - lastUserIntent: what the learner just said (in 3-6 words)
   - suggestedNpcAction: the nextAction you chose this turn (so the next prompt knows)
   - activeGoal: which goal id you are currently working on (string or empty if wrapping up)
   - touchedGoalIds: updated list (add the goal you just advanced or covered)
   - pendingGoalIds: updated list (remove goals you covered this turn)
   - summary: one-line state of the conversation
   - topicStatus: 'on_track' | 'adjacent_shift' | 'task_switch' | 'off_track'

[Friction — 1 line]
When learner's reply is fumbled / vague / contradictory / native / silent, REACT in character. Do NOT politely re-ask. Do NOT snap to next goal.

[Scene]
Category: ${scenarioCategory} / Title: ${scenarioTitle}
${scenarioDesc ? `Task: ${scenarioDesc}` : ''}
${npcStatus ? `NPC current state: ${npcStatus}` : ''}
${environmentalCue ? `Scene cue: ${environmentalCue}` : ''}
Learner English level: ${userLevel}

${resistanceLayer}

RECAP: output JSON only, schema at top, no preamble.`;
  }

  if (hasScriptPath) {
    // ── Script-driven prompt (2026-09-01) — legacy, fallback only ────────
    // Kept for back-compat. New cards should use conversationGoals.
    return `[Role]
You are ${npcName || 'an NPC'}.
${npcPersona}

[Opponent — the learner]
${learnerPersona}

[Hard Rules — must follow]
${interactionRules!.map((r, i) => `${i + 1}. ${r}`).join('\n')}

[Script — follow these beats in order, do not skip or reorder]
${scriptNodes!.map((n) => {
  const minTurnsHint = n.minTurns ? ` (target ≥${n.minTurns} turns before moving on)` : '';
  return `- ${n.id} (${n.name})${minTurnsHint}: ${n.description}`;
}).join('\n')}

[Endings — when these conditions are met, deliver the ending in character]
${endings!.map((e) => {
  const baseLine = `- ${e.type.toUpperCase()}: when ${e.trigger}${e.npcFinalLine ? ` → "${e.npcFinalLine}"` : ' → improvise a closing line in character'}`;
  return e.type === 'branch' && e.branchSetup ? `${baseLine} | BRANCH SETUP: ${e.branchSetup}` : baseLine;
}).join('\n')}

[Conversation Dynamics — 2026-09-01 depth upgrade]
This is the core fix for "1-2 turn then done" conversations. Follow these rules on EVERY turn:
1. SUB-BEAT FOLLOW-UP: After the learner answers, do NOT immediately move to the next script stage. Ask 1-2 follow-up questions that probe deeper into the same stage — a clarification, a specific detail, a related angle. Only advance to the next stage when the current stage's goals are clearly addressed.
2. NATURAL BRIDGING BETWEEN STAGES: When transitioning to the next stage, NEVER say "next question" or "let me ask you about something else" or any meta-commentary. Bridge naturally: "OK 护照没问题 — 顺便问一下..." or "By the way, while we're at it..." or just seamlessly start the next stage's question as if it follows from what was just discussed.
3. REFUSE TO CLOSE: If the learner says "Thanks", "OK", "That's all", "I think that's it" — do NOT reciprocate the close. Instead, add a small new angle: "Sure, but before you go — one more thing..." or "Actually, I just realized I forgot to ask..."
4. REFERENCE EARLIER: Occasionally reference something the learner said in a previous turn. This makes the conversation feel continuous, not transactional.
5. IN-CHARACTER PACING: Do not rapid-fire 5 short turns in a row without letting the learner actually respond. The conversation should breathe.

[Stage Transitions]
- Do not announce "moving to the next topic" or "now let me check X". Just continue the conversation naturally.
- If a stage's last sub-beat was about money, the next stage's first sub-beat can be "By the way, about your luggage..." without explicit "next" framing.
- The learner should NEVER feel the script moving. It should feel like a continuous real conversation.

[Real Conversation Realities — 2026-09-01 friction upgrade]
Real conversations are NOT clean. People fumble, forget, contradict themselves, get distracted, hand over the wrong thing. A realistic NPC must handle these moments IN CHARACTER rather than waiting for the learner to recover and continue the script.

When the learner's response shows ANY of these real-world frictions, REACT in character (using your persona's "real-life friction" patterns if defined, otherwise improvise a believable reaction). Do NOT ignore the friction or politely ask the same question again. Do NOT snap back to the script's next sub-beat as if nothing happened.

COMMON FRICTIONS and how to handle them:
- Learner fumbles / takes time / doesn't have the document ready: Pause. Show mild impatience or patience per your persona. Ask a specific question like "Carry-on or checked bag?" rather than waiting silently.
- Learner says something vague or non-specific ("it's in my bag", "around a thousand", "I don't remember"): Push for specifics. "Which bag?", "Exactly how much?", "Take a moment to think."
- Learner contradicts an earlier answer: Catch it immediately. "Wait — earlier you said X. Now you say Y. Which is correct?"
- Learner mentions a new detail (e.g. "oh, I also have..." or "actually my child is..."): Pick it up naturally. It's a thread to follow, not a distraction.
- Learner answers in their native language or with a long silence: Repeat the question word-for-word. Wait. Don't move on.
- Learner shows emotion (frustration, nervousness, amusement): Acknowledge briefly per your persona, then continue. Don't be a robot.

The key insight: friction is OPPORTUNITY, not failure. A real customs officer, real barista, real doctor uses these moments to LEARN MORE about the person. So do you. Catch contradictions. Probe vague answers. Pick up on emotional cues. The script is your structure, not your straitjacket.

[Scene]
Category: ${scenarioCategory}
Title: ${scenarioTitle}
${scenarioDesc ? `Task: ${scenarioDesc}` : ''}
${npcStatus ? `NPC current state: ${npcStatus}` : ''}
${environmentalCue ? `Scene cue: ${environmentalCue}` : ''}
Learner English level: ${userLevel}

${resistanceLayer}

[Output — JSON only, no markdown, no code fence]
{
  "text": "<your English reply, 1-4 sentences>",
  "translation": "<accurate Chinese translation>",
  "stateUpdate": {
    "currentStage": "<snake_case_stage_id_from_script_or_runtime — only change this when the current stage's goals are clearly done; do not pre-emptively jump>",
    "topicStatus": "on_track|adjacent_shift|task_switch|off_track",
    "activeObjective": "<current objective in your own words>",
    "lastUserIntent": "<brief intent>",
    "filledSlots": {},
    "pendingSlots": [],
    "suggestedNpcAction": "<brief next action>",
    "shouldConfirmTaskSwitch": false,
    "summary": "<one-line summary of where we are in the script>"
  }
}

CRITICAL: Stay in character. NEVER break the fourth wall. NEVER say you are an AI or a tutor. NEVER use markdown/asterisks/emoji in your text field.`;
  }

  // ── Legacy prompt path (fallback for cards without script fields) ──────
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

/**
 * Conversation state inference (2026-09-01 depth upgrade).
 *
 * Inspects the latest user message and recent history to estimate:
 *   - userEmotion: how the learner is feeling right now
 *   - recentRhythm: the cadence of the last few exchanges
 *
 * This is a lightweight heuristic. The LLM is the ultimate authority; we
 * just give it a starting point. Output goes into the system prompt so
 * the LLM's plan is grounded in observed signals rather than invented.
 */
function inferConversationState(input: {
  userMessage: string;
  history: ChatTurn[];
}): {
  userEmotion: 'relaxed' | 'nervous' | 'confused' | 'frustrated' | 'rushed' | 'engaged' | 'silence';
  recentRhythm: 'q_a' | 'q_q_a' | 'npc_explains' | 'user_storytelling' | 'friction' | 'silence';
} {
  const msg = (input.userMessage || '').trim();
  const lower = msg.toLowerCase();
  const len = msg.length;

  // userEmotion heuristics
  let userEmotion: 'relaxed' | 'nervous' | 'confused' | 'frustrated' | 'rushed' | 'engaged' | 'silence';
  if (len === 0) {
    userEmotion = 'silence';
  } else if (len < 5) {
    userEmotion = 'rushed';
  } else if (/\?/.test(msg) && len < 30) {
    // short question = likely confused / asking for clarification
    userEmotion = 'confused';
  } else if (/(sorry|excuse|pardon|don't understand|don`t know|no idea)/i.test(lower)) {
    userEmotion = 'confused';
  } else if (/(angry|annoyed|frustrated|terrible|ridiculous|useless)/i.test(lower)) {
    userEmotion = 'frustrated';
  } else if (/(nervous|worried|scared|stress|anxious|afraid)/i.test(lower)) {
    userEmotion = 'nervous';
  } else if (/(haha|lol|fun|great|awesome|amazing|love it)/i.test(lower) && len > 30) {
    userEmotion = 'engaged';
  } else if (len > 80) {
    userEmotion = 'engaged';
  } else {
    userEmotion = 'relaxed';
  }

  // recentRhythm: look at last 3 turns
  const recent = input.history.slice(-3);
  let recentRhythm: 'q_a' | 'q_q_a' | 'npc_explains' | 'user_storytelling' | 'friction' | 'silence';
  if (len === 0) {
    recentRhythm = 'silence';
  } else if (len > 100) {
    recentRhythm = 'user_storytelling';
  } else if (recent.length >= 2 && recent.slice(-2).every(t => t.role === 'npc')) {
    recentRhythm = 'q_q_a';
  } else if (recent.length >= 2 && recent.slice(-2).every(t => t.role === 'user')) {
    recentRhythm = 'npc_explains';
  } else {
    recentRhythm = 'q_a';
  }
  // Friction override: if the user just expressed confusion/frustration
  // and the NPC last turn was a question, that's friction.
  if ((userEmotion === 'confused' || userEmotion === 'frustrated') && recent.length > 0 && recent[recent.length - 1].role === 'npc' && /\?/.test(recent[recent.length - 1].text)) {
    recentRhythm = 'friction';
  }

  return { userEmotion, recentRhythm };
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
  // ── 2026-09-01: infer conversation state if caller didn't supply it ──
  // The agent-loop prompt needs (userEmotion, recentRhythm, touchedGoalIds,
  // pendingGoalIds) to let the LLM plan its nextAction. We infer the first
  // two heuristically here; the caller can override.
  let workingInput = input;
  if (!input.conversationState && (input.conversationGoals?.length ?? 0) > 0) {
    const inferred = inferConversationState({ userMessage: input.userMessage, history: input.history });
    workingInput = { ...input, conversationState: { ...inferred } };
    console.log('[NPC Chat] inferConversationState', {
      userMessageLen: input.userMessage.length,
      historyTurns: input.history.length,
      inferred,
      callerOverrode: false,
    });
  } else if (input.conversationState) {
    console.log('[NPC Chat] inferConversationState', {
      userMessageLen: input.userMessage.length,
      historyTurns: input.history.length,
      callerOverrode: true,
      callerState: input.conversationState,
    });
  }

  const systemPrompt = buildSystemPrompt(workingInput);
  const currentRuntime = normalizeConversationRuntime(workingInput.taskContract, workingInput.runtimeState);

  // ── 2026-09-01: log FULL system prompt + scenario context for evaluation ──
  // User explicitly requested every prompt + every output be in logs so they
  // can evaluate effect. We log:
  //   1. Routing decision (which prompt template was used)
  //   2. Scenario context (5 fields + runtime state)
  //   3. The FULL system prompt (not a 800-char preview) so the user can
  //      see exactly what the LLM is being told.
  //   4. The prompt length in case the full log gets trimmed by logcat.
  // The 800-char preview was dropped because the user needs the whole
  // prompt to evaluate, not just the lead.
  console.log('[NPC Chat] === PROMPT START ===');
  console.log('[NPC Chat] scenario:', workingInput.scenarioTitle, '/ category:', workingInput.scenarioCategory);
  console.log('[NPC Chat] history turns:', workingInput.history.length, '/ user message chars:', workingInput.userMessage.length);
  console.log('[NPC Chat] hasGoalsPath:', Boolean(workingInput.conversationGoals?.length), '/ hasScriptPath:', Boolean(!workingInput.conversationGoals?.length && workingInput.scriptNodes?.length));
  console.log('[NPC Chat] inferred state:', workingInput.conversationState ?? '(none)');
  console.log('[NPC Chat] npcPersona chars:', (workingInput.npcPersona ?? '').length);
  console.log('[NPC Chat] learnerPersona chars:', (workingInput.learnerPersona ?? '').length);
  console.log('[NPC Chat] interactionRules count:', (workingInput.interactionRules ?? []).length);
  console.log('[NPC Chat] conversationGoals count:', (workingInput.conversationGoals ?? []).length);
  console.log('[NPC Chat] scriptNodes count:', (workingInput.scriptNodes ?? []).length, '(legacy)');
  console.log('[NPC Chat] endings count:', (workingInput.endings ?? []).length);
  console.log('[NPC Chat] --- SYSTEM PROMPT (FULL, ' + systemPrompt.length + ' chars) ---');
  console.log(systemPrompt);
  console.log('[NPC Chat] --- END SYSTEM PROMPT ---');
  console.log('[NPC Chat] === PROMPT END ===');

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
      // 2026-09-01: log full BYOK response for parity with shared Qwen.
      console.log('[BYOK-AI] === BYOK RESPONSE (FULL, ' + content.length + ' chars) ===');
      console.log(content);
      console.log('[BYOK-AI] === END BYOK RESPONSE ===');
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
    console.log('[NPC Chat] Qwen request', {
      model: QWEN_MODEL,
      temperature: 0.9,
      max_tokens: 400,
      historyTurns: historyMessages.length,
      userMessagePreview: input.userMessage.slice(0, 80),
      systemPromptLen: systemPrompt.length,
      inferredState: workingInput.conversationState,
    });

    const t0 = Date.now();
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
        // 2026-09-01: bumped from 0.55/200 to 0.9/400 to give Qwen more room
        // to improvise unique replies and avoid the "1-line parrot" feel.
        temperature: 0.9,
        max_tokens: 400,
        response_format: { type: 'json_object' },
      }),
    });

    if (!response.ok) {
      console.warn('[NPC Chat] Qwen HTTP non-OK', {
        status: response.status,
        elapsedMs: Date.now() - t0,
      });
      return buildContextualFallbackReply(input, `http_${response.status}`);
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content?.trim() ?? '';
    const usage = data.usage ?? {};
    console.log('[NPC Chat] === QWEN RESPONSE START ===');
    console.log('[NPC Chat] elapsedMs:', Date.now() - t0, '/ contentLen:', content.length, '/ promptTokens:', usage.prompt_tokens, '/ completionTokens:', usage.completion_tokens);
    console.log('[NPC Chat] --- QWEN RESPONSE (FULL, ' + content.length + ' chars) ---');
    console.log(content);
    console.log('[NPC Chat] --- END QWEN RESPONSE ---');
    console.log('[NPC Chat] === QWEN RESPONSE END ===');
    return processNpcContent(content, workingInput, currentRuntime, undefined);
  } catch (err) {
    console.error('[NPC Chat] Qwen fetch failed', err);
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
      // 2026-09-01: bumped from 0.55/240 to 0.9/400 (match shared Qwen path)
      temperature: 0.9,
      maxTokens: 400,
    });
    if (!res.ok) {
      console.warn('[NPC Chat] BYOK anthropic failed', res.reason, res.status, res.message);
      return '';
    }
    console.log('[NPC Chat] BYOK anthropic response', { textLen: res.text.length, preview: res.text.slice(0, 200) });
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
    // 2026-09-01: bumped from 0.55/240 to 0.9/400 (match shared Qwen path)
    temperature: 0.9,
    maxTokens: 400,
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
    const newState = normalizeConversationRuntime(input.taskContract, parsedPayload.stateUpdate ?? currentRuntime);
    const result: NPCReplyResult = {
      text: cleanText || buildContextualFallbackReply(input, 'empty_text').text,
      translation: parsedPayload.translation,
      runtimeState: newState,
      status: cleanText ? 'ok' : 'fallback',
      fallbackReason: cleanText ? undefined : (fallbackPrefix ? `${fallbackPrefix}_empty` : 'empty_text'),
    };

    // ── 2026-09-01 depth upgrade: stage progression telemetry ────────────
    // Track how many user turns the NPC spent on each stage. If the NPC
    // jumps stages after a single turn (no sub-beat follow-up), this will
    // surface it.
    const prevStage = currentRuntime.currentStage;
    const newStage = newState.currentStage;
    const stageChanged = prevStage !== newStage;
    const textSentences = (cleanText.match(/[.!?]+/g) || []).length;

    // Count user turns in the current stage (from history, role=user only,
    // since the last time the stage id changed in any state update).
    let userTurnsInCurrentStage = 0;
    if (input.history) {
      for (let i = input.history.length - 1; i >= 0; i--) {
        if (input.history[i].role !== 'user') continue;
        userTurnsInCurrentStage += 1;
        // Approximation: stop counting if we hit a previous stage-change
        // boundary. We don't have a per-turn stage log so this is best-effort.
        if (userTurnsInCurrentStage >= 8) break;
      }
    }

    // Find minTurns hint for the new stage so we can flag premature jumps.
    const newStageNode = input.scriptNodes?.find(n => n.id === newStage);
    const minTurnsHint = newStageNode?.minTurns;
    const tooFastJump = stageChanged && minTurnsHint !== undefined && userTurnsInCurrentStage < minTurnsHint;

    // ── 2026-09-01: extract agent-loop signals from the parsed stateUpdate ──
    // When the LLM runs the new agent-loop path, it emits nextAction +
    // activeGoal + touchedGoalIds in stateUpdate. Surface them for eval.
    // 2026-09-01 v3: apply client-side guards BEFORE reading nextAction so
    // we see the corrected values (guards override the LLM when it
    // (a) repeats its own previous line or (b) wraps up on a single "thanks").
    const guardedSu = applyStateGuards(parsedPayload.stateUpdate, input, cleanText);
    const su = guardedSu as Record<string, unknown>;
    const nextAction = typeof su.suggestedNpcAction === 'string' ? su.suggestedNpcAction : null;
    const activeGoal = typeof su.activeGoal === 'string' ? su.activeGoal : null;
    const touchedIds = Array.isArray(su.touchedGoalIds) ? su.touchedGoalIds as unknown[] : null;
    const pendingIds = Array.isArray(su.pendingGoalIds) ? su.pendingGoalIds as unknown[] : null;
    const lastUserIntent = typeof su.lastUserIntent === 'string' ? su.lastUserIntent : null;
    const llmSummary = typeof su.summary === 'string' ? su.summary : null;

    console.log('[NPC Chat] processNpcContent → parsed ok', {
      hasTranslation: !!parsedPayload.translation,
      translationLen: parsedPayload.translation.length,
      hasStateUpdate: !!parsedPayload.stateUpdate,
      // agent-loop signals (only when LLM ran the new path)
      nextAction,
      // 2026-09-01: human-readable label for the nextAction so user can
      // evaluate without having to map the enum to a sentence.
      nextActionLabel: nextAction === 'ask_followup' ? '追问细节'
        : nextAction === 'advance_goal' ? '推进下一个目标'
        : nextAction === 'handle_friction' ? '处理卡壳/冲突'
        : nextAction === 'wrap_up' ? '收尾总结'
        : nextAction === 'give_hint' ? '给提示'
        : (nextAction ?? null),
      activeGoal,
      // Resolve the active goal's name from input.conversationGoals so the
      // log shows "verify_passport (查护照)" instead of just an id.
      activeGoalName: activeGoal
        ? (input.conversationGoals?.find(g => g.id === activeGoal)?.name ?? '(unresolved id)')
        : null,
      touchedGoalIds: touchedIds,
      pendingGoalIds: pendingIds,
      lastUserIntent,
      summary: llmSummary,
      // legacy stage tracking (only when LLM ran the old path)
      prevStage,
      newStage,
      stageChanged,
      userTurnsInCurrentStage,
      textSentences,
      newStageMinTurnsHint: minTurnsHint,
      tooFastJump,
      textPreview: cleanText.slice(0, 120),
      status: result.status,
      fallbackReason: result.fallbackReason,
    });

    if (tooFastJump) {
      console.warn('[NPC Chat] DepthWarning: stage jumped before minTurns', {
        newStage,
        userTurnsInCurrentStage,
        minTurnsHint,
      });
    }

    // ── 2026-09-01: log the FULL NPC reply text + translation for eval ──
    console.log('[NPC Chat] === NPC REPLY (text + translation) ===');
    console.log(`[NPC Chat] EN: ${cleanText}`);
    if (parsedPayload.translation) {
      console.log(`[NPC Chat] ZH: ${parsedPayload.translation}`);
    }
    console.log('[NPC Chat] === END NPC REPLY ===');

    return result;
  }

  const looksStructured = content.includes('"text"') || (content.trim().startsWith('{') && content.includes('"translation"'));
  if (looksStructured) {
    console.warn('[NPC Chat] processNpcContent → looks structured but JSON parse failed', {
      contentPreview: content.slice(0, 200),
      fallbackPrefix,
    });
    return buildContextualFallbackReply(input, fallbackPrefix ? `${fallbackPrefix}_invalid_json` : 'invalid_json');
  }

  const cleanContent = sanitizeNpcDialogueText(content);
  console.log('[NPC Chat] processNpcContent → treating as plain text', {
    rawLen: content.length,
    cleanLen: cleanContent.length,
    preview: cleanContent.slice(0, 120),
  });

  // 2026-09-01 v4: detect degenerate LLM output (千问's "infinite loop" failure
  // mode where it generates "300.5001234..." or repeated phrases until
  // max_tokens is exhausted). If we let this through, the user sees 9 seconds
  // of garbage. Replace the text with the contextual fallback and log loudly.
  const degenerate = isDegenerateLlmOutput(content, cleanContent);
  if (degenerate.isDegenerate) {
    const fallback = buildContextualFallbackReply(input, fallbackPrefix ? `${fallbackPrefix}_degenerate` : 'degenerate');
    console.warn('[NPC Chat] processNpcContent → DEGENERATE LLM output replaced with fallback', {
      rawLen: content.length,
      cleanLen: cleanContent.length,
      preview: cleanContent.slice(0, 80),
      reason: degenerate.reason,
      digitRatio: degenerate.digitRatio,
      wordCount: degenerate.wordCount,
    });
    const recoveredStateUpdate = inferStateUpdateFromPlainText(input, currentRuntime, fallback.text);
    return {
      text: fallback.text,
      translation: '',
      runtimeState: recoveredStateUpdate ?? currentRuntime,
      status: 'fallback',
      fallbackReason: `degenerate_${degenerate.reason}`,
    };
  }

  // 2026-09-01: when LLM returns plain text instead of JSON (千问 common
  // failure mode on long prompts), the state machine would otherwise stay
  // stuck — nextAction never gets recorded, activeGoal never advances. We
  // recover by inferring a minimal stateUpdate from the input so the
  // NEXT turn's prompt has fresh data to drive the LLM.
  const recoveredStateUpdate = inferStateUpdateFromPlainText(input, currentRuntime, cleanContent);
  return {
    text: cleanContent || buildContextualFallbackReply(input, fallbackPrefix ? `${fallbackPrefix}_invalid_json` : 'invalid_json').text,
    translation: '',
    runtimeState: recoveredStateUpdate ?? currentRuntime,
    status: cleanContent ? 'ok' : 'fallback',
    fallbackReason: cleanContent ? undefined : (fallbackPrefix ? `${fallbackPrefix}_invalid_json` : 'invalid_json'),
  };
}

// 2026-09-01: minimal recovery from a plain-text LLM response. Tries to
// keep the agent loop alive so the next turn has plausible state. The goal
// is NOT to be clever — just to make sure activeGoal / touchedGoalIds /
// suggestedNpcAction don't all stay at their initial values forever, which
// would cause the LLM to keep re-asking the same question.
function inferStateUpdateFromPlainText(
  input: NPCChatInput,
  currentRuntime: ReturnType<typeof normalizeConversationRuntime>,
  plainText: string,
): ReturnType<typeof normalizeConversationRuntime> | null {
  const goals = input.conversationGoals ?? [];
  if (goals.length === 0) {
    return null;
  }

  // Heuristic 1: detect "Anna" / "Anna?" / other 1-2 word replies that
  // mean the LLM parroted a persona sample. Force nextAction = handle_friction
  // so the NEXT prompt asks for a full sentence, not a single word.
  const wordCount = plainText.trim().split(/\s+/).filter(Boolean).length;
  const isParrotShort = wordCount > 0 && wordCount <= 2;

  // Heuristic 2: pick activeGoal — prefer the highest-priority pending goal.
  const sortedGoals = [...goals].sort((a, b) => (b.priority ?? 1) - (a.priority ?? 1));
  const activeGoal = sortedGoals[0]?.id ?? '';
  const pendingGoalIds = sortedGoals.map(g => g.id);

  const nextAction: 'ask_followup' | 'handle_friction' =
    isParrotShort ? 'handle_friction' : 'ask_followup';

  const recovered = {
    ...currentRuntime,
    activeGoal,
    pendingGoalIds,
    touchedGoalIds: [] as string[],
    lastUserIntent: currentRuntime.lastUserIntent,
    suggestedNpcAction: nextAction,
    summary: currentRuntime.summary || `Plain-text LLM recovery: "${plainText.slice(0, 40)}" → force ${nextAction} on goal ${activeGoal}`,
  };

  console.log('[NPC Chat] processNpcContent → recovered stateUpdate from plain text', {
    isParrotShort,
    wordCount,
    activeGoal,
    pendingGoalIds,
    nextAction,
    goalCount: goals.length,
  });

  return recovered;
}

// 2026-09-01 v4: degenerate-output detector.
//
// 千问 in some prompt contexts enters a "degenerate loop" where it generates
// garbage (digit strings like "300.5001234...", or repeated tokens) until
// max_tokens is exhausted. We've seen up to 9 seconds of pure noise. We
// detect this in three orthogonal ways and replace the text with a
// contextual fallback. We deliberately keep the original content visible
// only in the log so we can debug which trigger fired.
//
// Triggers (any one is enough):
//   1. digitRatio > 0.7 (most chars are digits or dots — "300.5001234")
//   2. wordCount < 5 AND length > 100 (very long but very few words = noise)
//   3. Non-English character ratio > 0.5 (random punctuation / unicode)
function isDegenerateLlmOutput(raw: string, cleaned: string): {
  isDegenerate: boolean;
  reason: 'digit_loop' | 'low_word_density' | 'non_english_noise' | null;
  digitRatio: number;
  wordCount: number;
} {
  const text = (cleaned || raw || '').trim();
  if (text.length === 0) {
    return { isDegenerate: false, reason: null, digitRatio: 0, wordCount: 0 };
  }

  // 1. Digit loop
  const digitOrDot = (text.match(/[\d.]/g) || []).length;
  const digitRatio = digitOrDot / text.length;
  if (digitRatio > 0.7 && text.length > 30) {
    return { isDegenerate: true, reason: 'digit_loop', digitRatio, wordCount: 0 };
  }

  // 2. Low word density — long text but almost no real words
  const words = text.split(/\s+/).filter(Boolean);
  const wordCount = words.length;
  if (text.length > 100 && wordCount < 5) {
    return { isDegenerate: true, reason: 'low_word_density', digitRatio, wordCount };
  }

  // 3. Non-English / non-CJK noise (random punctuation / control chars)
  const nonNoiseChars = (text.match(/[a-zA-Z\u4e00-\u9fff\s,.!?'"'-]/g) || []).length;
  const noiseRatio = 1 - nonNoiseChars / text.length;
  if (noiseRatio > 0.5 && text.length > 30) {
    return { isDegenerate: true, reason: 'non_english_noise', digitRatio, wordCount };
  }

  return { isDegenerate: false, reason: null, digitRatio, wordCount };
}

// 2026-09-01 v3: client-side guards that override the LLM's stateUpdate
// when the LLM is misbehaving in two specific ways 千问 does on long prompts:
//
// 1. REPETITION: 千问 returns the same NPC line 2-3 turns in a row. Without
//    intervention, the state machine would happily wrap up because the
//    text "looks done". We compare the new reply against the last 2 NPC
//    turns; > 70% word overlap = force nextAction = ask_followup.
//
// 2. PREMATURE WRAP-UP: 千问 sees the user say "thanks" once and decides
//    all goals are covered, ignoring [Hard Rules] #3 ("if learner says
//    thanks, do NOT close"). We re-detect: if suggestedNpcAction ==
//    'wrap_up' but the user's latest message is NOT a clear closing, we
//    force nextAction = ask_followup on the highest-priority pending goal.
//
// We deliberately do NOT override the `text` field — what the user sees is
// still the LLM's real output. We only correct the state machine so the
// NEXT prompt drives a different LLM behaviour.

interface GuardedStateUpdate {
  suggestedNpcAction?: string;
  activeGoal?: string;
  pendingGoalIds?: string[];
  touchedGoalIds?: string[];
  summary?: string;
}

function detectNpcRepetition(currentText: string, history: ChatTurn[]): { isRepetitive: boolean; similarity: number; matchedTurn: string | null } {
  const npcTurns = history.filter(t => t.role === 'npc').slice(-3);
  if (npcTurns.length === 0) return { isRepetitive: false, similarity: 0, matchedTurn: null };

  const currentTokens = new Set(currentText.toLowerCase().split(/\W+/).filter(w => w.length >= 3));
  if (currentTokens.size === 0) return { isRepetitive: false, similarity: 0, matchedTurn: null };

  for (const turn of npcTurns) {
    const pastTokens = new Set(turn.text.toLowerCase().split(/\W+/).filter(w => w.length >= 3));
    if (pastTokens.size === 0) continue;
    const intersection = [...currentTokens].filter(t => pastTokens.has(t)).length;
    const union = new Set([...currentTokens, ...pastTokens]).size;
    const jaccard = union === 0 ? 0 : intersection / union;
    if (jaccard > 0.7) {
      return { isRepetitive: true, similarity: jaccard, matchedTurn: turn.text.slice(0, 80) };
    }
  }
  return { isRepetitive: false, similarity: 0, matchedTurn: null };
}

function detectPrematureWrapUp(userMessage: string, historyTurns: number): boolean {
  // If the user has only said thanks/goodbye once or twice AND the
  // conversation is still in the early-middle phase, the NPC should NOT
  // wrap up. Hard cap: only allow wrap-up after 5+ user turns OR when
  // the user's latest message is a CLEAR closing.
  const lower = userMessage.toLowerCase().trim();
  const clearClosingPatterns = [
    /^(bye|goodbye|see you|farewell|see ya)/,
    /^(thanks|thank you|thx|ty)\s*[\.!]?\s*$/,
    /(that'?s all|i'?m done|i'?m finished|that is all|all set|nothing else)/,
  ];
  const isClearClose = clearClosingPatterns.some(p => p.test(lower));

  // Allow wrap-up only when:
  // - conversation has gone long enough (>= 6 user turns) AND
  // - user gave a clear closing signal
  if (isClearClose && historyTurns >= 6) return false; // legitimate wrap
  if (isClearClose) return true; // too early
  return true; // user didn't close at all → any wrap_up is premature
}

function applyStateGuards(
  stateUpdate: Record<string, unknown> | null | undefined,
  input: NPCChatInput,
  cleanText: string,
): GuardedStateUpdate {
  const su = (stateUpdate ?? {}) as Record<string, unknown>;
  const goals = input.conversationGoals ?? [];
  const sortedGoals = [...goals].sort((a, b) => (b.priority ?? 1) - (a.priority ?? 1));
  const currentAction = typeof su.suggestedNpcAction === 'string' ? su.suggestedNpcAction : null;
  const userMsg = input.history.filter(t => t.role === 'user').pop()?.text ?? '';
  const userTurnCount = input.history.filter(t => t.role === 'user').length;

  const result: GuardedStateUpdate = { ...su } as GuardedStateUpdate;
  let guardFired = false;

  // Guard 1: NPC repetition
  const rep = detectNpcRepetition(cleanText, input.history);
  if (rep.isRepetitive && currentAction === 'wrap_up') {
    // Worst case: 千问 repeated AND decided to wrap up → force ask_followup
    result.suggestedNpcAction = 'ask_followup';
    result.activeGoal = sortedGoals[0]?.id ?? '';
    result.pendingGoalIds = sortedGoals.map(g => g.id);
    result.touchedGoalIds = []; // trust nothing from this turn
    result.summary = `Repetition guard: NPC line matched past turn at ${(rep.similarity * 100).toFixed(0)}% similarity → forced ask_followup`;
    guardFired = true;
  } else if (rep.isRepetitive) {
    // Repetition but not wrap_up → still poke the state machine so next
    // turn's prompt knows to push a new angle.
    result.activeGoal = sortedGoals.find(g => !(result.touchedGoalIds ?? []).includes(g.id))?.id ?? sortedGoals[0]?.id ?? '';
    result.summary = (result.summary ?? '') + ` | repetition detected (${(rep.similarity * 100).toFixed(0)}%) — pivot requested`;
    guardFired = true;
  }

  // Guard 2: premature wrap-up
  if (currentAction === 'wrap_up' && detectPrematureWrapUp(userMsg, userTurnCount)) {
    result.suggestedNpcAction = 'ask_followup';
    const pending = sortedGoals.filter(g => !(result.touchedGoalIds ?? []).includes(g.id));
    result.activeGoal = pending[0]?.id ?? sortedGoals[0]?.id ?? '';
    result.pendingGoalIds = pending.map(g => g.id);
    result.summary = (result.summary ?? '') + ` | premature-wrap guard: user msg not a clear close → forced ask_followup on ${result.activeGoal}`;
    guardFired = true;
  }

  if (guardFired) {
    console.log('[NPC Chat] processNpcContent → state guards fired', {
      originalAction: currentAction,
      finalAction: result.suggestedNpcAction,
      repetition: rep.isRepetitive ? { similarity: rep.similarity, matched: rep.matchedTurn } : null,
      userMsgPreview: userMsg.slice(0, 60),
      userTurnCount,
      finalActiveGoal: result.activeGoal,
      finalPending: result.pendingGoalIds,
    });
  }

  return result;
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
 *
 * 2026-09-01 upgrade: hint prompt now reads the same 5 script-driven fields
 * as the NPC main-reply path (npcPersona / scriptNodes / interactionRules /
 * endings) plus the current conversationRuntime state, so hints can guide
 * the learner to the NEXT script beat rather than the same beat repeated
 * three ways. Falls back to the legacy "language coach" prompt if the
 * 5 fields are not provided (e.g. older call sites or legacy cards before
 * the backfill runs).
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

  // ── Script-driven fields (2026-09-01, optional) ─────────────────────────
  // When ALL of these are present, hint prompt uses the rich script-aware
  // path. Otherwise falls back to the legacy "language coach" prompt.
  npcPersona?: string;
  learnerPersona?: string;
  interactionRules?: string[];
  scriptNodes?: Array<{ id: string; name: string; description: string; minTurns?: number }>;
  endings?: Array<{ type: 'success' | 'failure' | 'branch'; trigger: string; npcFinalLine?: string; branchSetup?: string }>;

  // ── Conversation-goal fields (2026-09-01, optional) ──────────────────
  // When present, the hint prompt treats these as the topics the NPC is
  // trying to cover (alongside the legacy scriptNodes path). When BOTH
  // conversationGoals and scriptNodes are absent, hint prompt falls back
  // to the legacy "language coach" template.
  conversationGoals?: Array<{
    id: string;
    name: string;
    description: string;
    priority?: number;
    edgeCases?: string[];
  }>;
  conversationState?: {
    userEmotion?: 'relaxed' | 'nervous' | 'confused' | 'frustrated' | 'rushed' | 'engaged' | 'silence';
    recentRhythm?: 'q_a' | 'q_q_a' | 'npc_explains' | 'user_storytelling' | 'friction' | 'silence';
    touchedGoalIds?: string[];
    pendingGoalIds?: string[];
    lastNextAction?: 'ask_followup' | 'advance_goal' | 'handle_friction' | 'wrap_up' | 'give_hint';
  };
}): Promise<HintSuggestion[]> {
  const {
    scenarioTitle, scenarioCategory, scenarioDesc, history, taskContract, runtimeState,
    userLevel = 'B1', environmentalCue,
    npcPersona, learnerPersona, interactionRules, scriptNodes, endings,
    conversationGoals, conversationState,
  } = input;
  const hasScriptFields = Boolean(npcPersona && learnerPersona && interactionRules?.length && scriptNodes?.length && endings?.length);
  // 2026-09-01: prefer conversationGoals over scriptNodes for the prompt
  // engine path. The hint prompt should hint toward topics the NPC is
  // CURRENTLY trying to surface, not the legacy linear stage.
  const hasGoalsFields = Boolean(npcPersona && learnerPersona && interactionRules?.length && conversationGoals?.length && endings?.length);
  const hasScriptAware = hasGoalsFields || hasScriptFields;
  const normalizedRuntime = runtimeState && taskContract
    ? normalizeConversationRuntime(taskContract, runtimeState)
    : null;

  const lastNPCMsg = [...history].reverse().find(t => t.role === 'npc')?.text ?? '';
  const hasNPCSpoken = lastNPCMsg.length > 0;

  const recentHistory = history
    .map(t => `${t.role === 'user' ? 'Learner' : 'NPC'}: ${t.text}`)
    .join('\n');
  const runtimeBlock = taskContract
    ? `\n\n## Task Contract\n${contractToPromptBlock(taskContract)}\n\n## Runtime State\n${runtimeToPromptBlock(normalizeConversationRuntime(taskContract, runtimeState))}`
    : '';

  const prompt = hasScriptFields
    ? buildScriptAwareHintPrompt({
        hasNPCSpoken,
        lastNPCMsg,
        recentHistory,
        scenarioTitle, scenarioCategory, scenarioDesc, environmentalCue,
        npcPersona: npcPersona!,
        learnerPersona: learnerPersona!,
        interactionRules: interactionRules!,
        scriptNodes: scriptNodes!,
        endings: endings!,
        runtime: normalizedRuntime,
        userLevel,
      })
    : hasNPCSpoken
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
      "style": "<2-4 Chinese chars describing the strategy or tone of THIS reply. Must be a fresh label every turn — do NOT repeat labels from earlier hints, and do NOT copy any predefined category names.>"
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
      "style": "<2-4 Chinese chars describing the strategy or tone of THIS opening. Must be a fresh label every time — do NOT repeat labels from earlier hints, and do NOT copy any predefined category names.>"
    }
  ]
}`;

  // ── Hint pipeline logging (2026-09-01) ────────────────────────────────────
  // So we can see end-to-end whether the lightbulb is really prompt-driven
  // (LLM produced) or silently falling back to the hardcoded getFallbackHints.
  // 2026-09-01: 3-tier routing — goals (agent-loop) > script (legacy) > derive.
  const hintPromptPath: 'goals-aware' | 'script-aware' | 'legacy' = hasGoalsFields
    ? 'goals-aware'
    : hasScriptFields
      ? 'script-aware'
      : 'legacy';
  console.log('[NPC Chat] generateHints start', {
    scenarioTitle,
    scenarioCategory,
    hasDesc: !!scenarioDesc,
    historyTurns: history.length,
    hasNPCSpoken,
    hasGoalsFields,
    hasScriptFields,
    currentStage: normalizedRuntime?.currentStage,
    pendingSlots: normalizedRuntime?.pendingSlots,
    lastNPCPreview: lastNPCMsg.slice(0, 100),
    hasTaskContract: !!taskContract,
    promptPath: hintPromptPath,
  });
  console.log('[NPC Chat] --- HINT PROMPT (FULL, ' + prompt.length + ' chars) ---');
  console.log(prompt);
  console.log('[NPC Chat] --- END HINT PROMPT ---');

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
      // 2026-09-01: log full BYOK hint response for parity with shared Qwen.
      console.log('[BYOK-AI] === BYOK HINT RESPONSE (FULL, ' + content.length + ' chars) ===');
      console.log(content);
      console.log('[BYOK-AI] === END BYOK HINT RESPONSE ===');
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

  if (!QWEN_API_KEY) {
    console.warn('[NPC Chat] generateHints → no QWEN_API_KEY, using hardcoded fallback');
    return getFallbackHints(lastNPCMsg);
  }

  try {
    console.log('[NPC Chat] generateHints Qwen request', {
      model: QWEN_MODEL,
      temperature: 0.8,
      max_tokens: 400,
      hasNPCSpoken,
      promptLen: prompt.length,
    });

    const t0 = Date.now();
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

    if (!response.ok) {
      console.warn('[NPC Chat] generateHints Qwen HTTP non-OK', {
        status: response.status,
        elapsedMs: Date.now() - t0,
      });
      return getFallbackHints(lastNPCMsg);
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content;
    const usage = data.usage ?? {};
    console.log('[NPC Chat] generateHints Qwen response', {
      elapsedMs: Date.now() - t0,
      contentLen: typeof content === 'string' ? content.length : 0,
      promptTokens: usage.prompt_tokens,
      completionTokens: usage.completion_tokens,
    });
    // 2026-09-01: log full hint response for evaluation.
    if (typeof content === 'string') {
      console.log('[NPC Chat] --- HINT QWEN RESPONSE (FULL, ' + content.length + ' chars) ---');
      console.log(content);
      console.log('[NPC Chat] --- END HINT QWEN RESPONSE ---');
    }
    const hints = parseHintsContent(typeof content === 'string' ? content : '');
    if (hints.length) {
      console.log('[NPC Chat] generateHints → parsed from LLM', {
        count: hints.length,
        hintsPreview: hints.map(h => ({
          style: h.style,
          textPreview: h.text.slice(0, 60),
          translationPreview: h.translation.slice(0, 30),
        })),
      });
      return hints;
    }
    console.warn('[NPC Chat] generateHints → parse returned empty, using hardcoded fallback');
    return getFallbackHints(lastNPCMsg);
  } catch (e) {
    console.error('[NPC Chat] generateHints Qwen fetch failed', e);
    return getFallbackHints(lastNPCMsg);
  }
}

/**
 * Script-aware hint prompt (2026-09-01).
 *
 * Used when the calling site provides all 5 script-driven fields. Generates
 * hints that:
 *   1. Match the NPC's persona + interaction rules (so hints don't clash
 *      with the character the NPC is playing).
 *   2. Are aware of which script beat the conversation is on, and which
 *      required slot is still pending — so hints help the learner ADVANCE
 *      the script, not just repeat the same beat 3 ways.
 *   3. Include a "preview" of the next beat so even early hints hint at
 *      the deeper conversation to come.
 *
 * Same千问 discipline as the NPC system prompt: no example lines in the
 * prompt, abstract descriptions only.
 */
function buildScriptAwareHintPrompt(params: {
  hasNPCSpoken: boolean;
  lastNPCMsg: string;
  recentHistory: string;
  scenarioTitle: string;
  scenarioCategory: string;
  scenarioDesc?: string;
  environmentalCue?: string;
  npcPersona: string;
  learnerPersona: string;
  interactionRules: string[];
  scriptNodes: Array<{ id: string; name: string; description: string }>;
  endings: Array<{ type: 'success' | 'failure' | 'branch'; trigger: string }>;
  runtime: ReturnType<typeof normalizeConversationRuntime> | null;
  userLevel: string;
}): string {
  const {
    hasNPCSpoken, lastNPCMsg, recentHistory,
    scenarioTitle, scenarioCategory, scenarioDesc, environmentalCue,
    npcPersona, learnerPersona, interactionRules, scriptNodes, endings,
    runtime, userLevel,
  } = params;

  // Format the script beats as a numbered list so LLM can reference them.
  const scriptBlock = scriptNodes
    .map((n, i) => `${i + 1}. ${n.id} (${n.name}): ${n.description}`)
    .join('\n');
  const rulesBlock = interactionRules.map((r, i) => `${i + 1}. ${r}`).join('\n');
  const endingsBlock = endings.map(e => `- ${e.type.toUpperCase()}: ${e.trigger}`).join('\n');

  // Runtime-derived hints about where we are in the script.
  const currentStage = runtime?.currentStage ?? '(not yet started)';
  const pendingSlots = runtime?.pendingSlots ?? [];
  const filledSlots = runtime ? Object.entries(runtime.filledSlots ?? {}) : [];
  const suggestedNpcAction = runtime?.suggestedNpcAction ?? '(unknown)';

  // Identify the "next" script node by index so LLM knows what the NPC
  // is likely to do AFTER the current turn.
  const currentStageIndex = scriptNodes.findIndex(n => n.id === currentStage);
  const upcomingNodes = currentStageIndex >= 0
    ? scriptNodes.slice(currentStageIndex + 1, currentStageIndex + 3)
    : scriptNodes.slice(0, 2);
  const upcomingBlock = upcomingNodes.length
    ? upcomingNodes.map((n, i) => `${i + 1}. ${n.id} (${n.name}): ${n.description}`).join('\n')
    : '(no upcoming nodes — NPC is at the end of the script)';

  if (hasNPCSpoken) {
    return `You are a language coach helping a ${userLevel} English learner respond in a role-played conversation.

## Scenario
Title: ${scenarioTitle}
Category: ${scenarioCategory}
${scenarioDesc ? `Task: ${scenarioDesc}` : ''}
${environmentalCue ? `Setting: ${environmentalCue}` : ''}

## NPC (the role the learner is talking to)
${npcPersona}

## Learner (the user's profile)
${learnerPersona}

## NPC's hard rules (do NOT contradict these when writing hints)
${rulesBlock}

## Script beats the NPC is following (in order)
${scriptBlock}

## Where we are RIGHT NOW in the script
- Current stage: ${currentStage}
- Pending required info from the learner: ${pendingSlots.length > 0 ? pendingSlots.join(', ') : '(none — all slots filled)'}
- Already filled: ${filledSlots.length > 0 ? filledSlots.map(([k, v]) => `${k}=${v}`).join('; ') : '(none)'}
- NPC's next planned action: ${suggestedNpcAction}

## What's coming NEXT after this turn (so hints can prep the learner)
${upcomingBlock}

## Possible endings (for context — the NPC is working toward one of these)
${endingsBlock}

## Recent conversation
${recentHistory || '(no prior turns)'}

## NPC's last message (what the learner needs to respond to)
"${lastNPCMsg}"

## Your task
Generate exactly 3 DIFFERENT English replies the learner could say next. They MUST:
1. Use a DIFFERENT communication strategy each (e.g. assertive / empathetic / creative alternative)
2. Help the learner ADVANCE the script — at least one hint should make progress on the pending slots, not just rephrase the same beat
3. Sound natural in the NPC's voice (don't suggest lines that would break the NPC's hard rules or contradict the NPC's persona)
4. Be grammatically correct, natural, and feasible in this specific scenario
5. If the learner seems stuck on this beat (e.g. only ever handing over the passport), one hint can suggest a slightly larger move that still fits the scenario (asking a follow-up question, volunteering context, etc.)

CRITICAL — do NOT include any example dialogue in your output. Write original replies for this specific scenario.

Return ONLY valid JSON:
{
  "hints": [
    {
      "text": "<English reply, 1-2 sentences>",
      "translation": "<accurate Chinese translation>",
      "style": "<2-4 Chinese chars describing the strategy or tone of THIS reply. Must be a fresh label every turn — do NOT repeat labels from earlier hints, and do NOT copy any predefined category names.>"
    }
  ]
}`;
  }

  // No NPC has spoken yet — the learner needs to initiate.
  return `You are a language coach helping a ${userLevel} English learner START a role-played conversation.

## Scenario
Title: ${scenarioTitle}
Category: ${scenarioCategory}
${scenarioDesc ? `Task: ${scenarioDesc}` : ''}
${environmentalCue ? `Setting: ${environmentalCue}` : ''}

## NPC (the role the learner is about to talk to)
${npcPersona}

## Learner (the user's profile)
${learnerPersona}

## NPC's hard rules
${rulesBlock}

## Script beats the NPC is following (in order) — the NPC will start at the first one
${scriptBlock}

## Your task
Generate exactly 3 DIFFERENT English opening lines the learner could use to start the conversation. They MUST:
1. Use a DIFFERENT approach each (e.g. direct request / casual greeting + request / polite opener)
2. Match the NPC's persona (e.g. don't open with small talk if the NPC is impatient)
3. Help the learner land on the first script beat naturally
4. Be grammatically correct, natural, appropriate for ${userLevel} level

Return ONLY valid JSON:
{
  "hints": [
    {
      "text": "<English opening line, 1 sentence>",
      "translation": "<accurate Chinese translation>",
      "style": "<2-4 Chinese chars describing the strategy or tone of THIS opening. Must be a fresh label every time — do NOT repeat labels from earlier hints, and do NOT copy any predefined category names.>"
    }
  ]
}`;
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
