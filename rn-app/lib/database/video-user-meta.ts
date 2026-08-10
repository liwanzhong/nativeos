/**
 * Per-scene user meta — SQLite-backed (v4).
 *
 * Source of truth: video_user_meta table.
 * Replaces the legacy `video_user_meta_v1` AsyncStorage store.
 *
 * Each scene is one row. updatedAt is bumped on every write.
 *
 * See docs/2026-08-05-storage-migration-plan.md.
 */

import { getDatabase } from './schema';

export interface VideoUserMetaRecord {
  sceneId: string;
  isFavorite?: boolean;
  favoritedAt?: number;
  lastPracticedAt?: number;
  updatedAt: number;
}

function rowToRecord(row: any): VideoUserMetaRecord {
  return {
    sceneId: row.scene_id,
    isFavorite: row.is_favorite === 1 ? true : undefined,
    favoritedAt: row.favorited_at ?? undefined,
    lastPracticedAt: row.last_practiced_at ?? undefined,
    updatedAt: row.updated_at,
  };
}

export async function listVideoUserMeta(): Promise<VideoUserMetaRecord[]> {
  const db = await getDatabase();
  const rows: any[] = await db.getAllAsync(
    'SELECT * FROM video_user_meta ORDER BY updated_at DESC',
  );
  return rows.map(rowToRecord);
}

export async function getVideoUserMeta(sceneId: string): Promise<VideoUserMetaRecord | null> {
  const db = await getDatabase();
  const row: any = await db.getFirstAsync(
    'SELECT * FROM video_user_meta WHERE scene_id = ?',
    [sceneId],
  );
  return row ? rowToRecord(row) : null;
}

export async function markVideoScenePracticed(
  sceneId: string,
  practicedAt: number = Date.now(),
): Promise<VideoUserMetaRecord> {
  const db = await getDatabase();
  const existing = await getVideoUserMeta(sceneId);
  const next: VideoUserMetaRecord = {
    ...(existing ?? { sceneId, updatedAt: practicedAt }),
    sceneId,
    lastPracticedAt: practicedAt,
    updatedAt: practicedAt,
  };
  await db.runAsync(
    `INSERT OR REPLACE INTO video_user_meta (
      scene_id, is_favorite, favorited_at, last_practiced_at, updated_at
    ) VALUES (?, ?, ?, ?, ?)`,
    [
      sceneId,
      next.isFavorite ? 1 : 0,
      next.favoritedAt ?? null,
      next.lastPracticedAt ?? null,
      next.updatedAt,
    ],
  );
  return next;
}

export async function setVideoSceneFavorite(
  sceneId: string,
  isFavorite: boolean,
  operatedAt: number = Date.now(),
): Promise<VideoUserMetaRecord> {
  const db = await getDatabase();
  const existing = await getVideoUserMeta(sceneId);
  const next: VideoUserMetaRecord = {
    ...(existing ?? { sceneId, updatedAt: operatedAt }),
    sceneId,
    isFavorite,
    favoritedAt: isFavorite ? (existing?.favoritedAt ?? operatedAt) : undefined,
    updatedAt: operatedAt,
  };
  await db.runAsync(
    `INSERT OR REPLACE INTO video_user_meta (
      scene_id, is_favorite, favorited_at, last_practiced_at, updated_at
    ) VALUES (?, ?, ?, ?, ?)`,
    [
      sceneId,
      next.isFavorite ? 1 : 0,
      next.favoritedAt ?? null,
      next.lastPracticedAt ?? null,
      next.updatedAt,
    ],
  );
  return next;
}

export async function toggleVideoSceneFavorite(sceneId: string): Promise<VideoUserMetaRecord> {
  const current = await getVideoUserMeta(sceneId);
  return setVideoSceneFavorite(sceneId, !current?.isFavorite);
}
