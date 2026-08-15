/**
 * Backup/Restore — shared types.
 *
 * Everything the user can see in the items sheet and that gets serialized
 * into manifest.json lives here. BackupItemKind is the stable identifier
 * we persist — never rename a kind in v1; add a new one instead.
 *
 * Designed to survive schema upgrades:
 *   - `version` is the manifest schema version, bump on any breaking change
 *   - `kind` strings are append-only
 *   - `items[]` is filtered by user choice, so the consumer just trusts it
 *
 * v2 (2026-08-14):
 *   - `BACKUP_VERSION` bumped from 1 → 2 (additive: old v1 backups
 *     still restore; v2 just exposes 2 new spec items)
 *   - New `scene_caches` kind: dumps the cold-start cache tables
 *     (`oss_video_catalog`, `video_scene_info`) so re-install /
 *     device migration skips the first-time fetch
 *   - New `cloud_synced` kind: read-only info row showing the user
 *     which data lives in Supabase (我的跟练 / 我的合集 / 官方
 *     目录 / 官方剧集 / 官方 AI 卡片) and is therefore NOT in
 *     the backup
 *   - New `cloudOnly` flag on `BackupItem` — UI renders these as
 *     a separate non-selectable "云端" section
 *   - New `cloud` source for non-DB / non-file / non-AsyncStorage items
 */

export const BACKUP_VERSION = 2;

export type BackupItemKind =
  // SQLite tables (P0)
  | 'cards'              // learning_cards + fsrs_reviews
  | 'chat_history'       // chat_sessions + chat_turns
  | 'ai_practice'        // video_ai_practice_card + video_ai_practice_state (USER-GENERATED)
  | 'favorites'          // video_user_meta + ai_practice_user_meta
  | 'user_profile'       // app_config: user_profile
  | 'quota'              // app_config: quota_config / quota_pro_state / quota_usage_*
  | 'byok'               // app_config: byok_config ⚠️
  | 'cloud_drive'        // app_config: baiduPan* + defaultProvider ⚠️
  | 'scene_providers'    // scene_provider_selection
  | 'downloaded_videos'  // downloaded_scene_source + official_scene_sync_record (incl. baidu-pan bindings)
  | 'scene_caches'       // oss_video_catalog + video_scene_info (cold-start cache)
  // AsyncStorage-only (P1)
  | 'settings'           // tts_config / sandbox_config / show_avatar / practice_mode
  | 'staged_scenarios'   // staged_scenario_*
  | 'evaluator_state'    // injected_words_* / evaluator_*
  | 'known_words'        // known_words (legacy)
  // Files (P2)
  | 'user_videos'        // documentDirectory/user-videos/
  | 'clip_segments'      // documentDirectory/clip-segments/
  | 'imported_packs'     // documentDirectory/imported-video-packs/
  | 'tts_cache'          // documentDirectory/audio/ TTS cache
  // Cloud-only info (not actually backed up — see `cloudOnly` on BackupItem)
  | 'cloud_synced';      // 我的跟练 + 我的合集 + 官方 catalog — lives in Supabase

export interface BackupItem {
  kind: BackupItemKind;
  /** User-language label, e.g. "生词本", "NPC 对话历史". */
  label: string;
  /** One-line user-language description. */
  description: string;
  /** Estimated size in bytes (computed at scan time). */
  sizeBytes: number;
  /** Optional record count for display: "200 个生词". */
  recordCount?: number;
  /** Marks sensitive items (BYOK API keys, OAuth tokens). */
  sensitive?: boolean;
  /**
   * Read-only info row — data lives in Supabase and is auto-synced
   * after sign-in. The UI renders these in a separate "云端" section
   * without a checkbox, and the export pipeline skips them
   * (the kind is never added to the manifest).
   */
  cloudOnly?: boolean;
  /**
   * Source buckets for write — keeps export/import symmetric. UI never reads this.
   *   - 'db': row(s) from one or more SQLite tables
   *   - 'asyncstorage': one or more AsyncStorage keys
   *   - 'files': file/directory under documentDirectory
   *   - 'mixed': combination (e.g. cards = db table + WAL file)
   *   - 'cloud': lives in Supabase; never written to the zip. Pairs
   *     with `cloudOnly: true`.
   */
  source: 'db' | 'asyncstorage' | 'files' | 'mixed' | 'cloud';
  /** Source detail (e.g. table names, AS keys, file dir). UI never reads. */
  sourceRef: string;
}

export interface BackupManifest {
  version: number;
  /** ISO 8601 UTC, e.g. "2026-08-10T08:00:00.000Z". */
  createdAt: string;
  /** From expo-constants app version. */
  appVersion: string;
  /** Platform tag from Platform.OS. */
  platform: 'android' | 'ios';
  /** Current NativeOS DB schema version. */
  dbSchemaVersion: number;
  /** Items the user chose to include (filtered). */
  items: BackupItem[];
  /** Sum of items[].sizeBytes at write time. */
  totalSizeBytes: number;
}

export interface BackupProgress {
  phase: 'scan' | 'pack_db' | 'copy_files' | 'zip' | 'share' | 'done' | 'error';
  /** 0..1 fractional progress for the active phase. */
  current: number;
  /** User-language status text. */
  message: string;
  /** Total bytes processed so far (for "已处理 X / Y"). */
  bytesProcessed?: number;
  bytesTotal?: number;
}

export type RestoreStrategy = 'overwrite'; // 'merge' deferred to v2

export interface RestoreProgress {
  phase:
    | 'verify'
    | 'auth'
    | 'pull_pro'
    | 'rollback'
    | 'restore_db'
    | 'restore_asyncstorage'
    | 'restore_files'
    | 'done'
    | 'error';
  current: number;
  message: string;
  bytesProcessed?: number;
  bytesTotal?: number;
  /** Set after done: what the server says about Pro. */
  proStatusAfter?: 'pro_active' | 'pro_inactive' | 'unknown';
}

export interface RestorePrecheckResult {
  ok: boolean;
  reason?: string;
  manifest?: BackupManifest;
  /** Size on disk of the zip, for confirmation. */
  zipSizeBytes?: number;
  /** Time the backup was taken (from manifest). */
  createdAt?: string;
}
