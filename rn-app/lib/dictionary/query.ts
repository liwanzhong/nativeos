import { openDictionaryDb } from './db';
import { normalizeLookupToken } from './normalize';
import type {
  DictionaryEntry,
  DictionaryMatchKind,
  DictionaryResult,
} from './types';

function rowToEntry(row: any): DictionaryEntry {
  return {
    id: row.id,
    word: row.word,
    lemma: row.sw,
    phonetic: row.phonetic ?? null,
    definition: row.definition ?? null,
    translation: row.translation ?? null,
    pos: row.pos ?? null,
    collins: Number(row.collins ?? 0),
    oxford: Number(row.oxford ?? 0),
    tag: row.tag ?? null,
    bnc: Number(row.bnc ?? 0),
    frq: Number(row.frq ?? 0),
    exchange: row.exchange ?? null,
    detail: row.detail ?? null,
    audio: row.audio ?? null,
  };
}

/** Sort: 高 collins 优先 → 低 frq 优先（更常用）→ id 稳定 */
function sortEntries(entries: DictionaryEntry[]): DictionaryEntry[] {
  return [...entries].sort((a, b) => {
    if (a.collins !== b.collins) return b.collins - a.collins;
    if (a.frq && b.frq && a.frq !== b.frq) return a.frq - b.frq;
    return a.id - b.id;
  });
}

const ENTRY_LIMIT = 20;

async function fetchByWord(db: any, word: string): Promise<DictionaryEntry[]> {
  // 精确查 word 字段（COLLATE NOCASE 处理大小写）。
  // 不查 sw：sw 是 strip-word 模糊匹配键（"about" 和 "-about" 共用），
  // 会把同根不同形的条目都拉出来；精确查找只需要 word 完全一致的那条。
  const rows = await db.getAllAsync(
    `SELECT * FROM stardict WHERE word = ? COLLATE NOCASE LIMIT ?`,
    [word, ENTRY_LIMIT],
  );
  return (rows as any[]).map(rowToEntry);
}

/**
 * 形变回退：查询没命中时，从所有 entry 的 exchange 字段里找
 * "输入" 对应的形变，返回 entry 的 sw 作为 lemma。
 *
 * 之所以不全靠 sw 索引搞定：虽然 ECDICT 里大部分形变（done/went/was）
 * 都作为独立 headword 收录，但仍有少量只在原型 entry 的 exchange 字符串里登记。
 *
 * SQL 里 exchange 的形变对是 "d:done/p:did/3:does/i:doing"，
 * 用 LIKE '%:went%' 配合 sw IN (...) 验证。
 */
async function resolveFormLemma(db: any, sw: string): Promise<string | null> {
  // 找所有 exchange 包含 ":sw" 的行（带冒号防止子串误命中）
  const rows = await db.getAllAsync(
    `SELECT sw, exchange FROM stardict
     WHERE exchange LIKE ? OR exchange LIKE ? OR exchange LIKE ?
     LIMIT 50`,
    [`%:${sw}`, `${sw}/%`, `${sw}`], // 最后这个匹配单独的 "d:done" 形式
  );
  for (const row of rows as any[]) {
    const ex = row.exchange as string | null;
    if (!ex) continue;
    for (const pair of ex.split('/')) {
      const colonIdx = pair.indexOf(':');
      if (colonIdx < 0) continue;
      const value = pair.slice(colonIdx + 1).toLowerCase();
      if (value === sw) return row.sw as string;
    }
  }
  return null;
}

export async function lookupWord(rawToken: string): Promise<DictionaryResult> {
  const emptyResult = (matchKind: DictionaryMatchKind): DictionaryResult => ({
    query: rawToken,
    normalized: normalizeLookupToken(rawToken),
    lemma: null,
    matchKind,
    entries: [],
  });

  let db: any;
  try {
    db = await openDictionaryDb();
  } catch (e) {
    console.error('[Dictionary] openDictionaryDb failed:', e);
    return emptyResult('none');
  }
  if (!db) {
    console.warn('[Dictionary] db is null (web platform or init failed)');
    return emptyResult('none');
  }

  const normalized = normalizeLookupToken(rawToken);
  if (!normalized) return emptyResult('none');

  let entries: DictionaryEntry[] = [];
  let matchKind: DictionaryMatchKind = 'none';
  let resolvedLemma: string | null = null;

  // Step 1: 精确查 word 字段（COLLATE NOCASE 兼容大小写变体）
  entries = await fetchByWord(db, normalized);
  if (entries.length > 0) {
    matchKind = entries[0].word === rawToken ? 'exact' : 'normalized';
  }

  // Step 2: 形变回退 — 在 exchange 字符串里找 surface → lemma
  if (entries.length === 0) {
    resolvedLemma = await resolveFormLemma(db, normalized);
    if (resolvedLemma && resolvedLemma !== normalized) {
      entries = await fetchByWord(db, resolvedLemma);
      if (entries.length > 0) matchKind = 'form';
    }
  }

  if (entries.length === 0) {
    console.log(`[Dictionary] no match for "${rawToken}" (normalized: "${normalized}")`);
    return emptyResult('none');
  }

  entries = sortEntries(entries);
  console.log(
    `[Dictionary] matched ${entries.length} entries for "${rawToken}" (kind=${matchKind}):`,
    entries.slice(0, 3).map((e) => `${e.word}[${e.pos}]/c${e.collins}`).join(', '),
  );

  return {
    query: rawToken,
    normalized,
    lemma: resolvedLemma ?? entries[0].lemma,
    matchKind,
    entries,
  };
}
