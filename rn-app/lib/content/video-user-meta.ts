/**
 * Re-export of the SQLite-backed per-scene user meta module.
 *
 * Historical: this file used to wrap a single AsyncStorage JSON store
 * (`video_user_meta_v1`). As of schema v4 the data lives in the
 * video_user_meta table (see docs/2026-08-05-storage-migration-plan.md).
 *
 * API surface is unchanged — only the storage backend moved.
 */

export {
  getVideoUserMeta,
  listVideoUserMeta,
  markVideoScenePracticed,
  setVideoSceneFavorite,
  toggleVideoSceneFavorite,
} from '../database/video-user-meta';

export type { VideoUserMetaRecord } from '../database/video-user-meta';
