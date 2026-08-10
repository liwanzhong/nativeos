/**
 * Re-export of the SQLite-backed cloud bindings module.
 *
 * Historical: this file used to hold a single AsyncStorage JSON store
 * (@cloud_drive_bindings_v1) which caused write-amplification: every
 * scene download wrote the entire store. As of schema v3 the store is
 * split into 4 SQL tables (see docs/2026-08-05-storage-migration-plan.md).
 *
 * The API surface stays 1:1 — only the storage backend changed.
 */

export {
  BAIDU_OAUTH_BASE,
  DEFAULT_BAIDU_PAN_APP_CONFIG,
  bindOfficialSceneToProvider,
  buildBaiduOAuthUrl,
  clearBaiduPanAuthorization,
  deleteDownloadedSceneSource,
  exchangeBaiduCodeForToken,
  getBaiduPanAppConfig,
  getBaiduPanBinding,
  getConfiguredCloudProviders,
  getDefaultCloudProvider,
  getDownloadedSceneSource,
  getOfficialSceneProviderStates,
  getOfficialSceneSyncRecord,
  getSelectedCloudProvider,
  isBaiduOAuthCallbackCandidate,
  listDownloadedSceneSources,
  listOfficialSceneSyncRecords,
  parseBaiduImplicitTokenFromUrl,
  replaceOfficialSceneSyncRecords,
  saveBaiduPanAppConfig,
  saveBaiduPanBinding,
  saveBaiduPanImplicitTokenFromUrl,
  saveDefaultCloudProvider,
  saveSelectedCloudProvider,
  unbindOfficialSceneFromProvider,
  upsertDownloadedSceneSource,
  upsertOfficialSceneSyncRecord,
} from '../database/cloud-bindings';

export type {
  BaiduPanAppConfig,
  BaiduPanAuthMode,
  BaiduPanBinding,
  BaiduPanToken,
  CloudVideoProvider,
  DownloadedSceneSource,
  OfficialSceneAssetKeys,
  OfficialSceneSyncRecord,
  OfficialSceneSyncStatus,
  VideoSourceProviderState,
} from '../database/cloud-bindings';
