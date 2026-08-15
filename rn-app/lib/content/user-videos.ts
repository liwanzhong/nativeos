import * as DocumentPicker from 'expo-document-picker';
import {
  copyAsync,
  deleteAsync,
  documentDirectory,
  getInfoAsync,
  makeDirectoryAsync,
  readAsStringAsync,
  writeAsStringAsync,
} from 'expo-file-system/legacy';
import * as VideoThumbnails from 'expo-video-thumbnails';
import { z } from 'zod';
import { cleanupExtractedAudio, extractAudioToWav, extractRemoteAudioToWav } from '../media/ffmpeg-audio';
import { extractVideoFrame } from '../media/ffmpeg-thumbnail';
import { transcribeWavFileDirect } from '../volcengine/file-asr';
import { generateSubtitleTranslationPayload } from './subtitle-translation';
import {
  correctThenSplit,
  json3EventsToSubtitleUnits,
  type SubtitleUnit,
  type CorrectedSubtitleSegment,
} from './subtitle-segmenter';
import type { CloudVideoProvider } from './cloud-drive-bindings';
import {
  downloadCloudVideoAndWait,
  removeOfficialSceneVideoDownload,
  resolveCloudReferencedVideoCoverSource,
  resolveCloudReferencedVideoSource,
} from './cloud-video-playback';
import { getOrCreateDefaultCollection, encodeUserCollectionId, listUserCollections } from './user-collections';
import {
  checkSubtitleQuota,
  consumeQuota,
  minutesForAudioSeconds,
  type SubtitleQuotaCheck,
} from '../quota';

/**
 * Thrown when a Free user tries to generate a video subtitle. The UI
 * catches this and shows the dedicated Pro gate page (not a generic
 * error). Distinguishing this from `error` lets the user recover by
 * upgrading rather than retrying.
 */
export class SubtitleProRequiredError extends Error {
  readonly code = 'subtitle_pro_required';
  readonly check: SubtitleQuotaCheck;
  constructor(check: SubtitleQuotaCheck) {
    super('字幕生成是 Pro 专属功能');
    this.name = 'SubtitleProRequiredError';
    this.check = check;
  }
}

/**
 * Thrown when a Pro user has used up today's subtitle hard quota.
 * The UI catches this to show a friendly "come back tomorrow" /
 * "check membership" prompt, with the remaining/needed amounts in
 * `check` for display.
 */
export class SubtitleQuotaExhaustedError extends Error {
  readonly code = 'subtitle_quota_exhausted';
  readonly check: SubtitleQuotaCheck;
  constructor(check: SubtitleQuotaCheck) {
    super('今日字幕生成额度已用完');
    this.name = 'SubtitleQuotaExhaustedError';
    this.check = check;
  }
}

const USER_VIDEOS_ROOT_DIR = `${documentDirectory ?? ''}user-videos`;
const USER_VIDEOS_FILES_DIR = `${USER_VIDEOS_ROOT_DIR}/files`;
const USER_VIDEOS_COVERS_DIR = `${USER_VIDEOS_ROOT_DIR}/covers`;
const USER_VIDEOS_SUBTITLES_DIR = `${USER_VIDEOS_ROOT_DIR}/subtitles`;
const USER_VIDEOS_AI_PRACTICE_DIR = `${USER_VIDEOS_ROOT_DIR}/ai-practice`;
const USER_VIDEOS_INDEX_PATH = `${USER_VIDEOS_ROOT_DIR}/index.json`;
const LOCAL_ASR_CHUNK_SIZE_MS = 90_000;
const CLOUD_REMOTE_ASR_CHUNK_SIZE_MS = 10_000;
const CLOUD_REMOTE_HTTP_SLAB_SIZE_MS = 90_000;
const WAV_HEADER_BYTES = 44;
const WAV_BYTES_PER_SECOND = 16_000 * 2;
const activeCloudCoverGenerationTasks: Record<string, Promise<void> | undefined> = {};

const subtitleStatusSchema = z.enum(['none', 'pending', 'processing', 'ready', 'error']);

/**
 * Subtitle generation is now a 3-stage pipeline (cloud videos go through
 * all 3, local ones skip the download stage). We expose the current
 * stage on the entry so the UI can show a precise progress message
 * instead of an opaque "处理中" spinner.
 *
 *   'downloading' — pulling the cloud file into local cache (cloud only)
 *   'extracting'  — ffmpeg extracting a wav chunk from the local file
 *   'asr'         — sending wav chunks to the ASR provider
 *
 * When `subtitlePhase` is absent, fall back to the legacy single-stage
 * `subtitleStatus: 'processing'` rendering.
 */
const subtitlePhaseSchema = z.enum(['downloading', 'extracting', 'asr']).optional();

const userVideoEntrySchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  sourceType: z.enum(['local_file', 'cloud_reference']),
  sourceLabel: z.string().min(1),
  importedAt: z.string().min(1),
  level: z.string().min(1),
  category: z.string().min(1),
  type: z.string().min(1),
  durationSeconds: z.number().nonnegative().optional(),
  coverImageUri: z.string().optional(),
  subtitleStatus: subtitleStatusSchema,
  /** Stage of the current generation run. See subtitlePhaseSchema. */
  subtitlePhase: subtitlePhaseSchema,
  /** 0..1 progress for the current `subtitlePhase` (best-effort). */
  subtitlePhaseProgress: z.number().min(0).max(1).optional(),
  /** Free-form human-readable progress message (e.g. "下载 88MB / 250MB"). */
  subtitlePhaseMessage: z.string().optional(),
  /** Total minutes charged (rounded up) for the most recent run. */
  subtitleChargedMinutes: z.number().nonnegative().optional(),
  subtitleUri: z.string().optional(),
  subtitleZhUri: z.string().optional(),
  subtitleUpdatedAt: z.string().optional(),
  subtitleCursorMs: z.number().nonnegative().optional(),
  /**
   * Owning collection id. Same format as imported_video_packs: 
   * `"user:<bigserial>"` for user-built collections; absent means
   * "uncategorised — surface under the default collection at read
   * time". Set on import, editable from the video detail page.
   */
  collectionId: z.string().optional(),
  localVideoUri: z.string().optional(),
  /** When set: this cloud video has been downloaded into the local
   *  cache and the local copy is the source of truth for any
   *  subtitle / playback operation. */
  cachedLocalUri: z.string().optional(),
  /** Total bytes of the cached local copy. */
  cachedLocalSize: z.number().nonnegative().optional(),
  /** ISO timestamp of when the cloud video finished downloading locally. */
  cachedAt: z.string().optional(),

  // ── AI practice topic state ──
  // Mirrors the subtitle pipeline: a status enum, an optional
  // phase (so the UI can show "提取字幕 / 调用 LLM / 保存" style
  // progress), and a 0..1 progress + human-readable message. The
  // generated scenario cards are stored in a separate JSON file
  // pointed to by `aiPracticeUri` (same separation pattern we use
  // for `subtitleUri`) so the index doesn't bloat on every
  // generation run. The generation trigger is in
  // `user-video-ai-practice.ts`; the schema only carries the
  // persisted state.
  aiPracticeStatus: z.enum(['none', 'pre-shipped', 'pending', 'processing', 'ready', 'error']).optional(),
  aiPracticePhase: z.enum(['preparing', 'extracting-subtitle', 'calling-llm', 'saving']).optional(),
  aiPracticeProgress: z.number().min(0).max(1).optional(),
  aiPracticeProgressMessage: z.string().optional(),
  /** Number of practice scenario cards saved. */
  aiPracticeCount: z.number().int().nonnegative().optional(),
  /** Local URI of the saved cards JSON (one file per entry, the
   *  same `aiPracticeFileName` is just for human reference). */
  aiPracticeUri: z.string().optional(),
  /** ISO timestamp of the most recent successful generation. */
  aiPracticeUpdatedAt: z.string().optional(),
  /** Last error message from a failed run; cleared on next run. */
  aiPracticeErrorMessage: z.string().optional(),

  localFileName: z.string().optional(),
  mimeType: z.string().optional(),
  provider: z
    .string()
    .optional()
    .transform((value): CloudVideoProvider | undefined =>
      value === 'baidu_pan' ? 'baidu_pan' : undefined,
    ),
  remotePath: z.string().optional(),
  remoteFileId: z.string().optional(),
  remoteFileName: z.string().optional(),
  fileSize: z.number().nonnegative().optional(),
});

const userVideosIndexSchema = z.object({
  version: z.literal(1),
  items: z.array(userVideoEntrySchema),
});

export type UserVideoSubtitleStatus = z.infer<typeof subtitleStatusSchema>;
export type UserVideoEntry = z.infer<typeof userVideoEntrySchema>;

type Json3Event = {
  tStartMs: number;
  dDurationMs: number;
  segs: Array<{
    utf8: string;
    tOffsetMs?: number;
  }>;
};

type Json3File = {
  wireMagic: 'pb3';
  events: Json3Event[];
  xGeneratedRanges?: Array<{
    startMs: number;
    endMs: number;
  }>;
};

type AsrUploadWord = {
  text?: string;
  word?: string;
  start_time?: number;
  end_time?: number;
  startTime?: number;
  endTime?: number;
  start_ms?: number;
  end_ms?: number;
  startMs?: number;
  endMs?: number;
};

type AsrUploadUtterance = {
  text?: string;
  start_time?: number;
  end_time?: number;
  startTime?: number;
  endTime?: number;
  start_ms?: number;
  end_ms?: number;
  startMs?: number;
  endMs?: number;
  words?: AsrUploadWord[];
};

type AsrUploadResponse = {
  text?: string;
  utterances?: AsrUploadUtterance[];
};

interface ImportLocalVideoOptions {
  sourceName?: string | null;
  mimeType?: string | null;
  /**
   * Owning collection wire id (`"user:<bigserial>"`). When absent,
   * the import flow lazy-creates the default collection and tags the
   * entry with its wire id. Set by the import-sheet picker when the
   * user has chosen a non-default target.
   */
  collectionId?: string;
  /**
   * Skip the duplicate-by-name detection. Set by the import sheet
   * when the user confirms "Import anyway" from the duplicate
   * dialog. We still log the dedup result so a future investigation
   * can see what was bypassed.
   */
  force?: boolean;
}

interface CreateCloudVideoReferenceParams {
  provider: CloudVideoProvider;
  title?: string;
  remotePath?: string;
  remoteFileId?: string | number;
  remoteFileName?: string;
  fileSize?: number;
  /**
   * Owning collection wire id. See `ImportLocalVideoOptions` for
   * the same semantics.
   */
  collectionId?: string;
}

export class DuplicateLocalVideoImportError extends Error {
  readonly code = 'duplicate_local_video';
  readonly existingEntry: UserVideoEntry;

  constructor(existingEntry: UserVideoEntry) {
    super('视频已经导入过，无需重复导入');
    this.name = 'DuplicateLocalVideoImportError';
    this.existingEntry = existingEntry;
  }
}

function ensureUserVideosAvailable() {
  if (!documentDirectory) {
    throw new Error('当前环境不支持本地视频导入');
  }
}

async function generateAndSaveSubtitleTranslation(id: string, subtitleUri?: string) {
  if (!subtitleUri) {
    throw new Error('字幕文件不存在，无法生成中文字幕');
  }
  const subtitleJson = await readJsonFile<Json3File>(subtitleUri);
  // 2026-08-15: 跟桌面端镜像 — 优先读 *.en.segmented.json, 里面是 LLM 修过
  // 标点 + 本地按标点切/合并的 segments. 没有就回退到本地 groupTokensByEvent
  // 切分 (旧行为, 切得碎).
  let segmentedPayload: { sourceSubtitle?: string; segmentCount?: number; segments?: Array<{ id?: string; text?: string; startMs?: number; endMs?: number }> } | undefined;
  try {
    const segmentedUri = getSubtitleSegmentedTargetUri(id);
    const raw = await readAsStringAsync(segmentedUri);
    if (raw) {
      segmentedPayload = JSON.parse(raw);
    }
  } catch {
    // 没有 segmented.json 或解析失败, 忽略, fallback 到本地切分
  }
  const payload = await generateSubtitleTranslationPayload(
    subtitleJson,
    subtitleUri.split('/').pop() || subtitleUri,
    segmentedPayload ? { segmentedPayload } : undefined,
  );
  const subtitleZhUri = getSubtitleTranslationTargetUri(id);
  await writeJsonFile(subtitleZhUri, payload);
  await updateUserVideoEntry(id, (current) => ({
    ...current,
    subtitleZhUri,
    subtitleUpdatedAt: new Date().toISOString(),
  }));
  return subtitleZhUri;
}

function sanitizeSegment(value: string) {
  return value.replace(/[^a-zA-Z0-9_-]/g, '_') || `video_${Date.now()}`;
}

function getFileNameFromUri(uri: string) {
  const normalized = uri.split('?')[0] || uri;
  const segments = normalized.split('/').filter(Boolean);
  return segments.length ? segments[segments.length - 1] : '';
}

function looksLikeHlsSource(uri: string, contentType?: string) {
  const normalizedUri = uri.toLowerCase();
  const normalizedContentType = (contentType || '').toLowerCase();
  return normalizedUri.includes('.m3u8')
    || normalizedUri.includes('method=streaming')
    || normalizedContentType.includes('hls')
    || normalizedContentType.includes('mpegurl');
}

function getUserVideoCoverTargetUri(id: string) {
  return `${USER_VIDEOS_COVERS_DIR}/${sanitizeSegment(id)}.jpg`;
}

function stripFileExtension(name: string) {
  return name.replace(/\.[^./\\]+$/, '') || name;
}

function toFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function normalizeMs(raw: number | null) {
  if (raw == null || raw < 0) return null;
  if (raw >= 1000) return Math.round(raw);
  if (!Number.isInteger(raw)) {
    return raw < 100 ? Math.round(raw * 1000) : Math.round(raw);
  }
  return raw <= 60 ? raw * 1000 : raw;
}

function clampMs(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function normalizeChunkTimestamp(rawMs: number | null, timeOffsetMs: number, chunkDurationMs?: number | null) {
  if (rawMs == null) return null;
  const normalizedChunkDurationMs = typeof chunkDurationMs === 'number' && chunkDurationMs > 0 ? chunkDurationMs : null;
  if (normalizedChunkDurationMs == null) {
    return Math.max(0, rawMs);
  }
  const relativeCandidate = rawMs;
  if (relativeCandidate >= 0 && relativeCandidate <= normalizedChunkDurationMs + 1500) {
    return clampMs(relativeCandidate, 0, normalizedChunkDurationMs);
  }
  const absoluteCandidate = rawMs - timeOffsetMs;
  if (absoluteCandidate >= -1500 && absoluteCandidate <= normalizedChunkDurationMs + 1500) {
    return clampMs(absoluteCandidate, 0, normalizedChunkDurationMs);
  }
  return clampMs(relativeCandidate, 0, normalizedChunkDurationMs);
}

function getStartMs(value: { start_time?: unknown; startTime?: unknown; start_ms?: unknown; startMs?: unknown }) {
  return normalizeMs(
    toFiniteNumber(value.start_time)
      ?? toFiniteNumber(value.startTime)
      ?? toFiniteNumber(value.start_ms)
      ?? toFiniteNumber(value.startMs),
  );
}

function getEndMs(value: { end_time?: unknown; endTime?: unknown; end_ms?: unknown; endMs?: unknown }) {
  return normalizeMs(
    toFiniteNumber(value.end_time)
      ?? toFiniteNumber(value.endTime)
      ?? toFiniteNumber(value.end_ms)
      ?? toFiniteNumber(value.endMs),
  );
}

function estimateDurationMsFromText(text: string) {
  const wordCount = text.trim().split(/\s+/).filter(Boolean).length;
  return Math.max(1800, wordCount * 520);
}

function splitAsrTextIntoSentences(text: string) {
  return text
    .match(/[^.!?。！？\n]+[.!?。！？]?/g)?.map((item) => item.trim()).filter(Boolean)
    ?? [];
}

function buildFallbackJson3Events(text: string, timeOffsetMs: number) {
  const sentences = splitAsrTextIntoSentences(text);
  const parts = sentences.length > 0 ? sentences : [text.trim() || 'Subtitle generated'];
  const totalDurationMs = Math.max(estimateDurationMsFromText(text || 'generated subtitle'), parts.length * 800);
  const totalWeight = parts.reduce((sum, part) => sum + Math.max(1, part.replace(/\s+/g, '').length), 0);
  let cursorMs = Math.max(0, timeOffsetMs);
  return parts.map((part, index) => {
    const remaining = parts.length - index;
    const remainingBudgetMs = Math.max(800, timeOffsetMs + totalDurationMs - cursorMs);
    const durationMs = index === parts.length - 1
      ? remainingBudgetMs
      : Math.max(800, Math.round(remainingBudgetMs * (Math.max(1, part.replace(/\s+/g, '').length) / Math.max(1, totalWeight))));
    const safeDurationMs = remaining > 1
      ? Math.min(durationMs, Math.max(800, remainingBudgetMs - ((remaining - 1) * 800)))
      : remainingBudgetMs;
    const event = {
      tStartMs: cursorMs,
      dDurationMs: safeDurationMs,
      segs: [{ utf8: part, tOffsetMs: 0 }],
    };
    cursorMs += safeDurationMs;
    return event;
  });
}

function estimatePcmWavDurationMs(fileSize?: number | null) {
  if (typeof fileSize !== 'number' || !Number.isFinite(fileSize) || fileSize <= WAV_HEADER_BYTES) {
    return 0;
  }
  return Math.max(0, Math.round(((fileSize - WAV_HEADER_BYTES) / WAV_BYTES_PER_SECOND) * 1000));
}

function buildJson3FromAsrResult(result: AsrUploadResponse, options?: { timeOffsetMs?: number; chunkDurationMs?: number }): { json3: Json3File; durationSeconds?: number } {
  const timeOffsetMs = Math.max(0, options?.timeOffsetMs ?? 0);
  const chunkDurationMs = typeof options?.chunkDurationMs === 'number' && options.chunkDurationMs > 0
    ? options.chunkDurationMs
    : null;
  const utterances = Array.isArray(result.utterances) ? result.utterances : [];
  const events: Json3Event[] = utterances.map((utterance) => {
    const text = (utterance.text || '').trim();
    const rawUtteranceStartMs = getStartMs(utterance) ?? 0;
    const normalizedUtteranceStartMs = normalizeChunkTimestamp(rawUtteranceStartMs, timeOffsetMs, chunkDurationMs) ?? 0;
    const rawUtteranceEndMs = getEndMs(utterance) ?? (rawUtteranceStartMs + estimateDurationMsFromText(text));
    const normalizedUtteranceEndMs = normalizeChunkTimestamp(rawUtteranceEndMs, timeOffsetMs, chunkDurationMs)
      ?? Math.max(normalizedUtteranceStartMs + 800, normalizedUtteranceStartMs + estimateDurationMsFromText(text));
    const cappedUtteranceEndMs = chunkDurationMs != null
      ? clampMs(Math.max(normalizedUtteranceStartMs + 800, normalizedUtteranceEndMs), normalizedUtteranceStartMs + Math.min(800, Math.max(0, chunkDurationMs - normalizedUtteranceStartMs)), chunkDurationMs)
      : Math.max(normalizedUtteranceStartMs + 800, normalizedUtteranceEndMs);
    const startMs = normalizedUtteranceStartMs + timeOffsetMs;
    const endMs = cappedUtteranceEndMs + timeOffsetMs;
    const durationMs = Math.max(800, endMs - startMs);
    const words = Array.isArray(utterance.words) ? utterance.words : [];
    let segs: Array<{ utf8: string; tOffsetMs?: number }> = [];
    if (words.length > 0) {
      words.forEach((word) => {
        const tokenText = (word.text || word.word || '').trim();
        const tokenStartMs = normalizeChunkTimestamp(getStartMs(word), timeOffsetMs, chunkDurationMs);
        if (!tokenText) return;
        segs.push({
          utf8: tokenText,
          tOffsetMs: tokenStartMs != null ? clampMs(tokenStartMs - normalizedUtteranceStartMs, 0, durationMs) : undefined,
        });
      });
      const trailingPunctuation = text.match(/[.!?。！？]["']*$/)?.[0];
      if (trailingPunctuation && segs.length > 0 && !/[.!?。！？]["']*$/.test(segs[segs.length - 1].utf8)) {
        segs[segs.length - 1] = {
          ...segs[segs.length - 1],
          utf8: `${segs[segs.length - 1].utf8}${trailingPunctuation}`,
        };
      }
    } else if (text) {
      segs = [{ utf8: text }];
    }

    return {
      tStartMs: startMs,
      dDurationMs: durationMs,
      segs: segs.length > 0 ? segs : [{ utf8: text || '...' }],
    };
  });

  if (events.length === 0) {
    const fallbackText = (result.text || '').trim();
    const fallbackEvents = buildFallbackJson3Events(fallbackText, timeOffsetMs);
    const fallbackDurationMs = fallbackEvents.reduce((max, event) => Math.max(max, event.tStartMs + event.dDurationMs), timeOffsetMs);
    return {
      json3: {
        wireMagic: 'pb3',
        events: fallbackEvents,
      },
      durationSeconds: Math.max(1, Math.round(Math.max(1, fallbackDurationMs) / 1000)),
    };
  }

  const maxEndMs = events.reduce((max, item) => Math.max(max, item.tStartMs + item.dDurationMs), 0);
  return {
    json3: {
      wireMagic: 'pb3',
      events,
    },
    durationSeconds: maxEndMs > 0 ? Math.round(maxEndMs / 1000) : undefined,
  };
}

function getSubtitleTargetUri(entryId: string) {
  return `${USER_VIDEOS_SUBTITLES_DIR}/${sanitizeSegment(entryId)}.json3`;
}

// 2026-08-15: 跟桌面端 segmented.json 镜像. 字幕 ASR 完写完 json3 后,
// 立即调 LLM 修标点/大写 + 本地按标点切/合并, 把 sentence-level segments
// 写到这里. 翻译 + 显示时优先用这个, 避免每次都调 LLM.
// exported 出去给 video-scenes.ts 显示侧用 (parseJson3Subtitles 的 englishSegments 参数).
export function getSubtitleSegmentedTargetUri(entryId: string) {
  return `${USER_VIDEOS_SUBTITLES_DIR}/${sanitizeSegment(entryId)}.en.segmented.json`;
}

function getSubtitleTranslationTargetUri(entryId: string) {
  return `${USER_VIDEOS_SUBTITLES_DIR}/${sanitizeSegment(entryId)}.zh.json`;
}

function mergeGeneratedRanges(existing: Json3File['xGeneratedRanges'], incoming: Array<{ startMs: number; endMs: number }>) {
  const merged = [...(existing || []), ...incoming]
    .filter((item) => Number.isFinite(item.startMs) && Number.isFinite(item.endMs) && item.endMs > item.startMs)
    .sort((a, b) => a.startMs - b.startMs);
  const ranges: Array<{ startMs: number; endMs: number }> = [];
  merged.forEach((range) => {
    const last = ranges[ranges.length - 1];
    if (!last || range.startMs > last.endMs + 400) {
      ranges.push({ ...range });
      return;
    }
    last.endMs = Math.max(last.endMs, range.endMs);
  });
  return ranges;
}

function getJson3EventText(event: Json3Event) {
  return event.segs.map((seg) => seg.utf8).join('');
}

function mergeJson3Files(existing: Json3File | null, next: Json3File) {
  if (!existing) return next;
  const eventMap = new Map<string, Json3Event>();
  [...existing.events, ...next.events].forEach((event) => {
    const key = `${event.tStartMs}:${event.dDurationMs}:${getJson3EventText(event)}`;
    if (!eventMap.has(key)) {
      eventMap.set(key, event);
    }
  });
  return {
    wireMagic: 'pb3',
    events: Array.from(eventMap.values()).sort((a, b) => a.tStartMs - b.tStartMs),
    xGeneratedRanges: mergeGeneratedRanges(existing.xGeneratedRanges, next.xGeneratedRanges || []),
  } satisfies Json3File;
}

async function readExistingJson3(uri?: string) {
  if (!uri) return null;
  try {
    const raw = await readAsStringAsync(uri);
    if (!raw.trim()) return null;
    const parsed = JSON.parse(raw) as Json3File;
    if (!Array.isArray(parsed.events)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function inferExtension(sourceName?: string | null, sourceUri?: string, mimeType?: string | null) {
  const rawName = (sourceName || getFileNameFromUri(sourceUri || '')).trim();
  const fromName = rawName.match(/\.([a-zA-Z0-9]+)$/)?.[1]?.toLowerCase();
  if (fromName) return fromName;
  const normalizedMime = mimeType?.toLowerCase() || '';
  if (normalizedMime.includes('mp4')) return 'mp4';
  if (normalizedMime.includes('quicktime')) return 'mov';
  if (normalizedMime.includes('x-matroska')) return 'mkv';
  if (normalizedMime.includes('webm')) return 'webm';
  return 'mp4';
}

export function isVideoCandidate(sourceName?: string | null, sourceUri?: string, mimeType?: string | null) {
  const normalizedMime = mimeType?.trim().toLowerCase() || '';
  if (normalizedMime.startsWith('video/')) return true;
  const name = (sourceName || getFileNameFromUri(sourceUri || '')).trim().toLowerCase();
  return /\.(mp4|mov|m4v|mkv|webm|avi|ts|m2ts|3gp)$/i.test(name);
}

function assertVideoCandidate(sourceUri: string, options: ImportLocalVideoOptions = {}) {
  if (!isVideoCandidate(options.sourceName, sourceUri, options.mimeType)) {
    throw new Error('请选择视频文件');
  }
}

async function ensureDirectory(uri: string) {
  const info = await getInfoAsync(uri);
  if (!info.exists) {
    await makeDirectoryAsync(uri, { intermediates: true });
  }
}

async function readJsonFile<T>(uri: string): Promise<T> {
  const raw = await readAsStringAsync(uri);
  return JSON.parse(raw) as T;
}

async function writeJsonFile(uri: string, value: unknown) {
  await writeAsStringAsync(uri, JSON.stringify(value, null, 2));
}

async function fileExists(uri?: string | null) {
  if (!uri) return false;
  const info = await getInfoAsync(uri);
  return info.exists;
}

async function readUserVideosIndex() {
  ensureUserVideosAvailable();
  await ensureDirectory(USER_VIDEOS_ROOT_DIR);
  const exists = await fileExists(USER_VIDEOS_INDEX_PATH);
  if (!exists) {
    return { version: 1 as const, items: [] as UserVideoEntry[] };
  }
  return userVideosIndexSchema.parse(await readJsonFile(USER_VIDEOS_INDEX_PATH));
}

async function writeUserVideosIndex(items: UserVideoEntry[]) {
  ensureUserVideosAvailable();
  await ensureDirectory(USER_VIDEOS_ROOT_DIR);
  await writeJsonFile(USER_VIDEOS_INDEX_PATH, {
    version: 1,
    items,
  });
}

async function updateUserVideoEntry(id: string, updater: (entry: UserVideoEntry) => UserVideoEntry) {
  const index = await readUserVideosIndex();
  const nextItems = index.items.map((item) => item.id === id ? updater(item) : item);
  await writeUserVideosIndex(nextItems);
  return nextItems.find((item) => item.id === id) || null;
}

function triggerCloudVideoCoverGeneration(params: {
  id: string;
  provider: CloudVideoProvider;
  remotePath?: string;
  existingCoverImageUri?: string;
}) {
  const remotePath = params.remotePath?.trim();
  if (!remotePath || params.existingCoverImageUri || activeCloudCoverGenerationTasks[params.id]) {
    return;
  }

  let task: Promise<void> | undefined;
  task = (async () => {
    try {
      console.log('[UserVideoCover] async cloud import resolve start', {
        id: params.id,
        provider: params.provider,
        remotePath,
      });
      const resolved = await resolveCloudReferencedVideoCoverSource({
        provider: params.provider,
        remotePath,
      });
      console.log('[UserVideoCover] async cloud import resolve success', {
        id: params.id,
        provider: params.provider,
        remotePath,
        videoUri: resolved.videoUri.slice(0, 200),
        headerKeys: resolved.videoHeaders ? Object.keys(resolved.videoHeaders) : [],
      });
      const coverImageUri = await tryGenerateRemoteVideoCover(params.id, resolved.videoUri, resolved.videoHeaders);
      if (!coverImageUri) {
        return;
      }
      await updateUserVideoEntry(params.id, (current) => {
        if (current.sourceType !== 'cloud_reference' || current.coverImageUri) {
          return current;
        }
        if (current.provider !== params.provider || current.remotePath?.trim() !== remotePath) {
          return current;
        }
        return {
          ...current,
          coverImageUri,
        };
      });
      console.log('[UserVideoCover] async cloud import cover success', {
        id: params.id,
        provider: params.provider,
        remotePath,
        coverImageUri,
      });
    } catch (error) {
      console.log('[UserVideoCover] async cloud import generate failed', {
        id: params.id,
        provider: params.provider,
        remotePath,
        message: error instanceof Error ? error.message : String(error || ''),
      });
    } finally {
      if (activeCloudCoverGenerationTasks[params.id] === task) {
        delete activeCloudCoverGenerationTasks[params.id];
      }
    }
  })();

  activeCloudCoverGenerationTasks[params.id] = task;
}

function buildSubtitleGenerationErrorMessage(error: unknown) {
  const message = error instanceof Error ? error.message : String(error || '');
  const normalized = message.toLowerCase();
  if (!message) {
    return '字幕生成失败，请稍后重试';
  }
  if (normalized.includes('network request failed') || normalized.includes('failed to fetch')) {
    return '无法连接语音识别服务，请检查当前网络后重试';
  }
  if (normalized.includes('ffmpeg')) {
    return '本地音轨提取失败，请确认当前安装包已包含 ffmpeg 能力';
  }
  if (normalized.includes('asr 未返回可用字幕')) {
    return '识别服务没有返回可用字幕，可能是音轨太短、无人声或格式暂不支持';
  }
  // Volcengine ASR error codes (45000xxx). Don't show the raw code or the
  // JSON envelope to users — translate to plain Chinese.
  const volcCodeMatch = normalized.match(/\b(45000\d{3})\b/);
  if (volcCodeMatch) {
    const code = volcCodeMatch[1];
    if (code === '45000030' || normalized.includes('requested resource not granted')) {
      return '语音识别服务未开通或已停用，请联系管理员开通后重试';
    }
    if (code === '45000150' || code === '45000033') {
      return '语音识别调用频率超限，请稍后再试';
    }
    if (code === '45000032' || normalized.includes('insufficient balance')) {
      return '语音识别服务余额不足，请联系管理员充值';
    }
    if (code === '45000020' || code === '45000021') {
      return '语音识别请求参数错误，可能是音轨格式暂不支持';
    }
    if (code === '45000022') {
      return '音频时长超过识别服务上限';
    }
    return `语音识别服务异常 (code: ${code})，请稍后重试或联系管理员`;
  }
  return message;
}

function buildCloudSubtitleGenerationErrorMessage(error: unknown) {
  const message = error instanceof Error ? error.message : String(error || '');
  const normalized = message.toLowerCase();
  if (!message) {
    return '网盘字幕生成失败，请稍后重试';
  }
  if (normalized.includes('network request failed') || normalized.includes('failed to fetch')) {
    return '无法连接语音识别服务，请检查当前网络后重试';
  }
  if (normalized.includes('ffmpeg')) {
    return '网盘视频音轨提取失败，请确认当前安装包已包含 ffmpeg 能力';
  }
  if (normalized.includes('asr 未返回可用字幕')) {
    return '识别服务没有返回可用字幕，可能是音轨太短、无人声或当前来源暂不支持';
  }
  // Volcengine ASR error codes (45000xxx). Same translation as the local
  // path — users shouldn't see the raw code or JSON envelope.
  const volcCodeMatch = normalized.match(/\b(45000\d{3})\b/);
  if (volcCodeMatch) {
    const code = volcCodeMatch[1];
    if (code === '45000030' || normalized.includes('requested resource not granted')) {
      return '语音识别服务未开通或已停用，请联系管理员开通后重试';
    }
    if (code === '45000150' || code === '45000033') {
      return '语音识别调用频率超限，请稍后再试';
    }
    if (code === '45000032' || normalized.includes('insufficient balance')) {
      return '语音识别服务余额不足，请联系管理员充值';
    }
    if (code === '45000020' || code === '45000021') {
      return '语音识别请求参数错误，可能是音轨格式暂不支持';
    }
    if (code === '45000022') {
      return '音频时长超过识别服务上限';
    }
    return `语音识别服务异常 (code: ${code})，请稍后重试或联系管理员`;
  }
  return message;
}

/**
 * Update the subtitle phase on a user video entry. The UI polls the
 * `user-videos` index and shows a precise progress message based on
 * `subtitlePhase` (download → extract → ASR), not just a generic
 * "处理中" spinner.
 *
 * Pass `phase: undefined` to clear (e.g. on success or error terminal).
 */
async function setSubtitlePhase(
  id: string,
  phase: 'downloading' | 'extracting' | 'asr' | undefined,
  extras?: { progress?: number; message?: string; chargedMinutes?: number },
): Promise<void> {
  await updateUserVideoEntry(id, (current) => ({
    ...current,
    subtitlePhase: phase,
    subtitlePhaseProgress: extras?.progress,
    subtitlePhaseMessage: extras?.message,
    subtitleChargedMinutes: extras?.chargedMinutes ?? current.subtitleChargedMinutes,
  }));
}

async function transcribeChunkedWavSubtitleGeneration(params: {
  id: string;
  wavUri: string;
  expectedDurationSeconds?: number;
  outputPrefix: string;
  requestLabelPrefix: string;
  timeOffsetMs?: number;
  mergeInitial?: boolean;
  inputDurationMs?: number;
  forceCompleteOnWavEnd?: boolean;
  finalizeWhenLoopEnds?: boolean;
}) {
  const wavInfo = await getInfoAsync(params.wavUri);
  const wavSize = wavInfo.exists && 'size' in wavInfo && typeof wavInfo.size === 'number'
    ? wavInfo.size
    : 0;
  const extractedDurationMs = estimatePcmWavDurationMs(wavSize);
  const chunkingDurationMs = typeof params.inputDurationMs === 'number' && params.inputDurationMs > 0
    ? Math.min(extractedDurationMs, params.inputDurationMs)
    : extractedDurationMs;
  if (chunkingDurationMs <= 250) {
    throw new Error('ffmpeg 未生成有效 wav 文件');
  }

  const expectedDurationMs = typeof params.expectedDurationSeconds === 'number' && params.expectedDurationSeconds > 0
    ? Math.round(params.expectedDurationSeconds * 1000)
    : null;
  const effectiveDurationSeconds = expectedDurationMs != null
    ? params.expectedDurationSeconds
    : undefined;
  const maxChunkCount = Math.max(1, Math.ceil(chunkingDurationMs / LOCAL_ASR_CHUNK_SIZE_MS) + 1);
  const timeOffsetMs = typeof params.timeOffsetMs === 'number' && params.timeOffsetMs > 0
    ? params.timeOffsetMs
    : 0;
  let lastProgressEndMs = 0;
  let hasCommittedChunk = false;
  let finalized = false;

  for (let chunkIndex = 0; chunkIndex < maxChunkCount; chunkIndex += 1) {
    const chunkStartMs = chunkIndex * LOCAL_ASR_CHUNK_SIZE_MS;
    if (chunkStartMs >= chunkingDurationMs - 800) {
      break;
    }
    const requestedChunkEndMs = Math.min(chunkingDurationMs, chunkStartMs + LOCAL_ASR_CHUNK_SIZE_MS);
    let chunkWavUri: string | null = null;
    try {
      chunkWavUri = await extractAudioToWav({
        sourceUri: params.wavUri,
        startMs: chunkStartMs,
        endMs: requestedChunkEndMs,
        outputPrefix: `${params.outputPrefix}_${chunkIndex}`,
      });
      const chunkWavInfo = await getInfoAsync(chunkWavUri);
      const chunkWavSize = chunkWavInfo.exists && 'size' in chunkWavInfo && typeof chunkWavInfo.size === 'number'
        ? chunkWavInfo.size
        : 0;
      const chunkDurationMs = estimatePcmWavDurationMs(chunkWavSize);
      if (chunkDurationMs <= 250) {
        if (hasCommittedChunk) {
          break;
        }
        throw new Error('ffmpeg 未生成有效 wav 文件');
      }
      const actualChunkEndMs = Math.min(chunkingDurationMs, chunkStartMs + chunkDurationMs);
      const absoluteChunkStartMs = timeOffsetMs + chunkStartMs;
      const absoluteChunkEndMs = timeOffsetMs + actualChunkEndMs;
      const json = await transcribeWavFileDirect({
        wavUri: chunkWavUri,
        requestLabel: `${params.requestLabelPrefix}:${absoluteChunkStartMs}`,
      });
      const isShortTailChunk = chunkDurationMs < (requestedChunkEndMs - chunkStartMs) - 800;
      const isFinalChunk = expectedDurationMs != null
        ? absoluteChunkEndMs >= expectedDurationMs - 800
        : params.forceCompleteOnWavEnd
          ? actualChunkEndMs >= chunkingDurationMs - 800 || isShortTailChunk
          : isShortTailChunk;
      lastProgressEndMs = absoluteChunkEndMs;
      await commitGeneratedSubtitle(params.id, json, {
        merge: params.mergeInitial || hasCommittedChunk,
        progressEndMs: absoluteChunkEndMs,
        expectedDurationSeconds: effectiveDurationSeconds,
        timeOffsetMs: absoluteChunkStartMs,
        forceComplete: isFinalChunk,
      });
      hasCommittedChunk = true;
      finalized = isFinalChunk;
      if (isFinalChunk) {
        break;
      }
    } finally {
      await cleanupExtractedAudio(chunkWavUri);
    }
  }

  if (!hasCommittedChunk) {
    throw new Error('ASR 未返回可用字幕');
  }

  if (!finalized && params.finalizeWhenLoopEnds !== false) {
    await updateUserVideoEntry(params.id, (current) => ({
      ...current,
      subtitleStatus: 'ready',
      subtitleCursorMs: lastProgressEndMs,
      durationSeconds: current.durationSeconds ?? (lastProgressEndMs > 0 ? Math.round(lastProgressEndMs / 1000) : current.durationSeconds),
    }));
  }

  return await getUserVideoEntryById(params.id);
}

async function transcribeSlabbedRemoteSubtitleGeneration(params: {
  id: string;
  sourceUrl: string;
  headers?: Record<string, string>;
  expectedDurationSeconds?: number;
  outputPrefix: string;
  requestLabelPrefix: string;
}) {
  const expectedDurationMs = typeof params.expectedDurationSeconds === 'number' && params.expectedDurationSeconds > 0
    ? Math.round(params.expectedDurationSeconds * 1000)
    : null;
  const maxSlabCount = expectedDurationMs != null
    ? Math.max(1, Math.ceil(expectedDurationMs / CLOUD_REMOTE_HTTP_SLAB_SIZE_MS) + 1)
    : 60;
  let lastProgressEndMs = 0;
  let hasCommittedSlab = false;
  let finalized = false;

  for (let slabIndex = 0; slabIndex < maxSlabCount; slabIndex += 1) {
    const slabStartMs = slabIndex * CLOUD_REMOTE_HTTP_SLAB_SIZE_MS;
    if (expectedDurationMs != null && slabStartMs >= expectedDurationMs - 800) {
      break;
    }
    const requestedSlabEndMs = expectedDurationMs != null
      ? Math.min(expectedDurationMs, slabStartMs + CLOUD_REMOTE_HTTP_SLAB_SIZE_MS)
      : slabStartMs + CLOUD_REMOTE_HTTP_SLAB_SIZE_MS;
    let slabWavUri: string | null = null;
    try {
      console.log('[UserVideoSubtitle] cloud remote slab extract start', {
        id: params.id,
        slabIndex,
        slabStartMs,
        requestedSlabEndMs,
      });
      slabWavUri = await extractRemoteAudioToWav({
        sourceUrl: params.sourceUrl,
        startMs: slabStartMs,
        endMs: requestedSlabEndMs,
        headers: params.headers,
        outputPrefix: `${params.outputPrefix}_${slabIndex}`,
        remoteInputProfile: 'http',
      });
      const slabWavInfo = await getInfoAsync(slabWavUri);
      const slabWavSize = slabWavInfo.exists && 'size' in slabWavInfo && typeof slabWavInfo.size === 'number'
        ? slabWavInfo.size
        : 0;
      const slabDurationMs = estimatePcmWavDurationMs(slabWavSize);
      if (slabDurationMs <= 250) {
        if (hasCommittedSlab) {
          break;
        }
        throw new Error('ffmpeg 未生成有效 wav 文件');
      }
      const actualSlabEndMs = expectedDurationMs != null
        ? Math.min(expectedDurationMs, slabStartMs + slabDurationMs)
        : slabStartMs + slabDurationMs;
      const isFinalSlab = expectedDurationMs != null
        ? actualSlabEndMs >= expectedDurationMs - 800
        : slabDurationMs < (requestedSlabEndMs - slabStartMs) - 800;
      await transcribeChunkedWavSubtitleGeneration({
        id: params.id,
        wavUri: slabWavUri,
        expectedDurationSeconds: params.expectedDurationSeconds,
        outputPrefix: `${params.outputPrefix}_local_${slabIndex}`,
        requestLabelPrefix: `${params.requestLabelPrefix}:slab`,
        timeOffsetMs: slabStartMs,
        mergeInitial: hasCommittedSlab,
        inputDurationMs: Math.max(1, actualSlabEndMs - slabStartMs),
        forceCompleteOnWavEnd: isFinalSlab,
        finalizeWhenLoopEnds: false,
      });
      hasCommittedSlab = true;
      lastProgressEndMs = actualSlabEndMs;
      finalized = isFinalSlab;
      console.log('[UserVideoSubtitle] cloud remote slab extract success', {
        id: params.id,
        slabIndex,
        slabStartMs,
        actualSlabEndMs,
        slabDurationMs,
      });
      if (isFinalSlab) {
        break;
      }
    } finally {
      await cleanupExtractedAudio(slabWavUri);
    }
  }

  if (!hasCommittedSlab) {
    throw new Error('ASR 未返回可用字幕');
  }

  if (!finalized) {
    await updateUserVideoEntry(params.id, (current) => ({
      ...current,
      subtitleStatus: 'ready',
      subtitleCursorMs: lastProgressEndMs,
      durationSeconds: current.durationSeconds ?? (lastProgressEndMs > 0 ? Math.round(lastProgressEndMs / 1000) : current.durationSeconds),
    }));
  }

  return await getUserVideoEntryById(params.id);
}

async function transcribeChunkedRemoteSubtitleGeneration(params: {
  id: string;
  sourceUrl: string;
  headers?: Record<string, string>;
  remoteInputProfile: 'http' | 'hls';
  expectedDurationSeconds?: number;
  outputPrefix: string;
  requestLabelPrefix: string;
}) {
  const expectedDurationMs = typeof params.expectedDurationSeconds === 'number' && params.expectedDurationSeconds > 0
    ? Math.round(params.expectedDurationSeconds * 1000)
    : null;
  const effectiveDurationSeconds = expectedDurationMs != null
    ? Math.max(1, Math.round(expectedDurationMs / 1000))
    : undefined;
  const maxChunkCount = expectedDurationMs != null
    ? Math.max(1, Math.ceil(expectedDurationMs / CLOUD_REMOTE_ASR_CHUNK_SIZE_MS) + 1)
    : 240;
  let lastProgressEndMs = 0;
  let hasCommittedChunk = false;
  let finalized = false;

  for (let chunkIndex = 0; chunkIndex < maxChunkCount; chunkIndex += 1) {
    const chunkStartMs = chunkIndex * CLOUD_REMOTE_ASR_CHUNK_SIZE_MS;
    if (expectedDurationMs != null && chunkStartMs >= expectedDurationMs - 800) {
      break;
    }
    const requestedChunkEndMs = expectedDurationMs != null
      ? Math.min(expectedDurationMs, chunkStartMs + CLOUD_REMOTE_ASR_CHUNK_SIZE_MS)
      : chunkStartMs + CLOUD_REMOTE_ASR_CHUNK_SIZE_MS;
    let chunkWavUri: string | null = null;
    try {
      console.log('[UserVideoSubtitle] cloud remote chunk extract start', {
        id: params.id,
        chunkIndex,
        chunkStartMs,
        requestedChunkEndMs,
        remoteInputProfile: params.remoteInputProfile,
      });
      chunkWavUri = await extractRemoteAudioToWav({
        sourceUrl: params.sourceUrl,
        startMs: chunkStartMs,
        endMs: requestedChunkEndMs,
        headers: params.headers,
        outputPrefix: `${params.outputPrefix}_${chunkIndex}`,
        remoteInputProfile: params.remoteInputProfile,
      });
      const chunkWavInfo = await getInfoAsync(chunkWavUri);
      const chunkWavSize = chunkWavInfo.exists && 'size' in chunkWavInfo && typeof chunkWavInfo.size === 'number'
        ? chunkWavInfo.size
        : 0;
      const chunkDurationMs = estimatePcmWavDurationMs(chunkWavSize);
      if (chunkDurationMs <= 250) {
        if (hasCommittedChunk) {
          break;
        }
        throw new Error('ffmpeg 未生成有效 wav 文件');
      }
      const actualChunkEndMs = expectedDurationMs != null
        ? Math.min(expectedDurationMs, chunkStartMs + chunkDurationMs)
        : chunkStartMs + chunkDurationMs;
      const json = await transcribeWavFileDirect({
        wavUri: chunkWavUri,
        requestLabel: `${params.requestLabelPrefix}:${chunkStartMs}`,
      });
      const isFinalChunk = expectedDurationMs != null
        ? actualChunkEndMs >= expectedDurationMs - 800
        : chunkDurationMs < (requestedChunkEndMs - chunkStartMs) - 800;
      lastProgressEndMs = actualChunkEndMs;
      await commitGeneratedSubtitle(params.id, json, {
        merge: hasCommittedChunk,
        progressEndMs: actualChunkEndMs,
        expectedDurationSeconds: effectiveDurationSeconds,
        timeOffsetMs: chunkStartMs,
        forceComplete: isFinalChunk,
      });
      hasCommittedChunk = true;
      finalized = isFinalChunk;
      console.log('[UserVideoSubtitle] cloud remote chunk extract success', {
        id: params.id,
        chunkIndex,
        chunkStartMs,
        actualChunkEndMs,
        chunkDurationMs,
      });
      if (isFinalChunk) {
        break;
      }
    } finally {
      await cleanupExtractedAudio(chunkWavUri);
    }
  }

  if (!hasCommittedChunk) {
    throw new Error('ASR 未返回可用字幕');
  }

  if (!finalized) {
    await updateUserVideoEntry(params.id, (current) => ({
      ...current,
      subtitleStatus: 'ready',
      subtitleCursorMs: lastProgressEndMs,
      durationSeconds: current.durationSeconds ?? (lastProgressEndMs > 0 ? Math.round(lastProgressEndMs / 1000) : current.durationSeconds),
    }));
  }

  return await getUserVideoEntryById(params.id);
}

/**
 * Run the local ffmpeg + ASR loop against a local file URI and surface
 * progress through the 3-stage state machine. Pre-conditions: Pro gate
 * already passed, entry `subtitleStatus` is 'processing' and
 * `subtitlePhase` is 'extracting' (caller's job to set this).
 *
 * Returns the actual progress so the caller can do post-charge based on
 * the real amount of work done (per-minute billing, ceil, min 1).
 */
async function runLocalSubtitleGenerationFromUri(params: {
  id: string;
  sourceUri: string;
  outputPrefix: string;
  requestLabelPrefix: string;
  expectedDurationSeconds?: number;
  // Called between chunks so the UI can refresh its sub-progress message.
  // The helper itself owns the `subtitlePhase` field; this callback is
  // for caller-specific side effects (e.g. per-chunk quota accumulator).
  onChunkProgress?: (info: { chunkIndex: number; lastProgressEndMs: number; expectedDurationMs: number | null }) => void;
}): Promise<{
  lastProgressEndMs: number;
  actualDurationMs: number;
  hasCommittedChunk: boolean;
  finalized: boolean;
}> {
  // 整段本地视频一次性 ffmpeg 抽 wav,一次性 submit 火山 /api/v1/vc/submit。
  // 不再分 90s chunk:服务端 VAD 会按静音自动切句,切得比固定 90s 块更准,
  // 而且一个 job 一次拉通能避免跨 chunk 边界把一句话切两半。
  const expectedDurationSeconds = typeof params.expectedDurationSeconds === 'number' && params.expectedDurationSeconds > 0
    ? params.expectedDurationSeconds
    : undefined;
  const expectedDurationMs = expectedDurationSeconds != null
    ? Math.round(expectedDurationSeconds * 1000)
    : null;
  let wavUri: string | null = null;
  let lastProgressEndMs = 0;
  let actualDurationMs = 0;
  try {
    wavUri = await extractAudioToWav({
      sourceUri: params.sourceUri,
      // 不传 startMs / endMs:executeAudioExtract 会把整段视频抽成 wav
      outputPrefix: params.outputPrefix,
    });
    const wavInfo = await getInfoAsync(wavUri);
    const wavSize = wavInfo.exists && 'size' in wavInfo && typeof wavInfo.size === 'number'
      ? wavInfo.size
      : 0;
    actualDurationMs = estimatePcmWavDurationMs(wavSize);
    if (actualDurationMs <= 250) {
      throw new Error('ffmpeg 未生成有效 wav 文件');
    }
    lastProgressEndMs = actualDurationMs;
    console.log('[UserVideoSubtitle] local whole-audio asr start', {
      id: params.id,
      wavBytes: wavSize,
      durationSec: Math.round(actualDurationMs / 100) / 10,
    });
    const json = await transcribeWavFileDirect({
      wavUri,
      requestLabel: `${params.requestLabelPrefix}:0`,
    });
    await commitGeneratedSubtitle(params.id, json, {
      merge: false,
      progressEndMs: actualDurationMs,
      expectedDurationSeconds,
      timeOffsetMs: 0,
      forceComplete: true,
    });
    await setSubtitlePhase(params.id, 'asr', {
      progress: 1,
      message: `生成字幕完成 (${Math.round(actualDurationMs / 100) / 10}s)`,
    });
    params.onChunkProgress?.({
      chunkIndex: 0,
      lastProgressEndMs,
      expectedDurationMs,
    });
    return {
      lastProgressEndMs,
      actualDurationMs,
      hasCommittedChunk: true,
      finalized: true,
    };
  } catch (error) {
    // 如果服务端拒绝(1010 音频过长 / 1011 音频过大),把错误信息透传出来,
    // UI 会弹 Alert — 不在客户端再做兜底 chunking,因为 (1) 248s / 8MB
    // 这种量级服务端应该没问题,(2) 真触发了再单独处理。
    throw error;
  } finally {
    await cleanupExtractedAudio(wavUri);
  }
}

async function requestDirectCloudVideoSubtitleGeneration(entry: UserVideoEntry, id: string, options?: { startMs?: number; endMs?: number }) {
  const provider = entry.provider;
  const remotePath = entry.remotePath;
  if (!provider || !remotePath) {
    throw new Error('只有网盘关联视频才支持生成网盘字幕');
  }
  const expectedDurationSeconds = typeof (options as { expectedDurationSeconds?: number } | undefined)?.expectedDurationSeconds === 'number'
    && ((options as { expectedDurationSeconds?: number } | undefined)?.expectedDurationSeconds ?? 0) > 0
      ? (options as { expectedDurationSeconds?: number }).expectedDurationSeconds
      : entry.durationSeconds;
  const expectedDurationMs = typeof expectedDurationSeconds === 'number' && expectedDurationSeconds > 0
    ? Math.round(expectedDurationSeconds * 1000)
    : null;

  console.log('[UserVideoSubtitle] cloud generation start', {
    id,
    title: entry.title,
    provider,
    remotePath,
    expectedDurationSeconds: expectedDurationSeconds ?? null,
    requestedStartMs: options?.startMs ?? null,
    requestedEndMs: options?.endMs ?? null,
    ignoresRangeOptions: true,
    mode: provider === 'baidu_pan'
      ? 'android_baidu_download_first_then_local_extract'
      : 'android_ffmpeg_remote_hls_first_direct_fallback_chunked_remote_asr',
  });

  // Baidu-specific path: we need the actual file on disk to feed local
  // ffmpeg + ASR, so we download first. The download infrastructure
  // (downloadCloudVideoAndWait) is idempotent and joins any in-flight
  // download for the same sceneId, so a retry from a different surface
  // (auto-trigger, manual button) doesn't re-download.
  if (provider === 'baidu_pan') {
    let cachedLocalUri = entry.cachedLocalUri;
    if (!cachedLocalUri) {
      console.log('[UserVideoSubtitle] baidu download phase start', {
        id,
        provider,
        remotePath,
        expectedFileSize: entry.fileSize ?? null,
      });
      await setSubtitlePhase(id, 'downloading', {
        progress: 0,
        message: '准备下载',
      });
      try {
        const downloaded = await downloadCloudVideoAndWait({
          sceneId: id,
          provider,
          remotePath,
          onProgress: (entry) => {
            const total = entry.totalBytesExpectedToWrite ?? 0;
            const written = entry.totalBytesWritten ?? 0;
            const ratio = total > 0 ? Math.min(1, written / total) : undefined;
            // Avoid persisting dozens of identical states per second; the
            // helper already throttles to ~2x/sec, so this is cheap.
            void setSubtitlePhase(id, 'downloading', {
              progress: ratio,
              message: total > 0
                ? `下载中 ${formatDownloadProgress(written, total)}`
                : `下载中 ${(written / (1024 * 1024)).toFixed(1)} MB`,
            });
          },
        });
        cachedLocalUri = downloaded.localVideoUri;
        // Persist the cached reference on the entry so future runs (and
        // the playback layer) see this is a locally-available video.
        await updateUserVideoEntry(id, (current) => ({
          ...current,
          cachedLocalUri: downloaded.localVideoUri,
          cachedLocalSize: downloaded.fileSize || current.cachedLocalSize,
          cachedAt: new Date().toISOString(),
        }));
        console.log('[UserVideoSubtitle] baidu download phase success', {
          id,
          provider,
          remotePath,
          localVideoUri: downloaded.localVideoUri,
          fileSize: downloaded.fileSize,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error ?? '');
        console.warn('[UserVideoSubtitle] baidu download phase failed', {
          id,
          provider,
          remotePath,
          error: message,
        });
        throw new Error(buildCloudSubtitleGenerationErrorMessage(error));
      }
    } else {
      console.log('[UserVideoSubtitle] baidu download phase skipped (already cached)', {
        id,
        provider,
        remotePath,
        cachedLocalUri,
        cachedLocalSize: entry.cachedLocalSize ?? null,
        cachedAt: entry.cachedAt ?? null,
      });
    }
    // Switch to the local-extract phase. The shared helper will keep
    // refreshing the user-facing message via setSubtitlePhase.
    await setSubtitlePhase(id, 'extracting', {
      progress: 0,
      message: '正在准备生成',
    });
    const result = await runLocalSubtitleGenerationFromUri({
      id,
      sourceUri: cachedLocalUri,
      outputPrefix: `cloud_baidu_${entry.id}`,
      requestLabelPrefix: `cloud:baidu_local:${id}`,
      expectedDurationSeconds: expectedDurationSeconds
        ?? (expectedDurationMs != null && expectedDurationMs > 0 ? Math.round(expectedDurationMs / 1000) : undefined),
    });
    if (!result.hasCommittedChunk) {
      throw new Error('ASR 未返回可用字幕');
    }
    return await getUserVideoEntryById(id);
  }

  // Non-Baidu providers: keep the existing remote-stream path. They
  // may be HLS streams that ffmpeg can read directly over HTTP without
  // a local copy. (Future work: extend to other providers if their
  // stream shape doesn't support range-based ffmpeg reading.)
  let lastError: unknown = null;

  const attempts: Array<{
    label: 'hls' | 'direct';
    resolve: () => Promise<{ videoUri: string; videoHeaders?: Record<string, string>; videoContentType?: string }>;
  }> = [
    {
      label: 'hls',
      resolve: () => resolveCloudReferencedVideoSource({
        provider,
        remotePath,
      }),
    },
    {
      label: 'direct',
      resolve: () => resolveCloudReferencedVideoCoverSource({
        provider,
        remotePath,
      }),
    },
  ];

  for (const attempt of attempts) {
    try {
      const resolved = await attempt.resolve();
      const remoteInputProfile = looksLikeHlsSource(resolved.videoUri, resolved.videoContentType) ? 'hls' : 'http';
      console.log('[UserVideoSubtitle] cloud audio extract attempt', {
        id,
        provider,
        remotePath,
        attempt: attempt.label,
        remoteInputProfile,
        sourceUriPreview: resolved.videoUri.slice(0, 240),
        headerKeys: resolved.videoHeaders ? Object.keys(resolved.videoHeaders) : [],
        fileNameGuess: getFileNameFromUri(resolved.videoUri),
      });
      if (attempt.label === 'direct' && remoteInputProfile === 'http') {
        return await transcribeSlabbedRemoteSubtitleGeneration({
          id,
          sourceUrl: resolved.videoUri,
          headers: resolved.videoHeaders,
          expectedDurationSeconds: expectedDurationSeconds
            ?? (expectedDurationMs != null && expectedDurationMs > 0 ? Math.round(expectedDurationMs / 1000) : undefined),
          outputPrefix: `cloud_remote_slab_${provider}_${entry.id}_${attempt.label}`,
          requestLabelPrefix: `cloud:${provider}:${id}`,
        });
      }
      return await transcribeChunkedRemoteSubtitleGeneration({
        id,
        sourceUrl: resolved.videoUri,
        headers: resolved.videoHeaders,
        remoteInputProfile,
        expectedDurationSeconds: expectedDurationSeconds
          ?? (expectedDurationMs != null && expectedDurationMs > 0 ? Math.round(expectedDurationMs / 1000) : undefined),
        outputPrefix: `cloud_remote_chunk_${provider}_${entry.id}_${attempt.label}`,
        requestLabelPrefix: `cloud:${provider}:${id}`,
      });
    } catch (error) {
      lastError = error;
      console.warn('[UserVideoSubtitle] cloud audio extract attempt failed', {
        id,
        provider,
        remotePath,
        attempt: attempt.label,
        error: error instanceof Error ? error.message : String(error ?? ''),
      });
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError || '网盘音轨提取失败'));
}

function formatDownloadProgress(written: number, total: number): string {
  const mb = 1024 * 1024;
  if (total < mb * 1024) {
    return `${(written / mb).toFixed(1)} MB / ${(total / mb).toFixed(1)} MB`;
  }
  return `${(written / mb / 1024).toFixed(2)} GB / ${(total / mb / 1024).toFixed(2)} GB`;
}

async function commitGeneratedSubtitle(id: string, result: AsrUploadResponse, options?: { merge?: boolean; progressEndMs?: number; expectedDurationSeconds?: number; timeOffsetMs?: number; forceComplete?: boolean }) {
  if (!(result.text || '').trim() && (!Array.isArray(result.utterances) || result.utterances.length === 0)) {
    throw new Error('ASR 未返回可用字幕');
  }
  const chunkDurationMs = typeof options?.progressEndMs === 'number' && typeof options?.timeOffsetMs === 'number'
    ? Math.max(0, options.progressEndMs - options.timeOffsetMs)
    : undefined;
  const { json3 } = buildJson3FromAsrResult(result, {
    timeOffsetMs: options?.timeOffsetMs,
    chunkDurationMs,
  });
  const subtitleUri = getSubtitleTargetUri(id);
  const existing = options?.merge ? await readExistingJson3(subtitleUri) : null;
  const nextProgressEndMs = options?.progressEndMs
    ?? Math.max(...json3.events.map((event) => event.tStartMs + event.dDurationMs), 0);
  const merged = options?.merge
    ? mergeJson3Files(existing, {
        ...json3,
        xGeneratedRanges: mergeGeneratedRanges(existing?.xGeneratedRanges, nextProgressEndMs > 0 ? [{ startMs: Math.max(0, options?.timeOffsetMs ?? json3.events[0]?.tStartMs ?? 0), endMs: nextProgressEndMs }] : []),
      })
    : json3;
  await writeJsonFile(subtitleUri, merged);

  // 2026-08-15: 跟桌面端镜像 — ASR 写完 json3 后立即调 LLM 修标点/大写 +
  // 本地按标点切/合并, 写 *.en.segmented.json. 翻译 + 显示优先用这个,
  // 避免每次都调 LLM.
  // chunked 模式每个 chunk 都会调一次, 慢但简单 (后续可以优化成只调一次 LLM
  // 修整个 video). 失败/未配 LLM 时回退到纯 logic split (不调 LLM, 仍可写文件).
  try {
    const units = json3EventsToSubtitleUnits(merged.events || []);
    if (units.length > 0) {
      const segments = await correctThenSplit(units, {
        onProgress: (msg) => console.log(`[SubtitleSeg] chunked: ${msg}`),
      });
      const segmentedUri = getSubtitleSegmentedTargetUri(id);
      const segmentsWithId = segments.map((s, idx) => ({
        ...s,
        id: `cc-seg-${idx}`,
      }));
      const segmentedPayload = {
        sourceSubtitle: subtitleUri.split('/').pop() || subtitleUri,
        segmentCount: segmentsWithId.length,
        segmentationMode: 'llm+logic',
        segments: segmentsWithId,
      };
      await writeJsonFile(segmentedUri, segmentedPayload);
      console.log(`[SubtitleSeg] wrote ${segmentedUri}: ${segmentsWithId.length} segments`);
    }
  } catch (e) {
    // 写 segmented.json 失败不阻塞 commit 流程 — json3 已经写了, 显示侧有
    // 兜底 (parseJson3Subtitles 没 englishSegments 时回退到本地 groupTokensByEvent).
    console.warn(`[SubtitleSeg] commit segmented.json 失败, 不影响 json3 写入: ${(e as Error).message}`);
  }

  const updatedAt = new Date().toISOString();
  const isComplete = options?.forceComplete
    || (typeof options?.expectedDurationSeconds === 'number'
      && nextProgressEndMs >= Math.max(0, Math.round(options.expectedDurationSeconds * 1000) - 800));
  return updateUserVideoEntry(id, (current) => ({
    ...current,
    subtitleStatus: isComplete ? 'ready' : 'processing',
    subtitleUri,
    subtitleUpdatedAt: updatedAt,
    subtitleCursorMs: nextProgressEndMs,
    durationSeconds: options?.expectedDurationSeconds
      ?? current.durationSeconds
      ?? (isComplete && nextProgressEndMs > 0 ? Math.round(nextProgressEndMs / 1000) : undefined),
  }));
 }

 function getSourceLabel(provider?: CloudVideoProvider) {
  if (provider === 'baidu_pan') return '百度网盘';
  return '本地导入';
 }

function normalizeLocalVideoDuplicateName(name?: string | null) {
  return (name || '').trim().toLowerCase();
}

function findDuplicateLocalVideoEntry(
  items: UserVideoEntry[],
  sourceName?: string | null,
  fileSize?: number,
  /**
   * Wire ids of user collections that USED to exist but no longer
   * do on the current user's Supabase. Entries whose `collectionId`
   * is in this set are "orphan" (deleted collection, e.g. from a
   * previous build where the `collectionId` plumbing was incomplete
   * or the user recreated their account). They will show up in the
   * default collection at read time, but for dedup purposes they
   * should NOT count as "already imported" — the user can clearly
   * see nothing in their real collections, so a same-name file
   * picked from disk should be allowed to import.
   */
  orphanCollectionIds: ReadonlySet<string> = new Set(),
) {
  const normalizedName = normalizeLocalVideoDuplicateName(sourceName);
  if (!normalizedName) {
    return null;
  }

  // ── DIAG (2026-08-12): user reports dedup misfires. Log every
  // local_file entry we're comparing against so we can see which
  // one matched, what its name/size/collectionId was, and whether
  // the size-check branch was hit.
  const localFileItems = items.filter((it) => it.sourceType === 'local_file');
  console.log('[UserVideoDedup] scan start', {
    queryName: sourceName ?? null,
    normalizedQuery: normalizedName,
    querySize: typeof fileSize === 'number' ? fileSize : null,
    orphanCount: orphanCollectionIds.size,
    orphans: Array.from(orphanCollectionIds),
    candidateCount: localFileItems.length,
    candidates: localFileItems.map((it) => ({
      id: it.id,
      title: it.title,
      localFileName: it.localFileName ?? null,
      normalizedItemName: normalizeLocalVideoDuplicateName(it.localFileName || it.title),
      fileSize: typeof it.fileSize === 'number' ? it.fileSize : null,
      collectionId: it.collectionId ?? null,
      isOrphan: it.collectionId ? orphanCollectionIds.has(it.collectionId) : false,
    })),
  });

  const matched = items.find((item) => {
    if (item.sourceType !== 'local_file') {
      return false;
    }

    // Skip orphan entries — they have no real owner collection,
    // and the user has no way to manage them via the UI. Don't
    // block fresh imports on them.
    if (item.collectionId && orphanCollectionIds.has(item.collectionId)) {
      console.log('[UserVideoDedup] skip orphan entry', {
        entryId: item.id,
        entryCollectionId: item.collectionId,
      });
      return false;
    }

    const itemName = normalizeLocalVideoDuplicateName(item.localFileName || item.title);
    if (!itemName || itemName !== normalizedName) {
      return false;
    }

    if (typeof fileSize === 'number' && Number.isFinite(fileSize) && fileSize > 0) {
      const sizeMatch = item.fileSize === fileSize;
      console.log('[UserVideoDedup] size branch', {
        entryId: item.id,
        querySize: fileSize,
        entrySize: item.fileSize ?? null,
        result: sizeMatch ? 'MATCH' : 'skip (name match but size differs)',
      });
      return sizeMatch;
    }

    // ── DIAG: when query size is unknown we currently fall back to
    // name-only. That's been the false-positive source. Log the
    // hit so we can see the size-less path is being taken.
    console.log('[UserVideoDedup] SIZE-UNKNOWN FALLBACK (name only)', {
      entryId: item.id,
      entryName: item.localFileName || item.title,
      entryCollectionId: item.collectionId ?? null,
    });
    return true;
  }) || null;

  if (matched) {
    console.log('[UserVideoDedup] MATCH', {
      matchedId: matched.id,
      matchedTitle: matched.title,
      matchedLocalFileName: matched.localFileName ?? null,
      matchedFileSize: matched.fileSize ?? null,
      matchedCollectionId: matched.collectionId ?? null,
    });
  }
  return matched;
}

export function isDuplicateLocalVideoImportError(error: unknown): error is DuplicateLocalVideoImportError {
  return error instanceof DuplicateLocalVideoImportError;
}

export function buildCloudReferenceIdentity(provider: CloudVideoProvider, remotePath?: string, remoteFileId?: string) {
  const key = remoteFileId?.trim() || remotePath?.trim() || '';
  return `${provider}:${key}`;
}

function buildCoverCaptureCandidates(durationSeconds?: number) {
  const durationMs = typeof durationSeconds === 'number' && durationSeconds > 0
    ? Math.round(durationSeconds * 1000)
    : null;
  const primaryMs = durationMs == null
    ? 10_000
    : durationMs >= 12_000
      ? 10_000
      : Math.max(1_000, Math.round(durationMs * 0.25));
  const rawCandidates = durationMs == null
    ? [primaryMs, 5_000, 1_000, 0]
    : [
        Math.min(primaryMs, Math.max(0, durationMs - 300)),
        Math.min(5_000, Math.max(0, durationMs - 300)),
        Math.min(1_000, Math.max(0, durationMs - 300)),
        0,
      ];
  return rawCandidates.filter((value, index, list) => value >= 0 && list.indexOf(value) === index);
}

async function tryGenerateLocalVideoCover(entryId: string, localVideoUri: string, durationSeconds?: number) {
  const targetUri = getUserVideoCoverTargetUri(entryId);
  const captureCandidates = buildCoverCaptureCandidates(durationSeconds);
  let lastError: unknown = null;

  for (const captureMs of captureCandidates) {
    try {
      const { uri } = await VideoThumbnails.getThumbnailAsync(localVideoUri, {
        time: captureMs,
        quality: 0.8,
      });
      await deleteLocalUserVideoFile(targetUri);
      await copyAsync({ from: uri, to: targetUri });
      return targetUri;
    } catch (error) {
      lastError = error;
    }
  }

  if (lastError) {
    throw lastError;
  }

  return null;
}

async function tryGenerateRemoteVideoCover(entryId: string, remoteVideoUri: string, headers?: Record<string, string>, durationSeconds?: number) {
  const targetUri = getUserVideoCoverTargetUri(entryId);
  const captureCandidates = buildCoverCaptureCandidates(durationSeconds);
  let lastError: unknown = null;

  for (const captureMs of captureCandidates) {
    try {
       console.log('[UserVideoCover] remote thumbnail attempt', {
         id: entryId,
         captureMs,
         remoteVideoUri: remoteVideoUri.slice(0, 200),
         headerKeys: headers ? Object.keys(headers) : [],
       });
       const { uri } = await VideoThumbnails.getThumbnailAsync(remoteVideoUri, {
         time: captureMs,
         quality: 0.8,
         headers,
       });
       await deleteLocalUserVideoFile(targetUri);
       await copyAsync({ from: uri, to: targetUri });
       console.log('[UserVideoCover] remote thumbnail generated', {
         id: entryId,
         captureMs,
         tempUri: uri,
         targetUri,
       });
       return targetUri;
    } catch (thumbnailError) {
      lastError = thumbnailError;
      console.log('[UserVideoCover] remote thumbnail attempt failed', {
        id: entryId,
        captureMs,
        message: thumbnailError instanceof Error ? thumbnailError.message : String(thumbnailError || ''),
      });
      try {
        console.log('[UserVideoCover] remote thumbnail ffmpeg fallback start', {
          id: entryId,
          captureMs,
          remoteVideoUri: remoteVideoUri.slice(0, 200),
        });
        await deleteLocalUserVideoFile(targetUri);
        await extractVideoFrame({
          sourceUri: remoteVideoUri,
          targetUri,
          captureMs,
          headers,
          logLabel: 'UserVideoCoverFFmpeg',
        });
        console.log('[UserVideoCover] remote thumbnail ffmpeg fallback success', {
          id: entryId,
          captureMs,
          targetUri,
        });
        return targetUri;
      } catch (ffmpegError) {
        lastError = ffmpegError;
        console.log('[UserVideoCover] remote thumbnail ffmpeg fallback failed', {
          id: entryId,
          captureMs,
          message: ffmpegError instanceof Error ? ffmpegError.message : String(ffmpegError || ''),
        });
      }
    }
  }

  if (lastError) {
    throw lastError;
  }

  return null;
}

export async function listUserVideos() {
  const index = await readUserVideosIndex();
  return index.items;
}

export async function getUserVideoEntryById(id: string) {
  const index = await readUserVideosIndex();
  return index.items.find((item) => item.id === id) || null;
}

export async function deleteUserVideoEntry(id: string) {
  const index = await readUserVideosIndex();
  const entry = index.items.find((item) => item.id === id) || null;
  if (!entry) {
    return null;
  }
  // 云盘视频如果正在缓存中,先把下载任务取消 + 清理部分下载文件,否则
  // 下载会继续在后台跑、文件留在 cache 目录、"网盘下载" 列表里也一直
  // 显示这个已删除的视频。
  if (entry.sourceType === 'cloud_reference' && entry.provider) {
    try {
      await removeOfficialSceneVideoDownload(id, entry.provider);
    } catch (error) {
      console.warn('[UserVideoDelete] cancel cloud download failed (continuing with delete)', {
        id,
        provider: entry.provider,
        error: error instanceof Error ? error.message : String(error ?? ''),
      });
    }
  }
  await deleteLocalUserVideoFile(entry.subtitleUri);
  await deleteLocalUserVideoFile(entry.subtitleZhUri);
  await deleteLocalUserVideoFile(entry.localVideoUri);
  // 云盘视频的本地缓存文件存在 cachedLocalUri (跟 localVideoUri 是不同字段),
  // removeOfficialSceneVideoDownload 只清它在 downloadEntryCache 里 track 的
  // 部分下载文件,完成下载后的 cachedLocalUri 这边再清一次。
  await deleteLocalUserVideoFile(entry.cachedLocalUri);
  await deleteLocalUserVideoFile(entry.coverImageUri);
  await writeUserVideosIndex(index.items.filter((item) => item.id !== id));
  return entry;
}

/**
 * Move a user video to a different collection, or remove it from
 * its current collection (passing `undefined`) so it falls back to
 * the default collection via the "no collectionId → default" rule
 * in `matchesCollection`. Local files / cloud references are
 * untouched — only the index row's `collectionId` is rewritten.
 *
 * Use this for non-destructive "remove from this collection"
 * (when the user is currently inside a custom collection).
 * For real delete (e.g. "从默认合集移除"), call `deleteUserVideoEntry`.
 */
export async function setUserVideoCollection(
  id: string,
  collectionId: string | undefined,
): Promise<UserVideoEntry | null> {
  const updated = await updateUserVideoEntry(id, (current) => {
    // Only the collectionId field changes; everything else
    // (sourceType, provider, cache state, cover, etc.) is
    // preserved so the entry doesn't get re-imported / re-cached.
    return { ...current, collectionId };
  });
  if (!updated) {
    console.warn('[UserVideoCollection] entry not found', { id });
  }
  return updated;
}

/**
 * Patch one or more fields on a user video entry. The mutation
 * is a shallow merge: every key in `patch` is written through;
 * keys not present are left alone. Returns the updated entry
 * (or null if no entry with that id exists). Used by the
 * subtitle / cache / AI practice pipelines to bump their state
 * fields without rewriting the whole entry by hand.
 */
export async function updateUserVideoEntryFields(
  id: string,
  patch: Partial<UserVideoEntry>,
): Promise<UserVideoEntry | null> {
  return await updateUserVideoEntry(id, (current) => ({ ...current, ...patch }));
}

export async function importLocalVideoFromUri(sourceUri: string, options: ImportLocalVideoOptions = {}) {
  ensureUserVideosAvailable();
  assertVideoCandidate(sourceUri, options);
  await ensureDirectory(USER_VIDEOS_ROOT_DIR);
  await ensureDirectory(USER_VIDEOS_FILES_DIR);
  await ensureDirectory(USER_VIDEOS_COVERS_DIR);
  await ensureDirectory(USER_VIDEOS_SUBTITLES_DIR);

  // Resolve the owning collection. Picker can pass a non-default
  // wire id; if absent, lazy-create the default collection and tag
  // the entry with its wire id. The home page reads back via
  // `matchesCollection()`; without a default row every imported
  // video would be orphaned and the home card would show 0.
  const targetCollectionId = options.collectionId
    ?? encodeUserCollectionId((await getOrCreateDefaultCollection()).id);

  const now = new Date().toISOString();
  const sourceName = (options.sourceName || getFileNameFromUri(sourceUri) || `video_${Date.now()}.mp4`).trim();
  const sourceInfo = await getInfoAsync(sourceUri);
  const sourceFileSize = sourceInfo.exists && 'size' in sourceInfo && typeof sourceInfo.size === 'number'
    ? sourceInfo.size
    : undefined;
  const index = await readUserVideosIndex();
  // Build the set of currently-valid user collection wire ids so
  // dedup can skip "orphan" entries (whose `collectionId` points
  // to a deleted collection on Supabase). Those entries have no
  // visible owner, so they shouldn't block a fresh import.
  let orphanCollectionIds: Set<string> = new Set();
  try {
    const userCols = await listUserCollections();
    const validWireIds = new Set<string>(userCols.map((row) => encodeUserCollectionId(row.id)));
    orphanCollectionIds = new Set<string>();
    for (const it of index.items) {
      if (typeof it.collectionId === 'string' && it.collectionId.startsWith('user:') && !validWireIds.has(it.collectionId)) {
        orphanCollectionIds.add(it.collectionId);
      }
    }
  } catch (err) {
    // If the network call fails, fall through with an empty set —
    // dedup will still work, just slightly stricter than ideal.
    console.warn('[UserVideoDedup] listUserCollections failed; orphan filter disabled', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // ── DIAG (2026-08-12): user reports dedup misfires. Log the
  // resolved source name + size + index size before we run the
  // dedup check.
  console.log('[UserVideoDedup] importLocalVideoFromUri preflight', {
    sourceUri,
    sourceName,
    sourceFileSize: typeof sourceFileSize === 'number' ? sourceFileSize : null,
    sourceInfoExists: sourceInfo.exists,
    indexItemCount: index.items.length,
    localFileCount: index.items.filter((it) => it.sourceType === 'local_file').length,
    cloudRefCount: index.items.filter((it) => it.sourceType === 'cloud_reference').length,
    force: options.force === true,
    orphanCount: orphanCollectionIds.size,
    orphans: Array.from(orphanCollectionIds),
  });
  const duplicateEntry = options.force
    ? null
    : findDuplicateLocalVideoEntry(index.items, sourceName, sourceFileSize, orphanCollectionIds);
  if (duplicateEntry) {
    throw new DuplicateLocalVideoImportError(duplicateEntry);
  }
  const extension = inferExtension(sourceName, sourceUri, options.mimeType);
  const entryId = `user_video_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const targetUri = `${USER_VIDEOS_FILES_DIR}/${sanitizeSegment(entryId)}.${extension}`;

  await copyAsync({ from: sourceUri, to: targetUri });
  const fileInfo = await getInfoAsync(targetUri);
  const fileSize = fileInfo.exists && 'size' in fileInfo && typeof fileInfo.size === 'number'
    ? fileInfo.size
    : undefined;
  let coverImageUri: string | undefined;

  try {
    coverImageUri = (await tryGenerateLocalVideoCover(entryId, targetUri)) || undefined;
  } catch (error) {
    console.log('[UserVideoCover] local import generate failed', {
      id: entryId,
      message: error instanceof Error ? error.message : String(error || ''),
    });
  }

  const entry: UserVideoEntry = {
    id: entryId,
    title: stripFileExtension(sourceName),
    sourceType: 'local_file',
    sourceLabel: '本地导入',
    importedAt: now,
    level: 'B1',
    category: '我的视频',
    type: 'vlog',
    subtitleStatus: 'pending',
    localVideoUri: targetUri,
    localFileName: sourceName,
    mimeType: options.mimeType || undefined,
    fileSize: fileSize ?? sourceFileSize,
    coverImageUri,
    collectionId: targetCollectionId,
  };

  await writeUserVideosIndex([entry, ...index.items.filter((item) => item.id !== entry.id)]);
  return entry;
}

export async function pickAndImportLocalVideo(options: { collectionId?: string; force?: boolean } = {}) {
  const result = await DocumentPicker.getDocumentAsync({
    type: 'video/*',
    copyToCacheDirectory: true,
    multiple: false,
  });
  if (result.canceled || !result.assets?.[0]?.uri) {
    return null;
  }
  return importLocalVideoFromUri(result.assets[0].uri, {
    sourceName: result.assets[0].name,
    mimeType: result.assets[0].mimeType,
    collectionId: options.collectionId,
    force: options.force,
  });
}

export async function createCloudVideoReference(params: CreateCloudVideoReferenceParams) {
  ensureUserVideosAvailable();
  const remoteFileId = params.remoteFileId == null ? undefined : String(params.remoteFileId);
  const remotePath = params.remotePath?.trim();
  if (!remotePath && !remoteFileId) {
    throw new Error('缺少网盘文件标识');
  }

  await ensureDirectory(USER_VIDEOS_ROOT_DIR);
  await ensureDirectory(USER_VIDEOS_COVERS_DIR);

  // Resolve the target collection. Picker can pass a non-default
  // wire id; otherwise lazy-create default. Same rationale as
  // importLocalVideoFromUri.
  const defaultWireId = encodeUserCollectionId(
    (await getOrCreateDefaultCollection()).id,
  );

  const title = (params.title || params.remoteFileName || remotePath || '网盘视频').trim();
  const now = new Date().toISOString();
  const index = await readUserVideosIndex();
  const identity = buildCloudReferenceIdentity(params.provider, remotePath, remoteFileId);
  const existing = index.items.find((item) => item.sourceType === 'cloud_reference' && buildCloudReferenceIdentity(item.provider!, item.remotePath, item.remoteFileId) === identity);
  const entryId = existing?.id || `user_cloud_video_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  let coverImageUri = existing?.coverImageUri;

  // Resolution order:
  //   1. explicit picker choice (params.collectionId)
  //   2. existing entry's collectionId (re-import: keep the user's
  //      prior assignment)
  //   3. default wire id
  const collectionId = params.collectionId
    ?? existing?.collectionId
    ?? defaultWireId;

  const entry: UserVideoEntry = existing ? {
    ...existing,
    id: entryId,
    title,
    sourceLabel: getSourceLabel(params.provider),
    provider: params.provider,
    remotePath,
    remoteFileId,
    remoteFileName: params.remoteFileName || title,
    fileSize: params.fileSize,
    coverImageUri,
    collectionId,
  } : {
    id: entryId,
    title,
    sourceType: 'cloud_reference',
    sourceLabel: getSourceLabel(params.provider),
    importedAt: now,
    level: 'B1',
    category: '我的视频',
    type: 'vlog',
    subtitleStatus: 'none',
    provider: params.provider,
    remotePath,
    remoteFileId,
    remoteFileName: params.remoteFileName || title,
    fileSize: params.fileSize,
    coverImageUri,
    collectionId,
  };

  const nextItems = index.items.filter((item) => item.id !== entry.id);
  nextItems.unshift(entry);
  await writeUserVideosIndex(nextItems);
  triggerCloudVideoCoverGeneration({
    id: entry.id,
    provider: params.provider,
    remotePath,
    existingCoverImageUri: coverImageUri,
  });
  return entry;
}

export async function requestUserVideoSubtitleGeneration(id: string, options?: { expectedDurationSeconds?: number }) {
  const entry = await getUserVideoEntryById(id);
  if (!entry?.localVideoUri) {
    throw new Error('找不到本地视频文件');
  }

  console.log('[UserVideoSubtitle] local generation start', {
    id,
    title: entry.title,
    localVideoUri: entry.localVideoUri,
    mimeType: entry.mimeType ?? null,
    mode: 'local_ffmpeg_chunked_direct_asr',
  });
  if (entry.sourceType !== 'local_file' || !entry.localVideoUri) {
    throw new Error('只有本地导入视频才支持生成字幕');
  }

  await ensureDirectory(USER_VIDEOS_ROOT_DIR);
  await ensureDirectory(USER_VIDEOS_SUBTITLES_DIR);

  const expectedDurationSeconds = typeof options?.expectedDurationSeconds === 'number' && options.expectedDurationSeconds > 0
    ? options.expectedDurationSeconds
    : entry.durationSeconds;
  const expectedMinutes = minutesForAudioSeconds(expectedDurationSeconds);

  // ── Pro gate (pre-check only, no mutation) ──────────────────────
  // Subtitle generation is Pro-only with per-minute billing. We surface
  // a distinguished error class for the UI to render a marketing page
  // (not a generic "try again" toast).
  const quotaCheck = await checkSubtitleQuota(expectedMinutes);
  if (!quotaCheck.allowed) {
    if (quotaCheck.reason === 'pro_required') {
      throw new SubtitleProRequiredError(quotaCheck);
    }
    if (quotaCheck.reason === 'hard') {
      throw new SubtitleQuotaExhaustedError(quotaCheck);
    }
  }

  // Mark processing. Phase is 'extracting' (we set this even for local
  // so a single UI mapper handles both local and Baidu flows; the
  // helper refreshes it to 'asr' as soon as the first ASR call returns).
  await updateUserVideoEntry(id, (current) => ({
    ...current,
    subtitleStatus: 'processing',
    subtitleCursorMs: 0,
    subtitleUri: undefined,
    subtitleZhUri: undefined,
    subtitlePhase: 'extracting',
    subtitlePhaseProgress: 0,
    subtitlePhaseMessage: '正在准备生成',
  }));

  try {
    const result = await runLocalSubtitleGenerationFromUri({
      id,
      sourceUri: entry.localVideoUri,
      outputPrefix: `local_${entry.id}`,
      requestLabelPrefix: `local:${id}`,
      expectedDurationSeconds: expectedDurationSeconds
        ?? (typeof expectedDurationSeconds === 'number' ? expectedDurationSeconds : undefined),
    });

    if (!result.hasCommittedChunk) {
      throw new Error('ASR 未返回可用字幕');
    }

    if (!result.finalized) {
      await updateUserVideoEntry(id, (current) => ({
        ...current,
        subtitleStatus: 'ready',
        subtitleCursorMs: result.lastProgressEndMs,
        durationSeconds: current.durationSeconds
          ?? (result.lastProgressEndMs > 0 ? Math.round(result.lastProgressEndMs / 1000) : current.durationSeconds),
      }));
    }

    // ── Post-charge: bill for the actual work that was done ───────
    // We charge AFTER success, on the actual duration the loop saw
    // (not the pre-checked `expectedMinutes`). This avoids overcharging
    // when a video ends earlier than its metadata claimed.
    const actualMinutes = minutesForAudioSeconds(
      result.actualDurationMs > 0
        ? Math.round(result.actualDurationMs / 1000)
        : expectedDurationSeconds,
    );
    const consume = await consumeQuota('asr_subtitle', actualMinutes);
    if (consume.allowed) {
      console.log('[UserVideoSubtitle] subtitle quota charged', {
        id,
        minutes: actualMinutes,
        reason: consume.reason,
        used: consume.used,
        soft: consume.soft,
        hard: consume.hard,
      });
    } else {
      // Should be rare: pre-check said ok but post-charge flipped to
      // hard. Don't unwind the subtitles — the work is real. We just
      // don't bill for it (the user got the value).
      console.warn('[UserVideoSubtitle] subtitle post-charge blocked (race), skipping', {
        id,
        minutes: actualMinutes,
        reason: consume.reason,
        used: consume.used,
      });
    }

    // Stash the charged minutes so the UI can show "今日剩余 X 分钟"
    // based on the real cost, and clear the in-flight phase.
    await setSubtitlePhase(id, undefined, { chargedMinutes: consume.allowed ? actualMinutes : undefined });

    const updated = await getUserVideoEntryById(id);
    try {
      await generateAndSaveSubtitleTranslation(id, updated?.subtitleUri);
    } catch (error) {
      throw new Error(`英文字幕已生成，但中文字幕生成失败：${error instanceof Error ? error.message : '请稍后重试'}`);
    }
    return await getUserVideoEntryById(id);
  } catch (error) {
    // Pro gate errors are not "failures" — re-throw so the caller can
    // route the user to the marketing page. Don't poison the entry
    // with `subtitleStatus: 'error'`.
    if (error instanceof SubtitleProRequiredError || error instanceof SubtitleQuotaExhaustedError) {
      throw error;
    }
    console.warn('[UserVideoSubtitle] local generation failed', {
      id,
      error: error instanceof Error ? error.message : String(error ?? ''),
    });
    await updateUserVideoEntry(id, (current) => ({
      ...current,
      subtitleStatus: 'error',
      subtitlePhase: undefined,
      subtitlePhaseProgress: undefined,
      subtitlePhaseMessage: undefined,
    }));
    throw new Error(buildSubtitleGenerationErrorMessage(error));
  } finally {
    await cleanupExtractedAudio(null);
  }
}

export async function requestCloudVideoSubtitleGeneration(id: string, options?: { startMs?: number; endMs?: number; expectedDurationSeconds?: number }) {
  const entry = await getUserVideoEntryById(id);
  if (!entry) {
    throw new Error('视频记录不存在');
  }
  if (entry.sourceType !== 'cloud_reference' || !entry.provider || !entry.remotePath) {
    throw new Error('只有网盘关联视频才支持生成网盘字幕');
  }

  await ensureDirectory(USER_VIDEOS_ROOT_DIR);
  await ensureDirectory(USER_VIDEOS_SUBTITLES_DIR);

  const expectedDurationSeconds = typeof options?.expectedDurationSeconds === 'number' && options.expectedDurationSeconds > 0
    ? options.expectedDurationSeconds
    : entry.durationSeconds;

  // ── Pro gate (pre-check only, no mutation) ──────────────────────
  // Subtitle generation is Pro-only with per-minute billing.
  // Surface a distinguished error class so the UI can route the
  // user to the marketing page instead of a generic error toast.
  const expectedMinutes = minutesForAudioSeconds(expectedDurationSeconds);
  const quotaCheck = await checkSubtitleQuota(expectedMinutes);
  if (!quotaCheck.allowed) {
    if (quotaCheck.reason === 'pro_required') {
      throw new SubtitleProRequiredError(quotaCheck);
    }
    if (quotaCheck.reason === 'hard') {
      throw new SubtitleQuotaExhaustedError(quotaCheck);
    }
  }

  if (typeof expectedDurationSeconds === 'number' && expectedDurationSeconds > 0 && entry.durationSeconds !== expectedDurationSeconds) {
    await updateUserVideoEntry(id, (current) => ({
      ...current,
      durationSeconds: expectedDurationSeconds,
    }));
  }

  if (entry.subtitleUri) {
    await deleteLocalUserVideoFile(entry.subtitleUri);
  }
  if (entry.subtitleZhUri) {
    await deleteLocalUserVideoFile(entry.subtitleZhUri);
  }

  await updateUserVideoEntry(id, (current) => ({
    ...current,
    subtitleStatus: 'processing',
    subtitleCursorMs: 0,
    subtitleUri: undefined,
    subtitleZhUri: undefined,
    subtitlePhase: entry.provider === 'baidu_pan' ? 'downloading' : 'extracting',
    subtitlePhaseProgress: 0,
    subtitlePhaseMessage: entry.provider === 'baidu_pan' ? '准备下载' : '正在准备生成',
  }));

  try {
    const updated = await requestDirectCloudVideoSubtitleGeneration(entry, id, options);
    if (!updated) {
      throw new Error('字幕生成失败');
    }
    // ── Post-charge: bill for the actual work that was done ───────
    // For cloud, "actual work" = what the shared local loop saw.
    // For Baidu: the entry now has the post-download cachedLocalUri;
    // for non-Baidu remote paths, expectedDurationSeconds is the best
    // signal we have.
    const actualMinutes = minutesForAudioSeconds(
      updated.durationSeconds ?? expectedDurationSeconds,
    );
    const consume = await consumeQuota('asr_subtitle', actualMinutes);
    if (consume.allowed) {
      console.log('[UserVideoSubtitle] cloud subtitle quota charged', {
        id,
        provider: entry.provider,
        minutes: actualMinutes,
        reason: consume.reason,
        used: consume.used,
      });
    } else {
      console.warn('[UserVideoSubtitle] cloud subtitle post-charge blocked (race), skipping', {
        id,
        provider: entry.provider,
        minutes: actualMinutes,
        reason: consume.reason,
        used: consume.used,
      });
    }
    await setSubtitlePhase(id, undefined, { chargedMinutes: consume.allowed ? actualMinutes : undefined });
    try {
      await generateAndSaveSubtitleTranslation(id, updated.subtitleUri);
    } catch (error) {
      throw new Error(`英文字幕已生成，但中文字幕生成失败：${error instanceof Error ? error.message : '请稍后重试'}`);
    }
    return await getUserVideoEntryById(id);
  } catch (error) {
    // Pro gate errors are not "failures" — re-throw so the caller can
    // route the user to the marketing page. Don't poison the entry
    // with `subtitleStatus: 'error'`.
    if (error instanceof SubtitleProRequiredError || error instanceof SubtitleQuotaExhaustedError) {
      throw error;
    }
    console.warn('[UserVideoSubtitle] cloud generation failed', {
      id,
      provider: entry.provider,
      wavUri: null,
      startMs: options?.startMs ?? null,
      endMs: options?.endMs ?? null,
      error: error instanceof Error ? error.message : String(error ?? ''),
    });
    await updateUserVideoEntry(id, (current) => ({
      ...current,
      subtitleStatus: 'error',
      subtitlePhase: undefined,
      subtitlePhaseProgress: undefined,
      subtitlePhaseMessage: undefined,
    }));
    throw new Error(buildCloudSubtitleGenerationErrorMessage(error));
  } finally {
    await cleanupExtractedAudio(null);
  }
}

export function triggerUserVideoSubtitleGeneration(id: string, options?: { expectedDurationSeconds?: number }) {
  return requestUserVideoSubtitleGeneration(id, options);
}

export function triggerCloudVideoSubtitleGeneration(id: string, options?: { startMs?: number; endMs?: number; expectedDurationSeconds?: number }) {
  return requestCloudVideoSubtitleGeneration(id, options);
}

/**
 * Fire-and-forget subtitle auto-generation for an imported entry.
 *
 * Mirrors the pre-redesign `videos.tsx` flow:
 *   - **local_file** : silently skip when the user is Free or
 *     today's hard subtitle quota is exhausted. The entry stays at
 *     `subtitleStatus: 'pending'`, and the detail page surfaces the
 *     precise gate (Pro paywall / "今日额度已用完") when the user
 *     taps to retry. The free path is silent because the user just
 *     imported the video — slapping a Pro toast in their face
 *     mid-import feels like spam.
 *   - **cloud_reference** : no gate here. The user already walked
 *     through a more involved flow (mount a drive, browse, pick a
 *     file), and the existing toast on `triggerCloud*` failure
 *     gives them a precise next step.
 *
 * Errors thrown by the underlying generation are caught and logged;
 * they never propagate back to the import success path, so a
 * subtitle failure doesn't retroactively make the import look
 * broken. Re-discovery happens when the user opens the detail page
 * and `subtitleStatus` shows 'error' / 'pending'.
 *
 * Safe to call from anywhere — no React state, no router. The
 * caller (ImportVideoSheet, the shared-share path on the home
 * page, the collection detail page) wires any UI refresh after
 * the underlying entry's `subtitleStatus` updates.
 */
export async function triggerImportedVideoSubtitleGeneration(
  entry: { id?: string | null; sourceType?: string | null } | null | undefined,
): Promise<void> {
  if (!entry?.id) return;
  const entryId: string = entry.id;
  const sourceType = entry.sourceType;

  if (sourceType === 'local_file') {
    // Lazy-import to avoid a circular import: user-videos.ts is
    // pulled into quota.ts via ... not yet, but better safe than
    // sorry. Keep this dynamic.
    let pro = false;
    let hardQuotaExhausted = false;
    try {
      const quotaMod = await import('../quota');
      const [tierResult, usageConfig] = await Promise.allSettled([
        quotaMod.isProNow(),
        Promise.all([quotaMod.getTodayUsage(), quotaMod.getQuotaConfig()]),
      ]);
      pro = tierResult.status === 'fulfilled' && tierResult.value === true;
      if (pro && usageConfig.status === 'fulfilled') {
        const [usage, config] = usageConfig.value;
        const hard = config.pro.asr_subtitle.hard;
        if (typeof hard === 'number' && hard > 0 && usage.asr_subtitle >= hard) {
          hardQuotaExhausted = true;
        }
      }
    } catch (err) {
      // If quota check fails, fall through and run the trigger —
      // the underlying call has its own quota enforcement and
      // will surface a precise error if applicable.
      console.warn('[UserVideoSubtitle] pro/quota check failed; falling through', {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    if (!pro) {
      console.log('[UserVideoSubtitle] skip auto-trigger: free user', { entryId });
      return;
    }
    if (hardQuotaExhausted) {
      console.log('[UserVideoSubtitle] skip auto-trigger: hard quota exhausted', { entryId });
      return;
    }
  }

  const task = sourceType === 'cloud_reference'
    ? triggerCloudVideoSubtitleGeneration(entryId)
    : sourceType === 'local_file'
      ? triggerUserVideoSubtitleGeneration(entryId)
      : null;
  if (!task) {
    console.log('[UserVideoSubtitle] no trigger for sourceType', { entryId, sourceType: sourceType ?? null });
    return;
  }
  void task.catch((err) => {
    console.warn('[UserVideoSubtitle] auto-trigger failed', {
      entryId,
      sourceType: sourceType ?? null,
      error: err instanceof Error ? err.message : String(err),
    });
  });
}

export async function deleteLocalUserVideoFile(uri?: string) {
  if (!uri) return;
  const exists = await fileExists(uri);
  if (exists) {
    await deleteAsync(uri, { idempotent: true });
  }
}
