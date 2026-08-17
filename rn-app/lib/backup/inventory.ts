/**
 * Backup/Restore — items inventory (user-language manifest).
 *
 * The "items sheet" the user sees is built from BACKUP_ITEMS (static
 * metadata) and a live `scanBackupInventory()` that fills in size + count.
 *
 * Naming & grouping rules:
 *   - Use the user's language for label/description (no SQL/JSON jargon)
 *   - Sensitive items (BYOK API key, OAuth tokens) get sensitive=true
 *     so the UI shows a ⚠️ icon and a second-level confirm
 *   - source/sourceRef describe WHERE to read/write so the export and
 *     import code can stay symmetric
 *
 * Bump rules:
 *   - ADD a new kind freely (additive)
 *   - NEVER rename a kind (would silently break old backups)
 *   - Removing a kind from this list is fine — restore skips unknown kinds
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  documentDirectory,
  getInfoAsync,
  readDirectoryAsync,
} from 'expo-file-system/legacy';
import type { BackupItem, BackupItemKind } from './types';

export interface BackupItemSpec {
  kind: BackupItemKind;
  label: string;
  description: string;
  source: BackupItem['source'];
  sourceRef: string;
  /** Hide from the items sheet by default (legacy migration cruft). */
  advanced?: boolean;
  sensitive?: boolean;
  /** Read-only info row (Supabase data); never in the zip. */
  cloudOnly?: boolean;
}

export const BACKUP_ITEMS: BackupItemSpec[] = [
  // ── P0: SQLite core data ───────────────────────────────────────────
  {
    kind: 'cards',
    label: '生词本与复习状态',
    description: '所有收藏的单词、句子及间隔重复复习进度',
    source: 'mixed',
    sourceRef: 'learning_cards + fsrs_reviews',
  },
  {
    kind: 'chat_history',
    label: 'NPC 对话历史',
    description: '与陪练角色的全部聊天记录',
    source: 'db',
    sourceRef: 'chat_sessions + chat_turns',
  },
  {
    kind: 'ai_practice',
    // "我生成的" disambiguates from the official `official_video_ai_practice`
    // table (which lives in Supabase, not in this backup).
    label: '我生成的 AI 练习题',
    description: '你手动触发生成的 AI 陪练题及生成状态（官方 AI 卡片在 Supabase，云端自动同步）',
    source: 'db',
    sourceRef: 'video_ai_practice_card + video_ai_practice_state',
  },
  {
    kind: 'favorites',
    label: '收藏（视频 / 话题）',
    description: '视频和话题的收藏标记、最近练习时间',
    source: 'db',
    sourceRef: 'video_user_meta + ai_practice_user_meta',
  },
  {
    kind: 'user_profile',
    label: '个人资料',
    description: '等级、职业、兴趣场景',
    source: 'db',
    sourceRef: 'app_config[user_profile]',
  },
  {
    kind: 'quota',
    label: '今日用量与配置',
    description: '今日已用配额、每日上限、Pro 状态',
    source: 'db',
    sourceRef: 'app_config[quota_*]',
  },
  {
    kind: 'byok',
    label: '自带 API Key',
    description: '你在 BYOK 里配置的第三方 AI 服务密钥',
    source: 'db',
    sourceRef: 'app_config[byok_config]',
    sensitive: true,
  },
  {
    kind: 'cloud_drive',
    label: '云盘绑定',
    description: '百度网盘账号绑定信息与默认云盘',
    source: 'db',
    sourceRef: 'app_config[baiduPan*]',
    sensitive: true,
  },
  {
    kind: 'scene_providers',
    label: '场景云盘选择',
    description: '每个场景使用的云盘来源',
    source: 'db',
    sourceRef: 'scene_provider_selection',
  },
  {
    // "网盘绑定 + 下载元数据" disambiguates from the old "已下载视频"
    // label — now this item is mostly the baidu-pan binding rows in
    // `official_scene_sync_record` (since mp4 is no longer on OSS,
    // there's no official download metadata to back up here).
    kind: 'downloaded_videos',
    label: '网盘绑定 + 下载元数据',
    description: '每集的百度网盘绑定关系 + 导入视频的本地下载元数据（不含视频文件本身）',
    source: 'db',
    sourceRef: 'downloaded_scene_source + official_scene_sync_record',
  },
  {
    // Cold-start cache. Without this, a fresh install / device
    // migration has to re-fetch every `info.json` and the OSS catalog
    // before the UI is responsive. With this, the first launch is
    // instant.
    kind: 'scene_caches',
    label: '场景冷启缓存',
    description: 'OSS 官方目录 + 每集 info.json 的本地缓存表。删了不影响数据，只是首次启动会重新拉',
    source: 'db',
    sourceRef: 'oss_video_catalog + video_scene_info',
  },

  // ── P1: AsyncStorage / settings ────────────────────────────────────
  {
    kind: 'settings',
    label: '应用偏好设置',
    description: 'TTS / 沙箱 / 头像 / 练习模式等开关',
    source: 'asyncstorage',
    sourceRef: 'tts_config, sandbox_config, show_avatar, practice_mode',
  },
  {
    kind: 'staged_scenarios',
    label: '场景草稿',
    description: '未发布的 AI 生成场景草稿',
    source: 'asyncstorage',
    sourceRef: 'staged_scenario, staged_scenario_ref',
  },
  {
    kind: 'evaluator_state',
    label: '跟读评估状态',
    description: '已评估会话、复习注入缓存、徽章数',
    source: 'asyncstorage',
    sourceRef: 'fsrs_inject_cache, evaluated_sessions, library_badge_count',
  },
  {
    kind: 'known_words',
    label: '已掌握词表（遗留）',
    description: '老版本已知词表（一般为空）',
    source: 'asyncstorage',
    sourceRef: 'known_words, user_level, user_interests, user_profession',
    advanced: true,
  },

  // ── P2: Files (optional, can be large) ─────────────────────────────
  {
    kind: 'user_videos',
    label: '我的视频 + 字幕',
    description: '导入到自己库的视频和字幕文件',
    source: 'files',
    sourceRef: 'documentDirectory/user-videos',
  },
  {
    kind: 'clip_segments',
    label: '视频片段',
    description: '从视频切出的练习片段',
    source: 'files',
    sourceRef: 'documentDirectory/clip-segments',
  },
  {
    kind: 'imported_packs',
    label: '导入的视频包',
    description: '从外部导入的视频合集',
    source: 'files',
    sourceRef: 'documentDirectory/imported-video-packs',
  },
  {
    kind: 'tts_cache',
    label: 'TTS 音频缓存',
    description: '已合成过的 TTS 音频（重新生成很快）',
    source: 'files',
    sourceRef: 'documentDirectory/audio',
  },

  // ── Cloud-only info (NOT in the zip) ──────────────────────────────
  {
    kind: 'cloud_synced',
    label: '云端数据（不备份）',
    description:
      '我的跟练 · 我的合集 · 官方合集目录 · 官方剧集 · 官方 AI 陪练卡片 — 都在 Supabase 上，登录同一账号后自动同步，无需备份。',
    source: 'cloud',
    sourceRef:
      'supabase:user_picked_video_series + user_collections + official_video_series + official_video_episodes + official_video_ai_practice',
    cloudOnly: true,
  },
];

/** True if any item the user might select is a file/folder. */
export function hasFileItems(items: BackupItemSpec[]): boolean {
  return items.some((it) => it.source === 'files' || it.source === 'mixed');
}

/** Default selection = everything checked, except advanced and cloud-only. */
export function defaultSelection(): Set<BackupItemKind> {
  const set = new Set<BackupItemKind>();
  for (const it of BACKUP_ITEMS) {
    if (!it.advanced && !it.cloudOnly) set.add(it.kind);
  }
  return set;
}

/** Items the user actually selected, intersected with the spec table.
 *  Cloud-only items are filtered out — they never enter the export. */
export function resolveSelectedItems(
  selected: Set<BackupItemKind>,
): BackupItemSpec[] {
  return BACKUP_ITEMS.filter((it) => selected.has(it.kind) && !it.cloudOnly);
}

// ── Live sizing ──────────────────────────────────────────────────────

/**
 * Walk a directory recursively, summing file sizes. Best-effort: any
 * unreadable entry is skipped (does not throw).
 */
async function dirSizeBytes(path: string): Promise<number> {
  if (!path) return 0;
  let total = 0;
  try {
    const info = await getInfoAsync(path);
    // 2026-08-17: temporary debug log for the user-videos size=0 bug
    console.log('[inventory.dirSizeBytes] probe', {
      path,
      exists: info.exists,
      isDirectory: info.isDirectory,
      size: info.exists ? info.size : 0,
    });
    if (!info.exists) return 0;
  } catch (e) {
    console.log('[inventory.dirSizeBytes] getInfoAsync threw', {
      path,
      msg: e instanceof Error ? e.message : String(e),
    });
    return 0;
  }
  const stack: string[] = [path];
  while (stack.length) {
    const cur = stack.pop()!;
    let entries: string[] = [];
    try {
      entries = await readDirectoryAsync(cur);
      console.log('[inventory.dirSizeBytes] readDirectoryAsync', {
        cur,
        entriesCount: entries.length,
        sample: entries.slice(0, 5),
      });
    } catch (e) {
      console.log('[inventory.dirSizeBytes] readDirectoryAsync threw', {
        cur,
        msg: e instanceof Error ? e.message : String(e),
      });
      continue;
    }
    for (const name of entries) {
      const child = cur.endsWith('/') ? `${cur}${name}` : `${cur}/${name}`;
      let info;
      try {
        info = await getInfoAsync(child);
      } catch {
        continue;
      }
      if (!info.exists) continue;
      if (info.isDirectory) {
        stack.push(child);
      } else if (typeof info.size === 'number') {
        total += info.size;
      }
    }
  }
  console.log('[inventory.dirSizeBytes] done', { path, total });
  return total;
}

function countString(value: string | null): number {
  if (!value) return 0;
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) return parsed.length;
    if (parsed && typeof parsed === 'object') return Object.keys(parsed).length;
  } catch {
    /* not JSON */
  }
  return value.length > 0 ? 1 : 0;
}

/**
 * Best-effort size estimate for a single AppConfig row. value_json is a
 * TEXT column; we count its length.
 */
async function appConfigRowSize(key: string): Promise<number> {
  try {
    const { ensureDatabaseInitialized } = await import('../database');
    await ensureDatabaseInitialized();
    const { getDatabase } = await import('../database/schema');
    const db = await getDatabase();
    const row: any = await db.getFirstAsync(
      'SELECT value_json FROM app_config WHERE key = ?',
      [key],
    );
    if (!row?.value_json) return 0;
    return String(row.value_json).length;
  } catch {
    return 0;
  }
}

async function tableRowCount(table: string): Promise<number> {
  try {
    const { ensureDatabaseInitialized } = await import('../database');
    await ensureDatabaseInitialized();
    const { getDatabase } = await import('../database/schema');
    const db = await getDatabase();
    // Table names are hard-coded in this file (not user input), so it's
    // safe to interpolate. Don't take this pattern as a general utility.
    const row: any = await db.getFirstAsync(
      `SELECT COUNT(*) AS n FROM ${table}`,
    );
    return typeof row?.n === 'number' ? row.n : 0;
  } catch {
    return 0;
  }
}

async function asyncKeySize(key: string): Promise<{ size: number; count: number }> {
  try {
    const v = await AsyncStorage.getItem(key);
    if (v === null) return { size: 0, count: 0 };
    return { size: v.length, count: countString(v) };
  } catch {
    return { size: 0, count: 0 };
  }
}

function fileDir(ref: string): string | null {
  // ref is "documentDirectory/<subdir>"; map to actual file path
  const match = ref.match(/^documentDirectory\/(.+)$/);
  if (!match || !documentDirectory) return null;
  return `${documentDirectory}${match[1]}`;
}

/**
 * Scan all backup items and return them with current size + record count.
 * The order matches BACKUP_ITEMS. Files dirs are scanned in parallel.
 */
export async function scanBackupInventory(): Promise<BackupItem[]> {
  const out: BackupItem[] = [];

  for (const spec of BACKUP_ITEMS) {
    let sizeBytes = 0;
    let recordCount: number | undefined;

    switch (spec.kind) {
      // ── P0: SQLite ────────────────────────────────────────────────
      case 'cards': {
        const [a, b] = await Promise.all([
          tableRowCount('learning_cards'),
          tableRowCount('fsrs_reviews'),
        ]);
        recordCount = a + b;
        sizeBytes = recordCount * 600; // rough row size estimate
        break;
      }
      case 'chat_history': {
        const [a, b] = await Promise.all([
          tableRowCount('chat_sessions'),
          tableRowCount('chat_turns'),
        ]);
        recordCount = a + b;
        sizeBytes = recordCount * 400;
        break;
      }
      case 'ai_practice': {
        const [a, b] = await Promise.all([
          tableRowCount('video_ai_practice_card'),
          tableRowCount('video_ai_practice_state'),
        ]);
        recordCount = a + b;
        sizeBytes = recordCount * 1500; // cards_json can be large
        break;
      }
      case 'favorites': {
        const [a, b] = await Promise.all([
          tableRowCount('video_user_meta'),
          tableRowCount('ai_practice_user_meta'),
        ]);
        recordCount = a + b;
        sizeBytes = recordCount * 200;
        break;
      }
      case 'user_profile': {
        sizeBytes = await appConfigRowSize('user_profile');
        if (sizeBytes > 0) recordCount = 1;
        break;
      }
      case 'quota': {
        // Sum of all quota_* keys (config, pro_state, today's usage, sync)
        const keys = [
          'quota_config',
          'quota_pro_state',
          'quota_last_sync',
          'quota_pending_push',
        ];
        const today = new Date().toISOString().slice(0, 10);
        keys.push(`quota_usage_${today}`);
        const sizes = await Promise.all(keys.map(appConfigRowSize));
        sizeBytes = sizes.reduce((a, b) => a + b, 0);
        recordCount = sizes.filter((s) => s > 0).length;
        break;
      }
      case 'byok': {
        sizeBytes = await appConfigRowSize('byok_config');
        if (sizeBytes > 0) recordCount = 1;
        break;
      }
      case 'cloud_drive': {
        const [a, b, c] = await Promise.all([
          appConfigRowSize('baiduPanBinding'),
          appConfigRowSize('baiduPanAppConfig'),
          appConfigRowSize('defaultProvider'),
        ]);
        sizeBytes = a + b + c;
        recordCount = [a, b, c].filter((s) => s > 0).length;
        break;
      }
      case 'scene_providers': {
        recordCount = await tableRowCount('scene_provider_selection');
        sizeBytes = recordCount * 80;
        break;
      }
      case 'downloaded_videos': {
        const [a, b] = await Promise.all([
          tableRowCount('downloaded_scene_source'),
          tableRowCount('official_scene_sync_record'),
        ]);
        recordCount = a + b;
        sizeBytes = recordCount * 300;
        break;
      }
      case 'scene_caches': {
        const [a, b] = await Promise.all([
          tableRowCount('oss_video_catalog'),
          tableRowCount('video_scene_info'),
        ]);
        recordCount = a + b;
        // Both tables store JSON blobs; rough estimate is 8 KB
        // per scene_info row + ~50 KB per catalog row.
        sizeBytes = a * 50_000 + b * 8_000;
        break;
      }
      case 'cloud_synced': {
        // Read-only info row — not actually in the backup. Size 0
        // because it's never packed into the zip; the UI uses
        // `cloudOnly` to render the section differently.
        sizeBytes = 0;
        recordCount = undefined;
        break;
      }

      // ── P1: AsyncStorage ─────────────────────────────────────────
      case 'settings': {
        const r = await Promise.all(
          ['tts_config', 'sandbox_config', 'show_avatar', 'practice_mode'].map(asyncKeySize),
        );
        sizeBytes = r.reduce((acc, x) => acc + x.size, 0);
        recordCount = r.filter((x) => x.size > 0).length;
        break;
      }
      case 'staged_scenarios': {
        const r = await Promise.all(
          ['staged_scenario', 'staged_scenario_ref'].map(asyncKeySize),
        );
        sizeBytes = r.reduce((acc, x) => acc + x.size, 0);
        recordCount = r.filter((x) => x.size > 0).length;
        break;
      }
      case 'evaluator_state': {
        const r = await Promise.all(
          ['fsrs_inject_cache', 'evaluated_sessions', 'library_badge_count'].map(asyncKeySize),
        );
        sizeBytes = r.reduce((acc, x) => acc + x.size, 0);
        recordCount = r.filter((x) => x.size > 0).length;
        break;
      }
      case 'known_words': {
        const r = await Promise.all(
          ['known_words', 'user_level', 'user_interests', 'user_profession'].map(asyncKeySize),
        );
        sizeBytes = r.reduce((acc, x) => acc + x.size, 0);
        recordCount = r.filter((x) => x.size > 0).length;
        break;
      }

      // ── P2: Files ────────────────────────────────────────────────
      case 'user_videos':
      case 'clip_segments':
      case 'imported_packs':
      case 'tts_cache': {
        const dir = fileDir(spec.sourceRef);
        sizeBytes = dir ? await dirSizeBytes(dir) : 0;
        if (sizeBytes > 0) recordCount = 1; // dir, count is bytes
        break;
      }
    }

    out.push({
      kind: spec.kind,
      label: spec.label,
      description: spec.description,
      sizeBytes,
      recordCount,
      sensitive: spec.sensitive,
      source: spec.source,
      sourceRef: spec.sourceRef,
    });
  }

  return out;
}

export function formatBytes(n: number): string {
  if (!n || n <= 0) return '0 B';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
