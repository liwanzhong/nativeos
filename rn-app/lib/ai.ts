/**
 * AI API integration for scenario and card generation
 * Based on PRD's 11 cognitive matrices
 */

import { CardType, CEFRLevel } from '../types';
import { generateContextFillPrompt } from './ai/prompts/scene02-context-fill';
import { generateEtymologyPrompt } from './ai/prompts/scene01-etymology';
import { generateCollocationPrompt } from './ai/prompts/scene03-collocation';
import { generateContrastPrompt } from './ai/prompts/scene04-contrast';
import { generateVisualPrompt } from './ai/prompts/scene05-visual';
import { generateSlangPrompt } from './ai/prompts/scene06-slang';
import { generateGrammarPrompt } from './ai/prompts/scene07-grammar';
import { generateCrossDomainPrompt } from './ai/prompts/scene08-cross-domain';
import { generatePronunciationPrompt } from './ai/prompts/scene09-pronunciation';
import { generateRegisterPrompt } from './ai/prompts/scene10-register';
import { generateReversePrompt } from './ai/prompts/scene11-reverse';

interface GenerateScenarioParams {
  userLevel: CEFRLevel;
  userRAG: string[];
  scenarioType: 'survival' | 'workplace' | 'social' | 'news';
}

interface GenerateCardParams {
  targetWord: string;
  context: string;
  cardType: CardType;
  userLevel: CEFRLevel;
  knownContexts?: string[];
  userProfession?: string;
  userInterests?: string[];
}

interface AIConfig {
  apiKey?: string;
  model?: string;
  provider?: 'openai' | 'anthropic';
}

import { callAIProxy, isSupabaseConfigured } from './api-client';

/**
 * Call AI API with prompt (now using Supabase Edge Function proxy)
 * API keys are protected on server-side
 */
async function callAI(prompt: string, userLevel: CEFRLevel = 'B1', config?: AIConfig): Promise<any> {
  // Check if Supabase proxy is configured
  if (!isSupabaseConfigured()) {
    console.warn('Supabase not configured, AI features disabled');
    return null;
  }
  
  try {
    // Use Supabase Edge Function proxy instead of direct API call
    const result = await callAIProxy({
      type: 'generate-card',
      prompt,
      userLevel,
    });
    
    return result;
  } catch (error) {
    console.error('AI API call failed:', error);
    return null;
  }
}

/**
 * Generate a personalized scenario based on user's level and RAG
 * Implements Krashen's i+1 theory: query FSRS health >80% contexts (N),
 * then generate sentences with exactly one unknown word (+1)
 */
export async function generateScenario(params: GenerateScenarioParams) {
  // Check if Supabase proxy is configured
  if (!isSupabaseConfigured()) {
    console.warn('Supabase not configured, scenario generation disabled');
    return null;
  }
  
  try {
    // Step 1: Query user's known contexts with FSRS health >80% (the "N")
    const { findKnownContextsForWords } = await import('./database/contexts');
    
    // Get common words for the user's level
    const levelWords = getLevelVocabulary(params.userLevel);
    const knownContexts = await findKnownContextsForWords(levelWords, 80);
    
    // Extract known words from healthy contexts
    const knownWords = knownContexts
      .map(ctx => extractWordsFromSentence(ctx.sentence))
      .flat()
      .slice(0, 50); // Limit to top 50 known words
    
    // Step 2: Generate scenario with AI using known words as base (N+1)
    const scenarioPrompt = generateScenarioPrompt({
      userLevel: params.userLevel,
      knownWords,
      scenarioType: params.scenarioType,
      userRAG: params.userRAG,
    });
    
    const result = await callAI(scenarioPrompt, params.userLevel);
    
    if (!result) {
      return null;
    }
    
    return {
      title: result.title || `${params.scenarioType} scenario`,
      dialogue: result.dialogue || [],
      targetWords: result.targetWords || [],
      context: result.context || '',
    };
  } catch (error) {
    console.error('Failed to generate scenario:', error);
    return null;
  }
}

/**
 * Get common vocabulary for a CEFR level
 */
function getLevelVocabulary(level: CEFRLevel): string[] {
  const vocabularies: Record<CEFRLevel, string[]> = {
    A1: ['be', 'have', 'do', 'go', 'get', 'make', 'know', 'think', 'take', 'see', 'come', 'want', 'use', 'find', 'give', 'tell', 'work', 'call', 'try', 'need'],
    A2: ['become', 'leave', 'put', 'mean', 'keep', 'let', 'begin', 'seem', 'help', 'show', 'hear', 'play', 'run', 'move', 'live', 'believe', 'bring', 'happen', 'write', 'sit'],
    B1: ['provide', 'require', 'continue', 'create', 'add', 'understand', 'consider', 'appear', 'buy', 'expect', 'build', 'remain', 'suggest', 'raise', 'pass', 'sell', 'decide', 'win', 'explain', 'hope'],
    B2: ['develop', 'exist', 'involve', 'achieve', 'maintain', 'indicate', 'identify', 'establish', 'occur', 'assume', 'ensure', 'obtain', 'contribute', 'demonstrate', 'enhance', 'implement', 'acquire', 'facilitate', 'generate', 'utilize'],
    C1: ['constitute', 'facilitate', 'incorporate', 'differentiate', 'emphasize', 'attribute', 'derive', 'manipulate', 'advocate', 'accommodate', 'supplement', 'undermine', 'substantiate', 'articulate', 'consolidate', 'exemplify', 'synthesize', 'elucidate', 'corroborate', 'extrapolate'],
    C2: ['epitomize', 'juxtapose', 'ameliorate', 'exacerbate', 'proliferate', 'obfuscate', 'substantiate', 'corroborate', 'elucidate', 'extrapolate', 'interpolate', 'delineate', 'circumvent', 'obviate', 'mitigate', 'perpetuate', 'engender', 'promulgate', 'inculcate', 'expunge'],
  };
  
  return vocabularies[level] || vocabularies.B1;
}

/**
 * Extract words from a sentence (simple tokenization)
 */
function extractWordsFromSentence(sentence: string): string[] {
  return sentence
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter(word => word.length > 2);
}

/**
 * Generate scenario prompt for AI
 */
function generateScenarioPrompt(params: {
  userLevel: CEFRLevel;
  knownWords: string[];
  scenarioType: string;
  userRAG: string[];
}): string {
  const knownWordsStr = params.knownWords.slice(0, 30).join(', ');
  
  return `You are a language learning scenario generator following Krashen's i+1 theory.

User Level: ${params.userLevel}
Scenario Type: ${params.scenarioType}
User's Known Words (N): ${knownWordsStr}
User's Interests: ${params.userRAG.join(', ')}

Task: Generate a realistic ${params.scenarioType} scenario that:
1. Uses ONLY the known words listed above as the base (N)
2. Introduces exactly ONE new target word (+1) that is slightly above the user's level
3. The new word should be essential to understand the scenario
4. Provides enough context clues to guess the meaning

Return JSON format:
{
  "title": "Scenario title",
  "context": "Brief scenario description",
  "dialogue": ["Speaker: sentence with _____ (blank for target word)", ...],
  "targetWords": ["the_new_word"],
  "hint": "Contextual hint for the new word"
}

Make it realistic and engaging for ${params.scenarioType} context.`;
}

/**
 * Generate a learning card using one of the 11 cognitive matrices
 */
export async function generateCard(params: GenerateCardParams, config?: AIConfig) {
  const generators: Record<CardType, (params: GenerateCardParams, config?: AIConfig) => Promise<any>> = {
    'deep-understanding': generateDeepUnderstandingCard,
    'context-fill': generateContextFillCard,
    'collocation': generateCollocationCard,
    'contrast': generateContrastCard,
    'visual': generateVisualCard,
    'slang-idioms': generateSlangCard,
    'grammar-skeleton': generateGrammarCard,
    'cross-domain': generateCrossDomainCard,
    'pronunciation': generatePronunciationCard,
    'register-shift': generateRegisterShiftCard,
    'reverse-mapping': generateReverseCard,
  };
  
  const generator = generators[params.cardType];
  return generator ? await generator(params, config) : null;
}

// Individual card generators for each cognitive matrix

async function generateDeepUnderstandingCard(params: GenerateCardParams, config?: AIConfig) {
  const prompt = generateEtymologyPrompt({
    targetWord: params.targetWord,
    userLevel: params.userLevel,
    userProfession: params.userProfession,
    userInterests: params.userInterests,
  });
  
  const result = await callAI(prompt, params.userLevel, config);
  
  // Build cloze context: replace targetWord with ________ for Dojo review
  const exampleSentence = result?.example || params.context;
  const clozeContext = exampleSentence
    ? exampleSentence.replace(new RegExp(params.targetWord, 'gi'), '________')
    : `________ - ${params.targetWord}`;

  const explanation = result
    ? [result.mnemonic, result.breakdown].filter(Boolean).join('\n\n')
    : 'Etymology breakdown';

  return {
    type: 'deep-understanding',
    targetWord: params.targetWord,
    context: clozeContext,
    explanation,
    etymology: result?.etymology,
  };
}

async function generateContextFillCard(params: GenerateCardParams, config?: AIConfig) {
  const prompt = generateContextFillPrompt({
    context: params.context,
    targetWord: params.targetWord,
    userLevel: params.userLevel,
    knownContexts: params.knownContexts,
  });
  
  const result = await callAI(prompt, params.userLevel, config);
  
  return {
    type: 'context-fill',
    targetWord: params.targetWord,
    context: result?.sentence || params.context,
    explanation: result?.hint || '',
  };
}

async function generateCollocationCard(params: GenerateCardParams, config?: AIConfig) {
  const prompt = generateCollocationPrompt({
    targetWord: params.targetWord,
    context: params.context,
    userLevel: params.userLevel,
  });
  
  const result = await callAI(prompt, params.userLevel, config);
  
  return {
    type: 'collocation',
    targetWord: params.targetWord,
    context: result?.blankedSentence || params.context,
    explanation: result?.explanation || '',
  };
}

async function generateContrastCard(params: GenerateCardParams, config?: AIConfig) {
  const prompt = generateContrastPrompt({
    word1: params.targetWord,
    word2: params.knownContexts?.[0] || 'similar_word',
    userLevel: params.userLevel,
  });
  
  const result = await callAI(prompt, params.userLevel, config);
  
  return {
    type: 'contrast',
    targetWord: params.targetWord,
    context: result?.question || params.context,
    explanation: result?.keyDifference || '',
  };
}

async function generateVisualCard(params: GenerateCardParams, config?: AIConfig) {
  const prompt = generateVisualPrompt({
    targetWord: params.targetWord,
    userLevel: params.userLevel,
  });
  
  const result = await callAI(prompt, params.userLevel, config);
  
  return {
    type: 'visual',
    targetWord: params.targetWord,
    context: params.context,
    visualSvg: result?.svgCode || undefined,
  };
}

async function generateSlangCard(params: GenerateCardParams, config?: AIConfig) {
  const prompt = generateSlangPrompt({
    targetPhrase: params.targetWord,
    context: params.context,
    userLevel: params.userLevel,
  });
  
  const result = await callAI(prompt, params.userLevel, config);
  
  return {
    type: 'slang-idioms',
    targetWord: params.targetWord,
    context: params.context,
    explanation: result?.culturalContext || '',
  };
}

async function generateGrammarCard(params: GenerateCardParams, config?: AIConfig) {
  const prompt = generateGrammarPrompt({
    sentence: params.context,
    grammarPoint: params.targetWord,
    userLevel: params.userLevel,
  });
  
  const result = await callAI(prompt, params.userLevel, config);
  
  return {
    type: 'grammar-skeleton',
    targetWord: params.targetWord,
    context: result?.blankedSentence || params.context,
    explanation: result?.rule || '',
  };
}

async function generateCrossDomainCard(params: GenerateCardParams, config?: AIConfig) {
  const prompt = generateCrossDomainPrompt({
    targetWord: params.targetWord,
    domains: ['tech', 'business', 'daily'],
    userLevel: params.userLevel,
  });
  
  const result = await callAI(prompt, params.userLevel, config);
  
  return {
    type: 'cross-domain',
    targetWord: params.targetWord,
    context: params.context,
    explanation: result?.semanticConnection || '',
  };
}

async function generatePronunciationCard(params: GenerateCardParams, config?: AIConfig) {
  const prompt = generatePronunciationPrompt({
    targetWord: params.targetWord,
    type: 'stress-shift',
    userLevel: params.userLevel,
  });
  
  const result = await callAI(prompt, params.userLevel, config);
  
  return {
    type: 'pronunciation',
    targetWord: params.targetWord,
    context: params.context,
    explanation: result?.memoryTrick || '',
  };
}

async function generateRegisterShiftCard(params: GenerateCardParams, config?: AIConfig) {
  const prompt = generateRegisterPrompt({
    casualExpression: params.context,
    context: params.targetWord,
    userLevel: params.userLevel,
  });
  
  const result = await callAI(prompt, params.userLevel, config);
  
  return {
    type: 'register-shift',
    targetWord: params.targetWord,
    context: params.context,
    explanation: result?.emotionalImpact || '',
  };
}

async function generateReverseCard(params: GenerateCardParams, config?: AIConfig) {
  const prompt = generateReversePrompt({
    chinesePhrase: params.targetWord,
    context: params.context,
    userLevel: params.userLevel,
  });
  
  const result = await callAI(prompt, params.userLevel, config);
  
  return {
    type: 'reverse-mapping',
    targetWord: result?.recommendedExpression || params.targetWord,
    context: params.context,
    explanation: result?.culturalGap || '',
  };
}
