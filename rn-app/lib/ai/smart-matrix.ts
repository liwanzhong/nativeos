/**
 * Smart Matrix Selector
 * Lets Qwen AI decide which of the 11 cognitive matrices best fits the input,
 * then generates the card in a single API call.
 *
 * 11 Matrices:
 *  1. deep-understanding  – etymology + mnemonic (孤立单词、生僻词)
 *  2. context-fill        – cloze from original sentence (有完整语境)
 *  3. collocation         – multi-word chunk (常见搭配、词块)
 *  4. contrast            – binary opposition (易混淆词对)
 *  5. visual              – SVG for concrete nouns (可视化名词)
 *  6. slang-idioms        – cultural/slang context (俚语、网络用语、隐喻)
 *  7. grammar-skeleton    – grammar structure blank (语法结构)
 *  8. cross-domain        – polysemous word across fields (熟词生义)
 *  9. pronunciation       – stress / homograph / minimal-pair (发音重音)
 * 10. register-shift      – formal vs casual register (语体转换)
 * 11. reverse-mapping     – Chinese → English expression (母语逆向)
 */

import { callAIProxy } from '../api-client';
import { CEFRLevel } from '../../types';

export interface SmartCardInput {
  rawInput: string;          // 用户原始输入
  userLevel: CEFRLevel;
  userProfession?: string;
  userInterests?: string[];
  knownWords?: string[];     // 已知词汇 (onboarding收集), 用于 i+1 个性化
}

export interface SmartCardResult {
  matrixType: string;        // 选择的矩阵名称
  matrixIndex: number;       // 1-11
  targetWord: string;        // 核心目标词/短语
  context: string;           // 带 ________ 的填空句 (供 Dojo 复习，兼容旧字段)
  front: string;             // 卡片正面 (Dojo 显示给用户的问题)
  back: string;              // 卡片背面 (答案)
  explanation: string;       // 扩展解析 / 记忆法 / 文化背景
  extra?: Record<string, any>;
}

const MATRIX_DESCRIPTIONS = `
1. deep-understanding: isolated/rare word with no context → etymology breakdown + mnemonic story + cloze example
2. context-fill: full sentence with ONE confusing word → keep original sentence, blank out target word
3. collocation: multi-word chunk / natural phrase pattern → blank out the whole phrase
4. contrast: two similar/confusable words compared (vs / or / difference) → binary opposition analysis
5. visual: concrete, visualizable noun (table, car, bottle) → SVG description + cloze example
6. slang-idioms: internet slang / idiom / cultural expression / metaphor → literal vs actual meaning
7. grammar-skeleton: grammatical structure confusion (tense, articles, prepositions) → grammar blank
8. cross-domain: common word with different meanings in different fields (e.g. "abstract" in art vs programming) → polysemy
9. pronunciation: word with tricky stress / homograph / minimal-pair confusion → pronunciation guide
10. register-shift: word needs formal↔casual rewrite (e.g. "commence" vs "start") → register transformation
11. reverse-mapping: Chinese phrase → best English expression (input contains Chinese characters)
`;

/**
 * Generate a BATCH of 1-3 complementary cards from a single input.
 * Qwen decides how many learning angles the input has and generates one card per angle.
 * Each card uses a different matrix and covers a distinct learning point.
 */
export async function generateSmartCards(input: SmartCardInput): Promise<SmartCardResult[]> {
  const { rawInput, userLevel, userProfession, userInterests } = input;

  const profileHint = (userProfession || (userInterests?.length))
    ? `User profile: profession=${userProfession || 'general'}, interests=${(userInterests || []).join(', ')}.`
    : '';

  const knownWordsHint = (input.knownWords && input.knownWords.length > 0)
    ? `Known vocabulary (i+1 basis — do NOT use these as target words, go one level beyond them): ${input.knownWords.slice(0, 30).join(', ')}.`
    : ''

  const prompt = `You are an expert English learning card generator applying Krashen's i+1 theory and spaced repetition principles.

User input: "${rawInput}"
User level: ${userLevel}
${profileHint}
${knownWordsHint}

## Your Task
1. Deeply analyze the input for ALL distinct language learning angles.
2. For each angle, select the BEST cognitive matrix and generate ONE complete learning card.
3. Card count: 1 for simple input, 2-3 for rich/complex input. NEVER repeat the same matrixIndex.

## 11 Cognitive Matrices & Their Card Formats

### Matrix 1: deep-understanding
front: "The word ________ comes from [root clue]. Example: [sentence with blank]"
back: "Answer: [word]. Etymology: [root]. Mnemonic: [memorable story]"

### Matrix 2: context-fill
front: "Fill in the blank: [original sentence with target word replaced by ________]\\nHint: [synonym or brief clue]"
back: "Answer: [targetWord]. Explanation: [how/why this word fits here]"

### Matrix 3: collocation
front: "Complete the natural phrase: [sentence with multi-word chunk as ________]\\nHint: [first letter or semantic clue]"
back: "Answer: [full collocation]. Note: [why this phrase is idiomatic]"

### Matrix 4: contrast
front: "Choose the correct word:\\n[sentence A with word1 blank] vs [sentence B with word2 blank]\\nHint: [one-line rule]"
back: "Answers: [word1] / [word2]. Rule: [A=X, B=Y because...]"

### Matrix 5: visual
front: "[Emoji representing the object] What is this? The ________ is used for [function description]."
back: "Answer: [concrete noun]. Visual: [simple description of the object]"

### Matrix 6: slang-idioms
front: "[Context sentence with idiom/slang as ________]\\n(Hint: [emoji or cultural clue])"
back: "Answer: [idiom/slang]. Literal meaning: [word by word]. Actual meaning: [what it really means]. Origin: [brief cultural story]"

### Matrix 7: grammar-skeleton
front: "【Grammar Pattern】[sentence with grammar blank]\\nPattern: [structure name]\\nHint: [rule reminder]"
back: "Answer: [correct grammar form]. Rule: [clear explanation]. Mistake to avoid: [common error]"

### Matrix 8: cross-domain
front: "【Domain: [field]】[sentence with word in specialized meaning as ________]\\nHint: you know this word in everyday life..."
back: "Answer: [word]. Everyday meaning: [X]. In [domain]: [Y]. Connection: [semantic link]"

### Matrix 9: pronunciation
front: "【Stress/Sound】Say this aloud: '[sentence]'\\nQuestion: Is the stress on syllable [A] or [B]?"
back: "Answer: [correct stress]. IPA: [/notation/]. Memory trick: [mnemonic for stress]"

### Matrix 10: register-shift
front: "【Register】Rewrite this naturally for [context]:\\n❌ [awkward version]\\n✅ There is ________ [rest of sentence]\\nHint: [first letter clue]"
back: "Answer: [polished word/phrase]. Why: [register explanation]"

### Matrix 11: reverse-mapping
CRITICAL RULES for M11:
- targetWord MUST be the exact, complete, ready-to-say English expression (e.g. "pass the buck", "Could you settle the outstanding balance?")
- targetWord must NOT be a description of behavior (e.g. NOT "follow up politely", NOT "ask nicely")
- back MUST show: the exact phrase/sentence to say + one wrong literal translation to avoid + origin/cultural note
front: "【Chinese→English】'[Chinese expression]' — What do native speakers actually SAY?\\nHint: [first letters of the answer]"
back: "Say: \\"[exact English phrase/sentence]\\"\\nNEVER: \\"[wrong literal translation]\\"\\nWhy: [origin or cultural note]"

## Selection Rules
- Input has Chinese characters → MUST include matrix 11
- Input has "vs" / "difference" → MUST include matrix 4
- Full English sentence with key unknown → start with matrix 2
- Slang/idiom/meme → matrix 6
- Grammar structure question → matrix 7
- Concrete noun → matrix 5
- Isolated academic/professional word → matrix 1

## Output Format — Return ONLY valid JSON:
{
  "cards": [
    {
      "matrixIndex": <1-11>,
      "matrixType": "<type name>",
      "targetWord": "<the core answer word/phrase>",
      "context": "<REQUIRED: one sentence containing the literal string '________' (8 underscores) replacing the targetWord — used for Dojo cloze review>",
      "front": "<card front exactly as shown in matrix format above>",
      "back": "<card back exactly as shown in matrix format above>",
      "explanation": "<English-only extended explanation, max 150 chars>"
    }
  ]
}`;

  try {
    const result = await callAIProxy({
      type: 'generate-card',
      prompt,
      userLevel,
    });

    if (!result || !Array.isArray(result.cards)) return [];

    return result.cards.map((c: any) => ({
      matrixType: c.matrixType || 'deep-understanding',
      matrixIndex: c.matrixIndex || 1,
      targetWord: c.targetWord || rawInput,
      context: c.context || `________ — ${rawInput}`,
      front: c.front || c.context || `________ — ${rawInput}`,
      back: c.back || `Answer: ${c.targetWord || rawInput}`,
      explanation: c.explanation || '',
      extra: c.extra,
    }));
  } catch (e) {
    console.error('Smart matrix batch generation failed:', e);
    return [];
  }
}

/**
 * Single-card convenience wrapper (picks the first/best card from the batch).
 */
export async function generateSmartCard(input: SmartCardInput): Promise<SmartCardResult | null> {
  const cards = await generateSmartCards(input);
  return cards[0] ?? null;
}
