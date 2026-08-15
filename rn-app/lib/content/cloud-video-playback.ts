import { Directory, File, Paths } from 'expo-file-system';
import { createDownloadResumable, deleteAsync, getInfoAsync, makeDirectoryAsync } from 'expo-file-system/legacy';
import {
  deleteDownloadedSceneSource,
  getBaiduPanBinding,
  getDefaultCloudProvider,
  getDownloadedSceneSource,
  getOfficialSceneProviderStates,
  type CloudVideoProvider,
  type OfficialSceneAssetKeys,
  type VideoSourceProviderState,
  upsertDownloadedSceneSource,
} from './cloud-drive-bindings';

const BAIDU_API_BASE = 'https://pan.baidu.com';
const BAIDU_DOWNLOAD_URL_TTL_MS = 7.5 * 60 * 60 * 1000;
const DOWNLOAD_PROGRESS_PERSIST_INTERVAL_MS = 600;

const CLOUD_PLAYBACK_LOG_PREFIX = '[CloudPlayback]';

function logCloudPlayback(message: string, payload?: unknown) {
  if (payload === undefined) {
    console.log(`${CLOUD_PLAYBACK_LOG_PREFIX} ${message}`);
    return;
  }
  try {
    console.log(`${CLOUD_PLAYBACK_LOG_PREFIX} ${message} ${JSON.stringify(payload)}`);
  } catch {
    console.log(`${CLOUD_PLAYBACK_LOG_PREFIX} ${message}`, payload);
  }
}

const activeDownloadTasks: Record<string, ReturnType<typeof createDownloadResumable>> = {};
const downloadSpeedSamples: Record<string, { bytes: number; timestamp: number }> = {};
const progressPersistTimestamps: Record<string, number> = {};
const downloadEntryCache = new Map<string, {
  sceneId: string;
  provider: CloudVideoProvider;
  localVideoUri?: string;
  targetFileUri?: string;
  remotePath?: string;
  remoteUrl?: string;
  remoteUrlResolvedAt?: string;
  resumeData?: string;
  totalBytesWritten?: number;
  totalBytesExpectedToWrite?: number;
  speedBytesPerSecond?: number;
  status: 'idle' | 'resolving' | 'downloading' | 'paused' | 'completed' | 'error';
  progress: number;
  errorMessage?: string;
  updatedAt: string;
}>();

function sanitizeSegment(value: string) {
  return value.replace(/[^a-zA-Z0-9_-]/g, '_') || 'asset';
}

function simpleHash(value: string) {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) - hash) + value.charCodeAt(index);
    hash |= 0;
  }
  return Math.abs(hash).toString(36);
}

function normalizeUnixPath(path: string, fallback: string = '/') {
  const raw = (path || fallback).trim();
  if (!raw || raw === '/') return '/';
  const withLeadingSlash = raw.startsWith('/') ? raw : `/${raw}`;
  return withLeadingSlash.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/+$/, '') || '/';
}

function joinUnixPath(base: string, relative: string) {
  const normalizedBase = normalizeUnixPath(base);
  const normalizedRelative = (relative || '').trim().replace(/\\/g, '/').replace(/^\/+/, '');
  if (!normalizedRelative) return normalizedBase;
  if (normalizedBase === '/') return `/${normalizedRelative}`.replace(/\/+/g, '/');
  return `${normalizedBase}/${normalizedRelative}`.replace(/\/+/g, '/');
}

function dirnameUnix(path: string) {
  const normalized = normalizeUnixPath(path);
  if (normalized === '/') return '/';
  const parts = normalized.split('/').filter(Boolean);
  parts.pop();
  return parts.length ? `/${parts.join('/')}` : '/';
}

function appendQuery(url: string, key: string, value: string) {
  return `${url}${url.includes('?') ? '&' : '?'}${encodeURIComponent(key)}=${encodeURIComponent(value)}`;
}

function getDownloadTaskKey(sceneId: string, provider: CloudVideoProvider) {
  return `${sceneId}__${provider}`;
}

// ── Public subscription surface ────────────────────────────────
// In-memory only. Lets UI components (e.g. the cache chip on a
// collection detail row) observe a download's progress without
// having to focus a settings page. Pairs with `getCachedDownloadEntry`
// (also exported) which gives the most recent state on subscribe
// (e.g. when the page re-mounts mid-download). The source of
// truth across app restarts is the SQLite `cloud_video_downloads`
// table, queried separately by `getDownloadedSceneSource`.
export type DownloadStateListener = (state: {
  status: 'idle' | 'resolving' | 'downloading' | 'paused' | 'completed' | 'error';
  progress: number;
  totalBytesWritten: number;
  totalBytesExpectedToWrite: number;
  speedBytesPerSecond: number;
  errorMessage?: string;
} | null) => void;

const downloadListeners = new Map<string, Set<DownloadStateListener>>();

function notifyDownloadListeners(taskKey: string) {
  const listeners = downloadListeners.get(taskKey);
  if (!listeners) return;
  const entry = downloadEntryCache.get(taskKey);
  const payload = entry ? {
    status: entry.status,
    progress: entry.progress,
    totalBytesWritten: entry.totalBytesWritten ?? 0,
    totalBytesExpectedToWrite: entry.totalBytesExpectedToWrite ?? 0,
    speedBytesPerSecond: entry.speedBytesPerSecond ?? 0,
    errorMessage: entry.errorMessage,
  } : null;
  listeners.forEach((listener) => {
    try { listener(payload); } catch { /* listener errors are non-fatal */ }
  });
}

export function subscribeDownloadState(
  sceneId: string,
  provider: CloudVideoProvider,
  listener: DownloadStateListener,
): () => void {
  const taskKey = getDownloadTaskKey(sceneId, provider);
  const set = downloadListeners.get(taskKey) ?? new Set<DownloadStateListener>();
  set.add(listener);
  downloadListeners.set(taskKey, set);
  return () => {
    const current = downloadListeners.get(taskKey);
    if (!current) return;
    current.delete(listener);
    if (current.size === 0) downloadListeners.delete(taskKey);
  };
}

export function getCachedDownloadEntrySnapshot(
  sceneId: string,
  provider: CloudVideoProvider,
): {
  status: 'idle' | 'resolving' | 'downloading' | 'paused' | 'completed' | 'error';
  progress: number;
  totalBytesWritten: number;
  totalBytesExpectedToWrite: number;
  speedBytesPerSecond: number;
  errorMessage?: string;
} | null {
  const taskKey = getDownloadTaskKey(sceneId, provider);
  const entry = downloadEntryCache.get(taskKey);
  if (!entry) return null;
  return {
    status: entry.status,
    progress: entry.progress,
    totalBytesWritten: entry.totalBytesWritten ?? 0,
    totalBytesExpectedToWrite: entry.totalBytesExpectedToWrite ?? 0,
    speedBytesPerSecond: entry.speedBytesPerSecond ?? 0,
    errorMessage: entry.errorMessage,
  };
}

function getCloudCacheDir() {
  return new Directory(Paths.cache, 'cloud-video-cache');
}

function ensureCloudCacheDir() {
  const dir = getCloudCacheDir();
  if (!dir.exists) {
    dir.create({ intermediates: true });
  }
  return dir;
}

function getCacheTarget(sceneId: string, provider: CloudVideoProvider, remoteHint: string) {
  const extMatch = remoteHint.match(/\.([a-zA-Z0-9]+)(?:$|\?)/);
  const ext = extMatch?.[1] || 'mp4';
  const providerLabel = 'baidu';
  return new File(ensureCloudCacheDir(), `${sanitizeSegment(sceneId)}_${providerLabel}_${simpleHash(remoteHint)}.${ext}`);
}

async function ensureCloudCacheDirUri() {
  const dir = ensureCloudCacheDir();
  await makeDirectoryAsync(dir.uri, { intermediates: true });
  return dir.uri;
}

type ResolvedCloudVideoSource = {
  provider: CloudVideoProvider;
  playbackMode: 'local' | 'remote';
  videoUri: string;
  videoHeaders?: Record<string, string>;
  videoContentType?: 'auto' | 'hls';
  videoOverrideFileExtensionAndroid?: string;
};

type BaiduPanFile = {
  fs_id: number;
  path: string;
  dlink?: string;
};

async function getBaiduFileList(accessToken: string, dir: string = '/') {
  const qs = new URLSearchParams({
    method: 'list',
    access_token: accessToken,
    dir,
    order: 'time',
    start: '0',
    limit: '200',
    web: 'web',
    folder: '0',
    desc: '1',
  });
  const resp = await fetch(`${BAIDU_API_BASE}/rest/2.0/xpan/file?${qs.toString()}`, {
    method: 'GET',
    headers: { 'User-Agent': 'pan.baidu.com' },
  });
  const json = await resp.json();
  if (json.errno !== 0) {
    throw new Error(`获取百度网盘目录失败: errno=${json.errno}`);
  }
  return (json.list || []) as BaiduPanFile[];
}

async function getBaiduFileMetas(accessToken: string, fsids: number[]) {
  const qs = new URLSearchParams({
    method: 'filemetas',
    access_token: accessToken,
    fsids: JSON.stringify(fsids),
    dlink: '1',
    needmedia: '1',
  });
  const resp = await fetch(`${BAIDU_API_BASE}/rest/2.0/xpan/multimedia?${qs.toString()}`, {
    method: 'GET',
    headers: { 'User-Agent': 'pan.baidu.com' },
  });
  const json = await resp.json();
  if (json.errno !== 0) {
    throw new Error(`获取百度网盘文件信息失败: errno=${json.errno}`);
  }
  return (json.list || []) as BaiduPanFile[];
}

async function getBaiduFileByPath(accessToken: string, fullPath: string) {
  const files = await getBaiduFileList(accessToken, dirnameUnix(fullPath));
  const normalized = normalizeUnixPath(fullPath);
  const file = files.find((item) => normalizeUnixPath(item.path) === normalized);
  if (!file) {
    throw new Error(`百度网盘未找到文件: ${fullPath}`);
  }
  return file;
}

function buildBaiduStreamingUrl(accessToken: string, path: string, adToken?: string) {
  const qs = new URLSearchParams({
    method: 'streaming',
    access_token: accessToken,
    path,
    type: 'M3U8_AUTO_480',
  });
  if (adToken) {
    qs.set('adToken', adToken);
  }
  return `${BAIDU_API_BASE}/rest/2.0/xpan/file?${qs.toString()}`;
}

interface BaiduVideoSource {
  videoUri: string;
  /**
   * Maps to expo-av's `content-type` prop:
   *  - 'hls' for the m3u8 streaming path (force HLS parser)
   *  - 'auto' for the dlink mp4 path (let the player sniff Content-Type)
   */
  videoContentType: 'hls' | 'auto';
  videoHeaders: Record<string, string>;
  /**
   * Android's ExoPlayer sometimes needs the file extension hint on
   * the URL. We mirror the content type: 'm3u8' for HLS, 'mp4' for
   * the dlink fallback. iOS ignores this.
   */
  videoOverrideFileExtensionAndroid: 'm3u8' | 'mp4';
  /**
   * Which delivery mode won. 'hls' = m3u8 streaming (fast start,
   * adaptive). 'mp4' = dlink direct download (HTTP Range). Used for
   * log + analytics only.
   */
  delivery: 'hls' | 'mp4';
}

async function tryBaiduHlsOnce(accessToken: string, path: string): Promise<{ url: string } | { errno: number; errmsg: string }> {
  const requestBody = async (url: string, label: string): Promise<string> => {
    logCloudPlayback('baidu stream fetch start', { label, url: url.slice(0, 120) + '...' });
    const t0 = Date.now();
    try {
      const resp = await fetch(url, {
        method: 'GET',
        headers: { 'User-Agent': 'pan.baidu.com' },
      });
      const ms = Date.now() - t0;
      logCloudPlayback('baidu stream fetch got response', { label, status: resp.status, ms });
      const text = await resp.text();
      const textMs = Date.now() - t0;
      logCloudPlayback('baidu stream fetch body done', { label, bodyLen: text.length, totalMs: textMs, bodyStart: text.slice(0, 60) });
      return text;
    } catch (err) {
      const ms = Date.now() - t0;
      logCloudPlayback('baidu stream fetch threw', { label, ms, error: err instanceof Error ? err.message : String(err) });
      throw err;
    }
  };
  const parseJson = (body: string) => {
    try {
      return JSON.parse(body) as { errno?: number; adToken?: string; errmsg?: string; error_code?: number };
    } catch {
      return null;
    }
  };
  const firstUrl = buildBaiduStreamingUrl(accessToken, path);
  const firstBody = await requestBody(firstUrl, 'first');
  if (firstBody.trimStart().startsWith('#EXTM3U')) {
    logCloudPlayback('baidu stream first body is m3u8', {});
    return { url: firstUrl };
  }
  const firstJson = parseJson(firstBody);
  const firstErrno = typeof firstJson?.errno === 'number'
    ? firstJson.errno
    : typeof firstJson?.error_code === 'number'
      ? firstJson.error_code
      : -1;
  logCloudPlayback('baidu stream first json', { errno: firstErrno, errmsg: firstJson?.errmsg, hasAdToken: !!firstJson?.adToken });
  if (firstJson?.errno === 133 && firstJson.adToken) {
    const secondUrl = buildBaiduStreamingUrl(accessToken, path, firstJson.adToken);
    const secondBody = await requestBody(secondUrl, 'retry-with-adToken');
    if (secondBody.trimStart().startsWith('#EXTM3U')) {
      logCloudPlayback('baidu stream retry body is m3u8', {});
      return { url: secondUrl };
    }
    const secondJson = parseJson(secondBody);
    const secondErrno = typeof secondJson?.errno === 'number'
      ? secondJson.errno
      : typeof secondJson?.error_code === 'number'
        ? secondJson.error_code
        : -1;
    logCloudPlayback('baidu stream retry json', { errno: secondErrno, errmsg: secondJson?.errmsg });
    return { errno: secondErrno, errmsg: secondJson?.errmsg || '' };
  }
  return { errno: firstErrno, errmsg: firstJson?.errmsg || '' };
}

const HLS_RETRY_DELAY_MS = 2000;

/**
 * Resolve a Baidu pan file into a video source the player can play.
 *
 * Three-stage pipeline (m3u8 first, then dlink fallback):
 *  1. Try Baidu's HLS streaming endpoint (`?method=streaming`). On
 *     `errno 31341` (transcoding not ready), wait 2s and try again.
 *  2. If HLS is still failing, fall back to the direct dlink
 *     (`getBaiduFileMetas` + `?access_token=...`). dlink supports
 *     HTTP Range so expo-av can play it like any HTTP-served mp4.
 *  3. If dlink also fails (rare — file missing, fsid lookup
 *     collision), throw and let the UI surface "视频源不可用".
 *
 * Why this is a robust fix for the "first click fails, retry works"
 * pattern: Baidu's HLS cluster transcodes uploaded mp4s on demand
 * and 31341 means "transcode job not done yet". Two seconds is
 * enough for the cluster to land the job. The dlink fallback covers
 * the rare case where the transcode never finishes (e.g. unsupported
 * codec).
 */
async function resolveBaiduVideoSource(accessToken: string, path: string): Promise<BaiduVideoSource> {
  const baseHeaders = { 'User-Agent': 'pan.baidu.com' };
  // Stage 1: m3u8, with one retry after a short delay.
  const first = await tryBaiduHlsOnce(accessToken, path);
  if ('url' in first) {
    logCloudPlayback('baidu video source: hls first try', { path });
    return {
      videoUri: first.url,
      videoContentType: 'hls',
      videoHeaders: baseHeaders,
      videoOverrideFileExtensionAndroid: 'm3u8',
      delivery: 'hls',
    };
  }
  // 31341 = "高速视频播放媒体信息获取失败" (transcoding not ready). Worth
  // waiting a couple of seconds and retrying — the second click "always
  // works" symptom we saw in the wild is exactly this: by the time the
  // user re-tapped the scene, the cluster had finished the transcode.
  const isTransient = first.errno === 31341 || first.errno === 0 || first.errno < 0;
  if (isTransient) {
    logCloudPlayback('baidu hls first try transient, sleeping before retry', { errno: first.errno, delayMs: HLS_RETRY_DELAY_MS });
    await new Promise<void>((resolve) => setTimeout(resolve, HLS_RETRY_DELAY_MS));
    const second = await tryBaiduHlsOnce(accessToken, path);
    if ('url' in second) {
      logCloudPlayback('baidu video source: hls after retry', { path });
      return {
        videoUri: second.url,
        videoContentType: 'hls',
        videoHeaders: baseHeaders,
        videoOverrideFileExtensionAndroid: 'm3u8',
        delivery: 'hls',
      };
    }
    logCloudPlayback('baidu hls still failing after retry', { errno: second.errno, errmsg: second.errmsg });
  } else {
    logCloudPlayback('baidu hls first try non-transient, skipping retry', { errno: first.errno, errmsg: first.errmsg });
  }
  // Stage 2: dlink fallback.
  logCloudPlayback('baidu video source: falling back to dlink', { path });
  let downloadUrl: string;
  try {
    downloadUrl = await getBaiduDownloadUrl(accessToken, path);
  } catch (err) {
    logCloudPlayback('baidu video source: dlink FAILED', {
      path,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
  logCloudPlayback('baidu video source: dlink resolved', { path, url: downloadUrl.slice(0, 80) + '...' });
  return {
    videoUri: downloadUrl,
    videoContentType: 'auto',
    videoHeaders: baseHeaders,
    videoOverrideFileExtensionAndroid: 'mp4',
    delivery: 'mp4',
  };
}

async function getBaiduDownloadUrl(accessToken: string, fullPath: string) {
  const file = await getBaiduFileByPath(accessToken, fullPath);
  const metas = await getBaiduFileMetas(accessToken, [file.fs_id]);
  const meta = metas[0];
  if (!meta?.dlink) {
    throw new Error('百度网盘下载地址不存在');
  }
  return appendQuery(meta.dlink, 'access_token', accessToken);
}

async function getCachedDownloadEntry(sceneId: string, provider: CloudVideoProvider) {
  const taskKey = getDownloadTaskKey(sceneId, provider);
  if (downloadEntryCache.has(taskKey)) {
    return downloadEntryCache.get(taskKey) || null;
  }
  const entry = await getDownloadedSceneSource(sceneId, provider);
  if (entry) {
    downloadEntryCache.set(taskKey, entry);
  }
  return entry;
}

async function saveDownloadEntry(entry: NonNullable<Awaited<ReturnType<typeof getDownloadedSceneSource>>>) {
  const taskKey = getDownloadTaskKey(entry.sceneId, entry.provider);
  downloadEntryCache.set(taskKey, entry);
  await upsertDownloadedSceneSource(entry);
  return entry;
}

async function patchDownloadEntry(
  sceneId: string,
  provider: CloudVideoProvider,
  patch: Partial<NonNullable<Awaited<ReturnType<typeof getDownloadedSceneSource>>>>,
  forcePersist: boolean = true,
) {
  const current = await getCachedDownloadEntry(sceneId, provider);
  const next = {
    ...(current || {
      sceneId,
      provider,
      status: 'idle' as const,
      progress: 0,
      updatedAt: new Date().toISOString(),
    }),
    ...patch,
    sceneId,
    provider,
    updatedAt: new Date().toISOString(),
  };
  const taskKey = getDownloadTaskKey(sceneId, provider);
  downloadEntryCache.set(taskKey, next);
  // Fan out to in-memory subscribers (collection detail rows
  // use this to animate the cache chip without re-rendering the
  // whole page). Listener errors are swallowed; the entry is
  // the source of truth.
  notifyDownloadListeners(taskKey);
  const lastPersistAt = progressPersistTimestamps[taskKey] || 0;
  const shouldPersist = forcePersist || Date.now() - lastPersistAt >= DOWNLOAD_PROGRESS_PERSIST_INTERVAL_MS;
  if (shouldPersist) {
    progressPersistTimestamps[taskKey] = Date.now();
    await upsertDownloadedSceneSource(next);
  }
  return next;
}

function createSceneDownloadTask(params: {
  sceneId: string;
  provider: CloudVideoProvider;
  remoteUrl: string;
  localUri: string;
  headers?: Record<string, string>;
  resumeData?: string;
}) {
  const taskKey = getDownloadTaskKey(params.sceneId, params.provider);
  return createDownloadResumable(
    params.remoteUrl,
    params.localUri,
    {
      headers: params.headers,
    },
    (progress) => {
      const totalBytesExpectedToWrite = progress.totalBytesExpectedToWrite;
      const totalBytesWritten = progress.totalBytesWritten;
      const now = Date.now();
      const lastSample = downloadSpeedSamples[taskKey];
      let speedBytesPerSecond = 0;
      if (lastSample && now > lastSample.timestamp) {
        speedBytesPerSecond = ((totalBytesWritten - lastSample.bytes) * 1000) / (now - lastSample.timestamp);
      }
      downloadSpeedSamples[taskKey] = {
        bytes: totalBytesWritten,
        timestamp: now,
      };
      void patchDownloadEntry(
        params.sceneId,
        params.provider,
        {
          status: 'downloading',
          totalBytesExpectedToWrite,
          totalBytesWritten,
          speedBytesPerSecond: Math.max(0, speedBytesPerSecond),
          progress: totalBytesExpectedToWrite > 0 ? totalBytesWritten / totalBytesExpectedToWrite : 0,
        },
        false,
      );
    },
    params.resumeData,
  );
}

async function runSceneDownloadTask(
  sceneId: string,
  provider: CloudVideoProvider,
  task: ReturnType<typeof createDownloadResumable>,
  mode: 'start' | 'resume',
) {
  const taskKey = getDownloadTaskKey(sceneId, provider);
  activeDownloadTasks[taskKey] = task;
  await patchDownloadEntry(sceneId, provider, {
    status: 'downloading',
    errorMessage: undefined,
  });

  try {
    const result = mode === 'resume' ? await task.resumeAsync() : await task.downloadAsync();
    const current = await getCachedDownloadEntry(sceneId, provider);
    if (!current || current.status === 'paused') {
      return current?.localVideoUri;
    }
    await saveDownloadEntry({
      ...current,
      localVideoUri: result?.uri || current.localVideoUri || current.targetFileUri,
      status: 'completed',
      progress: 1,
      speedBytesPerSecond: 0,
      totalBytesWritten: current.totalBytesExpectedToWrite || current.totalBytesWritten || 0,
      resumeData: undefined,
      errorMessage: undefined,
      updatedAt: new Date().toISOString(),
    });
    return result?.uri || current.localVideoUri || current.targetFileUri;
  } catch (error) {
    const current = await getCachedDownloadEntry(sceneId, provider);
    if (!current || current.status === 'paused') {
      return current?.localVideoUri;
    }
    await patchDownloadEntry(sceneId, provider, {
      status: 'error',
      speedBytesPerSecond: 0,
      errorMessage: error instanceof Error ? error.message : '下载失败',
    });
    throw error;
  } finally {
    delete activeDownloadTasks[taskKey];
    delete downloadSpeedSamples[taskKey];
  }
}

async function resolveDownloadRequest(sceneId: string, provider: CloudVideoProvider) {
  const providerStates = await getOfficialSceneProviderStates(sceneId);
  const providerState = providerStates.find((item) => item.provider === provider);
  if (!providerState || providerState.syncStatus !== 'available' || !providerState.remotePath) {
    throw new Error('当前官方内容尚未同步到这个网盘来源');
  }

  const binding = await getBaiduPanBinding();
  if (!binding?.token?.accessToken) {
    throw new Error('百度网盘尚未授权');
  }
  const remoteUrl = await getBaiduDownloadUrl(binding.token.accessToken, providerState.remotePath);
  const headers: Record<string, string> = {
    'User-Agent': 'pan.baidu.com',
  };
  return {
    providerState,
    remoteUrl,
    headers,
    target: getCacheTarget(sceneId, provider, remoteUrl),
  };
}

async function resolveImportedDownloadRequest(sceneId: string, provider: CloudVideoProvider, remotePath: string) {
  const normalizedRemotePath = normalizeUnixPath(remotePath);
  if (normalizedRemotePath === '/') {
    throw new Error('缺少网盘视频路径');
  }

  const binding = await getBaiduPanBinding();
  if (!binding?.token?.accessToken) {
    throw new Error('百度网盘尚未授权');
  }
  const remoteUrl = await getBaiduDownloadUrl(binding.token.accessToken, normalizedRemotePath);
  const headers: Record<string, string> = {
    'User-Agent': 'pan.baidu.com',
  };
  return {
    remotePath: normalizedRemotePath,
    remoteUrl,
    headers,
    target: getCacheTarget(sceneId, provider, remoteUrl),
  };
}

async function resolveResumeRemoteUrl(
  sceneId: string,
  provider: CloudVideoProvider,
  remotePath: string,
  existingRemoteUrl?: string,
  resolvedAt?: string,
) {
  const binding = await getBaiduPanBinding();
  if (!binding?.token?.accessToken) {
    throw new Error('百度网盘尚未授权');
  }
  const resolvedTimestamp = resolvedAt ? Date.parse(resolvedAt) : 0;
  const shouldRefresh = !existingRemoteUrl || !resolvedTimestamp || Date.now() - resolvedTimestamp > BAIDU_DOWNLOAD_URL_TTL_MS;
  const headers: Record<string, string> = {
    'User-Agent': 'pan.baidu.com',
  };
  return {
    remoteUrl: shouldRefresh ? await getBaiduDownloadUrl(binding.token.accessToken, remotePath) : existingRemoteUrl,
    headers,
  };
}

async function hasPlayableLocalCache(localVideoUri?: string) {
  if (!localVideoUri) {
    return false;
  }
  const info = await getInfoAsync(localVideoUri);
  return Boolean(info.exists && (!('size' in info) || !info.size || info.size > 0));
}

export async function resolveOfficialSceneVideoSource(params: {
  sceneId: string;
  officialAssetKeys: OfficialSceneAssetKeys;
  providerStates?: VideoSourceProviderState[];
}): Promise<ResolvedCloudVideoSource | null> {
  const providerStates = params.providerStates ?? await getOfficialSceneProviderStates(params.sceneId);
  logCloudPlayback('resolveOfficialSceneVideoSource start', {
    sceneId: params.sceneId,
    officialVideoKey: params.officialAssetKeys?.videoKey,
    providerStateSummaries: providerStates.map((s) => ({
      provider: s.provider,
      isConfigured: s.isConfigured,
      isSelected: s.isSelected,
      syncStatus: s.syncStatus,
      hasLocalCache: s.hasLocalCache,
      hasRemotePath: !!s.remotePath,
      playbackMode: s.playbackMode,
      rootPath: s.rootPath,
    })),
  });
  const providerStateMap = new Map(providerStates.map((item) => [item.provider, item]));
  const preferredProviders: CloudVideoProvider[] = [];
  const selectedProvider = providerStates.find((item) => item.isSelected)?.provider;
  if (selectedProvider) {
    preferredProviders.push(selectedProvider);
  }
  const defaultProvider = await getDefaultCloudProvider();
  if (defaultProvider && !preferredProviders.includes(defaultProvider)) {
    preferredProviders.push(defaultProvider);
  }
  for (const state of providerStates) {
    if (!preferredProviders.includes(state.provider)) {
      preferredProviders.push(state.provider);
    }
  }

  for (const provider of preferredProviders) {
    const localEntry = await getDownloadedSceneSource(params.sceneId, provider);
    logCloudPlayback('check local cache', {
      sceneId: params.sceneId,
      provider,
      hasEntry: !!localEntry,
      hasUri: !!localEntry?.localVideoUri,
      status: localEntry?.status,
    });
    if (localEntry?.localVideoUri && localEntry.status === 'completed' && await hasPlayableLocalCache(localEntry.localVideoUri)) {
      logCloudPlayback('using local cache', {
        sceneId: params.sceneId,
        provider,
        localVideoUri: localEntry.localVideoUri,
      });
      return {
        provider,
        playbackMode: 'local' as const,
        videoUri: localEntry.localVideoUri,
      };
    }
  }

  for (const provider of preferredProviders) {
    const providerState = providerStateMap.get(provider);

    if (!providerState || (providerState.syncStatus !== 'available' && providerState.syncStatus !== 'cached') || !providerState.remotePath) {
      logCloudPlayback('skip provider', {
        sceneId: params.sceneId,
        provider,
        reason: !providerState
          ? 'no providerState'
          : providerState.syncStatus === 'available' || providerState.syncStatus === 'cached'
            ? !providerState.remotePath
              ? 'no remotePath'
              : 'unknown'
            : `syncStatus=${providerState.syncStatus}`,
        syncStatus: providerState?.syncStatus,
        remotePath: providerState?.remotePath,
      });
      continue;
    }

    if (provider === 'baidu_pan') {
      const binding = await getBaiduPanBinding();
      if (binding?.token?.accessToken) {
        logCloudPlayback('resolving baidu source', {
          sceneId: params.sceneId,
          remotePath: providerState.remotePath,
          accessTokenLen: binding.token.accessToken.length,
        });
        const source = await resolveBaiduVideoSource(binding.token.accessToken, providerState.remotePath);
        logCloudPlayback('baidu source resolved', {
          sceneId: params.sceneId,
          delivery: source.delivery,
          videoUri: source.videoUri.slice(0, 80) + '...',
        });
        return {
          provider,
          playbackMode: 'remote' as const,
          videoUri: source.videoUri,
          videoHeaders: source.videoHeaders,
          videoContentType: source.videoContentType,
          videoOverrideFileExtensionAndroid: source.videoOverrideFileExtensionAndroid,
        };
      } else {
        logCloudPlayback('skip baidu: no accessToken', {
          sceneId: params.sceneId,
        });
      }
    }
  }

  logCloudPlayback('resolveOfficialSceneVideoSource returning null', {
    sceneId: params.sceneId,
    preferredProviders,
    providerStateSummaries: providerStates.map((s) => ({
      provider: s.provider,
      syncStatus: s.syncStatus,
      hasRemotePath: !!s.remotePath,
      isReady: s.isReady,
    })),
  });
  return null;
}

export async function resolveCloudReferencedVideoSource(params: {
  provider: CloudVideoProvider;
  remotePath?: string;
}): Promise<ResolvedCloudVideoSource> {
  const remotePath = normalizeUnixPath(params.remotePath || '/');
  if (remotePath === '/') {
    throw new Error('缺少网盘视频路径');
  }

  const binding = await getBaiduPanBinding();
  logCloudPlayback('resolveCloudReferencedVideoSource', {
    provider: params.provider,
    remotePath,
    hasBinding: !!binding,
    hasAccessToken: !!(binding?.token?.accessToken),
    accessTokenLen: binding?.token?.accessToken ? binding.token.accessToken.length : 0,
    rootPath: binding?.rootPath || '(empty)',
  });
  if (!binding?.token?.accessToken) {
    throw new Error('百度网盘尚未授权');
  }
  const source = await resolveBaiduVideoSource(binding.token.accessToken, remotePath);
  return {
    provider: params.provider,
    playbackMode: 'remote' as const,
    videoUri: source.videoUri,
    videoHeaders: source.videoHeaders,
    videoContentType: source.videoContentType,
    videoOverrideFileExtensionAndroid: source.videoOverrideFileExtensionAndroid,
  };
}

export async function resolveCloudReferencedVideoCoverSource(params: {
  provider: CloudVideoProvider;
  remotePath?: string;
}): Promise<ResolvedCloudVideoSource> {
  const remotePath = normalizeUnixPath(params.remotePath || '/');
  if (remotePath === '/') {
    throw new Error('缺少网盘视频路径');
  }

  const binding = await getBaiduPanBinding();
  if (!binding?.token?.accessToken) {
    throw new Error('百度网盘尚未授权');
  }

  return {
    provider: params.provider,
    playbackMode: 'remote' as const,
    videoUri: await getBaiduDownloadUrl(binding.token.accessToken, remotePath),
    videoHeaders: {
      'User-Agent': 'pan.baidu.com',
    },
  };
}

export async function downloadOfficialSceneVideo(params: {
  sceneId: string;
  provider: CloudVideoProvider;
  officialAssetKeys?: OfficialSceneAssetKeys;
}) {
  const taskKey = getDownloadTaskKey(params.sceneId, params.provider);
  if (activeDownloadTasks[taskKey]) {
    return getCachedDownloadEntry(params.sceneId, params.provider);
  }

  try {
    await ensureCloudCacheDirUri();
    const { providerState, remoteUrl, headers, target } = await resolveDownloadRequest(params.sceneId, params.provider);
    const existingFile = await getInfoAsync(target.uri);
    if (existingFile.exists) {
      await deleteAsync(target.uri, { idempotent: true });
    }
    await saveDownloadEntry({
      sceneId: params.sceneId,
      provider: params.provider,
      targetFileUri: target.uri,
      localVideoUri: undefined,
      remotePath: providerState.remotePath,
      remoteUrl,
      remoteUrlResolvedAt: new Date().toISOString(),
      resumeData: undefined,
      totalBytesWritten: 0,
      totalBytesExpectedToWrite: 0,
      speedBytesPerSecond: 0,
      status: 'resolving',
      progress: 0,
      errorMessage: undefined,
      updatedAt: new Date().toISOString(),
    });
    const task = createSceneDownloadTask({
      sceneId: params.sceneId,
      provider: params.provider,
      remoteUrl,
      localUri: target.uri,
      headers,
    });
    void runSceneDownloadTask(params.sceneId, params.provider, task, 'start').catch(() => {});
    return getCachedDownloadEntry(params.sceneId, params.provider);
  } catch (error) {
    const message = error instanceof Error ? error.message : '下载失败';
    await patchDownloadEntry(params.sceneId, params.provider, {
      status: 'error',
      speedBytesPerSecond: 0,
      errorMessage: message,
    });
    throw error;
  }
}

export async function downloadImportedCloudVideo(params: {
  sceneId: string;
  provider: CloudVideoProvider;
  remotePath: string;
}) {
  const taskKey = getDownloadTaskKey(params.sceneId, params.provider);
  if (activeDownloadTasks[taskKey]) {
    return getCachedDownloadEntry(params.sceneId, params.provider);
  }

  try {
    await ensureCloudCacheDirUri();
    const { remotePath, remoteUrl, headers, target } = await resolveImportedDownloadRequest(
      params.sceneId,
      params.provider,
      params.remotePath,
    );
    const existingFile = await getInfoAsync(target.uri);
    if (existingFile.exists) {
      await deleteAsync(target.uri, { idempotent: true });
    }
    await saveDownloadEntry({
      sceneId: params.sceneId,
      provider: params.provider,
      targetFileUri: target.uri,
      localVideoUri: undefined,
      remotePath,
      remoteUrl,
      remoteUrlResolvedAt: new Date().toISOString(),
      resumeData: undefined,
      totalBytesWritten: 0,
      totalBytesExpectedToWrite: 0,
      speedBytesPerSecond: 0,
      status: 'resolving',
      progress: 0,
      errorMessage: undefined,
      updatedAt: new Date().toISOString(),
    });
    const task = createSceneDownloadTask({
      sceneId: params.sceneId,
      provider: params.provider,
      remoteUrl,
      localUri: target.uri,
      headers,
    });
    void runSceneDownloadTask(params.sceneId, params.provider, task, 'start').catch(() => {});
    return getCachedDownloadEntry(params.sceneId, params.provider);
  } catch (error) {
    const message = error instanceof Error ? error.message : '下载失败';
    await patchDownloadEntry(params.sceneId, params.provider, {
      status: 'error',
      speedBytesPerSecond: 0,
      errorMessage: message,
    });
    throw error;
  }
}

/**
 * Blocking wrapper around `downloadImportedCloudVideo` for use cases
 * that cannot proceed until the file is on disk (e.g. subtitle
 * generation, which runs ffmpeg against the local copy). Polls the
 * download cache entry until status reaches `completed` or `error`.
 *
 * Returns the local file URI + total bytes written. Throws on `error`
 * or `paused` status, or after `timeoutMs` elapses.
 *
 * Progress is reported via `onProgress` whenever the cache entry updates
 * (throttled to ~2x/sec by `patchDownloadEntry`).
 */
export async function downloadCloudVideoAndWait(params: {
  sceneId: string;
  provider: CloudVideoProvider;
  remotePath: string;
  onProgress?: (entry: NonNullable<Awaited<ReturnType<typeof getDownloadedSceneSource>>>) => void;
  pollIntervalMs?: number;
  timeoutMs?: number;
}): Promise<{ localVideoUri: string; fileSize: number }> {
  const pollIntervalMs = params.pollIntervalMs ?? 500;
  const timeoutMs = params.timeoutMs ?? 30 * 60 * 1000;
  const start = Date.now();
  let lastEmittedAt = 0;

  // Kick off (or join) the download. downloadImportedCloudVideo is
  // idempotent: if a task is already in flight, it returns the current
  // entry without starting a duplicate.
  await downloadImportedCloudVideo({
    sceneId: params.sceneId,
    provider: params.provider,
    remotePath: params.remotePath,
  });

  // Poll the cache until the download reaches a terminal state.
  while (Date.now() - start < timeoutMs) {
    await new Promise<void>((resolve) => setTimeout(resolve, pollIntervalMs));
    const entry = await getCachedDownloadEntry(params.sceneId, params.provider);
    if (!entry) continue;

    // Throttle progress emission to ~2x/sec to avoid UI thrash.
    const now = Date.now();
    if (params.onProgress && now - lastEmittedAt >= 500) {
      params.onProgress(entry);
      lastEmittedAt = now;
    }

    if (entry.status === 'completed' && entry.localVideoUri) {
      return {
        localVideoUri: entry.localVideoUri,
        fileSize: entry.totalBytesWritten ?? 0,
      };
    }
    if (entry.status === 'error') {
      throw new Error(entry.errorMessage || '视频下载失败');
    }
    if (entry.status === 'paused') {
      throw new Error('下载已暂停，请恢复后重试');
    }
    // 'resolving' or 'downloading' → keep polling.
  }
  throw new Error('视频下载超时');
}

export async function pauseOfficialSceneVideoDownload(sceneId: string, provider: CloudVideoProvider) {
  const taskKey = getDownloadTaskKey(sceneId, provider);
  const task = activeDownloadTasks[taskKey];
  const current = await getCachedDownloadEntry(sceneId, provider);
  if (!task || !current) {
    return current;
  }
  const pauseState = await task.pauseAsync();
  delete activeDownloadTasks[taskKey];
  delete downloadSpeedSamples[taskKey];
  return patchDownloadEntry(sceneId, provider, {
    status: 'paused',
    speedBytesPerSecond: 0,
    resumeData: pauseState.resumeData,
    errorMessage: undefined,
  });
}

export async function resumeOfficialSceneVideoDownload(sceneId: string, provider: CloudVideoProvider) {
  const taskKey = getDownloadTaskKey(sceneId, provider);
  if (activeDownloadTasks[taskKey]) {
    return getCachedDownloadEntry(sceneId, provider);
  }
  const current = await getCachedDownloadEntry(sceneId, provider);
  if (!current?.targetFileUri || !current.remotePath) {
    throw new Error('当前没有可恢复的缓存任务');
  }
  const { remoteUrl, headers } = await resolveResumeRemoteUrl(
    sceneId,
    provider,
    current.remotePath,
    current.remoteUrl,
    current.remoteUrlResolvedAt,
  );
  const task = createSceneDownloadTask({
    sceneId,
    provider,
    remoteUrl: remoteUrl || current.remoteUrl || '',
    localUri: current.targetFileUri,
    headers,
    resumeData: current.resumeData,
  });
  await patchDownloadEntry(sceneId, provider, {
    remoteUrl: remoteUrl || current.remoteUrl,
    remoteUrlResolvedAt: new Date().toISOString(),
    errorMessage: undefined,
  });
  void runSceneDownloadTask(sceneId, provider, task, 'resume').catch(() => {});
  return getCachedDownloadEntry(sceneId, provider);
}

export async function removeOfficialSceneVideoDownload(sceneId: string, provider: CloudVideoProvider) {
  const taskKey = getDownloadTaskKey(sceneId, provider);
  const task = activeDownloadTasks[taskKey];
  const current = await getCachedDownloadEntry(sceneId, provider);
  if (task) {
    await task.cancelAsync();
    delete activeDownloadTasks[taskKey];
  }
  delete downloadSpeedSamples[taskKey];
  delete progressPersistTimestamps[taskKey];
  downloadEntryCache.delete(taskKey);
  const fileUri = current?.targetFileUri || current?.localVideoUri;
  if (fileUri) {
    await deleteAsync(fileUri, { idempotent: true });
  }
  await deleteDownloadedSceneSource(sceneId, provider);
}
