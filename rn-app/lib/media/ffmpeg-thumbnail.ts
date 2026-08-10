import { getInfoAsync, makeDirectoryAsync, cacheDirectory } from 'expo-file-system/legacy';
import { FFmpegKit, ReturnCode } from '@wokcito/ffmpeg-kit-react-native';

function ensureCacheBase() {
  if (!cacheDirectory) {
    throw new Error('缓存目录不可用，无法生成视频封面');
  }
  return `${cacheDirectory}ffmpeg-thumbnail`;
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

function isRemoteUrl(uri: string) {
  return uri.startsWith('http://') || uri.startsWith('https://');
}

export async function extractVideoFrame(params: {
  sourceUri: string;
  targetUri: string;
  captureMs?: number;
  headers?: Record<string, string>;
  logLabel?: string;
}) {
  const baseDir = ensureCacheBase();
  await makeDirectoryAsync(baseDir, { intermediates: true });

  const targetDirectory = params.targetUri.split('/').slice(0, -1).join('/');
  if (targetDirectory) {
    await makeDirectoryAsync(targetDirectory, { intermediates: true });
  }

  const captureSeconds = Math.max(0, (params.captureMs ?? 0) / 1000);
  const isRemote = isRemoteUrl(params.sourceUri);
  const headersArg = buildHeadersArg(params.headers);
  const userAgent = getUserAgentHeader(params.headers);
  const args: string[] = ['-y'];

  if (isRemote) {
    args.push('-rw_timeout', '15000000');
    if (userAgent) {
      args.push('-user_agent', userAgent);
    }
    if (headersArg) {
      args.push('-headers', `${headersArg}\r\n`);
    }
  }

  if (captureSeconds > 0) {
    args.push('-ss', `${captureSeconds}`);
  }

  args.push(
    '-i', normalizePathForFfmpeg(params.sourceUri),
    '-frames:v', '1',
    '-q:v', '2',
    normalizePathForFfmpeg(params.targetUri),
  );

  console.log(`[${params.logLabel || 'VideoThumb'}] extract frame start`, {
    sourceUri: params.sourceUri,
    targetUri: params.targetUri,
    captureMs: params.captureMs ?? 0,
    isRemote,
    headerKeys: params.headers ? Object.keys(params.headers) : [],
  });

  const session: any = await FFmpegKit.executeWithArguments(args);
  const returnCode = await session.getReturnCode();
  const output = typeof session.getOutput === 'function' ? await session.getOutput() : '';

  if (!ReturnCode.isSuccess(returnCode)) {
    throw new Error(`ffmpeg 截取封面失败: ${output || String(returnCode)}`);
  }

  const info = await getInfoAsync(params.targetUri);
  if (!info.exists || !('size' in info) || !info.size) {
    throw new Error('ffmpeg 未生成有效封面文件');
  }

  console.log(`[${params.logLabel || 'VideoThumb'}] extract frame success`, {
    targetUri: params.targetUri,
    size: info.size,
  });

  return params.targetUri;
}
