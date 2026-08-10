/**
 * Scene 11: Reverse Mapping (母语逆向映射)
 * Chinese-specific concepts to natural English expressions
 */

export interface ReverseParams {
  chinesePhrase: string;
  context?: string;
  userLevel: string;
}

export function generateReversePrompt(params: ReverseParams): string {
  const { chinesePhrase, context, userLevel } = params;

  return `You are a language learning expert specializing in Chinese-to-English expression mapping.

Task: Find natural English expressions for the Chinese concept "${chinesePhrase}".

${context ? `Context: "${context}"` : ''}
User level: ${userLevel}

Requirements:
1. Provide 3-5 natural English expressions (NOT direct translations)
2. Explain which expression fits which context
3. Show example sentences for each
4. Highlight cultural differences in expression
5. Warn about literal translation traps
6. Suggest the most natural/idiomatic option
7. This is the ONLY scenario where Chinese is allowed in the output

Output ONLY valid JSON in this exact format:
{
  "chinesePhrase": "${chinesePhrase}",
  "literalTranslation": "word-for-word translation (to show why it's wrong)",
  "naturalExpressions": [
    {
      "expression": "natural English expression",
      "context": "when to use this",
      "example": "example sentence",
      "formality": "casual/neutral/formal",
      "naturalness": "very natural/somewhat natural/acceptable"
    }
  ],
  "culturalGap": "why direct translation doesn't work",
  "recommendedExpression": "the most natural option",
  "commonMistake": "what Chinese learners often say wrong",
  "memoryTip": "how to remember the natural expression"
}`;
}
