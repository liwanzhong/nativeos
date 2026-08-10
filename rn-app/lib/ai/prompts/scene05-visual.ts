/**
 * Scene 5: Visual SVG (具象视觉化)
 * Generate simple SVG for concrete nouns to bypass translation
 */

export interface VisualParams {
  targetWord: string;
  userLevel: string;
}

export function generateVisualPrompt(params: VisualParams): string {
  const { targetWord, userLevel } = params;

  return `You are a language learning expert creating visual memory aids.

Task: Create a simple SVG visualization for "${targetWord}".

Requirements:
1. ONLY for concrete, visualizable nouns (not abstract concepts)
2. Generate clean, minimal SVG code (max 200 characters)
3. Use basic shapes: circle, rect, line, path
4. Use 2-3 colors maximum
5. The image should be instantly recognizable
6. If the word is abstract, return null for svgCode

Output ONLY valid JSON in this exact format:
{
  "word": "${targetWord}",
  "isVisualizable": true or false,
  "svgCode": "<svg viewBox='0 0 100 100'>...</svg>" or null,
  "description": "what the SVG depicts",
  "example": "simple example sentence"
}`;
}
