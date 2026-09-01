/**
 * Script Backfill (2026-09-01)
 *
 * 老场景（没有 5 字段的）首次被用户打开时，异步调一次 LLM 把它们升级成
 * script-driven 5 字段。升级结果存回 AsyncStorage，下次不再重做。
 *
 * 为什么需要这个？
 * - 大部分老话题来自 Supabase 预生成（mapSupabaseRowToScenarioCard），
 *   它们没有 npcPersona / scriptNodes / endings 等字段。
 * - 用户已经在 home 上加了这些话题，期望"打开后体验跟新生成的一样"。
 * - 不能批量 SQL migrate（需要 LLM 生成内容）。
 * - lazy backfill：第一次打开时补全，体感是"打开老话题瞬间有点慢，
 *   之后立刻是新的深度体验"。
 */

import { callAIProxy } from '../api-client';
import type { ScenarioCard, ScriptNode, ScriptEnding } from './scenario-generator';

export interface BackfillResult {
  npcPersona?: string;
  learnerPersona?: string;
  interactionRules?: string[];
  // 2026-09-01: prefer conversationGoals (new, agent-loop) over scriptNodes (legacy)
  conversationGoals?: Array<{ id: string; name: string; description: string; priority?: number; edgeCases?: string[] }>;
  scriptNodes?: ScriptNode[];
  endings?: ScriptEnding[];
  /** LLM 是否真的返回了所有 5 字段 */
  success: boolean;
  /** 失败原因（用于日志） */
  reason?: string;
  /** 实际耗时 */
  elapsedMs: number;
}

/**
 * 检测一个 card 是否是「老卡」（缺 5 字段）
 */
export function isLegacyScriptCard(card: Partial<ScenarioCard> | null | undefined): boolean {
  if (!card) return true;
  return !(
    card.npcPersona && card.npcPersona.trim().length > 0 &&
    card.learnerPersona && card.learnerPersona.trim().length > 0 &&
    Array.isArray(card.interactionRules) && card.interactionRules.length > 0 &&
    Array.isArray(card.scriptNodes) && card.scriptNodes.length > 0 &&
    Array.isArray(card.endings) && card.endings.length > 0
  );
}

/**
 * 调 LLM 把 legacy card 补全 5 字段。
 *
 * 输入：老 card（至少有 title/desc/category/npcName/openingLine 等基础字段）
 * 输出：5 字段 JSON，失败返回 success: false
 */
export async function backfillScriptFields(
  card: Partial<ScenarioCard>,
): Promise<BackfillResult> {
  const t0 = Date.now();

  // 防御：老 card 必须有基本字段，否则 backfill 没意义
  if (!card.title || !card.npcName) {
    console.warn('[ScriptBackfill] 卡缺少基本字段, 跳过', { id: card.id, hasTitle: !!card.title, hasNpcName: !!card.npcName });
    return { success: false, reason: 'missing_basic_fields', elapsedMs: Date.now() - t0 };
  }

  const prompt = buildBackfillPrompt(card);

  try {
    console.log('[ScriptBackfill] 调用 LLM 补全 5 字段', {
      id: card.id,
      title: card.title,
      npcName: card.npcName,
      promptLen: prompt.length,
    });

    const result = await callAIProxy({
      type: 'generate-card', // reuse the JSON-output card-generation path
      prompt,
      userLevel: 'B1',
      // 2026-09-01 depth upgrade: 5 fields now require ~1100-1800 tokens
      // of output (5-8 sentence persona, sub-beat lists, branch endings).
      // Bumped from 1500 to 3000 to avoid JSON truncation on long persona.
      maxTokens: 3000,
      systemMessage: 'You are an expert at upgrading legacy language-learning scenarios into rich, character-driven scripts with deep conversation dynamics. Always respond with valid JSON only, no markdown.',
    });

    if (!result || typeof result !== 'object') {
      console.warn('[ScriptBackfill] LLM 返回非对象', { id: card.id, resultType: typeof result });
      return { success: false, reason: 'llm_returned_non_object', elapsedMs: Date.now() - t0 };
    }

    // 严格校验 5 字段
    const npcPersona = typeof result.npcPersona === 'string' && result.npcPersona.trim()
      ? result.npcPersona.trim() : undefined;
    const learnerPersona = typeof result.learnerPersona === 'string' && result.learnerPersona.trim()
      ? result.learnerPersona.trim() : undefined;
    const interactionRules = Array.isArray(result.interactionRules)
      ? (result.interactionRules as unknown[]).filter((r): r is string => typeof r === 'string' && r.trim().length > 0).map(r => r.trim())
      : undefined;
    // 2026-09-01: conversationGoals (new) — preferred over scriptNodes (legacy).
    const conversationGoals = Array.isArray(result.conversationGoals)
      ? (result.conversationGoals as any[])
          .filter((g: any) => g && typeof g.id === 'string' && typeof g.description === 'string')
          .map((g: any) => ({
            id: g.id,
            name: typeof g.name === 'string' ? g.name : g.id,
            description: g.description,
            priority: typeof g.priority === 'number' ? g.priority : 1,
            edgeCases: Array.isArray(g.edgeCases) ? g.edgeCases.filter((s: any) => typeof s === 'string') : undefined,
          }))
      : undefined;
    // Legacy scriptNodes — kept for back-compat. If conversationGoals is
    // present, scriptNodes is NOT required.
    const scriptNodes = Array.isArray(result.scriptNodes)
      ? (result.scriptNodes as any[])
          .filter((n: any) => n && typeof n.id === 'string' && typeof n.description === 'string')
          .map((n: any) => ({
            id: n.id,
            name: typeof n.name === 'string' ? n.name : n.id,
            description: n.description,
          }))
      : undefined;
    const endings = Array.isArray(result.endings)
      ? (result.endings as any[])
          .filter((e: any) => e && (e.type === 'success' || e.type === 'failure' || e.type === 'branch'))
          .map((e: any) => ({
            type: e.type,
            trigger: typeof e.trigger === 'string' ? e.trigger : '',
            npcFinalLine: typeof e.npcFinalLine === 'string' && e.npcFinalLine.trim() ? e.npcFinalLine : undefined,
            branchSetup: typeof e.branchSetup === 'string' ? e.branchSetup : undefined,
          }))
      : undefined;

    // Accept if EITHER conversationGoals (new) or scriptNodes (legacy) is present.
    const missing: string[] = [];
    if (!npcPersona) missing.push('npcPersona');
    if (!learnerPersona) missing.push('learnerPersona');
    if (!interactionRules || interactionRules.length === 0) missing.push('interactionRules');
    if (!endings || endings.length === 0) missing.push('endings');
    if (!conversationGoals?.length && !scriptNodes?.length) {
      missing.push('conversationGoals or scriptNodes');
    }

    if (missing.length > 0) {
      console.warn('[ScriptBackfill] LLM 返回字段不全', {
        id: card.id,
        missing,
        npcPersonaLen: npcPersona?.length ?? 0,
        learnerPersonaLen: learnerPersona?.length ?? 0,
        interactionRulesCount: interactionRules?.length ?? 0,
        conversationGoalsCount: conversationGoals?.length ?? 0,
        scriptNodesCount: scriptNodes?.length ?? 0,
        endingsCount: endings?.length ?? 0,
        elapsedMs: Date.now() - t0,
      });
      return { success: false, reason: `missing_fields:${missing.join(',')}`, elapsedMs: Date.now() - t0 };
    }

    console.log('[ScriptBackfill] 补全成功', {
      id: card.id,
      npcPersonaLen: npcPersona!.length,
      learnerPersonaLen: learnerPersona!.length,
      interactionRulesCount: interactionRules!.length,
      conversationGoalsCount: conversationGoals?.length ?? 0,
      scriptNodesCount: scriptNodes?.length ?? 0,
      endingsCount: endings!.length,
      elapsedMs: Date.now() - t0,
      promptPath: conversationGoals?.length ? 'agent-loop (new)' : 'script-driven (legacy)',
    });

    return {
      npcPersona,
      learnerPersona,
      interactionRules,
      conversationGoals,
      scriptNodes: scriptNodes && !conversationGoals ? scriptNodes : undefined, // only set legacy if no new
      endings,
      success: true,
      elapsedMs: Date.now() - t0,
    };
  } catch (e) {
    console.error('[ScriptBackfill] LLM 调用失败', { id: card.id, error: e instanceof Error ? e.message : 'unknown' });
    return { success: false, reason: 'llm_call_failed', elapsedMs: Date.now() - t0 };
  }
}

/**
 * 构造 backfill prompt
 */
function buildBackfillPrompt(card: Partial<ScenarioCard>): string {
  const {
    title = '(unknown)',
    desc = '',
    category = '综合',
    npcName = 'NPC',
    npcStatus,
    openingLine,
    environmentalCueEn,
    npcSystemPrompt,
  } = card;

  // 把 taskContract 序列化（如果有），给 LLM 更多上下文
  const taskContractSummary = card.taskContract
    ? `Existing task contract objective: ${card.taskContract.objective || '(none)'}\n` +
      `Required slots: ${card.taskContract.requiredSlots?.map(s => `${s.key}=${s.label} (${s.required ? 'required' : 'optional'})`).join('; ') || '(none)'}\n` +
      `Completion criteria: ${card.taskContract.completionCriteria?.join('; ') || '(none)'}`
    : 'No task contract available.';

  return `You are upgrading a legacy language-learning scenario into a DEEP, character-driven script (2026-09-01 schema with conversation-depth upgrade).

The goal is to fix a common product problem: AI conversation practice that ends after 1-2 user replies because the NPC has no "depth" — no behavior model, no sub-beats, no follow-up questions, no natural stage transitions. Your job is to make this NPC feel like a real person who has more to ask, not a checklist.

## Legacy Scenario Data
Title: ${title}
Category: ${category}
NPC Name: ${npcName}
${npcStatus ? `NPC status: ${npcStatus}` : ''}
${desc ? `Task description: ${desc}` : ''}
${openingLine ? `NPC opening line: "${openingLine}"` : ''}
${environmentalCueEn ? `Scene cue: ${environmentalCueEn}` : ''}
${npcSystemPrompt ? `Legacy NPC role: ${npcSystemPrompt}` : ''}

${taskContractSummary}

## Your Task
Generate the 5 script-driven fields. Each field has SPECIFIC requirements below — read carefully.

## Field Requirements (CRITICAL — response is INVALID if any field misses these)

### 1. npcPersona (5-8 sentences in English)
This is NOT a role label. It's a BEHAVIOR MODEL — concrete actions the NPC will take, not abstract traits. Include:
- WHO they are (1-2 sentences)
- Their CURRENT STATE (fatigued? rushed? curious? bored?)
- 3-5 SPECIFIC BEHAVIOR PATTERNS written as concrete "When X happens, the NPC does Y" rules. Example TYPES (DO NOT copy these — write your own for THIS scenario):
  - "When the learner is nervous, the NPC slightly slows down their speech but doesn't show obvious concern"
  - "When the learner answers in their native language, the NPC says 'Excuse me?' in a low tone and repeats the question word-for-word"
  - "When the learner's answer is clear and complete, the NPC quickly moves to the next question without lingering"
- Their language STYLE (short? elaborate? uses idioms?)

The NPC should feel like a real person, not a template. Generic personas like "You are a helpful teacher" are REJECTED.

### 2. learnerPersona (2-3 sentences in English)
- The learner's identity (who they are in this scenario)
- Their language level (CEFR or equivalent)
- Their emotional state and any specific motivation (why they're in this scenario)

### 3. interactionRules (array of 5-8 short rules)
Hard rules the NPC must follow. MUST include at least these three "depth" rules:
- "After the learner answers, ask 1-2 follow-up sub-beat questions before moving on"
- "Bridge naturally between script stages — never say 'next question' or similar meta-commentary"
- "If the learner says thanks/ok/that's-all, do NOT close the conversation — add a 'By the way...' or 'Wait, one more...' angle"
Plus 2-5 scenario-specific rules (ask one question per turn, speak English only, etc.)

### 4. conversationGoals (array of 3-6 goals, NOT a sequence — TOPICS to cover)
**THIS IS THE NEW MODEL (2026-09-01). Replace "script with stages" thinking.**

The NPC will run an AGENT LOOP each turn: observe state, think about what to do, then act. conversationGoals are the TOPICS the NPC must eventually cover. The LLM decides each turn:
- WHEN to dig deeper into the current goal (ask follow-up)
- WHEN to move to the next goal (advance, naturally)
- WHEN to handle real-world friction (fumble, contradict, vague)
- WHEN to wrap up

**Do NOT prescribe an order. Do NOT write sub-beats. Just describe what each goal covers.**

EACH goal has {id, name, description, priority, edgeCases}:
- id: snake_case key
- name: short label
- description: 1-2 sentences describing what the NPC must eventually know / cover
- priority: 0-3 (default 1). Higher = more important, NPC pushes harder to cover it
- edgeCases: array of 1-3 realistic frictions the NPC can use to "test" the learner (e.g. "Learner fumbles searching for passport" / "Learner says 'in my bag' without specifying which" / "Learner mentions they have snacks from mom — contradicted earlier answer")

CRITICAL — DO NOT write example dialogue in any field. DO NOT write sub-beats. Just describe the goal's topic and 1-3 edge cases. The LLM will improvise everything else per turn.

### 5. endings (array of 2-3 endings)
Each ending has {type, trigger, npcFinalLine, branchSetup?}.
- type: 'success' | 'failure' | 'branch'
- trigger: abstract condition (not a hard counter)
- npcFinalLine: leave null — the NPC will improvise
- For 'branch' type, branchSetup is REQUIRED: describe the new storyline the NPC should open. E.g. "the NPC suspects the learner, opens a secondary inspection scene with a different officer who re-asks the same questions in a different order"

Branches let the conversation escape a dead-end rather than terminating in a flat success/failure. Include at least 1 branch in your endings array when the scenario naturally has one (customs, police, interview, etc.).

## 千问注意 (Qwen-specific)
- DO NOT copy any example dialogue from this prompt into your output
- Write ORIGINAL npcPersona/learnerPersona that fit THIS specific scenario
- Make the scriptNodes descriptions about GOALS, not specific lines
- 千问 tends to generate 1-line descriptions — push it to 3-5 sub-beats per node, this is the most important fix

Return ONLY this JSON shape, no markdown:
{
  "npcPersona": "...",
  "learnerPersona": "...",
  "interactionRules": ["...", "..."],
  "conversationGoals": [
    { "id": "...", "name": "...", "description": "...", "priority": 2, "edgeCases": ["...", "..."] }
  ],
  "endings": [
    { "type": "success", "trigger": "...", "npcFinalLine": null },
    { "type": "branch", "trigger": "...", "npcFinalLine": null, "branchSetup": "..." }
  ]
}`;
}
