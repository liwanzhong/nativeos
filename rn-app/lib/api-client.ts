/**
 * AI API Client using Qwen (通义千问) - OpenAI-compatible interface
 * Alibaba Cloud DashScope: https://dashscope.aliyuncs.com/compatible-mode/v1
 */

const QWEN_API_KEY = process.env.EXPO_PUBLIC_QWEN_API_KEY || '';
const QWEN_BASE_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1';
const QWEN_MODEL = 'qwen-plus';

interface AIProxyRequest {
  type: 'generate-card' | 'intent-routing' | 'evaluate-session' | 'npc-reply';
  prompt: string;
  userLevel?: string;
  context?: string;
  systemMessage?: string;  // Override default system prompt
  maxTokens?: number;
}

interface TTSProxyRequest {
  text: string;
  emotion?: 'neutral' | 'excited' | 'professional' | 'casual' | 'urgent';
  speed?: number;
}

export async function callAITextProxy(request: AIProxyRequest): Promise<string> {
  if (!QWEN_API_KEY) {
    throw new Error('Qwen API key not configured (EXPO_PUBLIC_QWEN_API_KEY)');
  }

  try {
    const response = await fetch(`${QWEN_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${QWEN_API_KEY}`,
      },
      body: JSON.stringify({
        model: QWEN_MODEL,
        messages: [
          {
            role: 'system',
            content: request.systemMessage ?? 'Respond with plain text only.',
          },
          {
            role: 'user',
            content: request.prompt,
          },
        ],
        temperature: 0.7,
        max_tokens: request.maxTokens,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Qwen API error ${response.status}: ${errorText}`);
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content;

    if (typeof content !== 'string' || !content.trim()) {
      throw new Error('Empty response from Qwen API');
    }

    return content;
  } catch (error) {
    console.error('Qwen text API call failed:', error);
    throw error;
  }
}

/**
 * Call Qwen API directly (OpenAI-compatible)
 */
export async function callAIProxy(request: AIProxyRequest): Promise<any> {
  if (!QWEN_API_KEY) {
    throw new Error('Qwen API key not configured (EXPO_PUBLIC_QWEN_API_KEY)');
  }

  try {
    const response = await fetch(`${QWEN_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${QWEN_API_KEY}`,
      },
      body: JSON.stringify({
        model: QWEN_MODEL,
        messages: [
          {
            role: 'system',
            content: request.systemMessage ?? 'You are an expert English language learning card generator. Always respond with valid JSON only, no markdown.',
          },
          {
            role: 'user',
            content: request.prompt,
          },
        ],
        temperature: 0.7,
        max_tokens: request.maxTokens,
        response_format: { type: 'json_object' },
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Qwen API error ${response.status}: ${errorText}`);
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content;

    if (!content) {
      throw new Error('Empty response from Qwen API');
    }

    return typeof content === 'string' ? JSON.parse(content) : content;
  } catch (error) {
    console.error('Qwen API call failed:', error);
    throw error;
  }
}

/**
 * Stream Qwen API response via SSE using XMLHttpRequest.
 * React Native's fetch does NOT support response.body (ReadableStream),
 * but XHR's onreadystatechange gives incremental responseText — true streaming.
 */
export async function callAIProxyStream(
  request: AIProxyRequest,
  onChunk: (partial: string) => void,
): Promise<string> {
  if (!QWEN_API_KEY) {
    throw new Error('Qwen API key not configured (EXPO_PUBLIC_QWEN_API_KEY)');
  }

  return new Promise<string>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${QWEN_BASE_URL}/chat/completions`);
    xhr.setRequestHeader('Content-Type', 'application/json');
    xhr.setRequestHeader('Authorization', `Bearer ${QWEN_API_KEY}`);
    xhr.setRequestHeader('Accept', 'text/event-stream');

    let full = '';
    let processedLength = 0;
    let pendingSseBuffer = '';
    let settled = false;

    const settleResolve = (value: string) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    const settleReject = (error: Error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };

    xhr.onreadystatechange = () => {
      if (settled) return;
      if (xhr.readyState < 3) return;

      const raw = xhr.responseText ?? '';
      const newChunk = raw.slice(processedLength);
      processedLength = raw.length;
      const isDone = xhr.readyState === 4;

      if (newChunk) {
        pendingSseBuffer += newChunk;
        const lines = pendingSseBuffer.split('\n');
        pendingSseBuffer = lines.pop() ?? '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data:')) continue;
          const jsonStr = trimmed.slice(5).trim();
          if (jsonStr === '[DONE]') continue;
          try {
            const parsed = JSON.parse(jsonStr);
            const delta = parsed.choices?.[0]?.delta?.content ?? '';
            if (delta) {
              full += delta;
              if (full.length <= 200 || full.length % 500 < delta.length) {
                console.log('[AIStream] chunk parsed', {
                  type: request.type,
                  fullLength: full.length,
                  deltaLength: delta.length,
                });
              }
              onChunk(full);
            }
          } catch (error) {
            console.warn('[AIStream] failed to parse SSE line', {
              type: request.type,
              lineLength: jsonStr.length,
              error: error instanceof Error ? error.message : 'unknown',
            });
          }
        }
      }

      if (isDone) {
        if (xhr.status >= 200 && xhr.status < 300) {
          if (pendingSseBuffer.trim().startsWith('data:')) {
            const jsonStr = pendingSseBuffer.trim().slice(5).trim();
            if (jsonStr && jsonStr !== '[DONE]') {
              try {
                const parsed = JSON.parse(jsonStr);
                const delta = parsed.choices?.[0]?.delta?.content ?? '';
                if (delta) {
                  full += delta;
                  onChunk(full);
                }
              } catch (error) {
                console.warn('[AIStream] failed to parse trailing SSE buffer', {
                  type: request.type,
                  bufferLength: jsonStr.length,
                  error: error instanceof Error ? error.message : 'unknown',
                });
              }
            }
          }
          if (full) {
            console.log('[AIStream] stream completed', {
              type: request.type,
              fullLength: full.length,
              status: xhr.status,
            });
            settleResolve(full);
          } else {
            settleReject(new Error(`Empty stream response (status ${xhr.status})`));
          }
        } else {
          console.warn('[AIStream] stream request failed', {
            type: request.type,
            status: xhr.status,
            responseLength: xhr.responseText?.length ?? 0,
          });
          settleReject(new Error(`Qwen API error ${xhr.status}: ${xhr.responseText}`));
        }
      }
    };

    xhr.onerror = () => {
      if (settled) return;
      console.warn('[AIStream] xhr network error', { type: request.type });
      settleReject(new Error('XHR network error'));
    };
    xhr.ontimeout = () => {
      if (settled) return;
      console.warn('[AIStream] xhr timeout', { type: request.type, timeoutMs: xhr.timeout });
      settleReject(new Error('XHR timeout'));
    };
    xhr.timeout = 60000;

    console.log('[AIStream] request start', {
      type: request.type,
      timeoutMs: xhr.timeout,
      hasSystemMessage: !!request.systemMessage,
    });

    xhr.send(JSON.stringify({
      model: QWEN_MODEL,
      messages: [
        {
          role: 'system',
          content: request.systemMessage ?? 'You are an expert English language learning card generator. Always respond with valid JSON only, no markdown.',
        },
        { role: 'user', content: request.prompt },
      ],
      temperature: 0.7,
      max_tokens: request.maxTokens,
      stream: true,
    }));
  });
}

/**
 * TTS stub — not implemented for Qwen
 */
export async function callTTSProxy(request: TTSProxyRequest): Promise<string | null> {
  console.warn('TTS not configured');
  return null;
}

/**
 * Check if AI (Qwen) is configured
 */
export function isSupabaseConfigured(): boolean {
  return !!(QWEN_API_KEY);
}
