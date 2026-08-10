/**
 * Scene 3: Collocation (词块肌肉记忆)
 * Multi-word chunks for natural language production
 */

export interface CollocationParams {
  targetWord: string;
  context: string;
  userLevel: string;
}

export function generateCollocationPrompt(params: CollocationParams): string {
  const { targetWord, context, userLevel } = params;

  return `You are a language learning expert focusing on natural collocations.

Task: Create a collocation practice card for "${targetWord}".

Context: "${context}"
User level: ${userLevel}

Requirements:
1. Identify 2-3 word chunks that include the target word
2. Create a fill-in-the-blank with MULTIPLE consecutive blanks
3. Focus on natural, idiomatic usage
4. Example: "________ ________" = "sheer volume" (not just "volume")
5. Build muscle memory for natural word combinations

Output ONLY valid JSON in this exact format:
{
  "targetPhrase": "the complete collocation",
  "blankedSentence": "sentence with ________ ________ for the phrase",
  "collocations": ["collocation 1", "collocation 2", "collocation 3"],
  "explanation": "why this collocation is natural/idiomatic"
}`;
}
