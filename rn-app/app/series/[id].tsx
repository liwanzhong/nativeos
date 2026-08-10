import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { ActivityIndicator, ImageBackground, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { ChevronLeft } from 'lucide-react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors, spacing, borderRadius, fontSize, fontWeight } from '../../constants/theme';
import { getOfficialVideoSeriesById, type OfficialVideoSeriesDetail } from '../../lib/content/video-series';

const LEVEL_COLORS: Record<string, { bg: string; text: string }> = {
  A1: { bg: '#DCFCE7', text: '#166534' },
  A2: { bg: '#DBEAFE', text: '#1D4ED8' },
  B1: { bg: '#FEF3C7', text: '#92400E' },
  B2: { bg: '#FDE68A', text: '#B45309' },
  C1: { bg: '#E9D5FF', text: '#7C3AED' },
  C2: { bg: '#FBCFE8', text: '#BE185D' },
};

function formatDuration(seconds: number) {
  const total = Math.max(0, Math.floor(seconds || 0));
  const minutes = Math.floor(total / 60);
  const remainder = total % 60;
  return `${minutes}:${remainder.toString().padStart(2, '0')}`;
}

export default function SeriesDetailScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ id?: string }>();
  const [series, setSeries] = useState<OfficialVideoSeriesDetail | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);

  const loadSeries = useCallback(async (forceRefresh: boolean = false) => {
    if (!params.id) {
      setSeries(null);
      setIsLoading(false);
      return;
    }
    if (!forceRefresh) {
      setIsLoading(true);
    }
    try {
      const result = await getOfficialVideoSeriesById(params.id, forceRefresh);
      setSeries(result);
    } finally {
      setIsLoading(false);
    }
  }, [params.id]);

  useFocusEffect(useCallback(() => {
    void loadSeries(false);
  }, [loadSeries]));

  const handleRefresh = useCallback(async () => {
    setIsRefreshing(true);
    try {
      await loadSeries(true);
    } finally {
      setIsRefreshing(false);
    }
  }, [loadSeries]);

  const progressRatio = useMemo(() => {
    if (!series || series.episodeCount <= 0) {
      return 0;
    }
    return Math.max(0, Math.min(1, series.completedEpisodeCount / series.episodeCount));
  }, [series]);

  if (isLoading) {
    return (
      <View style={styles.loadingContainer}>
        <ActivityIndicator size="large" color={colors.primary} />
        <Text style={styles.loadingText}>系列内容加载中…</Text>
      </View>
    );
  }

  if (!series) {
    return (
      <View style={styles.loadingContainer}>
        <Text style={styles.emptyTitle}>未找到该系列</Text>
        <Pressable style={styles.backOnlyBtn} onPress={() => router.back()}>
          <Text style={styles.backOnlyBtnText}>返回</Text>
        </Pressable>
      </View>
    );
  }

  const levelColors = LEVEL_COLORS[series.level] || LEVEL_COLORS.B1;

  return (
    <View style={styles.container}>
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={[styles.scrollContent, { paddingTop: insets.top + spacing.sm, paddingBottom: Math.max(insets.bottom + spacing.xl, spacing.xl) }]}
        refreshControl={<RefreshControl refreshing={isRefreshing} onRefresh={handleRefresh} />}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.headerRow}>
          <Pressable style={styles.backBtn} onPress={() => router.back()}>
            <ChevronLeft size={20} color="#111827" />
          </Pressable>
          <Text style={styles.headerTitle} numberOfLines={1}>{series.title}</Text>
          <View style={styles.headerSpacer} />
        </View>

        <View style={styles.heroCard}>
          {series.coverImageUri ? (
            <ImageBackground source={{ uri: series.coverImageUri }} style={styles.heroBackground} imageStyle={styles.heroImage}>
              <View style={styles.heroOverlay}>
                <View style={styles.heroBadgeRow}>
                  <View style={[styles.levelBadge, { backgroundColor: levelColors.bg }]}>
                    <Text style={[styles.levelText, { color: levelColors.text }]}>{series.level}</Text>
                  </View>
                  <View style={styles.metaPill}>
                    <Text style={styles.metaPillText}>{series.category}</Text>
                  </View>
                  <View style={styles.metaPill}>
                    <Text style={styles.metaPillText}>{series.episodeCount} 集</Text>
                  </View>
                </View>
                <View style={styles.heroContent}>
                  <Text style={styles.heroTitle}>{series.title}</Text>
                  {series.description ? <Text style={styles.heroDesc}>{series.description}</Text> : null}
                  <View style={styles.progressRow}>
                    <View style={styles.progressTrack}>
                      <View style={[styles.progressFill, { width: `${progressRatio * 100}%` }]} />
                    </View>
                    <Text style={styles.progressText}>{series.completedEpisodeCount}/{series.episodeCount}</Text>
                  </View>
                </View>
              </View>
            </ImageBackground>
          ) : (
            <View style={[styles.heroBackground, styles.heroFallback]}>
              <View style={styles.heroOverlay}>
                <View style={styles.heroBadgeRow}>
                  <View style={[styles.levelBadge, { backgroundColor: levelColors.bg }]}>
                    <Text style={[styles.levelText, { color: levelColors.text }]}>{series.level}</Text>
                  </View>
                  <View style={styles.metaPill}>
                    <Text style={styles.metaPillText}>{series.category}</Text>
                  </View>
                  <View style={styles.metaPill}>
                    <Text style={styles.metaPillText}>{series.episodeCount} 集</Text>
                  </View>
                </View>
                <View style={styles.heroContent}>
                  <Text style={styles.heroTitle}>{series.title}</Text>
                  {series.description ? <Text style={styles.heroDesc}>{series.description}</Text> : null}
                  <View style={styles.progressRow}>
                    <View style={styles.progressTrack}>
                      <View style={[styles.progressFill, { width: `${progressRatio * 100}%` }]} />
                    </View>
                    <Text style={styles.progressText}>{series.completedEpisodeCount}/{series.episodeCount}</Text>
                  </View>
                </View>
              </View>
            </View>
          )}
        </View>

        <View style={styles.sectionHeader}>
          <Text style={styles.sectionTitle}>系列剧集</Text>
        </View>

        <View style={styles.episodeList}>
          {series.episodes.map((episode, index) => {
            const isCompleted = index < series.completedEpisodeCount;
            return (
              <Pressable
                key={episode.id}
                style={styles.episodeCard}
                onPress={() => router.push(`/scenario/video/${encodeURIComponent(episode.id)}`)}
              >
                {episode.coverImageUri ? (
                  <ImageBackground source={{ uri: episode.coverImageUri }} style={styles.episodeCardBackground} imageStyle={styles.episodeCardImage}>
                    <View style={styles.episodeCardOverlay}>
                      <View style={styles.episodeLeft}>
                        <View style={[styles.episodeIndexBadge, isCompleted && styles.episodeIndexBadgeCompleted]}>
                          <Text style={[styles.episodeIndexText, isCompleted && styles.episodeIndexTextCompleted]}>{episode.episodeIndex || index + 1}</Text>
                        </View>
                        <View style={styles.episodeMeta}>
                          <Text style={styles.episodeTitleOnImage} numberOfLines={2}>{episode.episodeTitle || episode.card.title}</Text>
                          <Text style={styles.episodeSubTextOnImage}>{formatDuration(episode.durationSeconds)} · {episode.card.category}</Text>
                        </View>
                      </View>
                      <View style={styles.episodeRight}>
                        {isCompleted ? <Text style={styles.completedTextOnImage}>已学习</Text> : null}
                        <Text style={styles.enterTextOnImage}>进入</Text>
                      </View>
                    </View>
                  </ImageBackground>
                ) : (
                  <View style={styles.episodeCardContent}>
                    <View style={styles.episodeLeft}>
                      <View style={[styles.episodeIndexBadge, isCompleted && styles.episodeIndexBadgeCompleted]}>
                        <Text style={[styles.episodeIndexText, isCompleted && styles.episodeIndexTextCompleted]}>{episode.episodeIndex || index + 1}</Text>
                      </View>
                      <View style={styles.episodeMeta}>
                        <Text style={styles.episodeTitle} numberOfLines={2}>{episode.episodeTitle || episode.card.title}</Text>
                        <Text style={styles.episodeSubText}>{formatDuration(episode.durationSeconds)} · {episode.card.category}</Text>
                      </View>
                    </View>
                    <View style={styles.episodeRight}>
                      {isCompleted ? <Text style={styles.completedText}>已学习</Text> : null}
                      <Text style={styles.enterText}>进入</Text>
                    </View>
                  </View>
                )}
              </Pressable>
            );
          })}
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
  },
  scroll: {
    flex: 1,
  },
  scrollContent: {
    paddingHorizontal: spacing.lg,
    gap: spacing.md,
  },
  loadingContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.md,
    backgroundColor: colors.background,
    paddingHorizontal: spacing.xl,
  },
  loadingText: {
    fontSize: fontSize.sm,
    color: colors.text.secondary,
  },
  emptyTitle: {
    fontSize: fontSize.lg,
    color: colors.text.primary,
    fontWeight: fontWeight.bold,
  },
  backOnlyBtn: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderRadius: borderRadius.xl,
    backgroundColor: colors.primary,
  },
  backOnlyBtnText: {
    color: '#FFFFFF',
    fontSize: fontSize.sm,
    fontWeight: fontWeight.bold,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  backBtn: {
    width: 40,
    height: 40,
    borderRadius: borderRadius.full,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border.light,
  },
  headerTitle: {
    flex: 1,
    fontSize: fontSize.lg,
    fontWeight: fontWeight.bold,
    color: colors.text.primary,
  },
  headerSpacer: {
    width: 40,
  },
  heroCard: {
    borderRadius: borderRadius.xxl,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: colors.border.light,
    backgroundColor: '#0F172A',
  },
  heroBackground: {
    minHeight: 220,
  },
  heroImage: {
    borderRadius: borderRadius.xxl,
  },
  heroFallback: {
    backgroundColor: '#1E293B',
  },
  heroOverlay: {
    flex: 1,
    justifyContent: 'space-between',
    padding: spacing.lg,
    backgroundColor: 'rgba(15,23,42,0.48)',
  },
  heroBadgeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    flexWrap: 'wrap',
  },
  heroContent: {
    gap: spacing.sm,
  },
  heroTitle: {
    color: '#FFFFFF',
    fontSize: 24,
    lineHeight: 32,
    fontWeight: fontWeight.bold,
  },
  heroDesc: {
    color: 'rgba(255,255,255,0.85)',
    fontSize: fontSize.sm,
    lineHeight: 22,
  },
  levelBadge: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: borderRadius.full,
  },
  levelText: {
    fontSize: fontSize.xs,
    fontWeight: fontWeight.bold,
  },
  metaPill: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: borderRadius.full,
    backgroundColor: 'rgba(255,255,255,0.16)',
  },
  metaPillText: {
    color: '#FFFFFF',
    fontSize: fontSize.xs,
    fontWeight: fontWeight.bold,
  },
  progressRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  progressTrack: {
    flex: 1,
    height: 8,
    borderRadius: borderRadius.full,
    backgroundColor: 'rgba(255,255,255,0.16)',
    overflow: 'hidden',
  },
  progressFill: {
    height: '100%',
    backgroundColor: '#60A5FA',
  },
  progressText: {
    color: '#DBEAFE',
    fontSize: fontSize.xs,
    fontWeight: fontWeight.bold,
    minWidth: 34,
    textAlign: 'right',
  },
  sectionHeader: {
    gap: 4,
  },
  sectionTitle: {
    fontSize: fontSize.lg,
    fontWeight: fontWeight.bold,
    color: colors.text.primary,
  },
  episodeList: {
    gap: spacing.sm,
  },
  episodeCard: {
    borderRadius: borderRadius.xxl,
    overflow: 'hidden',
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border.light,
  },
  episodeCardContent: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.md,
    padding: spacing.md,
  },
  episodeCardBackground: {
    minHeight: 92,
  },
  episodeCardImage: {
    borderRadius: borderRadius.xxl,
  },
  episodeCardOverlay: {
    minHeight: 92,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.md,
    padding: spacing.md,
    backgroundColor: 'rgba(15,23,42,0.54)',
  },
  episodeLeft: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
  },
  episodeIndexBadge: {
    width: 34,
    height: 34,
    borderRadius: borderRadius.full,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#E2E8F0',
  },
  episodeIndexBadgeCompleted: {
    backgroundColor: '#DBEAFE',
  },
  episodeIndexText: {
    color: '#334155',
    fontSize: fontSize.sm,
    fontWeight: fontWeight.bold,
  },
  episodeIndexTextCompleted: {
    color: '#1D4ED8',
  },
  episodeMeta: {
    flex: 1,
    gap: 4,
  },
  episodeTitle: {
    fontSize: fontSize.base,
    color: colors.text.primary,
    fontWeight: fontWeight.bold,
    lineHeight: 22,
  },
  episodeTitleOnImage: {
    fontSize: fontSize.base,
    color: '#FFFFFF',
    fontWeight: fontWeight.bold,
    lineHeight: 22,
  },
  episodeSubText: {
    fontSize: fontSize.xs,
    color: colors.text.secondary,
  },
  episodeSubTextOnImage: {
    fontSize: fontSize.xs,
    color: 'rgba(255,255,255,0.82)',
  },
  episodeRight: {
    alignItems: 'flex-end',
    gap: 4,
  },
  completedText: {
    fontSize: fontSize.xs,
    color: '#2563EB',
    fontWeight: fontWeight.bold,
  },
  completedTextOnImage: {
    fontSize: fontSize.xs,
    color: '#DBEAFE',
    fontWeight: fontWeight.bold,
  },
  enterText: {
    fontSize: fontSize.sm,
    color: colors.primary,
    fontWeight: fontWeight.bold,
  },
  enterTextOnImage: {
    fontSize: fontSize.sm,
    color: '#FFFFFF',
    fontWeight: fontWeight.bold,
  },
});
