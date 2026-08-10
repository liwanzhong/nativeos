/**
 * Scene 10: Register Shift (语体情商转换)
 * Transform between casual and professional expressions
 */

export interface RegisterParams {
  casualExpression: string;
  context: string;
  userLevel: string;
}

export function generateRegisterPrompt(params: RegisterParams): string {
  const { casualExpression, context, userLevel } = params;

  return `You are a language learning expert specializing in register and tone.

Task: Transform the casual expression into professional/polite alternatives.

Casual expression: "${casualExpression}"
Context: "${context}"
User level: ${userLevel}

Requirements:
1. Provide 3 levels of formality:
   - Casual/Blunt (original or similar)
   - Neutral/Professional
   - Formal/Diplomatic
2. Explain WHY each version is appropriate
3. Show the emotional impact of each version
4. Indicate when to use each level
5. Highlight key phrases that change the tone
6. Warn about cultural sensitivity

Output ONLY valid JSON in this exact format:
{
  "originalExpression": "${casualExpression}",
  "context": "${context}",
  "alternatives": [
    {
      "level": "casual/neutral/formal",
      "expression": "the alternative expression",
      "tone": "emotional tone (direct/polite/diplomatic)",
      "whenToUse": "appropriate situations",
      "keyPhrases": ["phrase that makes it this level"]
    }
  ],
  "emotionalImpact": "how each version makes the listener feel",
  "culturalNote": "any cultural sensitivity to be aware of",
  "practiceScenario": "a situation to practice this transformation"
}`;
}
