/**
 * 词典类型。
 *
 * 完全按 skywind3000/ECDICT 官方 stardict.py 的 schema 暴露字段。
 * 见 https://github.com/skywind3000/ECDICT/blob/master/stardict.py
 */
export interface DictionaryEntry {
  id: number;
  /** 原始 headword（保持大小写） */
  word: string;
  /** = word.toLowerCase()，sort key */
  lemma: string;
  /** IPA 音标 */
  phonetic: string | null;
  /** 英文释义（多行 \n 分隔） */
  definition: string | null;
  /** 中文翻译 */
  translation: string | null;
  /** 词性：n / v / a / adj / adv / vt / vi ... */
  pos: string | null;
  /** 柯林斯星级 0-5（5 = 核心词） */
  collins: number;
  /** 牛津 3000 词表 0/1 */
  oxford: number;
  /** 考试标签：zk / GRE / TOEFL / IELTS 等 */
  tag: string | null;
  /** BNC 语料库词频序号 */
  bnc: number;
  /** 当代语料库词频序号 */
  frq: number;
  /** 形变字符串 "d:done/p:did/3:does/i:doing" */
  exchange: string | null;
  /** 详情 JSON：时态/同义/反义 等 */
  detail: string | null;
  /** 第三方 mp3 URL（部分词有） */
  audio: string | null;
}

/** 查词命中类型 */
export type DictionaryMatchKind = 'exact' | 'normalized' | 'form' | 'none';

export interface DictionaryResult {
  query: string;
  /** 归一化后的小写 token */
  normalized: string;
  /** 当前 query 对应的 lemma（可能跟 normalized 不同，比如 went → go） */
  lemma: string | null;
  matchKind: DictionaryMatchKind;
  entries: DictionaryEntry[];
}
