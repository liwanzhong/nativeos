/**
 * /library/[id] — recommended-series detail page.
 *
 * Why this is a separate page from /collection/[id]:
 *   The two pages look like they share a "collection" concept, but
 *   the user's mental model is genuinely different:
 *
 *     /collection/[id]  → "I already own this. Help me learn it."
 *       - Full video list, per-row status, 继续/再看一遍 CTA
 *       - 视频跟练 context
 *
 *     /library/[id]     → "I'm browsing. Help me decide."
 *       - Big cover, full description, episode PREVIEW (3-5 items,
 *         not the whole list), prominent 加入我的合集 CTA
 *       - 推荐 context
 *
 *   Same data shape underneath (an official series), but the
 *   page affordances and content priority are different. Forcing
 *   them into one page would mean either:
 *     - Conditional branches everywhere (kind === 'official' &&
 *       context === 'browse' ...), which gets messy fast, OR
 *     - A lowest-common-denominator layout that serves neither
 *       flow well.
 *
 *   Two small focused pages beat one big branched one.
 *
 * Navigation:
 *   - From /library (the list): tap a card → /library/<id>
 *   - 3-dot menu on this page:
 *       · not picked → "加入我的合集" (same as the CTA, accessible
 *         via menu for users who skip the obvious button)
 *       · picked     → "从我的合集移出" + "进入学习页"
 *         (the second item jumps to /collection/official:<id> for
 *         the full learning view)
 */

import { useLocalSearchParams, useFocusEffect, useRouter } from 'expo-router';
import {
  ActivityIndicator,
  Alert,
  Image,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  ArrowLeft,
  Check,
  ChevronRight,
  MoreVertical,
  Play,
  Plus,
  Trash2,
} from 'lucide-react-native';
import { useCallback, useState } from 'react';
import { colors, spacing, borderRadius, fontSize, fontWeight } from '../../constants/theme';
import {
  getOfficialVideoSeriesById as getOfficialVideoSeriesByIdLegacy,
  type OfficialVideoSeriesDetail,
} from '../../lib/content/video-series';
import { getOfficialVideoSeriesDetailFromSupabase } from '../../lib/content/video-series-supabase-views';
import { listMyPickedSeriesIds, pickSeries, unpickSeries } from '../../lib/content/user-picked-series';
import { invalidateCollectionsCache } from '../../lib/content/collections';
import { invalidateVideoSeriesViewsCache } from '../../lib/content/video-series-supabase-views';

const LIBRARY_DETAIL_LOG_PREFIX = '[LibraryDetail]';

function formatDuration(seconds: number | undefined): string {
  if (!seconds || !Number.isFinite(seconds)) return '';
  const total = Math.max(0, Math.floor(seconds));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

// How many episodes we preview in the "内容预览" section. The
// full list is intentionally hidden — the user has to commit
// (pick the series) to see everything. This is a soft commitment
// loop: the preview gives enough signal to decide, but the full
// list is the value the user gets by picking.
const EPISODE_PREVIEW_COUNT = 4;

export default function LibraryDetailPage() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { id: rawId } = useLocalSearchParams<{ id: string }>();
  const seriesId = typeof rawId === 'string' ? decodeURIComponent(rawId) : '';

  const [series, setSeries] = useState<OfficialVideoSeriesDetail | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isPicked, setIsPicked] = useState(false);
  const [isPicking, setIsPicking] = useState(false);
  const [isMenuVisible, setIsMenuVisible] = useState(false);

  // ── Load series + picked state together ─────────────────────
  // We always re-fetch on focus so the CTA reflects the latest
  // picked state (the user might have picked/unpicked from a
  // different page and come back here).
  const load = useCallback(async (forceRefresh: boolean = false) => {
    if (!seriesId) return;
    setIsLoading(true);
    try {
      // Supabase is the source of truth (per-series row in
      // `official_video_series` + per-episode rows in
      // `official_video_episodes`). Fall back to the legacy
      // OSS-catalog path if Supabase doesn't know the series —
      // e.g. a series that was uploaded but never re-imported
      // after the table was created.
      const [pickedIds, supabaseResult] = await Promise.all([
        listMyPickedSeriesIds(),
        getOfficialVideoSeriesDetailFromSupabase(seriesId, forceRefresh),
      ]);
      let detail = supabaseResult;
      if (!detail) {
        detail = await getOfficialVideoSeriesByIdLegacy(seriesId, forceRefresh);
      }
      setSeries(detail);
      setIsPicked(pickedIds.has(seriesId));
    } catch (err) {
      console.warn(`${LIBRARY_DETAIL_LOG_PREFIX} load failed`, err);
      setSeries(null);
    } finally {
      setIsLoading(false);
    }
  }, [seriesId]);

  useFocusEffect(useCallback(() => {
    void load(false);
  }, [load]));

  // ── Pick / unpick ──────────────────────────────────────────
  const handleTogglePick = useCallback(async () => {
    if (!series || isPicking) return;
    setIsPicking(true);
    setIsMenuVisible(false);
    try {
      if (isPicked) {
        await unpickSeries(series.id);
        setIsPicked(false);
      } else {
        await pickSeries(series.id);
        setIsPicked(true);
      }
      invalidateCollectionsCache();
      invalidateVideoSeriesViewsCache();
    } catch (err) {
      Alert.alert(
        isPicked ? '移出失败' : '加入失败',
        err instanceof Error ? err.message : String(err),
      );
    } finally {
      setIsPicking(false);
    }
  }, [series, isPicked, isPicking]);

  // ── Render ────────────────────────────────────────────────
  if (isLoading && !series) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color={colors.primary} />
      </View>
    );
  }

  if (!series) {
    return (
      <View style={styles.container}>
        <View style={styles.topBar}>
          <Pressable style={styles.backBtn} onPress={() => router.back()} hitSlop={8}>
            <ArrowLeft size={20} color={colors.text.primary} />
          </Pressable>
        </View>
        <View style={styles.center}>
          <Text style={styles.errorText}>找不到这个合集</Text>
        </View>
      </View>
    );
  }

  const previewEpisodes = series.episodes.slice(0, EPISODE_PREVIEW_COUNT);
  const hiddenEpisodeCount = Math.max(0, series.episodes.length - EPISODE_PREVIEW_COUNT);

  return (
    <View style={styles.container}>
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={[styles.scrollContent, { paddingBottom: Math.max(120, insets.bottom + 96) }]}
        showsVerticalScrollIndicator={false}
      >
        {/* ── Top bar (back + menu) ── */}
        <View style={styles.topBar}>
          <Pressable style={styles.backBtn} onPress={() => router.back()} hitSlop={8} accessibilityLabel="返回">
            <ArrowLeft size={20} color={colors.text.primary} />
          </Pressable>
          <View style={{ flex: 1 }} />
          <Pressable style={styles.menuBtn} onPress={() => setIsMenuVisible(true)} hitSlop={8} accessibilityLabel="更多">
            <MoreVertical size={20} color={colors.text.primary} />
          </Pressable>
        </View>

        {/* ── Hero cover ── */}
        <View style={styles.coverWrap}>
          {series.coverImageUri ? (
            <Image source={{ uri: series.coverImageUri }} style={styles.coverImg} />
          ) : (
            <View style={[styles.coverImg, styles.coverFallback]}>
              <Text style={styles.coverFallbackText}>{series.title.slice(0, 2)}</Text>
            </View>
          )}
        </View>

        {/* ── Header (badges + title + meta) ── */}
        <View style={styles.headerBlock}>
          <View style={styles.badgeRow}>
            {series.level ? (
              <View style={[styles.badge, styles.levelBadge]}>
                <Text style={[styles.badgeText, styles.levelBadgeText]}>{series.level}</Text>
              </View>
            ) : null}
            {series.category ? (
              <View style={[styles.badge, styles.categoryBadge]}>
                <Text style={[styles.badgeText, styles.categoryBadgeText]}>{series.category}</Text>
              </View>
            ) : null}
            <View style={{ flex: 1 }} />
            <Text style={styles.episodeMeta}>{series.episodeCount} 集</Text>
          </View>
          <Text style={styles.title}>{series.title}</Text>
          {series.description ? (
            <Text style={styles.description}>{series.description}</Text>
          ) : null}
        </View>

        {/* ── Primary CTA ── */}
        <Pressable
          style={[
            styles.cta,
            isPicked && styles.ctaPicked,
            isPicking && styles.ctaDisabled,
          ]}
          onPress={() => void handleTogglePick()}
          disabled={isPicking}
        >
          {isPicking ? (
            <ActivityIndicator size="small" color={isPicked ? '#0F766E' : '#FFFFFF'} />
          ) : isPicked ? (
            <>
              <Check size={18} color="#0F766E" />
              <Text style={[styles.ctaText, styles.ctaTextPicked]}>已加入我的合集</Text>
            </>
          ) : (
            <>
              <Plus size={18} color="#FFFFFF" />
              <Text style={styles.ctaText}>加入我的合集</Text>
            </>
          )}
        </Pressable>

        {/* ── Episode preview ── */}
        {previewEpisodes.length > 0 ? (
          <View style={styles.previewBlock}>
            <View style={styles.previewHeader}>
              <Text style={styles.previewTitle}>部分内容预览</Text>
              <Text style={styles.previewHint}>加入后查看全部 {series.episodeCount} 集</Text>
            </View>
            <View style={styles.previewList}>
              {previewEpisodes.map((ep, idx) => (
                <View key={ep.id} style={styles.previewRow}>
                  <View style={styles.previewIndexCol}>
                    <Text style={styles.previewIndex}>{idx + 1}</Text>
                  </View>
                  <View style={styles.previewBody}>
                    <Text style={styles.previewRowTitle} numberOfLines={1}>
                      {ep.episodeTitle || ep.groupTitle}
                    </Text>
                    <Text style={styles.previewRowMeta} numberOfLines={1}>
                      {ep.durationSeconds ? formatDuration(ep.durationSeconds) : ''}
                    </Text>
                  </View>
                  {/* Lock icon to signal "preview only" without
                      being too aggressive. */}
                  <Play size={14} color={colors.text.tertiary} />
                </View>
              ))}
            </View>
            {hiddenEpisodeCount > 0 ? (
              <View style={styles.previewFooter}>
                <Text style={styles.previewFooterText}>
                  还有 {hiddenEpisodeCount} 集{isPicked ? '' : '，加入后查看全部'}
                </Text>
                {isPicked ? (
                  <Pressable
                    onPress={() => router.push(`/collection/${encodeURIComponent(`official:${series.id}`)}`)}
                    hitSlop={6}
                    style={styles.previewFooterCta}
                  >
                    <Text style={styles.previewFooterCtaText}>进入学习页</Text>
                    <ChevronRight size={14} color={colors.primary} />
                  </Pressable>
                ) : null}
              </View>
            ) : null}
          </View>
        ) : null}
      </ScrollView>

      {/* ── 3-dot menu ── */}
      {isMenuVisible ? (
        <Modal visible transparent animationType="fade" onRequestClose={() => setIsMenuVisible(false)}>
          <View style={styles.menuOverlay}>
            <Pressable style={StyleSheet.absoluteFill} onPress={() => setIsMenuVisible(false)} />
            <View style={styles.menuSheet}>
              {isPicked ? (
                <>
                  <Text style={styles.menuTitle}>合集选项</Text>
                  <Pressable
                    style={[styles.menuItem, styles.menuItemDanger]}
                    onPress={() => void handleTogglePick()}
                  >
                    <Trash2 size={16} color="#DC2626" />
                    <Text style={[styles.menuItemText, { color: '#DC2626' }]}>从我的合集移出</Text>
                  </Pressable>
                  <Pressable
                    style={styles.menuItem}
                    onPress={() => {
                      setIsMenuVisible(false);
                      router.push(`/collection/${encodeURIComponent(`official:${series.id}`)}`);
                    }}
                  >
                    <Play size={16} color={colors.text.primary} />
                    <Text style={styles.menuItemText}>进入学习页</Text>
                  </Pressable>
                </>
              ) : (
                <>
                  <Text style={styles.menuTitle}>合集选项</Text>
                  <Pressable style={styles.menuItem} onPress={() => void handleTogglePick()}>
                    <Plus size={16} color={colors.text.primary} />
                    <Text style={styles.menuItemText}>加入我的合集</Text>
                  </Pressable>
                </>
              )}
            </View>
          </View>
        </Modal>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  scroll: { flex: 1 },
  scrollContent: { paddingHorizontal: spacing.md, paddingTop: spacing.md },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xl },
  errorText: { color: colors.text.secondary, fontSize: fontSize.base },

  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: spacing.md,
  },
  backBtn: {
    width: 36, height: 36, borderRadius: 18,
    backgroundColor: 'rgba(0,0,0,0.04)',
    alignItems: 'center', justifyContent: 'center',
  },
  menuBtn: {
    width: 36, height: 36, borderRadius: 18,
    backgroundColor: 'rgba(0,0,0,0.04)',
    alignItems: 'center', justifyContent: 'center',
  },

  // ── Cover ──
  coverWrap: {
    width: '100%',
    aspectRatio: 16 / 9,
    borderRadius: borderRadius.lg,
    overflow: 'hidden',
    backgroundColor: '#E2E8F0',
  },
  coverImg: {
    width: '100%',
    height: '100%',
  },
  coverFallback: {
    backgroundColor: '#475569',
    alignItems: 'center',
    justifyContent: 'center',
  },
  coverFallbackText: {
    color: '#FFFFFF',
    fontSize: 40,
    fontWeight: fontWeight.bold,
  },

  // ── Header block ──
  headerBlock: {
    paddingTop: spacing.md,
    paddingBottom: spacing.md,
    gap: spacing.sm,
  },
  badgeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    flexWrap: 'wrap',
  },
  badge: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 999,
  },
  badgeText: {
    fontSize: 11,
    fontWeight: fontWeight.semibold,
  },
  levelBadge: { backgroundColor: '#DBEAFE' },
  levelBadgeText: { color: '#1E40AF' },
  categoryBadge: { backgroundColor: 'rgba(0,0,0,0.05)' },
  categoryBadgeText: { color: colors.text.secondary, fontWeight: fontWeight.medium },
  episodeMeta: { fontSize: 12, color: colors.text.secondary },
  title: {
    fontSize: fontSize.xl,
    fontWeight: fontWeight.bold,
    color: colors.text.primary,
  },
  description: {
    fontSize: fontSize.base,
    color: colors.text.secondary,
    lineHeight: 22,
  },

  // ── Primary CTA ──
  cta: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 12,
    borderRadius: borderRadius.md,
    backgroundColor: colors.primary,
  },
  ctaPicked: {
    backgroundColor: 'rgba(15,118,110,0.10)',
    borderWidth: 1,
    borderColor: 'rgba(15,118,110,0.4)',
  },
  ctaDisabled: { opacity: 0.55 },
  ctaText: {
    color: '#FFFFFF',
    fontSize: fontSize.base,
    fontWeight: fontWeight.semibold,
  },
  ctaTextPicked: { color: '#0F766E' },

  // ── Episode preview ──
  previewBlock: {
    marginTop: spacing.lg,
    gap: spacing.md,
  },
  previewHeader: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
  },
  previewTitle: {
    fontSize: fontSize.lg,
    fontWeight: fontWeight.semibold,
    color: colors.text.primary,
  },
  previewHint: {
    fontSize: fontSize.xs,
    color: colors.text.tertiary,
  },
  previewList: {
    backgroundColor: colors.surface,
    borderRadius: borderRadius.lg,
    borderWidth: 1,
    borderColor: 'rgba(0,0,0,0.06)',
    overflow: 'hidden',
  },
  previewRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(0,0,0,0.04)',
  },
  previewIndexCol: {
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: 'rgba(0,0,0,0.04)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  previewIndex: {
    fontSize: 12,
    fontWeight: fontWeight.semibold,
    color: colors.text.secondary,
  },
  previewBody: { flex: 1, minWidth: 0 },
  previewRowTitle: {
    fontSize: fontSize.base,
    color: colors.text.primary,
    fontWeight: fontWeight.medium,
  },
  previewRowMeta: {
    fontSize: 12,
    color: colors.text.secondary,
    marginTop: 2,
  },
  previewFooter: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingTop: spacing.xs,
  },
  previewFooterText: {
    fontSize: fontSize.sm,
    color: colors.text.tertiary,
  },
  previewFooterCta: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
  },
  previewFooterCtaText: {
    fontSize: fontSize.sm,
    color: colors.primary,
    fontWeight: fontWeight.medium,
  },

  // ── Menu sheet ──
  menuOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.4)',
    justifyContent: 'flex-end',
  },
  menuSheet: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    paddingHorizontal: spacing.md,
    paddingTop: spacing.sm,
    paddingBottom: spacing.xl,
  },
  menuTitle: {
    fontSize: fontSize.lg,
    fontWeight: fontWeight.bold,
    color: colors.text.primary,
    paddingHorizontal: spacing.xs,
    paddingTop: spacing.xs,
    paddingBottom: spacing.sm,
  },
  menuItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: 14,
    paddingHorizontal: spacing.xs,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(0,0,0,0.04)',
  },
  menuItemDanger: {},
  menuItemText: {
    fontSize: fontSize.base,
    color: colors.text.primary,
    fontWeight: fontWeight.medium,
  },
});
