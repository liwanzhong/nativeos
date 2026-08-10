import { Directory, File, Paths } from 'expo-file-system';

const getVideoCacheDir = () => new Directory(Paths.cache, 'video-cache');

function simpleHash(value: string) {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) - hash) + value.charCodeAt(index);
    hash |= 0;
  }
  return Math.abs(hash).toString(36);
}

function ensureVideoCacheDir() {
  const dir = getVideoCacheDir();
  if (!dir.exists) {
    dir.create({ intermediates: true });
  }
  return dir;
}

function getVideoCacheKey(sceneId: string, remoteUrl: string) {
  const extMatch = remoteUrl.match(/\.([a-zA-Z0-9]+)(?:$|\?)/);
  const ext = extMatch?.[1] || 'mp4';
  const remoteHash = simpleHash(remoteUrl);
  return `${sceneId.replace(/[^a-zA-Z0-9_-]/g, '_')}_${remoteHash}.${ext}`;
}

function getCachedVideoFile(sceneId: string, remoteUrl: string) {
  const dir = ensureVideoCacheDir();
  return new File(dir, getVideoCacheKey(sceneId, remoteUrl));
}

export async function getCachedVideoUri(sceneId: string, remoteUrl: string): Promise<string | null> {
  try {
    const file = getCachedVideoFile(sceneId, remoteUrl);
    if (file.exists && (file.size ?? 0) > 0) {
      return file.uri;
    }
    return null;
  } catch {
    return null;
  }
}

export async function cacheVideoLocally(sceneId: string, remoteUrl: string): Promise<string> {
  const existing = await getCachedVideoUri(sceneId, remoteUrl);
  if (existing) {
    return existing;
  }

  try {
    const dir = ensureVideoCacheDir();
    const downloaded = await File.downloadFileAsync(remoteUrl, dir);
    const target = new File(dir, getVideoCacheKey(sceneId, remoteUrl));
    if (target.exists) {
      target.delete();
    }
    downloaded.move(target);
    return target.uri;
  } catch {
    return remoteUrl;
  }
}

export async function clearVideoCache(): Promise<void> {
  try {
    const dir = getVideoCacheDir();
    if (!dir.exists) {
      return;
    }
    const entries = dir.list();
    for (const entry of entries) {
      entry.delete();
    }
  } catch {
  }
}

export async function getVideoCacheStats(): Promise<{ fileCount: number; totalSize: number }> {
  try {
    const dir = getVideoCacheDir();
    if (!dir.exists) {
      return { fileCount: 0, totalSize: 0 };
    }
    const entries = dir.list().filter((entry) => entry instanceof File) as File[];
    const totalSize = entries.reduce((sum, file) => sum + (file.size ?? 0), 0);
    return {
      fileCount: entries.length,
      totalSize,
    };
  } catch {
    return { fileCount: 0, totalSize: 0 };
  }
}
