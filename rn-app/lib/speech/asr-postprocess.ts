export type AsrRiskLevel = 'low' | 'medium' | 'high';

export interface AsrMeta {
  rawText: string;
  normalizedText: string;
  riskLevel: AsrRiskLevel;
  riskFlags: string[];
  shouldAskRetry: boolean;
  looksIncomplete: boolean;
  looksNoisy: boolean;
}

const DIGIT_WORDS: Record<string, string> = {
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

const COMMON_SHORT_UTTERANCES = new Set([
  'yes',
  'no',
  'sure',
  'okay',
  'ok',
  'thanks',
  'thank',
  'hello',
  'hi',
  'sorry',
  'maybe',
  'probably',
  'absolutely',
  'definitely',
  'right',
]);

const INCOMPLETE_ENDINGS = new Set([
  'a',
  'an',
  'the',
  'to',
  'for',
  'with',
  'at',
  'in',
  'on',
  'of',
  'my',
  'your',
  'his',
  'her',
  'their',
  'our',
  'and',
  'or',
  'but',
  'because',
  'if',
  'when',
  'while',
  'is',
  'are',
  'was',
  'were',
  'do',
  'does',
  'did',
  'can',
  'could',
  'should',
  'would',
  'will',
  'have',
  'has',
  'had',
]);

function tokenizeWords(text: string): string[] {
  return text.toLowerCase().match(/[a-z']+/g) ?? [];
}

export function normalizeAsrTranscript(text: string): string {
  return text
    .replace(/[，、]/g, ', ')
    .replace(/[。！？]/g, '. ')
    .replace(/\b(\d+)\b/g, (_, n) => DIGIT_WORDS[n] ?? n)
    .replace(/\s+/g, ' ')
    .trim();
}

export function detectAsrRiskFlags(text: string): string[] {
  const normalized = normalizeAsrTranscript(text);
  const words = tokenizeWords(normalized);
  const flags = new Set<string>();

  if (!normalized) {
    flags.add('empty_transcript');
    return Array.from(flags);
  }

  if (words.length === 1 && !COMMON_SHORT_UTTERANCES.has(words[0]!)) {
    flags.add('single_token_transcript');
  }

  if (words.length > 1) {
    const tail = words[words.length - 1]!;
    if (INCOMPLETE_ENDINGS.has(tail) && !/[.!?]$/.test(normalized)) {
      flags.add('possible_truncation');
    }
  }

  for (let i = 2; i < words.length; i++) {
    if (words[i] === words[i - 1] && words[i] === words[i - 2]) {
      flags.add('repeated_tokens');
      break;
    }
  }

  if (/([a-z])\1{3,}/i.test(normalized)) {
    flags.add('garbled_phrase');
  }

  const letterCount = (normalized.match(/[a-z]/gi) ?? []).length;
  const symbolCount = (normalized.match(/[^a-z\s'.,!?-]/gi) ?? []).length;
  if (letterCount > 0 && symbolCount > Math.max(3, Math.floor(letterCount * 0.4))) {
    flags.add('mixed_noise_pattern');
  }

  if (words.length >= 4) {
    const uniqueCount = new Set(words).size;
    if (uniqueCount <= Math.ceil(words.length / 2) - 1) {
      flags.add('unstable_repetition');
    }
  }

  return Array.from(flags);
}

export function analyzeAsrTranscript(text: string): AsrMeta {
  const normalizedText = normalizeAsrTranscript(text);
  const words = tokenizeWords(normalizedText);
  const riskFlags = detectAsrRiskFlags(normalizedText);
  const onlySingleTokenRisk = riskFlags.length === 1 && riskFlags[0] === 'single_token_transcript';
  const looksIncomplete = riskFlags.includes('possible_truncation');
  const looksNoisy = riskFlags.some((flag) =>
    flag === 'empty_transcript' ||
    flag === 'repeated_tokens' ||
    flag === 'garbled_phrase' ||
    flag === 'mixed_noise_pattern' ||
    flag === 'unstable_repetition'
  );

  let riskLevel: AsrRiskLevel = 'low';
  if (
    riskFlags.includes('empty_transcript') ||
    riskFlags.includes('garbled_phrase') ||
    riskFlags.includes('mixed_noise_pattern') ||
    (riskFlags.includes('repeated_tokens') && riskFlags.includes('possible_truncation'))
  ) {
    riskLevel = 'high';
  } else if (!onlySingleTokenRisk && riskFlags.length > 0 && !(words.length === 1 && COMMON_SHORT_UTTERANCES.has(words[0]!))) {
    riskLevel = 'medium';
  }

  const shouldAskRetry = riskLevel === 'high' || (looksIncomplete && words.length > 1);

  return {
    rawText: text,
    normalizedText,
    riskLevel,
    riskFlags,
    shouldAskRetry,
    looksIncomplete,
    looksNoisy,
  };
}
