/**
 * OSS catalog + per-scene info cache — SQLite-backed (v5).
 *
 * Replaces the in-memory `manifestCache` in video-scenes.ts and adds
 * persistence so cold starts are < 200 ms instead of 1 s+.
 *
 * Two tables:
 *   - oss_video_catalog : the top-level manifest blob + ETag
 *   - video_scene_info  : per-scene info.json + built-in ai practice cards
 *
 * On a network fetch, the caller passes the ETag/Last-Modified it had
 * to the remote URL via If-None-Match / If-Modified-Since. A 304
 * response means "use the existing row, no body needed".
 *
 * All writes are conservative: on any failure we keep the old row so
 * the app never loses its cache.
 */

import { getDatabase } from './schema';

// ── Catalog (top-level manifest) ──────────────────────────────────

export interface CachedCatalog {
  key: string;
  bucketBaseUrl: string;
  manifest: any;       // parsed JSON
  manifestJson: string; // raw JSON (for re-write without re-parse)
  etag: string | null;
  lastModified: string | null;
  fetchedAt: number;
}

interface CatalogRow {
  key: string;
  bucket_base_url: string;
  manifest_json: string;
  etag: string | null;
  last_modified: string | null;
  fetched_at: number;
}

function rowToCatalog(row: CatalogRow): CachedCatalog {
  return {
    key: row.key,
    bucketBaseUrl: row.bucket_base_url,
    manifest: JSON.parse(row.manifest_json),
    manifestJson: row.manifest_json,
    etag: row.etag,
    lastModified: row.last_modified,
    fetchedAt: row.fetched_at,
  };
}

export async function loadCatalogCache(key: string): Promise<CachedCatalog | null> {
  const db = await getDatabase();
  const row: CatalogRow | null = await db.getFirstAsync(
    'SELECT * FROM oss_video_catalog WHERE key = ?',
    [key],
  );
  if (!row) return null;
  try {
    return rowToCatalog(row);
  } catch {
    // Corrupt JSON — wipe so the next fetch repopulates cleanly.
    await db.runAsync('DELETE FROM oss_video_catalog WHERE key = ?', [key]);
    return null;
  }
}

export async function saveCatalogCache(params: {
  key: string;
  bucketBaseUrl: string;
  manifest: any;
  etag?: string | null;
  lastModified?: string | null;
}): Promise<void> {
  const db = await getDatabase();
  const manifestJson = JSON.stringify(params.manifest);
  await db.runAsync(
    `INSERT OR REPLACE INTO oss_video_catalog (
      key, bucket_base_url, manifest_json, etag, last_modified, fetched_at
    ) VALUES (?, ?, ?, ?, ?, ?)`,
    [
      params.key,
      params.bucketBaseUrl,
      manifestJson,
      params.etag ?? null,
      params.lastModified ?? null,
      Date.now(),
    ],
  );
}

// ── Per-scene info.json + built-in ai practice cards ─────────────

export interface CachedSceneInfo {
  sceneId: string;
  assetBaseUrl: string;
  info: any | null;
  infoJson: string | null;
  aiPracticeCards: any[] | null;
  aiPracticeCardsJson: string | null;
  etag: string | null;
  lastModified: string | null;
  fetchedAt: number;
  parseError: string | null;
}

interface SceneInfoRow {
  scene_id: string;
  asset_base_url: string;
  info_json: string | null;
  ai_practice_cards_json: string | null;
  etag: string | null;
  last_modified: string | null;
  fetched_at: number;
  parse_error: string | null;
}

function rowToSceneInfo(row: SceneInfoRow): CachedSceneInfo {
  let info: any | null = null;
  if (row.info_json) {
    try { info = JSON.parse(row.info_json); } catch { /* keep null */ }
  }
  let cards: any[] | null = null;
  if (row.ai_practice_cards_json) {
    try { cards = JSON.parse(row.ai_practice_cards_json); } catch { /* keep null */ }
  }
  return {
    sceneId: row.scene_id,
    assetBaseUrl: row.asset_base_url,
    info,
    infoJson: row.info_json,
    aiPracticeCards: cards,
    aiPracticeCardsJson: row.ai_practice_cards_json,
    etag: row.etag,
    lastModified: row.last_modified,
    fetchedAt: row.fetched_at,
    parseError: row.parse_error,
  };
}

export async function loadSceneInfoCache(sceneId: string): Promise<CachedSceneInfo | null> {
  const db = await getDatabase();
  const row: SceneInfoRow | null = await db.getFirstAsync(
    'SELECT * FROM video_scene_info WHERE scene_id = ?',
    [sceneId],
  );
  return row ? rowToSceneInfo(row) : null;
}

export async function loadAllSceneInfoCache(): Promise<CachedSceneInfo[]> {
  const db = await getDatabase();
  const rows: SceneInfoRow[] = await db.getAllAsync(
    'SELECT * FROM video_scene_info',
  );
  return rows.map(rowToSceneInfo);
}

export async function saveSceneInfoCache(params: {
  sceneId: string;
  assetBaseUrl: string;
  info?: any | null;
  aiPracticeCards?: any[] | null;
  etag?: string | null;
  lastModified?: string | null;
  parseError?: string | null;
}): Promise<void> {
  const db = await getDatabase();
  // Read existing row first. INSERT OR REPLACE would otherwise wipe the
  // sibling field on every save: when `loadInfoJson` writes `info_json`,
  // `ai_practice_cards_json` from a previous save gets nulled, and
  // vice versa. After that the next read of the wiped field misses
  // cache and re-fetches the network — turning 1 manifest refresh into
  // 30+30 round-trips. Merging keeps the two fields co-resident.
  const existing: SceneInfoRow | null = await db.getFirstAsync(
    'SELECT * FROM video_scene_info WHERE scene_id = ?',
    [params.sceneId],
  );

  // undefined = caller did not touch this field → keep existing.
  // null     = caller explicitly cleared this field → write null.
  // value    = caller wrote a new value → write JSON.
  const newInfoJson = params.info !== undefined
    ? (params.info !== null ? JSON.stringify(params.info) : null)
    : existing?.info_json ?? null;
  const newCardsJson = params.aiPracticeCards !== undefined
    ? (params.aiPracticeCards !== null ? JSON.stringify(params.aiPracticeCards) : null)
    : existing?.ai_practice_cards_json ?? null;
  const newEtag = params.etag !== undefined ? params.etag : existing?.etag ?? null;
  const newLastModified = params.lastModified !== undefined
    ? params.lastModified
    : existing?.last_modified ?? null;
  const newParseError = params.parseError !== undefined
    ? params.parseError
    : existing?.parse_error ?? null;

  await db.runAsync(
    `INSERT OR REPLACE INTO video_scene_info (
      scene_id, asset_base_url, info_json, ai_practice_cards_json,
      etag, last_modified, fetched_at, parse_error
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      params.sceneId,
      params.assetBaseUrl,
      newInfoJson,
      newCardsJson,
      newEtag,
      newLastModified,
      Date.now(),
      newParseError,
    ],
  );
}

export async function deleteSceneInfoCache(sceneId: string): Promise<void> {
  const db = await getDatabase();
  await db.runAsync('DELETE FROM video_scene_info WHERE scene_id = ?', [sceneId]);
}

export async function listCachedSceneIds(): Promise<string[]> {
  const db = await getDatabase();
  const rows: { scene_id: string }[] = await db.getAllAsync(
    'SELECT scene_id FROM video_scene_info',
  );
  return rows.map((r) => r.scene_id);
}

// ── Staleness helpers (for background refresh) ───────────────────

export async function listStaleSceneIds(
  olderThanMs: number,
  limit: number = 50,
): Promise<string[]> {
  const db = await getDatabase();
  const threshold = Date.now() - olderThanMs;
  const rows: { scene_id: string }[] = await db.getAllAsync(
    `SELECT scene_id FROM video_scene_info
     WHERE fetched_at < ? AND parse_error IS NULL
     ORDER BY fetched_at ASC
     LIMIT ?`,
    [threshold, limit],
  );
  return rows.map((r) => r.scene_id);
}

export async function getCatalogFetchedAt(key: string): Promise<number | null> {
  const db = await getDatabase();
  const row: { fetched_at: number } | null = await db.getFirstAsync(
    'SELECT fetched_at FROM oss_video_catalog WHERE key = ?',
    [key],
  );
  return row?.fetched_at ?? null;
}
