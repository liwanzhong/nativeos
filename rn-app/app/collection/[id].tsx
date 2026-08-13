/**
 * /collection/[id] — owned-collection detail page.
 *
 * Scope: this page is the **owned / 视频跟练** view. The id
 * parameter is the **wire** id (encoded via `encodeCollectionId`):
 *   - `"official:<id>"` for an official series the user has
 *     already picked (entered from the home grid; the
 *     `/library/<id>` page is the recommended-context sibling
 *     for unpicked or browse-mode entry)
 *   - `"user:<bigserial>"` for a user-built collection
 *
 * The page itself is source-agnostic — it branches on the prefix
 * only when fetching the underlying data and when rendering the
 * title-bar action menu (official → "从我的合集移出", user →
 * "重命名 / 删除"). The shared shape is intentional: a card on
 * the home page (the owned grid) lands here, full stop.
 *
 * Why this is a separate page from /library/[id]:
 *   The two pages look like they share a "collection" concept, but
 *   the user's mental model is genuinely different:
 *     /collection/[id]  → "I already own this. Help me learn it."
 *       Full video list with per-row status, 继续/再看一遍 CTA,
 *       progress bar, per-row actions.
 *     /library/[id]     → "I'm browsing. Help me decide."
 *       Big cover, full description, episode PREVIEW (a few items),
 *       prominent 加入我的合集 CTA.
 *   Two small focused pages beat one big branched one.
 */

import { useLocalSearchParams, useFocusEffect, useRouter } from 'expo-router';
import {
  ActivityIndicator,
  Alert,
  Image,
  ImageBackground,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  ArrowLeft,
  Bot,
  Check,
  Cloud,
  CloudOff,
  Download,
  FolderInput,
  HardDrive,
  Languages,
  Link2,
  MoreVertical,
  Pencil,
  Play,
  RefreshCw,
  Trash2,
  Upload,
  X,
} from 'lucide-react-native';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { colors, spacing, borderRadius, fontSize, fontWeight } from '../../constants/theme';
import {
  decodeCollectionId,
  getCollectionDetail,
  invalidateCollectionsCache,
  type CollectionDetail as Detail,
  type CollectionVideoItem,
} from '../../lib/content/collections';
import {
  deleteUserCollection,
  encodeUserCollectionId,
  listUserCollections,
  type UserCollectionRow,
  updateUserCollection,
} from '../../lib/content/user-collections';
import { unpickSeries } from '../../lib/content/user-picked-series';
import { invalidateVideoSeriesViewsCache } from '../../lib/content/video-series-supabase-views';
import { ImportVideoSheet } from '../../components/collection/ImportVideoSheet';
import {
  deleteImportedVideoPack,
  setImportedVideoPackCollection,
} from '../../lib/content/imported-video-packs';
import {
  deleteUserVideoEntry,
  getUserVideoEntryById,
  setUserVideoCollection,
  triggerImportedVideoSubtitleGeneration,
} from '../../lib/content/user-videos';
import {
  generateUserVideoAiPracticeCards,
  subscribeUserVideoAiPracticeState,
} from '../../lib/content/user-video-ai-practice';
import {
  downloadImportedCloudVideo,
  getCachedDownloadEntrySnapshot,
  subscribeDownloadState,
} from '../../lib/content/cloud-video-playback';
import { invalidateVideoSceneCaches } from '../../lib/content/video-scenes';
import {
  invalidateOfficialSceneBindingStatusCache,
} from '../../lib/content/cloud-binding-summary';
import { getConfiguredCloudProviders } from '../../lib/database/cloud-bindings';

const DETAIL_LOG_PREFIX = '[CollectionDetail]';

function logDetailTrace(message: string, payload?: unknown) {
  if (payload === undefined) {
    console.log(`${DETAIL_LOG_PREFIX} ${message}`);
    return;
  }
  console.log(`${DETAIL_LOG_PREFIX} ${message}`, payload);
}

export default function CollectionDetailPage() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { id: rawId } = useLocalSearchParams<{ id: string }>();
  const id = typeof rawId === 'string' ? decodeURIComponent(rawId) : '';
  // Memoize: decodeCollectionId returns a new object each call, and
  // putting `parsed` straight into a useCallback dep array makes the
  // callback invalidate on every render → useEffect on `load` loops
  // forever (saw the logcat flood).
  const parsed = useMemo(() => decodeCollectionId(id), [id]);

  const [detail, setDetail] = useState<Detail | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [menuVisible, setMenuVisible] = useState(false);
  const [renameVisible, setRenameVisible] = useState(false);
  const [renameText, setRenameText] = useState('');
  // Import sheet — only meaningful for user collections. The
  // official-series menu doesn't surface "导入视频" so this stays
  // false there.
  const [isImportSheetVisible, setIsImportSheetVisible] = useState(false);

  // Live download progress for any baidu-pan row in the list.
  // Keyed by entry id; value is the latest snapshot pushed by
  // `subscribeDownloadState`. Cleared on full page unmount and
  // re-seeded from `getCachedDownloadEntrySnapshot` so a
  // mid-download focus re-render shows the right number without
  // waiting for the next event tick.
  const [downloadProgress, setDownloadProgress] = useState<Record<string, {
    status: 'idle' | 'resolving' | 'downloading' | 'paused' | 'completed' | 'error';
    progress: number;
  }>>({});

  // Per-video action sheet ("移动到 / 从合集移除"). Opened from the
  // "..." button on each user-collection video row.
  //
  // Two pieces of state, kept separate on purpose:
  //   - `actionTarget` carries the row that will be acted on.
  //     MUST stay populated while the move picker is open so the
  //     picker's handler can read it; only cleared on full cancel
  //     (backdrop tap on the action sheet) or after the operation
  //     completes.
  //   - `isActionSheetVisible` gates just the action-sheet render.
  //     When the user picks "移动到合集", we flip this to false to
  //     hide the action sheet WITHOUT losing `actionTarget` for
  //     the move picker that's about to open.
  const [actionTarget, setActionTarget] = useState<CollectionVideoItem | null>(null);
  const [isActionSheetVisible, setIsActionSheetVisible] = useState(false);
  const [isMovePickerVisible, setIsMovePickerVisible] = useState(false);
  const [movePickerCollections, setMovePickerCollections] = useState<UserCollectionRow[]>([]);
  const [isMovePickerLoading, setIsMovePickerLoading] = useState(false);

  const load = useCallback(async (forceRefresh: boolean = false) => {
    if (!parsed) return;
    setIsLoading(true);
    logDetailTrace('load start', { id, forceRefresh });
    try {
      const d = await getCollectionDetail(id, forceRefresh);
      setDetail(d);
      logDetailTrace('load success', {
        id,
        kind: d?.kind,
        videoCount: d?.videoCount,
      });
    } catch (err) {
      logDetailTrace('load failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      setDetail(null);
    } finally {
      setIsLoading(false);
    }
  }, [id, parsed]);

  // Re-fetch whenever the page becomes active — covers both the
  // initial mount AND the case where the user navigates into the
  // video player and back (delete/move happened on the player page
  // and the detail list would otherwise show stale entries).
  // `load(true)` bypasses the cached CollectionDetail so a focus
  // re-entry always re-reads from disk.
  useFocusEffect(useCallback(() => {
    void load(true);
  }, [load]));

  // Live download progress subscription. We can't read the
  // provider from the bare CollectionVideoItem (only origin
  // tells us it's a baidu-pan row); the underlying UserVideoEntry
  // is the source of truth, so we look it up by id from the
  // current detail's video list. The lookup happens once per
  // focus, not per row, to keep the effect cheap.
  useEffect(() => {
    if (!detail || detail.kind !== 'user') return;
    const baiduRows = detail.videos.filter(
      (v) => v.source === 'user-video' && v.origin === 'baidu-pan' && typeof v.id === 'string',
    );
    if (baiduRows.length === 0) return;
    let cancelled = false;
    const unsubscribes: Array<() => void> = [];
    void (async () => {
      const { getUserVideoEntryById } = await import('../../lib/content/user-videos');
      for (const video of baiduRows) {
        const entry = await getUserVideoEntryById(video.id);
        if (!entry || !entry.provider || entry.provider !== 'baidu_pan') continue;
        // Seed from current snapshot so a mid-download focus
        // shows the right number without waiting for the next
        // event tick.
        const initial = getCachedDownloadEntrySnapshot(video.id, 'baidu_pan');
        if (initial && !cancelled) {
          setDownloadProgress((prev) => ({
            ...prev,
            [video.id]: { status: initial.status, progress: initial.progress },
          }));
        }
        if (cancelled) continue;
        const off = subscribeDownloadState(video.id, 'baidu_pan', (state) => {
          if (cancelled) return;
          setDownloadProgress((prev) => {
            if (!state) {
              // Listener fired with null (entry evicted from
              // the cache). The row should fall back to whatever
              // `cacheStatus` says on the entry.
              if (!(video.id in prev)) return prev;
              const next = { ...prev };
              delete next[video.id];
              return next;
            }
            return {
              ...prev,
              [video.id]: { status: state.status, progress: state.progress },
            };
          });
        });
        unsubscribes.push(off);
      }
    })();
    return () => {
      cancelled = true;
      unsubscribes.forEach((fn) => { try { fn(); } catch { /* noop */ } });
    };
  }, [detail]);

  const handleOpenVideo = useCallback((videoId: string) => {
    // Official episodes go to the existing /scenario/video/[id] route.
    // Imported / user videos reuse the same route; the renderer
    // already branches on scene.contentOrigin.
    router.push(`/scenario/video/${encodeURIComponent(videoId)}`);
  }, [router]);

  const handleUnpickOfficial = useCallback(async () => {
    if (!parsed || parsed.kind !== 'official') return;
    setMenuVisible(false);
    try {
      await unpickSeries(parsed.rawId);
      invalidateCollectionsCache();
      invalidateVideoSeriesViewsCache();
      router.back();
    } catch (err) {
      Alert.alert('移出失败', err instanceof Error ? err.message : String(err));
    }
  }, [parsed, router]);

  const handleDeleteUserCollection = useCallback(() => {
    if (!parsed || parsed.kind !== 'user') return;
    const userId = Number(parsed.rawId);
    setMenuVisible(false);
    Alert.alert(
      '删除这个合集?',
      '合集本身会被删除,里面的视频不会被删(它们会回到"默认合集")。',
      [
        { text: '取消', style: 'cancel' },
        {
          text: '删除',
          style: 'destructive',
          onPress: async () => {
            try {
              await deleteUserCollection(userId);
              invalidateCollectionsCache();
              router.back();
            } catch (err) {
              Alert.alert('删除失败', err instanceof Error ? err.message : String(err));
            }
          },
        },
      ],
    );
  }, [parsed, router]);

  const handleStartRename = useCallback(() => {
    if (!detail) return;
    setRenameText(detail.title);
    setRenameVisible(true);
    setMenuVisible(false);
  }, [detail]);

  const handleOpenImportSheet = useCallback(() => {
    if (!parsed || parsed.kind !== 'user') return;
    setMenuVisible(false);
    setIsImportSheetVisible(true);
  }, [parsed]);

  const handleImportSheetSuccess = useCallback(
    (_entry: { id: string; title: string }) => {
      setIsImportSheetVisible(false);
      // Re-read this collection's detail so the video list and
      // videoCount refresh. The ImportVideoSheet already wrote the
      // entry to the index; `load(true)` bypasses any cached
      // CollectionDetail that the detail page might have memoized.
      void load(true);
    },
    [load],
  );

  // ── Per-video actions (移动到合集 / 从合集移除) ────────────
  // Tapping the "..." on a user-managed row opens an action sheet
  // anchored to that row. We keep the target in state so the
  // move picker and the destructive confirm can read the same
  // id + source.
  const handleOpenVideoActions = useCallback((video: CollectionVideoItem) => {
    // The action sheet only exists for non-official rows. The row
    // shouldn't render the "..." button on official entries, but
    // bail defensively if it ever does.
    if (!video.source || video.source === 'official') return;
    setActionTarget(video);
    setIsActionSheetVisible(true);
  }, []);

  const handleCloseVideoActions = useCallback(() => {
    // User dismissed the action sheet without picking anything —
    // discard the target. (Cancel-out from the move picker has its
    // own handler that ALSO clears the target; the remove alert
    // clears it just before its onPress runs.)
    setIsActionSheetVisible(false);
    setActionTarget(null);
  }, []);

  const handleStartMoveTo = useCallback(async () => {
    // Hide the action sheet WITHOUT clearing `actionTarget` — the
    // move picker's "pick target" handler needs to know which row
    // to move. The target only gets cleared on full cancel (the
    // move picker's own backdrop) or after the move completes.
    setIsActionSheetVisible(false);
    setIsMovePickerVisible(true);
    setIsMovePickerLoading(true);
    try {
      const all = await listUserCollections();
      setMovePickerCollections(all);
    } catch (err) {
      logDetailTrace('loadMovePickerCollections failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      setMovePickerCollections([]);
    } finally {
      setIsMovePickerLoading(false);
    }
  }, []);

  const handleCloseMovePicker = useCallback(() => {
    // User backed out of the move picker (backdrop tap or Android
    // back). Discard the target — there was no successful move.
    setIsMovePickerVisible(false);
    setActionTarget(null);
  }, []);

  // Dispatcher: which data layer function actually moves the
  // entry, based on its `source`. Keeps the two code paths from
  // tangling inside the call sites below.
  const applyCollectionChange = useCallback(
    async (
      target: CollectionVideoItem,
      nextCollectionWireId: string | undefined,
    ): Promise<void> => {
      if (target.source === 'user-video') {
        const result = await setUserVideoCollection(
          target.id,
          nextCollectionWireId,
        );
        if (!result) {
          throw new Error('entry not found');
        }
      } else if (target.source === 'pack') {
        const result = await setImportedVideoPackCollection(
          target.id,
          nextCollectionWireId,
        );
        if (!result) {
          throw new Error('pack not found');
        }
      } else {
        throw new Error('this video cannot be moved');
      }
    },
    [],
  );

  const handlePickMoveTarget = useCallback(
    async (targetWireId: string) => {
      const target = actionTarget;
      if (!target) return;
      try {
        await applyCollectionChange(target, targetWireId);
        setIsMovePickerVisible(false);
        setActionTarget(null);
        invalidateCollectionsCache();
        void load(true);
        const targetTitle = movePickerCollections.find(
          (c) => encodeUserCollectionId(c.id) === targetWireId,
        )?.title ?? '合集';
        Alert.alert('已移动', `"${target.title}" 已移到 ${targetTitle}`);
      } catch (err) {
        Alert.alert('移动失败', err instanceof Error ? err.message : String(err));
      }
    },
    [actionTarget, applyCollectionChange, load, movePickerCollections],
  );

  // "从合集移除" semantics:
  //   - current is default → no other place for it; real delete
  //     (file + entry). Strong confirm.
  //   - current is custom → clear collectionId; the entry falls
  //     back to the default collection via the
  //     "no collectionId → default" rule in `matchesCollection`.
  //     Lighter confirm.
  const handleRemoveFromCollection = useCallback(() => {
    const target = actionTarget;
    if (!target) return;
    setActionTarget(null);

    const isDefault = detail?.isDefault === true;
    const confirmMessage = isDefault
      ? '视频将从你的设备上删除，无法恢复。'
      : '视频会回到默认合集。';

    Alert.alert(
      isDefault ? '删除视频?' : '从合集移除?',
      `"${target.title}"\n\n${confirmMessage}`,
      [
        { text: '取消', style: 'cancel' },
        {
          text: isDefault ? '删除' : '移除',
          style: 'destructive',
          onPress: async () => {
            try {
              if (isDefault) {
                if (target.source === 'user-video') {
                  await deleteUserVideoEntry(target.id);
                } else if (target.source === 'pack') {
                  await deleteImportedVideoPack(target.id);
                } else {
                  throw new Error('this video cannot be deleted');
                }
              } else {
                await applyCollectionChange(target, undefined);
              }
              invalidateVideoSceneCaches();
              invalidateCollectionsCache();
              void load(true);
            } catch (err) {
              Alert.alert(
                isDefault ? '删除失败' : '移除失败',
                err instanceof Error ? err.message : String(err),
              );
            }
          },
        },
      ],
    );
  }, [actionTarget, applyCollectionChange, detail?.isDefault, load]);

  const handleSubmitRename = useCallback(async () => {
    if (!parsed || parsed.kind !== 'user') return;
    const next = renameText.trim();
    if (!next) {
      Alert.alert('合集名不能为空');
      return;
    }
    try {
      await updateUserCollection(Number(parsed.rawId), { title: next });
      setRenameVisible(false);
      invalidateCollectionsCache();
      await load(true);
    } catch (err) {
      Alert.alert('重命名失败', err instanceof Error ? err.message : String(err));
    }
  }, [parsed, renameText, load]);

  // ── Per-row chip shortcuts ──────────────────────────────────
  // The detail page surfaces 3 actionable chips per row:
  //   - "缓存" on a remote user-video (cloud_reference, baidu)
  //   - "生成字幕" / "重试字幕" on a user-video whose subtitle
  //     pipeline is idle / failed
  //   - "AI 话题" on a user-video that has no AI topic cards yet
  //     (gated on cache + subtitle readiness; otherwise we tell
  //     the user what's blocking the generation)
  // All three end with `load(true)` to re-read the row's state
  // (the helpers write the new state to disk; the page just
  // re-renders it).
  const handleRowCachePress = useCallback(async (video: CollectionVideoItem) => {
    if (video.source !== 'user-video' || video.origin !== 'baidu-pan') return;
    const entry = await getUserVideoEntryById(video.id);
    if (!entry || !entry.provider || !entry.remotePath) {
      Alert.alert('缓存失败', '找不到百度网盘文件信息');
      return;
    }
    try {
      // Fire-and-forget the download; the cloud layer maintains
      // its own progress state and the next focus will re-render
      // the row with the new cacheStatus. We alert on completion
      // errors only.
      await downloadImportedCloudVideo({
        sceneId: entry.id,
        provider: entry.provider,
        remotePath: entry.remotePath,
      });
      invalidateCollectionsCache();
      await load(true);
    } catch (err) {
      Alert.alert('缓存失败', err instanceof Error ? err.message : String(err));
    }
  }, [load]);

  // Tapping the binding chip on an official video row. The
  // intent is to give the user a single tap that fixes the
  // most common "未绑定" cause (the user dropped the file in
  // their drive since the last scan). When no provider is
  // configured at all, we deep-link to the cloud-drives sheet
  // for authorisation first.
  const handleRowBindingPress = useCallback(async (video: CollectionVideoItem) => {
    if (video.source !== 'official') return;
    const status = video.bindingStatus;
    if (status === 'bound') return;
    try {
      const configured = await getConfiguredCloudProviders().catch(() => [] as ('baidu_pan')[]);
      if (configured.length === 0) {
        Alert.alert(
          '需要授权百度网盘',
          '授权后可以扫描你的网盘,自动把推荐视频绑定到本地播放。',
          [
            { text: '取消', style: 'cancel' },
            { text: '去授权', onPress: () => router.push('/cloud-drives') },
          ],
        );
        return;
      }
      // Provider configured but row isn't bound (or is stale/error) —
      // run a fresh scan. The user might have dropped the file in
      // their drive since the last scan; the new record will be
      // picked up the next time the page loads.
      const { rescanOfficialSceneSyncStatus } = await import('../../lib/content/cloud-drive-sync');
      await rescanOfficialSceneSyncStatus(true);
      invalidateOfficialSceneBindingStatusCache();
      invalidateCollectionsCache();
      await load(true);
    } catch (err) {
      Alert.alert('扫描失败', err instanceof Error ? err.message : String(err));
    }
  }, [load, router]);

  const handleRowSubtitlePress = useCallback(async (video: CollectionVideoItem) => {
    if (video.source !== 'user-video') return;
    // Mirrors the auto-trigger on import: the helper silently
    // gates on Pro / quota for local files; cloud references
    // are processed immediately.
    try {
      await triggerImportedVideoSubtitleGeneration(video);
      invalidateCollectionsCache();
      await load(true);
    } catch (err) {
      Alert.alert('字幕生成失败', err instanceof Error ? err.message : String(err));
    }
  }, [load]);

  const handleRowAiTopicPress = useCallback(async (video: CollectionVideoItem) => {
    if (video.source !== 'user-video') return;
    // Pre-flight gate on the two prerequisites the user described:
    // cached locally + subtitle ready. The generation helper
    // re-asserts both (defence in depth) and throws a clear error
    // so the UI can surface the right copy on partial readiness.
    if (video.cacheStatus !== 'cached') {
      Alert.alert('需要先缓存到本地', 'AI 话题生成依赖本地视频文件,请先点击「缓存」把视频下载到设备。');
      return;
    }
    if (video.subtitleStatus !== 'ready') {
      Alert.alert('需要先生成字幕', 'AI 话题基于字幕内容生成,请先点击「生成字幕」跑一遍字幕。');
      return;
    }
    // Subscribe to live state so the chip updates without us
    // having to wire a focus effect. The listener is cleaned up
    // on completion (success OR failure).
    let unsubscribe: (() => void) | null = null;
    const teardown = () => {
      if (unsubscribe) {
        unsubscribe();
        unsubscribe = null;
      }
    };
    try {
      unsubscribe = subscribeUserVideoAiPracticeState(video.id, () => {
        // Each publish patches the entry; reload so the row
        // re-renders with the latest status / progress / count.
        // (We don't push the in-memory state straight into
        // CollectionVideoItem; that would require lifting the
        // state up, and a re-read is cheap.)
        void load(true);
      });
      await generateUserVideoAiPracticeCards(video.id);
      // On success, deep-link into the AI 陪练 tab with this
      // video as the context so the user can browse the freshly
      // generated topics immediately. (If the AI 陪练 tab
      // doesn't yet read the `videoId` param, this is a
      // forward-compatible no-op.)
      router.push({
        pathname: '/(tabs)/feed',
        params: { videoId: video.id, videoTitle: video.title },
      });
    } catch (err) {
      Alert.alert('AI 话题生成失败', err instanceof Error ? err.message : String(err));
    } finally {
      teardown();
      // Final reload to settle the row state (the subscriber
      // already fires on each publish, but a trailing read
      // guarantees the persisted entry fields are reflected).
      void load(true);
    }
  }, [load, router]);

  if (!parsed) {
    return (
      <View style={styles.center}>
        <Text style={styles.errorText}>无效的合集 id</Text>
        <Pressable style={styles.errorBtn} onPress={() => router.back()}>
          <Text style={styles.errorBtnText}>返回</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={[styles.scrollContent, { paddingBottom: Math.max(120, insets.bottom + 96) }]}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.headerRow}>
          <Pressable style={styles.backBtn} onPress={() => router.back()} hitSlop={8}>
            <ArrowLeft size={20} color={colors.text.primary} />
          </Pressable>
          <View style={{ flex: 1 }} />
          {detail ? (
            <Pressable
              style={styles.menuBtn}
              hitSlop={8}
              onPress={() => setMenuVisible((v) => !v)}
            >
              <MoreVertical size={20} color={colors.text.primary} />
            </Pressable>
          ) : null}
        </View>

        {isLoading && !detail ? (
          <View style={styles.center}>
            <ActivityIndicator size="large" color={colors.primary} />
          </View>
        ) : !detail ? (
          <View style={styles.center}>
            <Text style={styles.errorText}>合集不存在或已被删除</Text>
          </View>
        ) : (
          <>
            {/* ── Header (cover-only) ──
                No cover → no header at all. The card the user just
                tapped already showed the title; showing a plain
                "我的 / abc" text block here would just be a fake
                cover. We drop straight to the video list, no
                "视频" section title either — the list is the page.
                With cover → hero treatment + the count meta + the
                "视频列表" section title. The cover is the
                orientation signal, the list is the body. */}
            {detail.coverImageUri ? (
              <>
                <View style={styles.coverBlock}>
                  <ImageBackground
                    source={{ uri: detail.coverImageUri }}
                    style={styles.coverImage}
                    imageStyle={styles.coverImageInner}
                  >
                    <View style={styles.coverOverlay}>
                      <View style={styles.badgeRow}>
                        <View style={styles.kindBadge}>
                          <Text style={styles.kindBadgeText}>
                            {detail.kind === 'official' ? '推荐' : '我的'}
                          </Text>
                        </View>
                      </View>
                      <Text style={styles.coverTitle} numberOfLines={2}>{detail.title}</Text>
                    </View>
                  </ImageBackground>
                </View>

                <View style={styles.metaLineRow}>
                  <Text style={styles.metaLineText}>
                    {detail.videoCount} {detail.kind === 'official' ? '集' : '个视频'}
                  </Text>
                </View>

                <Text style={styles.sectionTitle}>
                  {detail.kind === 'official' ? '视频列表' : '视频'}
                </Text>
              </>
            ) : null}
            {detail.videos.length === 0 ? (
              <View style={styles.emptyState}>
                <Text style={styles.emptyText}>
                  {detail.kind === 'user' ? '这个合集还是空的' : '这个合集还没有内容'}
                </Text>
              </View>
            ) : (
              <View style={styles.videoList}>
                {detail.videos.map((video) => (
                  <VideoRow
                    key={video.id}
                    video={video}
                    onPress={() => handleOpenVideo(video.id)}
                    onMorePress={
                      // Only user-managed rows get a "..." affordance.
                      // Official episodes are locked, packs and
                      // user videos both support move / remove.
                      video.source && video.source !== 'official'
                        ? () => handleOpenVideoActions(video)
                        : undefined
                    }
                    onCachePress={
                      // Only the baidu cloud-reference rows light
                      // up as actionable; everything else is a
                      // static "已缓存" / "远端" badge.
                      video.origin === 'baidu-pan' && video.cacheStatus !== 'cached'
                        ? () => handleRowCachePress(video)
                        : undefined
                    }
                    onBindingPress={
                      // Official video rows: actionable whenever
                      // the binding isn't already 'bound'. Tapping
                      // either deep-links to the cloud-drives
                      // sheet (no provider configured) or triggers
                      // a fresh rescan (user might have dropped
                      // the file since the last scan).
                      video.source === 'official' && video.bindingStatus && video.bindingStatus !== 'bound'
                        ? () => handleRowBindingPress(video)
                        : undefined
                    }
                    onSubtitlePress={
                      // 'none' / 'pending' / 'error' all light up
                      // (the chip builder re-renders the label
                      // and tint per state); 'ready' /
                      // 'processing' are static.
                      video.source === 'user-video'
                      && video.subtitleStatus
                      && video.subtitleStatus !== 'ready'
                      && video.subtitleStatus !== 'processing'
                        ? () => handleRowSubtitlePress(video)
                        : undefined
                    }
                    onAiTopicPress={
                      // User videos with no AI topics light up.
                      // The handler itself gates on cache +
                      // subtitle readiness; the chip stays
                      // tappable either way so the user gets a
                      // "what's blocking me" message.
                      video.source === 'user-video' && video.aiTopicStatus === 'none'
                        ? () => handleRowAiTopicPress(video)
                        : undefined
                    }
                    downloadProgress={downloadProgress[video.id]}
                  />
                ))}
              </View>
            )}
          </>
        )}
      </ScrollView>

      {menuVisible ? (
        <View style={styles.menuOverlay}>
          <Pressable style={StyleSheet.absoluteFill} onPress={() => setMenuVisible(false)} />
          <View style={styles.menuSheet}>
            {parsed.kind === 'official' ? (
              <>
                <Text style={styles.menuTitle}>推荐合集选项</Text>
                <Pressable
                  style={styles.menuItem}
                  onPress={handleUnpickOfficial}
                >
                  <Trash2 size={16} color={colors.text.primary} />
                  <Text style={styles.menuItemText}>从我的合集移出</Text>
                </Pressable>
              </>
            ) : (
              <>
                <Text style={styles.menuTitle}>我的合集选项</Text>
                <Pressable style={styles.menuItem} onPress={handleOpenImportSheet}>
                  <Upload size={16} color={colors.text.primary} />
                  <Text style={styles.menuItemText}>导入视频</Text>
                </Pressable>
                <Pressable style={styles.menuItem} onPress={handleStartRename}>
                  <Pencil size={16} color={colors.text.primary} />
                  <Text style={styles.menuItemText}>重命名</Text>
                </Pressable>
                <Pressable
                  style={[styles.menuItem, styles.menuItemDanger]}
                  onPress={handleDeleteUserCollection}
                >
                  <Trash2 size={16} color="#DC2626" />
                  <Text style={[styles.menuItemText, { color: '#DC2626' }]}>删除合集</Text>
                </Pressable>
              </>
            )}
          </View>
        </View>
      ) : null}

      {renameVisible ? (
        <View style={styles.renameOverlay}>
          <View style={styles.renameSheet}>
            <Text style={styles.renameTitle}>重命名合集</Text>
            <TextInput
              style={styles.renameInput}
              value={renameText}
              onChangeText={setRenameText}
              autoFocus
              maxLength={40}
              placeholder="合集名"
              placeholderTextColor={colors.text.tertiary}
            />
            <View style={styles.renameActions}>
              <Pressable
                style={[styles.renameBtn, styles.renameBtnGhost]}
                onPress={() => setRenameVisible(false)}
              >
                <Text style={styles.renameBtnGhostText}>取消</Text>
              </Pressable>
              <Pressable
                style={[styles.renameBtn, styles.renameBtnPrimary]}
                onPress={handleSubmitRename}
              >
                <Check size={14} color="#FFFFFF" />
                <Text style={styles.renameBtnPrimaryText}>保存</Text>
              </Pressable>
            </View>
          </View>
        </View>
      ) : null}

      {/* ── Import video sheet (only for user collections) ──────
            Pre-selects the current collection; the user can still
            switch to a different one via the inline selector. */}
      {parsed?.kind === 'user' ? (
        <ImportVideoSheet
          visible={isImportSheetVisible}
          defaultCollectionId={id}
          onClose={() => setIsImportSheetVisible(false)}
          onImportSuccess={handleImportSheetSuccess}
        />
      ) : null}

      {/* ── Per-video action sheet (移动到合集 / 从合集移除) ──
            Opened from the "..." button on each user-managed row.
            Compact 2-row action menu; the "取消" row is omitted
            because tapping the backdrop already dismisses (same
            pattern as the home-page addMenu). */}
      {isActionSheetVisible && actionTarget ? (
        <View style={styles.menuOverlay}>
          <Pressable
            style={StyleSheet.absoluteFill}
            onPress={handleCloseVideoActions}
          />
          <View style={styles.videoActionSheet}>
            <View style={styles.customSheetHandle} />
            <Text style={styles.videoActionTitle} numberOfLines={1}>
              {actionTarget.title}
            </Text>
            <Pressable
              style={styles.menuItem}
              // Don't call handleCloseVideoActions here — that
              // handler discards `actionTarget`, and the move
              // picker needs the target to know which row to move.
              // handleStartMoveTo flips the action-sheet visibility
              // off on its own while keeping `actionTarget` alive.
              onPress={() => {
                void handleStartMoveTo();
              }}
            >
              <FolderInput size={16} color={colors.text.primary} />
              <Text style={styles.menuItemText}>移动到合集</Text>
            </Pressable>
            <Pressable
              style={[styles.menuItem, styles.menuItemDanger]}
              onPress={handleRemoveFromCollection}
            >
              <Trash2 size={16} color="#DC2626" />
              <Text style={[styles.menuItemText, { color: '#DC2626' }]}>
                {detail?.isDefault === true ? '删除视频' : '从合集移除'}
              </Text>
            </Pressable>
          </View>
        </View>
      ) : null}

      {/* ── Move picker (sub-sheet for "移动到合集") ───────────
            Same visual family as the import target picker.
            Current collection is excluded from the list — a
            video can't move to the collection it already lives in.
            When the user has only the current collection, the
            "no other collections" empty state explains why the
            action is a no-op rather than just silently closing. */}
      {isMovePickerVisible ? (
        <View style={styles.menuOverlay}>
          <Pressable
            style={StyleSheet.absoluteFill}
            onPress={handleCloseMovePicker}
          />
          <View style={styles.movePickerSheet}>
            <View style={styles.customSheetHandle} />
            <Text style={styles.pickerSheetTitle}>移动到哪个合集</Text>
            {isMovePickerLoading ? (
              <View style={styles.pickerLoading}>
                <ActivityIndicator size="small" color={colors.primary} />
              </View>
            ) : (
              <ScrollView style={styles.pickerList} showsVerticalScrollIndicator={false}>
                {movePickerCollections
                  .filter((c) => encodeUserCollectionId(c.id) !== id)
                  .map((c) => {
                    const wireId = encodeUserCollectionId(c.id);
                    return (
                      <Pressable
                        key={c.id}
                        style={styles.pickerRow}
                        onPress={() => void handlePickMoveTarget(wireId)}
                      >
                        <View style={styles.pickerRowText}>
                          <Text style={styles.pickerRowTitle} numberOfLines={1}>
                            {c.title}
                          </Text>
                          {c.is_default ? (
                            <Text style={styles.pickerRowBadge}>默认</Text>
                          ) : null}
                        </View>
                      </Pressable>
                    );
                  })}
                {movePickerCollections.filter(
                  (c) => encodeUserCollectionId(c.id) !== id,
                ).length === 0 ? (
                  <Text style={styles.pickerEmpty}>
                    没有其他合集可移动。先在添加内容里建一个新合集吧。
                  </Text>
                ) : null}
              </ScrollView>
            )}
          </View>
        </View>
      ) : null}
    </View>
  );
}

function VideoRow({
  video,
  onPress,
  onMorePress,
  onCachePress,
  onBindingPress,
  onSubtitlePress,
  onAiTopicPress,
  downloadProgress,
}: {
  video: CollectionVideoItem;
  onPress: () => void;
  /**
   * Tap on the row's "..." button. Only supplied for
   * user-managed videos; the official-series list doesn't
   * surface this button (read-only).
   */
  onMorePress?: () => void;
  /**
   * Tap on the cache chip (when the chip is in an actionable
   * state). Not provided → chip is a static badge.
   */
  onCachePress?: () => void;
  /** Same pattern for the binding chip (official rows). */
  onBindingPress?: () => void;
  /** Same pattern for the subtitle chip. */
  onSubtitlePress?: () => void;
  /** Same pattern for the AI topic chip. */
  onAiTopicPress?: () => void;
  /**
   * Live download progress for cloud-reference rows. The page
   * subscribes to `subscribeDownloadState` and passes the
   * current snapshot here so the cache chip can show
   * "下载中 32%" without re-rendering the whole list.
   */
  downloadProgress?: { status: string; progress: number };
}) {
  // Status chips. Each builder returns the chip element OR null
  // when the row shouldn't render one. Chips that are actionable
  // for the current state wrap themselves in a Pressable that
  // calls the matching onXxxPress; chips that are read-only
  // render as a plain View.
  const originChip = buildOriginChip(video);
  const bindingChip = buildBindingChip(video, onBindingPress);
  const cacheChip = buildCacheChip(video, onCachePress, downloadProgress);
  const subtitleChip = buildSubtitleChip(video, onSubtitlePress);
  const aiTopicChip = buildAiTopicChip(video, onAiTopicPress);

  return (
    <Pressable style={styles.videoRow} onPress={onPress}>
      {/* Cover thumbnail (square). Falls back to a tinted
          placeholder with the episode index for official rows
          that don't have a per-episode cover. */}
      {video.coverImageUri ? (
        <Image source={{ uri: video.coverImageUri }} style={styles.videoThumb} />
      ) : (
        <View style={[styles.videoThumb, styles.videoThumbFallback]}>
          {typeof video.episodeIndex === 'number' ? (
            <Text style={styles.videoThumbFallbackText}>{video.episodeIndex}</Text>
          ) : (
            <Play size={18} color={colors.text.secondary} />
          )}
        </View>
      )}

      <View style={styles.videoBody}>
        <Text style={styles.videoTitle} numberOfLines={2}>
          {video.title}
        </Text>
        <View style={styles.videoMetaRow}>
          {typeof video.episodeIndex === 'number' ? (
            <Text style={styles.videoMetaText}>{video.episodeIndex}.</Text>
          ) : null}
          {typeof video.durationSeconds === 'number' && video.durationSeconds > 0 ? (
            <Text style={styles.videoMetaText}>
              {formatVideoDuration(video.durationSeconds)}
            </Text>
          ) : null}
        </View>
        {(originChip || bindingChip || cacheChip || subtitleChip || aiTopicChip) ? (
          <View style={styles.videoChipRow}>
            {originChip}
            {bindingChip}
            {cacheChip}
            {subtitleChip}
            {aiTopicChip}
          </View>
        ) : null}
      </View>

      {onMorePress ? (
        <Pressable
          onPress={(e) => {
            // Stop the parent row's onPress (which would navigate
            // to the player) from firing — the user explicitly
            // tapped the action button, not the row body.
            e.stopPropagation();
            onMorePress();
          }}
          hitSlop={8}
          style={styles.videoMoreBtn}
        >
          <MoreVertical size={16} color={colors.text.secondary} />
        </Pressable>
      ) : (
        <View style={styles.videoPlayIcon}>
          <Play size={14} color={colors.text.secondary} />
        </View>
      )}
    </Pressable>
  );
}

function formatVideoDuration(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

/**
 * Build the subtitle status pill for a user-video row. Returns
 * null if the row shouldn't render any pill (official / pack
 * rows, or videos that never requested subtitles).
 *
 * `onSubtitlePress` lights the chip up as a Pressable for the
 * states where the user can re-trigger generation: 'none' (never
 * started), 'pending' (queued but not running), 'error' (failed,
 * retry). 'ready' is read-only; 'processing' is also read-only
 * (we don't expose a "cancel" affordance yet).
 */
function buildSubtitleChip(
  video: CollectionVideoItem,
  onSubtitlePress?: () => void,
): React.ReactNode {
  if (video.source !== 'user-video') return null;
  const status = video.subtitleStatus;
  if (!status || status === 'none') {
    if (!onSubtitlePress) return null;
    return (
      <Pressable
        onPress={(e) => { e.stopPropagation(); onSubtitlePress(); }}
        hitSlop={6}
        style={[styles.subtitlePill, styles.subtitlePillActionable]}
      >
        <Languages size={10} color={colors.text.secondary} />
        <Text style={[styles.subtitlePillText, styles.subtitlePillTextPending]}>生成字幕</Text>
      </Pressable>
    );
  }
  if (status === 'ready') {
    return (
      <View style={[styles.subtitlePill, styles.subtitlePillReady]}>
        <Check size={10} color="#0F766E" />
        <Text style={[styles.subtitlePillText, styles.subtitlePillTextReady]}>字幕</Text>
      </View>
    );
  }
  if (status === 'processing') {
    // Prefer the human-readable phase message ("下载 88MB / 250MB")
    // when present; fall back to a percent of `subtitlePhaseProgress`.
    const pct = typeof video.subtitlePhaseProgress === 'number'
      ? Math.round(video.subtitlePhaseProgress * 100)
      : null;
    const label = video.subtitlePhaseMessage
      ? (pct != null ? `${video.subtitlePhaseMessage} ${pct}%` : video.subtitlePhaseMessage)
      : pct != null
        ? `生成中 ${pct}%`
        : '生成中…';
    return (
      <View style={[styles.subtitlePill, styles.subtitlePillProcessing]}>
        <Text style={[styles.subtitlePillText, styles.subtitlePillTextProcessing]}>{label}</Text>
      </View>
    );
  }
  if (status === 'pending') {
    return (
      <View style={[styles.subtitlePill, styles.subtitlePillPending]}>
        <Text style={[styles.subtitlePillText, styles.subtitlePillTextPending]}>字幕待生成</Text>
      </View>
    );
  }
  // 'error'
  if (onSubtitlePress) {
    return (
      <Pressable
        onPress={(e) => { e.stopPropagation(); onSubtitlePress(); }}
        hitSlop={6}
        style={[styles.subtitlePill, styles.subtitlePillActionable, styles.subtitlePillError]}
      >
        <Text style={[styles.subtitlePillText, styles.subtitlePillTextError]}>重试字幕</Text>
      </Pressable>
    );
  }
  return (
    <View style={[styles.subtitlePill, styles.subtitlePillError]}>
      <Text style={[styles.subtitlePillText, styles.subtitlePillTextError]}>字幕失败</Text>
    </View>
  );
}

/**
 * Build the source-origin chip (where the bytes come from).
 * Always rendered when the row has an origin; the chip itself is
 * purely informational (no action — the user doesn't change a
 * video's source post-import in v1).
 */
function buildOriginChip(video: CollectionVideoItem): React.ReactNode {
  const origin = video.origin;
  if (!origin) return null;
  // 'official' is implicit (no chip needed for a recommended
  // series), but the user did ask for "来源" visibility on every
  // row, so we surface it.
  if (origin === 'official') {
    return (
      <View style={[styles.chip, styles.originChipOfficial]}>
        <Cloud size={10} color={colors.text.secondary} />
        <Text style={[styles.chipText, styles.originChipOfficialText]}>推荐</Text>
      </View>
    );
  }
  if (origin === 'baidu-pan') {
    return (
      <View style={[styles.chip, styles.originChipBaidu]}>
        <HardDrive size={10} color={colors.text.secondary} />
        <Text style={[styles.chipText, styles.originChipBaiduText]}>百度网盘</Text>
      </View>
    );
  }
  if (origin === 'local') {
    return (
      <View style={[styles.chip, styles.originChipLocal]}>
        <HardDrive size={10} color={colors.text.secondary} />
        <Text style={[styles.chipText, styles.originChipLocalText]}>本地</Text>
      </View>
    );
  }
  // 'pack'
  return (
    <View style={[styles.chip, styles.originChipPack]}>
      <HardDrive size={10} color={colors.text.secondary} />
      <Text style={[styles.chipText, styles.originChipPackText]}>导入包</Text>
    </View>
  );
}

/**
 * Build the cloud-drive binding chip (official rows only).
 * Shows whether the user's Baidu pan has a matching file for
 * this scene, sourced from `OfficialSceneSyncRecord`. Lights
 * up as a Pressable when the entry needs attention:
 *   - 'not_synced' / 'unbound' → no record yet, tap to scan
 *   - 'stale' / 'error'        → record exists but is bad,
 *                                 tap to re-scan
 *   - 'bound'                  → no action, read-only
 *
 * `onBindingPress` is what the page wires to either deep-link
 * to the cloud-drives sheet (when no provider is configured) or
 * to trigger a fresh `rescanOfficialSceneSyncStatus` (when the
 * user might have dropped the file in their drive since the
 * last scan).
 */
function buildBindingChip(
  video: CollectionVideoItem,
  onBindingPress?: () => void,
): React.ReactNode {
  // Only meaningful for official scenes — user-built videos
  // don't have cloud-drive bindings.
  if (video.source !== 'official') return null;
  const status = video.bindingStatus;
  if (!status) return null;
  const isActionable = typeof onBindingPress === 'function' && status !== 'bound';
  const palette = (() => {
    switch (status) {
      case 'bound':
        return { bg: 'rgba(15,118,110,0.10)', fg: '#0F766E', label: '已绑定', Icon: Link2 };
      case 'stale':
        return { bg: 'rgba(245,158,11,0.10)', fg: '#B45309', label: '需刷新', Icon: RefreshCw };
      case 'error':
        return { bg: 'rgba(220,38,38,0.10)', fg: '#DC2626', label: '绑定出错', Icon: Link2 };
      case 'unbound':
      case 'not_synced':
      default:
        return { bg: 'rgba(37,99,235,0.08)', fg: colors.text.secondary, label: '未绑定', Icon: CloudOff };
    }
  })();
  const { bg, fg, label, Icon } = palette;
  const containerStyle = [
    styles.chip,
    { backgroundColor: bg },
    isActionable && styles.chipActionable,
  ];
  const iconColor = isActionable ? colors.primary : fg;
  const textStyle = [styles.chipText, { color: fg }];
  if (isActionable) {
    return (
      <Pressable
        onPress={(e) => { e.stopPropagation(); onBindingPress!(); }}
        hitSlop={6}
        style={containerStyle}
      >
        <Icon size={10} color={iconColor} />
        <Text style={textStyle}>{label}</Text>
      </Pressable>
    );
  }
  return (
    <View style={containerStyle}>
      <Icon size={10} color={iconColor} />
      <Text style={textStyle}>{label}</Text>
    </View>
  );
}

/**
 * Build the cache chip. Light up as a Pressable ONLY when the
 * entry is in 'remote' state (downloadable) AND the caller
 * supplied an `onCachePress`. 'cached' is read-only; 'downloading'
 * reads from the in-memory `downloadProgress` prop (the
 * subscription lives in the page) and shows a live percent.
 */
function buildCacheChip(
  video: CollectionVideoItem,
  onCachePress?: () => void,
  downloadProgress?: { status: string; progress: number },
): React.ReactNode {
  const status = video.cacheStatus;
  if (!status) return null;
  if (status === 'cached') {
    return (
      <View style={[styles.chip, styles.cacheChipCached]}>
        <Check size={10} color="#0F766E" />
        <Text style={[styles.chipText, styles.cacheChipCachedText]}>已缓存</Text>
      </View>
    );
  }
  if (status === 'downloading' || (downloadProgress && (downloadProgress.status === 'downloading' || downloadProgress.status === 'resolving'))) {
    // Live percent when we have it. The cloud-video-playback
    // layer reports 0..1; round to the nearest int. While the
    // download is in the 'resolving' phase (preparing the URL)
    // we don't have a percent yet — show "准备中" instead of
    // "下载中 0%" so the user isn't left wondering.
    const label = downloadProgress?.status === 'resolving'
      ? '准备中…'
      : downloadProgress
        ? `下载中 ${Math.round(downloadProgress.progress * 100)}%`
        : '下载中';
    return (
      <View style={[styles.chip, styles.cacheChipDownloading]}>
        <Download size={10} color="#1D4ED8" />
        <Text style={[styles.chipText, styles.cacheChipDownloadingText]}>{label}</Text>
      </View>
    );
  }
  // 'remote' — actionable when the caller wired an onCachePress
  // and the entry supports download (cloud references only;
  // official / local / pack are not downloadable).
  if (onCachePress && video.source === 'user-video' && video.origin === 'baidu-pan') {
    return (
      <Pressable
        onPress={(e) => { e.stopPropagation(); onCachePress(); }}
        hitSlop={6}
        style={[styles.chip, styles.chipActionable, styles.cacheChipRemote]}
      >
        <CloudOff size={10} color={colors.text.secondary} />
        <Text style={[styles.chipText, styles.cacheChipRemoteText]}>缓存</Text>
      </Pressable>
    );
  }
  // For everything else, render a static "远端" badge.
  return (
    <View style={[styles.chip, styles.cacheChipRemote]}>
      <CloudOff size={10} color={colors.text.secondary} />
      <Text style={[styles.chipText, styles.cacheChipRemoteText]}>远端</Text>
    </View>
  );
}

/**
 * Build the AI-topic chip. State machine:
 *   - 'pre-shipped' / 'ready' — static checkmark, no action
 *   - 'processing' — blue progress chip with a live message +
 *     percent (where `aiTopicProgress` is 0..1). Read-only while
 *     the LLM is running; we don't surface cancel in v1.
 *   - 'error' — red retry chip, calls onAiTopicPress on tap
 *   - 'none' (or undefined) — gray actionable chip; tap calls
 *     onAiTopicPress which itself gates on cache + subtitle.
 */
function buildAiTopicChip(
  video: CollectionVideoItem,
  onAiTopicPress?: () => void,
): React.ReactNode {
  const status = video.aiTopicStatus;
  if (!status || status === 'none') {
    if (onAiTopicPress && video.source === 'user-video') {
      return (
        <Pressable
          onPress={(e) => { e.stopPropagation(); onAiTopicPress(); }}
          hitSlop={6}
          style={[styles.chip, styles.chipActionable, styles.aiTopicChipNone]}
        >
          <Bot size={10} color={colors.text.secondary} />
          <Text style={[styles.chipText, styles.aiTopicChipNoneText]}>AI 话题</Text>
        </Pressable>
      );
    }
    return (
      <View style={[styles.chip, styles.aiTopicChipNone]}>
        <Bot size={10} color={colors.text.secondary} />
        <Text style={[styles.chipText, styles.aiTopicChipNoneText]}>AI 话题</Text>
      </View>
    );
  }
  if (status === 'pre-shipped' || status === 'ready') {
    return (
      <View style={[styles.chip, styles.aiTopicChipReady]}>
        <Bot size={10} color="#7C3AED" />
        <Text style={[styles.chipText, styles.aiTopicChipReadyText]}>AI 话题</Text>
      </View>
    );
  }
  if (status === 'processing') {
    // Same UX as the subtitle processing chip: phase message
    // ("整理字幕上下文…", "解析 3/5 个场景…") takes priority; fall
    // back to a plain "生成中 N%" when only the progress ratio
    // is available.
    const pct = typeof video.aiTopicProgress === 'number'
      ? Math.round(video.aiTopicProgress * 100)
      : null;
    const label = video.aiTopicProgressMessage
      ? (pct != null ? `${video.aiTopicProgressMessage} ${pct}%` : video.aiTopicProgressMessage)
      : pct != null
        ? `生成中 ${pct}%`
        : '生成中…';
    return (
      <View style={[styles.chip, styles.aiTopicChipProcessing]}>
        <Text style={[styles.chipText, styles.aiTopicChipProcessingText]}>{label}</Text>
      </View>
    );
  }
  // 'error' — actionable retry chip. Reuses the same gate as
  // 'none': the handler validates cache + subtitle readiness
  // before kicking off a new run.
  if (onAiTopicPress && video.source === 'user-video') {
    return (
      <Pressable
        onPress={(e) => { e.stopPropagation(); onAiTopicPress(); }}
        hitSlop={6}
        style={[styles.chip, styles.chipActionable, styles.aiTopicChipError]}
      >
        <Bot size={10} color="#DC2626" />
        <Text style={[styles.chipText, styles.aiTopicChipErrorText]}>重试 AI</Text>
      </Pressable>
    );
  }
  return (
    <View style={[styles.chip, styles.aiTopicChipError]}>
      <Bot size={10} color="#DC2626" />
      <Text style={[styles.chipText, styles.aiTopicChipErrorText]}>AI 话题失败</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  scroll: { flex: 1 },
  scrollContent: { paddingHorizontal: spacing.md, paddingTop: spacing.md },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xl },
  errorText: { color: colors.text.secondary, fontSize: fontSize.base, marginBottom: spacing.md },
  errorBtn: { paddingHorizontal: spacing.lg, paddingVertical: spacing.sm, backgroundColor: colors.primary, borderRadius: borderRadius.md },
  errorBtnText: { color: '#FFFFFF', fontWeight: fontWeight.semibold },

  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: spacing.md,
    gap: spacing.sm,
  },
  backBtn: {
    width: 36, height: 36, borderRadius: 18,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.04)',
  },
  menuBtn: {
    width: 36, height: 36, borderRadius: 18,
    alignItems: 'center', justifyContent: 'center',
  },

  coverBlock: { marginBottom: spacing.md },
  coverImage: {
    width: '100%',
    height: 200,
    borderRadius: borderRadius.lg,
    overflow: 'hidden',
    backgroundColor: '#475569',
  },
  coverImageInner: { borderRadius: borderRadius.lg },
  coverOverlay: {
    flex: 1,
    justifyContent: 'space-between',
    padding: spacing.md,
    backgroundColor: 'rgba(15,23,42,0.45)',
  },
  badgeRow: { flexDirection: 'row', gap: 6 },
  kindBadge: {
    paddingHorizontal: 10, paddingVertical: 3,
    borderRadius: 999,
    backgroundColor: 'rgba(255,255,255,0.18)',
  },
  kindBadgeText: { color: '#FFFFFF', fontSize: 11, fontWeight: fontWeight.semibold },
  coverTitle: { color: '#FFFFFF', fontSize: fontSize.xxl, fontWeight: fontWeight.bold },

  // Single meta line under the cover — just the count. The
  // "集数 / 已完成" two-up stat block is gone; the page is
  // about the video list, not progress.
  metaLineRow: { marginBottom: spacing.md },
  metaLineText: {
    fontSize: fontSize.sm,
    color: colors.text.secondary,
  },

  sectionTitle: {
    fontSize: fontSize.lg, fontWeight: fontWeight.semibold,
    color: colors.text.primary, marginBottom: spacing.sm,
  },
  videoList: { gap: spacing.xs },

  // ── Video row ──
  // Each row is a pressable surface with: a square cover
  // thumbnail (with a tinted fallback for rows missing a
  // per-episode cover), a body column with the title (2 lines)
  // and a meta line (index / duration / cached / subtitle
  // state), and a right-edge affordance ("..." for user-managed
  // rows, play-arrow for the read-only official rows).
  videoRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    backgroundColor: colors.surface,
    borderRadius: borderRadius.md,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.sm,
    borderWidth: 1,
    borderColor: 'rgba(0,0,0,0.05)',
  },
  videoThumb: {
    width: 64,
    height: 64,
    borderRadius: borderRadius.sm,
    backgroundColor: '#E2E8F0',
  },
  videoThumbFallback: {
    backgroundColor: 'rgba(15,118,110,0.10)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  videoThumbFallbackText: {
    fontSize: fontSize.lg,
    color: '#0F766E',
    fontWeight: fontWeight.bold,
  },
  videoBody: {
    flex: 1,
    minWidth: 0,
  },
  videoTitle: {
    fontSize: fontSize.base,
    color: colors.text.primary,
    fontWeight: fontWeight.medium,
  },
  videoMetaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 4,
    flexWrap: 'wrap',
  },
  videoMetaText: {
    fontSize: 12,
    color: colors.text.secondary,
  },

  // ── Status chip row (origin / cache / subtitle / AI topic) ──
  // Renders BELOW the meta line so the row stays scannable: title
  // up top, timecode in the middle, state badges at the bottom.
  // Each chip is independently optional; the row flex-wraps so
  // a 4-chip row can shrink to 2-chip if the title is long.
  videoChipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 4,
    marginTop: 6,
  },

  // Generic chip surface. Variants (origin / cache / subtitle /
  // AI topic) all inherit this size + radius and override the
  // tinted background + text color.
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: borderRadius.full,
    backgroundColor: 'rgba(0,0,0,0.04)',
  },
  chipText: {
    fontSize: 10,
    fontWeight: fontWeight.semibold,
    color: colors.text.secondary,
  },
  // Pressable chips: a subtle tint + slight press feedback to
  // signal they're tappable (vs. the read-only badges that look
  // identical at rest but respond to the row's onPress when
  // tapped directly).
  chipActionable: {
    backgroundColor: 'rgba(37,99,235,0.08)',
  },

  // Origin variants — all read-only, all share the chip base.
  originChipOfficial: { backgroundColor: 'rgba(15,118,110,0.10)' },
  originChipOfficialText: { color: '#0F766E' },
  originChipBaidu: { backgroundColor: 'rgba(220,38,38,0.08)' },
  originChipBaiduText: { color: '#DC2626' },
  originChipLocal: { backgroundColor: 'rgba(15,118,110,0.10)' },
  originChipLocalText: { color: '#0F766E' },
  originChipPack: { backgroundColor: 'rgba(0,0,0,0.04)' },
  originChipPackText: { color: colors.text.secondary },

  // Cache variants.
  cacheChipCached: { backgroundColor: 'rgba(15,118,110,0.10)' },
  cacheChipCachedText: { color: '#0F766E' },
  cacheChipDownloading: { backgroundColor: 'rgba(37,99,235,0.10)' },
  cacheChipDownloadingText: { color: '#1D4ED8' },
  cacheChipRemote: { backgroundColor: 'rgba(0,0,0,0.04)' },
  cacheChipRemoteText: { color: colors.text.secondary },

  // AI topic variants.
  aiTopicChipReady: { backgroundColor: 'rgba(124,58,237,0.10)' },
  aiTopicChipReadyText: { color: '#7C3AED' },
  aiTopicChipProcessing: { backgroundColor: 'rgba(37,99,235,0.10)' },
  aiTopicChipProcessingText: { color: '#1D4ED8' },
  aiTopicChipError: { backgroundColor: 'rgba(220,38,38,0.10)' },
  aiTopicChipErrorText: { color: '#DC2626' },
  aiTopicChipNone: { backgroundColor: 'rgba(0,0,0,0.04)' },
  aiTopicChipNoneText: { color: colors.text.secondary },
  videoPlayIcon: {
    width: 24,
    height: 24,
    alignItems: 'center',
    justifyContent: 'center',
  },
  videoMoreBtn: {
    width: 24,
    height: 24,
    alignItems: 'center',
    justifyContent: 'center',
  },

  // ── Subtitle / cache pills ──
  // Each variant uses a tinted background + matching text so
  // they read as "state indicators" rather than actionable
  // buttons.
  cachedPill: {
    paddingHorizontal: 6,
    paddingVertical: 1,
    borderRadius: 999,
    backgroundColor: 'rgba(0,0,0,0.05)',
  },
  cachedPillText: {
    fontSize: 10,
    color: colors.text.secondary,
    fontWeight: fontWeight.medium,
  },
  subtitlePill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    paddingHorizontal: 6,
    paddingVertical: 1,
    borderRadius: 999,
  },
  subtitlePillText: {
    fontSize: 10,
    fontWeight: fontWeight.semibold,
  },
  subtitlePillReady: { backgroundColor: 'rgba(15,118,110,0.10)' },
  subtitlePillTextReady: { color: '#0F766E' },
  subtitlePillProcessing: { backgroundColor: 'rgba(37,99,235,0.10)' },
  subtitlePillTextProcessing: { color: '#1D4ED8' },
  subtitlePillPending: { backgroundColor: 'rgba(0,0,0,0.05)' },
  subtitlePillTextPending: { color: colors.text.secondary },
  subtitlePillError: { backgroundColor: 'rgba(220,38,38,0.10)' },
  subtitlePillTextError: { color: '#DC2626' },
  // The "none / error" subtitle chips are Pressable when the
  // caller supplied an onSubtitlePress; this style is the
  // actionable tint (matches the cache/AI-topic actionable
  // chips so the row reads consistently).
  subtitlePillActionable: { backgroundColor: 'rgba(37,99,235,0.08)' },

  emptyState: { padding: spacing.lg, alignItems: 'center' },
  emptyText: { color: colors.text.secondary, fontSize: fontSize.sm },

  menuOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.4)',
    justifyContent: 'flex-end',
  },
  menuSheet: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: borderRadius.lg,
    borderTopRightRadius: borderRadius.lg,
    padding: spacing.md,
    paddingBottom: spacing.xl,
  },
  menuTitle: { fontSize: fontSize.xs, color: colors.text.secondary, marginBottom: spacing.sm, textTransform: 'uppercase', letterSpacing: 0.5 },
  menuItem: {
    flexDirection: 'row', alignItems: 'center', gap: spacing.sm,
    paddingVertical: 12,
  },
  menuItemDanger: {},
  menuItemText: { fontSize: fontSize.base, color: colors.text.primary },

  // ── Per-video action sheet (mirrors the home-page addMenu) ──
  // 2 action rows + the target's title at the top. No cancel row
  // because the backdrop tap already closes the sheet.
  customSheetHandle: {
    width: 40,
    height: 5,
    backgroundColor: colors.border.default,
    borderRadius: borderRadius.full,
    alignSelf: 'center',
    marginBottom: spacing.sm,
  },
  videoActionSheet: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: borderRadius.lg,
    borderTopRightRadius: borderRadius.lg,
    paddingHorizontal: spacing.md,
    paddingTop: spacing.sm,
    paddingBottom: spacing.xl,
  },
  videoActionTitle: {
    fontSize: fontSize.base,
    fontWeight: fontWeight.semibold,
    color: colors.text.primary,
    paddingVertical: spacing.sm,
    marginBottom: spacing.xs,
  },

  // ── Move picker (target chooser for "移动到合集") ──────────
  // Same family as the import target picker on the home page:
  // list of user collections, current one filtered out, "默认"
  // badge on the default collection, empty state when the user
  // has no other collections to move to.
  movePickerSheet: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: borderRadius.lg,
    borderTopRightRadius: borderRadius.lg,
    paddingHorizontal: spacing.md,
    paddingTop: spacing.md,
    paddingBottom: spacing.xl,
    maxHeight: '70%',
  },
  pickerSheetTitle: {
    fontSize: fontSize.lg,
    fontWeight: fontWeight.bold,
    color: colors.text.primary,
    marginBottom: spacing.sm,
  },
  pickerLoading: {
    paddingVertical: spacing.xl,
    alignItems: 'center',
  },
  pickerList: {
    maxHeight: 360,
  },
  pickerEmpty: {
    fontSize: fontSize.sm,
    color: colors.text.tertiary,
    textAlign: 'center',
    paddingVertical: spacing.lg,
  },
  pickerRow: {
    flexDirection: 'row', alignItems: 'center',
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.border.default,
  },
  pickerRowText: {
    flex: 1,
    flexDirection: 'row', alignItems: 'center', gap: spacing.sm,
  },
  pickerRowTitle: {
    fontSize: fontSize.base,
    color: colors.text.primary,
    fontWeight: fontWeight.medium,
    flexShrink: 1,
  },
  pickerRowBadge: {
    fontSize: fontSize.xs,
    color: colors.text.tertiary,
    backgroundColor: 'rgba(0,0,0,0.04)',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: borderRadius.sm,
    overflow: 'hidden',
  },

  renameOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.4)',
    justifyContent: 'center',
    paddingHorizontal: spacing.lg,
  },
  renameSheet: {
    backgroundColor: colors.surface,
    borderRadius: borderRadius.lg,
    padding: spacing.md,
  },
  renameTitle: { fontSize: fontSize.base, fontWeight: fontWeight.semibold, marginBottom: spacing.sm, color: colors.text.primary },
  renameInput: {
    borderWidth: 1, borderColor: 'rgba(0,0,0,0.12)',
    borderRadius: borderRadius.md,
    paddingHorizontal: spacing.sm, paddingVertical: 10,
    fontSize: fontSize.base, color: colors.text.primary,
    marginBottom: spacing.md,
  },
  renameActions: { flexDirection: 'row', justifyContent: 'flex-end', gap: spacing.sm },
  renameBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    paddingHorizontal: spacing.md, paddingVertical: 8,
    borderRadius: borderRadius.md,
  },
  renameBtnGhost: { backgroundColor: 'rgba(0,0,0,0.05)' },
  renameBtnGhostText: { color: colors.text.primary, fontWeight: fontWeight.medium },
  renameBtnPrimary: { backgroundColor: colors.primary },
  renameBtnPrimaryText: { color: '#FFFFFF', fontWeight: fontWeight.semibold },
});
