/**
 * Volcengine 视频字幕生成接口 (Video Caption)
 * Doc: https://www.volcengine.com/docs/6561/80909
 *
 * 这是火山专为"视频字幕生成"场景开的 HTTP 接口,流程 submit + query,
 * 鉴权用 `Authorization: Bearer; ${token}` (跟 ASR 大模型流式不同),
 * 提交支持两种方式:
 *   1) 音频二进制: `Content-Type: audio/wav`,body 直接是 wav 字节 ——
 *      本文件用这种方式,RN 端 fetch POST 直接发 wav bytes,无需 WebSocket
 *      binary protocol、无需 OSS 中转、无需任何中间环节
 *   2) 音频 URL: `Content-Type: application/json`,body 是 `{"url": "..."}` ——
 *      桌面端 videoinfo-gengui 用这种方式(走阿里云 OSS 签名 URL)
 *
 * 不接说话人识别(不传 with_speaker_info),跟 user 一致。
 * 不走 enable_speaker_info / ssd_version。
 * 不调用 enable_itn / use_ddc / use_punc 的"豆包大模型"开关(走接口默认行为)。
 *
 * 之前的 file ASR (volc.bigasr.auc submit/query + audio.url) + OSS 中转
 * 链路有 RN 0.83 + Hermes emulator 上 PUT OSS 100-continue 卡死 / 签名
 * 403 等坑,见 memory。换成这个接口后: 客户端直接 fetch POST + GET,
 * 无中间环节,走普通的 HTTPS 走 RN 0.83 + Hermes 完全没坑。
 */

import { Buffer } from 'buffer';
import { VOLC_APP_ID, VOLC_ACCESS_TOKEN } from './config';

export type FileAsrWord = {
  text?: string;
  start_time?: number;
  end_time?: number;
  startTime?: number;
  endTime?: number;
  start_ms?: number;
  end_ms?: number;
  startMs?: number;
  endMs?: number;
  blank_duration?: number;
};

export type FileAsrUtterance = {
  text?: string;
  start_time?: number;
  end_time?: number;
  startTime?: number;
  endTime?: number;
  start_ms?: number;
  end_ms?: number;
  startMs?: number;
  endMs?: number;
  words?: FileAsrWord[];
};

export type FileAsrResponse = {
  text?: string;
  utterances?: FileAsrUtterance[];
};

// ─── WAV header 解析 — 校验客户端 wav 是 16kHz/16bit/mono PCM ────────────

function findWavPcmOffset(bytes: Uint8Array): { pcmOffset: number; sampleRate: number; channels: number; bitsPerSample: number; } | null {
  if (bytes.length < 44) return null;
  if (
    bytes[0] !== 0x52 || bytes[1] !== 0x49 || bytes[2] !== 0x46 || bytes[3] !== 0x46 || // "RIFF"
    bytes[8] !== 0x57 || bytes[9] !== 0x41 || bytes[10] !== 0x56 || bytes[11] !== 0x45    // "WAVE"
  ) {
    return null;
  }
  let off = 12;
  let sampleRate = 0;
  let channels = 0;
  let bitsPerSample = 0;
  let pcmOffset = -1;
  while (off + 8 <= bytes.length) {
    const chunkId = String.fromCharCode(bytes[off], bytes[off + 1], bytes[off + 2], bytes[off + 3]);
    const chunkSize = (bytes[off + 4] | (bytes[off + 5] << 8) | (bytes[off + 6] << 16) | (bytes[off + 7] << 24)) >>> 0;
    if (chunkId === 'fmt ') {
      if (off + 8 + 16 <= bytes.length) {
        const formatCode = (bytes[off + 8] | (bytes[off + 9] << 8));
        channels = (bytes[off + 10] | (bytes[off + 11] << 8));
        sampleRate = (bytes[off + 12] | (bytes[off + 13] << 8) | (bytes[off + 14] << 16) | (bytes[off + 15] << 24)) >>> 0;
        bitsPerSample = (bytes[off + 22] | (bytes[off + 23] << 8));
        if (formatCode !== 1) {
          console.warn('[FileAsr] wav fmt chunk is not PCM (formatCode=', formatCode, ')');
        }
      }
    } else if (chunkId === 'data') {
      pcmOffset = off + 8;
      return { pcmOffset, sampleRate, channels, bitsPerSample };
    }
    off += 8 + chunkSize + (chunkSize & 1);
  }
  return null;
}

// ─── 鉴权 / endpoint 常量 ──────────────────────────────────────────────────

const VOLC_VC_SUBMIT_URL = 'https://openspeech.bytedance.com/api/v1/vc/submit';
const VOLC_VC_QUERY_URL = 'https://openspeech.bytedance.com/api/v1/vc/query';

// 阻塞 + 长轮询总超时(ms):90s wav 通常 5-10s 跑完,给 5min 上限兜底
const VC_TOTAL_TIMEOUT_MS = 5 * 60 * 1_000;

function buildAuthHeader(): string {
  // 文档原文: `Authorization: Bearer; ${token}` — 注意 Bearer 后面是分号
  return `Bearer; ${VOLC_ACCESS_TOKEN}`;
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildRequestId(): string {
  const seg = () => Math.floor((1 + Math.random()) * 0x10000).toString(16).slice(1);
  return `${seg()}${seg()}-${seg()}-${seg()}-${seg()}-${seg()}${seg()}${seg()}`;
}

// ─── submit ──────────────────────────────────────────────────────────────

interface VcSubmitResponse {
  code: number;
  message: string;
  id?: string;
}

async function submitCaptionTask(
  wavBytes: Uint8Array,
  taskId: string,
  language: string,
): Promise<string> {
  // URL params 跟文档示例一致。language 显式传英文/中文 (default zh-CN,但
  // user 视频都是英文,所以 'en-US'),caption_type=speech 让 use_punc 真正生效。
  const params = new URLSearchParams({
    appid: VOLC_APP_ID,
    language,                                 // 'en-US' 或 'zh-CN' (调用方传)
    caption_type: 'speech',                   // 只识别说话,use_punc 只在此模式生效
    use_itn: 'True',                          // 数字归一化
    use_punc: 'True',                         // 加标点 (仅 caption_type=speech 时生效)
    max_lines: '1',                           // 不分屏
    words_per_line: language === 'zh-CN' ? '15' : '55',
    // 不传 with_speaker_info (默认 False) —— user 明确不要说话人识别
    // 不传 use_ddc (默认 False) — 字幕场景不需要口水词/重复词特殊处理
  });
  const url = `${VOLC_VC_SUBMIT_URL}?${params.toString()}`;

  console.log('[FileAsr] submit start', {
    label: taskId,
    urlPreview: url.slice(0, 120) + (url.length > 120 ? '…' : ''),
    wavBytes: wavBytes.length,
    contentType: 'audio/wav',
  });

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': buildAuthHeader(),
      'Content-Type': 'audio/wav',
      'Content-Length': String(wavBytes.length),
    },
    // RN fetch: Buffer 需转 ArrayBuffer,ArrayBuffer view 也行
    body: wavBytes.buffer.slice(wavBytes.byteOffset, wavBytes.byteOffset + wavBytes.byteLength) as ArrayBuffer,
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`video caption submit HTTP 失败: status=${response.status} body=${errText.slice(0, 300)}`);
  }
  const result = (await response.json()) as VcSubmitResponse;
  console.log('[FileAsr] submit response', { label: taskId, code: result.code, message: result.message, id: result.id });
  if (result.code !== 0) {
    throw new Error(`video caption submit 失败: code=${result.code} message=${result.message}`);
  }
  if (!result.id) {
    throw new Error(`video caption submit 成功但没返回 id: ${JSON.stringify(result).slice(0, 300)}`);
  }
  return result.id;
}

// ─── query (阻塞) ────────────────────────────────────────────────────────

interface VcQueryResponse {
  id: string;
  code: number;
  message: string;
  duration?: number;
  utterances?: FileAsrUtterance[];
}

async function queryCaptionResult(
  jobId: string,
  taskId: string,
  language: string,
): Promise<FileAsrResponse> {
  // 文档说 GET ?appid=&id=&blocking= (默认阻塞 1)
  // 不用轮询,直接 blocking=1 等服务端处理完一次返回
  // 但是服务端处理可能要 5-30s(RN fetch 没有内置 timeout,要加 AbortController)
  const params = new URLSearchParams({
    appid: VOLC_APP_ID,
    id: jobId,
    blocking: '1',
    language,
  });
  const url = `${VOLC_VC_QUERY_URL}?${params.toString()}`;

  console.log('[FileAsr] query start (blocking)', {
    label: taskId,
    jobId,
    urlPreview: url.slice(0, 120) + (url.length > 120 ? '…' : ''),
  });

  // AbortController:服务端处理 90s wav 一般 5-10s,但也兜底 5min
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), VC_TOTAL_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'GET',
      headers: {
        'Authorization': buildAuthHeader(),
      },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`video caption query HTTP 失败: status=${response.status} body=${errText.slice(0, 300)}`);
  }
  const result = (await response.json()) as VcQueryResponse;
  console.log('[FileAsr] query response', {
    label: taskId,
    jobId,
    code: result.code,
    message: result.message,
    duration: result.duration,
    utteranceCount: result.utterances?.length || 0,
  });
  if (result.code !== 0) {
    throw new Error(`video caption query 失败: code=${result.code} message=${result.message}`);
  }

  // 拼成 file ASR 同 schema 给上层
  const utterances = Array.isArray(result.utterances) ? result.utterances : [];
  const text = utterances
    .map((u) => (typeof u.text === 'string' ? u.text : ''))
    .filter((s) => s.length > 0)
    .join(' ');
  return { text, utterances };
}

// ─── 公开 API ──────────────────────────────────────────────────────────────

/**
 * 把本地 wav 用火山"视频字幕生成"接口识别,跟 videoinfo-gengui 桌面端
 * videoinfo-gengui/tabs/asr_client.py::transcribe_wav_file_direct 接口
 * 行为一致(submit + query),但**不走阿里云 OSS 中转**——直接
 * fetch POST audio body,fetch GET 阻塞 query,中间无任何环节。
 *
 * 跟 file ASR (volc.bigasr.auc) 走 audio.url 的最大区别:
 *   - volc.bigasr.auc 期待 audio.url(JSON 模式)或 base64 (silently dropped)
 *   - /api/v1/vc/submit 直接吃 audio body (Content-Type: audio/wav)
 *
 * user-videos.ts 调 transcribeWavFileDirect({ wavUri, requestLabel }) 签名不变。
 */
export async function transcribeWavFileDirect(params: {
  wavUri: string;
  language?: string;
  requestLabel?: string;
}): Promise<FileAsrResponse> {
  if (!params.wavUri) {
    throw new Error('wavUri 不能为空');
  }
  const label = params.requestLabel ? ` [${params.requestLabel}]` : '';
  const language = params.language || 'en-US';
  const taskId = buildRequestId();

  // 1) 读 wav 文件
  console.log('[FileAsr] === start === (volc video caption /api/v1/vc/submit)', { label, wavUri: params.wavUri });
  const fileResp = await fetch(params.wavUri);
  if (!fileResp.ok) {
    throw new Error(`读取 wav 失败: ${fileResp.status} ${params.wavUri}`);
  }
  const arrayBuffer = await fileResp.arrayBuffer();
  const wavBytes = new Uint8Array(arrayBuffer);
  console.log('[FileAsr] wav loaded', { size: wavBytes.length });

  // 2) 校验 wav header,提取 sample rate/channels/bits 用于 submit 包 (server 不校验,但我们要保证不是 client bug 发了错的 wav)
  const wavInfo = findWavPcmOffset(wavBytes);
  if (!wavInfo) {
    throw new Error(`wav header 解析失败(不是合法 RIFF/WAVE): ${params.wavUri}`);
  }
  const { sampleRate, channels, bitsPerSample } = wavInfo;
  if (sampleRate !== 16000 || channels !== 1 || bitsPerSample !== 16) {
    throw new Error(
      `wav 不是 16kHz/16bit/mono PCM: sampleRate=${sampleRate} channels=${channels} bits=${bitsPerSample} (${params.wavUri})`,
    );
  }
  const durationSec = (wavBytes.length - wavInfo.pcmOffset) / (sampleRate * channels * (bitsPerSample / 8));
  console.log('[FileAsr] wav validated', {
    pcmOffset: wavInfo.pcmOffset,
    durationSec: Math.round(durationSec * 10) / 10,
  });

  // 3) submit (HTTP POST audio body)
  const jobId = await submitCaptionTask(wavBytes, taskId, language);

  // 4) query 阻塞 (GET blocking=1)
  const result = await queryCaptionResult(jobId, taskId, language);

  console.log('[FileAsr] === done ===', {
    label,
    jobId,
    textLen: result.text?.length || 0,
    utteranceCount: result.utterances?.length || 0,
  });
  return result;
}
