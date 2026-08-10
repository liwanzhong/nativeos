/**
 * Clip thumbnail cache
 *
 * For favorited video sentences we cache a single still frame from
 * `startMs` of the source video. This gives the review screen a
 * visual anchor ("which scene was this?") without having to ship an
 * independent video clip and without doing any ffmpeg-style trim.
 *
 * Storage layout:
 *   Paths.cache/clip-thumbs/<videoId>_<segmentId>.jpg
 *
 * Note: this directory is INDEPENDENT from `video-cache/`. Clearing
 * "video cache" (downloads of full videos) does not invalidate the
 * thumbnails — they're part of the knowledge base, not playback.
 *
 * Failure modes (all return null; caller falls back to coverUri):
 *   - network error downloading source
 *   - decoder failure on the source
 *   - file system error writing the cache
 *   - expo-video-thumbnails module not available
 */

import { Directory, File, Paths } from 'expo-file-system';
import { getThumbnailAsync } from 'expo-video-thumbnails';
import { extractVideoFrame } from './media/ffmpeg-thumbnail';

function getClipThumbsDir(): Directory {
  return new Directory(Paths.cache, 'clip-thumbs');
}

function ensureClipThumbsDir(): Directory {
  const dir = getClipThumbsDir();
  if (!dir.exists) {
    dir.create({ intermediates: true });
  }
  return dir;
}

function getThumbKey(videoId: string, segmentId: string): string {
  const safeVid = videoId.replace(/[^a-zA-Z0-9_-]/g, '_');
  const safeSid = segmentId.replace(/[^a-zA-Z0-9_-]/g, '_');
  return `${safeVid}__${safeSid}.jpg`;
}

/**
 * If a cached thumbnail exists for this (videoId, segmentId), return
 * its file URI. Otherwise return null (caller may or may not want to
 * fall through to `getOrCreateClipThumb`).
 */
export async function getClipThumbUri(
  videoId: string,
  segmentId: string,
): Promise<string | null> {
  try {
    const dir = getClipThumbsDir();
    if (!dir.exists) return null;
    const file = new File(dir, getThumbKey(videoId, segmentId));
    if (file.exists && (file.size ?? 0) > 0) {
      return file.uri;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Get an existing thumbnail, or capture a new one from `remoteUrl` at
 * `startMs` (ms) and cache it. Returns a local file:// URI on success,
 * or null on any failure — caller is expected to fall back to the
 * scene's cover image.
 */
export async function getOrCreateClipThumb(
  videoId: string,
  segmentId: string,
  sourceUrl: string,
  startMs: number,
): Promise<string | null> {
  console.log('[ClipThumb] getOrCreateClipThumb start', { videoId, segmentId, startMs, sourceUrl: sourceUrl.slice(0, 120) });

  const existing = await getClipThumbUri(videoId, segmentId);
  if (existing) {
    console.log('[ClipThumb] cache hit', { existing });
    return existing;
  }

  const dir = ensureClipThumbsDir();
  const target = new File(dir, getThumbKey(videoId, segmentId));
  const targetUri = target.uri;
  const isRemote = sourceUrl.startsWith('http://') || sourceUrl.startsWith('https://');

  console.log('[ClipThumb] no cache, will capture', { isRemote, targetUri });

  // Remote URLs (HLS / OSS): expo-video-thumbnails ignores `time` and
  // always returns frame 0. Use ffmpeg which reliably seeks.
  if (isRemote) {
    try {
      console.log('[ClipThumb] ffmpeg extractVideoFrame start', { captureMs: startMs });
      await extractVideoFrame({
        sourceUri: sourceUrl,
        targetUri,
        captureMs: Math.max(0, Math.floor(startMs)),
        logLabel: 'ClipThumb',
      });
      const saved = new File(targetUri);
      console.log('[ClipThumb] ffmpeg done', { exists: saved.exists, size: saved.size ?? 0 });
      if (saved.exists && (saved.size ?? 0) > 0) {
        return targetUri;
      }
      console.warn('[ClipThumb] ffmpeg produced empty file, falling through');
    } catch (err) {
      console.warn('[ClipThumb] ffmpeg failed', { error: err instanceof Error ? err.message : String(err) });
      // fall through to expo-video-thumbnails as last resort
    }
  }

  // Local file:// URLs (or remote ffmpeg fallback): expo-video-thumbnails.
  try {
    console.log('[ClipThumb] expo-video-thumbnails start', { time: startMs, isRemote });
    const result = await getThumbnailAsync(sourceUrl, {
      time: Math.max(0, Math.floor(startMs)),
      quality: 0.7,
    });
    console.log('[ClipThumb] expo-video-thumbnails result', { uri: result?.uri ?? null });

    if (!result?.uri) return null;

    if (target.exists) target.delete();
    const srcFile = new File(result.uri);
    if (!srcFile.exists) {
      console.warn('[ClipThumb] temp file missing, returning raw uri', { uri: result.uri });
      return result.uri;
    }
    srcFile.move(target);
    console.log('[ClipThumb] saved to cache', { targetUri: target.uri });
    return target.uri;
  } catch (err) {
    console.warn('[ClipThumb] expo-video-thumbnails failed', { error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}
