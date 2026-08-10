/**
 * Backup/Restore — EXPORT pipeline.
 *
 * Phases (each pushes progress to the callback):
 *   1. pack_db     — WAL checkpoint + copy nativeos.db to staging/db.sqlite
 *   2. copy_files  — copy selected file roots to staging/files/<kind>/
 *   3. pack_as     — write staging/asyncstorage.json with selected keys
 *   4. write_manifest — staging/manifest.json
 *   5. zip         — stage the whole thing into exports/nativeos-backup-*.zip
 *   6. share       — open the system share sheet for the zip (optional)
 *
 * Cancellation: not supported in v1 (the user can wait). Add later if
 * users complain. Each phase is small enough (a few seconds each) that
 * cancellation is rarely worth the complexity.
 *
 * On any error: clean up the staging dir + half-written zip, then rethrow.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  copyAsync,
  deleteAsync,
  getInfoAsync,
  makeDirectoryAsync,
  readDirectoryAsync,
  readAsStringAsync,
  writeAsStringAsync,
} from 'expo-file-system/legacy';
import { zip, subscribe as zipSubscribe } from 'react-native-zip-archive';

import { ensureBackupDirs, BACKUP_DIRS, backupFileName, documentDirectory } from './paths';
import type { BackupItem, BackupManifest, BackupProgress } from './types';
import { BACKUP_VERSION } from './types';
import { BACKUP_ITEMS, resolveSelectedItems } from './inventory';
import type { BackupItemKind } from './types';

export interface ExportOptions {
  /** Items the user has selected (set of kinds). */
  selected: Set<BackupItemKind>;
  /** Live inventory from `scanBackupInventory()` — provides labels + sizes. */
  inventory: BackupItem[];
  /** App version (from expo-constants). */
  appVersion: string;
  /** Current SQLite schema version. */
  dbSchemaVersion: number;
  /** Skip the share dialog at the end (default: false). */
  skipShare?: boolean;
}

export interface ExportResult {
  /** Absolute path to the finished zip. */
  zipPath: string;
  /** Bytes (size of the zip on disk). */
  zipSizeBytes: number;
  /** Number of items that actually got written. */
  itemsWritten: number;
  /** Total bytes processed across all phases. */
  bytesProcessed: number;
}

export type ProgressCallback = (p: BackupProgress) => void;

/** All AsyncStorage keys we know how to back up, grouped by item kind. */
const AS_KEYS_BY_KIND: Record<BackupItemKind, string[] | null> = {
  cards: null,
  chat_history: null,
  ai_practice: null,
  favorites: null,
  user_profile: null,
  quota: null,
  byok: null,
  cloud_drive: null,
  scene_providers: null,
  downloaded_videos: null,
  settings: ['tts_config', 'sandbox_config', 'show_avatar', 'practice_mode'],
  staged_scenarios: ['staged_scenario', 'staged_scenario_ref'],
  evaluator_state: ['fsrs_inject_cache', 'evaluated_sessions', 'library_badge_count'],
  known_words: ['known_words', 'user_level', 'user_interests', 'user_profession'],
  user_videos: null,
  clip_segments: null,
  imported_packs: null,
  tts_cache: null,
};

/** DB table groups by kind (for documentation; the actual pack is whole-DB). */
const DB_TABLE_GROUPS: Record<BackupItemKind, string[] | null> = {
  cards: ['learning_cards', 'fsrs_reviews'],
  chat_history: ['chat_sessions', 'chat_turns'],
  ai_practice: ['video_ai_practice_card', 'video_ai_practice_state'],
  favorites: ['video_user_meta', 'ai_practice_user_meta'],
  user_profile: ['app_config[user_profile]'],
  quota: ['app_config[quota_*]'],
  byok: ['app_config[byok_config]'],
  cloud_drive: ['app_config[baiduPan*]', 'app_config[defaultProvider]'],
  scene_providers: ['scene_provider_selection'],
  downloaded_videos: ['downloaded_scene_source', 'official_scene_sync_record'],
  settings: null,
  staged_scenarios: null,
  evaluator_state: null,
  known_words: null,
  user_videos: null,
  clip_segments: null,
  imported_packs: null,
  tts_cache: null,
};

const FILE_KIND_TO_DIR: Partial<Record<BackupItemKind, string>> = {
  user_videos: 'user-videos',
  clip_segments: 'clip-segments',
  imported_packs: 'imported-video-packs',
  tts_cache: 'audio',
};

function progress(
  cb: ProgressCallback | undefined,
  phase: BackupProgress['phase'],
  current: number,
  message: string,
  bytesProcessed?: number,
  bytesTotal?: number,
): void {
  cb?.({ phase, current, message, bytesProcessed, bytesTotal });
}

// ── Phase 1: pack_db ─────────────────────────────────────────────────

async function packDb(stagingDir: string, onProgress: ProgressCallback): Promise<void> {
  const destPath = `${stagingDir}/db.sqlite`;
  progress(onProgress, 'pack_db', 0.1, '正在写入数据库快照…');

  // WAL checkpoint so any pending writes hit the main file.
  try {
    const { ensureDatabaseInitialized } = await import('../database');
    await ensureDatabaseInitialized();
    const { getDatabase } = await import('../database/schema');
    const db = await getDatabase();
    await db.execAsync('PRAGMA wal_checkpoint(TRUNCATE)');
  } catch (e) {
    console.warn('[export] wal_checkpoint failed (continuing):', e);
  }

  // Source path: expo-sqlite stores the file in the app's documents dir.
  // SQLite is created via SQLite.openDatabaseAsync('nativeos.db'), so the
  // filename in documentDirectory is 'nativeos.db'.
  const srcPath = `${documentDirectory ?? ''}SQLite/nativeos.db`;
  const srcInfo = await getInfoAsync(srcPath);
  if (!srcInfo.exists) {
    throw new Error('本地数据库文件不存在，无法备份');
  }

  progress(onProgress, 'pack_db', 0.5, '正在复制数据库…');
  await copyAsync({ from: srcPath, to: destPath });
  progress(onProgress, 'pack_db', 1, '数据库已复制');
}

// ── Phase 2: copy_files ──────────────────────────────────────────────

async function copyDirRecursive(src: string, dest: string): Promise<number> {
  // returns bytes copied
  let bytes = 0;
  const info = await getInfoAsync(src);
  if (!info.exists) return 0;
  if (!info.isDirectory) {
    await copyAsync({ from: src, to: dest });
    return typeof info.size === 'number' ? info.size : 0;
  }
  await makeDirectoryAsync(dest, { intermediates: true });
  const entries = await readDirectoryAsync(src);
  for (const name of entries) {
    const childSrc = `${src}/${name}`;
    const childDest = `${dest}/${name}`;
    const childInfo = await getInfoAsync(childSrc);
    if (!childInfo.exists) continue;
    if (childInfo.isDirectory) {
      bytes += await copyDirRecursive(childSrc, childDest);
    } else {
      await copyAsync({ from: childSrc, to: childDest });
      bytes += typeof childInfo.size === 'number' ? childInfo.size : 0;
    }
  }
  return bytes;
}

async function packFiles(
  stagingDir: string,
  selected: Set<BackupItemKind>,
  onProgress: ProgressCallback,
): Promise<number> {
  const filesRoot = `${stagingDir}/files`;
  let totalBytes = 0;
  const fileKinds = (Object.keys(FILE_KIND_TO_DIR) as BackupItemKind[]).filter(
    (k) => selected.has(k) && FILE_KIND_TO_DIR[k],
  );
  if (fileKinds.length === 0) return 0;

  await makeDirectoryAsync(filesRoot, { intermediates: true });

  for (let i = 0; i < fileKinds.length; i++) {
    const kind = fileKinds[i];
    const dirName = FILE_KIND_TO_DIR[kind]!;
    const srcDir = `${documentDirectory ?? ''}${dirName}`;
    const destDir = `${filesRoot}/${dirName}`;
    progress(
      onProgress,
      'copy_files',
      i / fileKinds.length,
      `正在复制文件：${kind}（${i + 1}/${fileKinds.length}）`,
    );
    const bytes = await copyDirRecursive(srcDir, destDir);
    totalBytes += bytes;
  }
  progress(onProgress, 'copy_files', 1, '文件复制完成');
  return totalBytes;
}

// ── Phase 3: pack_asyncstorage ───────────────────────────────────────

async function packAsyncStorage(
  stagingDir: string,
  selected: Set<BackupItemKind>,
): Promise<number> {
  const keysToDump = new Set<string>();
  for (const kind of Object.keys(AS_KEYS_BY_KIND) as BackupItemKind[]) {
    if (!selected.has(kind)) continue;
    const keys = AS_KEYS_BY_KIND[kind];
    if (keys) keys.forEach((k) => keysToDump.add(k));
  }
  if (keysToDump.size === 0) return 0;

  const pairs = (await AsyncStorage.multiGet(
    Array.from(keysToDump),
  )) as Array<[string, string | null]>;
  const out: Record<string, string> = {};
  for (const [k, v] of pairs) {
    if (v !== null) out[k] = v;
  }
  const json = JSON.stringify(out);
  await writeAsStringAsync(`${stagingDir}/asyncstorage.json`, json);
  return json.length;
}

// ── Phase 4: write_manifest ──────────────────────────────────────────

async function writeManifest(
  stagingDir: string,
  opts: ExportOptions,
): Promise<void> {
  const items: BackupItem[] = opts.inventory.filter((it) => opts.selected.has(it.kind));
  const manifest: BackupManifest = {
    version: BACKUP_VERSION,
    createdAt: new Date().toISOString(),
    appVersion: opts.appVersion,
    platform: 'android',
    dbSchemaVersion: opts.dbSchemaVersion,
    items,
    totalSizeBytes: items.reduce((a, b) => a + (b.sizeBytes || 0), 0),
  };
  await writeAsStringAsync(
    `${stagingDir}/manifest.json`,
    JSON.stringify(manifest, null, 2),
  );
}

// ── Phase 5: zip ─────────────────────────────────────────────────────

async function packZip(
  stagingDir: string,
  onProgress: ProgressCallback,
): Promise<{ zipPath: string; sizeBytes: number }> {
  await ensureBackupDirs();
  const zipPath = `${BACKUP_DIRS.exports}/${backupFileName()}`;

  // Set up a one-shot progress listener.
  let lastPct = 0;
  const sub = zipSubscribe(({ progress: pct }) => {
    lastPct = pct;
    progress(onProgress, 'zip', Math.min(0.99, pct), `正在打包（${Math.round(pct * 100)}%）`);
  });

  try {
    progress(onProgress, 'zip', 0, '正在打包…');
    await zip(stagingDir, zipPath);
  } finally {
    sub.remove();
  }

  progress(onProgress, 'zip', 1, '打包完成');
  const info = await getInfoAsync(zipPath);
  const sizeBytes = info.exists && typeof info.size === 'number' ? info.size : 0;
  return { zipPath, sizeBytes };
}

// ── Cleanup helpers ──────────────────────────────────────────────────

async function rmrf(path: string): Promise<void> {
  try {
    const info = await getInfoAsync(path);
    if (info.exists) await deleteAsync(path, { idempotent: true });
  } catch {
    /* ignore */
  }
}

async function resetStaging(): Promise<void> {
  try {
    const info = await getInfoAsync(BACKUP_DIRS.staging);
    if (info.exists) {
      // wipe contents but keep the dir
      const entries = await readDirectoryAsync(BACKUP_DIRS.staging);
      for (const e of entries) {
        await rmrf(`${BACKUP_DIRS.staging}/${e}`);
      }
    } else {
      await makeDirectoryAsync(BACKUP_DIRS.staging, { intermediates: true });
    }
  } catch {
    /* ignore */
  }
}

// ── Public entry point ───────────────────────────────────────────────

export async function runExport(
  opts: ExportOptions,
  onProgress?: ProgressCallback,
): Promise<ExportResult> {
  await ensureBackupDirs();
  await resetStaging();
  const stagingDir = BACKUP_DIRS.staging;

  let bytesProcessed = 0;
  let zipPath = '';
  let zipSizeBytes = 0;

  try {
    // Phase 1: DB
    await packDb(stagingDir, onProgress ?? (() => {}));

    // Phase 2: Files (parallel-safe with AS)
    const [fileBytes, asBytes] = await Promise.all([
      packFiles(stagingDir, opts.selected, onProgress ?? (() => {})),
      packAsyncStorage(stagingDir, opts.selected),
    ]);
    bytesProcessed = fileBytes + asBytes;

    // Phase 3: Manifest
    await writeManifest(stagingDir, opts);

    // Phase 4: Zip
    const z = await packZip(stagingDir, onProgress ?? (() => {}));
    zipPath = z.zipPath;
    zipSizeBytes = z.sizeBytes;

    progress(onProgress, 'done', 1, '备份完成');

    // Optional share
    if (!opts.skipShare) {
      try {
        const { shareBackupZip } = await import('./share');
        await shareBackupZip(zipPath);
      } catch (e) {
        console.warn('[export] share failed (zip still saved):', e);
      }
    }

    return {
      zipPath,
      zipSizeBytes,
      itemsWritten: opts.selected.size,
      bytesProcessed,
    };
  } catch (err) {
    // Try to delete any half-written zip
    if (zipPath) await rmrf(zipPath);
    progress(
      onProgress,
      'error',
      0,
      err instanceof Error ? err.message : '备份失败',
    );
    throw err;
  } finally {
    // Staging is throwaway; always wipe
    await rmrf(stagingDir);
  }
}

// ── Lightweight listing of past exports (for "history" UI later) ──────

export async function listExistingBackups(): Promise<Array<{ path: string; sizeBytes: number; mtime: number }>> {
  await ensureBackupDirs();
  const out: Array<{ path: string; sizeBytes: number; mtime: number }> = [];
  try {
    const entries = await readDirectoryAsync(BACKUP_DIRS.exports);
    for (const name of entries) {
      if (!name.endsWith('.zip')) continue;
      const p = `${BACKUP_DIRS.exports}/${name}`;
      const info = await getInfoAsync(p);
      if (info.exists) {
        out.push({
          path: p,
          sizeBytes: typeof info.size === 'number' ? info.size : 0,
          // expo-file-system/legacy returns modificationTime in SECONDS,
          // not ms. Convert to ms so callers (Date, sort) work as expected.
          mtime: (info.modificationTime ?? 0) * 1000,
        });
      }
    }
  } catch {
    /* dir may not exist */
  }
  out.sort((a, b) => b.mtime - a.mtime);
  return out;
}

export async function deleteBackup(zipPath: string): Promise<void> {
  await rmrf(zipPath);
}

export { BACKUP_ITEMS, resolveSelectedItems };
export type { BackupItemKind };
