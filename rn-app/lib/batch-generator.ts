/**
 * Batch Card Generation Engine (Type 5 Input Handler)
 * PRD: "双轨制引擎 - 先通过内部知识库检索出标准词汇，再结合目标人群进行批量制卡"
 */

import { CEFRLevel, CardType } from '../types';
import { isSupabaseConfigured } from './api-client';

/**
 * Internal knowledge base - standard vocabulary by domain
 */
const DOMAIN_VOCABULARY: Record<string, Record<CEFRLevel, string[]>> = {
  business: {
    A1: ['meeting', 'office', 'work', 'boss', 'team'],
    A2: ['project', 'deadline', 'client', 'report', 'presentation'],
    B1: ['negotiate', 'proposal', 'strategy', 'revenue', 'stakeholder'],
    B2: ['leverage', 'synergy', 'benchmark', 'optimize', 'facilitate'],
    C1: ['consolidate', 'diversify', 'streamline', 'capitalize', 'incentivize'],
    C2: ['amalgamate', 'proliferate', 'substantiate', 'extrapolate', 'ameliorate'],
  },
  technology: {
    A1: ['computer', 'phone', 'internet', 'email', 'app'],
    A2: ['software', 'download', 'install', 'update', 'password'],
    B1: ['algorithm', 'database', 'network', 'server', 'interface'],
    B2: ['architecture', 'framework', 'deployment', 'scalability', 'optimization'],
    C1: ['infrastructure', 'microservices', 'containerization', 'orchestration', 'middleware'],
    C2: ['paradigm', 'abstraction', 'polymorphism', 'encapsulation', 'idempotent'],
  },
  daily: {
    A1: ['food', 'home', 'family', 'friend', 'time'],
    A2: ['shopping', 'restaurant', 'travel', 'weather', 'health'],
    B1: ['appointment', 'reservation', 'complaint', 'recommendation', 'preference'],
    B2: ['accommodation', 'itinerary', 'cuisine', 'amenities', 'vicinity'],
    C1: ['connoisseur', 'ambiance', 'palate', 'repertoire', 'aesthetic'],
    C2: ['epicurean', 'gastronomic', 'quintessential', 'ubiquitous', 'idiosyncratic'],
  },
  academic: {
    A1: ['book', 'study', 'learn', 'teacher', 'student'],
    A2: ['homework', 'exam', 'grade', 'subject', 'library'],
    B1: ['research', 'thesis', 'reference', 'citation', 'methodology'],
    B2: ['hypothesis', 'empirical', 'correlation', 'analysis', 'synthesis'],
    C1: ['paradigm', 'epistemology', 'phenomenology', 'hermeneutics', 'dialectic'],
    C2: ['ontological', 'heuristic', 'axiomatic', 'teleological', 'exegesis'],
  },
};

export interface BatchGenerationParams {
  count: number;
  domain: string;
  userLevel: CEFRLevel;
  targetScenarios?: CardType[];
}

/**
 * Generate batch cards using dual-track engine
 * Track 1: Retrieve standard vocabulary from internal knowledge base
 * Track 2: Generate cards with AI based on target audience
 */
export async function generateBatchCards(params: BatchGenerationParams): Promise<any[]> {
  if (!isSupabaseConfigured()) {
    console.warn('Supabase not configured, batch generation disabled');
    return [];
  }
  
  try {
    // Track 1: Retrieve standard vocabulary from knowledge base
    const vocabulary = getStandardVocabulary(params.domain, params.userLevel);
    const selectedWords = vocabulary.slice(0, params.count);
    
    if (selectedWords.length === 0) {
      console.warn(`No vocabulary found for domain: ${params.domain}, level: ${params.userLevel}`);
      return [];
    }
    
    // Track 2: Generate cards with AI
    const prompt = generateBatchPrompt({
      words: selectedWords,
      domain: params.domain,
      userLevel: params.userLevel,
      targetScenarios: params.targetScenarios || ['cross-domain', 'register-shift'],
    });
    
    const { callAIProxy } = await import('./api-client');
    const result = await callAIProxy({
      type: 'generate-card',
      prompt,
      userLevel: params.userLevel,
    });
    
    if (!result || !result.cards) {
      return [];
    }
    
    return result.cards;
  } catch (error) {
    console.error('Failed to generate batch cards:', error);
    return [];
  }
}

/**
 * Get standard vocabulary from internal knowledge base
 */
function getStandardVocabulary(domain: string, level: CEFRLevel): string[] {
  const domainVocab = DOMAIN_VOCABULARY[domain.toLowerCase()];
  
  if (!domainVocab) {
    // Fallback to general vocabulary
    return DOMAIN_VOCABULARY.daily[level] || [];
  }
  
  // Get vocabulary for current level and below
  const levels: CEFRLevel[] = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'];
  const currentLevelIndex = levels.indexOf(level);
  
  const words: string[] = [];
  for (let i = 0; i <= currentLevelIndex; i++) {
    const levelWords = domainVocab[levels[i]] || [];
    words.push(...levelWords);
  }
  
  return words;
}

/**
 * Generate batch prompt for AI
 */
function generateBatchPrompt(params: {
  words: string[];
  domain: string;
  userLevel: CEFRLevel;
  targetScenarios: CardType[];
}): string {
  return `You are a batch card generator for language learning.

Domain: ${params.domain}
User Level: ${params.userLevel}
Target Words: ${params.words.join(', ')}
Target Scenarios: ${params.targetScenarios.join(', ')}

Task: Generate ${params.words.length} learning cards, one for each word.

For each word, create a card that:
1. Uses the appropriate scenario type (cross-domain or register-shift)
2. Provides context relevant to ${params.domain}
3. Matches ${params.userLevel} difficulty level
4. Includes practical examples

Return JSON format:
{
  "cards": [
    {
      "targetWord": "word1",
      "type": "cross-domain",
      "context": "Sentence with blank for the word",
      "explanation": "How the word is used in different domains",
      "examples": ["Example 1", "Example 2"]
    },
    ...
  ]
}

Make cards practical and relevant to ${params.domain} professionals.`;
}

/**
 * Expand domain vocabulary (can be called to add more words)
 */
export function addDomainVocabulary(
  domain: string,
  level: CEFRLevel,
  words: string[]
): void {
  if (!DOMAIN_VOCABULARY[domain]) {
    DOMAIN_VOCABULARY[domain] = {
      A1: [],
      A2: [],
      B1: [],
      B2: [],
      C1: [],
      C2: [],
    };
  }
  
  DOMAIN_VOCABULARY[domain][level].push(...words);
}
