/**
 * Volcengine TTS Client (Android only — 直连 REST,不经过任何 dev proxy)
 *
 * - speaker === TTS_SYSTEM_VOICE: 走设备自带 TTS 引擎 (expo-speech),不消耗配额
 * - 否则: Native 调用 Volcengine 单向流式 HTTP TTS (doc 6561/2528925),
 *   流式读 chunked JSON lines 累积 base64 → expo-av 播放
 *
 * Doc: https://www.volcengine.com/docs/6561/2528925?lang=zh
 */

import * as Speech from 'expo-speech';
import {
  VOLC_APP_ID,
  VOLC_ACCESS_TOKEN,
  VOLC_TTS_API_KEY,
  VOLC_TTS_SPEAKER,
  VOLC_TTS_URL,
  VOLC_TTS_RESOURCE_ID,
} from './config';
import { writeAsStringAsync, cacheDirectory, EncodingType } from 'expo-file-system/legacy';
import { consumeAndNotify } from '../quota';

/**
 * Sentinel voice id for the device's built-in TTS engine.
 * When the user picks this, `speakWithVolcTTS` routes to expo-speech
 * (native) or the browser speechSynthesis (web) — bypassing the
 * Volcengine API entirely, so no quota is consumed and no network
 * round-trip happens.
 */
export const TTS_SYSTEM_VOICE = '__system_default__';

export function isSystemTTSVoice(voiceId: string | undefined | null): boolean {
  return voiceId === TTS_SYSTEM_VOICE;
}

// ─── Web 路径已全部删除 (app 仅支持 Android 原生) ─────────────────────────

/** Registered listener receives RMS volume [0..1] while audio plays, 0 when silent. */
export let onLipSyncVolume: ((volume: number) => void) | null = null;

export function setLipSyncVolumeCallback(cb: ((volume: number) => void) | null) {
  onLipSyncVolume = cb;
}

// ─── Speech rate mapping (UI 0.5-2.0 → API -50..100) ──────────────────────
// 2528925 接口 speech_rate 是 int 范围 [-50, 100],其中 100=2.0x, -50=0.5x.
// 0.7→-30, 0.85→-15, 1.0→0, 1.2→20, 1.5→50。
const SPEECH_RATE_MAP: Record<number, number> = { 0.7: -30, 0.85: -15, 1.0: 0, 1.2: 20, 1.5: 50 };
function toSpeechRate(speedRatio: number): number {
  if (SPEECH_RATE_MAP[speedRatio] !== undefined) return SPEECH_RATE_MAP[speedRatio];
  return Math.round((Math.max(0.5, Math.min(2.0, speedRatio)) - 1.0) * 100);
}

let currentNativeSound: any = null;
let nativeLipSyncInterval: ReturnType<typeof setInterval> | null = null;

function stopCurrentNativeAudio() {
  if (nativeLipSyncInterval) { clearInterval(nativeLipSyncInterval); nativeLipSyncInterval = null; }
  if (onLipSyncVolume) onLipSyncVolume(0);
  if (currentNativeSound) {
    try { currentNativeSound.stopAsync().catch(() => {}); currentNativeSound.unloadAsync().catch(() => {}); } catch { /* ignore */ }
    currentNativeSound = null;
  }
}

function startNativeLipSync(sound: any) {
  if (nativeLipSyncInterval) { clearInterval(nativeLipSyncInterval); nativeLipSyncInterval = null; }
  // Android MediaPlayer does not support audio metering.
  // Use position-based sinusoidal simulation to drive mouth animation.
  nativeLipSyncInterval = setInterval(async () => {
    try {
      const status = await sound.getStatusAsync();
      if (!status.isLoaded || status.didJustFinish || !status.isPlaying) {
        if (onLipSyncVolume) onLipSyncVolume(0);
        if (nativeLipSyncInterval) { clearInterval(nativeLipSyncInterval); nativeLipSyncInterval = null; }
        return;
      }
      const t = (status.positionMillis ?? 0) / 1000;
      // Layered sine waves to approximate natural speech rhythm
      const v = Math.max(0, 0.45 + 0.45 * Math.sin(t * 12.0) + 0.1 * Math.sin(t * 27.3 + 1.2));
      if (onLipSyncVolume) onLipSyncVolume(v);
    } catch { /* ignore */ }
  }, 50);
}

// ─── Native: Volcengine 单向流式 HTTP (doc 6561/2528925) ─────────────────

function generateRequestId(): string {
  // RN 不一定支持 crypto.randomUUID,用 Math.random 拼一个 UUID 形式的字符串
  // (服务端的 X-Api-Request-Id 只需要唯一标识,不要求是 v4 UUID)
  const r = () => Math.random().toString(16).slice(2, 10);
  return `${r()}-${r().slice(0, 4)}-${r().slice(0, 4)}-${r().slice(0, 4)}-${r()}${r().slice(0, 4)}`;
}

async function speakNativeVolcChunked(text: string, speaker: string, speedRatio = 1.0): Promise<void> {
  // 鉴权:优先用 X-Api-Key (控制台 API Key 管理签发),fallback 旧版 Bearer
  // 用 access_token。注意 X-Api-Key ≠ access_token,二者是两套独立机制 —
  // 用 access_token 当 X-Api-Key 会触发服务端 45000010 "Invalid X-Api-Key"。
  const useApiKey = !!VOLC_TTS_API_KEY.trim();
  const authMode = useApiKey ? 'X-Api-Key' : 'Bearer';
  if (!useApiKey) {
    console.warn('[VolcTTS][HTTP] VOLC_TTS_API_KEY 未配置,fallback 到旧版 Bearer 鉴权 (access_token)。' +
      '强烈建议从控制台>API Key管理拿 key 填入 config.ts:VOLC_TTS_API_KEY — 用 access_token 当 X-Api-Key ' +
      '会报 45000010 Invalid X-Api-Key,用旧版 Bearer 鉴权可能也会被部分服务拒绝。');
  }

  const requestId = generateRequestId();
  const body = {
    req_params: {
      text,
      speaker,
      audio_params: {
        format:       'mp3',
        sample_rate:  24000,
        speech_rate:  toSpeechRate(speedRatio),
      },
    },
  };

  const headers: Record<string, string> = {
    'Content-Type':      'application/json',
    'X-Api-Resource-Id': VOLC_TTS_RESOURCE_ID,
    'X-Api-Request-Id':  requestId,
  };
  if (useApiKey) {
    headers['X-Api-Key'] = VOLC_TTS_API_KEY.trim();
  } else {
    headers['Authorization'] = `Bearer;${VOLC_ACCESS_TOKEN}`;
  }

  console.log('[VolcTTS][HTTP] request', {
    url: VOLC_TTS_URL,
    appId: VOLC_APP_ID,
    resourceId: VOLC_TTS_RESOURCE_ID,
    speaker,
    speedRatio,
    speechRate: toSpeechRate(speedRatio),
    textPreview: text.slice(0, 120),
    textLen: text.length,
    requestId,
    authMode,
  });

  const resp = await fetch(VOLC_TTS_URL, {
    method:  'POST',
    headers,
    body: JSON.stringify(body),
  });

  console.log('[VolcTTS][HTTP] response', {
    url: VOLC_TTS_URL,
    status: resp.status,
    ok: resp.ok,
    contentType: resp.headers.get('content-type') || '(none)',
  });

  if (!resp.ok) {
    const errText = await resp.text();
    console.error('[VolcTTS][HTTP] HTTP error', {
      status: resp.status,
      bodyPreview: errText.slice(0, 800),
      bodyLen: errText.length,
    });
    throw new Error(`Volcengine TTS HTTP ${resp.status}: ${errText.slice(0, 300)}`);
  }

  // 2528925 响应是 chunked NDJSON:每个非空行是一个 JSON object
  //  - { code: 0, data: <base64 audio chunk>, sentence: { words: [...] } } 流式帧
  //  - { code: 20000000, usage: { text_words: N } } 结束帧
  //  - { code: >0, message: "..." } 错误帧
  const raw = await resp.text();
  const audioParts: string[] = [];
  const lineErrors: Array<{ line: string; error: string }> = [];
  let finalCode: number | null = null;
  let textWords: number | null = null;

  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed) as {
        code: number;
        data?: string;
        message?: string;
        usage?: { text_words?: number };
        sentence?: { text?: string; words?: Array<{ word: string; startTime: number; endTime: number }> };
      };
      if (obj.code === 0) {
        if (obj.data) audioParts.push(obj.data);
      } else if (obj.code === 20000000) {
        finalCode = obj.code;
        textWords = obj.usage?.text_words ?? null;
        break;
      } else {
        lineErrors.push({ line: trimmed.slice(0, 200), error: `code=${obj.code} msg=${obj.message || '(none)'}` });
      }
    } catch (parseErr) {
      lineErrors.push({ line: trimmed.slice(0, 200), error: `JSON parse: ${(parseErr as Error).message}` });
    }
  }

  console.log('[VolcTTS][HTTP] parsed', {
    audioChunks: audioParts.length,
    totalAudioBytes: audioParts.reduce((sum, p) => sum + p.length, 0),
    lineErrors: lineErrors.length,
    lineErrorSample: lineErrors.slice(0, 3),
    finalCode,
    textWords,
    rawPreview: raw.slice(0, 400),
    rawLen: raw.length,
  });

  if (audioParts.length === 0) {
    throw new Error(`TTS returned no audio data (lineErrors=${lineErrors.length})`);
  }

  const combined = audioParts.join('');
  const path = `${cacheDirectory}volc_tts_${Date.now()}.mp3`;
  await writeAsStringAsync(path, combined, { encoding: EncodingType.Base64 });

  stopCurrentNativeAudio();
  const { Audio } = await import('expo-av');
  const { sound } = await Audio.Sound.createAsync({ uri: path });
  currentNativeSound = sound;
  await sound.setStatusAsync({ isMeteringEnabled: true } as any);
  await sound.playAsync();
  startNativeLipSync(sound);
  await new Promise<void>(resolve => {
    sound.setOnPlaybackStatusUpdate((status: any) => {
      if (status.isLoaded && status.didJustFinish) {
        if (nativeLipSyncInterval) { clearInterval(nativeLipSyncInterval); nativeLipSyncInterval = null; }
        if (onLipSyncVolume) onLipSyncVolume(0);
        sound.unloadAsync().catch(() => {});
        currentNativeSound = null;
        resolve();
      }
    });
  });
}

// ─── System TTS (device built-in engine) ───────────────────────────────────

/**
 * Speak `text` using the device's built-in TTS engine.
 *
 * No network round-trip, no Volcengine quota consumed. The lip-sync
 * envelope is synthesised from elapsed time (layered sine waves), the
 * same approximation used by the Android Volcengine path (Android
 * MediaPlayer does not expose audio metering).
 */
async function speakSystemTTS(text: string, speedRatio = 1.0): Promise<void> {
  // expo-speech rate range is 0.5-2.0; our UI speedRatio lives in 0.7-1.5
  // — the clamp is a no-op for normal values but defends against bad
  // persisted values.
  const rate = Math.max(0.5, Math.min(2.0, speedRatio));

  // Rough duration estimate for the safety-timeout fallback only.
  // ~80ms per char for English; never let it go below 1.5s so a single
  // word still has a visible mouth cycle.
  const estMs = Math.max(1500, text.length * 80);
  const startTime = Date.now();

  console.log('[VolcTTS][SystemTTS] enter', {
    textPreview: text.slice(0, 80),
    textLen: text.length,
    speedRatio,
    rate,
    estMs,
  });

  // 探测:Android 模拟器经常没装 TTS 引擎,导致 getAvailableVoicesAsync
  // 永远 pending,卡住整个 speakSystemTTS 流程 → Speech.speak 永远不调用。
  // 用 Promise.race 加 1.5s 超时,不让探测阻塞主流程。
  const VOICE_PROBE_TIMEOUT_MS = 1500;
  const voiceProbe = (async () => {
    try {
      const voices = await Speech.getAvailableVoicesAsync();
      const enVoices = (voices || []).filter((v: any) => v?.language?.startsWith('en'));
      console.log('[VolcTTS][SystemTTS] available voices', {
        totalCount: (voices || []).length,
        enCount: enVoices.length,
        enVoices: enVoices.slice(0, 5).map((v: any) => ({
          id: v.id, name: v.name, language: v.language, quality: v.quality,
        })),
      });
      return voices;
    } catch (voiceErr) {
      console.error('[VolcTTS][SystemTTS] getAvailableVoicesAsync failed', {
        error: (voiceErr as Error)?.message,
      });
      return null;
    }
  })();
  const voiceTimeout = new Promise<null>((resolve) =>
    setTimeout(() => {
      console.warn('[VolcTTS][SystemTTS] voice probe timeout (likely TTS engine missing on emulator)', {
        timeoutMs: VOICE_PROBE_TIMEOUT_MS,
      });
      resolve(null);
    }, VOICE_PROBE_TIMEOUT_MS),
  );
  await Promise.race([voiceProbe, voiceTimeout]);

  // 探测:isSpeaking 状态(Android expo-speech 在部分版本上没这 API)
  try {
    if ((Speech as any).isSpeakingAsync) {
      const speaking = await Promise.race([
        (Speech as any).isSpeakingAsync(),
        new Promise((r) => setTimeout(() => r(null), 500)),
      ]);
      console.log('[VolcTTS][SystemTTS] pre-speak isSpeaking', { speaking });
    }
  } catch (e) {
    /* noop */
  }

  // Time-based layered sine waves for the mouth envelope.
  // Reuses `nativeLipSyncInterval` so `stopCurrentNativeAudio()` clears it
  // automatically (it's called by `stopCurrentTTS` on both platforms).
  if (nativeLipSyncInterval) { clearInterval(nativeLipSyncInterval); nativeLipSyncInterval = null; }
  const tick = () => {
    const elapsed = (Date.now() - startTime) / 1000;
    const v = Math.max(0, 0.45 + 0.45 * Math.sin(elapsed * 12.0) + 0.1 * Math.sin(elapsed * 27.3 + 1.2));
    if (onLipSyncVolume) onLipSyncVolume(v);
  };
  tick(); // open the mouth immediately so it doesn't lag the audio by ~50ms
  nativeLipSyncInterval = setInterval(tick, 50);
  console.log('[VolcTTS][SystemTTS] lipSync interval started', { intervalMs: 50 });

  // Stop anything currently in flight before starting fresh.
  try {
    Speech.stop();
    console.log('[VolcTTS][SystemTTS] Speech.stop() called');
  } catch (stopErr) {
    console.warn('[VolcTTS][SystemTTS] Speech.stop() failed', {
      error: (stopErr as Error)?.message,
    });
  }

  await new Promise<void>((resolve) => {
    let settled = false;
    const settle = (source: string) => {
      if (settled) return;
      settled = true;
      const elapsedMs = Date.now() - startTime;
      console.log('[VolcTTS][SystemTTS] settled', {
        source,
        elapsedMs,
        textLen: text.length,
      });
      if (nativeLipSyncInterval) { clearInterval(nativeLipSyncInterval); nativeLipSyncInterval = null; }
      if (onLipSyncVolume) onLipSyncVolume(0);
      resolve();
    };

    const speakOptions = {
      language: 'en-US',
      rate,
      pitch: 1.0,
      onDone: () => settle('onDone'),
      onStopped: () => settle('onStopped'),
      onError: (err: any) => {
        console.error('[VolcTTS][SystemTTS] Speech.speak onError', {
          error: err?.message ?? String(err),
          code: err?.code,
          stack: err?.stack?.split('\n')?.slice(0, 3)?.join('\n'),
        });
        settle('onError');
      },
    };

    console.log('[VolcTTS][SystemTTS] calling Speech.speak', {
      textLen: text.length,
      language: speakOptions.language,
      rate: speakOptions.rate,
      pitch: speakOptions.pitch,
    });
    try {
      Speech.speak(text, speakOptions);
      console.log('[VolcTTS][SystemTTS] Speech.speak returned (sync, no throw)');
    } catch (speakErr) {
      console.error('[VolcTTS][SystemTTS] Speech.speak threw sync', {
        error: (speakErr as Error)?.message,
        stack: (speakErr as Error)?.stack?.split('\n')?.slice(0, 5)?.join('\n'),
      });
      settle('sync_throw');
    }

    // Safety net: some web browsers never fire onError when speechSynthesis
    // is disabled by user policy, leaving the promise hanging forever.
    setTimeout(() => {
      if (!settled) {
        console.warn('[VolcTTS][SystemTTS] safety timeout fired (no callback in estMs+500ms)', {
          estMs: estMs + 500,
          actualElapsedMs: Date.now() - startTime,
        });
        settle('safety_timeout');
      }
    }, estMs + 500);
  });
}

// ─── Public API ────────────────────────────────────────────────────────────

/** Stop any currently playing TTS immediately. */
export function stopCurrentTTS() {
  stopCurrentNativeAudio();
  // Stop expo-speech (the system TTS path uses it on every platform).
  try { Speech.stop(); } catch { /* ignore */ }
}

/**
 * Quota-aware wrapper around `speakWithVolcTTS`.
 *
 * Use this for any user-initiated TTS that ISN'T already inside a
 * `consumeAndNotify('tts')` block (e.g. NPC auto-reply, shadowing reply).
 * For those, the caller manages the verdict itself and the Live2D
 * `isTtsSpeaking` state, so they should keep the inline pattern.
 *
 * Behavior:
 *   - System voice (`__system_default__`): speaks for free, returns true.
 *     expo-speech is offline / device-built-in, no network, no quota cost.
 *   - Third-party voice: charges 1 TTS unit first. If the daily hard cap is
 *     hit, returns false silently (matches "用完只是不能听" — the text on
 *     screen is unaffected). If allowed, calls the underlying
 *     `speakWithVolcTTS` and returns true on success.
 *
 * Returns `true` only when audio actually started playing (system spoke
 * OR third-party quota + speak both succeeded).
 */
export async function speakTextWithQuota(
  text: string,
  voice: string,
  speedRatio = 1.0,
): Promise<boolean> {
  if (!text.trim()) return false;
  // System TTS: free, offline, no quota cost.
  if (isSystemTTSVoice(voice)) {
    try {
      await speakSystemTTS(text, speedRatio);
    } catch (err) {
      console.warn('[VolcTTS] system TTS error:', err);
    }
    return true;
  }
  // Third-party TTS: consume one quota unit first.
  const verdict = await consumeAndNotify('tts');
  if (!verdict.allowed) {
    console.log('[VolcTTS] TTS quota exhausted, skipping speak', {
      field: verdict.field,
      tier: verdict.tier,
      used: verdict.used,
      hard: verdict.hard,
    });
    return false;
  }
  try {
    await speakWithVolcTTS(text, voice, speedRatio);
    return true;
  } catch (err) {
    // speakWithVolcTTS already logs + falls back to system TTS internally.
    return false;
  }
}

/**
 * Synthesise `text` with TTS and play it.
 *
 * - speaker === TTS_SYSTEM_VOICE: device built-in engine, free, offline.
 * - Otherwise: calls Volcengine 单向流式 HTTP TTS (doc 6561/2528925)
 *   directly, plays the streamed audio via expo-av.
 */
export async function speakWithVolcTTS(
  text: string,
  speaker: string = VOLC_TTS_SPEAKER,
  speedRatio = 1.0,
  pitchRatio = 1.0,  // 2528925 不直接支持 pitch,保留参数以兼容旧调用方
): Promise<void> {
  if (!text.trim()) return;
  // System TTS: bypass Volcengine entirely — no network, no quota cost.
  if (isSystemTTSVoice(speaker)) {
    try {
      await speakSystemTTS(text, speedRatio);
    } catch (err) {
      console.warn('[VolcTTS] system TTS error:', err);
    }
    return;
  }
  console.log('[VolcTTS] speakWithVolcTTS', {
    speaker,
    speedRatio,
    pitchRatio,
    textPreview: text.slice(0, 120),
    textLen: text.length,
  });
  try {
    await speakNativeVolcChunked(text, speaker, speedRatio);
  } catch (err) {
    console.error('[VolcTTS] HTTP TTS error', {
      speaker,
      textPreview: text.slice(0, 120),
      textLen: text.length,
      errorName: (err as Error)?.name,
      errorMessage: (err as Error)?.message,
      errorStack: (err as Error)?.stack?.split('\n').slice(0, 8).join('\n'),
    });
    // 失败时回退到系统 TTS,保证 app 还能出声
    try {
      await speakSystemTTS(text, speedRatio);
    } catch (fallbackErr) {
      console.error('[VolcTTS] system TTS fallback also failed', {
        textPreview: text.slice(0, 120),
        errorMessage: (fallbackErr as Error)?.message,
      });
    }
  }
}
