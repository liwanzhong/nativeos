/**
 * Backup/Restore — "save to user-picked directory" via Android's Storage
 * Access Framework (SAF).
 *
 * Why SAF (not MediaStore / not a direct file write):
 *  - On Android 11+ scoped storage blocks direct writes to
 *    `/storage/emulated/0/Download/`. expo-file-system's plain
 *    `writeAsStringAsync` cannot bypass that.
 *  - MediaStore needs `WRITE_EXTERNAL_STORAGE` (legacy) or the granular
 *    media perms on Android 13+, and the path through
 *    `react-native-blob-util` adds a new native dep whose RN 0.83 +
 *    Hermes compatibility is unverified.
 *  - SAF has been the official Expo-recommended path for Android 10+
 *    for years: the user picks a directory once, the system remembers
 *    the grant per-package, and the app can write to that directory
 *    without any runtime permission prompts.
 *
 * The URI the user grants is persisted in AsyncStorage under
 * `backup.save.dir.uri`. On subsequent saves we use it directly (no
 * re-prompt) as long as the user hasn't revoked the permission.
 *
 * The zip itself is streamed in as a base64 string via
 * `readAsStringAsync` / `writeAsStringAsync`. For a 20MB backup that
 * means a ~27MB string round-trip — fine on RN 0.83 + Hermes, but
 * worth keeping in mind if backups grow.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  getInfoAsync,
  readAsStringAsync,
  StorageAccessFramework,
  writeAsStringAsync,
} from 'expo-file-system/legacy';

const SAVED_DIR_URI_KEY = 'backup.save.dir.uri';

export type SaveOutcome = 'saved' | 'denied' | 'cancelled' | 'error';

export interface SaveResult {
  outcome: SaveOutcome;
  /** Where the file ended up, when known. */
  fileUri?: string;
  message?: string;
}

/** Returns the previously-granted directory URI, if any. */
export async function getSavedDirUri(): Promise<string | null> {
  try {
    return await AsyncStorage.getItem(SAVED_DIR_URI_KEY);
  } catch {
    return null;
  }
}

/** Forget the previously-granted directory. */
export async function clearSavedDirUri(): Promise<void> {
  try {
    await AsyncStorage.removeItem(SAVED_DIR_URI_KEY);
  } catch {
    /* best effort */
  }
}

/**
 * Ensure we have a directory to write into. If a previous grant is in
 * AsyncStorage we use it directly; otherwise we pop the system picker.
 * The user can pass `forcePick=true` to always re-pick (e.g. "use a
 * different folder").
 */
async function ensureDirectoryUri(
  forcePick: boolean,
): Promise<string | null> {
  if (!forcePick) {
    const remembered = await getSavedDirUri();
    if (remembered) return remembered;
  } else {
    // Open the picker with the previous grant as the start location so
    // the user doesn't have to navigate from root again.
    const remembered = await getSavedDirUri();
    const result = await StorageAccessFramework.requestDirectoryPermissionsAsync(
      remembered,
    );
    if (!result.granted || !result.directoryUri) return null;
    await AsyncStorage.setItem(SAVED_DIR_URI_KEY, result.directoryUri);
    return result.directoryUri;
  }

  const result = await StorageAccessFramework.requestDirectoryPermissionsAsync();
  if (!result.granted || !result.directoryUri) return null;
  await AsyncStorage.setItem(SAVED_DIR_URI_KEY, result.directoryUri);
  return result.directoryUri;
}

function fileNameFromPath(zipPath: string): string {
  // strip "file://" prefix, take last segment
  const stripped = zipPath.replace(/^file:\/\//, '');
  const segs = stripped.split('/');
  return segs[segs.length - 1] || 'backup.zip';
}

export interface SaveBackupZipOptions {
  /**
   * If true, always pop the directory picker even if a previous grant
   * is in AsyncStorage. Used when the user taps "use another folder".
   */
  forcePickDir?: boolean;
  /** Mime type for the new file. */
  mimeType?: string;
}

/**
 * Save a finished backup zip into a user-picked directory.
 *
 * Flow:
 *   1. Resolve directory URI (use remembered or ask the user)
 *   2. Verify the source zip still exists
 *   3. `createFileAsync` inside the granted directory
 *   4. Read zip as base64, write that to the new file
 *   5. Report outcome
 */
export async function saveBackupZipToDir(
  zipPath: string,
  options: SaveBackupZipOptions = {},
): Promise<SaveResult> {
  console.log('[saveBackupZipToDir] start', { zipPath, forcePick: options.forcePickDir });

  const info = await getInfoAsync(zipPath);
  if (!info.exists) {
    return { outcome: 'error', message: '备份文件不存在' };
  }

  let dirUri: string | null;
  try {
    dirUri = await ensureDirectoryUri(!!options.forcePickDir);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.log('[saveBackupZipToDir] ensureDirectoryUri threw', msg);
    return { outcome: 'error', message: `无法获取目录权限：${msg}` };
  }

  if (!dirUri) {
    return { outcome: 'cancelled', message: '已取消选择目录' };
  }

  const fileName = fileNameFromPath(zipPath);
  const mimeType = options.mimeType ?? 'application/zip';

  let targetUri: string;
  try {
    targetUri = await StorageAccessFramework.createFileAsync(dirUri, fileName, mimeType);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // A common failure here is the user revoked the grant outside the
    // app. Drop the stale URI so the next attempt re-prompts.
    await clearSavedDirUri();
    return {
      outcome: 'error',
      message: `创建文件失败：${msg}\n\n请重试并重新选择目录。`,
    };
  }

  console.log('[saveBackupZipToDir] created', { targetUri, fileName, size: info.size });

  try {
    const base64 = await readAsStringAsync(zipPath, { encoding: 'base64' });
    console.log('[saveBackupZipToDir] read source', { base64Len: base64.length });
    await writeAsStringAsync(targetUri, base64, { encoding: 'base64' });
    console.log('[saveBackupZipToDir] wrote target OK');
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.log('[saveBackupZipToDir] write failed', msg);
    return { outcome: 'error', message: `写入文件失败：${msg}` };
  }

  return {
    outcome: 'saved',
    fileUri: targetUri,
    message: `已保存到选定目录。\n文件名：${fileName}`,
  };
}
