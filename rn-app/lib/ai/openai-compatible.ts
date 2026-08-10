/**
 * OpenAI Chat Completions adapter for BYOK.
 *
 * Single adapter covers every vendor that exposes an OpenAI-compatible
 * endpoint (OpenAI itself, plus DeepSeek / Doubao Ark / Zhipu / Moonshot
 * / Tongyi / Qianfan / any self-hosted llama.cpp / vLLM with the
 * OpenAI shim). The wire format and request shape are identical across
 * all of them; only baseUrl and the model name differ.
 *
 * Return shape: `{ok: true, text}` or `{ok: false, reason}` so the
 * caller (npc-chat) can distinguish "key invalid" from "rate-limited"
 * from "network gone" without re-parsing the upstream error.
 */

import type { ChatTurn } from './npc-chat';

export interface OpenAiCompatibleRequest {
  baseUrl: string;
  apiKey: string;
  model: string;
  systemPrompt: string;
  history: ChatTurn[];
  userMessage: string;
  temperature?: number;
  maxTokens?: number;
  /** Force JSON object response. Doubao / DeepSeek / Zhipu support this; some others don't. */
  jsonMode?: boolean;
  /** Per-request timeout (ms). */
  timeoutMs?: number;
}

export interface OpenAiCompatibleOk {
  ok: true;
  text: string;
  raw: string;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
}
export interface OpenAiCompatibleErr {
  ok: false;
  reason:
    | 'network'
    | 'timeout'
    | 'http'
    | 'invalid_json'
    | 'empty'
    | 'no_key'
    | 'no_base_url'
    | 'no_model';
  status?: number;
  message?: string;
}
export type OpenAiCompatibleResult = OpenAiCompatibleOk | OpenAiCompatibleErr;

export async function callOpenAiCompatible(
  req: OpenAiCompatibleRequest,
): Promise<OpenAiCompatibleResult> {
  if (!req.apiKey) return { ok: false, reason: 'no_key' };
  if (!req.baseUrl) return { ok: false, reason: 'no_base_url' };
  if (!req.model) return { ok: false, reason: 'no_model' };

  const messages = [
    { role: 'system' as const, content: req.systemPrompt },
    ...req.history.map((t) => ({
      role: t.role === 'user' ? ('user' as const) : ('assistant' as const),
      content: t.text,
    })),
    { role: 'user' as const, content: req.userMessage },
  ];

  const body: Record<string, unknown> = {
    model: req.model,
    messages,
    temperature: req.temperature ?? 0.55,
    max_tokens: req.maxTokens ?? 240,
  };
  if (req.jsonMode) {
    body.response_format = { type: 'json_object' };
  }

  const url = `${req.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), req.timeoutMs ?? 25_000);

  const maskApiKey = (k: string) => {
    if (!k) return '<empty>';
    if (k.length <= 8) return `<len=${k.length}>`;
    return `${k.slice(0, 4)}…${k.slice(-4)}<len=${k.length}>`;
  };
  console.log('[BYOK-AI] callOpenAiCompatible → POST', {
    url,
    model: req.model,
    apiKeyMasked: maskApiKey(req.apiKey),
    jsonMode: !!req.jsonMode,
    messageCount: messages.length,
    bodyChars: JSON.stringify(body).length,
  });

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${req.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    clearTimeout(timer);

    console.log('[BYOK-AI] callOpenAiCompatible ← response', {
      status: res.status,
      ok: res.ok,
      contentLength: res.headers.get('content-length'),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      console.log('[BYOK-AI] callOpenAiCompatible error body', text.slice(0, 500));
      return {
        ok: false,
        reason: 'http',
        status: res.status,
        message: text.slice(0, 800),
      };
    }
    const data: any = await res.json();
    const content: string = data?.choices?.[0]?.message?.content?.trim() ?? '';
    console.log('[BYOK-AI] callOpenAiCompatible success', {
      model: data?.model,
      contentLen: content.length,
      usage: data?.usage,
      contentPreview: content.slice(0, 200),
    });
    if (!content) return { ok: false, reason: 'empty' };
    return {
      ok: true,
      text: content,
      raw: content,
      usage: data?.usage,
    };
  } catch (e: any) {
    clearTimeout(timer);
    if (e?.name === 'AbortError') {
      console.log('[BYOK-AI] callOpenAiCompatible TIMEOUT after 25s');
      return { ok: false, reason: 'timeout' };
    }
    console.log('[BYOK-AI] callOpenAiCompatible network error', e?.message ?? String(e));
    return { ok: false, reason: 'network', message: e?.message ?? String(e) };
  }
}
