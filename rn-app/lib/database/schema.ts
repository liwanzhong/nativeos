/**
 * SQLite Database Schema with FTS5 Support
 * Core storage engine for NativeOS (PRD requirement: no vector DB)
 *
 * Schema versions:
 *   v1: legacy (user_contexts, clusters, confusable_pairs, user_profile)
 *   v2: clean (learning_cards, fsrs_reviews) — current for cards
 *   v3: +8 tables for migrated AsyncStorage stores (cloud bindings,
 *       chat sessions/turns, video AI practice cards/state) — see
 *       docs/2026-08-05-storage-migration-plan.md
 *   v4: +2 tables for per-scene / per-topic user meta (video_user_meta,
 *       ai_practice_user_meta) — P1 of the migration plan
 *   v5: +2 tables for OSS manifest + per-scene info.json SQLite cache
 *       (with ETag/Last-Modified for conditional GET)
 *
 * Native-only. The web platform has no real SQLite (see
 * expo-sqlite-mock.ts); the migration code runs unconditionally and is
 * a no-op there.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SQLite from 'expo-sqlite';

const DB_NAME = 'nativeos.db';
const SCHEMA_VERSION = 6;
// Bump SCHEMA_VERSION + add a `migrateToV{N+1}` step to evolve the schema.

let _db: any = null;
let _initPromise: Promise<any> | null = null;

export async function initDatabase(): Promise<any> {
  if (_db) return _db;
  if (_initPromise) return _initPromise;

  _initPromise = (async () => {
    const db = await SQLite.openDatabaseAsync(DB_NAME);
    await db.execAsync(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
    `);
    await migrateToV2(db);
    await migrateToV3(db);
    await migrateToV4(db);
    await migrateToV5(db);
    await migrateToV6(db);
    _db = db;
    return db;
  })();

  return _initPromise;
}

async function createTables(db: any) {
  await db.execAsync(`
    -- Cards table (4 fixed templates: word/sentence × video/ai_practice)
    CREATE TABLE IF NOT EXISTS learning_cards (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,             -- 'word' | 'sentence'
      source TEXT NOT NULL,           -- 'video' | 'ai_practice'
      content TEXT NOT NULL,          -- 单词 or 句子
      translation TEXT NOT NULL,      -- 中文翻译
      notes TEXT,                     -- 用户自填笔记 (optional)
      video_context TEXT,             -- JSON: {videoId, sceneId, segmentId, startMs, endMs, coverUri}
      practice_context TEXT,          -- JSON: {topicId, userSaid}
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_cards_source_created
      ON learning_cards(source, created_at DESC);

    -- FSRS review state (ts-fsrs scheduler)
    CREATE TABLE IF NOT EXISTS fsrs_reviews (
      card_id TEXT PRIMARY KEY,
      difficulty REAL DEFAULT 5.0,
      stability REAL DEFAULT 1.0,
      elapsed_days INTEGER DEFAULT 0,
      scheduled_days INTEGER DEFAULT 1,
      reps INTEGER DEFAULT 0,
      lapses INTEGER DEFAULT 0,
      state INTEGER DEFAULT 0,
      last_review INTEGER,
      due INTEGER NOT NULL,
      FOREIGN KEY (card_id) REFERENCES learning_cards(id) ON DELETE CASCADE
    );

    -- ── v3: migrated AsyncStorage stores (P0) ─────────────────────────

    -- Generic key-value config: OAuth token, app config, default provider.
    -- Each value is a JSON-serialized object.
    CREATE TABLE IF NOT EXISTS app_config (
      key TEXT PRIMARY KEY,
      value_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );

    -- Per-scene user-selected cloud provider.
    CREATE TABLE IF NOT EXISTS scene_provider_selection (
      scene_id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );

    -- Per (scene, provider) download metadata. Replaces the
    -- downloadedSceneSources array inside @cloud_drive_bindings_v1.
    CREATE TABLE IF NOT EXISTS downloaded_scene_source (
      scene_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      local_video_uri TEXT,
      target_file_uri TEXT,
      remote_path TEXT,
      remote_url TEXT,
      remote_url_resolved_at TEXT,
      resume_data TEXT,
      total_bytes_written INTEGER,
      total_bytes_expected_to_write INTEGER,
      speed_bytes_per_second REAL,
      status TEXT NOT NULL,           -- 'idle'|'resolving'|'downloading'|'paused'|'completed'|'error'
      progress REAL NOT NULL DEFAULT 0,
      error_message TEXT,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (scene_id, provider)
    );
    CREATE INDEX IF NOT EXISTS idx_dss_status ON downloaded_scene_source(status);

    -- Per (scene, provider) sync state for official content on cloud drives.
    CREATE TABLE IF NOT EXISTS official_scene_sync_record (
      scene_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      official_video_key TEXT NOT NULL,
      synced_official_video_key TEXT,
      remote_path TEXT,
      remote_file_id INTEGER,
      binding_type TEXT,              -- 'scanned'|'manual'
      status TEXT NOT NULL,           -- 'not_synced'|'available'|'stale'|'error'
      error_message TEXT,
      last_checked_at TEXT NOT NULL,
      PRIMARY KEY (scene_id, provider)
    );
    CREATE INDEX IF NOT EXISTS idx_ossr_status ON official_scene_sync_record(status);

    -- Chat session header. Transcript is split into chat_turns so
    -- appendTurn() is O(1) instead of rewriting the whole array.
    CREATE TABLE IF NOT EXISTS chat_sessions (
      session_id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      scenario_id TEXT NOT NULL,
      scenario_title TEXT NOT NULL,
      status TEXT NOT NULL,           -- 'active'|'completed'
      created_at INTEGER NOT NULL,
      completed_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_cs_status_completed
      ON chat_sessions(status, completed_at DESC);

    CREATE TABLE IF NOT EXISTS chat_turns (
      session_id TEXT NOT NULL,
      turn_seq INTEGER NOT NULL,      -- 0-based, ascending
      role TEXT NOT NULL,             -- 'npc'|'user'
      text TEXT NOT NULL,
      ts INTEGER NOT NULL,
      PRIMARY KEY (session_id, turn_seq),
      FOREIGN KEY (session_id) REFERENCES chat_sessions(session_id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_turns_session ON chat_turns(session_id, turn_seq);

    -- Per-scene AI practice cards. cards_json is a full ScenarioCard JSON.
    CREATE TABLE IF NOT EXISTS video_ai_practice_card (
      scene_id TEXT NOT NULL,
      position INTEGER NOT NULL,      -- 0-based
      card_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (scene_id, position)
    );
    CREATE INDEX IF NOT EXISTS idx_vapc_scene ON video_ai_practice_card(scene_id);

    -- Per-scene AI practice generation state. Combines the old
    -- generated_video_ai_practice_generation_state_v1 store and the
    -- in-memory stream buffer into one consistent row.
    CREATE TABLE IF NOT EXISTS video_ai_practice_state (
      scene_id TEXT PRIMARY KEY,
      status TEXT NOT NULL,           -- 'idle'|'generating'|'completed'|'failed'
      progress_text TEXT NOT NULL,
      parsed_count INTEGER NOT NULL DEFAULT 0,
      target_count INTEGER NOT NULL DEFAULT 0,
      cards_json TEXT NOT NULL,       -- accumulated cards (text JSON)
      error_message TEXT,
      updated_at INTEGER NOT NULL
    );

    -- ── v4: P1 migration targets ───────────────────────────────────

    -- Per-scene user meta: favorite + last practiced. Replaces
    -- the video_user_meta_v1 AsyncStorage store.
    CREATE TABLE IF NOT EXISTS video_user_meta (
      scene_id TEXT PRIMARY KEY,
      is_favorite INTEGER NOT NULL DEFAULT 0,
      favorited_at INTEGER,
      last_practiced_at INTEGER,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_vum_favorite
      ON video_user_meta(is_favorite, updated_at DESC);

    -- Per-topic user meta: favorite + use count. Replaces the
    -- ai_practice_user_meta_v1 AsyncStorage store.
    -- AiPracticeUserMetaRecord is kept as JSON in meta_json.
    CREATE TABLE IF NOT EXISTS ai_practice_user_meta (
      topic_id TEXT PRIMARY KEY,
      is_favorite INTEGER NOT NULL DEFAULT 0,
      favorited_at INTEGER,
      last_used_at INTEGER,
      use_count INTEGER NOT NULL DEFAULT 0,
      meta_json TEXT NOT NULL,         -- full snapshot (card, sourceLabel, etc.)
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_apum_favorite
      ON ai_practice_user_meta(is_favorite, updated_at DESC);

    -- v5: OSS catalog + per-scene info cache (with ETag)
    -- Cold-start < 200ms + detect remote updates via
    -- If-None-Match / If-Modified-Since.

    -- Top-level OSS video catalog. We keep the full JSON blob;
    -- the ETag is what lets us cheaply check "did anything change?".
    CREATE TABLE IF NOT EXISTS oss_video_catalog (
      key TEXT PRIMARY KEY,
      bucket_base_url TEXT NOT NULL,
      manifest_json TEXT NOT NULL,
      etag TEXT,
      last_modified TEXT,
      fetched_at INTEGER NOT NULL
    );

    -- Per-scene info.json + built-in ai practice cards.
    CREATE TABLE IF NOT EXISTS video_scene_info (
      scene_id TEXT PRIMARY KEY,
      asset_base_url TEXT NOT NULL,
      info_json TEXT,
      ai_practice_cards_json TEXT,
      etag TEXT,
      last_modified TEXT,
      fetched_at INTEGER NOT NULL,
      parse_error TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_vsi_fetched
      ON video_scene_info(fetched_at DESC);

    -- ── v6: 官方预生成 AI practice cards 缓存 ────────────────────────
    -- Cache for Supabase official_video_ai_practice rows. Replaces
    -- N-times-per-page round-trips with 1 batch fetch + local lookup.
    -- Single source of truth for the recommend page; refreshed in bulk
    -- when the cache expires or is invalidated.
    CREATE TABLE IF NOT EXISTS official_ai_practice_card_cache (
      id TEXT PRIMARY KEY,                 -- supabase row.id (UUID)
      series_id TEXT NOT NULL,
      episode_id TEXT NOT NULL,
      card_index INTEGER NOT NULL,
      card_json TEXT NOT NULL,             -- full SupabaseAiPracticeRow JSON
      fetched_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_oai_cache_series
      ON official_ai_practice_card_cache(series_id);
    CREATE INDEX IF NOT EXISTS idx_oai_cache_episode
      ON official_ai_practice_card_cache(episode_id);
    CREATE INDEX IF NOT EXISTS idx_oai_cache_fetched
      ON official_ai_practice_card_cache(fetched_at DESC);
  `);
}

// No FTS — full-text search on cards not in scope. Keep it simple.
async function createFTSIndexes(_db: any) {
  // intentionally empty
}

export async function getDatabase(): Promise<any> {
  return initDatabase();
}

export async function getSchemaVersion(): Promise<number> {
  const db = await getDatabase();
  const row: any = await db.getFirstAsync('PRAGMA user_version');
  return typeof row?.user_version === 'number' ? row.user_version : 0;
}

/**
 * Close the current DB connection (if any) and clear the cached handle.
 * Used by the restore flow so we can replace the underlying file on disk
 * before the next getDatabase() call lazily re-opens it.
 */
export async function closeDatabase(): Promise<void> {
  if (_db) {
    try {
      await _db.closeAsync();
    } catch (e) {
      console.warn('[schema] closeAsync failed:', e);
    }
    _db = null;
  }
  _initPromise = null;
}

export async function resetDatabase(): Promise<void> {
  const db = await getDatabase();

  await db.execAsync(`
    DROP TABLE IF EXISTS official_ai_practice_card_cache;
    DROP TABLE IF EXISTS video_ai_practice_state;
    DROP TABLE IF EXISTS video_ai_practice_card;
    DROP TABLE IF EXISTS chat_turns;
    DROP TABLE IF EXISTS chat_sessions;
    DROP TABLE IF EXISTS official_scene_sync_record;
    DROP TABLE IF EXISTS downloaded_scene_source;
    DROP TABLE IF EXISTS scene_provider_selection;
    DROP TABLE IF EXISTS app_config;
    DROP TABLE IF EXISTS fsrs_reviews;
    DROP TABLE IF EXISTS learning_cards;
  `);

  await createTables(db);
  await createFTSIndexes(db);
  await db.execAsync(`PRAGMA user_version = ${SCHEMA_VERSION}`);
}

/**
 * One-shot migration from the old bloated schema to the new clean one.
 * Drops user_contexts / clusters / confusable_pairs / user_profile and any
 * legacy learning_cards columns we no longer need. Old cards are discarded
 * by design (the user explicitly opted into a clean slate).
 *
 * NOTE: must accept `db` directly — calling getDatabase() here would deadlock
 * with initDatabase() (which itself calls migrateToV2 before setting _db).
 */
export async function migrateToV2(db: any): Promise<void> {
  // Drop everything that doesn't belong to the v2 schema.
  await db.execAsync(`
    DROP TABLE IF EXISTS user_contexts_fts;
    DROP TABLE IF EXISTS user_contexts;
    DROP TABLE IF EXISTS clusters;
    DROP TABLE IF EXISTS confusable_pairs;
    DROP TABLE IF EXISTS user_profile;
  `);

  // Re-create learning_cards with the v2 shape if it still has the old shape.
  const row: any = await db.getFirstAsync(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='learning_cards'",
  );
  if (row) {
    const cols: any[] = await db.getAllAsync('PRAGMA table_info(learning_cards)');
    const names = new Set(cols.map((c) => c.name));
    if (names.has('target_word') || names.has('cluster_id')) {
      await db.execAsync(`
        DROP TABLE IF EXISTS fsrs_reviews;
        DROP TABLE learning_cards;
      `);
    }
  }

  await createTables(db);
  await createFTSIndexes(db);
}

// Old AsyncStorage keys to migrate (see docs/2026-08-05-storage-migration-plan.md)
const LEGACY_ASYNC_KEYS = {
  // v3 (P0)
  cloudBindings: '@cloud_drive_bindings_v1',
  chatSessions: 'chat_sessions',
  videoAiCards: 'generated_video_ai_practice_v1',
  videoAiState: 'generated_video_ai_practice_generation_state_v1',
  // v4 (P1)
  videoUserMeta: 'video_user_meta_v1',
  aiPracticeUserMeta: 'ai_practice_user_meta_v1',
} as const;

/**
 * v3: Migrate 4 legacy AsyncStorage JSON stores into the new v3 tables.
 * Runs once per DB. After successful migration the AsyncStorage keys are
 * removed. On any per-key failure the old data is preserved as a fallback
 * (logged but not thrown) so the user never loses state.
 */
export async function migrateToV3(db: any): Promise<void> {
  // 0. Schema version gate. PRAGMA user_version starts at 0.
  const versionRow: any = await db.getFirstAsync('PRAGMA user_version');
  const currentVersion = typeof versionRow?.user_version === 'number' ? versionRow.user_version : 0;
  if (currentVersion >= 3) return;

  // Make sure all v3 tables exist (idempotent — also covers fresh DBs
  // where v2 ran but no cards exist yet).
  await createTables(db);
  await createFTSIndexes(db);

  // 1. Migrate @cloud_drive_bindings_v1 → app_config + scene_provider_selection +
  //    downloaded_scene_source + official_scene_sync_record
  await migrateCloudBindings(db);

  // 2. Migrate chat_sessions → chat_sessions + chat_turns
  await migrateChatSessions(db);

  // 3. Migrate generated_video_ai_practice_v1 → video_ai_practice_card
  await migrateVideoAiCards(db);

  // 4. Migrate generated_video_ai_practice_generation_state_v1 → video_ai_practice_state
  await migrateVideoAiState(db);

  await db.execAsync('PRAGMA user_version = 3');
}

/**
 * v4: Migrate 2 small per-row AsyncStorage stores (P1) into single-row
 * tables. Same shape as v3 (transactional, safe on failure). Also stamps
 * user_version = 4.
 */
export async function migrateToV4(db: any): Promise<void> {
  const versionRow: any = await db.getFirstAsync('PRAGMA user_version');
  const currentVersion = typeof versionRow?.user_version === 'number' ? versionRow.user_version : 0;
  if (currentVersion >= 4) return;

  // Tables may not exist yet on a v3-only DB — createTables is idempotent.
  await createTables(db);
  await createFTSIndexes(db);

  await migrateVideoUserMeta(db);
  await migrateAiPracticeUserMeta(db);

  await db.execAsync('PRAGMA user_version = 4');
}

/**
 * v5: Add OSS catalog + per-scene info cache tables. No AsyncStorage
 * data to move (these caches only existed as in-memory state). The
 * cache will be populated lazily on first network fetch.
 */
export async function migrateToV5(db: any): Promise<void> {
  const versionRow: any = await db.getFirstAsync('PRAGMA user_version');
  const currentVersion = typeof versionRow?.user_version === 'number' ? versionRow.user_version : 0;
  if (currentVersion >= 5) return;

  await createTables(db);
  await createFTSIndexes(db);

  await db.execAsync('PRAGMA user_version = 5');
}

/**
 * v6: Add `official_ai_practice_card_cache` table — the local cache
 * for the Supabase `official_video_ai_practice` rows. The recommend
 * page reads from this table instead of issuing N round-trips.
 */
export async function migrateToV6(db: any): Promise<void> {
  const versionRow: any = await db.getFirstAsync('PRAGMA user_version');
  const currentVersion = typeof versionRow?.user_version === 'number' ? versionRow.user_version : 0;
  if (currentVersion >= 6) return;

  await createTables(db);
  await createFTSIndexes(db);

  await db.execAsync('PRAGMA user_version = 6');
}

async function safeRemoveAsyncKey(key: string): Promise<void> {
  try {
    await AsyncStorage.removeItem(key);
  } catch (e) {
    console.warn(`[migrateToV3] failed to remove legacy key ${key}:`, e);
  }
}

async function migrateCloudBindings(db: any): Promise<void> {
  const KEY = LEGACY_ASYNC_KEYS.cloudBindings;
  let raw: string | null = null;
  try {
    raw = await AsyncStorage.getItem(KEY);
  } catch (e) {
    console.warn('[migrateToV3] failed to read', KEY, e);
    return;
  }
  if (!raw) return;

  type Legacy = {
    version: number;
    baiduPan: any | null;
    baiduPanAppConfig: any | null;
    defaultProvider: string | null;
    selectedProviderBySceneId: Record<string, string>;
    downloadedSceneSources: any[];
    officialSceneSyncRecords: any[];
  };

  let parsed: Legacy;
  try {
    parsed = JSON.parse(raw) as Legacy;
  } catch (e) {
    console.warn('[migrateToV3] failed to parse', KEY, e);
    return;
  }

  const now = Date.now();
  try {
    await db.execAsync('BEGIN');
    if (parsed.baiduPan) {
      await db.runAsync(
        'INSERT OR REPLACE INTO app_config (key, value_json, updated_at) VALUES (?, ?, ?)',
        ['baiduPanBinding', JSON.stringify(parsed.baiduPan), now],
      );
    }
    if (parsed.baiduPanAppConfig) {
      await db.runAsync(
        'INSERT OR REPLACE INTO app_config (key, value_json, updated_at) VALUES (?, ?, ?)',
        ['baiduPanAppConfig', JSON.stringify(parsed.baiduPanAppConfig), now],
      );
    }
    if (parsed.defaultProvider) {
      await db.runAsync(
        'INSERT OR REPLACE INTO app_config (key, value_json, updated_at) VALUES (?, ?, ?)',
        ['defaultProvider', JSON.stringify(parsed.defaultProvider), now],
      );
    }
    for (const [sceneId, provider] of Object.entries(parsed.selectedProviderBySceneId || {})) {
      await db.runAsync(
        'INSERT OR REPLACE INTO scene_provider_selection (scene_id, provider, updated_at) VALUES (?, ?, ?)',
        [sceneId, provider, now],
      );
    }
    for (const entry of parsed.downloadedSceneSources || []) {
      if (!entry?.sceneId || !entry?.provider) continue;
      await db.runAsync(
        `INSERT OR REPLACE INTO downloaded_scene_source (
          scene_id, provider, local_video_uri, target_file_uri, remote_path,
          remote_url, remote_url_resolved_at, resume_data,
          total_bytes_written, total_bytes_expected_to_write, speed_bytes_per_second,
          status, progress, error_message, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          entry.sceneId, entry.provider, entry.localVideoUri ?? null, entry.targetFileUri ?? null,
          entry.remotePath ?? null, entry.remoteUrl ?? null, entry.remoteUrlResolvedAt ?? null,
          entry.resumeData ?? null,
          entry.totalBytesWritten ?? null, entry.totalBytesExpectedToWrite ?? null,
          entry.speedBytesPerSecond ?? null,
          entry.status ?? 'idle', entry.progress ?? 0, entry.errorMessage ?? null,
          entry.updatedAt ?? new Date().toISOString(),
        ],
      );
    }
    for (const entry of parsed.officialSceneSyncRecords || []) {
      if (!entry?.sceneId || !entry?.provider || !entry?.officialVideoKey) continue;
      await db.runAsync(
        `INSERT OR REPLACE INTO official_scene_sync_record (
          scene_id, provider, official_video_key, synced_official_video_key,
          remote_path, remote_file_id, binding_type, status,
          error_message, last_checked_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          entry.sceneId, entry.provider, entry.officialVideoKey,
          entry.syncedOfficialVideoKey ?? null,
          entry.remotePath ?? null, entry.remoteFileId ?? null,
          entry.bindingType ?? null, entry.status ?? 'not_synced',
          entry.errorMessage ?? null, entry.lastCheckedAt ?? new Date().toISOString(),
        ],
      );
    }
    await db.execAsync('COMMIT');
    await safeRemoveAsyncKey(KEY);
  } catch (e) {
    console.warn('[migrateToV3] cloud-bindings migration failed:', e);
    try { await db.execAsync('ROLLBACK'); } catch { /* ignore */ }
  }
}

async function migrateChatSessions(db: any): Promise<void> {
  const KEY = LEGACY_ASYNC_KEYS.chatSessions;
  let raw: string | null = null;
  try {
    raw = await AsyncStorage.getItem(KEY);
  } catch (e) {
    console.warn('[migrateToV3] failed to read', KEY, e);
    return;
  }
  if (!raw) return;

  type LegacyTurn = { role: 'npc' | 'user'; text: string; ts: number };
  type LegacySession = {
    session_id: string;
    user_id: string;
    scenario_id: string;
    scenario_title: string;
    status: 'active' | 'completed';
    transcript: LegacyTurn[];
    created_at: number;
    completed_at: number | null;
  };

  let parsed: LegacySession[];
  try {
    parsed = JSON.parse(raw) as LegacySession[];
  } catch (e) {
    console.warn('[migrateToV3] failed to parse', KEY, e);
    return;
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    await safeRemoveAsyncKey(KEY);
    return;
  }

  try {
    await db.execAsync('BEGIN');
    for (const s of parsed) {
      if (!s?.session_id) continue;
      await db.runAsync(
        `INSERT OR REPLACE INTO chat_sessions (
          session_id, user_id, scenario_id, scenario_title, status, created_at, completed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          s.session_id, s.user_id || 'local', s.scenario_id || '', s.scenario_title || '',
          s.status || 'active', s.created_at || Date.now(), s.completed_at ?? null,
        ],
      );
      const turns = Array.isArray(s.transcript) ? s.transcript : [];
      for (let i = 0; i < turns.length; i += 1) {
        const t = turns[i];
        if (!t) continue;
        await db.runAsync(
          `INSERT OR REPLACE INTO chat_turns (session_id, turn_seq, role, text, ts) VALUES (?, ?, ?, ?, ?)`,
          [s.session_id, i, t.role || 'user', t.text || '', t.ts || Date.now()],
        );
      }
    }
    await db.execAsync('COMMIT');
    await safeRemoveAsyncKey(KEY);
  } catch (e) {
    console.warn('[migrateToV3] chat_sessions migration failed:', e);
    try { await db.execAsync('ROLLBACK'); } catch { /* ignore */ }
  }
}

async function migrateVideoAiCards(db: any): Promise<void> {
  const KEY = LEGACY_ASYNC_KEYS.videoAiCards;
  let raw: string | null = null;
  try {
    raw = await AsyncStorage.getItem(KEY);
  } catch (e) {
    console.warn('[migrateToV3] failed to read', KEY, e);
    return;
  }
  if (!raw) return;

  type Legacy = Record<string, { sceneId: string; generatedAt: number; cards: any[] }>;

  let parsed: Legacy;
  try {
    parsed = JSON.parse(raw) as Legacy;
  } catch (e) {
    console.warn('[migrateToV3] failed to parse', KEY, e);
    return;
  }
  const entries = Object.values(parsed || {}).filter((e) => e?.sceneId);
  if (entries.length === 0) {
    await safeRemoveAsyncKey(KEY);
    return;
  }

  try {
    await db.execAsync('BEGIN');
    for (const entry of entries) {
      const cards = Array.isArray(entry.cards) ? entry.cards : [];
      for (let i = 0; i < cards.length; i += 1) {
        await db.runAsync(
          'INSERT OR REPLACE INTO video_ai_practice_card (scene_id, position, card_json, created_at) VALUES (?, ?, ?, ?)',
          [entry.sceneId, i, JSON.stringify(cards[i]), entry.generatedAt || Date.now()],
        );
      }
    }
    await db.execAsync('COMMIT');
    await safeRemoveAsyncKey(KEY);
  } catch (e) {
    console.warn('[migrateToV3] video-ai-practice cards migration failed:', e);
    try { await db.execAsync('ROLLBACK'); } catch { /* ignore */ }
  }
}

async function migrateVideoAiState(db: any): Promise<void> {
  const KEY = LEGACY_ASYNC_KEYS.videoAiState;
  let raw: string | null = null;
  try {
    raw = await AsyncStorage.getItem(KEY);
  } catch (e) {
    console.warn('[migrateToV3] failed to read', KEY, e);
    return;
  }
  if (!raw) return;

  type LegacyState = {
    sceneId: string;
    status: 'idle' | 'generating' | 'completed' | 'failed';
    progressText: string;
    parsedCount: number;
    targetCount: number;
    cards: any[];
    errorMessage?: string;
    updatedAt: number;
  };
  type Legacy = Record<string, LegacyState>;

  let parsed: Legacy;
  try {
    parsed = JSON.parse(raw) as Legacy;
  } catch (e) {
    console.warn('[migrateToV3] failed to parse', KEY, e);
    return;
  }
  const entries = Object.values(parsed || {}).filter((e) => e?.sceneId);
  if (entries.length === 0) {
    await safeRemoveAsyncKey(KEY);
    return;
  }

  try {
    await db.execAsync('BEGIN');
    for (const s of entries) {
      await db.runAsync(
        `INSERT OR REPLACE INTO video_ai_practice_state (
          scene_id, status, progress_text, parsed_count, target_count,
          cards_json, error_message, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          s.sceneId, s.status || 'idle', s.progressText || '',
          s.parsedCount || 0, s.targetCount || 0,
          JSON.stringify(Array.isArray(s.cards) ? s.cards : []),
          s.errorMessage ?? null, s.updatedAt || Date.now(),
        ],
      );
    }
    await db.execAsync('COMMIT');
    await safeRemoveAsyncKey(KEY);
  } catch (e) {
    console.warn('[migrateToV3] video-ai-practice state migration failed:', e);
    try { await db.execAsync('ROLLBACK'); } catch { /* ignore */ }
  }
}

async function migrateVideoUserMeta(db: any): Promise<void> {
  const KEY = LEGACY_ASYNC_KEYS.videoUserMeta;
  let raw: string | null = null;
  try {
    raw = await AsyncStorage.getItem(KEY);
  } catch (e) {
    console.warn('[migrateToV4] failed to read', KEY, e);
    return;
  }
  if (!raw) return;

  type Legacy = Record<string, {
    sceneId: string;
    isFavorite?: boolean;
    favoritedAt?: number;
    lastPracticedAt?: number;
    updatedAt: number;
  }>;

  let parsed: Legacy;
  try {
    parsed = JSON.parse(raw) as Legacy;
  } catch (e) {
    console.warn('[migrateToV4] failed to parse', KEY, e);
    return;
  }
  const entries = Object.values(parsed || {}).filter((e) => e?.sceneId);
  if (entries.length === 0) {
    await safeRemoveAsyncKey(KEY);
    return;
  }

  try {
    await db.execAsync('BEGIN');
    for (const r of entries) {
      await db.runAsync(
        `INSERT OR REPLACE INTO video_user_meta (
          scene_id, is_favorite, favorited_at, last_practiced_at, updated_at
        ) VALUES (?, ?, ?, ?, ?)`,
        [
          r.sceneId,
          r.isFavorite ? 1 : 0,
          r.favoritedAt ?? null,
          r.lastPracticedAt ?? null,
          r.updatedAt || Date.now(),
        ],
      );
    }
    await db.execAsync('COMMIT');
    await safeRemoveAsyncKey(KEY);
  } catch (e) {
    console.warn('[migrateToV4] video_user_meta migration failed:', e);
    try { await db.execAsync('ROLLBACK'); } catch { /* ignore */ }
  }
}

async function migrateAiPracticeUserMeta(db: any): Promise<void> {
  const KEY = LEGACY_ASYNC_KEYS.aiPracticeUserMeta;
  let raw: string | null = null;
  try {
    raw = await AsyncStorage.getItem(KEY);
  } catch (e) {
    console.warn('[migrateToV4] failed to read', KEY, e);
    return;
  }
  if (!raw) return;

  type Legacy = Record<string, any>;

  let parsed: Legacy;
  try {
    parsed = JSON.parse(raw) as Legacy;
  } catch (e) {
    console.warn('[migrateToV4] failed to parse', KEY, e);
    return;
  }
  const entries = Object.values(parsed || {}).filter((e) => e?.topicId);
  if (entries.length === 0) {
    await safeRemoveAsyncKey(KEY);
    return;
  }

  try {
    await db.execAsync('BEGIN');
    for (const r of entries) {
      await db.runAsync(
        `INSERT OR REPLACE INTO ai_practice_user_meta (
          topic_id, is_favorite, favorited_at, last_used_at, use_count,
          meta_json, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          r.topicId,
          r.isFavorite ? 1 : 0,
          r.favoritedAt ?? null,
          r.lastUsedAt ?? null,
          typeof r.useCount === 'number' ? r.useCount : 0,
          JSON.stringify(r),
          r.updatedAt || Date.now(),
        ],
      );
    }
    await db.execAsync('COMMIT');
    await safeRemoveAsyncKey(KEY);
  } catch (e) {
    console.warn('[migrateToV4] ai_practice_user_meta migration failed:', e);
    try { await db.execAsync('ROLLBACK'); } catch { /* ignore */ }
  }
}

