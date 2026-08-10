import {
  getBaiduPanBinding,
  getConfiguredCloudProviders,
  listOfficialSceneSyncRecords,
  replaceOfficialSceneSyncRecords,
  type CloudVideoProvider,
  type OfficialSceneSyncRecord,
  type OfficialSceneSyncStatus,
} from './cloud-drive-bindings';
import { listOfficialSceneCatalog, type OfficialSceneCatalogItem } from './video-scenes';

const BAIDU_API_BASE = 'https://pan.baidu.com';

type ProviderSyncSummary = {
  total: number;
  available: number;
  notSynced: number;
  stale: number;
  error: number;
  lastCheckedAt?: string;
};

export type OfficialSceneSyncIssueItem = {
  sceneId: string;
  title: string;
  level: string;
  category: string;
  provider: CloudVideoProvider;
  status: Exclude<OfficialSceneSyncStatus, 'available'>;
  officialVideoKey: string;
  syncedOfficialVideoKey?: string;
  remotePath?: string;
  errorMessage?: string;
  lastCheckedAt?: string;
};

export type OfficialSceneSyncSummary = {
  totalScenes: number;
  connectedProviders: CloudVideoProvider[];
  providers: Record<CloudVideoProvider, ProviderSyncSummary>;
  issues: OfficialSceneSyncIssueItem[];
};

type BaiduPanFile = {
  path: string;
  fsId?: number;
  name?: string;
};

type RemoteVideoFile = {
  path: string;
  name: string;
  remoteFileId?: number;
};

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

function basenameUnix(path: string) {
  const normalized = normalizeUnixPath(path);
  if (normalized === '/') return '/';
  const parts = normalized.split('/').filter(Boolean);
  return parts[parts.length - 1] || '/';
}

function normalizeOfficialVideoKey(videoKey: string) {
  return (videoKey || '').trim().replace(/\\/g, '/').replace(/^\/+/, '');
}

function isPathWithinRoot(path: string, rootPath: string) {
  const normalizedPath = normalizeUnixPath(path);
  const normalizedRoot = normalizeUnixPath(rootPath);
  if (normalizedRoot === '/') {
    return true;
  }
  return normalizedPath === normalizedRoot || normalizedPath.startsWith(`${normalizedRoot}/`);
}

function compareRemoteVideoFilePriority(left: RemoteVideoFile, right: RemoteVideoFile) {
  const leftPath = normalizeUnixPath(left.path);
  const rightPath = normalizeUnixPath(right.path);
  const leftDepth = leftPath.split('/').filter(Boolean).length;
  const rightDepth = rightPath.split('/').filter(Boolean).length;
  if (leftDepth !== rightDepth) {
    return leftDepth - rightDepth;
  }
  return leftPath.localeCompare(rightPath, 'zh-CN');
}

function dedupeRemoteVideoFiles(files: RemoteVideoFile[]) {
  const fileMap = new Map<string, RemoteVideoFile>();
  files.forEach((file) => {
    fileMap.set(normalizeUnixPath(file.path), {
      path: normalizeUnixPath(file.path),
      name: file.name || basenameUnix(file.path),
      remoteFileId: file.remoteFileId,
    });
  });
  return Array.from(fileMap.values()).sort(compareRemoteVideoFilePriority);
}

function findRemoteVideoFileForKey(
  officialVideoKey: string,
  rootPath: string,
  files: RemoteVideoFile[],
) {
  const normalizedKey = normalizeOfficialVideoKey(officialVideoKey);
  const expectedPath = normalizeUnixPath(joinUnixPath(rootPath, normalizedKey));
  const exactMatch = files.find((file) => normalizeUnixPath(file.path) === expectedPath);
  if (exactMatch) {
    return exactMatch;
  }

  const suffix = `/${normalizedKey}`;
  const suffixMatches = files
    .filter((file) => normalizeUnixPath(file.path).endsWith(suffix))
    .sort(compareRemoteVideoFilePriority);
  if (suffixMatches.length > 0) {
    return suffixMatches[0];
  }

  const fileName = basenameUnix(normalizedKey);
  return files
    .filter((file) => file.name === fileName)
    .sort(compareRemoteVideoFilePriority)[0];
}

function toRemoteVideoFile(file: BaiduPanFile): RemoteVideoFile {
  return {
    path: normalizeUnixPath(file.path),
    name: file.name || basenameUnix(file.path),
    remoteFileId: file.fsId,
  };
}

 function resolveTargetRemotePath(rootPath: string, item: OfficialSceneCatalogItem, previous?: OfficialSceneSyncRecord) {
   if (previous?.bindingType === 'manual' && previous.remotePath) {
     return normalizeUnixPath(previous.remotePath);
   }
   return joinUnixPath(rootPath, item.videoKey);
 }

function buildSummary(
  catalog: OfficialSceneCatalogItem[],
  records: OfficialSceneSyncRecord[],
  connectedProviders: CloudVideoProvider[],
): OfficialSceneSyncSummary {
  const stats: OfficialSceneSyncSummary['providers'] = {
    baidu_pan: {
      total: connectedProviders.includes('baidu_pan') ? catalog.length : 0,
      available: 0,
      notSynced: 0,
      stale: 0,
      error: 0,
    },
  };

  const recordMap = new Map<string, OfficialSceneSyncRecord>();
  const catalogMap = new Map<string, OfficialSceneCatalogItem>();
  const issues: OfficialSceneSyncIssueItem[] = [];
  catalog.forEach((item) => {
    catalogMap.set(item.id, item);
  });
  records.forEach((record) => {
    recordMap.set(`${record.sceneId}__${record.provider}`, record);
  });

  connectedProviders.forEach((provider) => {
    catalog.forEach((item) => {
      const record = recordMap.get(`${item.id}__${provider}`);
      const target = stats[provider];
      const effectiveStatus = record?.status ?? 'not_synced';
      if (effectiveStatus === 'available') {
        target.available += 1;
      } else if (effectiveStatus === 'stale') {
        target.stale += 1;
      } else if (effectiveStatus === 'error') {
        target.error += 1;
      } else {
        target.notSynced += 1;
      }
      if (effectiveStatus !== 'available') {
        const scene = catalogMap.get(item.id);
        if (scene) {
          issues.push({
            sceneId: scene.id,
            title: scene.title,
            level: scene.level,
            category: scene.category,
            provider,
            status: effectiveStatus,
            officialVideoKey: scene.videoKey,
            syncedOfficialVideoKey: record?.syncedOfficialVideoKey,
            remotePath: record?.remotePath,
            errorMessage: record?.errorMessage,
            lastCheckedAt: record?.lastCheckedAt,
          });
        }
      }
      if (record?.lastCheckedAt && (!target.lastCheckedAt || record.lastCheckedAt > target.lastCheckedAt)) {
        target.lastCheckedAt = record.lastCheckedAt;
      }
    });
  });

  return {
    totalScenes: catalog.length,
    connectedProviders,
    providers: stats,
    issues: issues.sort((left, right) => {
      const rank = { stale: 0, error: 1, not_synced: 2 };
      const statusDelta = rank[left.status] - rank[right.status];
      if (statusDelta !== 0) return statusDelta;
      return left.title.localeCompare(right.title, 'zh-CN');
    }),
  };
}

async function listBaiduDirectory(accessToken: string, dir: string = '/') {
  const qs = new URLSearchParams({
    method: 'list',
    access_token: accessToken,
    dir,
    order: 'time',
    start: '0',
    limit: '500',
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
  return ((json.list || []) as Array<{ path: string; fs_id?: number; server_filename?: string }>).map((item) => ({
    path: item.path,
    fsId: item.fs_id,
    name: item.server_filename,
  }));
}

async function listBaiduVideosRecursive(accessToken: string, rootPath: string) {
  const qs = new URLSearchParams({
    method: 'videolist',
    access_token: accessToken,
    parent_path: normalizeUnixPath(rootPath),
    recursion: '1',
    web: '1',
  });
  const resp = await fetch(`${BAIDU_API_BASE}/rest/2.0/xpan/file?${qs.toString()}`, {
    method: 'GET',
    headers: { 'User-Agent': 'pan.baidu.com' },
  });
  const json = await resp.json() as {
    errno?: number;
    info?: Array<{ path: string; fs_id?: number; server_filename?: string }>;
  };
  if (json.errno !== 0) {
    throw new Error(`获取百度网盘视频列表失败: errno=${json.errno}`);
  }
  return dedupeRemoteVideoFiles((json.info || []).map((item) => ({
    path: item.path,
    name: item.server_filename || basenameUnix(item.path),
    remoteFileId: item.fs_id,
  })));
}

async function listBaiduFilesForScan(accessToken: string, rootPath: string, extraPaths: string[]) {
  const files = await listBaiduVideosRecursive(accessToken, rootPath);
  const extraDirs = Array.from(new Set(
    extraPaths
      .map((path) => normalizeUnixPath(path))
      .filter((path) => !isPathWithinRoot(path, rootPath))
      .map((path) => dirnameUnix(path)),
  ));

  for (const dir of extraDirs) {
    const dirFiles = await listBaiduDirectory(accessToken, dir);
    files.push(...dirFiles.map(toRemoteVideoFile));
  }

  return dedupeRemoteVideoFiles(files);
}

async function scanBaiduProvider(
  catalog: OfficialSceneCatalogItem[],
  existingRecords: Map<string, OfficialSceneSyncRecord>,
): Promise<OfficialSceneSyncRecord[]> {
  const binding = await getBaiduPanBinding();
  if (!binding?.token?.accessToken || !binding.rootPath) {
    return [];
  }

  const expectedPaths = catalog.map((item) => {
    const previous = existingRecords.get(`${item.id}__baidu_pan`);
    return resolveTargetRemotePath(binding.rootPath, item, previous);
  });
  const remoteFiles = await listBaiduFilesForScan(binding.token.accessToken, binding.rootPath, expectedPaths);

  const now = new Date().toISOString();
  return catalog.map((item) => {
    const previous = existingRecords.get(`${item.id}__baidu_pan`);
    const expectedRemotePath = resolveTargetRemotePath(binding.rootPath, item, previous);
    const manualRemotePath = previous?.bindingType === 'manual' ? previous.remotePath : undefined;
    const matchedFile = manualRemotePath
      ? remoteFiles.find((file) => normalizeUnixPath(file.path) === normalizeUnixPath(manualRemotePath))
      : findRemoteVideoFileForKey(item.videoKey, binding.rootPath, remoteFiles);
    const exists = Boolean(matchedFile);
    const status: OfficialSceneSyncStatus = exists
      ? 'available'
      : previous?.bindingType === 'manual' && previous.remotePath
        ? 'error'
      : previous?.syncedOfficialVideoKey && previous.syncedOfficialVideoKey !== item.videoKey
        ? 'stale'
        : 'not_synced';
    return {
      sceneId: item.id,
      provider: 'baidu_pan' as const,
      officialVideoKey: item.videoKey,
      syncedOfficialVideoKey: exists ? item.videoKey : previous?.syncedOfficialVideoKey,
      remotePath: matchedFile?.path || expectedRemotePath,
      remoteFileId: exists ? matchedFile?.remoteFileId ?? previous?.remoteFileId : previous?.remoteFileId,
      bindingType: previous?.bindingType === 'manual' ? 'manual' : 'scanned',
      status,
      errorMessage: exists
        ? undefined
        : previous?.bindingType === 'manual' && previous.remotePath
          ? '当前绑定的视频文件不存在，请重新绑定'
          : previous?.syncedOfficialVideoKey && previous.syncedOfficialVideoKey !== item.videoKey
            ? '官方内容已更新，需要重新同步'
            : undefined,
      lastCheckedAt: now,
    };
  });
}

export async function getOfficialSceneSyncSummary(forceRefreshCatalog: boolean = false): Promise<OfficialSceneSyncSummary> {
  const [catalog, records, connectedProviders] = await Promise.all([
    listOfficialSceneCatalog(forceRefreshCatalog),
    listOfficialSceneSyncRecords(),
    getConfiguredCloudProviders(),
  ]);
  return buildSummary(catalog, records, connectedProviders);
}

export async function rescanOfficialSceneSyncStatus(forceRefreshCatalog: boolean = true): Promise<OfficialSceneSyncSummary> {
  const [catalog, existingRecords, connectedProviders] = await Promise.all([
    listOfficialSceneCatalog(forceRefreshCatalog),
    listOfficialSceneSyncRecords(),
    getConfiguredCloudProviders(),
  ]);

  const existingMap = new Map<string, OfficialSceneSyncRecord>();
  existingRecords.forEach((record) => {
    existingMap.set(`${record.sceneId}__${record.provider}`, record);
  });

  const nextRecords: OfficialSceneSyncRecord[] = [];

  if (connectedProviders.includes('baidu_pan')) {
    try {
      nextRecords.push(...await scanBaiduProvider(catalog, existingMap));
    } catch (error) {
      const now = new Date().toISOString();
      catalog.forEach((item) => {
        nextRecords.push({
          sceneId: item.id,
          provider: 'baidu_pan',
          officialVideoKey: item.videoKey,
          syncedOfficialVideoKey: existingMap.get(`${item.id}__baidu_pan`)?.syncedOfficialVideoKey,
          remotePath: existingMap.get(`${item.id}__baidu_pan`)?.remotePath,
          remoteFileId: existingMap.get(`${item.id}__baidu_pan`)?.remoteFileId,
          bindingType: existingMap.get(`${item.id}__baidu_pan`)?.bindingType,
          status: 'error',
          errorMessage: error instanceof Error ? error.message : '百度网盘扫描失败',
          lastCheckedAt: now,
        });
      });
    }
  }

  await replaceOfficialSceneSyncRecords(nextRecords);
  return buildSummary(catalog, nextRecords, connectedProviders);
}
