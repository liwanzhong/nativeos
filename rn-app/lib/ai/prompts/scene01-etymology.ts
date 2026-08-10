/**
 * Scene 1: Deep Understanding (词根词缀拆解)
 * Etymology and mnemonic breakdown for difficult words
 */

export interface EtymologyParams {
  targetWord: string;
  userLevel: string;
  userProfession?: string;
  userInterests?: string[];
}

export function generateEtymologyPrompt(params: EtymologyParams): string {
  const { targetWord, userLevel, userProfession, userInterests } = params;

  const profileContext = userProfession || userInterests?.length
    ? `\nUser Profile: profession=${userProfession || 'general'}, interests=${(userInterests || []).join(', ') || 'general'}. Tailor the example sentence to their background.`
    : '';

  return `You are a language learning expert specializing in etymology and mnemonics.

Task: Break down the word "${targetWord}" into memorable components.
${profileContext}
Requirements:
1. Provide root/prefix/suffix breakdown if applicable
2. Create a vivid, absurd, or humorous mnemonic device
3. Use plain language suitable for ${userLevel} learners
4. Make it memorable and engaging
5. If the word has interesting etymology, explain it briefly
6. The example sentence MUST relate to the user's profession/interests if provided

Output ONLY valid JSON in this exact format:
{
  "word": "${targetWord}",
  "breakdown": "root + prefix + suffix explanation",
  "mnemonic": "creative memory aid or story",
  "etymology": "brief origin story if interesting",
  "example": "simple example sentence tailored to user"
}`;
}
