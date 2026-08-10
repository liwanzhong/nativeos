/**
 * Scene 7: Grammar Skeleton (语法骨架填空)
 * Practice grammatical structures, not vocabulary
 */

export interface GrammarParams {
  sentence: string;
  grammarPoint: string;
  userLevel: string;
}

export function generateGrammarPrompt(params: GrammarParams): string {
  const { sentence, grammarPoint, userLevel } = params;

  return `You are a language learning expert focusing on grammar patterns.

Task: Create a grammar practice card for "${grammarPoint}".

Example sentence: "${sentence}"
User level: ${userLevel}

Requirements:
1. Blank out ONLY grammatical elements (tense, articles, prepositions, conjunctions)
2. Keep all content words (nouns, verbs, adjectives) visible
3. Focus on structural patterns, not vocabulary
4. Example: "I ________ (have/has) been ________ (work/working) here ________ (for/since) 5 years"
5. Provide clear explanation of the grammar rule
6. Include common mistakes to avoid

Output ONLY valid JSON in this exact format:
{
  "grammarPoint": "${grammarPoint}",
  "blankedSentence": "sentence with grammar blanks",
  "correctAnswer": "complete correct sentence",
  "rule": "clear explanation of the grammar rule",
  "commonMistakes": ["mistake 1", "mistake 2"],
  "moreExamples": ["example 1", "example 2"]
}`;
}
