/**
 * Anthropic Messages API adapter for BYOK.
 *
 * Anthropic's protocol differs from OpenAI in two important ways:
 *   1. System prompt is a top-level `system` field, not a message.
 *   2. `max_tokens` is REQUIRED on every request.
 *
 * Anthropic's official API does NOT support `response_format` / JSON
 * mode. We use a stronger system prompt asking for JSON-only output
 * and parse leniently on the caller side. (This is the same strategy
 * npc-chat.ts uses as a fallback path for malformed output.)
 */

import type { ChatTurn } from './npc-chat';

export interface AnthropicRequest {
  baseUrl: string;
  apiKey: string;
  model: string;
  systemPrompt: string;
  history: ChatTurn[];
  userMessage: string;
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
}

export interface AnthropicOk {
  ok: true;
  text: string;
  raw: string;
  usage?: { input_tokens?: number; output_tokens?: number };
}
export interface AnthropicErr {
  ok: false;
  reason: 'network' | 'timeout' | 'http' | 'invalid_json' | 'empty' | 'no_key' | 'no_base_url' | 'no_model';
  status?: number;
  message?: string;
}
export type AnthropicResult = AnthropicOk | AnthropicErr;

export async function callAnthropic(
  req: AnthropicRequest,
): Promise<AnthropicResult> {
  if (!req.apiKey) return { ok: false, reason: 'no_key' };
  if (!req.baseUrl) return { ok: false, reason: 'no_base_url' };
  if (!req.model) return { ok: false, reason: 'no_model' };

  const messages = [
    ...req.history.map((t) => ({
      role: t.role === 'user' ? ('user' as const) : ('assistant' as const),
      content: t.text,
    })),
    { role: 'user' as const, content: req.userMessage },
  ];

  const url = `${req.baseUrl.replace(/\/+$/, '')}/v1/messages`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), req.timeoutMs ?? 25_000);

  const maskApiKey = (k: string) => {
    if (!k) return '<empty>';
    if (k.length <= 8) return `<len=${k.length}>`;
    return `${k.slice(0, 4)}…${k.slice(-4)}<len=${k.length}>`;
  };
  console.log('[BYOK-AI] callAnthropic → POST', {
    url,
    model: req.model,
    apiKeyMasked: maskApiKey(req.apiKey),
    messageCount: messages.length,
  });

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': req.apiKey,
        'anthropic-version': '2023-06-01',
        // Allow direct browser/native access; required when calling
        // Anthropic from RN without a proxy in front.
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({
        model: req.model,
        system: req.systemPrompt,
        messages,
        temperature: req.temperature ?? 0.55,
        max_tokens: req.maxTokens ?? 240,
      }),
      signal: controller.signal,
    });
    clearTimeout(timer);

    console.log('[BYOK-AI] callAnthropic ← response', {
      status: res.status,
      ok: res.ok,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      console.log('[BYOK-AI] callAnthropic error body', text.slice(0, 500));
      return {
        ok: false,
        reason: 'http',
        status: res.status,
        message: text.slice(0, 800),
      };
    }
    const data: any = await res.json();
    // Anthropic returns content blocks; pull the first text block.
    const blocks: any[] = Array.isArray(data?.content) ? data.content : [];
    const text = blocks
      .filter((b) => b?.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('')
      .trim();
    console.log('[BYOK-AI] callAnthropic success', {
      model: data?.model,
      contentLen: text.length,
      usage: data?.usage,
      contentPreview: text.slice(0, 200),
    });
    if (!text) return { ok: false, reason: 'empty' };
    return {
      ok: true,
      text,
      raw: text,
      usage: data?.usage,
    };
  } catch (e: any) {
    clearTimeout(timer);
    if (e?.name === 'AbortError') {
      console.log('[BYOK-AI] callAnthropic TIMEOUT after 25s');
      return { ok: false, reason: 'timeout' };
    }
    console.log('[BYOK-AI] callAnthropic network error', e?.message ?? String(e));
    return { ok: false, reason: 'network', message: e?.message ?? String(e) };
  }
}
