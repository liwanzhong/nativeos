/**
 * Scene 8: Cross-Domain (跨学科词义折叠)
 * Handle words with different meanings across domains (熟词生义)
 */

export interface CrossDomainParams {
  targetWord: string;
  domains: string[];
  userLevel: string;
}

export function generateCrossDomainPrompt(params: CrossDomainParams): string {
  const { targetWord, domains, userLevel } = params;

  return `You are a language learning expert specializing in polysemous words.

Task: Explain different meanings of "${targetWord}" across domains.

Domains to cover: ${domains.join(', ')}
User level: ${userLevel}

Requirements:
1. Show how the SAME word has different meanings in different fields
2. Provide clear context for each domain
3. Create example sentences for each meaning
4. Highlight the semantic connection between meanings
5. Mark which meaning is most common
6. Warn about potential confusion

Output ONLY valid JSON in this exact format:
{
  "word": "${targetWord}",
  "coreMeaning": "the original/core meaning",
  "domainMeanings": [
    {
      "domain": "domain name (e.g., tech, medical, business)",
      "meaning": "specific meaning in this domain",
      "example": "example sentence",
      "frequency": "common/rare"
    }
  ],
  "semanticConnection": "how these meanings relate to each other",
  "confusionWarning": "what learners often mix up"
}`;
}
