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

/**
 * Home origin — where a topic was added into the user's AI 陪练 home grid.
 *
 * Three sources, unified into one list on the home page:
 *   - from_video_chip: pushed from a video row's "AI 话题" chip in
 *                      collection/[id] (official or user-video AI topics)
 *   - from_recommended: added from the "推荐话题" section of /ai-practice/add
 *                       (officially-picked series' pre-generated topics)
 *   - from_custom:     added from the "自定义话题" generator of /ai-practice/add
 *
 * Legacy 'recommended' / 'video' values are still readable (old data is
 * preserved), but the home page filters them out and only displays the
 * new three sources.
 */
export type AiPracticeHomeOrigin =
  | 'from_video_chip'
  | 'from_recommended'
  | 'from_custom';

export interface AiPracticeTopicSnapshot {
  topicId: string;
  card: any; // ScenarioCard
  origin: 'recommended' | 'video' | AiPracticeHomeOrigin;
  sourceType: 'recommended' | 'official_video' | 'imported_video' | 'video_chip' | 'recommended_topic' | 'custom_topic';
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
  /**
   * Timestamp the user added this topic to their AI 陪练 home.
   * Drives home grid sort order (newest on top). Optional on legacy rows
   * (they fall back to `updated_at` on the SQL side).
   */
  homeAddedAt?: number;
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

// ── Home grid (AI 陪练主页) ─────────────────────────────────────────
// The home page shows topics the user has explicitly added — from
// video chips, the 推荐话题 section of /ai-practice/add, or the 自定义
// generator. These writers do NOT bump `use_count` or `last_used_at`
// (those are reserved for "actually opened the immersive chat").
// `homeAddedAt` is the only field they touch; it lives inside `meta_json`
// so we don't need a schema bump.

export async function addAiTopicToHome(
  snapshot: AiPracticeTopicSnapshot & { homeOrigin: AiPracticeHomeOrigin },
): Promise<void> {
  const db = await getDatabase();
  const enriched: AiPracticeTopicSnapshot = {
    ...snapshot,
    origin: snapshot.homeOrigin,
    sourceType: snapshot.homeOrigin === 'from_video_chip'
      ? 'video_chip'
      : snapshot.homeOrigin === 'from_recommended'
        ? 'recommended_topic'
        : 'custom_topic',
    homeAddedAt: Date.now(),
  };
  // INSERT OR REPLACE: if a row with this topic_id already exists (e.g.
  // user added then removed earlier), we just overwrite the snapshot.
  // We deliberately do NOT change last_used_at / use_count — those are
  // owned by markAiPracticeTopicUsed.
  await db.runAsync(
    `INSERT OR REPLACE INTO ai_practice_user_meta (
      topic_id, is_favorite, favorited_at, last_used_at, use_count,
      meta_json, updated_at
    ) VALUES (?, 0, NULL, NULL, 0, ?, ?)`,
    [snapshot.topicId, JSON.stringify(enriched), Date.now()],
  );
}

export async function removeAiTopicFromHome(topicId: string): Promise<void> {
  const db = await getDatabase();
  await db.runAsync(
    'DELETE FROM ai_practice_user_meta WHERE topic_id = ?',
    [topicId],
  );
}

/**
 * Read home grid topics only — filter out legacy 'recommended' / 'video'
 * rows that pre-date the home-page redesign. The result is sorted by
 * `homeAddedAt` desc, falling back to `updated_at` for legacy rows
 * (defensive — should be empty after the first migration).
 */
export async function listHomeAiTopics(): Promise<AiPracticeUserMetaRecord[]> {
  const all = await listAiPracticeUserMeta();
  const HOME_ORIGINS: ReadonlySet<string> = new Set([
    'from_video_chip',
    'from_recommended',
    'from_custom',
  ]);
  return all
    .filter((row) => HOME_ORIGINS.has(String(row.origin)))
    .sort((a, b) => (b.homeAddedAt ?? b.updatedAt ?? 0) - (a.homeAddedAt ?? a.updatedAt ?? 0));
}
