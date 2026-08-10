/**
 * Per-topic user meta — SQLite-backed (v4).
 *
 * Source of truth: ai_practice_user_meta table.
 * Replaces the legacy `ai_practice_user_meta_v1` AsyncStorage store.
 *
 * The full AiPracticeUserMetaRecord is kept as JSON in `meta_json` so
 * we can evolve the snapshot shape (card, sourceLabel, etc.) without
 * a schema bump.
 *
 * The hot fields (is_favorite, use_count) are denormalized into their
 * own columns for cheap ORDER BY and WHERE.
 *
 * See docs/2026-08-05-storage-migration-plan.md.
 */

import { getDatabase } from './schema';

// ── Types ────────────────────────────────────────────────────────────
// Kept loose to avoid a hard dep cycle with ai/scenario-generator.
// The shape mirrors AiPracticeUserMetaRecord in
// lib/ai/ai-practice-user-meta.ts.

export interface AiPracticeTopicSnapshot {
  topicId: string;
  card: any; // ScenarioCard
  origin: 'recommended' | 'video';
  sourceType: 'recommended' | 'official_video' | 'imported_video';
  sourceLabel: string;
  sourceId?: string;
  sceneTitle?: string;
  importSourceLabel?: string;
  title: string;
  level: string;
  category: string;
  icon: string;
  desc?: string;
  descZh?: string;
}

export interface AiPracticeUserMetaRecord extends AiPracticeTopicSnapshot {
  isFavorite?: boolean;
  favoritedAt?: number;
  lastUsedAt?: number;
  useCount: number;
  updatedAt: number;
}

function parseMetaJson(raw: any): any {
  if (typeof raw !== 'string') return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function rowToRecord(row: any): AiPracticeUserMetaRecord {
  const meta = parseMetaJson(row.meta_json);
  return {
    topicId: row.topic_id,
    card: meta.card,
    origin: meta.origin || 'recommended',
    sourceType: meta.sourceType || 'recommended',
    sourceLabel: meta.sourceLabel || '推荐话题',
    sourceId: meta.sourceId,
    sceneTitle: meta.sceneTitle,
    importSourceLabel: meta.importSourceLabel,
    title: meta.title || '',
    level: meta.level || 'B1',
    category: meta.category || '陪练',
    icon: meta.icon || '💬',
    desc: meta.desc,
    descZh: meta.descZh,
    isFavorite: row.is_favorite === 1 ? true : undefined,
    favoritedAt: row.favorited_at ?? undefined,
    lastUsedAt: row.last_used_at ?? undefined,
    useCount: row.use_count ?? 0,
    updatedAt: row.updated_at,
  };
}

export async function listAiPracticeUserMeta(): Promise<AiPracticeUserMetaRecord[]> {
  const db = await getDatabase();
  const rows: any[] = await db.getAllAsync(
    'SELECT * FROM ai_practice_user_meta ORDER BY updated_at DESC',
  );
  return rows.map(rowToRecord);
}

export async function getAiPracticeUserMeta(topicId: string): Promise<AiPracticeUserMetaRecord | null> {
  const db = await getDatabase();
  const row: any = await db.getFirstAsync(
    'SELECT * FROM ai_practice_user_meta WHERE topic_id = ?',
    [topicId],
  );
  return row ? rowToRecord(row) : null;
}

export async function markAiPracticeTopicUsed(
  snapshot: AiPracticeTopicSnapshot,
  usedAt: number = Date.now(),
): Promise<AiPracticeUserMetaRecord> {
  const db = await getDatabase();
  const existing = await getAiPracticeUserMeta(snapshot.topicId);
  const useCount = (existing?.useCount ?? 0) + 1;
  await db.runAsync(
    `INSERT OR REPLACE INTO ai_practice_user_meta (
      topic_id, is_favorite, favorited_at, last_used_at, use_count,
      meta_json, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      snapshot.topicId,
      existing?.isFavorite ? 1 : 0,
      existing?.favoritedAt ?? null,
      usedAt,
      useCount,
      JSON.stringify(snapshot),
      usedAt,
    ],
  );
  return {
    ...snapshot,
    isFavorite: existing?.isFavorite,
    favoritedAt: existing?.favoritedAt,
    lastUsedAt: usedAt,
    useCount,
    updatedAt: usedAt,
  };
}

export async function setAiPracticeTopicFavorite(
  snapshot: AiPracticeTopicSnapshot,
  isFavorite: boolean,
  operatedAt: number = Date.now(),
): Promise<AiPracticeUserMetaRecord> {
  const db = await getDatabase();
  const existing = await getAiPracticeUserMeta(snapshot.topicId);
  await db.runAsync(
    `INSERT OR REPLACE INTO ai_practice_user_meta (
      topic_id, is_favorite, favorited_at, last_used_at, use_count,
      meta_json, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      snapshot.topicId,
      isFavorite ? 1 : 0,
      isFavorite ? (existing?.favoritedAt ?? operatedAt) : null,
      existing?.lastUsedAt ?? null,
      existing?.useCount ?? 0,
      JSON.stringify(snapshot),
      operatedAt,
    ],
  );
  return {
    ...snapshot,
    lastUsedAt: existing?.lastUsedAt,
    useCount: existing?.useCount ?? 0,
    isFavorite,
    favoritedAt: isFavorite ? (existing?.favoritedAt ?? operatedAt) : undefined,
    updatedAt: operatedAt,
  };
}

export async function toggleAiPracticeTopicFavorite(
  snapshot: AiPracticeTopicSnapshot,
): Promise<AiPracticeUserMetaRecord> {
  const current = await getAiPracticeUserMeta(snapshot.topicId);
  return setAiPracticeTopicFavorite(snapshot, !current?.isFavorite);
}
