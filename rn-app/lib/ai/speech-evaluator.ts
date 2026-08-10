/**
 * Speech Evaluator — 口语评分模块
 *
 * 评分逻辑（先粗后细）：
 * 1. 粗粒度：这句话在当前场景是否合适？（场景适配性）
 *    → 不合适：记录原话 + 正确示范 → 直接生成 FSRS 卡片，跳过细粒度
 * 2. 细粒度：用词、语法是否正确？
 *    → 有问题：逐条列出，生成 FSRS 卡片
 *
 * 触发时机：sendUserMessage 后异步调用，不打断用户交互
 */

import type { AsrMeta } from '../speech/asr-postprocess';
import type { ConversationRuntimeState, ScenarioTaskContract } from './conversation-runtime';
import { analyzeShadowingDiff, diffShadowing } from '../shadowing/diff';

const QWEN_API_KEY = process.env.EXPO_PUBLIC_QWEN_API_KEY || '';
const QWEN_BASE_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1';
const QWEN_MODEL = 'qwen-plus';

export interface FineIssue {
  original: string;       // 用户的原始用词/短语
  corrected: string;      // 正确说法
  type: 'grammar' | 'vocabulary' | 'register' | 'collocation';
  explanation: string;    // 简短解释（中英均可）
}

export interface EvaluationResult {
  shouldSave: boolean;    // 是否有问题需要加入 FSRS

  // 粗粒度
  coarseOk: boolean;                // true = 场景适配，false = 不合适
  coarseIssue?: string;             // 问题描述（粗粒度不合适时）
  nativeAlternative?: string;       // 母语者会怎么说
  nativeWhy?: string;               // 为什么这样说

  // 细粒度（仅在 coarseOk === true 时填充）
  fineIssues?: FineIssue[];

  // FSRS 卡片信息（shouldSave=true 时存在）
  card?: {
    front: string;   // 场景 + 用户原话
    back: string;    // 正确说法 + 原因
    matrixType: 'register-shift' | 'reverse-mapping' | 'context-fill';
    targetPhrase: string;
  };
}

export type SpeechAssessmentKind = 'pass' | 'possible_asr_noise' | 'issue' | 'suggestion' | 'unknown';

export interface SpeechAssessment {
  kind: SpeechAssessmentKind;
  severity: 'low' | 'medium' | 'high';
  confidence: 'low' | 'medium' | 'high';
  detailCode?: 'general' | 'missing_head' | 'missing_tail' | 'word_replacement' | 'possible_asr_cutoff';
  shortFeedbackZh: string;
  explanationZh?: string;
  issueType?: 'grammar' | 'wording';
  original?: string;
  corrected?: string;
  shouldInterrupt: boolean;
  shouldPersist: boolean;
  card?: EvaluationResult['card'];
}

export interface EvaluateInput {
  scenarioTitle: string;
  scenarioCategory: string;
  scenarioDesc?: string;
  taskContract?: ScenarioTaskContract;
  runtimeState?: Partial<ConversationRuntimeState> | null;
  history: Array<{ role: 'user' | 'npc'; text: string }>;
  userMessage: string;   // 最新这条用户输入（待评分）
  userLevel?: string;
  asrMeta?: AsrMeta;
  targetText?: string;
}

function buildEvaluatorPrompt(input: EvaluateInput, transcript: string): string {
  const { scenarioTitle, scenarioCategory, scenarioDesc, userLevel = 'B1', asrMeta, targetText } = input;
  const historyText = input.history
    .slice(-2)
    .map(t => `${t.role === 'user' ? 'Learner' : 'NPC'}: ${t.text}`)
    .join('\n');
  const normalizedHint = asrMeta?.normalizedText && asrMeta.normalizedText !== transcript
    ? `ASR normalized hint: ${asrMeta.normalizedText}\n`
    : '';
  const shadowingDiffBlock = targetText
    ? (() => {
        const diff = diffShadowing(targetText, transcript);
        const signals = analyzeShadowingDiff(diff);
        return `Deterministic shadowing diff:
- completionScore=${diff.completionScore.toFixed(2)}
- accuracyScore=${diff.accuracyScore.toFixed(2)}
- dominantPattern=${signals.dominantPattern}
- missingHeadChunk=${signals.missingHeadChunk || 'none'}
- missingTailChunk=${signals.missingTailChunk || 'none'}
- substitutionCount=${signals.substitutionCount}
- extraCount=${signals.extraCount}\n`;
      })()
    : '';
  const shadowingBlock = targetText
    ? `\nThis is SHADOWING practice, not free conversation.
Expected target text:
"${targetText}"

When target text is provided:
- Compare the transcript against the target text.
- Prefer possible_asr_noise if the mismatch is small and could be explained by ASR confusion.
- Use issue only when there is a clear missing, replaced, or malformed phrase that meaningfully hurts the target sentence.
- Do not reward paraphrasing here; judge whether the learner substantially reproduced the target sentence.
- Use detailCode=missing_head when the learner seems to have recorded only the later part of the target sentence.
- Use detailCode=missing_tail when the learner seems to have recorded only the front part of the target sentence.
- Use detailCode=possible_asr_cutoff when the result looks more like ASR truncation than learner omission.
- Use detailCode=word_replacement when a clear target word or phrase was replaced by another one.
- Use detailCode=general when none of the above apply.
- For shadowing, do not use suggestion. Use pass, possible_asr_noise, issue, or unknown only.
- corrected must be plain spoken English only; never include stage directions, parentheses, or *action* markup.
- If the learner omitted or misread content, shortFeedbackZh should describe the missing/replaced part, and corrected should be the clean target sentence without extra commentary.
`
    : '';

  return `You are evaluating spoken English in a speaking-practice app.

The input is an ASR transcript, not a perfect human transcript.
ASR may drop articles, cut off the ending, split words strangely, or mishear a word.
If a problem looks more like ASR noise than a learner mistake, classify it as possible_asr_noise.

Your job is NOT to judge task completion, politeness strategy, or whether the learner used the most native phrasing.
Your job is ONLY to judge these three things:
1. Does this transcript still form acceptable spoken English?
2. Is there any serious grammar error?
3. Is there any clearly inappropriate or wrong word choice?

Be conservative.
High precision matters more than recall.
When in doubt, choose pass or possible_asr_noise.

Scenario: ${scenarioTitle}
Category: ${scenarioCategory}
${scenarioDesc ? `Scenario note: ${scenarioDesc}\n` : ''}Learner level: ${userLevel}
ASR risk level: ${asrMeta?.riskLevel ?? 'low'}
ASR risk flags: ${(asrMeta?.riskFlags ?? []).join(', ') || 'none'}
${normalizedHint}${shadowingDiffBlock}${shadowingBlock}

Recent context:
${historyText || 'none'}

Transcript to assess:
"${transcript}"

Return ONLY valid JSON:
{
  "kind": "pass|possible_asr_noise|issue|suggestion",
  "severity": "low|medium|high",
  "confidence": "low|medium|high",
  "detailCode": "general|missing_head|missing_tail|word_replacement|possible_asr_cutoff|null",
  "issueType": "grammar|wording|null",
  "original": null,
  "corrected": null,
  "shortFeedbackZh": "简短中文反馈，20字内",
  "explanationZh": "更具体的中文解释，40字内"
}

Rules:
- Use possible_asr_noise if the text seems truncated, garbled, or unreliable because of ASR.
- Use issue only for high-confidence spoken-English problems worth correcting now.
- Use suggestion only when the English is acceptable but there is a clearly better wording.
- Use detailCode=word_replacement when the main problem is that an incorrect target word or phrase was used.
- Use detailCode=general for grammar issues or when no finer detail code fits.
- corrected must contain only the spoken English sentence itself.
- Do not include parenthetical notes like (points to machine), bracketed explanations, or *action* formatting in corrected.
- Do not rewrite just to make it sound more native.
- Do not judge off-topic, rude, or strategy issues unless the wording itself is clearly wrong English.`;
}

/**
 * 异步评分用户的口语回复
 * 完全异步，调用方不需要 await，评分回来后通过回调更新 UI
 */
function buildPassAssessment(shortFeedbackZh = '这句口语基本成立。', explanationZh = '表达可接受，先继续对话。'): SpeechAssessment {
  return {
    kind: 'pass',
    severity: 'low',
    confidence: 'medium',
    detailCode: 'general',
    shortFeedbackZh,
    explanationZh,
    shouldInterrupt: false,
    shouldPersist: false,
  };
}

function buildUnknownAssessment(shortFeedbackZh = '这次口语暂未完成评分。', explanationZh = '暂时不给出通过或纠错结论。'): SpeechAssessment {
  return {
    kind: 'unknown',
    severity: 'low',
    confidence: 'low',
    detailCode: 'general',
    shortFeedbackZh,
    explanationZh,
    shouldInterrupt: false,
    shouldPersist: false,
  };
}

function buildAsrNoiseAssessment(asrMeta?: AsrMeta): SpeechAssessment {
  return {
    kind: 'possible_asr_noise',
    severity: asrMeta?.riskLevel === 'high' ? 'high' : 'medium',
    confidence: 'medium',
    detailCode: asrMeta?.looksIncomplete ? 'possible_asr_cutoff' : 'general',
    shortFeedbackZh: asrMeta?.shouldAskRetry ? '识别可能不稳定，建议再说一次。' : '这句转写有点不稳定。',
    explanationZh: asrMeta?.riskFlags.length
      ? `识别信号不够稳：${asrMeta.riskFlags.join('、')}`
      : '这句更像识别抖动，不急着判错。',
    shouldInterrupt: !!asrMeta?.shouldAskRetry,
    shouldPersist: false,
  };
}

function buildIssueCard(
  input: EvaluateInput,
  original: string,
  corrected: string,
  explanationZh?: string,
  detailCode: SpeechAssessment['detailCode'] = 'general'
): NonNullable<EvaluationResult['card']> {
  return {
    matrixType: detailCode === 'word_replacement' ? 'reverse-mapping' : 'context-fill',
    targetPhrase: corrected,
    front: `场景：${input.scenarioTitle}\n你说：「${original}」\n\n这里怎么说更准确？`,
    back: `更合适的说法：「${corrected}」\n\n${explanationZh || '这个表达在口语里更稳。'}`,
  };
}

function sanitizeAssessmentKind(value: unknown): SpeechAssessmentKind {
  return value === 'possible_asr_noise' || value === 'issue' || value === 'suggestion' || value === 'pass' || value === 'unknown'
    ? value
    : 'unknown';
}

function sanitizeLevel(value: unknown, fallback: 'low' | 'medium' | 'high'): 'low' | 'medium' | 'high' {
  return value === 'low' || value === 'medium' || value === 'high' ? value : fallback;
}

function tokenizeAssessmentWords(text: string): string[] {
  return text.toLowerCase().match(/[a-z']+/g) ?? [];
}

function getShadowingGapSummary(targetText: string, transcript: string): string {
  const targetWords = tokenizeAssessmentWords(targetText);
  const transcriptWords = tokenizeAssessmentWords(transcript);
  if (targetWords.length === 0 || transcriptWords.length === 0) {
    return '当前转写和目标句差距较大，更像识别不完整。';
  }

  let prefixMatchCount = 0;
  while (
    prefixMatchCount < transcriptWords.length &&
    prefixMatchCount < targetWords.length &&
    transcriptWords[prefixMatchCount] === targetWords[prefixMatchCount]
  ) {
    prefixMatchCount += 1;
  }

  if (prefixMatchCount >= 2 && prefixMatchCount < targetWords.length) {
    const missingTail = targetWords.slice(prefixMatchCount, Math.min(prefixMatchCount + 4, targetWords.length)).join(' ');
    return missingTail
      ? `前半句已录到，后半句更像缺失：${missingTail}`
      : '前半句已录到，但后半句更像缺失。';
  }

  return '目标句较长，当前转写更像中途截断或识别残缺。';
}

function buildShadowingRetryAssessment(asrMeta: AsrMeta | undefined, targetText: string, transcript: string): SpeechAssessment {
  const targetWords = tokenizeAssessmentWords(targetText);
  return {
    kind: 'possible_asr_noise',
    severity: asrMeta?.riskLevel === 'high' ? 'high' : 'medium',
    confidence: 'medium',
    detailCode: 'possible_asr_cutoff',
    shortFeedbackZh: '这句跟读可能没完整录到，建议再试一次。',
    explanationZh: targetWords.length >= 6
      ? getShadowingGapSummary(targetText, transcript)
      : '当前转写和目标句差距较大，更像识别不完整。',
    shouldInterrupt: true,
    shouldPersist: false,
  };
}

export function getShadowingDeterministicAssessment(input: EvaluateInput, transcript: string): SpeechAssessment | null {
  if (!input.targetText) return null;

  const diff = diffShadowing(input.targetText, transcript);
  const signals = analyzeShadowingDiff(diff);
  const looksLikeAsrCutoff = !!input.asrMeta?.shouldAskRetry || !!input.asrMeta?.looksIncomplete || !!input.asrMeta?.looksNoisy;
  const targetWords = diff.targetTokens;
  const transcriptWords = diff.transcriptTokens;

  if (diff.pass && diff.issues.length === 0) {
    return buildPassAssessment('这句跟读基本完整。', '和目标句基本一致，可以继续。');
  }

  if (targetWords.length < 4 || transcriptWords.length === 0) {
    return null;
  }

  if (looksLikeAsrCutoff && (signals.dominantPattern === 'missing_tail' || signals.dominantPattern === 'fragment') && diff.completionScore <= 0.55) {
    return buildShadowingRetryAssessment(input.asrMeta, diff.targetText, transcript);
  }

  if (signals.dominantPattern === 'missing_head' && signals.leadingMissingCount >= 2) {
    return {
      kind: 'issue',
      severity: diff.completionScore < 0.55 ? 'high' : 'medium',
      confidence: 'high',
      detailCode: 'missing_head',
      shortFeedbackZh: '前半句没有完整跟上。',
      explanationZh: signals.missingHeadChunk ? `更像漏掉了前半句：${signals.missingHeadChunk}` : '更像漏掉了目标句前半部分。',
      issueType: 'wording',
      original: transcript,
      corrected: diff.targetText,
      shouldInterrupt: true,
      shouldPersist: false,
    };
  }

  if (signals.dominantPattern === 'missing_tail' && signals.trailingMissingCount >= 2) {
    return {
      kind: looksLikeAsrCutoff ? 'possible_asr_noise' : 'issue',
      severity: diff.completionScore < 0.55 ? 'high' : 'medium',
      confidence: 'high',
      detailCode: looksLikeAsrCutoff ? 'possible_asr_cutoff' : 'missing_tail',
      shortFeedbackZh: looksLikeAsrCutoff ? '这句跟读可能没完整录到，建议再试一次。' : '后半句没有完整跟上。',
      explanationZh: signals.missingTailChunk ? `更像缺了后半句：${signals.missingTailChunk}` : '更像缺了目标句后半部分。',
      issueType: 'wording',
      original: transcript,
      corrected: looksLikeAsrCutoff ? undefined : diff.targetText,
      shouldInterrupt: true,
      shouldPersist: false,
    };
  }

  if (signals.dominantPattern === 'replacement' && signals.substitutionCount <= 2 && diff.accuracyScore >= 0.6) {
    const firstSubstitution = diff.issues.find(issue => issue.type === 'substitution');
    const replacementHint = firstSubstitution?.expected && firstSubstitution?.actual
      ? `更像把“${firstSubstitution.expected}”说成了“${firstSubstitution.actual}”。`
      : '有目标词被替换了。';
    return {
      kind: 'issue',
      severity: 'medium',
      confidence: 'high',
      detailCode: 'word_replacement',
      shortFeedbackZh: '目标词有替换。',
      explanationZh: replacementHint,
      issueType: 'wording',
      original: transcript,
      corrected: diff.targetText,
      shouldInterrupt: false,
      shouldPersist: false,
    };
  }

  return null;
}

function sanitizeDetailCode(value: unknown): SpeechAssessment['detailCode'] {
  return value === 'general' || value === 'missing_head' || value === 'missing_tail' || value === 'word_replacement' || value === 'possible_asr_cutoff'
    ? value
    : 'general';
}

function inferDetailCode(kind: SpeechAssessmentKind, issueType: SpeechAssessment['issueType'], detailCode: SpeechAssessment['detailCode']): SpeechAssessment['detailCode'] {
  if (detailCode && detailCode !== 'general') {
    return detailCode;
  }

  if (kind === 'issue' && issueType === 'wording') {
    return 'word_replacement';
  }

  return detailCode || 'general';
}

function sanitizeCorrectedText(value: string | undefined): string | undefined {
  if (!value) return undefined;

  const sanitized = value
    .replace(/\*[^*]*\*/g, ' ')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/\s+([,.!?;:])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();

  return sanitized || undefined;
}

function resolveShadowingIssueWithoutCorrected(
  input: EvaluateInput,
  transcript: string,
  assessment: SpeechAssessment
): SpeechAssessment | null {
  if (!input.targetText || assessment.kind !== 'issue' || assessment.corrected) {
    return null;
  }

  const looksLikeAsrCutoff = !!input.asrMeta?.shouldAskRetry || !!input.asrMeta?.looksIncomplete || !!input.asrMeta?.looksNoisy;

  if ((assessment.detailCode === 'missing_tail' || assessment.detailCode === 'possible_asr_cutoff') && looksLikeAsrCutoff) {
    return {
      ...assessment,
      kind: 'possible_asr_noise',
      shouldInterrupt: true,
      shouldPersist: false,
      corrected: undefined,
      card: undefined,
    };
  }

  return {
    ...assessment,
    original: assessment.original || transcript,
    corrected: sanitizeCorrectedText(input.targetText.trim()),
    shouldInterrupt: assessment.severity === 'high',
    shouldPersist: false,
    card: undefined,
  };
}

export function mapAssessmentToLegacyEvaluation(assessment: SpeechAssessment, input: Pick<EvaluateInput, 'scenarioTitle' | 'userMessage'>): EvaluationResult {
  if (assessment.kind === 'issue') {
    const issueType = assessment.issueType === 'grammar' ? 'grammar' : 'vocabulary';
    const fineIssues: FineIssue[] = assessment.original && assessment.corrected
      ? [{
          original: assessment.original,
          corrected: assessment.corrected,
          type: issueType,
          explanation: assessment.explanationZh || assessment.shortFeedbackZh,
        }]
      : [];
    return {
      shouldSave: assessment.shouldPersist,
      coarseOk: true,
      fineIssues: fineIssues.length > 0 ? fineIssues : undefined,
      card: assessment.card,
    };
  }

  if (assessment.kind === 'suggestion') {
    const fineIssues: FineIssue[] = assessment.original && assessment.corrected
      ? [{
          original: assessment.original,
          corrected: assessment.corrected,
          type: 'vocabulary',
          explanation: assessment.explanationZh || assessment.shortFeedbackZh,
        }]
      : [];
    return {
      shouldSave: false,
      coarseOk: true,
      fineIssues: fineIssues.length > 0 ? fineIssues : undefined,
    };
  }

  if (assessment.kind === 'possible_asr_noise') {
    return {
      shouldSave: false,
      coarseOk: true,
      coarseIssue: assessment.shortFeedbackZh,
      nativeWhy: assessment.explanationZh,
    };
  }

  if (assessment.kind === 'unknown') {
    return {
      shouldSave: false,
      coarseOk: true,
      coarseIssue: assessment.shortFeedbackZh,
      nativeWhy: assessment.explanationZh,
    };
  }

  return {
    shouldSave: false,
    coarseOk: true,
    coarseIssue: assessment.shortFeedbackZh,
  };
}

export async function assessSpokenReply(input: EvaluateInput): Promise<SpeechAssessment> {
  const transcript = input.userMessage.trim();
  if (!transcript) {
    return buildAsrNoiseAssessment(input.asrMeta);
  }

  const shadowingDeterministicAssessment = getShadowingDeterministicAssessment(input, transcript);
  if (shadowingDeterministicAssessment) {
    return shadowingDeterministicAssessment;
  }

  if (input.asrMeta?.riskLevel === 'high' || input.asrMeta?.shouldAskRetry) {
    return buildAsrNoiseAssessment(input.asrMeta);
  }

  const wordCount = transcript.split(/\s+/).filter(Boolean).length;
  if (wordCount <= 1 && input.asrMeta?.riskLevel === 'medium') {
    return buildAsrNoiseAssessment(input.asrMeta);
  }

  console.log('[SpeechEval] assessSpokenReply called, apiKey=', QWEN_API_KEY ? `${QWEN_API_KEY.slice(0,8)}...` : 'MISSING');
  if (!QWEN_API_KEY) {
    console.warn('[SpeechEval] No API key — returning unknown assessment');
    return buildUnknownAssessment('本次口语未完成评分。', '缺少评分服务配置，因此不默认判对。');
  }

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
          { role: 'system', content: buildEvaluatorPrompt(input, transcript) },
          { role: 'user', content: `Assess this ASR transcript: "${transcript}"` },
        ],
        temperature: 0.2,
        max_tokens: 260,
        response_format: { type: 'json_object' },
      }),
    });

    console.log('[SpeechEval] HTTP status=', response.status);
    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      console.warn('[SpeechEval] API error:', response.status, errText.slice(0, 200));
      return buildUnknownAssessment('本次口语未完成评分。', '评分服务暂时异常，因此不默认判对。');
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content?.trim() ?? '';
    console.log('[SpeechEval] raw content=', content.slice(0, 300));
    const parsed = typeof content === 'string' ? JSON.parse(content) : content;
    console.log('[SpeechEval] parsed=', JSON.stringify(parsed).slice(0, 300));

    const kind = sanitizeAssessmentKind(parsed?.kind);
    const severity = sanitizeLevel(parsed?.severity, kind === 'issue' ? 'medium' : 'low');
    const confidence = sanitizeLevel(parsed?.confidence, kind === 'issue' ? 'medium' : 'medium');
    const issueType = parsed?.issueType === 'grammar' || parsed?.issueType === 'wording' ? parsed.issueType : undefined;
    const detailCode = inferDetailCode(kind, issueType, sanitizeDetailCode(parsed?.detailCode));
    const original = typeof parsed?.original === 'string' && parsed.original.trim() ? parsed.original.trim() : undefined;
    const corrected = typeof parsed?.corrected === 'string' && parsed.corrected.trim()
      ? sanitizeCorrectedText(parsed.corrected.trim())
      : undefined;
    const shortFeedbackZh = typeof parsed?.shortFeedbackZh === 'string' && parsed.shortFeedbackZh.trim()
      ? parsed.shortFeedbackZh.trim()
      : kind === 'issue'
        ? '这里有个值得纠正的口语点。'
        : kind === 'suggestion'
          ? '这句可以再自然一点。'
          : kind === 'possible_asr_noise'
            ? '这句识别可能不太稳定。'
            : '这句口语基本成立。';
    const explanationZh = typeof parsed?.explanationZh === 'string' && parsed.explanationZh.trim()
      ? parsed.explanationZh.trim()
      : undefined;

    const assessment: SpeechAssessment = {
      kind,
      severity,
      confidence,
      detailCode,
      shortFeedbackZh,
      explanationZh,
      issueType,
      original,
      corrected,
      shouldInterrupt: kind === 'possible_asr_noise' ? !!input.asrMeta?.shouldAskRetry : kind === 'issue' && severity === 'high',
      shouldPersist: false,
    };

    if (kind === 'issue' && corrected) {
      assessment.shouldPersist = severity === 'high' && confidence !== 'low' && input.asrMeta?.riskLevel !== 'medium';
      assessment.card = assessment.shouldPersist
        ? buildIssueCard(input, original || input.userMessage, corrected, explanationZh || shortFeedbackZh, detailCode)
        : undefined;
      return assessment;
    }

    if (kind === 'possible_asr_noise') {
      return {
        ...assessment,
        shouldInterrupt: !!input.asrMeta?.shouldAskRetry,
        shouldPersist: false,
      };
    }

    if (kind === 'issue') {
      const shadowingIssueAssessment = resolveShadowingIssueWithoutCorrected(input, transcript, assessment);
      if (shadowingIssueAssessment) {
        return shadowingIssueAssessment;
      }
      return buildUnknownAssessment('这次评分结果不完整。', '模型识别到可能有问题，但缺少稳定纠正结果。');
    }

    if (kind === 'suggestion') {
      return {
        ...assessment,
        shouldInterrupt: false,
        shouldPersist: false,
      };
    }

    if (kind === 'pass') {
      return buildPassAssessment(shortFeedbackZh, explanationZh);
    }

    if (kind === 'unknown') {
      return {
        ...assessment,
        shouldInterrupt: false,
        shouldPersist: false,
      };
    }

    return buildUnknownAssessment();
  } catch (err) {
    console.warn('[SpeechEval] failed:', err);
    return buildUnknownAssessment('本次口语未完成评分。', '评分请求失败，因此不默认判对。');
  }
}

export async function evaluateSpeech(input: EvaluateInput): Promise<EvaluationResult> {
  const assessment = await assessSpokenReply(input);
  return mapAssessmentToLegacyEvaluation(assessment, {
    scenarioTitle: input.scenarioTitle,
    userMessage: input.userMessage,
  });
}

export async function assessShadowingReply(input: EvaluateInput & { targetText: string }): Promise<SpeechAssessment> {
  return assessSpokenReply(input);
}

// Note: Auto-saving evaluation results to the knowledge base is intentionally
// disabled. Users add cards manually via the word/sentence "加入知识库" entry
// points in the immersive sandbox and the video page.
