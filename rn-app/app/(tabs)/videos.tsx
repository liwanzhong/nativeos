/**
 * /(tabs)/videos — "我的内容" home page.
 *
 * The video tab is now a single scroll showing every collection the
 * user has, in one flat list (no sub-tabs, no top tabs). The only
 * interactions are:
 *
 *   - tap a collection card → push `/collection/<wireId>`
 *   - tap the + button in the header → bottom action sheet with
 *     "从推荐资源库添加" / "导入本地/网盘视频" / "创建新合集"
 *   - pull to refresh → refetch collections
 *
 * What lives here vs elsewhere:
 *   - The SourcePickerContent / import flow reuses the existing
 *     `handleOpenSourceBinding` and `handleImportLocalVideo` so the
 *     import path is identical to the old "导入" tab. We just
 *     route the user back to the same page after a successful
 *     import and tag the entry with the chosen collection id
 *     (`getDefaultCollectionWireId()` by default, or whatever the
 *     user picked in the collection-picker action sheet).
 *   - "创建新合集" shows a small inline rename-style sheet to take
 *     a title. We do NOT offer cover upload in v1 — `cover_url`
 *     is left null and the home page falls back to a gradient
 *     derived from the title.
 */

import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import {
  ActivityIndicator,
  Alert,
  Modal,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  Check,
  ChevronDown,
  ChevronRight,
  Compass,
  Download,
  Edit3,
  Folder,
  Plus,
  Search,
  Sparkles,
  Trash2,
  Upload,
  X,
} from 'lucide-react-native';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as Sharing from 'expo-sharing';
import { Platform } from 'react-native';
import { colors, spacing, borderRadius, fontSize, fontWeight } from '../../constants/theme';
import {
  listMyCollections,
  invalidateCollectionsCache,
  type CollectionSummary,
} from '../../lib/content/collections';
import {
  createUserCollection,
  deleteUserCollection,
  encodeUserCollectionId,
  getOrCreateDefaultCollection,
  listUserCollections,
  updateUserCollection,
  type UserCollectionRow,
} from '../../lib/content/user-collections';
import { unpickSeries } from '../../lib/content/user-picked-series';
import { invalidateVideoSeriesViewsCache } from '../../lib/content/video-series-supabase-views';
import { invalidateVideoSceneCaches } from '../../lib/content/video-scenes';
import {
  pickAndImportLocalVideo,
  importLocalVideoFromUri,
  createCloudVideoReference,
  DuplicateLocalVideoImportError,
  isVideoCandidate,
  triggerImportedVideoSubtitleGeneration,
  type UserVideoEntry,
} from '../../lib/content/user-videos';
import { ImportVideoSheet } from '../../components/collection/ImportVideoSheet';
import { RecommendedCollectionCard } from '../../components/collection/RecommendedCollectionCard';

const VIDEOS_LOG_PREFIX = '[VideosHome]';

function logTrace(message: string, payload?: unknown) {
  if (payload === undefined) {
    console.log(`${VIDEOS_LOG_PREFIX} ${message}`);
    return;
  }
  console.log(`${VIDEOS_LOG_PREFIX} ${message}`, payload);
}

function warnTrace(message: string, payload?: unknown) {
  if (payload === undefined) {
    console.warn(`${VIDEOS_LOG_PREFIX} ${message}`);
    return;
  }
  console.warn(`${VIDEOS_LOG_PREFIX} ${message}`, payload);
}

type ActionSheetMode = 'closed' | 'addMenu' | 'createCollection';

export default function VideosHome() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ shared?: string }>();

  const [collections, setCollections] = useState<CollectionSummary[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isPullRefreshing, setIsPullRefreshing] = useState(false);
  const [toast, setToast] = useState('');

  // Action sheet state
  const [sheetMode, setSheetMode] = useState<ActionSheetMode>('closed');
  const [newCollectionTitle, setNewCollectionTitle] = useState('');

  // The import flow (source binding sheet + collection picker) is
  // entirely owned by <ImportVideoSheet>. The home page just
  // tracks whether the sheet should be visible.
  const [isImportSheetVisible, setIsImportSheetVisible] = useState(false);
  // Pre-selected target for the next import sheet open. Set by
  // either `handleOpenImport` (no preset — sheet lazy-creates
  // default) or `handleOpenImportFromCard` (pre-selects the
  // tapped card's collection). Reset to undefined after the sheet
  // closes so the next + tap reverts to the default behavior.
  const [importSheetTarget, setImportSheetTarget] = useState<string | undefined>(undefined);
  // Web builds can't import local files via expo-document-picker;
  // the original "导入" tab gates this with the same check, so we
  // do too.
  const isNativeVideoImportSupported = Platform.OS !== 'web';

  // SharedShare import (expo-sharing)
  const { resolvedSharedPayloads, isResolving: isResolvingSharedPayloads } = Sharing.useIncomingShare();

  // Toast helper
  const showToast = useCallback((msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(''), 2000);
  }, []);

  // ── Load collections ───────────────────────────────────────────
  const loadCollections = useCallback(async (forceRefresh: boolean = false) => {
    setIsLoading(true);
    logTrace('loadCollections start', { forceRefresh });
    try {
      const list = await listMyCollections(forceRefresh);
      setCollections(list);
      logTrace('loadCollections success', { count: list.length });
    } catch (err) {
      warnTrace('loadCollections failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      setCollections([]);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useFocusEffect(useCallback(() => {
    void loadCollections(false);
  }, [loadCollections]));

  const onPullRefresh = useCallback(async () => {
    setIsPullRefreshing(true);
    try {
      await loadCollections(true);
    } finally {
      setIsPullRefreshing(false);
    }
  }, [loadCollections]);

  // ── Open collection ────────────────────────────────────────────
  const handleOpenCollection = useCallback((c: CollectionSummary) => {
    router.push(`/collection/${encodeURIComponent(c.id)}`);
  }, [router]);

  // ── Header + button: open action sheet ──────────────────────────
  const handleOpenAddMenu = useCallback(() => {
    setSheetMode('addMenu');
  }, []);

  // ── Action sheet handlers ──────────────────────────────────────
  const handleAddFromLibrary = useCallback(() => {
    setSheetMode('closed');
    router.push('/library');
  }, [router]);

  const handleOpenImport = useCallback(() => {
    setSheetMode('closed');
    setImportSheetTarget(undefined);
    setIsImportSheetVisible(true);
  }, []);

  const handleOpenCreateCollection = useCallback(() => {
    setSheetMode('createCollection');
    setNewCollectionTitle('');
  }, []);

  // Fires after a successful import from ImportVideoSheet. The
  // sheet has already closed itself and triggered subtitle
  // auto-generation; we just need to refresh the home grid and
  // show a toast.
  const handleImportSheetSuccess = useCallback(
    (entry: { id: string; title: string; sourceType?: string }) => {
      setIsImportSheetVisible(false);
      setImportSheetTarget(undefined);
      invalidateVideoSceneCaches();
      invalidateCollectionsCache();
      void loadCollections(true);
      showToast(`已导入：${entry.title || '视频'}`);
    },
    [loadCollections, showToast],
  );

  // ── Create user collection ─────────────────────────────────────
  const handleSubmitCreateCollection = useCallback(async () => {
    const title = newCollectionTitle.trim();
    if (!title) {
      Alert.alert('合集名不能为空');
      return;
    }
    try {
      const row = await createUserCollection({ title });
      setSheetMode('closed');
      setNewCollectionTitle('');
      invalidateCollectionsCache();
      await loadCollections(true);
      // Open the new collection right away.
      router.push(`/collection/user:${row.id}`);
    } catch (err) {
      Alert.alert('创建失败', err instanceof Error ? err.message : String(err));
    }
  }, [newCollectionTitle, loadCollections, router]);

  // ── Per-card "..." menu (home grid) ───────────────────────────
  // The menu is anchored to a single card. We keep two pieces of
  // state separate, like on the collection detail page:
  //   - `cardMenuTarget` carries the CollectionSummary that was
  //     tapped. The handler reads `kind` + `isDefault` to decide
  //     which menu items to render.
  //   - `cardMenuVisible` just gates the render. Hide ≠ discard;
  //     we only clear the target on backdrop tap or after the
  //     operation completes.
  const [cardMenuTarget, setCardMenuTarget] = useState<CollectionSummary | null>(null);
  const [cardMenuVisible, setCardMenuVisible] = useState(false);
  // Card-level rename — same shape as the detail page's rename
  // sheet but driven from the home grid. Reusing the existing
  // `newCollectionTitle` state would be confusing (it's set by the
  // addMenu's "新建合集" path), so this has its own.
  const [cardRenameText, setCardRenameText] = useState('');
  const [cardRenameVisible, setCardRenameVisible] = useState(false);

  const handleOpenCardMenu = useCallback((c: CollectionSummary) => {
    setCardMenuTarget(c);
    setCardMenuVisible(true);
  }, []);

  const handleCloseCardMenu = useCallback(() => {
    setCardMenuVisible(false);
    setCardMenuTarget(null);
  }, []);

  const handleUnpickFromCard = useCallback(async () => {
    if (!cardMenuTarget || cardMenuTarget.kind !== 'official') return;
    const rawId = cardMenuTarget.id.replace(/^official:/, '');
    handleCloseCardMenu();
    try {
      await unpickSeries(rawId);
      invalidateCollectionsCache();
      invalidateVideoSeriesViewsCache();
      void loadCollections(true);
    } catch (err) {
      Alert.alert('移出失败', err instanceof Error ? err.message : String(err));
    }
  }, [cardMenuTarget, loadCollections]);

  const handleStartRenameFromCard = useCallback(() => {
    if (!cardMenuTarget || cardMenuTarget.kind === 'official') return;
    setCardRenameText(cardMenuTarget.title);
    setCardRenameVisible(true);
    setCardMenuVisible(false);
  }, [cardMenuTarget]);

  const handleSubmitRenameFromCard = useCallback(async () => {
    if (!cardMenuTarget || cardMenuTarget.kind === 'official') return;
    const next = cardRenameText.trim();
    if (!next) {
      Alert.alert('合集名不能为空');
      return;
    }
    const userId = Number(cardMenuTarget.id.replace(/^user:/, ''));
    if (!Number.isFinite(userId) || userId <= 0) return;
    try {
      await updateUserCollection(userId, { title: next });
      setCardRenameVisible(false);
      setCardRenameText('');
      invalidateCollectionsCache();
      void loadCollections(true);
    } catch (err) {
      Alert.alert('重命名失败', err instanceof Error ? err.message : String(err));
    }
  }, [cardMenuTarget, cardRenameText, loadCollections]);

  const handleDeleteFromCard = useCallback(() => {
    if (!cardMenuTarget || cardMenuTarget.kind === 'official') return;
    const userId = Number(cardMenuTarget.id.replace(/^user:/, ''));
    if (!Number.isFinite(userId) || userId <= 0) return;
    const isDefault = cardMenuTarget.isDefault === true;
    if (isDefault) {
      // Defensive: the menu doesn't surface delete for default, but
      // guard against accidental dispatch.
      return;
    }
    const title = cardMenuTarget.title;
    handleCloseCardMenu();
    Alert.alert(
      '删除合集?',
      `合集"${title}"本身会被删除，里面的视频不会被删(它们会回到默认合集)。`,
      [
        { text: '取消', style: 'cancel' },
        {
          text: '删除',
          style: 'destructive',
          onPress: async () => {
            try {
              await deleteUserCollection(userId);
              invalidateCollectionsCache();
              void loadCollections(true);
            } catch (err) {
              Alert.alert('删除失败', err instanceof Error ? err.message : String(err));
            }
          },
        },
      ],
    );
  }, [cardMenuTarget, loadCollections]);

  const handleOpenImportFromCard = useCallback(() => {
    if (!cardMenuTarget || cardMenuTarget.kind === 'official') return;
    // Capture the target's wire id before clearing cardMenuTarget
    // — the import sheet reads it via defaultCollectionId.
    setImportSheetTarget(cardMenuTarget.id);
    setCardMenuVisible(false);
    setCardMenuTarget(null);
    setIsImportSheetVisible(true);
  }, [cardMenuTarget]);

  // ── Shared (expo-sharing) deep-link import ──────────────────────
  // Files shared from other apps land here. We import directly into
  // the user's default collection (no sheet in the way — the user
  // is already outside the app's import flow) and refresh the grid.
  useEffect(() => {
    if (!params.shared || params.shared !== '1') return;
    if (isResolvingSharedPayloads) return;
    const candidate = resolvedSharedPayloads.find((p) => p.contentUri);
    if (!candidate?.contentUri) return;
    if (!isVideoCandidate(candidate.originalName ?? null, candidate.contentUri, candidate.contentMimeType ?? null)) {
      Sharing.clearSharedPayloads();
      return;
    }
    const contentUri = candidate.contentUri;
    void (async () => {
      try {
        const imported = await importLocalVideoFromUri(contentUri, {
          sourceName: candidate.originalName ?? undefined,
          mimeType: candidate.contentMimeType,
        });
        Sharing.clearSharedPayloads();
        if (imported) {
          invalidateVideoSceneCaches();
          invalidateCollectionsCache();
          await loadCollections(true);
          showToast(`已导入：${imported.title || '视频'}`);
          // Kick off subtitle auto-generation. Local file path
          // honors the pro / quota gate; cloud is not used here
          // (expo-sharing payloads are local files only).
          void triggerImportedVideoSubtitleGeneration(imported);
        }
      } catch (err) {
        Sharing.clearSharedPayloads();
        if (err instanceof DuplicateLocalVideoImportError) {
          Alert.alert(
            '检测到同名视频',
            '系统里已经有一份同名视频。是否仍然再导入一份?',
            [
              { text: '取消', style: 'cancel' },
              {
                text: '再次导入',
                onPress: async () => {
                  try {
                    const imported = await importLocalVideoFromUri(contentUri, {
                      sourceName: candidate.originalName ?? undefined,
                      mimeType: candidate.contentMimeType,
                      force: true,
                    });
                    if (imported) {
                      invalidateVideoSceneCaches();
                      invalidateCollectionsCache();
                      await loadCollections(true);
                      showToast(`已导入：${imported.title || '视频'}`);
                      void triggerImportedVideoSubtitleGeneration(imported);
                    }
                  } catch (retryErr) {
                    const msg = retryErr instanceof Error ? retryErr.message : '导入失败,请稍后重试';
                    Alert.alert('导入失败', msg);
                  }
                },
              },
            ],
          );
          return;
        }
        const msg = err instanceof Error ? err.message : '导入失败,请稍后重试';
        Alert.alert('导入失败', msg);
      }
    })();
  }, [isResolvingSharedPayloads, loadCollections, params.shared, resolvedSharedPayloads, showToast]);

  // ── Derived: which collections are present ─────────────────────
  const totalCount = collections.length;

  return (
    <View style={styles.container}>
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={[styles.scrollContent, { paddingBottom: Math.max(120, insets.bottom + 96) }]}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl refreshing={isPullRefreshing} onRefresh={onPullRefresh} />
        }
      >
        <View style={styles.headerRow}>
          <View style={styles.headerTitleWrap}>
            <Text style={styles.headerTitle}>视频跟练</Text>
          </View>
          <Pressable
            style={styles.headerLink}
            onPress={() => router.push('/library')}
            hitSlop={6}
            accessibilityLabel="推荐资源"
          >
            <Text style={styles.headerLinkText}>推荐资源</Text>
            <ChevronRight size={14} color={colors.primary} />
          </Pressable>
          <Pressable
            style={styles.addBtn}
            onPress={handleOpenAddMenu}
            hitSlop={8}
            accessibilityLabel="添加内容"
          >
            <Plus size={22} color={colors.text.primary} />
          </Pressable>
        </View>

        {isLoading && totalCount === 0 ? (
          <View style={styles.center}>
            <ActivityIndicator size="large" color={colors.primary} />
            <Text style={styles.loadingText}>合集加载中…</Text>
          </View>
        ) : totalCount === 0 ? (
          <BigEmptyState onAdd={handleOpenAddMenu} />
        ) : (
          <View style={styles.list}>
            {collections.map((c) => (
              <CollectionRow
                key={c.id}
                collection={c}
                onPress={() => handleOpenCollection(c)}
                onMorePress={() => handleOpenCardMenu(c)}
              />
            ))}
            <Pressable style={styles.bottomAddBtn} onPress={handleOpenAddMenu}>
              <Plus size={16} color={colors.primary} />
              <Text style={styles.bottomAddBtnText}>添加合集或导入视频</Text>
            </Pressable>
            {/* Secondary CTA — points the user to the official-series
                catalogue for content they don't own yet. Stays
                subordinate to the primary "add" button so it doesn't
                compete for attention. */}
            <Pressable
              style={styles.bottomLibraryLink}
              onPress={() => router.push('/library')}
              hitSlop={6}
            >
              <Text style={styles.bottomLibraryLinkText}>推荐资源</Text>
              <ChevronRight size={14} color={colors.primary} />
            </Pressable>
          </View>
        )}
      </ScrollView>

      {toast ? (
        <View style={styles.toast} pointerEvents="none">
          <Text style={styles.toastText}>{toast}</Text>
        </View>
      ) : null}

      {/* ── Add menu (title + large card rows + cancel, mirrors
            AiPracticeHome's choice sheet so the two "join" UIs
            feel like siblings) ────────────────────────────── */}
      {sheetMode === 'addMenu' ? (
        <Modal visible transparent animationType="slide" onRequestClose={() => setSheetMode('closed')}>
          <View style={styles.sheetOverlay}>
            <Pressable style={StyleSheet.absoluteFill} onPress={() => setSheetMode('closed')} />
            <View style={styles.choiceSheet}>
              <View style={styles.customSheetHandle} />
              <Text style={styles.choiceSheetTitle}>选择加入方式</Text>
              <Pressable style={styles.choiceItem} onPress={handleAddFromLibrary}>
                <View style={[styles.choiceItemIcon, styles.choiceItemIconLibrary]}>
                  <Compass size={20} color="#1E40AF" />
                </View>
                <View style={styles.choiceItemBody}>
                  <Text style={styles.choiceItemTitle}>从推荐资源库添加</Text>
                  <Text style={styles.choiceItemDesc}>从官方合集里挑一个,自动订阅更新</Text>
                </View>
              </Pressable>
              <Pressable style={styles.choiceItem} onPress={handleOpenImport}>
                <View style={[styles.choiceItemIcon, styles.choiceItemIconImport]}>
                  <Upload size={20} color="#7C3AED" />
                </View>
                <View style={styles.choiceItemBody}>
                  <Text style={styles.choiceItemTitle}>导入本地/网盘视频</Text>
                  <Text style={styles.choiceItemDesc}>从手机或百度网盘导入已有视频</Text>
                </View>
              </Pressable>
              <Pressable style={styles.choiceItem} onPress={handleOpenCreateCollection}>
                <View style={[styles.choiceItemIcon, styles.choiceItemIconCreate]}>
                  <Sparkles size={20} color="#0E7490" />
                </View>
                <View style={styles.choiceItemBody}>
                  <Text style={styles.choiceItemTitle}>创建新合集</Text>
                  <Text style={styles.choiceItemDesc}>起个名字,创建后再往里面加视频</Text>
                </View>
              </Pressable>
              <Pressable style={styles.choiceCancel} onPress={() => setSheetMode('closed')}>
                <Text style={styles.choiceCancelText}>取消</Text>
              </Pressable>
            </View>
          </View>
        </Modal>
      ) : null}

      {/* ── Create collection (inline) ─────────────────────── */}
      {sheetMode === 'createCollection' ? (
        <Modal visible transparent animationType="slide" onRequestClose={() => setSheetMode('closed')}>
          <View style={styles.sheetOverlay}>
            <Pressable style={StyleSheet.absoluteFill} onPress={() => setSheetMode('closed')} />
            <View style={styles.createSheet}>
              <View style={styles.customSheetHandle} />
              <Text style={styles.addMenuTitle}>创建合集</Text>
              <Text style={styles.addMenuHint}>起个名字,创建后再往里面加视频。</Text>
              <TextInput
                style={styles.sheetInput}
                value={newCollectionTitle}
                onChangeText={setNewCollectionTitle}
                autoFocus
                maxLength={40}
                placeholder="合集名"
                placeholderTextColor={colors.text.tertiary}
              />
              <View style={styles.createSheetActions}>
                <Pressable
                  style={[styles.sheetBtn, styles.sheetBtnGhost]}
                  onPress={() => setSheetMode('closed')}
                >
                  <Text style={styles.sheetBtnGhostText}>取消</Text>
                </Pressable>
                <Pressable
                  style={[styles.sheetBtn, styles.sheetBtnPrimary]}
                  onPress={handleSubmitCreateCollection}
                >
                  <Check size={14} color="#FFFFFF" />
                  <Text style={styles.sheetBtnPrimaryText}>创建并打开</Text>
                </Pressable>
              </View>
            </View>
          </View>
        </Modal>
      ) : null}

      {/* ── Source binding sheet (lifted verbatim from the old
            "导入" tab so the visual layout — handle, header, hint,
            close icon — is identical to the pre-redesign flow). ── */}
      <ImportVideoSheet
        visible={isImportSheetVisible}
        defaultCollectionId={importSheetTarget}
        onClose={() => {
          setIsImportSheetVisible(false);
          setImportSheetTarget(undefined);
        }}
        onImportSuccess={handleImportSheetSuccess}
      />

      {/* ── Per-card "..." menu (home grid) ──────────────────────
            Items are filtered by target kind:
              - official: 移出我的合集 (destructive)
              - default:   重命名, 导入视频 (no delete — catch-all)
              - user:      重命名, 导入视频, 删除合集 (destructive)
            Mirrors the per-collection menu in the detail page, just
            with one less tap to reach.
            NOTE: must be wrapped in <Modal> (not a plain View) so the
            sheet renders in a separate window above the bottom tab
            bar. A regular View is clipped by the (tabs) layout. */}
      {cardMenuVisible && cardMenuTarget ? (
        <Modal visible transparent animationType="slide" onRequestClose={handleCloseCardMenu}>
          <View style={styles.menuOverlay}>
            <Pressable
              style={StyleSheet.absoluteFill}
              onPress={handleCloseCardMenu}
            />
            <View style={styles.cardMenuSheet}>
              <View style={styles.cardMenuHandle} />
              <Text style={styles.cardMenuTitle} numberOfLines={1}>
                {cardMenuTarget.title}
              </Text>
              {cardMenuTarget.kind === 'official' ? (
                <Pressable
                  style={[styles.menuItem, styles.menuItemDanger]}
                  onPress={() => void handleUnpickFromCard()}
                >
                  <Trash2 size={16} color="#DC2626" />
                  <Text style={[styles.menuItemText, { color: '#DC2626' }]}>
                    移出我的合集
                  </Text>
                </Pressable>
              ) : (
                <>
                  <Pressable
                    style={styles.menuItem}
                    onPress={handleStartRenameFromCard}
                  >
                    <Edit3 size={16} color={colors.text.primary} />
                    <Text style={styles.menuItemText}>重命名</Text>
                  </Pressable>
                  <Pressable
                    style={styles.menuItem}
                    onPress={handleOpenImportFromCard}
                  >
                    <Upload size={16} color={colors.text.primary} />
                    <Text style={styles.menuItemText}>导入视频</Text>
                  </Pressable>
                  {cardMenuTarget.isDefault !== true ? (
                    <Pressable
                      style={[styles.menuItem, styles.menuItemDanger]}
                      onPress={handleDeleteFromCard}
                    >
                      <Trash2 size={16} color="#DC2626" />
                      <Text style={[styles.menuItemText, { color: '#DC2626' }]}>
                        删除合集
                      </Text>
                    </Pressable>
                  ) : null}
                </>
              )}
            </View>
          </View>
        </Modal>
      ) : null}

      {/* ── Card-level rename sheet ──────────────────────────────
            Mirrors the rename UI on the collection detail page
            (TextInput + 取消/保存) but driven from the home grid
            without the navigation round-trip.
            NOTE: must be wrapped in <Modal> so it renders above the
            bottom tab bar. */}
      {cardRenameVisible ? (
        <Modal visible transparent animationType="fade" onRequestClose={() => { setCardRenameVisible(false); setCardRenameText(''); }}>
          <View style={styles.renameSheetOverlay}>
            <View style={styles.renameSheet}>
              <Text style={styles.addMenuTitle}>重命名合集</Text>
              <Text style={styles.addMenuHint}>改完名字后立即生效。</Text>
              <TextInput
                style={styles.sheetInput}
                value={cardRenameText}
                onChangeText={setCardRenameText}
                autoFocus
                maxLength={40}
                placeholder="合集名"
                placeholderTextColor={colors.text.tertiary}
              />
              <View style={styles.createSheetActions}>
                <Pressable
                  style={[styles.sheetBtn, styles.sheetBtnGhost]}
                  onPress={() => {
                    setCardRenameVisible(false);
                    setCardRenameText('');
                  }}
                >
                  <Text style={styles.sheetBtnGhostText}>取消</Text>
                </Pressable>
                <Pressable
                  style={[styles.sheetBtn, styles.sheetBtnPrimary]}
                  onPress={handleSubmitRenameFromCard}
                >
                  <Check size={14} color="#FFFFFF" />
                  <Text style={styles.sheetBtnPrimaryText}>保存</Text>
                </Pressable>
              </View>
            </View>
          </View>
        </Modal>
      ) : null}
    </View>
  );
}

// ── Big empty state (no collections at all) ────────────────────────
function BigEmptyState({ onAdd }: { onAdd: () => void }) {
  return (
    <View style={styles.emptyState}>
      <View style={styles.emptyIcon}>
        <Sparkles size={28} color={colors.primary} />
      </View>
      <Text style={styles.emptyTitle}>还没有内容</Text>
      <Text style={styles.emptyDesc}>
        从推荐资源库挑一个合集,或者导入本地视频开始。
      </Text>
      <Pressable style={styles.emptyCta} onPress={onAdd}>
        <Plus size={16} color="#FFFFFF" />
        <Text style={styles.emptyCtaText}>添加第一个内容</Text>
      </Pressable>
    </View>
  );
}

// ── Collection row (one card in the home list) ─────────────────────
// Thin adapter around the shared `RecommendedCollectionCard`.
// The home list uses the horizontal layout because the user
// already owns these collections — the small thumbnail is just a
// visual cue, and the right side carries the progress info
// (completed / total + bar) that's the primary signal here.
function CollectionRow({
  collection,
  onPress,
  onMorePress,
}: {
  collection: CollectionSummary;
  onPress: () => void;
  /**
   * Tap on the row's "..." button. Opens a context menu anchored
   * to this card (handled by the parent, which knows which items
   * to show for official / default / custom).
   */
  onMorePress?: () => void;
}) {
  const isDefault = collection.isDefault === true;
  const kindLabel = isDefault ? '默认' : (collection.kind === 'official' ? '推荐' : '我的');
  const accent = isDefault
    ? { bg: '#F1F5F9', text: '#475569' }
    : collection.kind === 'official'
      ? { bg: 'rgba(15,118,110,0.10)', text: '#0F766E' }
      : { bg: 'rgba(99,102,241,0.10)', text: '#4F46E5' };

  return (
    <RecommendedCollectionCard
      layout="horizontal"
      title={collection.title}
      coverImageUri={collection.coverImageUri}
      kindBadge={kindLabel}
      kindAccent={accent}
      videoCount={collection.videoCount}
      completedCount={collection.completedCount}
      onPress={onPress}
      onMorePress={onMorePress}
    />
  );
}

// ── Action sheet primitive ─────────────────────────────────────────
// `variant` controls the height profile:
//   - 'fixed' (default) — matches the original source-binding sheet
// ── Action sheet primitive (REMOVED — caused layout issues; sheets
//    are now inlined directly above). Keeping this comment as a
//    breadcrumb so future readers know why there's no overlay helper.
// ────────────────────────────────────────────────────────────────────

// ── expo-router search params shim ────────────────────────────────
// (no longer needed; useLocalSearchParams is imported above.)

// ── Styles ────────────────────────────────────────────────────────
const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  scroll: { flex: 1 },
  scrollContent: { paddingHorizontal: spacing.md, paddingTop: spacing.md },

  headerRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    marginBottom: spacing.md,
  },
  headerTitleWrap: { flex: 1 },
  headerTitle: { fontSize: fontSize.xxl, fontWeight: fontWeight.bold, color: colors.text.primary },
  headerSub: { fontSize: fontSize.sm, color: colors.text.secondary, marginTop: 2 },
  // Inline "推荐资源" link sitting between the title and the +
  // button in the header row. Subtle (small + primary color text)
  // so it doesn't compete with the page title.
  headerLink: {
    flexDirection: 'row', alignItems: 'center', gap: 2,
    paddingHorizontal: 4, paddingVertical: 4,
  },
  headerLinkText: {
    fontSize: fontSize.sm,
    color: colors.primary,
    fontWeight: fontWeight.medium,
  },
  addBtn: {
    width: 36, height: 36,
    alignItems: 'center', justifyContent: 'center',
  },

  center: { padding: spacing.xl, alignItems: 'center', justifyContent: 'center' },
  loadingText: { color: colors.text.secondary, fontSize: fontSize.sm, marginTop: spacing.sm },

  list: { gap: spacing.sm, paddingBottom: spacing.xl },

  bottomAddBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: 6, paddingVertical: 14, marginTop: spacing.md,
    borderRadius: borderRadius.md,
    borderWidth: 1, borderStyle: 'dashed', borderColor: colors.primary,
  },
  // Secondary CTA below the primary "添加合集或导入视频" button.
  // No background, no border — just a tinted chevron link to keep
  // it subordinate to the primary action above.
  bottomLibraryLink: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: 2, paddingVertical: 10,
  },
  bottomLibraryLinkText: {
    fontSize: fontSize.sm,
    color: colors.primary,
    fontWeight: fontWeight.medium,
  },
  bottomAddBtnText: { color: colors.primary, fontSize: fontSize.sm, fontWeight: fontWeight.semibold },

  emptyState: {
    alignItems: 'center', paddingVertical: spacing.xxl, paddingHorizontal: spacing.lg,
  },
  emptyIcon: {
    width: 64, height: 64, borderRadius: 32,
    backgroundColor: 'rgba(15,118,110,0.10)',
    alignItems: 'center', justifyContent: 'center',
    marginBottom: spacing.md,
  },
  emptyTitle: { fontSize: fontSize.lg, fontWeight: fontWeight.semibold, color: colors.text.primary, marginBottom: 4 },
  emptyDesc: { fontSize: fontSize.sm, color: colors.text.secondary, textAlign: 'center', lineHeight: 20, marginBottom: spacing.lg },
  emptyCta: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    backgroundColor: colors.primary, paddingHorizontal: spacing.lg, paddingVertical: 10,
    borderRadius: borderRadius.md,
  },
  emptyCtaText: { color: '#FFFFFF', fontWeight: fontWeight.semibold, fontSize: fontSize.sm },

  toast: {
    position: 'absolute', left: 0, right: 0, bottom: 80,
    alignItems: 'center',
  },
  toastText: {
    backgroundColor: 'rgba(15,23,42,0.92)',
    color: '#FFFFFF', paddingHorizontal: spacing.md, paddingVertical: 10,
    borderRadius: borderRadius.md, fontSize: fontSize.sm, overflow: 'hidden',
  },

  // Sheets — all bottom sheets on this page share these styles
  // (the source binding sheet AND the add-menu / create-collection
  // action sheets). Styles below for the source binding are
  // copied from the pre-redesign "导入" tab so the visual shape
  // is identical.
  sheetInput: {
    borderWidth: 1, borderColor: 'rgba(0,0,0,0.12)',
    borderRadius: borderRadius.md,
    paddingHorizontal: spacing.sm, paddingVertical: 10,
    fontSize: fontSize.base, color: colors.text.primary,
    marginBottom: spacing.md,
  },
  sheetActionRow: { flexDirection: 'row', justifyContent: 'flex-end', gap: spacing.sm },
  sheetBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    paddingHorizontal: spacing.md, paddingVertical: 10,
    borderRadius: borderRadius.md,
  },
  sheetBtnGhost: { backgroundColor: 'rgba(0,0,0,0.05)' },
  sheetBtnGhostText: { color: colors.text.primary, fontWeight: fontWeight.medium },
  sheetBtnPrimary: { backgroundColor: colors.primary },
  sheetBtnPrimaryText: { color: '#FFFFFF', fontWeight: fontWeight.semibold },
  // Source binding sheet (identical to the pre-redesign "导入" tab)
  // The overlay flexes to full height; `justifyContent: 'flex-end'`
  // pushes child sheet to the bottom. Without it, RN lays out the
  // child from the top and our hug-content sheets float in the
  // middle of the screen.
  sheetOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.4)',
    justifyContent: 'flex-end',
  },
  customSheet: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    paddingBottom: 48,
    gap: spacing.md,
    height: '75%',
  },
  // Variant of customSheet for short option lists (3-4 rows).
  // No fixed height / no maxHeight — the sheet hugs its content
  // so the cancel button sits right under the last row instead of
  // being pushed to the middle of a 50%-tall empty panel.
  customSheetHandle: {
    width: 40,
    height: 5,
    backgroundColor: colors.border.default,
    borderRadius: borderRadius.full,
    alignSelf: 'center',
    marginBottom: spacing.sm,
  },
  // Add-menu sheet (compact option list, no fixed height — hugs
  // content so the sheet sits just above the tab bar with no
  // empty band below the cancel button).
  addMenuSheet: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    paddingHorizontal: spacing.md,
    paddingTop: spacing.sm,
    paddingBottom: spacing.md,
  },
  addMenuTitle: {
    fontSize: fontSize.lg,
    fontWeight: fontWeight.bold,
    color: colors.text.primary,
    paddingHorizontal: spacing.xs,
    paddingTop: spacing.xs,
    paddingBottom: spacing.sm,
  },
  addMenuHint: {
    fontSize: fontSize.sm,
    color: colors.text.secondary,
    paddingHorizontal: spacing.xs,
    paddingBottom: spacing.sm,
    lineHeight: 20,
  },
  addMenuRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: 14,
    paddingHorizontal: spacing.xs,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(0,0,0,0.04)',
  },
  addMenuRowIcon: { width: 28, alignItems: 'center', justifyContent: 'center' },
  addMenuRowTitle: { fontSize: fontSize.base, color: colors.text.primary, fontWeight: fontWeight.medium },
  // ── Choice sheet (mirrors AiPracticeHome's "选择加入方式" modal)
  // 2026-08-17: title + large card rows + bottom cancel button.
  // Used by the video tab's "+" menu. Cards use full background
  // (vs the old bare Pressable rows) so it matches the AI 陪练
  // choice sheet and reads as a single visual family.
  choiceSheet: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    paddingBottom: Math.max(28, spacing.xl),
    gap: spacing.sm,
  },
  choiceSheetTitle: {
    fontSize: fontSize.lg,
    fontWeight: fontWeight.bold,
    color: colors.text.primary,
    marginTop: spacing.xs,
    marginBottom: spacing.xs,
  },
  choiceItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    borderRadius: borderRadius.lg,
    backgroundColor: '#F8FAFC',
    borderWidth: 1,
    borderColor: '#E2E8F0',
  },
  choiceItemIcon: {
    width: 40,
    height: 40,
    borderRadius: borderRadius.full,
    alignItems: 'center',
    justifyContent: 'center',
  },
  choiceItemIconLibrary: {
    backgroundColor: '#DBEAFE',
  },
  choiceItemIconImport: {
    backgroundColor: 'rgba(124,58,237,0.12)',
  },
  choiceItemIconCreate: {
    backgroundColor: 'rgba(14,116,144,0.12)',
  },
  choiceItemBody: {
    flex: 1,
  },
  choiceItemTitle: {
    fontSize: fontSize.base,
    fontWeight: fontWeight.semibold,
    color: colors.text.primary,
  },
  choiceItemDesc: {
    fontSize: fontSize.xs,
    color: colors.text.secondary,
    marginTop: 2,
    lineHeight: 16,
  },
  choiceCancel: {
    alignItems: 'center',
    paddingVertical: 12,
    marginTop: spacing.xs,
  },
  choiceCancelText: {
    fontSize: fontSize.sm,
    color: colors.text.secondary,
    fontWeight: fontWeight.medium,
  },
  // Create-collection sheet — slightly taller content (input + 2
  // buttons), no fixed height.
  createSheet: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
    paddingBottom: spacing.md,
  },
  createSheetActions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: spacing.sm,
    paddingTop: spacing.sm,
  },
  customSheetHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  customSheetTitle: {
    fontSize: fontSize.lg,
    fontWeight: fontWeight.bold,
    color: colors.text.primary,
  },
  videoAiPickerHeaderInfo: {
    flex: 1,
    gap: 4,
    paddingRight: spacing.md,
  },

  // ── Per-card menu (home grid) ─────────────────────────────
  // Same family as the detail page's per-video menu. Compact
  // surface card, 28px top radius, hugged content. No title bar
  // by default — the collection name lives in the first row.
  menuOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.4)',
    justifyContent: 'flex-end',
  },
  cardMenuSheet: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    paddingHorizontal: spacing.md,
    paddingTop: spacing.sm,
    paddingBottom: spacing.xl,
  },
  cardMenuHandle: {
    width: 40,
    height: 5,
    backgroundColor: colors.border.default,
    borderRadius: borderRadius.full,
    alignSelf: 'center',
    marginBottom: spacing.sm,
  },
  cardMenuTitle: {
    fontSize: fontSize.base,
    fontWeight: fontWeight.semibold,
    color: colors.text.primary,
    paddingVertical: spacing.sm,
    marginBottom: spacing.xs,
  },
  menuItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: 12,
  },
  menuItemDanger: {},
  menuItemText: { fontSize: fontSize.base, color: colors.text.primary },

  // ── Card-level rename sheet (home grid) ────────────────────
  // Centered modal that reuses the addMenu title/hint styles so
  // the input/buttons look identical to the "新建合集" path.
  renameSheetOverlay: {
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
  videoAiPickerHint: {
    fontSize: fontSize.sm,
    color: colors.text.secondary,
    lineHeight: 20,
  },

  // ── Inline import-target selector (top of source binding sheet) ──
  // Single row: [icon] 导入到  [collection name]  [chevron]. Acts as
  // a button that opens the collection picker. Stretches the full
  // sheet width with a hairline border, matches the soft surface
  // palette so it doesn't compete with the source picker below.
  targetSelector: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.sm + 2,
    paddingHorizontal: spacing.md,
    borderRadius: borderRadius.md,
    backgroundColor: 'rgba(0,0,0,0.03)',
    borderWidth: 1,
    borderColor: colors.border.default,
  },
  targetSelectorLabel: {
    fontSize: fontSize.sm,
    color: colors.text.secondary,
  },
  targetSelectorValue: {
    flex: 1,
    fontSize: fontSize.base,
    color: colors.text.primary,
    fontWeight: fontWeight.medium,
  },

  // ── Collection picker sheet ──────────────────────────────────────
  // Same visual family as customSheet / addMenuSheet but with
  // padding tuned for a scrollable list. No fixed height — it
  // hugs content (capped at ~70% via maxHeight to keep the
  // tab bar visible on long collection lists).
  pickerSheet: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    paddingBottom: spacing.xl,
    gap: spacing.md,
    maxHeight: '70%',
  },
  pickerSheetTitle: {
    fontSize: fontSize.lg,
    fontWeight: fontWeight.bold,
    color: colors.text.primary,
  },
  pickerSheetHint: {
    fontSize: fontSize.sm,
    color: colors.text.secondary,
    lineHeight: 20,
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
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.border.default,
  },
  pickerRowSelected: {
    backgroundColor: 'rgba(0,0,0,0.02)',
  },
  pickerRowText: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  pickerRowTitle: {
    fontSize: fontSize.base,
    color: colors.text.primary,
    fontWeight: fontWeight.medium,
    flexShrink: 1,
  },
  pickerRowTitleSelected: {
    color: colors.primary,
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
  pickerCreateBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.md,
    marginTop: spacing.sm,
  },
  pickerCreateBtnText: {
    fontSize: fontSize.base,
    color: colors.primary,
    fontWeight: fontWeight.medium,
  },
});
