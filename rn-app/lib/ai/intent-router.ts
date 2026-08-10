/**
 * Intent Router - Classifies user input and routes to appropriate card generation
 * Implements PRD's 5 input types
 */

import { CardType } from '../../types';

export type InputType = 
  | 'isolated_word'      // Type 1: Pure English word without context
  | 'context_fragment'   // Type 2: Complete English sentence with context
  | 'contrast_query'     // Type 3: Explicit comparison (vs, difference)
  | 'reverse_mapping'    // Type 4: Chinese to English mapping
  | 'batch_request';     // Type 5: Bulk generation request

export interface RouterResult {
  type: InputType;
  targetWords: string[];
  context?: string;
  scenarios: CardType[];
  metadata?: {
    word1?: string;
    word2?: string;
    chinesePhrase?: string;
    userProfession?: string;
    userInterests?: string[];
    userLevel?: string;
    count?: number;
    domain?: string;
  };
}

const CONTRAST_PATTERNS = [
  /\bvs\.?\b/i,
  /\bversus\b/i,
  /区别/,
  /difference between/i,
  /\bor\b.*\?$/,
];

const BATCH_PATTERNS = [
  /给我.*\d+.*词/,
  /generate.*\d+/i,
  /create.*\d+/i,
  /list.*\d+/i,
];

export async function routeInput(input: string): Promise<RouterResult> {
  const trimmed = input.trim();
  
  // PRD PRIORITY: Scene 2 (Context Fill) is HIGHEST priority
  // Try to extract context first, as it's closest to Krashen's i+1 theory
  
  // Type 3: Contrast query (explicit comparison takes precedence)
  if (isContrastQuery(trimmed)) {
    return handleContrastQuery(trimmed);
  }
  
  // PRD CRITICAL: Check for confusable words (Saussure's structuralism)
  // "系统检测到易混淆词时，绝对禁止单独生成释义卡"
  const { detectConfusableInInput } = await import('../confusable-words');
  const confusableCheck = await detectConfusableInInput(trimmed);
  
  if (confusableCheck.hasConfusable && confusableCheck.word && confusableCheck.confusableWord) {
    // Force Scene 4: Contrast card
    return {
      type: 'contrast_query',
      targetWords: [confusableCheck.word, confusableCheck.confusableWord],
      scenarios: ['contrast'],
      metadata: {
        word1: confusableCheck.word,
        word2: confusableCheck.confusableWord,
      },
    };
  }
  
  // Type 4: Reverse mapping (contains Chinese)
  if (containsChinese(trimmed)) {
    return handleReverseMapping(trimmed);
  }
  
  // Type 5: Batch request
  if (isBatchRequest(trimmed)) {
    return handleBatchRequest(trimmed);
  }
  
  // PRIORITY: Type 2 - Context fragment (Scene 2 优先)
  // Check if we can extract ANY context, even from short inputs
  const hasContext = canExtractContext(trimmed);
  if (hasContext) {
    return handleContextFragment(trimmed);
  }
  
  // Type 1: Isolated word (only when no context available)
  return await handleIsolatedWord(trimmed);
}

/**
 * Enhanced context detection - more aggressive to prioritize Scene 2
 */
function canExtractContext(input: string): boolean {
  const wordCount = input.split(/\s+/).length;
  
  // Even 3+ words can provide context
  if (wordCount >= 3) return true;
  
  // Has sentence structure indicators
  const hasPunctuation = /[.!?,;:]/.test(input);
  const hasVerb = /\b(is|are|was|were|have|has|had|do|does|did|can|could|will|would|should|make|get|take|go|come)\b/i.test(input);
  const hasPreposition = /\b(in|on|at|to|for|with|from|by|about)\b/i.test(input);
  
  if (wordCount >= 2 && (hasVerb || hasPreposition || hasPunctuation)) {
    return true;
  }
  
  return false;
}

function isContrastQuery(input: string): boolean {
  return CONTRAST_PATTERNS.some(pattern => pattern.test(input));
}

function containsChinese(input: string): boolean {
  return /[\u4e00-\u9fa5]/.test(input);
}

function isBatchRequest(input: string): boolean {
  return BATCH_PATTERNS.some(pattern => pattern.test(input));
}

function isCompleteSentence(input: string): boolean {
  // Check if input has multiple words and sentence structure
  const wordCount = input.split(/\s+/).length;
  const hasPunctuation = /[.!?]$/.test(input);
  const hasVerb = /\b(is|are|was|were|have|has|had|do|does|did|can|could|will|would|should)\b/i.test(input);
  
  return wordCount >= 4 && (hasPunctuation || hasVerb);
}

function handleContrastQuery(input: string): RouterResult {
  // Extract two words being compared
  const vsMatch = input.match(/(\w+)\s+(?:vs\.?|versus|or)\s+(\w+)/i);
  
  if (vsMatch) {
    return {
      type: 'contrast_query',
      targetWords: [vsMatch[1], vsMatch[2]],
      scenarios: ['contrast'],
      metadata: {
        word1: vsMatch[1],
        word2: vsMatch[2],
      },
    };
  }
  
  // Fallback: extract all words
  const words = input.match(/\b[a-z]+\b/gi) || [];
  return {
    type: 'contrast_query',
    targetWords: words.slice(0, 2),
    scenarios: ['contrast'],
  };
}

function handleReverseMapping(input: string): RouterResult {
  // Extract Chinese phrase
  const chineseMatch = input.match(/[\u4e00-\u9fa5]+/);
  
  // PRD: Type 4 triggers Scene 11 (reverse-mapping) AND Scene 6 (slang-idioms)
  return {
    type: 'reverse_mapping',
    targetWords: [],
    scenarios: ['reverse-mapping', 'slang-idioms'],
    metadata: {
      chinesePhrase: chineseMatch ? chineseMatch[0] : input,
    },
  };
}

function handleBatchRequest(input: string): RouterResult {
  // Extract topic/domain
  const words = input.match(/\b[a-z]+\b/gi) || [];
  
  return {
    type: 'batch_request',
    targetWords: [],
    scenarios: ['cross-domain', 'register-shift'],
    context: input,
    metadata: {
      domain: 'daily',
    },
  };
}

function handleContextFragment(input: string): RouterResult {
  // Extract potential target words (longer/uncommon words first)
  const allWords = input.match(/\b[a-z]+\b/gi) || [];
  
  // Prioritize longer words (likely more significant/uncommon)
  const sortedWords = allWords
    .filter(w => w.length >= 4) // Filter out very short words
    .sort((a, b) => b.length - a.length);
  
  const targetWords = sortedWords.length > 0 
    ? sortedWords.slice(0, 3) 
    : allWords.slice(0, 3);
  
  return {
    type: 'context_fragment',
    targetWords,
    context: input,
    // PRIORITY: context-fill is FIRST (Scene 2 优先)
    scenarios: ['context-fill', 'collocation', 'grammar-skeleton'],
  };
}

async function handleIsolatedWord(input: string): Promise<RouterResult> {
  const targetWord = extractTargetWord(input);
  
  // PRD: "AI 必须主动结合用户的职业/兴趣为其'造境'"
  const { getUserContext } = await import('../user-profile');
  const userContext = await getUserContext();
  
  return {
    type: 'isolated_word',
    targetWords: [targetWord],
    scenarios: ['deep-understanding', 'collocation', 'visual'],
    metadata: {
      userProfession: userContext.profession,
      userInterests: userContext.interests,
      userLevel: userContext.level,
    },
  };
}

export function extractTargetWord(input: string): string {
  // Extract the most significant word from input
  const words = input.match(/\b[a-z]+\b/gi) || [];
  
  // Prefer longer words (likely more significant)
  const sorted = words.sort((a, b) => b.length - a.length);
  
  return sorted[0] || input;
}
