import Constants from 'expo-constants';
import { NativeModules } from 'react-native';

/**
 * Volcengine (ByteDance) ASR + TTS credentials and endpoint configuration.
 * In production, move these to environment variables.
 */

export const VOLC_APP_ID = '5128453750';
export const VOLC_ACCESS_TOKEN = '8kECf9ZsUy4N5FJF0D_jIfA_0IeuFDZ-';

// 单向流式 TTS (doc 6561/2528925) 用 X-Api-Key 鉴权,需要从
// https://console.volcengine.com/speech/new/setting/apikeys?projectName=default
// 「API Key 管理」页面新建/复制一个 Key,不能直接复用上面的 access_token
// (access_token 是给旧版 Authorization: Bearer; <token> 用的,X-Api-Key
// 是另一套机制 — 服务端会报 code=45000010 "Invalid X-Api-Key")
export const VOLC_TTS_API_KEY = 'ee7d690f-0528-4464-a279-97fa2025c286';

// 阿里云 OSS 字段已废弃：之前 ASR 走"file ASR (submit/query) + OSS 中转"，
// 2026-08-07 改用大模型流式识别 (WebSocket binary protocol, 直发 wav PCM),
// 完全去掉 OSS 中转环节,RN emulator 上 PUT 100-continue 卡死 / 签名 403 等
// 坑都不用踩了。OSS 字段保留以防 desktop 端对接需要(虽然 desktop 走自己
// 的 oss2 库不需要这个),用 ALIYUN_OSS_* 命名的常量直接由调用方按需定义。

export const VOLC_ASR_URL = 'wss://openspeech.bytedance.com/api/v3/sauc/bigmodel';
export const VOLC_ASR_RESOURCE_ID = 'volc.bigasr.sauc.duration';

// 单向流式 TTS (HTTP chunked) — doc 6561/2528925
// 鉴权 X-Api-Key 与控制台 API Key 管理页签发,沿用 VOLC_ACCESS_TOKEN 字段。
export const VOLC_TTS_URL = 'https://openspeech.bytedance.com/api/v3/tts/unidirectional';
export const VOLC_TTS_RESOURCE_ID = 'seed-tts-2.0';
// English NPC speaker — 豆包语音合成模型 2.0 音色 (英式),见 doc 6561/1257544
// 2.0 接口只接 _uranus_bigtts 后缀的音色 ID,且 doc 多语种表里真正英式英语
// 只有 Charlotte 一个。原生 1.0 的 moon/mars 音色跟 seed-tts-2.0 不匹配。
export const VOLC_TTS_SPEAKER = 'en_female_authoritative-british_uranus_bigtts';

// 开发期 dev host 推断 (用于 NAT 转发到本机代理),保留供参考;
// 所有 dev proxy 已在 2026-08 删除,这个 helper 暂时没被引用,但重新启用
// proxy 调试时可以直接恢复。
function getExpoDevHost(): string | null {
  const candidates = [
    { value: (Constants as any)?.expoConfig?.hostUri },
    { value: (Constants as any)?.manifest2?.extra?.expoClient?.hostUri },
    { value: (Constants as any)?.manifest?.debuggerHost },
    { value: (Constants as any)?.expoGoConfig?.debuggerHost },
    { value: (NativeModules as any)?.SourceCode?.scriptURL },
  ];
  for (const candidate of candidates) {
    const value = candidate.value;
    if (typeof value !== 'string' || !value.trim()) continue;
    const normalized = value.includes('://') ? value.split('://')[1] ?? value : value;
    const host = normalized.split('/')[0]?.split(':')[0]?.trim();
    if (host) return host;
  }
  return null;
}
