/**
 * BYOK — Bring Your Own Key.
 *
 * Lets the user plug in their own AI provider key (OpenAI / Anthropic /
 * DeepSeek / Doubao / Zhipu / custom) and have all NPC chat completions
 * billed to them, bypassing NativeOS's quota. ASR / TTS are intentionally
 * left on the shared path (each vendor's streaming protocol is too
 * different to be worth maintaining N adapters).
 *
 * Storage:
 *   - Single row in the existing `app_config` table under key 'byok_config'.
 *   - The API key is base64-encoded before write. This is **obfuscation,
 *     not encryption** — it stops a casual clipboard sniff, nothing more.
 *     Real protection would require a native keystore binding (out of
 *     scope for v1). The doc explicitly tells the user this.
 *   - Same scheme as `lib/user-profile.ts` so we don't need a schema
 *     migration.
 *
 * Quota interaction:
 *   - When BYOK is enabled, `lib/ai/npc-chat.ts` calls the user's adapter
 *     instead of the shared Qwen proxy.
 *   - The caller (immersive page) skips the `consumeAndNotify('ai_rounds')`
 *     charge via `isByokEnabled()`.
 *   - We do NOT mutate the local daily counter — BYOK usage is invisible
 *     to the quota UI.
 *
 * Provider list (preset) — all presets except `anthropic` use the
 * OpenAI Chat Completions wire format. Doubao / DeepSeek / Zhipu /
 * Moonshot / Tongyi / Qianfan all expose an OpenAI-compatible endpoint
 * so one adapter covers them.
 */

import { Platform } from 'react-native';
import { ensureDatabaseInitialized, getDatabase } from './database';

const STORAGE_KEY = 'byok_config';

export type ByokProviderId =
  | 'openai'
  | 'anthropic'
  | 'deepseek'
  | 'doubao'
  | 'zhipu'
  | 'moonshot'
  | 'custom';

export interface ByokProviderPreset {
  id: ByokProviderId;
  label: string;
  /** Wire format. openai = Chat Completions; anthropic = Messages API. */
  wire: 'openai' | 'anthropic';
  baseUrl: string;
  defaultModel: string;
  placeholderKeyPrefix?: string;
}

export const BYOK_PROVIDERS: Record<ByokProviderId, ByokProviderPreset> = {
  openai: {
    id: 'openai',
    label: 'OpenAI',
    wire: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-4o-mini',
    placeholderKeyPrefix: 'sk-...',
  },
  anthropic: {
    id: 'anthropic',
    label: 'Anthropic',
    wire: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    defaultModel: 'claude-3-5-sonnet-latest',
    placeholderKeyPrefix: 'sk-ant-...',
  },
  deepseek: {
    id: 'deepseek',
    label: 'DeepSeek',
    wire: 'openai',
    baseUrl: 'https://api.deepseek.com/v1',
    defaultModel: 'deepseek-chat',
  },
  doubao: {
    id: 'doubao',
    label: '火山豆包 (Ark)',
    wire: 'openai',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    defaultModel: 'doubao-1-5-pro-32k-250115',
  },
  zhipu: {
    id: 'zhipu',
    label: '智谱 GLM',
    wire: 'openai',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    defaultModel: 'glm-4-flash',
  },
  moonshot: {
    id: 'moonshot',
    label: 'Moonshot Kimi',
    wire: 'openai',
    baseUrl: 'https://api.moonshot.cn/v1',
    defaultModel: 'moonshot-v1-8k',
  },
  custom: {
    id: 'custom',
    label: '自定义 (OpenAI 兼容)',
    wire: 'openai',
    baseUrl: '',
    defaultModel: '',
  },
};

export interface ByokConfig {
  /** Total kill switch. When false, even if apiKey is set, use shared. */
  enabled: boolean;
  provider: ByokProviderId;
  /** base64-encoded api key (obfuscation, not encryption — see header). */
  apiKeyB64: string;
  /** baseUrl — for preset, copied from preset; for custom, user-supplied. */
  baseUrl: string;
  model: string;
  updatedAt: number;
}

export const DEFAULT_BYOK_CONFIG: ByokConfig = {
  enabled: false,
  provider: 'openai',
  apiKeyB64: '',
  baseUrl: BYOK_PROVIDERS.openai.baseUrl,
  model: BYOK_PROVIDERS.openai.defaultModel,
  updatedAt: 0,
};

// ── Obfuscation helpers ────────────────────────────────────────────
//
// We use a small dependency-free base64 codec instead of Buffer / global.btoa.
// Why not Buffer?  RN 0.79+ removed the default Buffer polyfill. The `buffer`
// npm package would have to be installed and a global assigned, which is
// friction for a v1 storage layer. Why not global.btoa/atob? Those work
// but only on Latin-1; non-ASCII characters throw. The codec below is
// safe for the entire BMP (sufficient for API keys, which are ASCII).
//
// This is **obfuscation, not encryption** — anyone with adb pull and a
// SQLite browser can read the key. The UI explicitly tells the user
// this. Real protection would require a native keystore binding
// (expo-secure-store + a native module), out of scope for v1.

const B64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function utf8ToCodePoints(s: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < s.length; i++) {
    let c = s.charCodeAt(i);
    if (c < 0x80) {
      out.push(c);
    } else if (c < 0x800) {
      out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
    } else if (c >= 0xd800 && c < 0xdc00) {
      // Surrogate pair
      const lo = s.charCodeAt(++i);
      c = 0x10000 + ((c & 0x3ff) << 10) + (lo & 0x3ff);
      out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 0x3f), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    } else {
      out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    }
  }
  return out;
}

function codePointsToUtf8(bytes: number[]): string {
  let out = '';
  let i = 0;
  while (i < bytes.length) {
    const b1 = bytes[i++];
    if (b1 < 0x80) {
      out += String.fromCharCode(b1);
    } else if (b1 < 0xe0) {
      const b2 = bytes[i++] & 0x3f;
      out += String.fromCharCode(((b1 & 0x1f) << 6) | b2);
    } else if (b1 < 0xf0) {
      const b2 = bytes[i++] & 0x3f;
      const b3 = bytes[i++] & 0x3f;
      out += String.fromCharCode(((b1 & 0x0f) << 12) | (b2 << 6) | b3);
    } else {
      const b2 = bytes[i++] & 0x3f;
      const b3 = bytes[i++] & 0x3f;
      const b4 = bytes[i++] & 0x3f;
      let cp = ((b1 & 0x07) << 18) | (b2 << 12) | (b3 << 6) | b4;
      cp -= 0x10000;
      out += String.fromCharCode(0xd800 + (cp >> 10), 0xdc00 + (cp & 0x3ff));
    }
  }
  return out;
}

function encodeObfuscated(plain: string): string {
  if (!plain) return '';
  const bytes = utf8ToCodePoints(plain);
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b1 = bytes[i];
    const b2 = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const b3 = i + 2 < bytes.length ? bytes[i + 2] : 0;
    out += B64_ALPHABET[b1 >> 2];
    out += B64_ALPHABET[((b1 & 0x03) << 4) | (b2 >> 4)];
    out += i + 1 < bytes.length ? B64_ALPHABET[((b2 & 0x0f) << 2) | (b3 >> 6)] : '=';
    out += i + 2 < bytes.length ? B64_ALPHABET[b3 & 0x3f] : '=';
  }
  return out;
}

function decodeObfuscated(b64: string): string {
  if (!b64) return '';
  // Strip whitespace; tolerate missing padding.
  const clean = b64.replace(/[\s=]/g, '');
  if (!clean) return '';
  const lookup: Record<string, number> = {};
  for (let i = 0; i < B64_ALPHABET.length; i++) lookup[B64_ALPHABET[i]] = i;
  const bytes: number[] = [];
  for (let i = 0; i < clean.length; i += 4) {
    const c1 = lookup[clean[i]] ?? 0;
    const c2 = lookup[clean[i + 1]] ?? 0;
    const c3 = clean[i + 2] != null ? lookup[clean[i + 2]] ?? -1 : -1;
    const c4 = clean[i + 3] != null ? lookup[clean[i + 3]] ?? -1 : -1;
    bytes.push((c1 << 2) | (c2 >> 4));
    if (c3 >= 0) bytes.push(((c2 & 0x0f) << 4) | (c3 >> 2));
    if (c4 >= 0) bytes.push(((c3 & 0x03) << 6) | c4);
  }
  return codePointsToUtf8(bytes);
}

// ── Storage I/O ────────────────────────────────────────────────────

async function readRow(): Promise<ByokConfig | null> {
  if (Platform.OS === 'web') return null;
  await ensureDatabaseInitialized();
  const db = await getDatabase();
  const row: any = await db.getFirstAsync(
    'SELECT value_json FROM app_config WHERE key = ?',
    [STORAGE_KEY],
  );
  if (!row?.value_json) return null;
  try {
    return JSON.parse(row.value_json) as ByokConfig;
  } catch {
    return null;
  }
}

async function writeRow(cfg: ByokConfig): Promise<void> {
  if (Platform.OS === 'web') return;
  await ensureDatabaseInitialized();
  const db = await getDatabase();
  await db.runAsync(
    `INSERT INTO app_config (key, value_json, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
    [STORAGE_KEY, JSON.stringify(cfg), Date.now()],
  );
}

// ── Public surface ─────────────────────────────────────────────────

export async function getByokConfig(): Promise<ByokConfig> {
  if (Platform.OS === 'web') return { ...DEFAULT_BYOK_CONFIG };
  const stored = await readRow();
  if (!stored) return { ...DEFAULT_BYOK_CONFIG };
  // Backfill baseUrl / model if user upgraded the app and the preset
  // changed since they last saved.
  const preset = BYOK_PROVIDERS[stored.provider];
  return {
    ...stored,
    baseUrl: stored.baseUrl || preset.baseUrl,
    model: stored.model || preset.defaultModel,
  };
}

export async function saveByokConfig(cfg: ByokConfig): Promise<void> {
  await writeRow(cfg);
}

export async function clearByokConfig(): Promise<void> {
  if (Platform.OS === 'web') return;
  const db = await getDatabase();
  await db.runAsync('DELETE FROM app_config WHERE key = ?', [STORAGE_KEY]);
}

/**
 * The effective config to use for a chat completion call. Returns
 * `null` when BYOK is disabled, the key is empty, the preset is
 * unknown, or the user is not Pro — the caller should fall back to
 * the shared NativeOS path.
 *
 * BYOK is a Pro-only feature. Free users who have a stored config
 * still get null here so the AI call goes through the shared quota
 * path; their config is preserved on disk and re-activated the moment
 * they upgrade (no re-entry needed). This is the single chokepoint
 * for the gate — `isByokEnabled()` calls through this.
 *
 * Dynamic import of `./quota` to break the import cycle (quota.ts
 * also lazy-imports byok.ts for `isByokEnabled`).
 */
export async function getActiveByok(): Promise<ByokConfig | null> {
  if (Platform.OS === 'web') return null;
  // ── Pro gate ────────────────────────────────────────────────────
  try {
    const { isProNow } = await import('./quota');
    const pro = await isProNow();
    if (!pro) return null;
  } catch {
    // If quota check fails (db not ready etc.), be safe and block BYOK
    return null;
  }
  // ── Stored config validity ──────────────────────────────────────
  const cfg = await getByokConfig();
  if (!cfg.enabled) return null;
  const apiKey = decodeObfuscated(cfg.apiKeyB64);
  if (!apiKey) return null;
  if (!BYOK_PROVIDERS[cfg.provider]) return null;
  if (!cfg.baseUrl || !cfg.model) return null;
  return { ...cfg, apiKeyB64: apiKey /* expose plaintext for adapters */ };
}

/**
 * Lightweight boolean — used by the quota skip path in immersive/[id].tsx
 * and by the userCard chip on the profile tab.
 */
export async function isByokEnabled(): Promise<boolean> {
  const cfg = await getActiveByok();
  return cfg != null;
}

// ── Encoded/decode helpers (for the UI to read/write the key field) ──

export function encodeKey(plain: string): string {
  return encodeObfuscated(plain);
}

export function decodeKey(b64: string): string {
  return decodeObfuscated(b64);
}

// ── Test ping (verifies the key is valid before saving) ─────────────

/**
 * Send a single tiny completion to verify the key works. Returns
 * `{ok: true}` on 200, `{ok: false, reason}` on failure.
 *
 * Cost: ~50 input tokens. We do not call this automatically — the UI
 * exposes a "测试连接" button.
 */
export async function testByokConnection(cfg: ByokConfig): Promise<
  { ok: true; model: string } | { ok: false; reason: string; status?: number }
> {
  console.log('[BYOK] testByokConnection received', {
    provider: cfg.provider,
    enabled: cfg.enabled,
    apiKeyB64_len: cfg.apiKeyB64.length,
    apiKeyB64_preview: cfg.apiKeyB64.slice(0, 16),
    baseUrl: cfg.baseUrl,
    model: cfg.model,
  });
  const apiKey = decodeObfuscated(cfg.apiKeyB64);
  console.log('[BYOK] decoded apiKey length', apiKey.length, 'preview', apiKey.slice(0, 8));
  if (!apiKey) return { ok: false, reason: 'empty_key' };
  const preset = BYOK_PROVIDERS[cfg.provider];
  if (!preset) return { ok: false, reason: 'unknown_provider' };
  const baseUrl = cfg.baseUrl || preset.baseUrl;
  const model = cfg.model || preset.defaultModel;
  if (!baseUrl) return { ok: false, reason: 'empty_base_url' };
  if (!model) return { ok: false, reason: 'empty_model' };

  try {
    if (preset.wire === 'anthropic') {
      const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/v1/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true',
        },
        body: JSON.stringify({
          model,
          max_tokens: 8,
          messages: [{ role: 'user', content: 'ping' }],
        }),
      });
      if (res.ok) return { ok: true, model };
      const text = await res.text().catch(() => '');
      return { ok: false, reason: text || `http_${res.status}`, status: res.status };
    }
    // OpenAI-compatible
    const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 8,
      }),
    });
    if (res.ok) return { ok: true, model };
    const text = await res.text().catch(() => '');
    return { ok: false, reason: text || `http_${res.status}`, status: res.status };
  } catch (e: any) {
    return { ok: false, reason: e?.message ?? 'network_error' };
  }
}
