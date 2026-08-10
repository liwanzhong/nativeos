/**
 * Scene 4: Contrast (二元对立辨析)
 * Saussure's structuralism - distinguish confusable pairs
 */

export interface ContrastParams {
  word1: string;
  word2: string;
  userLevel: string;
}

export function generateContrastPrompt(params: ContrastParams): string {
  const { word1, word2, userLevel } = params;

  return `You are a language learning expert specializing in distinguishing confusable words.

Task: Create a contrast card for "${word1}" vs "${word2}".

User level: ${userLevel}

Requirements:
1. Explain the KEY difference between these words
2. Provide a scenario-based warning (when to use which)
3. Create a two-choice question with strong context clues
4. Make the distinction crystal clear and memorable
5. Use vivid, real-world scenarios

Output ONLY valid JSON in this exact format:
{
  "word1": "${word1}",
  "word2": "${word2}",
  "keyDifference": "the essential distinction",
  "scenario": "When you should use word1 vs word2",
  "question": "A scenario-based question",
  "correctAnswer": "word1 or word2",
  "explanation": "why this is the correct choice"
}`;
}
