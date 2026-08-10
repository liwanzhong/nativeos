/**
 * Volcengine 机器翻译大模型 (matx_translate)
 * Doc: https://www.volcengine.com/docs/6561/...
 *
 * 跟 ASR (`/api/v1/vc/submit`) 一样,直连 openspeech.bytedance.com,不走
 * 任何中间代理。鉴权是旧版控制台风格 (`X-Api-App-Key` + `X-Api-Access-Key`
 * + `X-Api-Resource-Id=volc.speech.mt`),跟 TTS/ASR 用同一对
 * VOLC_APP_ID / VOLC_ACCESS_TOKEN,不用单独开凭据。
 *
 * 接口硬约束:
 *   - text_list 长度 ≤ 16
 *   - 单条 ≤ 1024 tokens
 *   - 错误码 20000000 = 成功,45000130 = 列表过长/单条超长,45000001 = 缺参
 *   - 错误码 55000001 = 服务内部错误
 *
 * 返回结构 (成功):
 *   { code: 20000000, message: 'ok',
 *     data: { translation_list: [ { translation, usage? } ] } }
 *
 * 跟之前 LLM 翻译最大的区别:返回的 translation_list 跟输入 text_list 1:1
 * 对应,不用解析 "1. xxx" 编号正则,**没有 LLM 偶发漏行/编号错的风险**。
 */

import { VOLC_APP_ID, VOLC_ACCESS_TOKEN } from './config';

const VOLC_MT_URL = 'https://openspeech.bytedance.com/api/v3/machine_translation/matx_translate';
const VOLC_MT_RESOURCE_ID = 'volc.speech.mt';
// 文档硬上限。LLM 那版我们是 25,这里必须降到 16。
export const VOLC_MT_BATCH_LIMIT = 16;
const MT_HTTP_TIMEOUT_MS = 30_000;

export type MatxTranslation = {
  translation: string;
  detected_source_language?: string;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
};

interface MatxResponse {
  code: number;
  message: string;
  data?: {
    translation_list?: MatxTranslation[];
  };
}

function buildRequestId(): string {
  const seg = () => Math.floor((1 + Math.random()) * 0x10000).toString(16).slice(1);
  return `${seg()}${seg()}-${seg()}-${seg()}-${seg()}-${seg()}${seg()}${seg()}`;
}

/**
 * 翻译一批文本(≤ 16 条)。返回跟输入等长的字符串数组,顺序一一对应。
 * 任何一条翻译失败(空字符串 / 接口报错)整批 throw,调用方按需重试。
 */
export async function translateBatch(params: {
  texts: string[];
  sourceLanguage?: string;     // 不传 = 服务端自动检测
  targetLanguage: string;      // 必填,例如 'zh' / 'en'
  requestLabel?: string;       // 日志用
}): Promise<string[]> {
  if (params.texts.length === 0) {
    return [];
  }
  if (params.texts.length > VOLC_MT_BATCH_LIMIT) {
    throw new Error(
      `MT batch 超长: ${params.texts.length} > ${VOLC_MT_BATCH_LIMIT} (text_list 上限 16)`,
    );
  }

  const body: Record<string, unknown> = {
    target_language: params.targetLanguage,
    text_list: params.texts,
  };
  if (params.sourceLanguage) {
    body.source_language = params.sourceLanguage;
  }

  const url = VOLC_MT_URL;
  const requestId = buildRequestId();
  console.log('[VolcMt] batch start', {
    label: params.requestLabel,
    requestId,
    count: params.texts.length,
    sourceLanguage: params.sourceLanguage ?? '(auto)',
    targetLanguage: params.targetLanguage,
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MT_HTTP_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'X-Api-App-Key': VOLC_APP_ID,
        'X-Api-Access-Key': VOLC_ACCESS_TOKEN,
        'X-Api-Resource-Id': VOLC_MT_RESOURCE_ID,
        'X-Api-Request-Id': requestId,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(
      `MT HTTP 失败: status=${response.status} body=${errText.slice(0, 300)}`,
    );
  }

  const result = (await response.json()) as MatxResponse;
  if (result.code !== 20000000) {
    throw new Error(
      `MT 业务失败: code=${result.code} message=${result.message || '(empty)'} ` +
      `(${params.requestLabel || requestId})`,
    );
  }
  const list = result.data?.translation_list;
  if (!Array.isArray(list)) {
    throw new Error(`MT 响应缺 translation_list (${params.requestLabel || requestId})`);
  }
  if (list.length !== params.texts.length) {
    throw new Error(
      `MT 返回条数不匹配: 入参 ${params.texts.length} 出参 ${list.length} ` +
      `(${params.requestLabel || requestId})`,
    );
  }
  const translations = list.map((item, index) => {
    const text = typeof item.translation === 'string' ? item.translation.trim() : '';
    if (!text) {
      throw new Error(
        `MT 第 ${index + 1} 条翻译为空 (${params.requestLabel || requestId})`,
      );
    }
    return text;
  });

  console.log('[VolcMt] batch done', {
    label: params.requestLabel,
    requestId,
    count: translations.length,
    sample: translations[0]?.slice(0, 60),
  });
  return translations;
}
