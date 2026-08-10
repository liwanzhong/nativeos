/**
 * Scene 9: Pronunciation & Stress (语音/重音盲点)
 * Handle stress patterns and pronunciation traps
 */

export interface PronunciationParams {
  targetWord: string;
  type: 'stress-shift' | 'homograph' | 'minimal-pair';
  userLevel: string;
}

export function generatePronunciationPrompt(params: PronunciationParams): string {
  const { targetWord, type, userLevel } = params;

  return `You are a language learning expert specializing in pronunciation.

Task: Create a pronunciation practice card for "${targetWord}".

Type: ${type}
User level: ${userLevel}

Requirements:
1. For stress-shift words (e.g., REcord vs reCORD):
   - Show both pronunciations with capital letters for stress
   - Explain which is noun vs verb
   - Provide clear example sentences
2. For homographs (same spelling, different sound):
   - Show IPA or phonetic spelling
   - Explain meaning difference
3. For minimal pairs (similar sounds):
   - Contrast the two sounds
   - Provide listening practice examples
4. Include common mistakes
5. Suggest memory tricks for correct pronunciation

Output ONLY valid JSON in this exact format:
{
  "word": "${targetWord}",
  "type": "${type}",
  "pronunciations": [
    {
      "stress": "REcord or reCORD format",
      "ipa": "IPA notation if applicable",
      "partOfSpeech": "noun/verb/adjective",
      "meaning": "meaning for this pronunciation",
      "example": "example sentence"
    }
  ],
  "commonMistake": "what learners often get wrong",
  "memoryTrick": "how to remember the correct pronunciation",
  "contrastPair": "similar word to contrast with (if applicable)"
}`;
}
