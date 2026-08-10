import { buildLocalShadowingSummary, type ShadowingDiffResult } from '../shadowing/diff';

const QWEN_API_KEY = process.env.EXPO_PUBLIC_QWEN_API_KEY || '';
const QWEN_BASE_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1';
const QWEN_MODEL = 'qwen-plus';

export interface ShadowingAiFeedback {
  summaryZh: string;
  recommendedChunk?: string;
  encouragement?: string;
}

function buildPrompt(diff: ShadowingDiffResult): string {
  const issues = diff.issues.slice(0, 8).map((issue) => {
    if (issue.type === 'missing') return `missing:${issue.expected}`;
    if (issue.type === 'extra') return `extra:${issue.actual}`;
    return `substitution:${issue.expected}->${issue.actual}`;
  }).join('\n');

  return `You are a speaking coach for sentence shadowing in an English learning app.

Target sentence:
${diff.targetText}

ASR transcript:
${diff.transcriptText}

Normalized target:
${diff.normalizedTarget}

Normalized transcript:
${diff.normalizedTranscript}

Completion score: ${diff.completionScore.toFixed(2)}
Accuracy score: ${diff.accuracyScore.toFixed(2)}

Detected issues:
${issues || 'none'}

Missing chunks:
${diff.missingChunks.join(' | ') || 'none'}

Your task:
- Give one concise Chinese summary for the learner.
- Focus on the most useful practice point, not every tiny error.
- If there is a missing chunk worth practicing, return it as recommendedChunk.
- Encourage retry when appropriate.
- Do not over-penalize possible ASR mistakes.

Return ONLY valid JSON:
{
  "summaryZh": "...",
  "recommendedChunk": "optional short chunk",
  "encouragement": "optional short encouragement"
}`;
}

export async function evaluateShadowingWithAI(diff: ShadowingDiffResult): Promise<ShadowingAiFeedback> {
  if (!QWEN_API_KEY) {
    return {
      summaryZh: buildLocalShadowingSummary(diff),
      recommendedChunk: diff.missingChunks[0],
      encouragement: diff.pass ? '可以继续下一句。' : '再跟读一遍会更稳。',
    };
  }

  try {
    const response = await fetch(`${QWEN_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${QWEN_API_KEY}`,
      },
      body: JSON.stringify({
        model: QWEN_MODEL,
        messages: [
          { role: 'system', content: buildPrompt(diff) },
          { role: 'user', content: `Evaluate this shadowing attempt for: "${diff.targetText}"` },
        ],
        temperature: 0.3,
        max_tokens: 220,
        response_format: { type: 'json_object' },
      }),
    });

    if (!response.ok) {
      return {
        summaryZh: buildLocalShadowingSummary(diff),
        recommendedChunk: diff.missingChunks[0],
        encouragement: diff.pass ? '可以继续下一句。' : '再跟读一遍会更稳。',
      };
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content?.trim() ?? '';
    const parsed = typeof content === 'string' ? JSON.parse(content) : content;

    return {
      summaryZh: parsed?.summaryZh || buildLocalShadowingSummary(diff),
      recommendedChunk: parsed?.recommendedChunk || diff.missingChunks[0],
      encouragement: parsed?.encouragement || (diff.pass ? '可以继续下一句。' : '再跟读一遍会更稳。'),
    };
  } catch {
    return {
      summaryZh: buildLocalShadowingSummary(diff),
      recommendedChunk: diff.missingChunks[0],
      encouragement: diff.pass ? '可以继续下一句。' : '再跟读一遍会更稳。',
    };
  }
}
