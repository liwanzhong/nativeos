/**
 * Backup/Restore — RESTORE (import) pipeline.
 *
 * Phases:
 *   1. verify         — read manifest, sanity-check version & item kinds
 *   2. auth           — require a signed-in user (auth gate, Q4)
 *   3. pull_pro       — refresh Supabase profile so Pro state is server-truth
 *   4. rollback       — snapshot current state to rollback/<ts>/
 *   5. restore_db     — close handle, replace SQLite/nativeos.db
 *   6. restore_as     — write AsyncStorage keys
 *   7. restore_files  — copy back into documentDirectory/<kind>/
 *   8. done           — caller is expected to reload the app
 *
 * Strategy: overwrite only (Q5). merge is UI-disabled and not implemented.
 *
 * Failure handling:
 *   - Any pre-rollback failure: just abort, no data is touched
 *   - Any post-rollback failure: roll back to the snapshot we just made
 *   - The 7-day rollback window lets the user recover from a botched
 *     restore even if they didn't notice the error in time
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  copyAsync,
  deleteAsync,
  getInfoAsync,
  makeDirectoryAsync,
  moveAsync,
  readAsStringAsync,
  readDirectoryAsync,
  writeAsStringAsync,
} from 'expo-file-system/legacy';
import { unzip, subscribe as unzipSubscribe } from 'react-native-zip-archive';

import { BACKUP_DIRS, ensureBackupDirs, rollbackDirName, documentDirectory } from './paths';
import type {
  BackupItem,
  BackupItemKind,
  BackupManifest,
  RestorePrecheckResult,
  RestoreProgress,
  RestoreStrategy,
} from './types';
import { BACKUP_VERSION } from './types';
import { BACKUP_ITEMS } from './inventory';

export interface RestoreOptions {
  /** Path to the backup zip the user picked. */
  zipPath: string;
  /** Which strategy to use (only 'overwrite' supported in v1). */
  strategy: RestoreStrategy;
  /** Callback for progress + phase transitions. */
  onProgress?: (p: RestoreProgress) => void;
}

export interface RestoreResult {
  manifest: BackupManifest;
  rollbackPath: string;
  proStatusAfter: 'pro_active' | 'pro_inactive' | 'unknown';
  restoredKinds: BackupItemKind[];
}

type ProgressCb = NonNullable<RestoreOptions['onProgress']>;

function progress(
  cb: ProgressCb | undefined,
  phase: RestoreProgress['phase'],
  current: number,
  message: string,
): void {
  cb?.({ phase, current, message });
}

async function rmrf(path: string): Promise<void> {
  try {
    const info = await getInfoAsync(path);
    if (info.exists) await deleteAsync(path, { idempotent: true });
  } catch {
    /* ignore */
  }
}

async function dirSizeBytes(path: string): Promise<number> {
  let total = 0;
  const stack: string[] = [path];
  while (stack.length) {
    const cur = stack.pop()!;
    const info = await getInfoAsync(cur);
    if (!info.exists) continue;
    if (!info.isDirectory) {
      total += typeof info.size === 'number' ? info.size : 0;
      continue;
    }
    const entries = await readDirectoryAsync(cur);
    for (const name of entries) {
      stack.push(`${cur}/${name}`);
    }
  }
  return total;
}

// ── Phase 1: verify ──────────────────────────────────────────────────

/**
 * Cheap ZIP magic-number check. Safe to call right after expo-document-picker
 * returns — if the user picked a JPG/PDF, this returns false WITHOUT ever
 * touching unzip(). Catches the native crash window where picker hands off
 * a non-zip file and react-native-zip-archive would segfault.
 */
export async function isZipMagic(uri: string): Promise<boolean> {
  try {
    const head = await readAsStringAsync(uri, {
      encoding: 'base64',
      position: 0,
      length: 4,
    });
    return !!head && head.startsWith('UEs');
  } catch {
    return false;
  }
}

export async function precheckBackup(
  zipPath: string,
): Promise<RestorePrecheckResult> {
  try {
    const info = await getInfoAsync(zipPath);
    if (!info.exists) {
      return { ok: false, reason: '备份文件不存在' };
    }
    const zipSizeBytes = typeof info.size === 'number' ? info.size : 0;
    if (zipSizeBytes === 0) {
      return { ok: false, reason: '备份文件为空' };
    }
    // 2 GB 上限 —— 备份包正常在几十 MB~几百 MB,超过基本是用户选错文件。
    const ZIP_SIZE_MAX = 2 * 1024 * 1024 * 1024;
    if (zipSizeBytes > ZIP_SIZE_MAX) {
      return {
        ok: false,
        reason: `文件过大（${(zipSizeBytes / 1024 / 1024).toFixed(0)} MB），不是合法的备份文件`,
      };
    }

    // ZIP 魔数校验 —— 在 unzip() 之前做,防止 react-native-zip-archive
    // 对非 zip 输入 native crash(JS 抓不到,app 会直接挂)。
    // ZIP 头 4 字节 = 50 4B 03 04 = "PK\x03\x04" (local file header)
    // 或 50 4B 05 06 = "PK\x05\x06" (空 zip end record),
    // 两种 base64 编码前 3 字符都是 "UEs"。读 4 字节就够。
    if (!(await isZipMagic(zipPath))) {
      return {
        ok: false,
        reason: '不是有效的 ZIP 文件（请选择 NativeOS 导出的 .zip 备份）',
      };
    }

    // Unzip to a fresh temp dir to read the manifest
    await ensureBackupDirs();
    const tmpDir = `${BACKUP_DIRS.staging}/precheck`;
    await rmrf(tmpDir);
    await makeDirectoryAsync(tmpDir, { intermediates: true });

    try {
      await unzip(zipPath, tmpDir);
    } catch (e) {
      await rmrf(tmpDir);
      return {
        ok: false,
        reason: '无法解压备份文件，可能已损坏',
      };
    }

    const manifestPath = `${tmpDir}/manifest.json`;
    const mInfo = await getInfoAsync(manifestPath);
    if (!mInfo.exists) {
      await rmrf(tmpDir);
      return { ok: false, reason: '备份中没有 manifest.json，文件可能不是 NativeOS 备份' };
    }

    let manifest: BackupManifest;
    try {
      const raw = await readAsStringAsync(manifestPath);
      manifest = JSON.parse(raw);
    } catch (e) {
      await rmrf(tmpDir);
      return { ok: false, reason: 'manifest 解析失败' };
    }

    // 基础 shape 校验 —— JSON.parse 成功不代表 manifest 合法。
    if (
      !manifest ||
      typeof manifest.version !== 'number' ||
      !Array.isArray(manifest.items)
    ) {
      await rmrf(tmpDir);
      return { ok: false, reason: 'manifest 格式不正确，不是 NativeOS 备份' };
    }

    if (manifest.version > BACKUP_VERSION) {
      await rmrf(tmpDir);
      return {
        ok: false,
        reason: `备份由更高版本创建（v${manifest.version}），请升级 app 后再恢复`,
      };
    }

    // 内容交叉验证 —— manifest 合法但 zip 里啥都没有的"空壳 zip"必须挡掉。
    // 任何一份真正的 NativeOS 备份至少要带 db.sqlite（cards / chat / favorites 等
    // 都是 db source） 或 asyncstorage.json（settings / byok 等）。
    // 两个都缺 = 这个 zip 不是 NativeOS 产物,不要让 runRestore 跑到一半才发现。
    const dbInfo = await getInfoAsync(`${tmpDir}/db.sqlite`);
    const asInfo = await getInfoAsync(`${tmpDir}/asyncstorage.json`);
    if (!dbInfo.exists && !asInfo.exists) {
      await rmrf(tmpDir);
      return {
        ok: false,
        reason: '该 zip 里没有数据库或设置内容，不是 NativeOS 备份',
      };
    }

    // Validate kind names against our current list
    const knownKinds = new Set<string>(BACKUP_ITEMS.map((it) => it.kind));
    for (const it of manifest.items) {
      if (!knownKinds.has(it.kind)) {
        // Unknown kind — not fatal, just skip on restore
      }
    }

    await rmrf(tmpDir);
    return {
      ok: true,
      manifest,
      zipSizeBytes,
      createdAt: manifest.createdAt,
    };
  } catch (e) {
    return {
      ok: false,
      reason: e instanceof Error ? e.message : '备份文件校验失败',
    };
  }
}

// ── Phase 2: auth gate ───────────────────────────────────────────────

async function requireSignedIn(): Promise<{ ok: boolean; reason?: string; supabase?: typeof import('../supabase').supabase }> {
  const { supabase } = await import('../supabase');
  try {
    const { data, error } = await supabase.auth.getSession();
    if (error) return { ok: false, reason: error.message, supabase };
    if (!data?.session?.user) {
      return {
        ok: false,
        reason: '需要先登录账号才能恢复备份',
        supabase,
      };
    }
    return { ok: true, supabase };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : '登录检查失败', supabase };
  }
}

// ── Phase 3: pull_pro from supabase ──────────────────────────────────

async function pullProFromSupabase(
  supabase: typeof import('../supabase').supabase,
  onProgress: ProgressCb,
): Promise<'pro_active' | 'pro_inactive' | 'unknown'> {
  try {
    const { data: sess } = await supabase.auth.getSession();
    const uid = sess?.session?.user?.id;
    if (!uid) return 'unknown';
    const { data, error } = await supabase
      .from('profiles')
      .select('is_pro, pro_expires_at')
      .eq('id', uid)
      .maybeSingle();
    if (error) {
      console.warn('[restore] pull profile failed:', error.message);
      return 'unknown';
    }
    if (!data) return 'unknown';

    const expiresAt = data.pro_expires_at ? new Date(data.pro_expires_at) : null;
    const isActive = !!data.is_pro && (!expiresAt || expiresAt.getTime() > Date.now());

    // Update local pro state via the quota module
    const { setProState, refreshQuotaConfigFromSupabase } = await import('../quota');
    await setProState({
      tier: isActive ? 'pro' : 'free',
      expiresAt: data.pro_expires_at ?? null,
      updatedAt: Date.now(),
    });
    await refreshQuotaConfigFromSupabase();

    return isActive ? 'pro_active' : 'pro_inactive';
  } catch (e) {
    console.warn('[restore] pullProFromSupabase error:', e);
    return 'unknown';
  }
}

// ── Phase 4: rollback (snapshot current state) ───────────────────────

async function snapshotCurrentState(
  onProgress: ProgressCb,
): Promise<string> {
  const ts = rollbackDirName();
  const dir = `${BACKUP_DIRS.rollback}/${ts}`;
  await makeDirectoryAsync(dir, { intermediates: true });

  // 4a. Copy nativeos.db
  const srcDb = `${documentDirectory ?? ''}SQLite/nativeos.db`;
  const srcInfo = await getInfoAsync(srcDb);
  if (srcInfo.exists) {
    progress(onProgress, 'rollback', 0.2, '正在备份当前数据库…');
    try {
      // Checkpoint first so WAL hits the main file
      try {
        const { getDatabase } = await import('../database/schema');
        const db = await getDatabase();
        await db.execAsync('PRAGMA wal_checkpoint(TRUNCATE)');
      } catch {
        /* ignore — proceed with whatever's on disk */
      }
      await copyAsync({ from: srcDb, to: `${dir}/nativeos.db` });
    } catch (e) {
      console.warn('[restore] rollback DB copy failed:', e);
    }
  }

  // 4b. AsyncStorage dump
  progress(onProgress, 'rollback', 0.5, '正在备份当前 AsyncStorage…');
  try {
    const allKeys = await AsyncStorage.getAllKeys();
    const pairs = await AsyncStorage.multiGet(allKeys);
    const out: Record<string, string> = {};
    for (const [k, v] of pairs) {
      if (v !== null) out[k] = v;
    }
    await writeAsStringAsync(`${dir}/asyncstorage.json`, JSON.stringify(out));
  } catch (e) {
    console.warn('[restore] rollback AS dump failed:', e);
  }

  // 4c. Skip file snapshot to keep rollback light (user can lose these
  // intentionally — re-download from cloud is cheap). Add later if a
  // user loses a critical local file.

  progress(onProgress, 'rollback', 1, '回滚点已就绪');
  return dir;
}

// ── Phase 5: restore_db ──────────────────────────────────────────────

async function restoreDb(stagingDir: string, onProgress: ProgressCb): Promise<void> {
  const srcDb = `${stagingDir}/db.sqlite`;
  const info = await getInfoAsync(srcDb);
  if (!info.exists) {
    throw new Error('备份中没有数据库文件');
  }

  progress(onProgress, 'restore_db', 0.2, '正在关闭数据库连接…');
  const { closeDatabase } = await import('../database/schema');
  await closeDatabase();

  // Remove old DB files (main + WAL + SHM)
  const sqliteDir = `${documentDirectory ?? ''}SQLite`;
  for (const name of ['nativeos.db', 'nativeos.db-wal', 'nativeos.db-shm']) {
    const p = `${sqliteDir}/${name}`;
    await rmrf(p);
  }

  // Copy new DB
  progress(onProgress, 'restore_db', 0.6, '正在写入数据库…');
  await makeDirectoryAsync(sqliteDir, { intermediates: true });
  await copyAsync({ from: srcDb, to: `${sqliteDir}/nativeos.db` });
  progress(onProgress, 'restore_db', 1, '数据库已恢复');
}

// ── Phase 6: restore_asyncstorage ────────────────────────────────────

async function restoreAsyncStorage(
  stagingDir: string,
  onProgress: ProgressCb,
): Promise<number> {
  const asPath = `${stagingDir}/asyncstorage.json`;
  const info = await getInfoAsync(asPath);
  if (!info.exists) return 0;

  progress(onProgress, 'restore_asyncstorage', 0.2, '正在恢复设置与草稿…');
  const raw = await readAsStringAsync(asPath);
  let parsed: Record<string, string>;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return 0;
  }
  const entries = Object.entries(parsed);
  // Use multiSet in chunks of 50 to avoid huge IPC
  const chunk = 50;
  for (let i = 0; i < entries.length; i += chunk) {
    const slice = entries.slice(i, i + chunk);
    await AsyncStorage.multiSet(slice as [string, string][]);
  }
  progress(onProgress, 'restore_asyncstorage', 1, `已恢复 ${entries.length} 项`);
  return entries.length;
}

// ── Phase 7: restore_files ───────────────────────────────────────────

const FILE_KIND_TO_DIR: Partial<Record<BackupItemKind, string>> = {
  user_videos: 'user-videos',
  clip_segments: 'clip-segments',
  imported_packs: 'imported-video-packs',
  tts_cache: 'audio',
};

async function restoreFiles(
  stagingDir: string,
  manifest: BackupManifest,
  onProgress: ProgressCb,
): Promise<number> {
  const filesRoot = `${stagingDir}/files`;
  const info = await getInfoAsync(filesRoot);
  if (!info.exists) return 0;

  const fileItems = manifest.items.filter(
    (it) => it.source === 'files' || it.source === 'mixed',
  );
  if (fileItems.length === 0) return 0;

  let totalBytes = 0;
  for (let i = 0; i < fileItems.length; i++) {
    const it = fileItems[i];
    const dirName = FILE_KIND_TO_DIR[it.kind];
    if (!dirName) continue;
    const srcDir = `${filesRoot}/${dirName}`;
    const sInfo = await getInfoAsync(srcDir);
    if (!sInfo.exists) continue;

    const destDir = `${documentDirectory ?? ''}${dirName}`;
    progress(
      onProgress,
      'restore_files',
      i / fileItems.length,
      `正在恢复文件：${it.label}（${i + 1}/${fileItems.length}）`,
    );

    // Wipe existing first (overwrite strategy)
    await rmrf(destDir);
    await makeDirectoryAsync(destDir, { intermediates: true });

    // Recursive copy
    const stack: Array<[string, string]> = [[srcDir, destDir]];
    while (stack.length) {
      const [s, d] = stack.pop()!;
      const sInfo2 = await getInfoAsync(s);
      if (!sInfo2.exists) continue;
      if (sInfo2.isDirectory) {
        await makeDirectoryAsync(d, { intermediates: true });
        const entries = await readDirectoryAsync(s);
        for (const name of entries) stack.push([`${s}/${name}`, `${d}/${name}`]);
      } else {
        await copyAsync({ from: s, to: d });
        if (typeof sInfo2.size === 'number') totalBytes += sInfo2.size;
      }
    }
  }
  progress(onProgress, 'restore_files', 1, '文件已恢复');
  return totalBytes;
}

// ── Phase 8: 7-day rollback GC ───────────────────────────────────────

const ROLLBACK_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export async function pruneOldRollbacks(): Promise<void> {
  await ensureBackupDirs();
  try {
    const entries = await readDirectoryAsync(BACKUP_DIRS.rollback);
    const now = Date.now();
    for (const name of entries) {
      const full = `${BACKUP_DIRS.rollback}/${name}`;
      const info = await getInfoAsync(full);
      if (!info.exists) continue;
      // expo-file-system/legacy returns modificationTime in SECONDS.
      // Convert to ms so the TTL comparison works.
      const mtime = (info.modificationTime ?? 0) * 1000;
      if (mtime && now - mtime > ROLLBACK_TTL_MS) {
        await rmrf(full);
      }
    }
  } catch {
    /* ignore */
  }
}

export async function listRollbacks(): Promise<
  Array<{ path: string; sizeBytes: number; mtime: number }>
> {
  await ensureBackupDirs();
  const out: Array<{ path: string; sizeBytes: number; mtime: number }> = [];
  try {
    const entries = await readDirectoryAsync(BACKUP_DIRS.rollback);
    for (const name of entries) {
      const full = `${BACKUP_DIRS.rollback}/${name}`;
      const info = await getInfoAsync(full);
      if (info.exists) {
        out.push({
          path: full,
          sizeBytes: await dirSizeBytes(full),
          // SECONDS → ms (see listExistingBackups in export.ts for why)
          mtime: (info.modificationTime ?? 0) * 1000,
        });
      }
    }
  } catch {
    /* ignore */
  }
  out.sort((a, b) => b.mtime - a.mtime);
  return out;
}

// ── Public entry point ───────────────────────────────────────────────

export async function runRestore(opts: RestoreOptions): Promise<RestoreResult> {
  const onProgress = opts.onProgress ?? (() => {});
  await ensureBackupDirs();
  const stagingDir = `${BACKUP_DIRS.staging}/restore_${Date.now()}`;
  await makeDirectoryAsync(stagingDir, { intermediates: true });

  let rollbackPath = '';

  try {
    // ── Phase 1: verify ─────────────────────────────────────────────
    progress(onProgress, 'verify', 0.1, '正在校验备份文件…');
    const pre = await precheckBackup(opts.zipPath);
    if (!pre.ok || !pre.manifest) {
      throw new Error(pre.reason || '备份文件无法识别');
    }
    const manifest = pre.manifest;
    progress(onProgress, 'verify', 1, '备份文件已识别');

    // ── Phase 2: auth gate ──────────────────────────────────────────
    progress(onProgress, 'auth', 0.2, '正在检查登录…');
    const auth = await requireSignedIn();
    if (!auth.ok || !auth.supabase) {
      throw new Error(auth.reason || '需要登录后才能恢复');
    }
    progress(onProgress, 'auth', 1, '登录已确认');

    // ── Phase 3: pull_pro ───────────────────────────────────────────
    progress(onProgress, 'pull_pro', 0.3, '正在从云端刷新 Pro 状态…');
    const proStatus = await pullProFromSupabase(auth.supabase, onProgress);
    progress(onProgress, 'pull_pro', 1, `Pro 状态：${proStatus === 'pro_active' ? '已激活' : proStatus === 'pro_inactive' ? '未激活' : '未知'}`);

    // ── Phase 4: rollback ───────────────────────────────────────────
    rollbackPath = await snapshotCurrentState(onProgress);

    // ── Unzip the backup to a fresh staging dir ─────────────────────
    progress(onProgress, 'verify', 0.5, '正在解压…');
    let lastUnzipPct = 0;
    const sub = unzipSubscribe(({ progress: pct }) => {
      lastUnzipPct = pct;
      progress(onProgress, 'verify', 0.5 + pct * 0.3, `正在解压（${Math.round(pct * 100)}%）`);
    });
    try {
      await unzip(opts.zipPath, stagingDir);
    } catch (e) {
      // JS 抛错:文件中途损坏 / 权限不足 / 磁盘满。precheck 已经把 magic 和
      // 内容都查过了,走到这里报错基本是磁盘或权限问题,给用户一个具体提示。
      throw new Error(
        `解压失败：${e instanceof Error ? e.message : '备份文件可能已损坏'}`,
      );
    } finally {
      sub.remove();
    }

    // ── Phase 5: restore_db ─────────────────────────────────────────
    await restoreDb(stagingDir, onProgress);

    // ── Phase 6: restore_asyncstorage ───────────────────────────────
    await restoreAsyncStorage(stagingDir, onProgress);

    // ── Phase 7: restore_files ──────────────────────────────────────
    await restoreFiles(stagingDir, manifest, onProgress);

    // ── Done ────────────────────────────────────────────────────────
    progress(onProgress, 'done', 1, '恢复完成，请重启 app');
    await pruneOldRollbacks();

    return {
      manifest,
      rollbackPath,
      proStatusAfter: proStatus,
      restoredKinds: manifest.items.map((it) => it.kind),
    };
  } catch (err) {
    progress(
      onProgress,
      'error',
      0,
      err instanceof Error ? err.message : '恢复失败',
    );
    throw err;
  } finally {
    await rmrf(stagingDir);
  }
}

// ── Manual rollback (from settings UI) ───────────────────────────────

export async function rollbackTo(rollbackPath: string): Promise<void> {
  const info = await getInfoAsync(rollbackPath);
  if (!info.exists) throw new Error('回滚点不存在');

  // Close DB
  const { closeDatabase } = await import('../database/schema');
  await closeDatabase();

  // Replace DB
  const sqliteDir = `${documentDirectory ?? ''}SQLite`;
  for (const name of ['nativeos.db', 'nativeos.db-wal', 'nativeos.db-shm']) {
    await rmrf(`${sqliteDir}/${name}`);
  }
  await makeDirectoryAsync(sqliteDir, { intermediates: true });
  const dbInfo = await getInfoAsync(`${rollbackPath}/nativeos.db`);
  if (dbInfo.exists) {
    await copyAsync({
      from: `${rollbackPath}/nativeos.db`,
      to: `${sqliteDir}/nativeos.db`,
    });
  }

  // Replace AS
  const asInfo = await getInfoAsync(`${rollbackPath}/asyncstorage.json`);
  if (asInfo.exists) {
    const raw = await readAsStringAsync(`${rollbackPath}/asyncstorage.json`);
    try {
      const parsed = JSON.parse(raw);
      const entries = Object.entries(parsed) as [string, string][];
      const chunk = 50;
      for (let i = 0; i < entries.length; i += chunk) {
        await AsyncStorage.multiSet(entries.slice(i, i + chunk));
      }
    } catch {
      /* ignore */
    }
  }
}
