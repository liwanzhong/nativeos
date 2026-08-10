/**
 * Backup/Restore — share a finished backup zip via the system share sheet.
 *
 * Implementation: instead of using `expo-sharing` or `expo-intent-launcher`
 * (both of which call `Activity.startActivityForResult` and then wait for
 * an `onActivityResult` callback — a callback that on some devices /
 * emulators never arrives when the user dismisses the chooser via
 * home/recents, causing the JS promise to hang forever — AND which keep
 * a native "activity is already started" flag that blocks subsequent
 * calls), we ship our own fire-and-forget native module:
 * `com.nativeos.app.chooser.ChooserModule`. It calls
 * `Activity.startActivity(Intent.createChooser(...))` and resolves the
 * promise *immediately* — no callback, no flag, no race. The system
 * owns the chooser once it pops; we don't need to know how the user
 * resolved it.
 *
 * The local file path is converted to a `content://` URI via
 * `expo-file-system`'s `getContentUriAsync` (expo already wires up
 * `FileProvider` for us), and we set `FLAG_GRANT_READ_URI_PERMISSION`
 * so the receiving app can read the file.
 *
 * The file is still on disk in the app's private
 * `documentDirectory/backups/exports/`; you can pull it via:
 *   adb pull /data/data/com.nativeos.app/files/backups/exports/<file>.zip
 */

import { NativeModules } from 'react-native';
import { getInfoAsync, getContentUriAsync } from 'expo-file-system/legacy';

export type ShareOutcome = 'shared' | 'dismissed' | 'error';

export interface ShareResult {
  outcome: ShareOutcome;
  /** Internal app path — useful when share fails and user wants adb pull. */
  internalPath?: string;
  message?: string;
}

const MIME_TYPE = 'application/zip';
const CHOOSER_TITLE = 'NativeOS 备份';

// Reuse the same module shape from the native side: see
// `rn-app/android/app/src/main/java/com/nativeos/app/chooser/ChooserModule.kt`.
interface NativeChooser {
  open(contentUri: string, mimeType: string, title: string): Promise<void>;
}

const NativeChooserModule: NativeChooser | undefined =
  (NativeModules as Record<string, unknown>).NativeChooser as
    | NativeChooser
    | undefined;

export async function shareBackupZip(zipPath: string): Promise<ShareResult> {
  console.log('[shareBackupZip] start', { zipPath });

  const info = await getInfoAsync(zipPath);
  console.log('[shareBackupZip] fileInfo', { exists: info.exists, size: info.size });
  if (!info.exists) {
    return { outcome: 'error', message: '备份文件不存在' };
  }

  let contentUri: string;
  try {
    contentUri = await getContentUriAsync(zipPath);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.log('[shareBackupZip] getContentUriAsync threw', { msg });
    return {
      outcome: 'error',
      internalPath: zipPath,
      message: `准备分享失败：${msg}`,
    };
  }
  console.log('[shareBackupZip] contentUri', { contentUri });

  if (!NativeChooserModule) {
    return {
      outcome: 'error',
      internalPath: zipPath,
      message: 'NativeChooser 原生模块未注册。请检查 MainApplication.kt 是否添加了 ChooserPackage。',
    };
  }

  try {
    console.log('[shareBackupZip] chooser open', { contentUri });
    await NativeChooserModule.open(contentUri, MIME_TYPE, CHOOSER_TITLE);
    console.log('[shareBackupZip] result done');
    return { outcome: 'shared' };
  } catch (e: any) {
    // native 抛过来的 code (RN Promise reject 会塞到 e.code / e.message)
    const code = typeof e?.code === 'string' ? e.code : '';
    const msg = e instanceof Error ? e.message : String(e);
    console.log('[shareBackupZip] chooser threw', { code, msg });
    if (code === 'E_NO_HANDLER') {
      return {
        outcome: 'error',
        internalPath: zipPath,
        message:
          '当前设备没有应用能处理 .zip 备份(MuMu 等精简模拟器上常见)。' +
          '备份文件已保留,可用 adb pull 或系统文件管理器取出。',
      };
    }
    return {
      outcome: 'error',
      internalPath: zipPath,
      message: `分享失败：${msg}`,
    };
  }
}
