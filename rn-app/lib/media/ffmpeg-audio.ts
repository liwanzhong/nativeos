import { deleteAsync, getInfoAsync, makeDirectoryAsync, cacheDirectory } from 'expo-file-system/legacy';
import { FFmpegKit, ReturnCode } from '@wokcito/ffmpeg-kit-react-native';

function ensureCacheBase() {
  if (!cacheDirectory) {
    throw new Error('缓存目录不可用，无法执行音频提取');
  }
  return `${cacheDirectory}ffmpeg-audio`;
}

function normalizePathForFfmpeg(uri: string) {
  if (uri.startsWith('file://')) {
    return decodeURIComponent(uri.replace('file://', ''));
  }
  return uri;
}

function getUserAgentHeader(headers?: Record<string, string>) {
  const entries = Object.entries(headers || {});
  const hit = entries.find(([key, value]) => key.toLowerCase() === 'user-agent' && typeof value === 'string' && value.length > 0);
  return hit?.[1] || null;
}

function buildHeadersArg(headers?: Record<string, string>) {
  const entries = Object.entries(headers || {}).filter(([key, value]) => key.toLowerCase() !== 'user-agent' && typeof value === 'string' && value.length > 0);
  if (!entries.length) {
    return null;
  }
  return entries.map(([key, value]) => `${key}: ${value}`).join('\r\n');
}

function buildOutputUri(prefix: string) {
  const base = ensureCacheBase();
  return `${base}/${prefix}_${Date.now()}.wav`;
}

function isRemoteUrl(uri: string) {
  return uri.startsWith('http://') || uri.startsWith('https://');
}

function summarizeForLog(value: string | null | undefined, maxLength = 1200) {
  if (!value) {
    return '';
  }
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, maxLength)}...<truncated>`;
}

async function executeAudioExtract(params: {
  sourceUri: string;
  startMs?: number;
  endMs?: number;
  headers?: Record<string, string>;
  outputPrefix?: string;
  remoteInputProfile?: 'http' | 'hls';
  logLabel: 'LocalFFmpeg' | 'RemoteFFmpeg';
}) {
  const baseDir = ensureCacheBase();
  await makeDirectoryAsync(baseDir, { intermediates: true });
  const outputUri = buildOutputUri(params.outputPrefix || 'asr');
  const outputPath = normalizePathForFfmpeg(outputUri);
  const durationSeconds = typeof params.startMs === 'number'
    && typeof params.endMs === 'number'
    && params.endMs > params.startMs
      ? Math.max(0.2, (params.endMs - params.startMs) / 1000)
      : null;
  const isRemote = isRemoteUrl(params.sourceUri);
  const requestedStartMs = typeof params.startMs === 'number' && params.startMs > 0
    ? params.startMs
    : 0;
  const remoteSeekPrerollMs = 5000;
  const coarseSeekMs = isRemote && requestedStartMs > 0
    ? Math.max(0, requestedStartMs - remoteSeekPrerollMs)
    : requestedStartMs;
  const accurateSeekMs = requestedStartMs - coarseSeekMs;
  const remoteInputProfile = isRemote
    ? (params.remoteInputProfile || 'http')
    : null;

  const headersArg = buildHeadersArg(params.headers);
  const userAgent = getUserAgentHeader(params.headers);
  const args: string[] = ['-y'];
  if (isRemote) {
    args.push('-rw_timeout', '15000000');
    args.push('-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_on_network_error', '1', '-reconnect_delay_max', '5');
    if (userAgent) {
      args.push('-user_agent', userAgent);
    }
    if (headersArg) {
      args.push('-headers', `${headersArg}\r\n`);
    }
    if (remoteInputProfile === 'hls') {
      args.push('-protocol_whitelist', 'file,http,https,tcp,tls,crypto,data');
      args.push('-allowed_extensions', 'ALL');
      args.push('-allowed_segment_extensions', 'ALL');
      args.push('-f', 'hls');
    }
  }
  if (coarseSeekMs > 0) {
    args.push('-ss', `${Math.max(0, coarseSeekMs / 1000)}`);
  }
  args.push('-i', normalizePathForFfmpeg(params.sourceUri));
  if (accurateSeekMs > 0) {
    args.push('-ss', `${Math.max(0, accurateSeekMs / 1000)}`);
  }
  if (durationSeconds != null) {
    args.push('-t', `${durationSeconds}`);
  }
  args.push('-vn', '-ac', '1', '-ar', '16000', '-sample_fmt', 's16', outputPath);

  console.log(`[${params.logLabel}] extract start`, {
    sourceUri: params.sourceUri,
    outputUri,
    startMs: params.startMs ?? null,
    endMs: params.endMs ?? null,
    coarseSeekMs: coarseSeekMs || null,
    accurateSeekMs: accurateSeekMs || null,
    headerKeys: params.headers ? Object.keys(params.headers) : [],
    isRemote,
    remoteInputProfile,
    argsPreview: args,
  });
  const session: any = await FFmpegKit.executeWithArguments(args);
  const returnCode = await session.getReturnCode();
  const output = typeof session.getOutput === 'function' ? await session.getOutput() : '';
  console.log(`[${params.logLabel}] extract end`, {
    sourceUri: params.sourceUri,
    outputUri,
    returnCode: returnCode != null ? String(returnCode) : null,
    remoteInputProfile,
    outputPreview: summarizeForLog(output),
  });
  if (!ReturnCode.isSuccess(returnCode)) {
    throw new Error(`ffmpeg 提音轨失败: ${output || String(returnCode)}`);
  }
  const info = await getInfoAsync(outputUri);
  if (!info.exists || !info.size) {
    throw new Error('ffmpeg 未生成有效 wav 文件');
  }
  console.log(`[${params.logLabel}] extract success`, {
    outputUri,
    size: info.size,
  });
  return outputUri;
}

export async function extractAudioToWav(params: {
  sourceUri: string;
  startMs?: number;
  endMs?: number;
  headers?: Record<string, string>;
  outputPrefix?: string;
}) {
  return executeAudioExtract({
    ...params,
    logLabel: 'LocalFFmpeg',
  });
}

export async function extractRemoteAudioToWav(params: {
  sourceUrl: string;
  startMs?: number;
  endMs?: number;
  headers?: Record<string, string>;
  outputPrefix?: string;
  remoteInputProfile?: 'http' | 'hls';
}) {
  return executeAudioExtract({
    sourceUri: params.sourceUrl,
    startMs: params.startMs,
    endMs: params.endMs,
    headers: params.headers,
    outputPrefix: params.outputPrefix,
    remoteInputProfile: params.remoteInputProfile,
    logLabel: 'RemoteFFmpeg',
  });
}

export async function cleanupExtractedAudio(uri?: string | null) {
  if (!uri) {
    return;
  }
  try {
    await deleteAsync(uri, { idempotent: true });
  } catch {
  }
}
