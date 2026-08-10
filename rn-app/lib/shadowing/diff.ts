export type ShadowingIssueType = 'missing' | 'extra' | 'substitution';

export interface ShadowingIssue {
  type: ShadowingIssueType;
  expected?: string;
  actual?: string;
  expectedIndex?: number;
  actualIndex?: number;
}

export type ShadowingTokenComparisonStatus = 'match' | 'missing' | 'extra' | 'substitution';

export interface ShadowingTokenComparison {
  text: string;
  status: ShadowingTokenComparisonStatus;
  counterpart?: string;
}

export interface ShadowingDiffResult {
  targetText: string;
  transcriptText: string;
  normalizedTarget: string;
  normalizedTranscript: string;
  targetTokens: string[];
  transcriptTokens: string[];
  matchedTokenCount: number;
  completionScore: number;
  accuracyScore: number;
  issues: ShadowingIssue[];
  missingChunks: string[];
  targetComparisons: ShadowingTokenComparison[];
  transcriptComparisons: ShadowingTokenComparison[];
  pass: boolean;
}

export type ShadowingDominantPattern = 'pass' | 'missing_head' | 'missing_tail' | 'replacement' | 'fragment' | 'mixed';

export interface ShadowingDeterministicSignals {
  missingCount: number;
  extraCount: number;
  substitutionCount: number;
  leadingMissingCount: number;
  trailingMissingCount: number;
  missingHeadChunk?: string;
  missingTailChunk?: string;
  dominantPattern: ShadowingDominantPattern;
}

const NUM_WORDS: Record<string, string> = {
  '0': 'zero',
  '1': 'one',
  '2': 'two',
  '3': 'three',
  '4': 'four',
  '5': 'five',
  '6': 'six',
  '7': 'seven',
  '8': 'eight',
  '9': 'nine',
  '10': 'ten',
  '11': 'eleven',
  '12': 'twelve',
  '13': 'thirteen',
  '14': 'fourteen',
  '15': 'fifteen',
  '16': 'sixteen',
  '17': 'seventeen',
  '18': 'eighteen',
  '19': 'nineteen',
  '20': 'twenty',
};

const REPLACEMENTS: Array<[RegExp, string]> = [
  [/\bI'm\b/gi, 'I am'],
  [/\byou're\b/gi, 'you are'],
  [/\bwe're\b/gi, 'we are'],
  [/\bthey're\b/gi, 'they are'],
  [/\bit's\b/gi, 'it is'],
  [/\bthat's\b/gi, 'that is'],
  [/\bthere's\b/gi, 'there is'],
  [/\bcan't\b/gi, 'cannot'],
  [/\bwon't\b/gi, 'will not'],
  [/\bdon't\b/gi, 'do not'],
  [/\bdoesn't\b/gi, 'does not'],
  [/\bdidn't\b/gi, 'did not'],
  [/\bisn't\b/gi, 'is not'],
  [/\baren't\b/gi, 'are not'],
  [/\bwasn't\b/gi, 'was not'],
  [/\bweren't\b/gi, 'were not'],
  [/\bhaven't\b/gi, 'have not'],
  [/\bhasn't\b/gi, 'has not'],
  [/\bhadn't\b/gi, 'had not'],
  [/\bI've\b/gi, 'I have'],
  [/\byou've\b/gi, 'you have'],
  [/\bwe've\b/gi, 'we have'],
  [/\bthey've\b/gi, 'they have'],
  [/\bI'll\b/gi, 'I will'],
  [/\byou'll\b/gi, 'you will'],
  [/\bwe'll\b/gi, 'we will'],
  [/\bthey'll\b/gi, 'they will'],
  [/\bgonna\b/gi, 'going to'],
  [/\bwanna\b/gi, 'want to'],
];

function normalizeText(input: string): string {
  let value = input.replace(/[’']/g, "'");
  for (const [pattern, replacement] of REPLACEMENTS) {
    value = value.replace(pattern, replacement);
  }
  value = value.replace(/\b(\d+)\b/g, (_, n: string) => NUM_WORDS[n] ?? n);
  value = value
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return value;
}

export function cleanShadowingTargetText(input: string): string {
  return input
    .replace(/\*[^*]*\*/g, ' ')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/\s+([,.!?;:])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenize(input: string): string[] {
  return input ? input.split(' ').filter(Boolean) : [];
}

function pushMissingChunk(chunks: string[], buffer: string[]) {
  if (buffer.length > 0) {
    chunks.push(buffer.join(' '));
    buffer.length = 0;
  }
}

export function diffShadowing(targetText: string, transcriptText: string): ShadowingDiffResult {
  const cleanedTargetText = cleanShadowingTargetText(targetText);
  const normalizedTarget = normalizeText(cleanedTargetText);
  const normalizedTranscript = normalizeText(transcriptText);
  const targetTokens = tokenize(normalizedTarget);
  const transcriptTokens = tokenize(normalizedTranscript);

  const m = targetTokens.length;
  const n = transcriptTokens.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array.from({ length: n + 1 }, () => 0));

  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = targetTokens[i - 1] === transcriptTokens[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost,
      );
    }
  }

  const issues: ShadowingIssue[] = [];
  const missingChunks: string[] = [];
  const targetComparisons: ShadowingTokenComparison[] = [];
  const transcriptComparisons: ShadowingTokenComparison[] = [];
  const missingBuffer: string[] = [];
  let matchedTokenCount = 0;
  let i = m;
  let j = n;

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && targetTokens[i - 1] === transcriptTokens[j - 1] && dp[i][j] === dp[i - 1][j - 1]) {
      matchedTokenCount += 1;
      pushMissingChunk(missingChunks, missingBuffer);
      targetComparisons.push({
        text: targetTokens[i - 1],
        status: 'match',
        counterpart: transcriptTokens[j - 1],
      });
      transcriptComparisons.push({
        text: transcriptTokens[j - 1],
        status: 'match',
        counterpart: targetTokens[i - 1],
      });
      i -= 1;
      j -= 1;
      continue;
    }

    if (i > 0 && j > 0 && dp[i][j] === dp[i - 1][j - 1] + 1) {
      pushMissingChunk(missingChunks, missingBuffer);
      targetComparisons.push({
        text: targetTokens[i - 1],
        status: 'substitution',
        counterpart: transcriptTokens[j - 1],
      });
      transcriptComparisons.push({
        text: transcriptTokens[j - 1],
        status: 'substitution',
        counterpart: targetTokens[i - 1],
      });
      issues.push({
        type: 'substitution',
        expected: targetTokens[i - 1],
        actual: transcriptTokens[j - 1],
        expectedIndex: i - 1,
        actualIndex: j - 1,
      });
      i -= 1;
      j -= 1;
      continue;
    }

    if (i > 0 && dp[i][j] === dp[i - 1][j] + 1) {
      targetComparisons.push({
        text: targetTokens[i - 1],
        status: 'missing',
      });
      issues.push({
        type: 'missing',
        expected: targetTokens[i - 1],
        expectedIndex: i - 1,
      });
      missingBuffer.unshift(targetTokens[i - 1]);
      i -= 1;
      continue;
    }

    if (j > 0 && dp[i][j] === dp[i][j - 1] + 1) {
      pushMissingChunk(missingChunks, missingBuffer);
      transcriptComparisons.push({
        text: transcriptTokens[j - 1],
        status: 'extra',
      });
      issues.push({
        type: 'extra',
        actual: transcriptTokens[j - 1],
        actualIndex: j - 1,
      });
      j -= 1;
      continue;
    }

    break;
  }

  pushMissingChunk(missingChunks, missingBuffer);
  issues.reverse();
  targetComparisons.reverse();
  transcriptComparisons.reverse();

  const completionScore = m === 0 ? 1 : matchedTokenCount / m;
  const accuracyScore = Math.max(m, n) === 0 ? 1 : matchedTokenCount / Math.max(m, n);
  const pass = completionScore >= 0.85 && accuracyScore >= 0.8;

  return {
    targetText: cleanedTargetText,
    transcriptText,
    normalizedTarget,
    normalizedTranscript,
    targetTokens,
    transcriptTokens,
    matchedTokenCount,
    completionScore,
    accuracyScore,
    issues,
    missingChunks,
    targetComparisons,
    transcriptComparisons,
    pass,
  };
}

function buildContiguousMissingChunk(comparisons: ShadowingTokenComparison[], fromStart: boolean): string | undefined {
  const buffer: string[] = [];
  const items = fromStart ? comparisons : [...comparisons].reverse();

  for (const item of items) {
    if (item.status !== 'missing') break;
    buffer.push(item.text);
  }

  if (buffer.length === 0) return undefined;
  return fromStart ? buffer.join(' ') : buffer.reverse().join(' ');
}

export function analyzeShadowingDiff(result: ShadowingDiffResult): ShadowingDeterministicSignals {
  const missingCount = result.issues.filter((issue) => issue.type === 'missing').length;
  const extraCount = result.issues.filter((issue) => issue.type === 'extra').length;
  const substitutionCount = result.issues.filter((issue) => issue.type === 'substitution').length;

  let leadingMissingCount = 0;
  for (const item of result.targetComparisons) {
    if (item.status !== 'missing') break;
    leadingMissingCount += 1;
  }

  let trailingMissingCount = 0;
  for (let i = result.targetComparisons.length - 1; i >= 0; i -= 1) {
    if (result.targetComparisons[i].status !== 'missing') break;
    trailingMissingCount += 1;
  }

  const missingHeadChunk = buildContiguousMissingChunk(result.targetComparisons, true);
  const missingTailChunk = buildContiguousMissingChunk(result.targetComparisons, false);
  const heavyMismatch = result.accuracyScore < 0.45 || result.completionScore < 0.45;

  let dominantPattern: ShadowingDominantPattern = 'mixed';
  if (result.pass && result.issues.length === 0) {
    dominantPattern = 'pass';
  } else if (leadingMissingCount >= 2 && leadingMissingCount >= trailingMissingCount) {
    dominantPattern = 'missing_head';
  } else if (trailingMissingCount >= 2 && trailingMissingCount > leadingMissingCount) {
    dominantPattern = 'missing_tail';
  } else if (substitutionCount > 0 && missingCount === 0 && extraCount === 0) {
    dominantPattern = 'replacement';
  } else if (heavyMismatch) {
    dominantPattern = 'fragment';
  }

  return {
    missingCount,
    extraCount,
    substitutionCount,
    leadingMissingCount,
    trailingMissingCount,
    missingHeadChunk,
    missingTailChunk,
    dominantPattern,
  };
}

export function buildLocalShadowingSummary(result: ShadowingDiffResult): string {
  if (result.transcriptTokens.length === 0) {
    return '这次没有识别到有效内容，建议再读一次。';
  }
  if (result.pass && result.issues.length === 0) {
    return '这一句基本完整跟上了，可以继续下一句。';
  }
  const missing = result.issues.filter((issue) => issue.type === 'missing').length;
  const substitution = result.issues.filter((issue) => issue.type === 'substitution').length;
  const extra = result.issues.filter((issue) => issue.type === 'extra').length;
  const parts: string[] = [];
  if (missing > 0) parts.push(`漏了 ${missing} 个词`);
  if (substitution > 0) parts.push(`替换了 ${substitution} 个词`);
  if (extra > 0) parts.push(`多出了 ${extra} 个词`);
  return parts.length > 0 ? `这句整体接近目标句，但${parts.join('，')}。` : '这句还可以再稳定一点。';
}
