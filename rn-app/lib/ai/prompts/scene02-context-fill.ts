/**
 * Scene 2: Context Fill (语境填空)
 * Highest priority - extracts target word from original context
 */

import { CEFRLevel } from '../../../types';

export interface ContextFillParams {
  context: string;
  targetWord: string;
  userLevel: CEFRLevel;
  knownContexts?: string[];
}

export function generateContextFillPrompt(params: ContextFillParams): string {
  const { context, targetWord, userLevel, knownContexts = [] } = params;
  
  const knownContextsHint = knownContexts.length > 0
    ? `\nUser's known contexts (N): ${knownContexts.slice(0, 5).join(', ')}`
    : '';

  return `You are a language learning expert implementing the i+1 theory.

Task: Create a cloze deletion card from the original context.

Original context: "${context}"
Target word to blank out: "${targetWord}"
User level: ${userLevel}${knownContextsHint}

Requirements:
1. Keep the original sentence EXACTLY as provided
2. Replace ONLY the target word with "________"
3. Ensure the context provides enough clues to infer the word
4. The difficulty should match ${userLevel} level (i+1 principle)
5. Provide a pure English hint (synonym or brief explanation)

Output ONLY valid JSON in this exact format:
{
  "sentence": "original sentence with ________ replacing target word",
  "targetWord": "${targetWord}",
  "hint": "English synonym or brief explanation",
  "difficulty": "appropriate CEFR level"
}`;
}
