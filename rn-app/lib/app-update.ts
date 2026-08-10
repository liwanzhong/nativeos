import AsyncStorage from '@react-native-async-storage/async-storage';
import Constants from 'expo-constants';
import {
  cacheDirectory,
  createDownloadResumable,
  deleteAsync,
  documentDirectory,
  getContentUriAsync,
  getInfoAsync,
  makeDirectoryAsync,
  readAsStringAsync,
} from 'expo-file-system/legacy';
import { Platform } from 'react-native';
import { z } from 'zod';

const DEFAULT_ANDROID_UPDATE_MANIFEST_URL = 'https://nativeos.oss-cn-beijing.aliyuncs.com/app/android/version.json';
const ANDROID_UPDATE_SKIP_KEY = 'android_update_skipped_version_code';
const APK_MIME_TYPE = 'application/vnd.android.package-archive';
const FLAG_GRANT_READ_URI_PERMISSION = 1;
const FLAG_ACTIVITY_NEW_TASK = 268435456;

const androidUpdateManifestSchema = z.object({
  versionName: z.string().min(1),
  versionCode: z.number().int().positive(),
  downloadUrl: z.string().url(),
  forceUpdate: z.boolean().optional().default(false),
  minSupportedVersionCode: z.number().int().positive().optional(),
  releaseNotes: z.union([z.string(), z.array(z.string())]).optional(),
  apkMd5: z.string().min(1).optional(),
  apkSizeBytes: z.number().int().positive().optional(),
  publishedAt: z.string().min(1).optional(),
});

type AndroidUpdateManifest = z.infer<typeof androidUpdateManifestSchema>;

export type AndroidUpdateInfo = AndroidUpdateManifest & {
  manifestUrl: string;
  localVersionName: string;
  localVersionCode: number;
  isMandatory: boolean;
  releaseNotes: string[];
};

export type AndroidUpdateCheckResult =
  | { status: 'unsupported' | 'disabled' | 'upToDate' }
  | { status: 'available'; update: AndroidUpdateInfo };

interface CheckForAndroidAppUpdateOptions {
  ignoreSkippedVersion?: boolean;
}

function getAndroidUpdateManifestUrl() {
  return process.env.EXPO_PUBLIC_ANDROID_UPDATE_MANIFEST_URL || DEFAULT_ANDROID_UPDATE_MANIFEST_URL;
}

function getLocalVersionName() {
  return Constants.expoConfig?.version || '0.0.0';
}

function getLocalVersionCode() {
  const value = Constants.expoConfig?.android?.versionCode;
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function normalizeReleaseNotes(releaseNotes?: string | string[]) {
  if (!releaseNotes) return [];
  if (Array.isArray(releaseNotes)) {
    return releaseNotes.map((item) => item.trim()).filter(Boolean);
  }
  return releaseNotes
    .split('\n')
    .map((item) => item.trim())
    .filter(Boolean);
}

function isAndroidStandaloneLike() {
  return Platform.OS === 'android' && Constants.executionEnvironment !== 'storeClient';
}

function sanitizeManifestResponseText(responseText: string) {
  return responseText.replace(/^[\uFEFF\u200B\u200C\u200D]+/, '');
}

export async function checkForAndroidAppUpdate(
  options: CheckForAndroidAppUpdateOptions = {},
): Promise<AndroidUpdateCheckResult> {
  if (!isAndroidStandaloneLike()) {
    return { status: 'unsupported' };
  }

  const manifestUrl = getAndroidUpdateManifestUrl();
  if (!manifestUrl) {
    return { status: 'disabled' };
  }

  const separator = manifestUrl.includes('?') ? '&' : '?';
  const requestUrl = `${manifestUrl}${separator}t=${Date.now()}`;
  const response = await fetch(requestUrl, {
    headers: {
      'Cache-Control': 'no-cache',
    },
  });
  const responseText = await response.text();
  const sanitizedResponseText = sanitizeManifestResponseText(responseText);

  if (!response.ok) {
    throw new Error(`更新清单请求失败：${response.status}`);
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(sanitizedResponseText);
  } catch (error) {
    const contentType = response.headers.get('content-type') || 'unknown';
    console.warn('Android update manifest parse failed', {
      manifestUrl,
      requestUrl,
      status: response.status,
      contentType,
      bodyPreview: responseText.slice(0, 500),
      leadingCharCodes: Array.from(responseText.slice(0, 5)).map((char) => char.charCodeAt(0)),
      error,
    });
    throw new Error(`更新清单不是合法 JSON。status=${response.status}, content-type=${contentType}`);
  }

  const parsed = androidUpdateManifestSchema.parse(parsedJson);
  const localVersionCode = getLocalVersionCode();
  if (parsed.versionCode <= localVersionCode) {
    return { status: 'upToDate' };
  }

  const isMandatory = parsed.forceUpdate || (
    typeof parsed.minSupportedVersionCode === 'number' && localVersionCode < parsed.minSupportedVersionCode
  );

  if (!isMandatory && !options.ignoreSkippedVersion) {
    const skippedVersionCode = Number(await AsyncStorage.getItem(ANDROID_UPDATE_SKIP_KEY));
    if (Number.isFinite(skippedVersionCode) && skippedVersionCode === parsed.versionCode) {
      return { status: 'upToDate' };
    }
  }

  return {
    status: 'available',
    update: {
      ...parsed,
      manifestUrl,
      localVersionName: getLocalVersionName(),
      localVersionCode,
      isMandatory,
      releaseNotes: normalizeReleaseNotes(parsed.releaseNotes),
    },
  };
}

export async function markAndroidUpdateSkipped(versionCode: number) {
  await AsyncStorage.setItem(ANDROID_UPDATE_SKIP_KEY, String(versionCode));
}

export async function clearSkippedAndroidUpdate() {
  await AsyncStorage.removeItem(ANDROID_UPDATE_SKIP_KEY);
}

function getUpdateDirectory() {
  const baseDir = documentDirectory || cacheDirectory;
  if (!baseDir) {
    throw new Error('设备存储目录不可用');
  }
  return `${baseDir}app-updates`;
}

function buildApkFileUri(versionCode: number) {
  return `${getUpdateDirectory()}/nativeos-${versionCode}.apk`;
}

type IntentLauncherModule = {
  startActivityAsync: (activityAction: string, params?: Record<string, unknown>) => Promise<unknown>;
};

function resolveIntentLauncherModule(candidate: unknown): IntentLauncherModule | null {
  const resolvedModule: Partial<IntentLauncherModule> = (candidate as { default?: Partial<IntentLauncherModule> })?.default?.startActivityAsync
    ? (candidate as { default: Partial<IntentLauncherModule> }).default
    : (candidate as Partial<IntentLauncherModule>);

  if (!resolvedModule?.startActivityAsync) {
    return null;
  }

  return resolvedModule as IntentLauncherModule;
}

function loadIntentLauncherModule(): IntentLauncherModule {
  try {
    const intentLauncherModule = require('expo-intent-launcher');
    const resolvedModule = resolveIntentLauncherModule(intentLauncherModule);

    if (resolvedModule) {
      return resolvedModule;
    }

    console.warn('Expo intent launcher module shape unexpected', {
      moduleSpecifier: 'expo-intent-launcher',
      moduleKeys: Object.keys(intentLauncherModule ?? {}),
      defaultKeys: Object.keys(intentLauncherModule?.default ?? {}),
    });
  } catch (error) {
    console.warn('Expo intent launcher require failed', {
      moduleSpecifier: 'expo-intent-launcher',
      error,
    });
  }

  try {
    const intentLauncherModule = require('expo-intent-launcher/build/IntentLauncher');
    const resolvedModule = resolveIntentLauncherModule(intentLauncherModule);

    if (resolvedModule) {
      return resolvedModule;
    }

    console.warn('Expo intent launcher module shape unexpected', {
      moduleSpecifier: 'expo-intent-launcher/build/IntentLauncher',
      moduleKeys: Object.keys(intentLauncherModule ?? {}),
      defaultKeys: Object.keys(intentLauncherModule?.default ?? {}),
    });
  } catch (error) {
    console.warn('Expo intent launcher require failed', {
      moduleSpecifier: 'expo-intent-launcher/build/IntentLauncher',
      error,
    });
  }

  try {
    const intentLauncherModule = require('expo-intent-launcher/build/IntentLauncher.js');
    const resolvedModule = resolveIntentLauncherModule(intentLauncherModule);

    if (resolvedModule) {
      return resolvedModule;
    }

    console.warn('Expo intent launcher module shape unexpected', {
      moduleSpecifier: 'expo-intent-launcher/build/IntentLauncher.js',
      moduleKeys: Object.keys(intentLauncherModule ?? {}),
      defaultKeys: Object.keys(intentLauncherModule?.default ?? {}),
    });
  } catch (error) {
    console.warn('Expo intent launcher require failed', {
      moduleSpecifier: 'expo-intent-launcher/build/IntentLauncher.js',
      error,
    });
  }

  try {
    throw new Error('intent-launcher-export-missing');
  } catch (error) {
    console.warn('Expo intent launcher load failed', error);
    throw new Error('当前安装包未包含应用安装模块，请重新安装最新 Android 构建包后再试');
  }
}

async function logDownloadedFilePreview(fileUri: string, fileSize?: number) {
  if (!fileSize || fileSize > 16 * 1024) {
    return;
  }

  try {
    const preview = await readAsStringAsync(fileUri, {
      encoding: 'utf8',
    });
    console.warn('Android update downloaded file preview', {
      fileUri,
      fileSize,
      preview: preview.slice(0, 500),
    });
  } catch (error) {
    console.warn('Android update file preview read failed', {
      fileUri,
      fileSize,
      error,
    });
  }
}

export async function downloadAndroidUpdateApk(
  update: AndroidUpdateInfo,
  onProgress?: (progress: number) => void,
) {
  if (!isAndroidStandaloneLike()) {
    throw new Error('当前环境不支持应用内更新');
  }

  const updateDir = getUpdateDirectory();
  await makeDirectoryAsync(updateDir, { intermediates: true });

  const targetFileUri = buildApkFileUri(update.versionCode);
  const existingInfo = await getInfoAsync(targetFileUri, { md5: Boolean(update.apkMd5) });
  const existingMd5 = existingInfo.exists && 'md5' in existingInfo ? existingInfo.md5 : undefined;
  const existingSize = existingInfo.exists && 'size' in existingInfo ? existingInfo.size : undefined;
  console.log('Android update download start', {
    versionCode: update.versionCode,
    versionName: update.versionName,
    downloadUrl: update.downloadUrl,
    targetFileUri,
    expectedApkMd5: update.apkMd5,
    expectedApkSizeBytes: update.apkSizeBytes,
    existingFileExists: existingInfo.exists,
    existingFileMd5: existingMd5,
    existingFileSize: existingSize,
  });
  if (existingInfo.exists) {
    if (!update.apkMd5 || existingMd5?.toLowerCase() === update.apkMd5.toLowerCase()) {
      console.log('Android update download reuse cached apk', {
        targetFileUri,
        cachedMd5: existingMd5,
        cachedSize: existingSize,
      });
      onProgress?.(1);
      return targetFileUri;
    }

    console.warn('Android update cached apk hash mismatch, deleting stale file', {
      targetFileUri,
      cachedMd5: existingMd5,
      expectedApkMd5: update.apkMd5,
      cachedSize: existingSize,
    });
    await deleteAsync(targetFileUri, { idempotent: true });
  }

  const downloadResumable = createDownloadResumable(
    update.downloadUrl,
    targetFileUri,
    {},
    ({ totalBytesWritten, totalBytesExpectedToWrite }) => {
      if (!totalBytesExpectedToWrite || totalBytesExpectedToWrite <= 0) return;
      onProgress?.(Math.max(0, Math.min(1, totalBytesWritten / totalBytesExpectedToWrite)));
    },
  );

  const result = await downloadResumable.downloadAsync();
  if (!result?.uri) {
    throw new Error('下载更新包失败');
  }

  console.log('Android update download finished', {
    resultUri: result.uri,
  });

  if (update.apkMd5) {
    const fileInfo = await getInfoAsync(result.uri, { md5: true });
    const actualMd5 = fileInfo.exists && 'md5' in fileInfo ? fileInfo.md5 : undefined;
    const actualSize = fileInfo.exists && 'size' in fileInfo ? fileInfo.size : undefined;
    console.log('Android update apk verification', {
      resultUri: result.uri,
      actualMd5,
      expectedApkMd5: update.apkMd5,
      actualSize,
      expectedApkSizeBytes: update.apkSizeBytes,
      fileExists: fileInfo.exists,
    });
    if (!fileInfo.exists || !actualMd5 || actualMd5.toLowerCase() !== update.apkMd5.toLowerCase()) {
      await logDownloadedFilePreview(result.uri, actualSize);
      await deleteAsync(result.uri, { idempotent: true });
      throw new Error('安装包校验失败，请重新下载');
    }
  }

  onProgress?.(1);
  return result.uri;
}

export async function installAndroidUpdateApk(fileUri: string) {
  if (!isAndroidStandaloneLike()) {
    throw new Error('当前环境不支持安装更新包');
  }

  const IntentLauncher = loadIntentLauncherModule();
  const contentUri = await getContentUriAsync(fileUri);
  await IntentLauncher.startActivityAsync('android.intent.action.VIEW', {
    data: contentUri,
    type: APK_MIME_TYPE,
    flags: FLAG_GRANT_READ_URI_PERMISSION | FLAG_ACTIVITY_NEW_TASK,
  });
}
