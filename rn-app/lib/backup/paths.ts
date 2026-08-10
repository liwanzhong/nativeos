/**
 * Backup/Restore — filesystem paths.
 *
 * All backup artifacts live under `documentDirectory/backups/` so they're
 * visible to the user in their normal file manager (not cache, which the
 * OS may evict). The directory layout is:
 *
 *   documentDirectory/backups/
 *     ├── exports/                    # finished backup zips waiting to share
 *     ├── rollback/                   # one folder per pre-restore snapshot
 *     │   └── <ISO-timestamp>/
 *     └── staging/                    # scratch dir while packing
 *
 * Native-only. Web is not supported (matches the rest of the SQLite stack).
 */

import { documentDirectory, cacheDirectory } from 'expo-file-system/legacy';

const BACKUP_ROOT_NAME = 'backups';

function ensureBase(): string {
  if (!documentDirectory) {
    throw new Error('当前环境不支持本地备份（缺少 documentDirectory）');
  }
  return `${documentDirectory}${BACKUP_ROOT_NAME}`;
}

export const BACKUP_DIRS: {
  root: string;
  exports: string;
  rollback: string;
  staging: string;
  rollbackTmp: string;
} = {
  root: ensureBase(),
  exports: '',
  rollback: '',
  staging: '',
  rollbackTmp: '',
};

/**
 * One-shot setup of the backup directory tree. Safe to call repeatedly;
 * creates missing dirs.
 */
export async function ensureBackupDirs(): Promise<void> {
  const { makeDirectoryAsync } = await import('expo-file-system/legacy');
  const root = ensureBase();
  BACKUP_DIRS.root = root;
  BACKUP_DIRS.exports = `${root}/exports`;
  BACKUP_DIRS.rollback = `${root}/rollback`;
  BACKUP_DIRS.staging = `${root}/staging`;
  BACKUP_DIRS.rollbackTmp = `${root}/rollback_tmp`;

  for (const d of [
    BACKUP_DIRS.exports,
    BACKUP_DIRS.rollback,
    BACKUP_DIRS.staging,
    BACKUP_DIRS.rollbackTmp,
  ]) {
    try {
      await makeDirectoryAsync(d, { intermediates: true });
    } catch {
      // already exists, ignore
    }
  }
}

export function backupFileName(date: Date = new Date()): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  return `nativeos-backup-${y}${m}${d}-${hh}${mm}.zip`;
}

export function rollbackDirName(date: Date = new Date()): string {
  // Use milliseconds so two consecutive rollbacks in the same second
  // don't collide. Strip punctuation for filesystem safety.
  const iso = date.toISOString().replace(/[:.]/g, '-');
  return iso;
}

export { documentDirectory, cacheDirectory };
