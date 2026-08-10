/**
 * YouTube json3 subtitle parser.
 *
 * Parses the raw json3 CC format (events → segs → utf8) into
 * a flat array of VideoSceneSegment that the video player can consume.
 */

import type { VideoSceneSegment, WordTiming } from './video-scenes';

/** Raw event shape inside a json3 subtitle file. */
interface Json3Event {
  tStartMs: number;
  dDurationMs: number;
  wWinId?: number;
  aAppend?: number;
  segs?: { utf8: string; tOffsetMs?: number; acAsrConf?: number }[];
  id?: number;
  wpWinPosId?: number;
  wsWinStyleId?: number;
}

interface Json3File {
  wireMagic?: string;
  events?: Json3Event[];
}

const NON_SPEECH_RE = /^\[.*\]$/;
const SENTENCE_END_RE = /[.!?]["']*$/;
const HARD_PAUSE_SPLIT_MS = 900;
const SOFT_PAUSE_SPLIT_MS = 600;
const SOFT_PAUSE_MIN_TOKENS = 8;
const SOFT_PAUSE_MIN_DURATION_MS = 2200;
const MAX_SENTENCE_TOKENS = 14;
const MAX_SENTENCE_DURATION_MS = 5200;

interface SpeechEventEntry {
  event: Json3Event;
  text: string;
}

interface TimedWordToken {
  text: string;
  startMs: number;
  endMs: number;
  tokenIndex: number;
}

function toSpeechEvents(events: Json3Event[]): SpeechEventEntry[] {
  return events
    .filter((event) => {
      if (event.id !== undefined && event.wpWinPosId !== undefined) return false;
      if (event.aAppend) return false;
      if (!event.segs || event.segs.length === 0) return false;

      const text = event.segs
        .map((s) => s.utf8)
        .join('')
        .replace(/\n/g, ' ')
        .trim();

      return Boolean(text) && !NON_SPEECH_RE.test(text);
    })
    .map((event) => ({
      event,
      text: event.segs!
        .map((s) => s.utf8)
        .join('')
        .replace(/\n/g, ' ')
        .trim(),
    }));
}

function toTimedWordTokens(speechEvents: SpeechEventEntry[]): TimedWordToken[] {
  const tokens: TimedWordToken[] = [];

  speechEvents.forEach(({ event }, eventIndex) => {
    const nextSpeechStartMs = speechEvents[eventIndex + 1]?.event.tStartMs;
    const durationMs = event.dDurationMs;
    let displayEndMs: number;
    if (Number.isFinite(durationMs) && durationMs >= 0) {
      displayEndMs = event.tStartMs + durationMs;
    } else if (nextSpeechStartMs !== undefined && nextSpeechStartMs > event.tStartMs) {
      displayEndMs = nextSpeechStartMs;
    } else {
      const offsets = event.segs?.map((seg) => seg.tOffsetMs ?? 0) ?? [];
      displayEndMs = event.tStartMs + Math.max(0, ...offsets);
    }
    const segmentEndMs = nextSpeechStartMs !== undefined
      ? Math.min(displayEndMs, nextSpeechStartMs)
      : displayEndMs;

    for (let i = 0; i < event.segs!.length; i++) {
      const seg = event.segs![i];
      const raw = seg.utf8.replace(/\n/g, ' ');
      if (!raw.trim()) continue;

      const startMs = event.tStartMs + (seg.tOffsetMs ?? 0);
      const endMs = i < event.segs!.length - 1
        ? Math.min(segmentEndMs, event.tStartMs + (event.segs![i + 1].tOffsetMs ?? 0))
        : segmentEndMs;

      tokens.push({
        text: raw,
        startMs,
        endMs: Math.max(startMs, endMs),
        tokenIndex: tokens.length,
      });
    }
  });

  return tokens;
}

/**
 * 把 speechEvents 切成"组 token 列表":每个 ASR event 内部一组 token。
 * 火山 /api/v1/vc/submit 等 ASR 返回的每个 event 已经代表一个 VAD 切出来的
 * 完整 utterance,本身就该是一句/一段字幕。直接拍平所有 event 的话,后面按
 * 标点切句会把所有 event 拼回一段,丢掉 VAD 的分句。
 *
 * 调用方 (parseJson3Subtitles / parseJson3ToSentenceSegments) 拿到这个二维
 * 数组后,应该在每个内层数组结束时 finalize 一句,不要再做跨 event 切句。
 */
function groupTokensByEvent(speechEvents: SpeechEventEntry[]): TimedWordToken[][] {
  const groups: TimedWordToken[][] = [];
  speechEvents.forEach((entry, eventIndex) => {
    const { event } = entry;
    const nextSpeechStartMs = speechEvents[eventIndex + 1]?.event.tStartMs;
    const durationMs = event.dDurationMs;
    let displayEndMs: number;
    if (Number.isFinite(durationMs) && durationMs >= 0) {
      displayEndMs = event.tStartMs + durationMs;
    } else if (nextSpeechStartMs !== undefined && nextSpeechStartMs > event.tStartMs) {
      displayEndMs = nextSpeechStartMs;
    } else {
      const offsets = event.segs?.map((seg) => seg.tOffsetMs ?? 0) ?? [];
      displayEndMs = event.tStartMs + Math.max(0, ...offsets);
    }
    const segmentEndMs = nextSpeechStartMs !== undefined
      ? Math.min(displayEndMs, nextSpeechStartMs)
      : displayEndMs;

    const group: TimedWordToken[] = [];
    for (let i = 0; i < (event.segs?.length || 0); i += 1) {
      const seg = event.segs![i];
      const raw = seg.utf8.replace(/\n/g, ' ');
      if (!raw.trim()) continue;
      const startMs = event.tStartMs + (seg.tOffsetMs ?? 0);
      const endMs = i < event.segs!.length - 1
        ? Math.min(segmentEndMs, event.tStartMs + (event.segs![i + 1].tOffsetMs ?? 0))
        : segmentEndMs;
      group.push({
        text: raw,
        startMs,
        endMs: Math.max(startMs, endMs),
        tokenIndex: group.length,
      });
    }
    if (group.length > 0) {
      groups.push(group);
    }
  });
  return groups;
}

function shouldSplitBeforeToken(sentenceTokens: TimedWordToken[], nextToken: TimedWordToken): boolean {
  if (sentenceTokens.length === 0) return false;

  const previousToken = sentenceTokens[sentenceTokens.length - 1];
  const gapMs = Math.max(0, nextToken.startMs - previousToken.endMs);
  const sentenceDurationMs = Math.max(0, previousToken.endMs - sentenceTokens[0].startMs);

  if (gapMs >= HARD_PAUSE_SPLIT_MS) {
    return true;
  }
  if (
    gapMs >= SOFT_PAUSE_SPLIT_MS
    && (sentenceTokens.length >= SOFT_PAUSE_MIN_TOKENS || sentenceDurationMs >= SOFT_PAUSE_MIN_DURATION_MS)
  ) {
    return true;
  }
  if (sentenceTokens.length >= MAX_SENTENCE_TOKENS || sentenceDurationMs >= MAX_SENTENCE_DURATION_MS) {
    return true;
  }

  return false;
}

function finalizeSentence(tokens: TimedWordToken[], index: number): VideoSceneSegment | null {
  if (tokens.length === 0) return null;

  const words: WordTiming[] = [];
  let charOffset = 0;

  tokens.forEach((token, tokenIndex) => {
    let text = tokenIndex === 0 ? token.text.trimStart() : token.text;
    if (!text) return;

    if (words.length > 0) {
      const previousText = words[words.length - 1].text;
      const needsSyntheticSpace = !/^\s/.test(text)
        && !/\s$/.test(previousText)
        && !/^[,.;:!?)}\]]/.test(text);
      if (needsSyntheticSpace) {
        text = ` ${text}`;
      }
    }

    words.push({
      text,
      startMs: token.startMs,
      endMs: token.endMs,
      charStart: charOffset,
      charEnd: charOffset + text.length,
    });
    charOffset += text.length;
  });

  if (words.length === 0) return null;

  return {
    id: `cc-seg-${index}`,
    startMs: words[0].startMs,
    endMs: words[words.length - 1].endMs,
    speaker: 'narration',
    text: words.map((word) => word.text).join('').trim(),
    textZh: '',
    words,
  };
}

/** Chinese translations map: segment id -> Chinese text. */
export interface SubtitleTranslations {
  sourceSubtitle?: string;
  sourceEnglishSubtitle?: string;
  segmentCount?: number;
  translations: Record<string, string>;
}

export interface EnglishSubtitleSegment {
  id?: string;
  startToken?: number;
  endToken?: number;
  startMs?: number;
  endMs?: number;
  text?: string;
}

export interface EnglishSegmentedSubtitles {
  sourceSubtitle?: string;
  segmentCount?: number;
  segmentationMode?: string;
  usedAiCorrection?: boolean;
  quality?: Record<string, unknown>;
  segments?: EnglishSubtitleSegment[];
}

function buildWordsFromTokens(tokens: TimedWordToken[]): WordTiming[] {
  const words: WordTiming[] = [];
  let charOffset = 0;

  tokens.forEach((token, tokenIndex) => {
    let text = tokenIndex === 0 ? token.text.trimStart() : token.text;
    if (!text) return;

    if (words.length > 0) {
      const previousText = words[words.length - 1].text;
      const needsSyntheticSpace = !/^\s/.test(text)
        && !/\s$/.test(previousText)
        && !/^[,.;:!?)}\]]/.test(text);
      if (needsSyntheticSpace) {
        text = ` ${text}`;
      }
    }

    words.push({
      text,
      startMs: token.startMs,
      endMs: token.endMs,
      charStart: charOffset,
      charEnd: charOffset + text.length,
    });
    charOffset += text.length;
  });

  return words;
}

function finalizeExternalSegment(
  segment: EnglishSubtitleSegment,
  timedTokens: TimedWordToken[],
  index: number,
): VideoSceneSegment | null {
  const startToken = typeof segment.startToken === 'number' ? segment.startToken : -1;
  const endToken = typeof segment.endToken === 'number' ? segment.endToken : -1;
  if (startToken < 0 || endToken < startToken || endToken >= timedTokens.length) {
    return null;
  }

  const tokenSlice = timedTokens.slice(startToken, endToken + 1);
  if (tokenSlice.length === 0) return null;
  const words = buildWordsFromTokens(tokenSlice);
  if (words.length === 0) return null;

  const text = typeof segment.text === 'string' && segment.text.trim().length > 0
    ? segment.text.trim()
    : words.map((word) => word.text).join('').trim();

  return {
    id: typeof segment.id === 'string' && segment.id.trim().length > 0 ? segment.id.trim() : `cc-seg-${index}`,
    startMs: typeof segment.startMs === 'number' ? segment.startMs : words[0].startMs,
    endMs: typeof segment.endMs === 'number' ? segment.endMs : words[words.length - 1].endMs,
    speaker: 'narration',
    text,
    textZh: '',
    words,
  };
}

function parseSegmentedEnglishSubtitles(
  englishSegments: EnglishSegmentedSubtitles | undefined,
  timedTokens: TimedWordToken[],
  zhTranslations?: SubtitleTranslations,
): VideoSceneSegment[] | null {
  const rawSegments = englishSegments?.segments;
  if (!Array.isArray(rawSegments) || rawSegments.length === 0) {
    return null;
  }

  const zhMap = zhTranslations?.translations;
  const segments: VideoSceneSegment[] = [];
  rawSegments.forEach((segment, index) => {
    const finalized = finalizeExternalSegment(segment, timedTokens, index);
    if (!finalized) return;
    if (zhMap && zhMap[finalized.id]) {
      finalized.textZh = zhMap[finalized.id];
    }
    segments.push(finalized);
  });

  return segments.length > 0 ? segments : null;
}

/**
 * Parse a YouTube json3 subtitle object into VideoSceneSegment[].
 *
 * - Skips window-positioning / append-newline events.
 * - Skips non-speech markers like [Music], [Laughter], [Applause].
 * - Concatenates word-level segs into one text string per event.
 * - Preserves per-word timing in the `words` array when tOffsetMs is present.
 * - If `zhTranslations` is provided, injects textZh from matching segment IDs.
 */
export function parseJson3Subtitles(
  json3: Json3File,
  zhTranslations?: SubtitleTranslations,
  englishSegments?: EnglishSegmentedSubtitles,
): VideoSceneSegment[] {
  const events = json3.events ?? [];
  const zhMap = zhTranslations?.translations;

  const speechEvents = toSpeechEvents(events);
  const timedTokens = toTimedWordTokens(speechEvents);
  const externalSegments = parseSegmentedEnglishSubtitles(englishSegments, timedTokens, zhTranslations);
  if (externalSegments) {
    return externalSegments;
  }

  // 关键:按 event 边界切句。每个 ASR event (utterance) 已经被服务端 VAD
  // 切好,本身就该是一段字幕,不要拍平后再按标点切。event 内部还是按
  // `[.!?]` 标点再细切 (一个 event 含多句的情况)。
  const tokenGroups = groupTokensByEvent(speechEvents);
  const segments: VideoSceneSegment[] = [];

  const flushSentence = (sentenceTokens: TimedWordToken[]) => {
    const segment = finalizeSentence(sentenceTokens, segments.length);
    if (segment) {
      if (zhMap && zhMap[segment.id]) {
        segment.textZh = zhMap[segment.id];
      }
      segments.push(segment);
    }
  };

  tokenGroups.forEach((groupTokens) => {
    let sentenceTokens: TimedWordToken[] = [];
    groupTokens.forEach((token) => {
      sentenceTokens.push(token);
      const trimmedToken = token.text.trim();
      if (!trimmedToken || !SENTENCE_END_RE.test(trimmedToken)) return;
      flushSentence(sentenceTokens);
      sentenceTokens = [];
    });
    // event 结尾处 flush 一次,保证每个 ASR utterance 至少落成一段
    flushSentence(sentenceTokens);
  });

  return segments;
}

/**
 * Convenience: parse and optionally filter to a time range.
 *
 * @param json3      Raw json3 object (require'd JSON asset).
 * @param startMs    Optional clip start (inclusive).
 * @param endMs      Optional clip end (exclusive).
 */
export function parseJson3ForClip(
  json3: Json3File,
  startMs?: number,
  endMs?: number,
  zhTranslations?: SubtitleTranslations,
  englishSegments?: EnglishSegmentedSubtitles,
): VideoSceneSegment[] {
  const all = parseJson3Subtitles(json3, zhTranslations, englishSegments);
  if (startMs === undefined && endMs === undefined) return all;

  const lo = startMs ?? 0;
  const hi = endMs ?? Infinity;

  return all.filter((seg) => seg.startMs >= lo && seg.startMs < hi);
}
