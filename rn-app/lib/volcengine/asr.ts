/**
 * Volcengine Streaming ASR (大模型流式语音识别) WebSocket Client
 * Doc: https://www.volcengine.com/docs/6561/1354869
 *
 * Protocol: binary V3, sequence-based
 * URL: wss://openspeech.bytedance.com/api/v3/sauc/bigmodel
 * Audio: raw PCM, 16 kHz, 16-bit, mono, streamed in chunks
 *
 * Native: records via expo-av, reads as base64, submits directly to Volcengine HTTP ASR (no proxy).
 */

import { Platform } from 'react-native';
import { PermissionsAndroid } from 'react-native';
import { readAsStringAsync, EncodingType } from 'expo-file-system/legacy';
import { VOLC_APP_ID, VOLC_ACCESS_TOKEN } from './config';
import { analyzeAsrTranscript, type AsrMeta } from '../speech/asr-postprocess';

// Pure-JS base64 → Uint8Array (works in RN without Buffer/atob polyfill)
function base64ToBytes(b64: string): Uint8Array {
  const table = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const str = b64.replace(/=+$/, '');
  const out = new Uint8Array(Math.floor(str.length * 3 / 4));
  let idx = 0;
  for (let i = 0; i < str.length; i += 4) {
    const a = table.indexOf(str[i]),     b = table.indexOf(str[i + 1]);
    const c = table.indexOf(str[i + 2]), d = table.indexOf(str[i + 3]);
    out[idx++] = (a << 2) | (b >> 4);
    if (c !== -1) out[idx++] = ((b & 0xf) << 4) | (c >> 2);
    if (d !== -1) out[idx++] = ((c & 0x3) << 6) | d;
  }
  return out.slice(0, idx);
}

// ─── Protocol constants ────────────────────────────────────────────────────
const PROTO_VER = 0b0001;
const HDR_SIZE  = 0b0001; // header = 4 bytes

const MSG_FULL_CLIENT  = 0b0001;
const MSG_AUDIO_ONLY   = 0b0010;
const MSG_FULL_SERVER  = 0b1001;
const MSG_SERVER_ACK   = 0b1011;

const FLAG_POS_SEQ  = 0b0001; // has positive sequence number
const FLAG_NEG_LAST = 0b0011; // has sequence + is last packet

const SER_JSON = 0b0001;
const SER_NONE = 0b0000;
const CMP_NONE = 0b0000;

// ─── Binary helpers ────────────────────────────────────────────────────────
function makeHeader(msgType: number, flags: number, serial: number, comp: number): Uint8Array {
  return new Uint8Array([
    (PROTO_VER << 4) | HDR_SIZE,
    (msgType   << 4) | flags,
    (serial    << 4) | comp,
    0,
  ]);
}

function int32BE(n: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setInt32(0, n, false);
  return b;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

// RN WebSocket.send() only accepts string or ArrayBuffer, not Uint8Array
function toAB(u8: Uint8Array): ArrayBuffer {
  return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer;
}

// ─── Response parser ───────────────────────────────────────────────────────
interface ParsedASRResult {
  isLast: boolean;
  text: string | null;
}

function parseASRResponse(raw: ArrayBuffer): ParsedASRResult {
  const buf  = new Uint8Array(raw);
  const hdrBytes = (buf[0] & 0x0f) * 4;
  const msgType  = (buf[1] >> 4) & 0x0f;
  const flags    = buf[1] & 0x0f;
  const comp     = buf[2] & 0x0f;

  let off = hdrBytes;
  let isLast = false;

  if (flags & 0x01) off += 4;       // skip sequence number
  if (flags & 0x02) isLast = true;  // last package flag

  if (msgType === MSG_FULL_SERVER) {
    const dv      = new DataView(buf.buffer, buf.byteOffset + off, 4);
    const size    = dv.getInt32(0, false);
    const payload = buf.slice(off + 4, off + 4 + size);
    try {
      const json = JSON.parse(new TextDecoder().decode(payload));
      // Result path differs slightly across API versions
      const text: string | undefined =
        json?.result?.text ??
        json?.results?.[0]?.alternatives?.[0]?.transcript ??
        null;
      return { isLast, text: text ?? null };
    } catch {
      return { isLast, text: null };
    }
  }

  return { isLast, text: null };
}

// ─── Public API ────────────────────────────────────────────────────────────
export interface ASRResult {
  text: string;
  /** Object URL pointing to a WAV blob of the user's recording (web only). Revoke when done. */
  audioUrl: string | null;
  asrMeta?: AsrMeta;
}

export interface ASRHandle {
  /** Stop recording and return the final recognised text + audio URL (waits up to 600 ms). */
  stop: () => Promise<ASRResult>;
}

function buildASRResult(text: string, audioUrl: string | null): ASRResult {
  return {
    text,
    audioUrl,
    asrMeta: analyzeAsrTranscript(text),
  };
}

/**
 * Start a Volcengine streaming ASR session.
 *
 * - Web: opens WebSocket, captures microphone via AudioContext, streams PCM.
 * - Native: records via expo-av then uploads to /asr-upload proxy for transcription.
 *
 * @param onPartial  Called with partial transcription results while recording.
 * @param onError    Called if mic access or setup fails (web only).
 */
export function startVolcASR(onPartial: (text: string) => void, onError?: (err: Error) => void): ASRHandle {
  console.log('[VolcASR] startVolcASR called, platform:', Platform.OS);

  // ── Native: react-native-audio-record → PCM → WebSocket直连Volcengine ────
  // react-native-audio-record 录 PCM 16kHz 16bit mono，onData 实时回调 base64 PCM
  // Doc: https://www.volcengine.com/docs/6561/1354869
  if (Platform.OS !== 'web') {
    let finalText = '';
    let ws: WebSocket | null = null;
    let wsReady = false;
    let stopped = false;

    // UUID v4
    const seg = () => Math.floor((1 + Math.random()) * 0x10000).toString(16).slice(1);
    const reqId = `${seg()}${seg()}-${seg()}-${seg()}-${seg()}-${seg()}${seg()}${seg()}`;

    const wsUrl = `wss://openspeech.bytedance.com/api/v3/sauc/bigmodel`;
    // RN WebSocket supports custom headers via 3rd argument (unlike browser WebSocket)
    const wsHeaders = {
      'X-Api-App-Key':     VOLC_APP_ID,
      'X-Api-Access-Key':  VOLC_ACCESS_TOKEN,
      'X-Api-Resource-Id': 'volc.bigasr.sauc.duration',
      'X-Api-Request-Id':  reqId,
    };

    // Buffer to hold PCM chunks received before WS is ready
    const pcmQueue: Uint8Array[] = [];

    let audioSeq = 2;       // client seq: starts at 2 (1 used by full client request)
    let lastServerSeq = 0; // last seq seen in server responses
    let wsDone = false;
    let wsResolve: (() => void) | null = null;
    const wsClosedPromise = new Promise<void>(r => { wsResolve = r; });
    const flushQueue = () => {
      while (pcmQueue.length > 0 && ws?.readyState === WebSocket.OPEN) {
        const chunk = pcmQueue.shift()!;
        ws.send(toAB(concat(makeHeader(MSG_AUDIO_ONLY, FLAG_POS_SEQ, SER_NONE, CMP_NONE), int32BE(audioSeq++), int32BE(chunk.length), chunk)));
      }
    };

    try {
      ws = new (WebSocket as any)(wsUrl, [], { headers: wsHeaders }) as WebSocket;
      const _ws = ws as WebSocket;
      let seq = 1;
      let asrConnected = false;
      _ws.onopen = () => {
        console.log('[VolcASR] Native: WS connected, sending init packet');
        const params = JSON.stringify({
          user:  { uid: reqId },
          audio: { format: 'pcm', rate: 16000, bits: 16, channel: 1, codec: 'raw' },
        });
        const payload = new TextEncoder().encode(params);
        _ws.send(toAB(concat(
          makeHeader(MSG_FULL_CLIENT, FLAG_POS_SEQ, SER_JSON, CMP_NONE),
          int32BE(seq++),
          int32BE(payload.length),
          payload,
        )));
        console.log('[VolcASR] Native: init packet sent, waiting for server ack...');
      };
      _ws.onmessage = (e: any) => {
        const raw = e.data as ArrayBuffer;
        const buf = new Uint8Array(raw);
        const msgType = (buf[1] >> 4) & 0x0f;
        // Type 0b1111 = error from server
        if (msgType === 0b1111) {
          const errCode = new DataView(raw, 4, 4).getUint32(0, false);
          const errSize = new DataView(raw, 8, 4).getUint32(0, false);
          const errMsg = new TextDecoder().decode(new Uint8Array(raw, 12, errSize));
          console.warn(`[VolcASR] Native: SERVER ERROR code=${errCode} msg=${errMsg}`);
          return;
        }
        // Extract server sequence number (bytes 4-7 after 4-byte header)
        if (buf.length >= 8) {
          lastServerSeq = new DataView(raw, 4, 4).getInt32(0, false);
        }
        if (!asrConnected) {
          asrConnected = true;
          wsReady = true;
          console.log('[VolcASR] Native: server ack seq=' + lastServerSeq + ', starting PCM stream');
          flushQueue();
        }
        const parsed = parseASRResponse(raw);
        if (parsed.text) {
          finalText = parsed.text;
          onPartial(parsed.text);
          console.log('[VolcASR] Native: text:', parsed.text);
        }
      };
      _ws.onerror = (e: any) => console.warn('[VolcASR] Native: WS error', e.message);
      _ws.onclose = (e: any) => {
        console.log('[VolcASR] Native: WS closed', e.code, e.reason);
        wsDone = true;
        wsResolve?.();
      };
    } catch (wsErr) {
      console.warn('[VolcASR] Native: WS init error:', wsErr);
    }

    // Start PCM recording via react-native-audio-record
    const setupPromise = (async () => {
      try {
        // Request RECORD_AUDIO permission on Android before init
        if (Platform.OS === 'android') {
          const granted = await PermissionsAndroid.request(
            PermissionsAndroid.PERMISSIONS.RECORD_AUDIO,
            { title: '麦克风权限', message: '需要麦克风权限来进行语音识别', buttonPositive: '允许' },
          );
          if (granted !== PermissionsAndroid.RESULTS.GRANTED) {
            throw new Error('RECORD_AUDIO permission denied');
          }
        }
        const AudioRecord = (await import('react-native-audio-record')).default;
        const wavFile = `asr_${Date.now()}.wav`;
        AudioRecord.init({
          sampleRate: 16000,
          channels:   1,
          bitsPerSample: 16,
          audioSource: 6, // VOICE_RECOGNITION — highest mic gain for speech on Android
          wavFile,
        });
        AudioRecord.on('data', (base64Chunk: string) => {
          if (stopped) return;
          const bytes = base64ToBytes(base64Chunk);
          if (wsReady && ws?.readyState === WebSocket.OPEN) {
            ws.send(toAB(concat(makeHeader(MSG_AUDIO_ONLY, FLAG_POS_SEQ, SER_NONE, CMP_NONE), int32BE(audioSeq++), int32BE(bytes.length), bytes)));
          } else {
            pcmQueue.push(bytes); // buffer until WS ready
          }
        });
        AudioRecord.start();
        console.log('[VolcASR] Native: PCM recording started (16kHz 16bit mono)');
      } catch (err) {
        console.warn('[VolcASR] Native setup error:', err);
        if (!stopped && onError) onError(err instanceof Error ? err : new Error(String(err)));
      }
    })();

    return {
      stop: async (): Promise<ASRResult> => {
        stopped = true;
        await setupPromise;
        let localAudioUri: string | null = null;
        try {
          const AudioRecord = (await import('react-native-audio-record')).default;
          const filePath: string = await AudioRecord.stop();
          console.log('[VolcASR] Native: PCM recording stopped, file:', filePath);
          if (filePath) localAudioUri = `file://${filePath}`;
        } catch (e) {
          console.warn('[VolcASR] Native: stop recording error:', e);
        }

        // Send final (empty) packet to signal end of stream
        if (ws?.readyState === WebSocket.OPEN) {
          ws.send(toAB(concat(makeHeader(MSG_AUDIO_ONLY, FLAG_NEG_LAST, SER_NONE, CMP_NONE), int32BE(-(audioSeq)), int32BE(0))));
          // Wait for server to close (max 8s)
          await Promise.race([wsClosedPromise, new Promise(r => setTimeout(r, 8000))]);
        }
        console.log('[VolcASR] Native: final text:', finalText);
        if (!wsDone) ws?.close();
        // Delete recording if no text recognized (avoid storage accumulation)
        if (!finalText && localAudioUri) {
          try {
            const { deleteAsync } = await import('expo-file-system/legacy');
            await deleteAsync(localAudioUri, { idempotent: true });
            localAudioUri = null;
          } catch (_) {}
        }
        return buildASRResult(finalText, localAudioUri);
      },
    };
  }

  // Web 路径已删除 (app 仅 Android 原生,WebSocket 直连火山 openspeech.bytedance.com
  // 即可,不再用 dev proxy)。如果以后要支持 web,自己加 MediaRecorder + 直连。
  throw new Error('startVolcASR 当前仅支持 Android/iOS 原生,不支持 web');
}
