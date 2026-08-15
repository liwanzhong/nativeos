/**
 * 字幕断句优化器 — 跟桌面端 videoinfo-gengui/tabs/ai_client.py 镜像.
 *
 * 流程:
 *   1) aiCorrectSubtitleUnits — 调 LLM 修标点/大写 (1-to-1 严格映射 + 宽容验证)
 *   2) logicSplitUnits         — 本地按标点切/合并 fragment (确定性, 不调 LLM)
 *   3) correctThenSplit        — 组合: 先 LLM 修 (失败/未配则跳过), 再本地切
 *
 * LLM 路由跟 npc-chat.ts::getNPCReply 一样: BYOK 优先 → Shared Qwen 兜底.
 * BYOK 没配 / 不是 Pro → 走 NativeOS 自己的 Qwen key (EXPO_PUBLIC_QWEN_API_KEY).
 * 跟桌面端 _ai_correct_sentence_segments 行为完全一致, 同样的 prompt + 同样的
 * 1-to-1 验证规则 + 同样的本地按标点切/合并.
 *
 * 调用方 (user-videos.ts::commitGeneratedSubtitle) 拿到 ASR result 后调
 * correctThenSplit, 把结果写成 `<subtitleUri>.en.segmented.json` 持久化,
 * 避免每次显示/翻译都调 LLM. 实时 fallback 走 parseSegmentedEnglishSubtitles
 * 或 logicSplitUnits.
 */

import { callOpenAiCompatible } from '../ai/openai-compatible';
import { getActiveByok, BYOK_PROVIDERS, type ByokConfig } from '../byok';

const SHARED_QWEN_API_KEY = process.env.EXPO_PUBLIC_QWEN_API_KEY || '';
const SHARED_QWEN_BASE_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1';
const SHARED_QWEN_MODEL = 'qwen-plus';

const LLM_BATCH_UNITS = 16;

const UNIT_END_PUNC_RE = /[.!?。！？]["')\]]*\s*$/;
const SENTENCE_END_RE = /[.!?]["']*$/;
const NON_SPEECH_RE = /^\[.*\]$/;

export const ENGLISH_SEGMENTATION_SYSTEM_PROMPT = `\
You are a subtitle text normalizer. For each input unit, output EXACTLY ONE
segment that covers that single unit. Do NOT merge units. Do NOT split units.

HARD RULES — strict 1-to-1 mapping:
- Every input unit must appear in the output as its OWN segment.
- \`startUnit\` MUST equal \`endUnit\` for every segment.
- The number of output segments must equal the number of input units.
- Do not reorder units.
- Do not drop content. Do not invent content.

What you MAY change in the text:
- Add missing sentence-final punctuation (\`.\` \`!\` \`?\`).
- Add commas, apostrophes, hyphens, or dashes where grammatically needed.
- Capitalize the first letter of each sentence.
- Capitalize proper nouns (e.g. "George" not "george", "Peppa" not "peppa").
- Fix obvious ASR word errors only if you are very confident.

What you MUST NOT change:
- The words themselves.
- The order of words.

Return JSON only in this format (note: startUnit == endUnit for every segment):
{"segments":[{"startUnit":1,"endUnit":1,"text":"Tropical day trip."}, {"startUnit":2,"endUnit":2,"text":"Peppa and George are on a cruise ship holiday."}]}`;

// ── 共享 unit 类型 ──────────────────────────────────────────────────

/**
 * 字幕断句优化器输入的最小单位: 一个 ASR event (utterance) 折成的"伪 unit",
 * 含 text + 时序信息. 不依赖 json3 event/segs 结构, 方便 LLM 1-to-1 处理.
 */
export interface SubtitleUnit {
  /** 1-based 索引, 跟 LLM 输出的 startUnit/endUnit 对齐. */
  index: number;
  text: string;
  startMs: number;
  endMs: number;
}

export interface CorrectedSubtitleSegment {
  id?: string;
  startToken: number;
  endToken: number;
  startMs: number;
  endMs: number;
  text: string;
}

// ── 本地按标点切/合并 fragment (确定性, 不调 LLM) ────────────────────

function _looksLikeCompleteSentence(text: string): boolean {
  return UNIT_END_PUNC_RE.test((text || '').trimEnd());
}

function _buildSegmentFromUnits(units: SubtitleUnit[]): CorrectedSubtitleSegment | null {
  if (units.length === 0) return null;
  if (units.length === 1) {
    const u = units[0];
    return {
      startToken: u.index - 1,
      endToken: u.index - 1,
      startMs: u.startMs,
      endMs: u.endMs,
      text: (u.text || '').trim(),
    };
  }
  // 多个 unit 合并 (fragment 合并): token index 取首尾, text 用空格拼接.
  const first = units[0];
  const last = units[units.length - 1];
  const text = units.map((u) => (u.text || '').trim()).filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
  return {
    startToken: first.index - 1,
    endToken: last.index - 1,
    startMs: first.startMs,
    endMs: last.endMs,
    text,
  };
}

/**
 * 跟桌面端 _logic_split_units 镜像:
 * - 标点结尾的 unit → 闭合当前段, 落成一段
 * - 无标点 unit (fragment) → 跟后续合并, 直到遇到有标点的
 * - 末尾 fragment → 跟最后一段合并 (如果有), 否则独立成段
 */
export function logicSplitUnits(units: SubtitleUnit[]): CorrectedSubtitleSegment[] {
  if (!units || units.length === 0) return [];
  const out: CorrectedSubtitleSegment[] = [];
  let buf: SubtitleUnit[] = [];
  for (const unit of units) {
    buf.push(unit);
    if (_looksLikeCompleteSentence(unit.text)) {
      const seg = _buildSegmentFromUnits(buf);
      if (seg) out.push(seg);
      buf = [];
    }
  }
  // 末尾 fragment: 跟最后一段合并 (如果有), 否则独立
  if (buf.length > 0) {
    if (out.length > 0) {
      const last = out[out.length - 1];
      // 把最后一段还原成 pseudo-unit, 再跟 buf 合并
      const pseudo: SubtitleUnit = {
        index: last.startToken + 1,
        text: last.text,
        startMs: last.startMs,
        endMs: last.endMs,
      };
      const merged = _buildSegmentFromUnits([pseudo, ...buf]);
      if (merged) out[out.length - 1] = merged;
    } else {
      const seg = _buildSegmentFromUnits(buf);
      if (seg) out.push(seg);
    }
  }
  return out;
}

// ── LLM 路由 (跟 npc-chat.ts 一样的 BYOK → Shared Qwen 兜底) ────────

interface LlmRoute {
  baseUrl: string;
  apiKey: string;
  model: string;
  source: 'byok' | 'shared_qwen' | 'none';
}

async function resolveLlmRoute(): Promise<LlmRoute> {
  // 1) BYOK 优先
  try {
    const byok: ByokConfig | null = await getActiveByok();
    if (byok) {
      const preset = BYOK_PROVIDERS[byok.provider];
      const baseUrl = byok.baseUrl || preset.baseUrl;
      const apiKey = byok.apiKeyB64; // 已解密
      if (baseUrl && apiKey && byok.model) {
        return { baseUrl, apiKey, model: byok.model, source: 'byok' };
      }
    }
  } catch (e) {
    console.warn('[SubtitleSeg] BYOK route resolve failed, fallback to shared', e);
  }
  // 2) Shared Qwen (跟 npc-chat.ts 的 QWEN_* 常量镜像)
  if (SHARED_QWEN_API_KEY) {
    return { baseUrl: SHARED_QWEN_BASE_URL, apiKey: SHARED_QWEN_API_KEY, model: SHARED_QWEN_MODEL, source: 'shared_qwen' };
  }
  return { baseUrl: '', apiKey: '', model: '', source: 'none' };
}

// ── LLM 修标点/大写 (1-to-1 严格映射 + 宽容验证) ────────────────────

/**
 * 把 units 喂给 LLM, 要求严格 1-to-1 输出 (修标点/大写, 不参与切段).
 * 宽容验证: LLM 抽风 (丢/合并/多) 时缺失的 unit 用本地原始 text 兜底.
 *
 * 跟桌面端 _ai_correct_sentence_segments 行为一致, 同样的 prompt + 同样的
 * 1-to-1 验证规则.
 */
export async function aiCorrectSubtitleUnits(
  units: SubtitleUnit[],
  options?: { onProgress?: (msg: string) => void; signal?: AbortSignal },
): Promise<SubtitleUnit[] | null> {
  if (units.length === 0) return units;

  const route = await resolveLlmRoute();
  if (route.source === 'none') {
    console.log('[SubtitleSeg] LLM 未配置 (无 BYOK 无 Shared Qwen key), 跳过 AI 矫正');
    return null;
  }

  const corrected: SubtitleUnit[] = [];
  for (let batchStart = 0; batchStart < units.length; batchStart += LLM_BATCH_UNITS) {
    if (options?.signal?.aborted) {
      throw new Error('aiCorrectSubtitleUnits aborted');
    }
    const batch = units.slice(batchStart, batchStart + LLM_BATCH_UNITS);
    const numberedLines = batch.map((u, i) => `${i + 1}. ${u.text || ''}`);
    const userPrompt = [
      'Normalize the following subtitle units (one output segment per unit).',
      'Return JSON only.',
      '',
      ...numberedLines,
    ].join('\n');
    options?.onProgress?.(`  字幕断句 AI 矫正中: ${batchStart + 1}-${Math.min(batchStart + batch.length, units.length)} / ${units.length} unit`);

    const result = await callOpenAiCompatible({
      baseUrl: route.baseUrl,
      apiKey: route.apiKey,
      model: route.model,
      systemPrompt: ENGLISH_SEGMENTATION_SYSTEM_PROMPT,
      history: [],
      userMessage: userPrompt,
      temperature: 0.2,
      maxTokens: 4000,
      jsonMode: true,
      timeoutMs: 60_000,
    });

    if (!result.ok) {
      console.warn(`[SubtitleSeg] LLM 调用失败 (${result.reason}): ${('message' in result ? result.message : '') || ''}, fallback to raw`);
      // 整个 batch fallback 到原始 unit text
      for (const u of batch) corrected.push(u);
      continue;
    }

    // 解析 LLM 返回的 JSON
    let payload: { segments?: Array<{ startUnit?: number; endUnit?: number; text?: string }> };
    try {
      const text = result.text.trim();
      // LLM 偶尔会包 ```json ``` 围栏, 去掉
      const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
      payload = JSON.parse(cleaned);
    } catch (e) {
      console.warn(`[SubtitleSeg] LLM 返回 JSON 解析失败: ${(e as Error).message}; raw preview: ${result.text.slice(0, 200)}`);
      for (const u of batch) corrected.push(u);
      continue;
    }

    const segs = Array.isArray(payload?.segments) ? payload.segments : [];
    // 宽容验证 (跟桌面端 _validate_ai_segment_batch 镜像)
    const byStart = new Map<number, { startUnit: number; endUnit: number; text: string }>();
    for (const seg of segs) {
      if (!seg || typeof seg !== 'object') continue;
      const startU = Number(seg.startUnit) || 0;
      const endU = Number(seg.endUnit) || startU;
      if (startU <= 0 || startU > batch.length) continue;
      if (endU < startU || endU > batch.length) continue;
      if (!byStart.has(startU)) {
        byStart.set(startU, { startUnit: startU, endUnit: endU, text: String(seg.text || '').trim() });
      }
    }

    let fallbackCount = 0;
    for (let unitIdx = 1; unitIdx <= batch.length; unitIdx++) {
      const u = batch[unitIdx - 1];
      const hit = byStart.get(unitIdx);
      if (hit && hit.startUnit === hit.endUnit && hit.startUnit === unitIdx) {
        // 严格 1-to-1: 用 LLM 修过的 text
        corrected.push({ ...u, text: hit.text || u.text });
      } else if (hit && unitIdx >= hit.startUnit && unitIdx <= hit.endUnit) {
        // LLM 合并: 只有 startUnit 拿 LLM 修过的 text, 其他 unit 兜底
        if (unitIdx === hit.startUnit) {
          corrected.push({ ...u, text: hit.text || u.text });
        } else {
          corrected.push(u);
          fallbackCount++;
        }
      } else {
        // LLM 漏了: 用原始 text
        corrected.push(u);
        fallbackCount++;
      }
    }
    if (fallbackCount > 0 || byStart.size !== batch.length) {
      console.log(`[SubtitleSeg] batch fallbackUnits=${fallbackCount} llmSegments=${byStart.size}/${batch.length}`);
    }
  }

  return corrected;
}

// ── 组合: 先 LLM 再本地按标点切 ────────────────────────────────────

/**
 * 完整流程:
 *   1) aiCorrectSubtitleUnits 调 LLM 修标点/大写 (失败/未配则跳过, 走原始 text)
 *   2) logicSplitUnits 本地按标点切/合并 fragment
 *
 * 切段决策完全本地、确定性, LLM 怎么抽风都不影响"一句一段"核心诉求.
 */
export async function correctThenSplit(
  units: SubtitleUnit[],
  options?: { onProgress?: (msg: string) => void; signal?: AbortSignal },
): Promise<CorrectedSubtitleSegment[]> {
  if (!units || units.length === 0) return [];
  let workingUnits: SubtitleUnit[] = units;
  try {
    const llmOut = await aiCorrectSubtitleUnits(units, options);
    if (llmOut && llmOut.length === units.length) {
      workingUnits = llmOut;
    }
  } catch (e) {
    console.warn(`[SubtitleSeg] LLM correction failed, fallback to raw: ${(e as Error).message}`);
  }
  return logicSplitUnits(workingUnits);
}

// ── 跟现有 json3-parser.ts 兼容的辅助函数 ────────────────────────────

/**
 * 从 json3 events 构造 SubtitleUnit 数组 (用于 LLM 输入).
 * 每个 ASR event 折成一个 unit, text 是该 event 拼接 segs 的结果.
 */
export function json3EventsToSubtitleUnits(events: Array<{
  tStartMs: number;
  dDurationMs: number;
  segs?: Array<{ utf8: string }>;
}>): SubtitleUnit[] {
  return events
    .map((event, i) => {
      const text = (event.segs || []).map((s) => s.utf8).join('').replace(/\n/g, ' ').trim();
      if (!text || NON_SPEECH_RE.test(text)) return null;
      return {
        index: i + 1,
        text,
        startMs: event.tStartMs,
        endMs: event.tStartMs + (event.dDurationMs || 0),
      } as SubtitleUnit;
    })
    .filter((u): u is SubtitleUnit => u != null);
}

// 暴露 SENTENCE_END_RE 给 json3-parser 兼容用
export { SENTENCE_END_RE };
