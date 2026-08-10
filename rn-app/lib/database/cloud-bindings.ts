/**
 * Cloud drive bindings — SQLite-backed (v3).
 *
 * Source of truth for:
 *   - Baidu pan OAuth binding + app config + default provider
 *     (app_config table, key-value JSON)
 *   - Per-scene selected provider (scene_provider_selection)
 *   - Per (scene, provider) download metadata (downloaded_scene_source)
 *   - Per (scene, provider) official content sync state
 *     (official_scene_sync_record)
 *
 * Public API mirrors the legacy @cloud_drive_bindings_v1 store 1:1 so
 * callers (cloud-video-playback.ts, etc.) don't need any change.
 *
 * See docs/2026-08-05-storage-migration-plan.md.
 */

import { getDatabase } from './schema';

export type CloudVideoProvider = 'baidu_pan';
export type BaiduPanAuthMode = 'code' | 'token';

export type BaiduPanAppConfig = {
  appKey: string;
  secretKey: string;
  redirectUri: string;
  scope: string;
  appNumericId: string;
  signKey: string;
  shareSecret: string;
  shareThirdId: string;
};

export type OfficialSceneAssetKeys = {
  videoKey: string;
  subtitleKey: string;
  subtitleEnSegmentedKey?: string;
  subtitleZhKey?: string;
};

export type BaiduPanToken = {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  scope: string;
  savedAt: string;
};

export type BaiduPanBinding = {
  rootPath: string;
  token: BaiduPanToken | null;
};

export type DownloadedSceneSource = {
  sceneId: string;
  provider: CloudVideoProvider;
  localVideoUri?: string;
  targetFileUri?: string;
  remotePath?: string;
  remoteUrl?: string;
  remoteUrlResolvedAt?: string;
  resumeData?: string;
  totalBytesWritten?: number;
  totalBytesExpectedToWrite?: number;
  speedBytesPerSecond?: number;
  status: 'idle' | 'resolving' | 'downloading' | 'paused' | 'completed' | 'error';
  progress: number;
  errorMessage?: string;
  updatedAt: string;
};

export type OfficialSceneSyncStatus = 'not_synced' | 'available' | 'stale' | 'error';

export type OfficialSceneSyncRecord = {
  sceneId: string;
  provider: CloudVideoProvider;
  officialVideoKey: string;
  syncedOfficialVideoKey?: string;
  remotePath?: string;
  remoteFileId?: number;
  bindingType?: 'scanned' | 'manual';
  status: OfficialSceneSyncStatus;
  errorMessage?: string;
  lastCheckedAt: string;
};

export type VideoSourceProviderState = {
  provider: CloudVideoProvider;
  label: string;
  isConfigured: boolean;
  isSelected: boolean;
  hasLocalCache: boolean;
  isReady: boolean;
  playbackMode: 'none' | 'remote' | 'local';
  syncStatus: 'not_connected' | 'not_synced' | 'available' | 'cached' | 'stale' | 'error';
  rootPath?: string;
  errorMessage?: string;
  lastCheckedAt?: string;
  remotePath?: string;
  officialVideoKey?: string;
  syncedOfficialVideoKey?: string;
  bindingType?: 'scanned' | 'manual';
};

// ── app_config row keys ────────────────────────────────────────────
const CONFIG_BAIDU_PAN_BINDING = 'baiduPanBinding';
const CONFIG_BAIDU_PAN_APP_CONFIG = 'baiduPanAppConfig';
const CONFIG_DEFAULT_PROVIDER = 'defaultProvider';

// ── Default app config (process.env → compile-time fallback) ──────
export const BAIDU_OAUTH_BASE = 'https://openapi.baidu.com';
export const DEFAULT_BAIDU_PAN_APP_CONFIG: BaiduPanAppConfig = {
  appKey: process.env.EXPO_PUBLIC_BAIDU_PAN_APP_KEY || 'Z2KeJosfv4IrzRVa1e85SIh5dhZ0XqJq',
  secretKey: process.env.EXPO_PUBLIC_BAIDU_PAN_SECRET_KEY || 'GvawsF7b3vRjlrx9wpMKKuQUjixXnccN',
  redirectUri: process.env.EXPO_PUBLIC_BAIDU_PAN_REDIRECT_URI || 'oob',
  scope: process.env.EXPO_PUBLIC_BAIDU_PAN_SCOPE || 'basic,netdisk',
  appNumericId: process.env.EXPO_PUBLIC_BAIDU_PAN_APP_NUMERIC_ID || '122902579',
  signKey: process.env.EXPO_PUBLIC_BAIDU_PAN_SIGN_KEY || 'Ava8kIxBJmFLwi7t~zklEkjKrIb0sq-3',
  shareSecret: process.env.EXPO_PUBLIC_BAIDU_PAN_SHARE_SECRET || '',
  shareThirdId: process.env.EXPO_PUBLIC_BAIDU_PAN_SHARE_THIRD_ID || '0',
};

// ── Helpers ────────────────────────────────────────────────────────

function normalizeUnixPath(path: string, fallback: string = '/'): string {
  const raw = (path || fallback).trim();
  if (!raw || raw === '/') return '/';
  const withLeadingSlash = raw.startsWith('/') ? raw : `/${raw}`;
  return withLeadingSlash.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/+$/, '') || '/';
}

function normalizeBaiduPanAppConfig(config: BaiduPanAppConfig): BaiduPanAppConfig {
  return {
    appKey: config.appKey.trim(),
    secretKey: config.secretKey.trim(),
    redirectUri: config.redirectUri.trim(),
    scope: config.scope.trim(),
    appNumericId: config.appNumericId.trim(),
    signKey: config.signKey.trim(),
    shareSecret: config.shareSecret.trim(),
    shareThirdId: config.shareThirdId.trim(),
  };
}

function resolveBaiduPanAppConfig(config: Partial<BaiduPanAppConfig> | null | undefined): BaiduPanAppConfig {
  const incoming = normalizeBaiduPanAppConfig({
    ...DEFAULT_BAIDU_PAN_APP_CONFIG,
    ...(config || {}),
  });
  return {
    appKey: incoming.appKey || DEFAULT_BAIDU_PAN_APP_CONFIG.appKey,
    secretKey: incoming.secretKey || DEFAULT_BAIDU_PAN_APP_CONFIG.secretKey,
    redirectUri: incoming.redirectUri || DEFAULT_BAIDU_PAN_APP_CONFIG.redirectUri,
    scope: incoming.scope || DEFAULT_BAIDU_PAN_APP_CONFIG.scope,
    appNumericId: incoming.appNumericId || DEFAULT_BAIDU_PAN_APP_CONFIG.appNumericId,
    signKey: incoming.signKey || DEFAULT_BAIDU_PAN_APP_CONFIG.signKey,
    shareSecret: incoming.shareSecret,
    shareThirdId: incoming.shareThirdId || DEFAULT_BAIDU_PAN_APP_CONFIG.shareThirdId,
  };
}

function extractBaiduOAuthParam(raw: string, key: string): string | null {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = raw.match(new RegExp(`(?:^|[?#&\\s])${escapedKey}=([^&#\\s]+)`));
  return match ? decodeURIComponent(match[1]) : null;
}

function rowToAppConfigValue<T = any>(row: any): T | null {
  if (!row) return null;
  try {
    return JSON.parse(row.value_json) as T;
  } catch {
    return null;
  }
}

async function getConfigValue<T = any>(key: string): Promise<T | null> {
  const db = await getDatabase();
  const row: any = await db.getFirstAsync(
    'SELECT value_json FROM app_config WHERE key = ?',
    [key],
  );
  return rowToAppConfigValue<T>(row);
}

async function setConfigValue(key: string, value: any): Promise<void> {
  const db = await getDatabase();
  await db.runAsync(
    'INSERT OR REPLACE INTO app_config (key, value_json, updated_at) VALUES (?, ?, ?)',
    [key, JSON.stringify(value), Date.now()],
  );
}

async function clearConfigValue(key: string): Promise<void> {
  const db = await getDatabase();
  await db.runAsync('DELETE FROM app_config WHERE key = ?', [key]);
}

function rowToDownloadedSource(row: any): DownloadedSceneSource {
  return {
    sceneId: row.scene_id,
    provider: row.provider,
    localVideoUri: row.local_video_uri ?? undefined,
    targetFileUri: row.target_file_uri ?? undefined,
    remotePath: row.remote_path ?? undefined,
    remoteUrl: row.remote_url ?? undefined,
    remoteUrlResolvedAt: row.remote_url_resolved_at ?? undefined,
    resumeData: row.resume_data ?? undefined,
    totalBytesWritten: row.total_bytes_written ?? undefined,
    totalBytesExpectedToWrite: row.total_bytes_expected_to_write ?? undefined,
    speedBytesPerSecond: row.speed_bytes_per_second ?? undefined,
    status: row.status,
    progress: row.progress,
    errorMessage: row.error_message ?? undefined,
    updatedAt: row.updated_at,
  };
}

function rowToSyncRecord(row: any): OfficialSceneSyncRecord {
  return {
    sceneId: row.scene_id,
    provider: row.provider,
    officialVideoKey: row.official_video_key,
    syncedOfficialVideoKey: row.synced_official_video_key ?? undefined,
    remotePath: row.remote_path ?? undefined,
    remoteFileId: row.remote_file_id ?? undefined,
    bindingType: row.binding_type ?? undefined,
    status: row.status,
    errorMessage: row.error_message ?? undefined,
    lastCheckedAt: row.last_checked_at,
  };
}

function getConfiguredProvidersFromBinding(binding: BaiduPanBinding | null): CloudVideoProvider[] {
  if (binding?.token?.accessToken && binding.rootPath) return ['baidu_pan'];
  return [];
}

function resolveEffectiveDefaultProvider(
  defaultProvider: CloudVideoProvider | null,
  configured: CloudVideoProvider[],
): CloudVideoProvider | null {
  if (defaultProvider && configured.includes(defaultProvider)) return defaultProvider;
  if (configured.length === 1) return configured[0];
  return null;
}

// ── App config: Baidu pan app config ───────────────────────────────

export async function getBaiduPanAppConfig(): Promise<BaiduPanAppConfig> {
  const stored = await getConfigValue<Partial<BaiduPanAppConfig>>(CONFIG_BAIDU_PAN_APP_CONFIG);
  return resolveBaiduPanAppConfig(stored);
}

export async function saveBaiduPanAppConfig(config: BaiduPanAppConfig): Promise<void> {
  await setConfigValue(CONFIG_BAIDU_PAN_APP_CONFIG, normalizeBaiduPanAppConfig(config));
}

// ── OAuth URL helpers (pure functions) ──────────────────────────────

export async function buildBaiduOAuthUrl(mode: BaiduPanAuthMode = 'token'): Promise<string> {
  const config = await getBaiduPanAppConfig();
  if (!config.redirectUri) {
    throw new Error('请先配置 EXPO_PUBLIC_BAIDU_PAN_REDIRECT_URI，并确保它已在百度开放平台安全设置中登记');
  }
  const params = new URLSearchParams({
    response_type: mode,
    client_id: config.appKey,
    redirect_uri: config.redirectUri,
    scope: config.scope,
    display: 'mobile',
  });
  return `${BAIDU_OAUTH_BASE}/oauth/2.0/authorize?${params.toString()}`;
}

export function parseBaiduImplicitTokenFromUrl(url: string): BaiduPanToken | null {
  const accessToken = extractBaiduOAuthParam(url, 'access_token');
  if (!accessToken) return null;
  const expiresInRaw = extractBaiduOAuthParam(url, 'expires_in');
  const expiresIn = expiresInRaw && Number.isFinite(Number(expiresInRaw))
    ? Number(expiresInRaw)
    : 2592000;
  const scope = (extractBaiduOAuthParam(url, 'scope') || DEFAULT_BAIDU_PAN_APP_CONFIG.scope).replace(/\+/g, ' ');
  return {
    accessToken,
    refreshToken: '',
    expiresIn,
    scope,
    savedAt: new Date().toISOString(),
  };
}

export function isBaiduOAuthCallbackCandidate(url: string, redirectUri: string = ''): boolean {
  if (url.includes('access_token=') || /(?:\?|&)code=/.test(url) || url.startsWith('oob')) {
    return true;
  }
  if (!redirectUri || redirectUri === 'oob') return false;
  return url.startsWith(redirectUri);
}

export async function saveBaiduPanImplicitTokenFromUrl(url: string): Promise<BaiduPanToken> {
  const token = parseBaiduImplicitTokenFromUrl(url);
  if (!token) {
    throw new Error('未从百度授权结果中解析到 access_token');
  }
  const existing = await getBaiduPanBinding();
  await saveBaiduPanBinding({
    rootPath: existing?.rootPath || '/',
    token,
  });
  return token;
}

export async function exchangeBaiduCodeForToken(code: string): Promise<BaiduPanToken> {
  const config = await getBaiduPanAppConfig();
  const params = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    client_id: config.appKey,
    client_secret: config.secretKey,
    redirect_uri: config.redirectUri,
  });
  const resp = await fetch(`${BAIDU_OAUTH_BASE}/oauth/2.0/token?${params.toString()}`, {
    method: 'GET',
    headers: { 'User-Agent': 'pan.baidu.com' },
  });
  const json = await resp.json();
  if (json.error || !json.access_token) {
    throw new Error(json.error_description || json.error || '百度网盘授权失败');
  }
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token || '',
    expiresIn: json.expires_in || 2592000,
    scope: json.scope || '',
    savedAt: new Date().toISOString(),
  };
}

// ── Baidu pan binding ──────────────────────────────────────────────

export async function getBaiduPanBinding(): Promise<BaiduPanBinding | null> {
  return await getConfigValue<BaiduPanBinding>(CONFIG_BAIDU_PAN_BINDING);
}

export async function saveBaiduPanBinding(binding: BaiduPanBinding): Promise<void> {
  await setConfigValue(CONFIG_BAIDU_PAN_BINDING, {
    rootPath: normalizeUnixPath(binding.rootPath || '/'),
    token: binding.token,
  });
  invalidateDefaultProviderCache();
}

export async function clearBaiduPanAuthorization(): Promise<void> {
  const db = await getDatabase();
  await db.execAsync('BEGIN');
  try {
    await clearConfigValue(CONFIG_BAIDU_PAN_BINDING);
    const storedDefault = await getConfigValue<CloudVideoProvider>(CONFIG_DEFAULT_PROVIDER);
    if (storedDefault === 'baidu_pan') {
      await clearConfigValue(CONFIG_DEFAULT_PROVIDER);
    }
    await db.runAsync('DELETE FROM scene_provider_selection');
    await db.runAsync(
      "DELETE FROM official_scene_sync_record WHERE provider = 'baidu_pan'",
    );
    await db.execAsync('COMMIT');
    invalidateDefaultProviderCache();
  } catch (e) {
    try { await db.execAsync('ROLLBACK'); } catch { /* ignore */ }
    throw e;
  }
}

// ── Default provider ───────────────────────────────────────────────

// In-memory 5s TTL cache for getDefaultCloudProvider. This is called
// ~30x per scene-summary build, so without it we hit SQLite 30x for
// the same value. Writes to app_config / baiduPanBinding / sync records
// also clear this so stale values don't linger longer than 5 s.
const DEFAULT_PROVIDER_TTL_MS = 5000;
let defaultProviderCache: { value: CloudVideoProvider | null; expiresAt: number } | null = null;
function invalidateDefaultProviderCache() {
  defaultProviderCache = null;
}

export async function getDefaultCloudProvider(): Promise<CloudVideoProvider | null> {
  const now = Date.now();
  if (defaultProviderCache && defaultProviderCache.expiresAt > now) {
    return defaultProviderCache.value;
  }
  const binding = await getBaiduPanBinding();
  const configured = getConfiguredProvidersFromBinding(binding);
  const storedDefault = await getConfigValue<CloudVideoProvider>(CONFIG_DEFAULT_PROVIDER);
  const validDefault = storedDefault === 'baidu_pan' ? storedDefault : null;
  const result = resolveEffectiveDefaultProvider(validDefault, configured);
  defaultProviderCache = { value: result, expiresAt: now + DEFAULT_PROVIDER_TTL_MS };
  return result;
}

export async function saveDefaultCloudProvider(provider: CloudVideoProvider | null): Promise<void> {
  if (provider === null) {
    await clearConfigValue(CONFIG_DEFAULT_PROVIDER);
  } else {
    await setConfigValue(CONFIG_DEFAULT_PROVIDER, provider);
  }
  invalidateDefaultProviderCache();
  // Mirror legacy behaviour: saving default wipes per-scene selection.
  const db = await getDatabase();
  await db.runAsync('DELETE FROM scene_provider_selection');
}

export async function getConfiguredCloudProviders(): Promise<CloudVideoProvider[]> {
  const binding = await getBaiduPanBinding();
  return getConfiguredProvidersFromBinding(binding);
}

// ── Per-scene selected provider ────────────────────────────────────

export async function getSelectedCloudProvider(sceneId: string): Promise<CloudVideoProvider | null> {
  const db = await getDatabase();
  const row: any = await db.getFirstAsync(
    'SELECT provider FROM scene_provider_selection WHERE scene_id = ?',
    [sceneId],
  );
  if (!row?.provider) return null;
  return row.provider === 'baidu_pan' ? 'baidu_pan' : null;
}

export async function saveSelectedCloudProvider(
  sceneId: string,
  provider: CloudVideoProvider,
): Promise<void> {
  const db = await getDatabase();
  await db.runAsync(
    'INSERT OR REPLACE INTO scene_provider_selection (scene_id, provider, updated_at) VALUES (?, ?, ?)',
    [sceneId, provider, Date.now()],
  );
}

// ── Downloaded scene source ────────────────────────────────────────

export async function getDownloadedSceneSource(
  sceneId: string,
  provider: CloudVideoProvider,
): Promise<DownloadedSceneSource | null> {
  const db = await getDatabase();
  const row: any = await db.getFirstAsync(
    'SELECT * FROM downloaded_scene_source WHERE scene_id = ? AND provider = ?',
    [sceneId, provider],
  );
  return row ? rowToDownloadedSource(row) : null;
}

export async function listDownloadedSceneSources(): Promise<DownloadedSceneSource[]> {
  const db = await getDatabase();
  const rows: any[] = await db.getAllAsync(
    'SELECT * FROM downloaded_scene_source ORDER BY updated_at DESC',
  );
  return rows.map(rowToDownloadedSource);
}

export async function upsertDownloadedSceneSource(entry: DownloadedSceneSource): Promise<void> {
  const db = await getDatabase();
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

export async function deleteDownloadedSceneSource(
  sceneId: string,
  provider: CloudVideoProvider,
): Promise<void> {
  const db = await getDatabase();
  await db.runAsync(
    'DELETE FROM downloaded_scene_source WHERE scene_id = ? AND provider = ?',
    [sceneId, provider],
  );
}

// ── Official scene sync record ─────────────────────────────────────

export async function getOfficialSceneSyncRecord(
  sceneId: string,
  provider: CloudVideoProvider,
): Promise<OfficialSceneSyncRecord | null> {
  const db = await getDatabase();
  const row: any = await db.getFirstAsync(
    'SELECT * FROM official_scene_sync_record WHERE scene_id = ? AND provider = ?',
    [sceneId, provider],
  );
  return row ? rowToSyncRecord(row) : null;
}

export async function listOfficialSceneSyncRecords(): Promise<OfficialSceneSyncRecord[]> {
  const db = await getDatabase();
  const rows: any[] = await db.getAllAsync(
    'SELECT * FROM official_scene_sync_record ORDER BY last_checked_at DESC',
  );
  return rows.map(rowToSyncRecord);
}

export async function upsertOfficialSceneSyncRecord(entry: OfficialSceneSyncRecord): Promise<void> {
  const db = await getDatabase();
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

export async function bindOfficialSceneToProvider(params: {
  sceneId: string;
  provider: CloudVideoProvider;
  officialVideoKey: string;
  remotePath: string;
  remoteFileId?: number;
}): Promise<void> {
  const previous = await getOfficialSceneSyncRecord(params.sceneId, params.provider);
  await upsertOfficialSceneSyncRecord({
    sceneId: params.sceneId,
    provider: params.provider,
    officialVideoKey: params.officialVideoKey,
    syncedOfficialVideoKey: params.officialVideoKey,
    remotePath: normalizeUnixPath(params.remotePath),
    remoteFileId: params.remoteFileId,
    bindingType: 'manual',
    status: 'available',
    errorMessage: undefined,
    lastCheckedAt: previous?.lastCheckedAt || new Date().toISOString(),
  });
}

export async function unbindOfficialSceneFromProvider(
  sceneId: string,
  provider: CloudVideoProvider,
): Promise<void> {
  const db = await getDatabase();
  await db.runAsync(
    'DELETE FROM official_scene_sync_record WHERE scene_id = ? AND provider = ?',
    [sceneId, provider],
  );
}

export async function replaceOfficialSceneSyncRecords(
  entries: OfficialSceneSyncRecord[],
): Promise<void> {
  const db = await getDatabase();
  await db.execAsync('BEGIN');
  try {
    await db.runAsync('DELETE FROM official_scene_sync_record');
    for (const entry of entries) {
      await upsertOfficialSceneSyncRecord(entry);
    }
    await db.execAsync('COMMIT');
  } catch (e) {
    try { await db.execAsync('ROLLBACK'); } catch { /* ignore */ }
    throw e;
  }
}

// ── Derived: provider states (used by UI) ──────────────────────────

export async function getOfficialSceneProviderStates(
  sceneId: string,
): Promise<VideoSourceProviderState[]> {
  const binding = await getBaiduPanBinding();
  const cached = await getDownloadedSceneSource(sceneId, 'baidu_pan');
  const sync = await getOfficialSceneSyncRecord(sceneId, 'baidu_pan');
  const defaultProvider = await getDefaultCloudProvider();
  const hasLocalCache = !!(cached?.localVideoUri && cached.status === 'completed');
  const isConfigured = Boolean(binding?.token?.accessToken && binding.rootPath);
  const syncStatus: VideoSourceProviderState['syncStatus'] = hasLocalCache
    ? 'cached'
    : !isConfigured
      ? 'not_connected'
      : sync?.status === 'stale'
        ? 'stale'
        : sync?.status === 'error'
          ? 'error'
          : sync?.status === 'available'
            ? 'available'
            : 'not_synced';
  return [
    {
      provider: 'baidu_pan',
      label: '百度',
      isConfigured,
      isSelected: defaultProvider === 'baidu_pan',
      hasLocalCache,
      isReady: hasLocalCache || sync?.status === 'available',
      playbackMode: hasLocalCache
        ? 'local'
        : sync?.status === 'available'
          ? 'remote'
          : 'none',
      syncStatus,
      rootPath: binding?.rootPath,
      errorMessage: sync?.errorMessage,
      lastCheckedAt: sync?.lastCheckedAt,
      remotePath: sync?.remotePath,
      officialVideoKey: sync?.officialVideoKey,
      syncedOfficialVideoKey: sync?.syncedOfficialVideoKey,
      bindingType: sync?.bindingType,
    },
  ];
}
