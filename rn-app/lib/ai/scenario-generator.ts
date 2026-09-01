/**
 * Scenario Generator
 * Generates daily personalized scenario task cards based on user level + interests.
 * Integrates invisible FSRS injection (due words → NPC system prompt).
 *
 * PRD §2.3 + §3.2: Feed dynamic task tiles (10-20 per day)
 *
 * Script-driven schema (2026-09-01):
 *   - npcPersona / learnerPersona / interactionRules / scriptNodes / endings
 *   - Replace the 1-line npcSystemPrompt with a full narrative script so the
 *     NPC has a real character to play, not just a role label.
 *   - taskContract is kept as a fallback (deriveTaskContract still runs)
 *     so any old card without the new fields still works.
 */

import { callAIProxy, callAIProxyStream } from '../api-client';
import { deriveTaskContract, type ScenarioTaskContract } from './conversation-runtime';
import type { CEFRLevel } from '../../types';

export type ScenarioSourceType = 'ai_scenario' | 'video_scene' | 'static_scenario';

export interface StagedScenarioRef {
  id: string;
  sourceType: ScenarioSourceType;
  stagedAt: number;
}

/**
 * Script node — narrative description of one beat in the scene.
 * IMPORTANT: `description` MUST be abstract (约束 + 目标), not example lines.
 * 千问会把 prompt 里的 example 台词当真实选项照抄。
 */
export interface ScriptNode {
  id: string;             // stable snake_case key, e.g. "check_documents"
  name: string;           // short Chinese label, e.g. "检查证件"
  description: string;    // abstract narrative (目标 + 行为边界, NO example dialogue)
  /**
   * Recommended minimum turns the NPC should spend on this stage before
   * transitioning. The runtime does NOT hard-cap this — it's a soft hint
   * surfaced to the LLM via the system prompt so it knows to extend the
   * conversation with sub-beats (follow-up questions, clarifications,
   * micro-pushback) rather than jumping to the next stage after one
   * user reply. Typical values: 2-4.
   */
  minTurns?: number;
}

export interface ScriptEnding {
  type: 'success' | 'failure' | 'branch';
  trigger: string;        // abstract trigger description (not a hard counter)
  npcFinalLine?: string;  // optional literal line; usually omit so Qwen can improvise
  /**
   * When the ending is `branch`, this describes what new storyline the
   * NPC should open. E.g. "open secondary inspection scene with a new
   * officer who asks the same questions in a different order". Branches
   * let the conversation escape a dead-end rather than terminating in
   * a flat success/failure.
   */
  branchSetup?: string;
}

/**
 * ConversationGoal (2026-09-01) — replaces "script stage" with "goal".
 *
 * A goal is a TOPIC to discuss, NOT a stage to perform in order. The NPC
 * is told "you need to cover these N topics" but the ORDER, DEPTH, and
 * TIMING of when to bring each one up is decided by the LLM each turn
 * based on the live conversation state.
 *
 * Static layer: defined in the scenario card. Never changes after
 * generation. The prompt engine surfaces these to the LLM as
 * "you need to discuss these topics" — not as a sequence to follow.
 */
export interface ConversationGoal {
  id: string;                // stable snake_case key, e.g. "verify_purpose"
  name: string;              // short label, e.g. "确认访问目的"
  description: string;       // abstract: what the NPC must eventually know / cover
  /**
   * Optional priority hint. LLM is free to ignore. Higher = more important
   * (NPC should push harder to cover this). Lower = can be skipped if the
   * conversation goes off in a different direction.
   */
  priority?: number;         // 0-3, default 1
  /**
   * Edge cases / real-life frictions to bring up if the learner gives an
   * opening. Optional. NPC can use these to "test" the learner with
   * believable follow-ups.
   */
  edgeCases?: string[];
}

export interface ScenarioCard {
  id: string;
  sourceType?: ScenarioSourceType;
  icon: string;
  category: string;
  level: string;
  title: string;
  desc: string;                // English task description (CEFR-appropriate)
  descZh?: string;            // Chinese translation of desc (pre-generated, no extra API call)
  npcEmoji?: string;           // Avatar emoji for the NPC in sandbox
  npcName?: string;            // NPC's name (e.g. "David", "Officer Chen")
  npcStatus?: string;          // NPC's current state for immersion (e.g. "正低头看手机")
  openingLine?: string;        // NPC's spoken opening (npc_first) — null for user_first
  openingLineZh?: string;      // Chinese translation of openingLine (pre-generated)
  environmentalCue?: string;   // 环境旁白 (user_first only): Chinese scene narration
  environmentalCueEn?: string; // English version of environmentalCue (default display)
  npcSystemPrompt?: string;    // Carries invisible FSRS injection + NPC persona (legacy 1-2 line)
  taskContract?: ScenarioTaskContract;
  userInitiates?: boolean;     // true = user speaks first, environmentalCue shown instead
  modelUrl?: string;           // Live2D model path (assets-relative for Android)

  // ── Script-driven fields (2026-09-01) ────────────────────────────────────
  // If present, npc-chat uses these to build the system prompt. If absent,
  // it falls back to the legacy npcSystemPrompt + deriveTaskContract path.
  npcPersona?: string;            // 3-5 sentences: who they are, mood, behavior pattern
  learnerPersona?: string;        // 2-3 sentences: learner's identity, level, emotional state
  interactionRules?: string[];    // 3-5 hard rules (e.g. "一次只问一个问题")
  scriptNodes?: ScriptNode[];     // ordered narrative beats (legacy — kept for back-compat; new cards should use conversationGoals)
  /**
   * Conversation goals (2026-09-01) — the topics the NPC must cover.
   * Unlike scriptNodes, these are NOT a sequence to follow in order; the
   * LLM decides each turn which to advance, defer, or skip. Prefer this
   * over scriptNodes for new cards. ScriptNode-derived cards fall back
   * to the legacy "ordered stage" behavior.
   */
  conversationGoals?: ConversationGoal[];
  endings?: ScriptEnding[];       // possible endings
}

interface GeneratorInput {
  userLevel: CEFRLevel;
  interests: string[];
  count?: number;
  excludeTitles?: string[];
}

const FALLBACK_SCENARIOS: ScenarioCard[] = [
  { id: 'f1',  icon: '✈️', category: '机场求生',   level: 'B1', title: '航班因天气取消',    desc: 'Ask the gate agent to rebook your flight and get hotel compensation.',     descZh: '向地勤要求改签并索要酒店补偿。',       npcEmoji: '👨‍✈️', openingLine: "I'm sorry, but your flight has been cancelled due to severe weather conditions.", openingLineZh: '非常抱歉，您的航班因恶劣天气已被取消。' },
  { id: 'f2',  icon: '💻', category: '职场与代码', level: 'B2', title: '汇报服务器宕机',    desc: 'Explain a production outage to your boss using technical vocabulary.',       descZh: '用专业词汇向老板说清楚线上事故。',     npcEmoji: '👨‍💼', openingLine: 'What happened to the production server? It\'s been down for 20 minutes!', openingLineZh: '生产服务器发生了什么？已经宕机20分钟了！' },
  { id: 'f3',  icon: '☕', category: '日常点单',   level: 'A2', title: '星巴克高级定制',    desc: 'Order a drink and ask for oat milk instead of regular milk.',              descZh: '把牛奶换成燕麦奶，并要求少冰。',       npcEmoji: '🧑‍🍳', modelUrl: 'models/senko/senko.model3.json', openingLine: 'Hi! Welcome to Starbucks. What can I get for you today?', openingLineZh: '你好！欢迎光临星巴克，请问您要点什么？' },
  { id: 'f4',  icon: '📧', category: '商务沟通',   level: 'C1', title: '高情商催尾款',      desc: 'Follow up on an unpaid invoice politely but firmly without losing your professional image.', descZh: '礼貌又强硬地催账，不失专业感。', npcEmoji: '💼', openingLine: "We haven't processed the payment yet. Let me check with finance.", openingLineZh: '我们还没有处理这笔付款，让我和财务确认一下。' },
  { id: 'f5',  icon: '🏕️', category: '户外生存',   level: 'B1', title: '周末露营计划',      desc: 'Casually invite a friend to go camping this weekend using natural spoken English.', descZh: '如何用地道口语问朋友一起搭帐篷。', npcEmoji: '🧑‍🤝‍🧑', openingLine: 'Hey! Are we doing the camping trip this weekend or what?', openingLineZh: '嘿！我们这个周末去露营吗？' },
  { id: 'f6',  icon: '🏥', category: '海外就医',   level: 'B2', title: '描述过敏症状',      desc: 'Describe your rash and breathing difficulties accurately to a doctor.',     descZh: '如何准确向医生描述皮疹和呼吸困难。',   npcEmoji: '👨‍⚕️', openingLine: "So, what brings you in today? Can you describe your symptoms?", openingLineZh: '您今天来就诊是什么原因？可以描述一下您的症状吗？' },
  { id: 'f7',  icon: '🚗', category: '交通出行',   level: 'A2', title: '确认 Uber 位置',    desc: "Can't find the pickup spot? Call the driver to sort it out.",             descZh: '找不到上车点？和司机电话沟通。',       npcEmoji: '🚗',   openingLine: "Hi, I'm your driver. I'm waiting near the main entrance.", openingLineZh: '你好，我是您的司机，我在正门附近等您。' },
  { id: 'f8',  icon: '🗣️', category: '社交闲聊',   level: 'B2', title: '打破沉默的小聊',    desc: 'Start a conversation with a coworker you barely know in the elevator.',    descZh: '在电梯里遇到不太熟的同事该怎么搭话。', npcEmoji: '🧑‍💼', openingLine: '*awkward silence as the elevator doors close*', openingLineZh: '*电梯门关上，陷入尴尬的沉默*' },
  { id: 'f9',  icon: '🎮', category: '游戏社交',   level: 'B1', title: 'Reddit 游戏热评',   desc: 'Understand gaming slang like "nerf" and "buff" in a rant about a patch.',  descZh: '理解 nerf 和 buff 在语境中的吐槽。',   npcEmoji: '🎮',   openingLine: 'Dude, did you see they just nerfed the damage by 30%? This patch is unplayable!', openingLineZh: '兄弟，你看到了吗，他们刚把伤害削弱了30%？这个版本根本没法玩！' },
  { id: 'f10', icon: '🍔', category: '快餐生存',   level: 'A2', title: 'Drive-thru 得来速', desc: 'Understand a crackly intercom and order a double-patty combo meal.',       descZh: '听懂充满杂音的对讲机，点一份双层套餐。', npcEmoji: '🍔', openingLine: 'Welcome to Burger Palace, what can I get for you today?', openingLineZh: '欢迎光临汉堡宫殿，您要点什么？' },
];

/**
 * Generate today's scenario task cards, injecting FSRS due words into NPC prompts.
 */
export async function generateDailyScenarios(input: GeneratorInput): Promise<ScenarioCard[]> {
  const { userLevel, interests, count = 10 } = input;

  // Difficulty-based ratio: how many scenarios should be user_first
  const userFirstRatio = userLevel === 'A1' || userLevel === 'A2' ? 0.35
    : userLevel === 'B1' || userLevel === 'B2' ? 0.65
    : 0.8; // C1, C2
  const userFirstCount = Math.round(count * userFirstRatio);
  const npcFirstCount = count - userFirstCount;

  const prompt = buildScenarioPrompt(count, userLevel, interests, npcFirstCount, userFirstCount);

  try {
    const result = await callAIProxy({
      type: 'generate-card',
      prompt,
      userLevel,
      maxTokens: 5200,
      systemMessage: 'You are NativeOS, an AI English learning scenario designer. Always respond with valid JSON only, no markdown.',
    });

    if (!result || !Array.isArray(result.scenarios) || result.scenarios.length === 0) {
      return FALLBACK_SCENARIOS.slice(0, count).map(normalizeScenarioCard);
    }

    const seenIds = new Set<string>();
    const cards: ScenarioCard[] = result.scenarios.map((s: any) => {
      let id = s.id || `ai-${Math.random().toString(36).slice(2, 8)}`;
      while (seenIds.has(id)) id = `ai-${Math.random().toString(36).slice(2, 8)}`;
      seenIds.add(id);
      return mapRawToCard(s, id, userLevel);
    });

    return cards.slice(0, count);
  } catch {
    return FALLBACK_SCENARIOS.slice(0, count).map(normalizeScenarioCard);
  }
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

  for (let i = arrayStartIndex + 1; i < partial.length; i++) {
    const char = partial[i];

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
      if (depth === 0) objectStart = i;
      depth += 1;
      continue;
    }

    if (char === '}') {
      depth -= 1;
      if (depth === 0 && objectStart >= 0) {
        objects.push(partial.slice(objectStart, i + 1));
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

/**
 * Streaming variant: same as generateDailyScenarios but calls onCard for each
 * ScenarioCard as soon as it is fully parsed from the stream.
 * Falls back to FALLBACK_SCENARIOS if streaming fails.
 */
export async function generateDailyScenariosStream(
  input: GeneratorInput,
  onCard: (card: ScenarioCard, index: number) => void,
): Promise<ScenarioCard[]> {
  const { userLevel, interests, count = 10, excludeTitles } = input;

  const userFirstRatio = userLevel === 'A1' || userLevel === 'A2' ? 0.35
    : userLevel === 'B1' || userLevel === 'B2' ? 0.65
    : 0.8;
  const userFirstCount = Math.round(count * userFirstRatio);
  const npcFirstCount = count - userFirstCount;

  // If this is a custom query (single free-text description, not a domain tag), use dedicated prompt
  const isCustomQuery = interests.length === 1 && interests[0].length > 10;
  const prompt = isCustomQuery
    ? buildCustomQueryPrompt(count, userLevel, interests[0], npcFirstCount, userFirstCount, undefined)
    : buildScenarioPrompt(count, userLevel, interests, npcFirstCount, userFirstCount, excludeTitles);

  console.log('[ScenarioGenerator] ===== FULL PROMPT =====\n' + prompt + '\n[ScenarioGenerator] ===== END PROMPT =====');

  const seenIds = new Set<string>();
  const allCards: ScenarioCard[] = [];
  let cardIndex = 0;
  let streamFullText = '';
  let enoughCardsResolve: (() => void) | null = null;
  const enoughCardsPromise = new Promise<void>(res => { enoughCardsResolve = res; });

  try {
    console.log('[ScenarioGenerator] stream start', {
      userLevel,
      interests,
      count,
      excludeTitlesCount: excludeTitles?.length ?? 0,
      isCustomQuery,
    });

    const streamPromise = callAIProxyStream(
      {
        type: 'generate-card',
        prompt,
        userLevel,
        maxTokens: 5200,
        systemMessage: 'You are NativeOS, an AI English learning scenario designer. Always respond with valid JSON only, no markdown.',
      },
      (partial) => {
        try {
          const objects = extractScenarioObjectsFromPartial(partial);
          for (let i = cardIndex; i < objects.length; i++) {
            if (allCards.length >= count) {
              enoughCardsResolve?.();
              break;
            }
            try {
              const raw = JSON.parse(objects[i]) as Partial<ScenarioCard>;
              if (!raw.id || !raw.title) continue;
              let id = raw.id;
              while (seenIds.has(id)) id = `ai-${Math.random().toString(36).slice(2, 8)}`;
              seenIds.add(id);
              const card = mapRawToCard(raw, id, userLevel);
              allCards.push(card);
              console.log('[ScenarioGenerator] streamed card parsed', {
                index: allCards.length - 1,
                id: card.id,
                title: card.title,
              });
              onCard(card, allCards.length - 1);
              cardIndex = i + 1;
              if (allCards.length >= count) enoughCardsResolve?.();
            } catch { /* incomplete object */ }
          }
        } catch { /* parsing in progress */ }
      },
    );

    const raceWinner = await Promise.race([
      streamPromise.then((text) => {
        streamFullText = text;
        return 'stream_complete' as const;
      }),
      enoughCardsPromise.then(() => 'enough_cards' as const),
    ]);

    console.log('[ScenarioGenerator] stream race settled', {
      raceWinner,
      streamedCards: allCards.length,
    });

    try {
      if (!streamFullText) {
        streamFullText = await streamPromise;
      }
      const parsed = JSON.parse(streamFullText);
      if (Array.isArray(parsed?.scenarios)) {
        for (const s of parsed.scenarios) {
          if (allCards.length >= count) break;
          if (!s.id || seenIds.has(s.id)) continue;
          let id = s.id;
          while (seenIds.has(id)) id = `ai-${Math.random().toString(36).slice(2, 8)}`;
          seenIds.add(id);
          const card = mapRawToCard(s, id, userLevel);
          allCards.push(card);
          console.log('[ScenarioGenerator] final parse card appended', {
            index: allCards.length - 1,
            id: card.id,
            title: card.title,
          });
          onCard(card, allCards.length - 1);
        }
      }
    } catch (error) {
      console.warn('[ScenarioGenerator] final parse failed', {
        streamedCards: allCards.length,
        fullTextLength: streamFullText.length,
        error: error instanceof Error ? error.message : 'unknown',
      });
    }

    console.log('[ScenarioGenerator] stream finished', {
      totalCards: allCards.length,
      usedFallback: allCards.length === 0,
    });

    return allCards.length > 0 ? allCards.slice(0, count) : FALLBACK_SCENARIOS.slice(0, count).map(normalizeScenarioCard);
  } catch (error) {
    console.warn('[ScenarioGenerator] stream failed, using fallback', {
      error: error instanceof Error ? error.message : 'unknown',
    });
    return FALLBACK_SCENARIOS.slice(0, count).map(normalizeScenarioCard);
  }
}

function normalizeScenarioInterests(interests: string[]): string[] {
  return Array.from(new Set(interests.map((item) => item.trim()).filter(Boolean)));
}

function allocateScenarioCounts(interests: string[], count: number): Array<{ interest: string; count: number }> {
  const normalized = normalizeScenarioInterests(interests);
  if (normalized.length === 0) {
    return [];
  }
  const base = Math.floor(count / normalized.length);
  const remainder = count % normalized.length;
  return normalized
    .map((interest, index) => ({
      interest,
      count: base + (index < remainder ? 1 : 0),
    }))
    .filter((item) => item.count > 0);
}

function buildInterestAllocationBlock(interests: string[], count: number): string {
  const allocation = allocateScenarioCounts(interests, count);
  if (allocation.length === 0) {
    return '';
  }
  return `

## Interest Allocation
Distribute the ${count} scenarios EXACTLY according to this plan:
${allocation.map((item) => `- ${item.interest}: exactly ${item.count} scenarios`).join('\n')}

CRITICAL:
- Total scenario count must remain exactly ${count}.
- Each listed interest must appear exactly the number of times assigned above.
- Create distinct sub-situations within each interest, not wording-only variants.`;
}

/**
 * Shared prompt builder for both streaming and non-streaming generators.
 */
function buildScenarioPrompt(
  count: number,
  userLevel: string,
  interests: string[],
  npcFirstCount: number,
  userFirstCount: number,
  excludeTitles?: string[],
): string {
  const normalizedInterests = normalizeScenarioInterests(interests);
  const excludeBlock = excludeTitles && excludeTitles.length > 0
    ? `\n- Already shown (DO NOT repeat these topics or close variants): ${excludeTitles.map(t => `「${t}」`).join(', ')}`
    : '';
  const allocationBlock = buildInterestAllocationBlock(normalizedInterests, count);
  return `You are NativeOS, an immersive English learning scenario designer.
Generate exactly ${count} real-life English practice scenarios for this learner.

User profile:
- CEFR level: ${userLevel}
- Interests/domains: ${normalizedInterests.join(', ') || 'general daily life'}${excludeBlock}${allocationBlock}

## Dual-Initiation Engine
Every scenario belongs to one of two tracks. The track determines exactly which fields are filled.

### Track A — npc_first (${npcFirstCount} scenarios): NPC speaks first
When: The NPC naturally initiates (e.g. shopkeeper greets a customer, receptionist asks how to help).
Field rules:
- userInitiates = false
- openingLine = NPC's first English sentence (grammatically correct, in-character, appropriate to NPC's role)
- openingLineZh = accurate Chinese translation of openingLine
- environmentalCue = null  ← MUST be null, no narration needed
- environmentalCueEn = null  ← MUST be null

### Track B — user_first (${userFirstCount} scenarios): User speaks first
When: The NPC is busy/occupied — user must break the silence to initiate.
Field rules:
- userInitiates = true
- openingLine = null  ← MUST be null, NPC does NOT speak first
- openingLineZh = null  ← MUST be null
- environmentalCue = Chinese-only narration (2-3 sentences): describe the scene vividly, what the NPC is doing, and give the user a subtle hint about how to start. NEVER write English here.
- environmentalCueEn = English-only narration: same content as environmentalCue translated to English, CEFR-appropriate for ${userLevel}. NEVER write Chinese here.

### npcSystemPrompt (both tracks)
1-2 English sentences that:
1. Clearly state the NPC's role (e.g. "You are a stationery shop assistant.")
2. Clearly state the learner's role (e.g. "The learner is a customer who wants to buy tape.")
3. Add scenario-appropriate friction (e.g. "You are slightly busy and ask clarifying questions before helping.")
IMPORTANT: Role assignments MUST be logically consistent with the scenario title and desc. If the scenario is about buying something, the NPC is the seller and the learner is the buyer — unless the title/desc clearly specifies otherwise.

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

**desc** (English ONLY, CEFR-matched):
- A1/A2: very simple (e.g. "Ask for oat milk instead of regular milk.")
- B1/B2: intermediate (e.g. "Explain a production outage using technical vocabulary.")
- C1/C2: sophisticated (e.g. "Follow up on an unpaid invoice politely but firmly.")

**descZh**: Chinese translation of desc (≤30 chars).
**npcStatus**: short Chinese phrase describing what NPC is currently doing.

Return ONLY valid JSON, no markdown:
{
  "scenarios": [
    {
      "id": "ai-<unique 6 chars>",
      "icon": "<single basic emoji, NO ZWJ sequences, e.g. 🏥 🚌 ☕ 🎮 not 🧑‍⚕️ 🧑‍💻>",
      "category": "<2-4 Chinese chars>",
      "level": "<A1/A2/B1/B2/C1/C2>",
      "title": "<Chinese title ≤10 chars>",
      "desc": "<English task description, CEFR-appropriate>",
      "descZh": "<Chinese translation of desc ≤30 chars>",
      "npcEmoji": "<single basic emoji, NO ZWJ sequences, e.g. 👮 👩 👨 🤖 not 🧑‍⚕️>",
      "npcName": "<NPC first name, English or Chinese>",
      "npcStatus": "<short Chinese phrase describing what NPC is doing>",
      "userInitiates": <true for user_first, false for npc_first>,
      "openingLine": "<NPC's English opening line, or null>",
      "openingLineZh": "<Chinese translation of openingLine, or null>",
      "environmentalCue": "<Chinese environmental narration, or null>",
      "environmentalCueEn": "<English environmental narration, or null>",
      "npcSystemPrompt": "<1-2 English sentences about NPC role and friction>",
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
        "allowedTopicExtensions": ["<adjacent topic>"] ,
        "outOfScopeTopics": ["<out of scope topic>"],
        "completionCriteria": ["<success condition>"]
      }
    }
  ]
}`;
}

/**
 * Prompt builder for free-text custom queries (e.g. "我的小狗走丢了，向保安询问").
 * Unlike the domain-based prompt, ALL scenarios must revolve around the described scene.
 *
 * scriptSchema (optional): when provided, the generator treats this as a THEME
 * and generates ${count} DIFFERENT variants of the same theme — each with a
 * distinct NPC, setting detail, and situational twist. The schema itself
 * contains NO example dialogue (千问会把 example 照抄).
 */
function buildCustomQueryPrompt(
  count: number,
  userLevel: string,
  query: string,
  npcFirstCount: number,
  userFirstCount: number,
  scriptSchema: string | undefined,
): string {
  return `You are NativeOS, an immersive English learning scenario designer.

The learner wants to practice this situation:
「${query}」

Your job: Generate exactly ${count} English conversation practice scenarios.${scriptSchema ? ' These must be DIFFERENT VARIANTS of the same theme — each variant should be the same core scenario but with a unique NPC, setting, and twist.' : ' Every scenario must involve the same core situation described above, but approach it from different angles, different NPCs, or different stages of the interaction.'}
${scriptSchema ? '\n' + scriptSchema + '\n' : ''}
User profile:
- CEFR level: ${userLevel}

## Dual-Initiation Engine
Every scenario belongs to one of two tracks:

### Track A — npc_first (${npcFirstCount} scenarios): NPC speaks first
- userInitiates = false
- openingLine = NPC's first English sentence (in-character, original)
- openingLineZh = accurate Chinese translation of openingLine
- environmentalCue = null
- environmentalCueEn = null

### Track B — user_first (${userFirstCount} scenarios): User speaks first
- userInitiates = true
- openingLine = null
- openingLineZh = null
- environmentalCue = Chinese-only narration (2-3 sentences): describe the scene vividly
- environmentalCueEn = English-only narration: same content as environmentalCue in English

### Script-Driven Fields (both tracks, 2026-09-01 schema with depth upgrade)
**MANDATORY — response is INVALID if any of these 5 fields is missing or empty.**
The runtime detects missing fields and falls back to a worse experience; the
scenario will feel "dry" and the NPC will parrot a 1-line reply. You MUST
populate all 5 for EVERY scenario. The NPC will use these as their "character
sheet" to play the role. Write them as if directing an actor.

**Depth requirements (CRITICAL — fix the "1-2 turn then done" problem):**
- **npcPersona** (5-8 sentences): NOT a role label. A BEHAVIOR MODEL. Include:
  WHO (1-2 sentences), CURRENT STATE (fatigued? rushed? curious?), then 3-5
  concrete "When X happens, the NPC does Y" behavior patterns. Generic
  descriptions like "You are a helpful person" are REJECTED.
- **learnerPersona** (2-3 sentences): The learner's identity, language level,
  emotional state, and motivation in this scenario. Write in English.
- **interactionRules** (array of 5-8 short rules): MUST include at least these
  three "depth" rules:
    - "After the learner answers, ask 1-2 follow-up sub-beat questions before moving on"
    - "Bridge naturally between script stages — never say 'next question' or similar meta-commentary"
    - "If the learner says thanks/ok/that's-all, do NOT close — add a 'By the way...' or 'Wait, one more...' angle"
  Plus 2-5 scenario-specific rules (ask one question per turn, speak English only, etc.).
- **conversationGoals** (array of 3-6 goals, NEW 2026-09-01 model — REPLACES
  the old "scriptNodes in order" thinking): These are TOPICS the NPC must
  eventually cover, NOT a sequence to follow. The LLM runs an agent loop
  each turn and decides WHEN to dig deeper, WHEN to advance, WHEN to
  handle friction. Each goal has:
  - id: snake_case key
  - name: short label
  - description: 1-2 sentences describing what the NPC must eventually
    know / cover. **DO NOT write sub-beats.** The LLM decides the rhythm
    per turn.
  - priority: 0-3 (default 1). Higher = more important, NPC pushes harder
    to cover it. Lower = can be skipped if the conversation goes elsewhere.
  - edgeCases: array of 1-3 realistic frictions the NPC can use to test
    the learner, e.g. "Learner fumbles searching for passport" or
    "Learner says 'in my bag' without specifying which" or "Learner
    contradicts an earlier answer".
  CRITICAL: DO NOT write example dialogue in any field. DO NOT write
  sub-beats. Just describe the goal's topic and 1-3 edge cases. The LLM
  will improvise everything else per turn.
- **endings** (array of 2-3 endings): Each has {type, trigger, npcFinalLine,
  branchSetup?}.
  - type: 'success' | 'failure' | 'branch'
  - trigger: abstract condition (not a hard counter)
  - npcFinalLine: leave null — the NPC will improvise
  - For 'branch' type, branchSetup is REQUIRED: describe the new storyline
    the NPC opens. Include a branch when the scenario naturally has one
    (customs, police, interview, etc.) so the conversation can escape a
    dead-end.

### Legacy taskContract (optional, for fallback)
You MAY also return the legacy taskContract block. If you do, keep it brief
(1-2 required slots). The runtime falls back to it only if the new script
fields are missing or malformed.

## Other field rules
**desc**: English task description, CEFR-matched for ${userLevel}.
**descZh**: Chinese translation of desc (≤30 chars).
**category**: 2-4 Chinese chars summarizing this scenario variant.
**npcStatus**: short Chinese phrase for what NPC is doing.

## 千问 DIVERSITY CHECKLIST (read carefully before generating)
The model is Qwen, which tends to copy example patterns. To force diversity:
1. NPC names: do NOT reuse names across variants. Use culturally appropriate names.
2. Opening lines: structure-wise different (e.g. one is a question, one is a
   statement, one is a request). NOT all "Hi, can I see your X?"
3. Setting details: vary time of day, queue length, weather, season, mood.
4. Twists: each variant should have at least one unique complication or surprise.
5. Do NOT include any example dialogue in the scriptNodes descriptions.

CRITICAL: ALL ${count} scenarios MUST be about the situation: 「${query}」

Return ONLY valid JSON, no markdown:
{
  "scenarios": [
    {
      "id": "ai-<unique 6 chars>",
      "icon": "<single basic emoji, NO ZWJ sequences, e.g. 🏥 🚌 ☕ 🎮 not 🧑‍⚕️ 🧑‍💻>",
      "category": "<2-4 Chinese chars>",
      "level": "<A1/A2/B1/B2/C1/C2>",
      "title": "<Chinese title ≤10 chars>",
      "desc": "<English task description>",
      "descZh": "<Chinese translation of desc ≤30 chars>",
      "npcEmoji": "<single basic emoji, NO ZWJ sequences, e.g. 👮 👩 👨 🤖 not 🧑‍⚕️>",
      "npcName": "<NPC first name>",
      "npcStatus": "<short Chinese phrase>",
      "userInitiates": <true or false>,
      "openingLine": "<NPC's English opening, or null>",
      "openingLineZh": "<Chinese translation, or null>",
      "environmentalCue": "<Chinese narration, or null>",
      "environmentalCueEn": "<English narration, or null>",
      "npcSystemPrompt": "<1-2 English sentences (legacy, optional)>",
      "npcPersona": "<5-8 English sentences: BEHAVIOR MODEL with 3-5 concrete 'When X, the NPC does Y' patterns, NOT a generic role label>",
      "learnerPersona": "<2-3 English sentences>",
      "interactionRules": ["<rule>", "<rule>", "<MUST include the 3 depth rules: ask 1-2 follow-up sub-beats, bridge naturally, refuse to close on thanks/ok>"],
      "conversationGoals": [
        {
          "id": "<snake_case_id>",
          "name": "<short Chinese label>",
          "description": "<1-2 sentences: what the NPC must eventually know / cover. DO NOT write sub-beats.>",
          "priority": 2,
          "edgeCases": ["<1-3 realistic frictions the NPC can use to test the learner, e.g. 'Learner fumbles searching for passport' or 'Learner contradicts earlier answer'>"]
        }
      ],
      "endings": [
        {
          "type": "success|failure|branch",
          "trigger": "<abstract condition>",
          "npcFinalLine": null,
          "branchSetup": "<required when type=branch: describe the new storyline the NPC opens>"
        }
      ],
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

/**
 * Safe emoji pool — all verified single-codepoint emojis that render correctly
 * on Android 9+ (API 28+). Grouped by rough scenario category for contextual fallback.
 */
const SAFE_EMOJI_POOL = [
  '🏥','🏪','🏨','🏦','🏫','🏬','🏢','🏠','🏙','🚉',
  '🚌','🚕','✈️','🚂','🚢','🚗','🛒','🎓','🎯','🎮',
  '🎵','🎬','📱','💻','📚','📋','📝','📦','📧','📞',
  '☕','🍜','🍕','🍔','🍱','�','🍣','🍦','🎂','🥤',
  '💊','🩺','💉','🔬','🧪','🏋','🚴','⚽','🏊','🤸',
  '👮','👩','👨','👴','👵','👶','🤖','👼','�','�',
  '💼','🔑','📅','🗂','💳','💰','🧾','📊','🔧','⚙️',
  '🌍','🗺','🌐','🏔','🌊','🌴','🌸','🍀','☀️','🌙',
];

/**
 * Returns the emoji if it is a simple renderable codepoint (no ZWJ, no multi-char
 * skin-tone / gender sequences). Otherwise returns a random safe emoji from the pool.
 */
function safeEmoji(raw: string | undefined, fallback: string): string {
  if (!raw || !raw.trim()) return fallback;
  // Get the first grapheme cluster
  let first: string;
  try {
    const seg = new (Intl as any).Segmenter();
    first = [...seg.segment(raw.trim())][0]?.segment ?? raw.trim();
  } catch {
    first = [...raw.trim()][0] ?? fallback;
  }
  // Reject if it contains ZWJ (U+200D), skin-tone modifiers (U+1F3FB-1F3FF),
  // or variation selectors (U+FE0F), or is longer than 2 JS chars (surrogate pair = fine, 3+ = complex)
  const hasZWJ = first.includes('\u200D');
  const hasSkinTone = /[\u{1F3FB}-\u{1F3FF}]/u.test(first);
  const codepoints = [...first];
  const isComplex = hasZWJ || hasSkinTone || codepoints.length > 2;
  if (isComplex) {
    // Use base codepoint if it's a recognisable emoji, otherwise pick from safe pool
    const base = codepoints[0];
    // Check if base codepoint is itself in the emoji range
    const cp = base.codePointAt(0) ?? 0;
    const isEmojiRange = (cp >= 0x1F300 && cp <= 0x1FAFF) || (cp >= 0x2600 && cp <= 0x27BF);
    return isEmojiRange ? base : SAFE_EMOJI_POOL[Math.floor(Math.random() * SAFE_EMOJI_POOL.length)];
  }
  return first;
}

/**
 * Map a raw AI-returned scenario object to a ScenarioCard.
 */
function mapRawToCard(s: any, id: string, userLevel: string): ScenarioCard {
  const userInitiates: boolean = s.userInitiates ?? false;

  // Enforce field consistency: AI sometimes fills the wrong track's fields.
  // Track A (npc_first): openingLine must be set, environmentalCue must be null.
  // Track B (user_first): environmentalCue must be set, openingLine must be null.
  const openingLine = userInitiates ? undefined : (s.openingLine || undefined);
  const openingLineZh = userInitiates ? undefined : (s.openingLineZh || undefined);
  const environmentalCue = userInitiates ? (s.environmentalCue || undefined) : undefined;
  const environmentalCueEn = userInitiates ? (s.environmentalCueEn || undefined) : undefined;

  // ── Parse new script-driven fields (2026-09-01) ─────────────────────────
  // Be defensive: AI may return partial / malformed data. Validate shape and
  // log what we got vs what we used. The post-validation is intentionally
  // per-field so we can pinpoint exactly which field the LLM failed to fill.
  const npcPersona = typeof s.npcPersona === 'string' && s.npcPersona.trim() ? s.npcPersona.trim() : undefined;
  const learnerPersona = typeof s.learnerPersona === 'string' && s.learnerPersona.trim() ? s.learnerPersona.trim() : undefined;
  const interactionRules = Array.isArray(s.interactionRules)
    ? (s.interactionRules as unknown[])
        .filter((r): r is string => typeof r === 'string' && r.trim().length > 0)
        .map(r => r.trim())
    : undefined;
  const scriptNodes = Array.isArray(s.scriptNodes)
    ? s.scriptNodes
        .filter((n: any) => n && typeof n.id === 'string' && typeof n.description === 'string')
        .map((n: any) => ({
          id: n.id,
          name: typeof n.name === 'string' ? n.name : n.id,
          description: n.description,
        }))
    : undefined;
  const endings = Array.isArray(s.endings)
    ? s.endings
        .filter((e: any) => e && (e.type === 'success' || e.type === 'failure' || e.type === 'branch'))
        .map((e: any) => ({
          type: e.type,
          trigger: typeof e.trigger === 'string' ? e.trigger : '',
          npcFinalLine: typeof e.npcFinalLine === 'string' && e.npcFinalLine.trim() ? e.npcFinalLine : undefined,
        }))
    : undefined;

  const hasScriptData = Boolean(npcPersona && learnerPersona && interactionRules && scriptNodes && scriptNodes.length > 0 && endings);

  // Post-validation: log EXACTLY which field is missing so we can spot
  // LLM under-fill at a glance. `level` is one of "ok" (5/5), "partial"
  // (some but not all), or "empty" (none of the 5).
  const missingFields: string[] = [];
  if (!npcPersona) missingFields.push('npcPersona');
  if (!learnerPersona) missingFields.push('learnerPersona');
  if (!interactionRules || interactionRules.length === 0) missingFields.push('interactionRules');
  if (!scriptNodes || scriptNodes.length === 0) missingFields.push('scriptNodes');
  if (!endings || endings.length === 0) missingFields.push('endings');

  const completeness = !hasScriptData && missingFields.length === 5
    ? 'empty'
    : hasScriptData
      ? 'ok'
      : 'partial';

  if (completeness !== 'ok') {
    // Loud warn so logcat | grep "ScriptIncomplete" surfaces failures fast.
    console.warn('[ScenarioGenerator] ScriptIncomplete', {
      id,
      completeness,
      missingFields,
      npcPersonaPresent: !!npcPersona,
      learnerPersonaPresent: !!learnerPersona,
      interactionRulesCount: interactionRules?.length ?? 0,
      scriptNodesCount: scriptNodes?.length ?? 0,
      endingsCount: endings?.length ?? 0,
    });
  } else {
    console.log('[ScenarioGenerator] mapRawToCard parsed (script path OK)', {
      id,
      npcPersonaLen: npcPersona!.length,
      learnerPersonaLen: learnerPersona!.length,
      interactionRulesCount: interactionRules!.length,
      scriptNodesCount: scriptNodes!.length,
      endingsCount: endings!.length,
    });
  }

  return {
    id,
    sourceType: 'ai_scenario',
    icon: safeEmoji(s.icon, '🎯'),
    category: s.category || '通用',
    level: s.level || userLevel,
    title: s.title || '未命名场景',
    desc: s.desc || '',
    descZh: s.descZh || undefined,
    npcEmoji: safeEmoji(s.npcEmoji, '🤖'),
    npcName: s.npcName || '',
    npcStatus: s.npcStatus || '',
    openingLine,
    openingLineZh,
    environmentalCue,
    environmentalCueEn,
    npcSystemPrompt: s.npcSystemPrompt || '',
    taskContract: deriveTaskContract({
      title: s.title || '未命名场景',
      desc: s.desc || '',
      category: s.category || '通用',
      npcName: s.npcName || '',
      npcStatus: s.npcStatus || '',
      npcSystemPrompt: s.npcSystemPrompt || '',
      openingLine,
      environmentalCue,
      environmentalCueEn,
    }, s.taskContract),
    userInitiates,
    // New script fields — only set if AI provided them; otherwise the runtime
    // falls back to the legacy npcSystemPrompt + deriveTaskContract path.
    ...(npcPersona ? { npcPersona } : {}),
    ...(learnerPersona ? { learnerPersona } : {}),
    ...(interactionRules ? { interactionRules } : {}),
    ...(scriptNodes ? { scriptNodes } : {}),
    ...(endings ? { endings } : {}),
  };
}

/**
 * Attach the FSRS injection as npcSystemPrompt to each card.
 * The sandbox will read this when initializing the NPC.
 */
function attachInjection(cards: ScenarioCard[], injection: string): ScenarioCard[] {
  const normalized = cards.map(normalizeScenarioCard);
  void injection;
  return normalized;
}

/**
 * Lightweight sync fallback — returns pre-baked scenarios instantly (no AI call).
 * Used when the user is offline or AI call is pending.
 */
export function getFallbackScenarios(): ScenarioCard[] {
  return FALLBACK_SCENARIOS.map(normalizeScenarioCard);
}

const STAGED_KEY = 'staged_scenario';
const STAGED_REF_KEY = 'staged_scenario_ref';

function stripLegacyFsrsPrompt(npcSystemPrompt?: string) {
  if (!npcSystemPrompt) return npcSystemPrompt;
  if (!npcSystemPrompt.includes('【强制指令】')) return npcSystemPrompt;

  const strippedPrompt = npcSystemPrompt
    .replace(/\n*【强制指令】在本次对话中，请自然地使用以下词汇向用户提问或刁难，测试其反应：[^。]*。?/g, '')
    .replace(/\n*【强制指令】在本次对话中，请自然地将以下词汇融入对话来测试用户（语义必须与"[^"]*"场景契合）：[^。]*。?/g, '')
    .trim();

  console.warn('[ScenarioGenerator] stripped legacy FSRS prompt from staged scenario', {
    beforePreview: npcSystemPrompt.slice(0, 200),
    afterPreview: strippedPrompt.slice(0, 200),
  });

  return strippedPrompt;
}

function normalizeScenarioCard(card: ScenarioCard): ScenarioCard {
  const strippedNpcSystemPrompt = stripLegacyFsrsPrompt(card.npcSystemPrompt);
  return {
    ...card,
    npcSystemPrompt: strippedNpcSystemPrompt,
    taskContract: deriveTaskContract({
      title: card.title,
      desc: card.desc,
      category: card.category,
      npcName: card.npcName,
      npcStatus: card.npcStatus,
      npcSystemPrompt: strippedNpcSystemPrompt,
      openingLine: card.openingLine,
      environmentalCue: card.environmentalCue,
      environmentalCueEn: card.environmentalCueEn,
    }, card.taskContract),
    sourceType: card.sourceType || 'ai_scenario',
  };
}

/**
 * Stage a ScenarioCard before navigating to /scenario/[id].
 * The scenario screen reads this on mount to get full card data.
 */
export async function selectScenario(card: ScenarioCard): Promise<void> {
  try {
    const AsyncStorage = (await import('@react-native-async-storage/async-storage')).default;
    const normalized = normalizeScenarioCard(card);
    const ref: StagedScenarioRef = {
      id: normalized.id,
      sourceType: normalized.sourceType || 'ai_scenario',
      stagedAt: Date.now(),
    };
    console.log('[ScenarioGenerator] selectScenario staging', {
      id: normalized.id,
      sourceType: ref.sourceType,
      title: normalized.title,
      hasOpeningLine: !!normalized.openingLine,
      hasPrompt: !!normalized.npcSystemPrompt,
    });
    await Promise.all([
      AsyncStorage.setItem(STAGED_KEY, JSON.stringify(normalized)),
      AsyncStorage.setItem(STAGED_REF_KEY, JSON.stringify(ref)),
    ]);
    console.log('[ScenarioGenerator] selectScenario staged successfully', {
      id: normalized.id,
      sourceType: ref.sourceType,
    });
  } catch { /* non-fatal */ }
}

/**
 * Read the staged ScenarioCard. Returns null if nothing was staged.
 */
export async function getSelectedScenario(expectedId?: string): Promise<ScenarioCard | null> {
  try {
    const AsyncStorage = (await import('@react-native-async-storage/async-storage')).default;
    const raw = await AsyncStorage.getItem(STAGED_KEY);
    if (!raw) return null;
    const parsed = normalizeScenarioCard(JSON.parse(raw) as ScenarioCard);
    console.log('[ScenarioGenerator] getSelectedScenario loaded', {
      expectedId,
      actualId: parsed.id,
      sourceType: parsed.sourceType,
      title: parsed.title,
    });
    if (expectedId && parsed.id !== expectedId) return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function getSelectedScenarioRef(expectedId?: string): Promise<StagedScenarioRef | null> {
  try {
    const AsyncStorage = (await import('@react-native-async-storage/async-storage')).default;
    const raw = await AsyncStorage.getItem(STAGED_REF_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StagedScenarioRef;
    if (expectedId && parsed.id !== expectedId) return null;
    return parsed;
  } catch {
    return null;
  }
}
