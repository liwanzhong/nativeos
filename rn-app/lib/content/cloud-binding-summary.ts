/**
 * Per-series / per-scene cloud-drive binding + cache summary.
 *
 * Aggregates two SQLite tables into a single, easy-to-consume map
 * for the library page (and any other UI that needs to know
 * "is this official video bound to the user's Baidu pan, and is
 * it already cached locally?"):
 *
 *   - `official_scene_sync_record` → `bound: 'bound' | 'unbound' | 'stale' | 'error' | 'not_synced'`
 *   - `downloaded_scene_source`    → `cached: 'remote' | 'downloading' | 'cached' | 'error'`
 *
 * Important id-mapping note:
 *   The library page operates on **series ids** (e.g.
 *   "a1-beginner-english"), but `OfficialSceneSyncRecord.sceneId`
 *   holds the **episode / scene id** (e.g.
 *   "a1-beginner-english__1"). Each scene's `groupId` equals its
 *   series id, so we resolve the series→scene mapping via
 *   `listOfficialSceneCatalog()` and then aggregate per scene
 *   before folding back to series.
 *
 * Aggregation rules (per series, the worst-case across its scenes):
 *   bound  = any scene 'bound' → 'bound' | else any 'stale' → 'stale'
 *           | else any 'error' → 'error' | else 'unbound'
 *   cached = any scene 'cached' → 'cached' | else any 'downloading'
 *           → 'downloading' | else any 'error' → 'error' | else 'remote'
 *
 * The library page passes a list of series ids; this module joins
 * the catalog + both SQLite tables in-process and returns a per-id
 * record. Memoised by series-id-set so back-to-back useFocusEffect
 * loads don't hit SQLite on every render.
 *
 * Cache invalidation:
 *   Call `invalidateOfficialSceneBindingStatusCache()` from any
 *   mutation path (pick/unpick, sync rescan, download complete)
 *   so the next read picks up the new state.
 */

import {
  listDownloadedSceneSources,
  listOfficialSceneSyncRecords,
  type CloudVideoProvider,
  type DownloadedSceneSource,
  type OfficialSceneSyncRecord,
} from '../database/cloud-bindings';
import { listOfficialSceneCatalog } from './video-scenes';

export type SceneBindingStatus = 'bound' | 'unbound' | 'stale' | 'error' | 'not_synced';
export type SceneCacheStatus = 'remote' | 'downloading' | 'cached' | 'error';

export interface SceneBindingSnapshot {
  bound: SceneBindingStatus;
  cached: SceneCacheStatus;
  /** Which provider the binding/cache status is for. `undefined`
   *  when nothing is bound (caller decides the default copy). */
  provider?: CloudVideoProvider;
  /** Remote path on the cloud drive (only set when bound). */
  remotePath?: string;
  /** Local cache file URI (only set when cached). */
  localCacheUri?: string;
}

type CacheKey = string;

let memoisedSnapshot: { key: CacheKey; value: Record<string, SceneBindingSnapshot> } | null = null;

function buildCacheKey(sceneIds: readonly string[], provider: CloudVideoProvider): CacheKey {
  // Stable join; caller passes sceneIds from the same Supabase
  // fetch each focus, so identity order is fine.
  return `${provider}::${[...sceneIds].sort().join('|')}`;
}

function deriveBindingStatus(record: OfficialSceneSyncRecord | undefined): SceneBindingStatus {
  if (!record) return 'not_synced';
  switch (record.status) {
    case 'available': return 'bound';
    case 'stale': return 'stale';
    case 'error': return 'error';
    case 'not_synced': return 'unbound';
    default: return 'not_synced';
  }
}

function deriveCacheStatus(
  downloadedLocalUri: string | undefined,
  downloadedStatus: string | undefined,
): SceneCacheStatus {
  if (downloadedLocalUri && downloadedStatus === 'completed') return 'cached';
  if (downloadedStatus === 'downloading' || downloadedStatus === 'resolving') return 'downloading';
  if (downloadedStatus === 'error') return 'error';
  return 'remote';
}

/**
 * Return a `{ [seriesId]: SceneBindingSnapshot }` map for the
 * given provider. The library page passes **series ids** (e.g.
 * "a1-beginner-english"); this function resolves each series to
 * its scenes via `listOfficialSceneCatalog()`, looks up the
 * per-scene binding + cache, and folds back to series with a
 * "any scene wins" rule (see the module header for the full
 * aggregation rules).
 *
 * Reads are batched: a single `listOfficialSceneCatalog()` +
 * `listOfficialSceneSyncRecords()` + `listDownloadedSceneSources()`
 * call covers all requested series, regardless of count.
 */
export async function getOfficialSceneBindingStatus(
  seriesIds: readonly string[],
  provider: CloudVideoProvider = 'baidu_pan',
): Promise<Record<string, SceneBindingSnapshot>> {
  if (seriesIds.length === 0) return {};
  const cacheKey = buildCacheKey(seriesIds, provider);
  if (memoisedSnapshot && memoisedSnapshot.key === cacheKey) {
    return memoisedSnapshot.value;
  }
  const seriesIdSet = new Set(seriesIds);
  const [catalog, syncRecords, downloadRecords] = await Promise.all([
    listOfficialSceneCatalog(false).catch(() => []),
    listOfficialSceneSyncRecords().catch(() => [] as OfficialSceneSyncRecord[]),
    listDownloadedSceneSources().catch(() => [] as DownloadedSceneSource[]),
  ]);
  // Group catalog scenes by series id, filtered to the series
  // the caller asked about.
  const scenesBySeries = new Map<string, string[]>();
  for (const item of catalog) {
    const groupId = item.groupId;
    if (!groupId || !seriesIdSet.has(groupId)) continue;
    const list = scenesBySeries.get(groupId) ?? [];
    list.push(item.id);
    scenesBySeries.set(groupId, list);
  }
  const syncByScene = new Map<string, OfficialSceneSyncRecord>();
  for (const record of syncRecords) {
    if (record.provider !== provider) continue;
    syncByScene.set(record.sceneId, record);
  }
  const downloadByScene = new Map<string, DownloadedSceneSource>();
  for (const download of downloadRecords) {
    if (download.provider !== provider) continue;
    downloadByScene.set(download.sceneId, download);
  }
  const snapshot: Record<string, SceneBindingSnapshot> = {};
  for (const seriesId of seriesIds) {
    const sceneIds = scenesBySeries.get(seriesId) ?? [];
    if (sceneIds.length === 0) {
      // No catalog data for this series — the catalog cache may
      // be cold. Surface a "not_synced" snapshot so the chip
      // still renders (no row crash); the next focus after
      // catalog warm-up will pick up the real state.
      snapshot[seriesId] = {
        bound: 'not_synced',
        cached: 'remote',
      };
      continue;
    }
    // Aggregate per-scene status to series-level.
    let bestBound: SceneBindingStatus = 'unbound';
    let bestCached: SceneCacheStatus = 'remote';
    for (const sceneId of sceneIds) {
      const sync = syncByScene.get(sceneId);
      const download = downloadByScene.get(sceneId);
      const sceneBound = deriveBindingStatus(sync);
      const sceneCached = deriveCacheStatus(download?.localVideoUri, download?.status);
      if (rankBinding(sceneBound) > rankBinding(bestBound)) {
        bestBound = sceneBound;
      }
      if (rankCache(sceneCached) > rankCache(bestCached)) {
        bestCached = sceneCached;
      }
    }
    // Pick the first sync record we found for remote-path display.
    const firstSync = sceneIds
      .map((id) => syncByScene.get(id))
      .find((r): r is OfficialSceneSyncRecord => Boolean(r));
    const firstDownload = sceneIds
      .map((id) => downloadByScene.get(id))
      .find((r): r is DownloadedSceneSource => Boolean(r));
    snapshot[seriesId] = {
      bound: bestBound,
      cached: bestCached,
      provider: firstSync ? provider : undefined,
      remotePath: firstSync?.remotePath,
      localCacheUri: firstDownload?.localVideoUri,
    };
  }
  memoisedSnapshot = { key: cacheKey, value: snapshot };
  return snapshot;
}

/**
 * Per-scene variant. Use this when the caller has a list of
 * `VideoSceneDetail.id`s (e.g. `getOfficialDetail` builds one
 * such list and needs to know the binding status of every
 * episode individually — the aggregate "any scene wins" rule
 * of `getOfficialSceneBindingStatus` would hide per-episode
 * state in that UI).
 *
 * Returns a `Record<sceneId, SceneBindingSnapshot>` map. The
 * `bound` field is the per-scene status from the sync record
 * (no aggregation). The `cached` field is set when the scene
 * has a `downloaded_scene_source` row.
 */
export async function getOfficialSceneBindingStatusByScene(
  sceneIds: readonly string[],
  provider: CloudVideoProvider = 'baidu_pan',
): Promise<Record<string, SceneBindingSnapshot>> {
  if (sceneIds.length === 0) return {};
  const [syncRecords, downloadRecords] = await Promise.all([
    listOfficialSceneSyncRecords().catch(() => [] as OfficialSceneSyncRecord[]),
    listDownloadedSceneSources().catch(() => [] as DownloadedSceneSource[]),
  ]);
  const syncByScene = new Map<string, OfficialSceneSyncRecord>();
  for (const record of syncRecords) {
    if (record.provider !== provider) continue;
    syncByScene.set(record.sceneId, record);
  }
  const downloadByScene = new Map<string, DownloadedSceneSource>();
  for (const download of downloadRecords) {
    if (download.provider !== provider) continue;
    downloadByScene.set(download.sceneId, download);
  }
  const result: Record<string, SceneBindingSnapshot> = {};
  for (const sceneId of sceneIds) {
    const sync = syncByScene.get(sceneId);
    const download = downloadByScene.get(sceneId);
    result[sceneId] = {
      bound: deriveBindingStatus(sync),
      cached: deriveCacheStatus(download?.localVideoUri, download?.status),
      provider: sync ? provider : undefined,
      remotePath: sync?.remotePath,
      localCacheUri: download?.localVideoUri,
    };
  }
  return result;
}

// ── Aggregation ranking ────────────────────────────────────────
// Worst-case wins. Higher rank = stronger positive signal (e.g.
// "bound" beats "unbound"). Ties resolve to whichever the
// caller already saw — we only upgrade, never downgrade mid
// scan.
function rankBinding(status: SceneBindingStatus): number {
  switch (status) {
    case 'bound': return 4;
    case 'stale': return 3;
    case 'error': return 2;
    case 'unbound': return 1;
    case 'not_synced':
    default: return 0;
  }
}

function rankCache(status: SceneCacheStatus): number {
  switch (status) {
    case 'cached': return 4;
    case 'downloading': return 3;
    case 'error': return 2;
    case 'remote':
    default: return 1;
  }
}

/**
 * Drop the memoised snapshot. Call this from any mutation path:
 *   - pickSeries / unpickSeries (resets any per-scene UI cache)
 *   - rescanOfficialSceneSyncStatus (new sync record rows)
 *   - download completion (new DownloadedSceneSource rows)
 *   - deleteOfficialSceneDownload (cache removed)
 */
export function invalidateOfficialSceneBindingStatusCache(): void {
  memoisedSnapshot = null;
}
