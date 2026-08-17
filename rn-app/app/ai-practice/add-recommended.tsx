/**
 * /ai-practice/add-recommended — secondary page for adding pre-generated
 * "推荐话题" (video-scene topics) to the AI 陪练 home grid.
 *
 * Sources: `listVideoAiTopicGroups` over the user's "我的合集" official
 * series. Each card has a [+] button that calls `addAiTopicToHome` with
 * `homeOrigin = 'from_recommended'`. A "已加入" toast confirms the
 * write; the button locks to "已加入" for the rest of the page life
 * (no auto-navigate — users often want to add several at once).
 *
 * Two filter surfaces:
 *  - Top chip row: difficulty band (适合我 / 全部 / A1..C2)
 *  - Top-right "场景筛选" button → bottom-sheet Modal for multi-select
 *    scene category filter. Sheet uses draft state; "确定" commits.
 */

import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  Pressable,
  ActivityIndicator,
  Alert,
  Modal,
} from 'react-native';
import { Stack, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, Plus, X } from 'lucide-react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors, spacing, borderRadius, fontSize, fontWeight } from '../../constants/theme';
import { sectionStyles } from '../../constants/sectionStyles';
import {
  buildAiPracticeTopicSnapshot,
  addAiTopicToHome,
  type AiPracticeHomeOrigin,
} from '../../lib/ai/ai-practice-user-meta';
import {
  listVideoAiTopicGroups,
  getAiPracticeFitBand,
  type AiPracticeFitBand,
  type VideoAiTopicGroup,
  type VideoAiTopicItem,
} from '../../lib/ai/ai-practice-hub';
import { listMyPickedSeriesIds } from '../../lib/content/user-picked-series';

type FitFilter = AiPracticeFitBand | 'A1' | 'A2' | 'B1' | 'B2' | 'C1' | 'C2';

const FIT_FILTER_OPTIONS: ReadonlyArray<readonly [FitFilter, string]> = [
  ['fit', '适合我'],
  ['all', '全部'],
  ['A1', 'A1'],
  ['A2', 'A2'],
  ['B1', 'B1'],
  ['B2', 'B2'],
  ['C1', 'C1'],
  ['C2', 'C2'],
];

export default function AiPracticeAddRecommendedPage() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [toast, setToast] = useState('');
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [videoGroups, setVideoGroups] = useState<VideoAiTopicGroup[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [userLevel, setUserLevel] = useState('B1');
  const [fitFilter, setFitFilter] = useState<FitFilter>('fit');
  const [selectedCategories, setSelectedCategories] = useState<string[]>([]);
  const [draftCategories, setDraftCategories] = useState<string[]>([]);
  const [isSceneSheetOpen, setIsSceneSheetOpen] = useState(false);
  const [addedTopicIds, setAddedTopicIds] = useState<Set<string>>(new Set());

  const showToast = useCallback((message: string) => {
    if (toastTimer.current) {
      clearTimeout(toastTimer.current);
    }
    setToast(message);
    toastTimer.current = setTimeout(() => setToast(''), 1800);
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const AsyncStorage = (await import('@react-native-async-storage/async-storage')).default;
        const level = (await AsyncStorage.getItem('user_level')) || 'B1';
        if (!cancelled) {
          setUserLevel(level);
        }
      } catch {
        // Defaults already seeded; nothing to do.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const loadRecommended = useCallback(async () => {
    setIsLoading(true);
    try {
      const pickedIds = await listMyPickedSeriesIds();
      // 2026-08-17: 未登录 / 没挑合集 → 传 null 给 listVideoAiTopicGroups 让它显示
      // 所有 official scenes 的推荐话题 (legacy fallback). 登录且 pickedIds 非空 → 只看挑的.
      // 区分: null = "显示全部 official", 空 Set = "登录但没挑 → 空", 非空 Set = "只看挑的"
      const effectivePickedIds = pickedIds.size > 0 ? pickedIds : null;
      console.log('[AiPracticeAddRecommended] picked series', { count: pickedIds.size, ids: Array.from(pickedIds), effective: effectivePickedIds == null ? 'all-official' : 'picked-only' });
      const groups = await listVideoAiTopicGroups(userLevel, false, effectivePickedIds);
      console.log('[AiPracticeAddRecommended] groups loaded', { count: groups.length, sample: groups.slice(0, 2).map(g => ({ sceneId: g.sceneId, sceneTitle: g.sceneTitle, topicCount: g.topicCount })) });
      setVideoGroups(groups);
    } catch (error) {
      console.warn('[AiPracticeAddRecommended] load failed', error);
      setVideoGroups([]);
    } finally {
      setIsLoading(false);
    }
  }, [userLevel]);

  useEffect(() => {
    void loadRecommended();
  }, [loadRecommended]);

  // Derive available scene categories from current groups, then prune any
  // stale selection whose category is no longer present (e.g. after the
  // user removes a "我的合集" series that previously contributed it).
  const videoCategories = useMemo(
    () => Array.from(new Set(videoGroups.flatMap((g) => g.topics.map((t) => t.card.category)).filter((c): c is string => Boolean(c)))),
    [videoGroups],
  );
  useEffect(() => {
    setSelectedCategories((prev) => prev.filter((item) => videoCategories.includes(item)));
    setDraftCategories((prev) => prev.filter((item) => videoCategories.includes(item)));
  }, [videoCategories]);

  // Flatten + filter by fit band / level. Mirrors the pre-redesign
  // `filteredVideoTopics` logic from AiPracticeHome so the filter
  // semantics stay identical for users who remember the old home.
  const filteredItems = useMemo(() => {
    const flat = videoGroups.flatMap((group) =>
      group.topics.map((topic) => ({
        ...topic,
        sceneId: group.sceneId,
        sceneTitle: group.sceneTitle,
      })),
    );
    return flat
      .filter((topic) => {
        if (selectedCategories.length > 0 && !selectedCategories.includes(topic.card.category)) {
          return false;
        }
        if (fitFilter === 'all') return true;
        if (['A1', 'A2', 'B1', 'B2', 'C1', 'C2'].includes(fitFilter)) {
          return topic.card.level === fitFilter;
        }
        return getAiPracticeFitBand(topic.card.level, userLevel) === fitFilter;
      })
      .sort((a, b) => b.fitScore - a.fitScore);
  }, [videoGroups, fitFilter, selectedCategories, userLevel]);

  const handleAdd = useCallback(async (item: VideoAiTopicItem & { sceneId: string; sceneTitle: string }) => {
    if (addedTopicIds.has(item.topicId)) return;
    try {
      const snapshot = buildAiPracticeTopicSnapshot({
        card: item.card,
        origin: 'from_recommended',
        sourceType: 'recommended_topic',
        sourceLabel: '推荐话题',
        sourceId: item.sceneId,
        sceneTitle: item.sceneTitle,
      });
      await addAiTopicToHome({ ...snapshot, homeOrigin: 'from_recommended' as AiPracticeHomeOrigin });
      setAddedTopicIds((prev) => {
        const next = new Set(prev);
        next.add(item.topicId);
        return next;
      });
      showToast('已加入');
    } catch (error) {
      console.warn('[AiPracticeAddRecommended] add failed', error);
      Alert.alert('加入失败', '请稍后再试。');
    }
  }, [addedTopicIds, showToast]);

  return (
    <>
      <Stack.Screen
        options={{
          headerShown: true,
          title: '推荐话题',
          headerShadowVisible: false,
          headerStyle: { backgroundColor: colors.background },
          headerTitleStyle: { color: colors.text.primary, fontSize: fontSize.lg, fontWeight: fontWeight.semibold },
          headerLeft: () => (
            <Pressable hitSlop={8} onPress={() => router.back()} style={styles.headerBack}>
              <ArrowLeft size={20} color={colors.text.primary} />
            </Pressable>
          ),
          headerRight: () => (
            <Pressable
              hitSlop={8}
              onPress={() => {
                setDraftCategories(selectedCategories);
                setIsSceneSheetOpen(true);
              }}
              style={[
                styles.headerSceneFilterBtn,
                selectedCategories.length > 0 && styles.headerSceneFilterBtnActive,
              ]}
            >
              <Text
                style={[
                  styles.headerSceneFilterBtnText,
                  selectedCategories.length > 0 && styles.headerSceneFilterBtnTextActive,
                ]}
              >
                {selectedCategories.length > 0 ? `场景筛选(${selectedCategories.length})` : '场景筛选'}
              </Text>
            </Pressable>
          ),
        }}
      />
      <View style={styles.container}>
        <ScrollView
          style={styles.scroll}
          contentContainerStyle={[styles.scrollContent, { paddingBottom: Math.max(120, insets.bottom + 96) }]}
          showsVerticalScrollIndicator={false}
        >
          <View style={styles.filterRow}>
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.filterScrollContent}
            >
              {FIT_FILTER_OPTIONS.map(([value, label]) => {
                const active = fitFilter === value;
                return (
                  <Pressable
                    key={`fit-filter-${value}`}
                    style={[styles.filterChip, active && styles.filterChipActive]}
                    onPress={() => setFitFilter(value)}
                  >
                    <Text style={[styles.filterChipText, active && styles.filterChipTextActive]}>{label}</Text>
                  </Pressable>
                );
              })}
            </ScrollView>
          </View>

          {isLoading ? (
            <View style={styles.loadingRow}>
              <ActivityIndicator size="small" color={colors.primary} />
              <Text style={styles.loadingText}>正在整理…</Text>
            </View>
          ) : filteredItems.length === 0 ? (
            <View style={styles.emptyHint}>
              <Text style={styles.emptyHintText}>
                {videoGroups.length === 0
                  ? '「我的合集」里还没有视频。先去视频跟练 tab 挑合集，预生成话题会自动出现在这里。'
                  : '当前筛选下没有匹配的话题，换个标签试试。'}
              </Text>
            </View>
          ) : (
            filteredItems.map((item) => {
              const added = addedTopicIds.has(item.topicId);
              return (
                <View key={`recommended-${item.topicId}`} style={styles.recommendedCard}>
                  <View style={styles.recommendedCardBody}>
                    <View style={styles.recommendedCardTopRow}>
                      <Text style={styles.recommendedEmoji}>{item.card.icon}</Text>
                      {item.card.level ? (
                        <View style={styles.levelBadge}>
                          <Text style={styles.levelText}>{item.card.level}</Text>
                        </View>
                      ) : null}
                      {item.card.category ? (
                        <Text style={styles.categoryText} numberOfLines={1}>{item.card.category}</Text>
                      ) : null}
                    </View>
                    <Text style={styles.recommendedCardTitle} numberOfLines={2}>{item.card.title}</Text>
                    {item.card.descZh || item.card.desc ? (
                      <Text style={styles.recommendedCardDesc} numberOfLines={1}>
                        {item.card.descZh || item.card.desc}
                      </Text>
                    ) : null}
                    <Text style={styles.recommendedCardSource} numberOfLines={1}>
                      {item.sceneTitle ? `《${item.sceneTitle}》` : ''}
                    </Text>
                  </View>
                  <Pressable
                    hitSlop={8}
                    onPress={() => void handleAdd(item)}
                    style={[styles.addBtn, added && styles.addBtnDisabled]}
                    disabled={added}
                    accessibilityLabel={added ? '已加入' : '加入主页'}
                  >
                    {added ? (
                      <Text style={styles.addBtnTextAdded}>已加入</Text>
                    ) : (
                      <Plus size={18} color={colors.primary} />
                    )}
                  </Pressable>
                </View>
              );
            })
          )}
        </ScrollView>
        {toast ? (
          <View style={styles.toast} pointerEvents="none">
            <Text style={styles.toastText}>{toast}</Text>
          </View>
        ) : null}
      </View>

      <Modal visible={isSceneSheetOpen} transparent animationType="slide" onRequestClose={() => setIsSceneSheetOpen(false)}>
        <View style={styles.sceneSheetOverlay}>
          <Pressable style={styles.sceneSheetBackdrop} onPress={() => setIsSceneSheetOpen(false)} />
          <View style={styles.sceneSheet}>
            <View style={styles.sceneSheetHandle} />
            <View style={styles.sceneSheetHeader}>
              <Text style={styles.sceneSheetTitle}>场景筛选</Text>
              <View style={styles.sceneSheetHeaderActions}>
                <Pressable
                  onPress={() => {
                    setSelectedCategories(draftCategories);
                    setIsSceneSheetOpen(false);
                  }}
                >
                  <Text style={styles.sceneSheetConfirmText}>确定</Text>
                </Pressable>
                <Pressable onPress={() => setDraftCategories([])}>
                  <Text style={styles.sceneSheetClearText}>清空</Text>
                </Pressable>
                <Pressable hitSlop={8} onPress={() => setIsSceneSheetOpen(false)}>
                  <X size={18} color={colors.text.secondary} />
                </Pressable>
              </View>
            </View>
            {videoCategories.length === 0 ? (
              <Text style={styles.sceneSheetEmpty}>还没有可筛选的场景。</Text>
            ) : (
              <ScrollView style={styles.sceneSheetScroll} showsVerticalScrollIndicator={false}>
                <View style={styles.sceneSheetOptionsWrap}>
                  {videoCategories.map((value) => {
                    const active = draftCategories.includes(value);
                    return (
                      <Pressable
                        key={`scene-filter-${value}`}
                        style={[styles.sceneSheetChip, active && styles.sceneSheetChipActive]}
                        onPress={() =>
                          setDraftCategories((prev) =>
                            active ? prev.filter((item) => item !== value) : [...prev, value],
                          )
                        }
                      >
                        <Text style={[styles.sceneSheetChipText, active && styles.sceneSheetChipTextActive]}>{value}</Text>
                      </Pressable>
                    );
                  })}
                </View>
              </ScrollView>
            )}
          </View>
        </View>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
  },
  headerBack: {
    paddingHorizontal: 4,
    paddingVertical: 4,
  },
  scroll: {
    flex: 1,
  },
  scrollContent: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
  },
  filterRow: {
    marginBottom: spacing.sm,
  },
  headerSceneFilterBtn: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: borderRadius.full,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border.light,
  },
  headerSceneFilterBtnActive: {
    backgroundColor: '#EFF6FF',
    borderColor: '#93C5FD',
  },
  headerSceneFilterBtnText: {
    fontSize: fontSize.xs,
    color: colors.text.secondary,
    fontWeight: fontWeight.medium,
  },
  headerSceneFilterBtnTextActive: {
    color: colors.primary,
    fontWeight: fontWeight.bold,
  },
  sceneSheetOverlay: {
    flex: 1,
    backgroundColor: 'rgba(15, 23, 42, 0.35)',
    justifyContent: 'flex-end',
  },
  sceneSheetBackdrop: {
    flex: 1,
  },
  sceneSheet: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    paddingBottom: Math.max(28, spacing.xl),
    gap: spacing.md,
    maxHeight: '72%',
  },
  sceneSheetHandle: {
    width: 40,
    height: 5,
    borderRadius: borderRadius.full,
    backgroundColor: colors.border.default,
    alignSelf: 'center',
  },
  sceneSheetHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.md,
  },
  sceneSheetTitle: {
    fontSize: fontSize.lg,
    fontWeight: fontWeight.bold,
    color: colors.text.primary,
  },
  sceneSheetHeaderActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
  },
  sceneSheetConfirmText: {
    fontSize: fontSize.sm,
    color: colors.primary,
    fontWeight: fontWeight.bold,
  },
  sceneSheetClearText: {
    fontSize: fontSize.sm,
    color: colors.primary,
    fontWeight: fontWeight.medium,
  },
  sceneSheetScroll: {
    flexGrow: 0,
  },
  sceneSheetOptionsWrap: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
    paddingBottom: spacing.md,
  },
  sceneSheetChip: {
    minWidth: 72,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: borderRadius.full,
    backgroundColor: '#F8FAFC',
    borderWidth: 1,
    borderColor: '#E2E8F0',
    alignItems: 'center',
    justifyContent: 'center',
  },
  sceneSheetChipActive: {
    backgroundColor: '#EFF6FF',
    borderColor: '#93C5FD',
  },
  sceneSheetChipText: {
    fontSize: fontSize.sm,
    color: colors.text.secondary,
    fontWeight: fontWeight.medium,
    textAlign: 'center',
  },
  sceneSheetChipTextActive: {
    color: colors.primary,
    fontWeight: fontWeight.bold,
  },
  sceneSheetEmpty: {
    fontSize: fontSize.sm,
    color: colors.text.secondary,
    lineHeight: 20,
    paddingVertical: spacing.md,
  },
  filterScrollContent: {
    gap: spacing.sm,
    paddingRight: spacing.md,
  },
  filterChip: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: borderRadius.full,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border.light,
  },
  filterChipActive: {
    backgroundColor: '#EFF6FF',
    borderColor: '#93C5FD',
  },
  filterChipText: {
    fontSize: fontSize.sm,
    color: colors.text.secondary,
    fontWeight: fontWeight.medium,
  },
  filterChipTextActive: {
    color: colors.primary,
    fontWeight: fontWeight.bold,
  },
  loadingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.lg,
  },
  loadingText: {
    fontSize: fontSize.sm,
    color: colors.text.secondary,
  },
  emptyHint: {
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.md,
    backgroundColor: '#F8FAFC',
    borderRadius: borderRadius.lg,
    borderWidth: 1,
    borderColor: '#E2E8F0',
  },
  emptyHintText: {
    fontSize: fontSize.sm,
    color: colors.text.secondary,
    lineHeight: 20,
  },
  recommendedCard: {
    flexDirection: 'row',
    alignItems: 'stretch',
    paddingVertical: 12,
    paddingHorizontal: 12,
    marginTop: spacing.sm,
    backgroundColor: colors.surface,
    borderRadius: borderRadius.lg,
    borderWidth: 1,
    borderColor: colors.border.light,
    gap: 8,
  },
  recommendedCardBody: {
    flex: 1,
    gap: 4,
  },
  recommendedCardTopRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  recommendedEmoji: {
    fontSize: 20,
    lineHeight: 24,
  },
  recommendedCardTitle: {
    fontSize: fontSize.sm,
    fontWeight: fontWeight.bold,
    color: colors.text.primary,
    lineHeight: 18,
  },
  recommendedCardDesc: {
    fontSize: fontSize.xs,
    color: colors.text.secondary,
    lineHeight: 16,
  },
  recommendedCardSource: {
    fontSize: 10,
    color: colors.text.tertiary,
    marginTop: 2,
  },
  addBtn: {
    width: 36,
    height: 36,
    borderRadius: borderRadius.full,
    backgroundColor: '#EFF6FF',
    alignItems: 'center',
    justifyContent: 'center',
    alignSelf: 'center',
  },
  addBtnDisabled: {
    backgroundColor: '#F8FAFC',
  },
  addBtnTextAdded: {
    fontSize: 10,
    fontWeight: fontWeight.bold,
    color: colors.text.tertiary,
  },
  levelBadge: {
    paddingHorizontal: 6,
    paddingVertical: 1,
    borderRadius: borderRadius.sm,
    backgroundColor: '#DBEAFE',
  },
  levelText: {
    fontSize: 10,
    fontWeight: fontWeight.bold,
    color: '#1E40AF',
  },
  categoryText: {
    flexShrink: 1,
    fontSize: 10,
    fontWeight: fontWeight.bold,
    color: '#9CA3AF',
  },
  toast: {
    position: 'absolute',
    bottom: 100,
    left: '50%',
    transform: [{ translateX: -80 }],
    backgroundColor: 'rgba(15, 23, 42, 0.92)',
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: borderRadius.full,
    width: 160,
    alignItems: 'center',
  },
  toastText: {
    color: '#FFFFFF',
    fontSize: fontSize.sm,
    fontWeight: fontWeight.medium,
  },
});
