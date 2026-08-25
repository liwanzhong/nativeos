/**
 * /library — the standalone "资源库" page.
 *
 * Why a dedicated page (not a tab):
 *   The video tab is "我的合集" — the user's curated home. The
 *   library is a separate, on-demand destination: the user navigates
 *   here when they want to discover new content, and leaves when
 *   they're done. Making it a sub-page of the video tab (rather
 *   than a tab itself) keeps the home tab focused.
 *
 * Data source:
 *   `official_video_series` from Supabase. Reuses the
 *   `getOfficialVideoSeriesListFromSupabase` view that already
 *   exists from the earlier "OSS → Supabase" cutover.
 *
 * Action semantics:
 *   Tapping a series card calls `pickSeries` (the existing mutation
 *   on `user_picked_video_series`). The card then flips to "已加入"
 *   without a navigation — the user stays on the library to keep
 *   browsing.
 */

import { useFocusEffect, useRouter } from 'expo-router';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ArrowLeft, Cloud, CloudOff, Link2, Settings2 } from 'lucide-react-native';
import { useCallback, useMemo, useState } from 'react';
import { colors, spacing, borderRadius, fontSize, fontWeight } from '../constants/theme';
import {
  getOfficialVideoSeriesPageFromSupabase,
  invalidateVideoSeriesViewsCache,
  type PaginatedSeriesResult,
} from '../lib/content/video-series-supabase-views';
import { listMyPickedSeriesIds, pickSeries, unpickSeries } from '../lib/content/user-picked-series';
import { invalidateCollectionsCache } from '../lib/content/collections';
import { RecommendedCollectionCard } from '../components/collection/RecommendedCollectionCard';
import type { OfficialVideoSeriesSummary } from '../lib/content/video-series';
import {
  getOfficialSceneBindingStatus,
  invalidateOfficialSceneBindingStatusCache,
  type SceneBindingSnapshot,
} from '../lib/content/cloud-binding-summary';
import { getConfiguredCloudProviders, getDefaultCloudProvider } from '../lib/database/cloud-bindings';
import {
  rescanOfficialSceneSyncStatus,
  type OfficialSceneSyncSummary,
} from '../lib/content/cloud-drive-sync';

const LIBRARY_LOG_PREFIX = '[Library]';
const LEVEL_ORDER = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'];
// 2026-08-21: 资源库分页加载。每页 10 个, 离底部 40% 时触发加载更多。
const LIBRARY_PAGE_SIZE = 10;
const LIBRARY_ON_END_REACHED_THRESHOLD = 0.4;

// 2026-08-21: 计时助手。每步打 ms, 一眼看出哪步慢。
// 用 performance.now() 而不是 Date.now() 更精确 (亚毫秒)。
function logLibTiming(label: string, startMs: number): number {
  const elapsed = performance.now() - startMs;
  console.log(`${LIBRARY_LOG_PREFIX} [timing] ${label}: ${elapsed.toFixed(0)}ms`);
  return performance.now();
}

function logLibTrace(message: string, payload?: unknown) {
  if (payload === undefined) {
    console.log(`${LIBRARY_LOG_PREFIX} ${message}`);
    return;
  }
  console.log(`${LIBRARY_LOG_PREFIX} ${message}`, payload);
}

function formatDuration(seconds: number | undefined): string {
  if (!seconds || !Number.isFinite(seconds)) return '';
  const total = Math.max(0, Math.floor(seconds));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export default function LibraryPage() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [series, setSeries] = useState<OfficialVideoSeriesSummary[]>([]);
  const [pickedIdSet, setPickedIdSet] = useState<Set<string>>(new Set());
  const [isLoading, setIsLoading] = useState(false);
  const [isPullRefreshing, setIsPullRefreshing] = useState(false);
  const [pendingPickId, setPendingPickId] = useState<string | null>(null);
  const [levelFilter, setLevelFilter] = useState<'all' | string>('all');
  // Per-scene cloud-drive binding + cache snapshot. `null` when
  // the user hasn't configured a cloud provider (banner is hidden
  // in that case). Re-fetched on every focus + after any mutation
  // (pick/unpick, rescan, download) via `invalidateOfficialSceneBindingStatusCache`.
  const [bindingMap, setBindingMap] = useState<Record<string, SceneBindingSnapshot>>({});
  const [isCloudReady, setIsCloudReady] = useState(false);
  const [syncSummary, setSyncSummary] = useState<OfficialSceneSyncSummary | null>(null);
  const [isRescanning, setIsRescanning] = useState(false);

  // 2026-08-21: 分页状态。
  // - total: 当前 level 筛选下 published series 总数 (server 端 count)
  // - hasMore: 是否还有下一页
  // - isLoadingMore: 上拉加载中
  // - loadMoreError: 加载更多失败, footer 显示重试
  // - page: 已加载的页数 (offset = page * PAGE_SIZE)
  // - cloudProvider: 缓存当前选中的 provider, loadMore 算 binding status 用
  const [total, setTotal] = useState(0);
  const [hasMore, setHasMore] = useState(true);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [loadMoreError, setLoadMoreError] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const [cloudProvider, setCloudProvider] = useState<'baidu_pan' | null>(null);

  // 2026-08-21: 拉一页, level 走参数, fetchPage 引用稳定不依赖 state。
  const fetchPage = useCallback(
    async (offset: number, level: 'all' | string): Promise<PaginatedSeriesResult> => {
      return await getOfficialVideoSeriesPageFromSupabase({
        limit: LIBRARY_PAGE_SIZE,
        offset,
        level: level === 'all' ? null : level,
      });
    },
    [],
  );

  // 计算当前 page 的 binding status, 累加到 bindingMap。
  // 单独提出来, loadFirstPage / loadMore 都用, 避免重复代码。
  const appendBindingForPage = useCallback(
    async (items: OfficialVideoSeriesSummary[], provider: 'baidu_pan') => {
      if (items.length === 0) return;
      const map = await getOfficialSceneBindingStatus(
        items.map((s) => s.id),
        provider,
      );
      setBindingMap((prev) => ({ ...prev, ...map }));
    },
    [],
  );

  // 2026-08-21: 加载第一页 (重置状态)。所有 reset 路径 (focus / pull refresh /
  // 切 level) 都走这里, 行为一致。
  // 2026-08-21 性能诊断: 每步打 timing, 看从打开到内容出来到底哪步慢。
  // 之前用户报"打开页面到完全加载出内容用了将近一分钟", 找瓶颈用。
  const loadFirstPage = useCallback(
    async (level: 'all' | string) => {
      const t0 = performance.now();
      logLibTrace('loadFirstPage start', { level });
      setIsLoading(true);
      setLoadMoreError(null);
      setSeries([]);
      setTotal(0);
      setHasMore(true);
      setPage(0);
      try {
        let t = t0;
        // 三件并发: series 列表 / picked ids / cloud providers 配置
        const [r, ids, providers] = await Promise.all([
          fetchPage(0, level),
          listMyPickedSeriesIds(),
          getConfiguredCloudProviders().catch(() => [] as ('baidu_pan')[]),
        ]);
        t = logLibTiming('series+picked+providers (parallel)', t);
        const provider = providers[0] ?? 'baidu_pan';
        setCloudProvider(provider);
        setIsCloudReady(providers.length > 0);
        setPickedIdSet(ids);
        setSeries(r.items);
        setTotal(r.total);
        setHasMore(r.hasMore);
        setPage(1);
        logLibTiming('setState (series/picked/cloudProvider)', t);

        // binding 状态: 对每个 series 查一次网盘绑定 (这是新怀疑点)
        t = performance.now();
        await appendBindingForPage(r.items, provider);
        t = logLibTiming('appendBindingForPage', t);

        logLibTiming('loadFirstPage total', t0);
        logLibTrace('loadFirstPage success', {
          level,
          returned: r.items.length,
          total: r.total,
          hasMore: r.hasMore,
          pickedCount: ids.size,
        });
      } catch (err) {
        logLibTiming('loadFirstPage total (failed)', t0);
        logLibTrace('loadFirstPage failed', {
          level,
          error: err instanceof Error ? err.message : String(err),
        });
        setSeries([]);
        setTotal(0);
        setHasMore(false);
        setPickedIdSet(new Set());
      } finally {
        setIsLoading(false);
      }
    },
    [fetchPage, appendBindingForPage],
  );

  // 2026-08-21: 加载下一页。已加载 items 保留, append 新 items。
  // 触发条件: 滚动到 FlatList 底部 (onEndReached), 由 UI 层调用。
  const loadMore = useCallback(async () => {
    if (!hasMore || isLoadingMore || isLoading) {
      return;
    }
    if (!cloudProvider) {
      // 还没拿到 provider (cloudProvider 在 loadFirstPage 后才设置),
      // 不可能进 loadMore, 防御性返回
      return;
    }
    setIsLoadingMore(true);
    setLoadMoreError(null);
    const nextOffset = page * LIBRARY_PAGE_SIZE;
    const t0 = performance.now();
    let t = t0;
    logLibTrace('loadMore start', { nextOffset, level: levelFilter, page });
    try {
      const r = await fetchPage(nextOffset, levelFilter);
      t = logLibTiming('loadMore fetchPage', t);
      setSeries((prev) => {
        // 防御: server 可能返回重复 id (offset 数据变化时), 用 Set 去重
        const seen = new Set(prev.map((s) => s.id));
        const fresh = r.items.filter((s) => !seen.has(s.id));
        return [...prev, ...fresh];
      });
      setTotal(r.total);
      setHasMore(r.hasMore);
      setPage((p) => p + 1);
      t = logLibTiming('loadMore setState', t);
      await appendBindingForPage(r.items, cloudProvider);
      t = logLibTiming('loadMore appendBindingForPage', t);
      logLibTiming('loadMore total', t0);
      logLibTrace('loadMore success', {
        nextOffset,
        returned: r.items.length,
        total: r.total,
        hasMore: r.hasMore,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logLibTrace('loadMore failed', { nextOffset, error: msg });
      setLoadMoreError(msg);
    } finally {
      setIsLoadingMore(false);
    }
  }, [hasMore, isLoadingMore, isLoading, cloudProvider, page, fetchPage, appendBindingForPage, levelFilter]);

  useFocusEffect(useCallback(() => {
    void loadFirstPage(levelFilter);
  }, [loadFirstPage, levelFilter]));

  const onPullRefresh = useCallback(async () => {
    setIsPullRefreshing(true);
    try {
      await loadFirstPage(levelFilter);
    } finally {
      setIsPullRefreshing(false);
    }
  }, [loadFirstPage, levelFilter]);

  // Re-scan the user's configured cloud drive for matching
  // official-video files. Refreshes the binding map + summary
  // so the row chips flip from "未绑定" to "已绑定" on success.
  const handleRescan = useCallback(async () => {
    if (isRescanning) return;
    setIsRescanning(true);
    try {
      const next = await rescanOfficialSceneSyncStatus(true);
      setSyncSummary(next);
      invalidateOfficialSceneBindingStatusCache();
      await loadFirstPage(levelFilter);
    } catch (err) {
      Alert.alert('扫描失败', err instanceof Error ? err.message : String(err));
    } finally {
      setIsRescanning(false);
    }
  }, [isRescanning, loadFirstPage, levelFilter]);

  // Open the cloud-drive management sheet (auth / provider
  // configuration). When the user comes back, useFocusEffect
  // re-runs `load`, which re-reads the configured providers and
  // binding map.
  const handleOpenCloudDrives = useCallback(() => {
    router.push('/cloud-drives');
  }, [router]);

  // Tapping "绑定到网盘" on a card when no provider is configured
  // short-circuits to the cloud-drive sheet (auth is the
  // prerequisite). When a provider IS configured but the scene
  // isn't bound, we run a fresh rescan — the user might have
  // dropped the file in their drive since the last scan.
  const handleBindingPress = useCallback((seriesId: string) => {
    const status = bindingMap[seriesId];
    if (!isCloudReady) {
      handleOpenCloudDrives();
      return;
    }
    if (status?.bound === 'bound') {
      // Already bound — no-op for v1; the user can manage the
      // binding from the cloud-drives sheet if they want to
      // unbind.
      return;
    }
    void handleRescan();
  }, [bindingMap, isCloudReady, handleOpenCloudDrives, handleRescan]);

  // Tapping "缓存到本地" on a card triggers a download. The
  // actual download infra lives in the collection detail page
  // (which knows the cloud provider, remote path, etc.); here
  // we deep-link to that page and let the user trigger the
  // download from the per-row chip on the detail list. This
  // keeps the library card lean (no per-row download state).
  const handleCachePress = useCallback((seriesId: string) => {
    router.push(`/library/${encodeURIComponent(seriesId)}`);
  }, [router]);

  // 2026-08-21: 切 level 筛选时, 重置分页 (清空 series, page=0, 重新拉第一页)。
  // 把 level 推到 server 端, 一次就只拉该 level 的 series, 不会出现
  // "10 个里筛出 1 个"的糟糕 UX。
  const handleLevelChange = useCallback(
    (newLevel: 'all' | string) => {
      if (newLevel === levelFilter) return;
      setLevelFilter(newLevel);
      void loadFirstPage(newLevel);
    },
    [levelFilter, loadFirstPage],
  );

  // Summary numbers for the cloud-banner. Only built when a
  // provider is configured.
  const bindingSummary = useMemo(() => {
    const ids = Object.keys(bindingMap);
    if (ids.length === 0) return null;
    let bound = 0;
    let cached = 0;
    for (const id of ids) {
      const s = bindingMap[id];
      if (s.bound === 'bound') bound += 1;
      if (s.cached === 'cached') cached += 1;
    }
    return { total: ids.length, bound, cached };
  }, [bindingMap]);

  const handleTogglePick = useCallback(async (seriesId: string) => {
    if (pendingPickId) return;
    setPendingPickId(seriesId);
    const wasPicked = pickedIdSet.has(seriesId);
    try {
      if (wasPicked) {
        await unpickSeries(seriesId);
      } else {
        await pickSeries(seriesId);
      }
      invalidateVideoSeriesViewsCache();
      invalidateCollectionsCache();
      setPickedIdSet((prev) => {
        const next = new Set(prev);
        if (wasPicked) next.delete(seriesId);
        else next.add(seriesId);
        return next;
      });
    } catch (err) {
      console.warn(`${LIBRARY_LOG_PREFIX} toggle pick failed`, err);
    } finally {
      setPendingPickId(null);
    }
  }, [pendingPickId, pickedIdSet]);

  // 2026-08-21: 之前 client 端用 visible = series.filter(level) 筛, 现在
  // server 端已经在 SQL 里 .eq('level', ...) 筛过, 不需要 client 再 filter。
  // 留这个 useMemo 注释是为了让 review 时一眼看到这是有意删的, 避免后续
  // 误以为漏写。

  return (
    <View style={styles.container}>
      <FlatList
        data={series}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => (
          <LibraryCard
            series={item}
            isPicked={pickedIdSet.has(item.id)}
            isPicking={pendingPickId === item.id}
            onTogglePick={() => handleTogglePick(item.id)}
            onOpen={() => router.push(`/library/${encodeURIComponent(item.id)}`)}
            binding={bindingMap[item.id]}
            onBindingPress={() => handleBindingPress(item.id)}
            onCachePress={() => handleCachePress(item.id)}
          />
        )}
        style={styles.scroll}
        contentContainerStyle={[
          styles.scrollContent,
          { paddingBottom: Math.max(120, insets.bottom + 96) },
        ]}
        showsVerticalScrollIndicator={false}
        // 2026-08-21: 触发分页加载更多
        onEndReached={loadMore}
        onEndReachedThreshold={LIBRARY_ON_END_REACHED_THRESHOLD}
        refreshControl={
          <RefreshControl refreshing={isPullRefreshing} onRefresh={onPullRefresh} />
        }
        ListHeaderComponent={
          <View>
            <View style={styles.headerRow}>
              <Pressable
                style={styles.backBtn}
                onPress={() => router.back()}
                hitSlop={8}
                accessibilityLabel="返回"
              >
                <ArrowLeft size={20} color={colors.text.primary} />
              </Pressable>
              <View style={styles.headerTitleWrap}>
                <Text style={styles.headerTitle}>资源库</Text>
              </View>
            </View>

            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.filterRow}
            >
              <Pressable
                style={[styles.filterChip, levelFilter === 'all' && styles.filterChipActive]}
                onPress={() => handleLevelChange('all')}
              >
                <Text style={[styles.filterChipText, levelFilter === 'all' && styles.filterChipTextActive]}>
                  全部
                </Text>
              </Pressable>
              {LEVEL_ORDER.map((level) => {
                const active = levelFilter === level;
                return (
                  <Pressable
                    key={`library-level-${level}`}
                    style={[styles.filterChip, active && styles.filterChipActive]}
                    onPress={() => handleLevelChange(level)}
                  >
                    <Text style={[styles.filterChipText, active && styles.filterChipTextActive]}>
                      {level}
                    </Text>
                  </Pressable>
                );
              })}
            </ScrollView>

            {/* Cloud-drive status banner.
                Three states:
                  1. No provider configured → call-to-action CTA pointing
                     at /cloud-drives to authorise Baidu pan.
                  2. Provider configured, no series bound yet → soft hint
                     with a "重新扫描" button so the user can retry.
                  3. Some series bound → summary numbers + scan button
                     (rescan surfaces new files the user dropped in). */}
            <View style={styles.cloudBanner}>
              {!isCloudReady ? (
                <Pressable
                  style={styles.cloudBannerActionable}
                  onPress={handleOpenCloudDrives}
                >
                  <View style={styles.cloudBannerIcon}>
                    <CloudOff size={18} color={colors.primary} />
                  </View>
                  <View style={styles.cloudBannerBody}>
                    <Text style={styles.cloudBannerTitle}>授权百度网盘</Text>
                    <Text style={styles.cloudBannerDesc}>
                      授权后可以扫描你的网盘,自动把推荐视频绑定到本地播放,免流量观看。
                    </Text>
                  </View>
                  <Settings2 size={16} color={colors.text.secondary} />
                </Pressable>
              ) : (
                <View style={styles.cloudBannerRow}>
                  <View style={styles.cloudBannerIcon}>
                    <Cloud size={18} color={colors.primary} />
                  </View>
                  <View style={styles.cloudBannerBody}>
                    <Text style={styles.cloudBannerTitle}>百度网盘已授权</Text>
                    <Text style={styles.cloudBannerDesc}>
                      {bindingSummary
                        ? `已绑定 ${bindingSummary.bound} / ${bindingSummary.total} 集,已缓存 ${bindingSummary.cached} 集`
                        : '正在读取绑定状态…'}
                    </Text>
                  </View>
                  <Pressable
                    style={styles.cloudBannerScanBtn}
                    onPress={handleRescan}
                    disabled={isRescanning}
                  >
                    {isRescanning ? (
                      <ActivityIndicator size="small" color={colors.primary} />
                    ) : (
                      <Text style={styles.cloudBannerScanBtnText}>重新扫描</Text>
                    )}
                  </Pressable>
                </View>
              )}
            </View>

            {/* 首次加载且没数据时, header 底部显示加载中 (列表本身空) */}
            {isLoading && series.length === 0 ? (
              <View style={styles.loadingBanner}>
                <ActivityIndicator size="small" color={colors.primary} />
                <Text style={styles.loadingText}>资源库加载中…</Text>
              </View>
            ) : null}
          </View>
        }
        ListEmptyComponent={
          // series.length === 0 时显示 empty state。注意: 这个组件在没数据时
          // 也会渲染, 但我们已经在 header 里处理了 isLoading, 这里只处理
          // "加载完成但 0 条" 的情况。
          isLoading ? null : (
            <View style={styles.emptyState}>
              <Text style={styles.emptyText}>
                当前筛选下没有可加的视频。换一个等级试试,或者下拉刷新一下。
              </Text>
            </View>
          )
        }
        ListFooterComponent={
          // 列表底部分页状态指示器:
          //   - 加载更多中: spinner
          //   - 加载更多失败: 重试按钮
          //   - 已加载全部: "— 已显示全部 —"
          //   - 还未开始加载: 不显示
          <View style={styles.footerContainer}>
            {isLoadingMore ? (
              <View style={styles.footerRow}>
                <ActivityIndicator size="small" color={colors.primary} />
                <Text style={styles.footerText}>加载更多…</Text>
              </View>
            ) : loadMoreError ? (
              <Pressable style={styles.footerRetry} onPress={loadMore}>
                <Text style={styles.footerRetryText}>加载失败, 点重试</Text>
              </Pressable>
            ) : !hasMore && series.length > 0 ? (
              <Text style={styles.footerDone}>— 已显示全部 {total} 个合集 —</Text>
            ) : null}
          </View>
        }
      />
    </View>
  );
}

function LibraryCard({
  series,
  isPicked,
  isPicking,
  onTogglePick,
  onOpen,
  binding,
  onBindingPress,
  onCachePress,
}: {
  series: OfficialVideoSeriesSummary;
  isPicked: boolean;
  isPicking: boolean;
  onTogglePick: () => void;
  /** Tap on the card body opens the collection detail page.
   *  The action button still has its own handler (with
   *  stopPropagation) so picking/unpicking doesn't also
   *  trigger a navigation. */
  onOpen: () => void;
  /** Per-scene cloud-drive binding + cache snapshot. When
   *  undefined, the card just omits the chip row (provider
   *  not configured). */
  binding?: SceneBindingSnapshot;
  onBindingPress?: () => void;
  onCachePress?: () => void;
}) {
  // Thin adapter: maps the official-series shape onto the
  // shared `RecommendedCollectionCard`. Library uses the
  // vertical layout — the cover is the primary signal here
  // because the user is still deciding whether to add the
  // series, and a full-width 16:9 cover gives the strongest
  // visual cue.
  return (
    <RecommendedCollectionCard
      layout="vertical"
      title={series.title}
      coverImageUri={series.coverImageUri}
      description={series.description}
      level={series.level}
      category={series.category}
      episodeCount={series.episodeCount}
      isPicked={isPicked}
      isPicking={isPicking}
      onTogglePick={onTogglePick}
      onPress={onOpen}
      bindingStatus={binding?.bound ?? null}
      cacheStatus={binding?.cached ?? null}
      onBindingPress={onBindingPress}
      onCachePress={onCachePress}
    />
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  scroll: { flex: 1 },
  scrollContent: { paddingHorizontal: spacing.md, paddingTop: spacing.md },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: spacing.md,
    gap: spacing.sm,
  },
  backBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.04)',
  },
  headerTitleWrap: { flex: 1 },
  headerTitle: {
    fontSize: fontSize.xl,
    fontWeight: fontWeight.bold,
    color: colors.text.primary,
  },
  filterRow: {
    paddingVertical: 0,
    gap: spacing.xs,
    paddingHorizontal: 0,
  },
  filterChip: {
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
    borderRadius: borderRadius.xl,
    backgroundColor: 'rgba(0,0,0,0.04)',
  },
  filterChipActive: { backgroundColor: colors.primary },
  filterChipText: { color: colors.text.secondary, fontSize: fontSize.sm },
  filterChipTextActive: { color: '#FFFFFF', fontWeight: fontWeight.semibold },
  loadingBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    padding: spacing.lg,
    justifyContent: 'center',
  },
  loadingText: { color: colors.text.secondary, fontSize: fontSize.sm },
  emptyState: { padding: spacing.xl, alignItems: 'center' },
  emptyText: {
    color: colors.text.secondary,
    fontSize: fontSize.sm,
    textAlign: 'center',
    lineHeight: 20,
  },
  cardList: { gap: spacing.md, paddingTop: spacing.sm },

  // ── 列表 footer (分页状态) ──
  // 加载更多中 / 失败重试 / 已到底, 三种状态
  footerContainer: {
    paddingVertical: spacing.lg,
    alignItems: 'center',
    justifyContent: 'center',
  },
  footerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  footerText: {
    color: colors.text.secondary,
    fontSize: fontSize.sm,
  },
  footerRetry: {
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
    borderRadius: borderRadius.md,
    backgroundColor: 'rgba(15,118,110,0.10)',
  },
  footerRetryText: {
    color: '#0F766E',
    fontSize: fontSize.sm,
    fontWeight: fontWeight.semibold,
  },
  footerDone: {
    color: colors.text.secondary,
    fontSize: fontSize.xs,
  },

  // ── Cloud-drive status banner ──
  // Sits between the level filter row and the card list. Two
  // layout modes: full-bleed Pressable CTA when no provider is
  // configured, side-by-side info row when one is.
  cloudBanner: {
    marginTop: spacing.md,
    marginBottom: spacing.md,
    backgroundColor: colors.surface,
    borderRadius: borderRadius.lg,
    borderWidth: 1,
    borderColor: 'rgba(0,0,0,0.06)',
    overflow: 'hidden',
  },
  cloudBannerActionable: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: spacing.md,
    gap: spacing.sm,
  },
  cloudBannerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: spacing.md,
    gap: spacing.sm,
  },
  cloudBannerIcon: {
    width: 36, height: 36,
    borderRadius: 18,
    backgroundColor: 'rgba(15,118,110,0.10)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  cloudBannerBody: { flex: 1, minWidth: 0 },
  cloudBannerTitle: {
    fontSize: fontSize.base,
    fontWeight: fontWeight.semibold,
    color: colors.text.primary,
  },
  cloudBannerDesc: {
    fontSize: fontSize.xs,
    color: colors.text.secondary,
    marginTop: 2,
    lineHeight: 16,
  },
  cloudBannerScanBtn: {
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
    borderRadius: borderRadius.md,
    backgroundColor: 'rgba(15,118,110,0.10)',
    minWidth: 72,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cloudBannerScanBtnText: {
    fontSize: fontSize.sm,
    color: '#0F766E',
    fontWeight: fontWeight.semibold,
  },
});
