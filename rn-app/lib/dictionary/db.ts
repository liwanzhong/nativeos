import { Platform } from 'react-native';
import {
  documentDirectory,
  getInfoAsync,
  makeDirectoryAsync,
  deleteAsync,
  createDownloadResumable,
} from 'expo-file-system/legacy';

/**
 * 离线词典配置。
 *
 * 词典文件公开在 OSS 桶上（参考视频跟练页面的 fetchJson 模式），不签名、不需要 key。
 * 首次启动时拉到 documentDirectory/SQLite/ecdict.db，之后离线查词。
 *
 *   https://nativeos.oss-cn-beijing.aliyuncs.com/dictionary/ecdict.db
 */
const DICTIONARY_DOWNLOAD_URL =
  'https://nativeos.oss-cn-beijing.aliyuncs.com/dictionary/ecdict.db';
const DICTIONARY_DB_FILENAME = 'ecdict.db';

export type DictionaryDbPhase =
  | 'idle'
  | 'preparing'
  | 'downloading'
  | 'opening'
  | 'ready'
  | 'failed';

export interface DictionaryDbStatus {
  phase: DictionaryDbPhase;
  errorMessage: string | null;
  /** 0-1，仅在 phase='downloading' 期间有效。-1 = 未知 */
  downloadProgress: number;
  startedAt: number | null;
  updatedAt: number;
}

type DictionaryDbStatusListener = (status: DictionaryDbStatus) => void;

let _db: any = null;
let _initPromise: Promise<any> | null = null;
let _status: DictionaryDbStatus = {
  phase: 'idle',
  errorMessage: null,
  downloadProgress: 0,
  startedAt: null,
  updatedAt: Date.now(),
};
const _statusListeners = new Set<DictionaryDbStatusListener>();

function updateDictionaryDbStatus(next: Partial<DictionaryDbStatus>) {
  _status = {
    ..._status,
    ...next,
    updatedAt: Date.now(),
  };
  _statusListeners.forEach((listener) => listener(_status));
}

export function getDictionaryDbStatus(): DictionaryDbStatus {
  return _status;
}

export function subscribeDictionaryDbStatus(listener: DictionaryDbStatusListener) {
  _statusListeners.add(listener);
  listener(_status);
  return () => {
    _statusListeners.delete(listener);
  };
}

export function retryDictionaryDbDownload() {
  _initPromise = null;
  return openDictionaryDb();
}

export async function openDictionaryDb(): Promise<any> {
  if (_db) {
    if (_status.phase !== 'ready') {
      updateDictionaryDbStatus({
        phase: 'ready',
        errorMessage: null,
        startedAt: _status.startedAt ?? Date.now(),
      });
    }
    return _db;
  }
  if (_initPromise) return _initPromise;

  _initPromise = (async () => {
    const startedAt = Date.now();
    if (Platform.OS === 'web') {
      return null;
    }

    updateDictionaryDbStatus({
      phase: 'preparing',
      errorMessage: null,
      startedAt,
      downloadProgress: 0,
    });

    const SQLite = await import('expo-sqlite');

    const dbDir = `${documentDirectory}SQLite/`;
    const dbPath = `${dbDir}${DICTIONARY_DB_FILENAME}`;

    const dirInfo = await getInfoAsync(dbDir);
    if (!dirInfo.exists) {
      await makeDirectoryAsync(dbDir, { intermediates: true });
    }

    const dbInfo = await getInfoAsync(dbPath);
    if (!dbInfo.exists) {
      updateDictionaryDbStatus({
        phase: 'downloading',
        errorMessage: null,
        startedAt,
        downloadProgress: 0,
      });

      // createDownloadResumable 是 RN 原生下载，不走 JS 内存，适合 200MB 文件
      if (dbInfo.exists) {
        await deleteAsync(dbPath, { idempotent: true });
      }
      const downloadResumable = createDownloadResumable(
        DICTIONARY_DOWNLOAD_URL,
        dbPath,
        {},
        (progress) => {
          const expected = progress.totalBytesExpectedToWrite;
          const ratio =
            expected && expected > 0 ? progress.totalBytesWritten / expected : -1;
          updateDictionaryDbStatus({
            phase: 'downloading',
            downloadProgress: ratio,
          });
        },
      );
      const result = await downloadResumable.downloadAsync();
      if (!result || !result.uri) {
        throw new Error('[Dictionary] 下载未完成，未获得目标文件 URI');
      }
      console.log('[Dictionary] DB downloaded', {
        elapsedMs: Date.now() - startedAt,
        path: dbPath,
      });
    }

    updateDictionaryDbStatus({
      phase: 'opening',
      errorMessage: null,
      startedAt,
    });

    const db = await SQLite.openDatabaseAsync(DICTIONARY_DB_FILENAME);
    console.log('[Dictionary] openDictionaryDb ready', {
      elapsedMs: Date.now() - startedAt,
    });
    _db = db;
    updateDictionaryDbStatus({
      phase: 'ready',
      errorMessage: null,
      startedAt,
    });
    return db;
  })().catch((error) => {
    _db = null;
    _initPromise = null;
    updateDictionaryDbStatus({
      phase: 'failed',
      errorMessage: error instanceof Error ? error.message : '词典下载失败',
    });
    throw error;
  });

  return _initPromise;
}

export function prewarmDictionaryDb() {
  // 后台触发，不阻塞 UI。下载过程通过 subscribeDictionaryDbStatus 暴露给 UI
  void openDictionaryDb().catch((error) => {
    console.warn('[Dictionary] prewarm failed', error);
  });
}
