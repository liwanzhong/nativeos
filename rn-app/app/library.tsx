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
  getOfficialVideoSeriesListFromSupabase,
  invalidateVideoSeriesViewsCache,
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

  const load = useCallback(async (forceRefresh: boolean) => {
    if (!forceRefresh) setIsLoading(true);
    logLibTrace('load start', { forceRefresh });
    try {
      const [list, ids, configuredProviders] = await Promise.all([
        getOfficialVideoSeriesListFromSupabase(forceRefresh),
        listMyPickedSeriesIds(),
        getConfiguredCloudProviders().catch(() => [] as ('baidu_pan')[]),
      ]);
      setSeries(list);
      setPickedIdSet(ids);
      const provider = configuredProviders[0] ?? 'baidu_pan';
      const map = await getOfficialSceneBindingStatus(
        list.map((s) => s.id),
        provider,
      );
      setBindingMap(map);
      setIsCloudReady(configuredProviders.length > 0);
      logLibTrace('load success', { count: list.length, pickedCount: ids.size, provider });
    } catch (err) {
      logLibTrace('load failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      setSeries([]);
      setPickedIdSet(new Set());
    } finally {
      if (!forceRefresh) setIsLoading(false);
    }
  }, []);

  useFocusEffect(useCallback(() => {
    void load(false);
  }, [load]));

  const onPullRefresh = useCallback(async () => {
    setIsPullRefreshing(true);
    try {
      await load(true);
    } finally {
      setIsPullRefreshing(false);
    }
  }, [load]);

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
      await load(false);
    } catch (err) {
      Alert.alert('扫描失败', err instanceof Error ? err.message : String(err));
    } finally {
      setIsRescanning(false);
    }
  }, [isRescanning, load]);

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

  const visible = useMemo(() => {
    if (levelFilter === 'all') return series;
    return series.filter((s) => s.level === levelFilter);
  }, [levelFilter, series]);

  return (
    <View style={styles.container}>
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={[
          styles.scrollContent,
          { paddingBottom: Math.max(120, insets.bottom + 96) },
        ]}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl refreshing={isPullRefreshing} onRefresh={onPullRefresh} />
        }
      >
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
            onPress={() => setLevelFilter('all')}
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
                onPress={() => setLevelFilter(level)}
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

        {isLoading && series.length === 0 ? (
          <View style={styles.loadingBanner}>
            <ActivityIndicator size="small" color={colors.primary} />
            <Text style={styles.loadingText}>资源库加载中…</Text>
          </View>
        ) : visible.length === 0 ? (
          <View style={styles.emptyState}>
            <Text style={styles.emptyText}>
              当前筛选下没有可加的视频。换一个等级试试,或者下拉刷新一下。
            </Text>
          </View>
        ) : (
          <View style={styles.cardList}>
            {visible.map((s) => (
              <LibraryCard
                key={s.id}
                series={s}
                isPicked={pickedIdSet.has(s.id)}
                isPicking={pendingPickId === s.id}
                onTogglePick={() => handleTogglePick(s.id)}
                onOpen={() => router.push(`/library/${encodeURIComponent(s.id)}`)}
                binding={bindingMap[s.id]}
                onBindingPress={() => handleBindingPress(s.id)}
                onCachePress={() => handleCachePress(s.id)}
              />
            ))}
          </View>
        )}
      </ScrollView>
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
