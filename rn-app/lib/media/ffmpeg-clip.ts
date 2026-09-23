/**
 * Video clip extraction using FFmpegKit.
 *
 * Cuts a [startMs, endMs] segment from a local or remote video source
 * without re-encoding (-c copy), so it's fast (typically < 3s).
 *
 * Storage layout:
 *   Paths.document/clip-segments/<videoId>__<segmentId>.mp4
 *
 * The clips directory lives in documentDirectory (not cache) so it
 * persists across app restarts and is not cleared by "clear cache".
 */

import { cacheDirectory, documentDirectory, makeDirectoryAsync, getInfoAsync } from 'expo-file-system/legacy';
import { FFmpegKit, ReturnCode } from '@wokcito/ffmpeg-kit-react-native';

function getClipsDir(): string {
  const base = documentDirectory ?? cacheDirectory;
  if (!base) throw new Error('无法获取存储目录');
  return `${base}clip-segments`;
}

function getClipKey(videoId: string, segmentId: string): string {
  const safeVid = videoId.replace(/[^a-zA-Z0-9_-]/g, '_');
  const safeSid = segmentId.replace(/[^a-zA-Z0-9_-]/g, '_');
  return `${safeVid}__${safeSid}.mp4`;
}

function normalizeForFfmpeg(uri: string): string {
  if (uri.startsWith('file://')) {
    return decodeURIComponent(uri.replace('file://', ''));
  }
  return uri;
}

export function getClipSegmentUri(videoId: string, segmentId: string): string {
  return `${getClipsDir()}/${getClipKey(videoId, segmentId)}`;
}

export async function getCachedClipUri(
  videoId: string,
  segmentId: string,
): Promise<string | null> {
  try {
    const uri = getClipSegmentUri(videoId, segmentId);
    const info = await getInfoAsync(uri);
    if (info.exists && 'size' in info && (info.size ?? 0) > 0) {
      return uri;
    }
    return null;
  } catch {
    return null;
  }
}

export async function extractVideoClip(params: {
  videoId: string;
  segmentId: string;
  sourceUri: string;
  startMs: number;
  endMs: number;
  headers?: Record<string, string>;
}): Promise<string | null> {
  const { videoId, segmentId, sourceUri, startMs, endMs, headers } = params;

  console.log('[ClipSegment] extractVideoClip start', {
    videoId,
    segmentId,
    startMs,
    endMs,
    durationMs: endMs - startMs,
    sourceUri: sourceUri.slice(0, 120),
  });

  const existing = await getCachedClipUri(videoId, segmentId);
  if (existing) {
    console.log('[ClipSegment] cache hit', { existing });
    return existing;
  }

  const clipsDir = getClipsDir();
  await makeDirectoryAsync(clipsDir, { intermediates: true });

  const targetUri = getClipSegmentUri(videoId, segmentId);
  const targetPath = normalizeForFfmpeg(targetUri);
  const sourcePath = normalizeForFfmpeg(sourceUri);

  const startSec = Math.max(0, startMs / 1000);
  const endSec = endMs / 1000;
  const isRemote = sourceUri.startsWith('http://') || sourceUri.startsWith('https://');

  const args: string[] = ['-y'];

  if (isRemote) {
    args.push('-rw_timeout', '20000000');
    const entries = Object.entries(headers ?? {});
    const ua = entries.find(([k]) => k.toLowerCase() === 'user-agent')?.[1];
    if (ua) args.push('-user_agent', ua);
    const extraHeaders = entries
      .filter(([k]) => k.toLowerCase() !== 'user-agent')
      .map(([k, v]) => `${k}: ${v}`)
      .join('\r\n');
    if (extraHeaders) args.push('-headers', `${extraHeaders}\r\n`);
  }

  // Seek BEFORE -i for fast seeking (keyframe-accurate input seek)
  args.push('-ss', String(startSec), '-to', String(endSec));
  args.push('-i', sourcePath);
  args.push('-c', 'copy', '-avoid_negative_ts', 'make_zero');
  args.push(targetPath);

  console.log('[ClipSegment] ffmpeg args', args.join(' '));

  try {
    const session: any = await FFmpegKit.executeWithArguments(args);
    const rc = await session.getReturnCode();
    const output = typeof session.getOutput === 'function' ? await session.getOutput() : '';

    if (!ReturnCode.isSuccess(rc)) {
      console.warn('[ClipSegment] ffmpeg failed', { rc: String(rc), output: output?.slice(0, 500) });
      return null;
    }

    const info = await getInfoAsync(targetUri);
    if (!info.exists || !('size' in info) || !info.size) {
      console.warn('[ClipSegment] ffmpeg produced empty file');
      return null;
    }

    console.log('[ClipSegment] success', { targetUri, size: info.size });
    return targetUri;
  } catch (err) {
    console.warn('[ClipSegment] exception', { error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

export async function deleteClipSegment(videoId: string, segmentId: string): Promise<void> {
  try {
    const { deleteAsync } = await import('expo-file-system/legacy');
    const uri = getClipSegmentUri(videoId, segmentId);
    const info = await getInfoAsync(uri);
    if (info.exists) {
      await deleteAsync(uri, { idempotent: true });
      console.log('[ClipSegment] deleted', { uri });
    }
  } catch (err) {
    console.warn('[ClipSegment] delete failed', { error: err instanceof Error ? err.message : String(err) });
  }
}

// ── Range clip (multi-segment selection) ─────────────────────────────────
//
// Keyed by videoId + startMs + endMs rather than a single segmentId.
// Multiple sentence cards may share the same range clip via clipUri;
// deletion of any single sentence card via deleteClipSegment() will NOT
// touch a range clip (different file name). To remove a range clip,
// call deleteRangeClip() explicitly after verifying no sentence card
// still references it.

function getRangeClipKey(videoId: string, startMs: number, endMs: number): string {
  const safeVid = videoId.replace(/[^a-zA-Z0-9_-]/g, '_');
  return `${safeVid}__range_${Math.round(startMs)}-${Math.round(endMs)}.mp4`;
}

export function getRangeClipUri(videoId: string, startMs: number, endMs: number): string {
  return `${getClipsDir()}/${getRangeClipKey(videoId, startMs, endMs)}`;
}

export async function getCachedRangeClipUri(
  videoId: string,
  startMs: number,
  endMs: number,
): Promise<string | null> {
  try {
    const uri = getRangeClipUri(videoId, startMs, endMs);
    const info = await getInfoAsync(uri);
    if (info.exists && 'size' in info && (info.size ?? 0) > 0) {
      return uri;
    }
    return null;
  } catch {
    return null;
  }
}

export async function extractRangeClip(params: {
  videoId: string;
  startMs: number;
  endMs: number;
  sourceUri: string;
  headers?: Record<string, string>;
}): Promise<string | null> {
  const { videoId, startMs, endMs, sourceUri, headers } = params;

  if (!(endMs > startMs)) {
    console.warn('[ClipSegment] extractRangeClip invalid range', { startMs, endMs });
    return null;
  }

  console.log('[ClipSegment] extractRangeClip start', {
    videoId,
    startMs,
    endMs,
    durationMs: endMs - startMs,
    sourceUri: sourceUri.slice(0, 120),
  });

  const existing = await getCachedRangeClipUri(videoId, startMs, endMs);
  if (existing) {
    console.log('[ClipSegment] range cache hit', { existing });
    return existing;
  }

  const clipsDir = getClipsDir();
  await makeDirectoryAsync(clipsDir, { intermediates: true });

  const targetUri = getRangeClipUri(videoId, startMs, endMs);
  const targetPath = normalizeForFfmpeg(targetUri);
  const sourcePath = normalizeForFfmpeg(sourceUri);

  const startSec = Math.max(0, startMs / 1000);
  const endSec = endMs / 1000;
  const isRemote = sourceUri.startsWith('http://') || sourceUri.startsWith('https://');

  const args: string[] = ['-y'];

  if (isRemote) {
    args.push('-rw_timeout', '20000000');
    const entries = Object.entries(headers ?? {});
    const ua = entries.find(([k]) => k.toLowerCase() === 'user-agent')?.[1];
    if (ua) args.push('-user_agent', ua);
    const extraHeaders = entries
      .filter(([k]) => k.toLowerCase() !== 'user-agent')
      .map(([k, v]) => `${k}: ${v}`)
      .join('\r\n');
    if (extraHeaders) args.push('-headers', `${extraHeaders}\r\n`);
  }

  // Seek BEFORE -i for fast seeking (keyframe-accurate input seek)
  args.push('-ss', String(startSec), '-to', String(endSec));
  args.push('-i', sourcePath);
  args.push('-c', 'copy', '-avoid_negative_ts', 'make_zero');
  args.push(targetPath);

  console.log('[ClipSegment] range ffmpeg args', args.join(' '));

  try {
    const session: any = await FFmpegKit.executeWithArguments(args);
    const rc = await session.getReturnCode();
    const output = typeof session.getOutput === 'function' ? await session.getOutput() : '';

    if (!ReturnCode.isSuccess(rc)) {
      console.warn('[ClipSegment] range ffmpeg failed', { rc: String(rc), output: output?.slice(0, 500) });
      return null;
    }

    const info = await getInfoAsync(targetUri);
    if (!info.exists || !('size' in info) || !info.size) {
      console.warn('[ClipSegment] range ffmpeg produced empty file');
      return null;
    }

    console.log('[ClipSegment] range success', { targetUri, size: info.size });
    return targetUri;
  } catch (err) {
    console.warn('[ClipSegment] range exception', { error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

export async function deleteRangeClip(
  videoId: string,
  startMs: number,
  endMs: number,
): Promise<void> {
  try {
    const { deleteAsync } = await import('expo-file-system/legacy');
    const uri = getRangeClipUri(videoId, startMs, endMs);
    const info = await getInfoAsync(uri);
    if (info.exists) {
      await deleteAsync(uri, { idempotent: true });
      console.log('[ClipSegment] range deleted', { uri });
    }
  } catch (err) {
    console.warn('[ClipSegment] range delete failed', { error: err instanceof Error ? err.message : String(err) });
  }
}
