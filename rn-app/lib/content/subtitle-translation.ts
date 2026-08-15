import { translateBatch, VOLC_MT_BATCH_LIMIT } from '../volcengine/mt';
import type { SubtitleTranslations } from './json3-parser';

type Json3Event = {
  tStartMs: number;
  dDurationMs: number;
  segs?: Array<{
    utf8: string;
    tOffsetMs?: number;
  }>;
  id?: number;
  wpWinPosId?: number;
  aAppend?: number;
};

type Json3FileLike = {
  events?: Json3Event[];
};

type SentenceSegment = {
  id: string;
  startMs: number;
  endMs: number;
  text: string;
};

type TimedWordToken = {
  text: string;
  startMs: number;
  endMs: number;
};

const NON_SPEECH_RE = /^\[.*\]$/;
const SENTENCE_END_RE = /[.!?]["']*$/;
const HARD_PAUSE_SPLIT_MS = 900;
const SOFT_PAUSE_SPLIT_MS = 600;
const SOFT_PAUSE_MIN_TOKENS = 8;
const SOFT_PAUSE_MIN_DURATION_MS = 2200;
const MAX_SENTENCE_TOKENS = 14;
const MAX_SENTENCE_DURATION_MS = 5200;
// 火山机器翻译大模型 (matx_translate) 接口硬上限是 16 条/批。
const BATCH_SIZE = VOLC_MT_BATCH_LIMIT;

function toSpeechEvents(events: Json3Event[]) {
  return events
    .filter((event) => {
      if (event.id !== undefined && event.wpWinPosId !== undefined) return false;
      if (event.aAppend) return false;
      if (!event.segs || event.segs.length === 0) return false;
      const text = event.segs.map((segment) => segment.utf8).join('').replace(/\n/g, ' ').trim();
      return Boolean(text) && !NON_SPEECH_RE.test(text);
    })
    .map((event) => ({
      event,
      text: event.segs!.map((segment) => segment.utf8).join('').replace(/\n/g, ' ').trim(),
    }));
}

function toTimedWordTokens(speechEvents: Array<{ event: Json3Event; text: string }>) {
  const tokens: TimedWordToken[] = [];
  speechEvents.forEach(({ event }, index) => {
    const nextStartMs = speechEvents[index + 1]?.event.tStartMs;
    const durationMs = event.dDurationMs;
    let displayEndMs: number;
    if (Number.isFinite(durationMs) && durationMs >= 0) {
      displayEndMs = event.tStartMs + durationMs;
    } else if (nextStartMs !== undefined && nextStartMs > event.tStartMs) {
      displayEndMs = nextStartMs;
    } else {
      const offsets = event.segs?.map((segment) => segment.tOffsetMs ?? 0) ?? [];
      displayEndMs = event.tStartMs + Math.max(0, ...offsets);
    }
    const segmentEndMs = nextStartMs !== undefined ? Math.min(displayEndMs, nextStartMs) : displayEndMs;
    for (let tokenIndex = 0; tokenIndex < (event.segs?.length || 0); tokenIndex += 1) {
      const segment = event.segs![tokenIndex];
      const rawText = segment.utf8.replace(/\n/g, ' ');
      if (!rawText.trim()) continue;
      const startMs = event.tStartMs + (segment.tOffsetMs ?? 0);
      const endMs = tokenIndex < event.segs!.length - 1
        ? Math.min(segmentEndMs, event.tStartMs + (event.segs![tokenIndex + 1].tOffsetMs ?? 0))
        : segmentEndMs;
      tokens.push({
        text: rawText,
        startMs,
        endMs: Math.max(startMs, endMs),
      });
    }
  });
  return tokens;
}

/**
 * 按 ASR event 边界分组的 token 二维数组。每个 event 是一组 (VAD 已经按
 * 静音切好),调用方拿到后应在每组结束处 finalize 一句,不要做跨 event 切句。
 * 跟 json3-parser.ts::groupTokensByEvent 是同一思路,保证显示侧和翻译侧
 * 切出的 segment ID (`cc-seg-N`) 完全一致,这样 `.zh.json` 的中文才能
 * 正确挂到对应的英文段上。
 */
function groupTokensByEvent(speechEvents: Array<{ event: Json3Event; text: string }>): TimedWordToken[][] {
  const groups: TimedWordToken[][] = [];
  speechEvents.forEach(({ event }, eventIndex) => {
    const nextStartMs = speechEvents[eventIndex + 1]?.event.tStartMs;
    const durationMs = event.dDurationMs;
    let displayEndMs: number;
    if (Number.isFinite(durationMs) && durationMs >= 0) {
      displayEndMs = event.tStartMs + durationMs;
    } else if (nextStartMs !== undefined && nextStartMs > event.tStartMs) {
      displayEndMs = nextStartMs;
    } else {
      const offsets = event.segs?.map((segment) => segment.tOffsetMs ?? 0) ?? [];
      displayEndMs = event.tStartMs + Math.max(0, ...offsets);
    }
    const segmentEndMs = nextStartMs !== undefined ? Math.min(displayEndMs, nextStartMs) : displayEndMs;
    const group: TimedWordToken[] = [];
    for (let tokenIndex = 0; tokenIndex < (event.segs?.length || 0); tokenIndex += 1) {
      const segment = event.segs![tokenIndex];
      const rawText = segment.utf8.replace(/\n/g, ' ');
      if (!rawText.trim()) continue;
      const startMs = event.tStartMs + (segment.tOffsetMs ?? 0);
      const endMs = tokenIndex < event.segs!.length - 1
        ? Math.min(segmentEndMs, event.tStartMs + (event.segs![tokenIndex + 1].tOffsetMs ?? 0))
        : segmentEndMs;
      group.push({
        text: rawText,
        startMs,
        endMs: Math.max(startMs, endMs),
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

function finalizeSentence(tokens: TimedWordToken[], index: number): SentenceSegment | null {
  if (tokens.length === 0) return null;
  const normalizedTokens: string[] = [];
  tokens.forEach((token, tokenIndex) => {
    let text = tokenIndex === 0 ? token.text.trimStart() : token.text;
    if (!text) return;
    if (normalizedTokens.length > 0) {
      const previousText = normalizedTokens[normalizedTokens.length - 1];
      const needsSpace = !/^\s/.test(text)
        && !/\s$/.test(previousText)
        && !/^[,.;:!?)}\]]/.test(text);
      if (needsSpace) {
        text = ` ${text}`;
      }
    }
    normalizedTokens.push(text);
  });
  if (normalizedTokens.length === 0) return null;
  return {
    id: `cc-seg-${index}`,
    startMs: tokens[0].startMs,
    endMs: tokens[tokens.length - 1].endMs,
    text: normalizedTokens.join('').trim(),
  };
}

export function parseJson3ToSentenceSegments(json3: Json3FileLike): SentenceSegment[] {
  const events = json3.events ?? [];
  const speechEvents = toSpeechEvents(events);
  // 按 event 边界分组:每个 ASR utterance 一组,保证最终 segment 跟
  // json3-parser.ts::parseJson3Subtitles 切出来的完全一致(都用 cc-seg-N 编号)。
  // 组内还是用 shouldSplitBeforeToken + 标点进一步切,但不跨 event。
  const tokenGroups = groupTokensByEvent(speechEvents);
  const segments: SentenceSegment[] = [];

  const flushSentence = (sentenceTokens: TimedWordToken[]) => {
    const seg = finalizeSentence(sentenceTokens, segments.length);
    if (seg) {
      segments.push(seg);
    }
  };

  tokenGroups.forEach((groupTokens) => {
    let sentenceTokens: TimedWordToken[] = [];
    groupTokens.forEach((token) => {
      if (shouldSplitBeforeToken(sentenceTokens, token)) {
        flushSentence(sentenceTokens);
        sentenceTokens = [];
      }
      sentenceTokens.push(token);
      const trimmed = token.text.trim();
      if (!trimmed || !SENTENCE_END_RE.test(trimmed)) {
        return;
      }
      flushSentence(sentenceTokens);
      sentenceTokens = [];
    });
    // event 结尾处 flush 一次
    flushSentence(sentenceTokens);
  });

  return segments;
}

export async function generateSubtitleTranslationPayload(
  json3: Json3FileLike,
  sourceSubtitle: string,
  options?: { onProgress?: (message: string) => void; segmentedPayload?: { sourceSubtitle?: string; segmentCount?: number; segments?: Array<{ id?: string; text?: string; startMs?: number; endMs?: number }> } },
): Promise<SubtitleTranslations> {
  // 2026-08-15: 跟桌面端镜像 — 优先用 *.en.segmented.json 里的 segments
  // (由 subtitle-segmenter 调 LLM 修标点/大写 + 本地按标点切/合并生成的).
  // 没有才回退到本地 groupTokensByEvent 切分.
  let sentences: SentenceSegment[];
  if (options?.segmentedPayload?.segments && options.segmentedPayload.segments.length > 0) {
    sentences = options.segmentedPayload.segments.map((seg, idx) => ({
      id: seg.id || `cc-seg-${idx}`,
      startMs: typeof seg.startMs === 'number' ? seg.startMs : 0,
      endMs: typeof seg.endMs === 'number' ? seg.endMs : 0,
      text: (seg.text || '').trim(),
    })).filter((s) => s.text);
    console.log(`[SubtitleTrans] use segmented.json: ${sentences.length} sentences`);
  } else {
    sentences = parseJson3ToSentenceSegments(json3);
    console.log(`[SubtitleTrans] use local parseJson3ToSentenceSegments: ${sentences.length} sentences`);
  }
  if (sentences.length === 0) {
    throw new Error('字幕文件中没有找到有效句子');
  }
  options?.onProgress?.(`提取到 ${sentences.length} 个句子，开始翻译…`);
  const translations: Record<string, string> = {};
  for (let batchStart = 0; batchStart < sentences.length; batchStart += BATCH_SIZE) {
    const batch = sentences.slice(batchStart, batchStart + BATCH_SIZE);
    options?.onProgress?.(`翻译中: ${batchStart + 1}-${Math.min(batchStart + batch.length, sentences.length)}/${sentences.length}`);
    // 火山机器翻译大模型:返回的 translation_list 跟输入 text_list 1:1
    // 对应,直接按索引挂到 sentence.id,不再用 "1. xxx" 解析,避免 LLM
    // 偶发漏行/编号错导致丢翻译。
    const translated = await translateBatch({
      texts: batch.map((s) => s.text),
      sourceLanguage: 'en',
      targetLanguage: 'zh',
      requestLabel: `sub:${sourceSubtitle}:${batchStart}`,
    });
    batch.forEach((sentence, index) => {
      const text = translated[index];
      if (text) {
        translations[sentence.id] = text;
      }
    });
  }
  return {
    sourceSubtitle,
    segmentCount: sentences.length,
    translations,
  };
}
