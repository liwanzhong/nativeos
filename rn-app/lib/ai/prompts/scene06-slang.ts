/**
 * Scene 6: Slang & Idioms (俚语与隐喻)
 * Decode internet memes and cultural expressions
 */

export interface SlangParams {
  targetPhrase: string;
  context?: string;
  userLevel: string;
}

export function generateSlangPrompt(params: SlangParams): string {
  const { targetPhrase, context, userLevel } = params;

  return `You are a language learning expert specializing in slang and cultural expressions.

Task: Explain the slang/idiom "${targetPhrase}" with cultural context.

${context ? `Context: "${context}"` : ''}
User level: ${userLevel}

Requirements:
1. Explain the LITERAL meaning vs ACTUAL meaning
2. Provide cultural/historical background
3. Show when and where it's commonly used
4. Give 2-3 example situations
5. Warn about formality level (casual/offensive/professional)
6. Suggest equivalent expressions in other contexts

Output ONLY valid JSON in this exact format:
{
  "phrase": "${targetPhrase}",
  "literalMeaning": "word-by-word translation",
  "actualMeaning": "what it really means",
  "culturalContext": "origin story or cultural background",
  "usage": "when/where to use it",
  "examples": ["example 1", "example 2", "example 3"],
  "formalityLevel": "casual/slang/professional/offensive",
  "alternatives": ["similar expression 1", "similar expression 2"]
}`;
}
