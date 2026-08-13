/**
 * AI 陪练 home — single source of truth for the user's "已加入话题" list.
 *
 * UX (post-2026-08-13 redesign):
 *   - One flat grid of topics the user has explicitly added, sorted by
 *     `homeAddedAt` desc (newest on top).
 *   - Sources: video-chip push, /ai-practice/add "推荐话题" [+] buttons,
 *     /ai-practice/add "自定义话题" generator results. The home page
 *     does not distinguish between them — all three routes funnel
 *     through `addAiTopicToHome` and read back via `listHomeAiTopics`.
 *   - Top-right [+] button → /ai-practice/add.
 *   - Per-card [×] → `removeAiTopicFromHome` (re-list on next focus).
 *   - Tap a card → `markAiPracticeTopicUsed` + push immersive chat.
 *
 * Removed (from pre-redesign):
 *   - Top "话题 / 历史 / 收藏" tab row.
 *   - 推荐话题 section (LLM "daily" stream + Shuffle).
 *   - 历史 / 收藏 list pages.
 *   - The from-video-chip deep-link highlight banner (video chips now
 *     pre-add to the home list, so the user just sees the topic on
 *     the home page on their next visit).
 */

import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  Pressable,
  RefreshControl,
  ActivityIndicator,
  Alert,
  Modal,
} from 'react-native';
import { useRouter, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { Plus, X, Sparkles, BookmarkPlus, ChevronRight } from 'lucide-react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors, spacing, borderRadius, fontSize, fontWeight } from '../../constants/theme';
import { sectionStyles } from '../../constants/sectionStyles';
import { selectScenario } from '../../lib/ai/scenario-generator';
import {
  listHomeAiTopics,
  markAiPracticeTopicUsed,
  removeAiTopicFromHome,
  type AiPracticeUserMetaRecord,
} from '../../lib/ai/ai-practice-user-meta';

function HomeTopicCard({
  record,
  onOpen,
  onRemove,
}: {
  record: AiPracticeUserMetaRecord;
  onOpen: () => void;
  onRemove: () => void;
}) {
  const card = record.card || {};
  return (
    <View style={styles.topicCard}>
      <Pressable style={styles.topicCardBody} onPress={onOpen}>
        <View style={styles.topicCardTopRow}>
          <Text style={styles.topicEmoji}>{record.icon || card.icon || '💬'}</Text>
          <View style={styles.topicCardMetaRow}>
            {record.level ? (
              <View style={styles.levelBadge}>
                <Text style={styles.levelText}>{record.level}</Text>
              </View>
            ) : null}
            {record.category ? (
              <Text style={styles.categoryText} numberOfLines={1}>{record.category}</Text>
            ) : null}
          </View>
          <Pressable
            hitSlop={8}
            onPress={(event) => {
              // Stop the outer Pressable from also firing and starting
              // the immersive chat when the user clearly meant to
              // dismiss the card.
              event.stopPropagation?.();
              Alert.alert(
                '移出 AI 陪练',
                `确定不再练习「${record.title}」？`,
                [
                  { text: '取消', style: 'cancel' },
                  { text: '移出', style: 'destructive', onPress: onRemove },
                ],
              );
            }}
            style={styles.removeBtn}
          >
            <X size={16} color={colors.text.tertiary} />
          </Pressable>
        </View>
        <Text style={styles.topicCardTitle} numberOfLines={2}>{record.title}</Text>
        {record.descZh || record.desc ? (
          <Text style={styles.topicCardDesc} numberOfLines={1}>
            {record.descZh || record.desc}
          </Text>
        ) : null}
      </Pressable>
    </View>
  );
}

export function AiPracticeHome() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [homeTopics, setHomeTopics] = useState<AiPracticeUserMetaRecord[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isPullRefreshing, setIsPullRefreshing] = useState(false);
  const [isAddChoiceOpen, setIsAddChoiceOpen] = useState(false);

  const reload = useCallback(async () => {
    try {
      const rows = await listHomeAiTopics();
      setHomeTopics(rows);
    } catch (error) {
      console.warn('[AiPracticeHome] listHomeAiTopics failed', error);
      setHomeTopics([]);
    }
  }, []);

  useFocusEffect(useCallback(() => {
    let cancelled = false;
    setIsLoading(true);
    (async () => {
      await reload();
      if (!cancelled) {
        setIsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [reload]));

  const handlePullRefresh = useCallback(async () => {
    setIsPullRefreshing(true);
    try {
      await reload();
    } finally {
      setIsPullRefreshing(false);
    }
  }, [reload]);

  const handleOpenTopic = useCallback(async (record: AiPracticeUserMetaRecord) => {
    try {
      // Bump use_count + last_used_at so we know which topics are getting
      // traffic. Adding to home uses a different field (homeAddedAt) —
      // do not conflate.
      await markAiPracticeTopicUsed(record);
      if (record.card) {
        await selectScenario(record.card);
      }
      router.push(`/scenario/immersive/${record.card?.id ?? record.topicId}`);
    } catch (error) {
      console.warn('[AiPracticeHome] open topic failed', error);
    }
  }, [router]);

  const handleRemoveTopic = useCallback(async (record: AiPracticeUserMetaRecord) => {
    try {
      await removeAiTopicFromHome(record.topicId);
      setHomeTopics((prev) => prev.filter((row) => row.topicId !== record.topicId));
    } catch (error) {
      console.warn('[AiPracticeHome] remove topic failed', error);
    }
  }, []);

  const handleOpenAddPage = useCallback(() => {
    // Two-source picker instead of jumping straight to a page — lets
    // the user choose between browsing pre-generated "推荐话题" and
    // running the LLM "自定义" generator. Both routes funnel into
    // `addAiTopicToHome` so the home grid is the single source of
    // truth either way.
    setIsAddChoiceOpen(true);
  }, []);

  const handleAddChoiceRecommended = useCallback(() => {
    setIsAddChoiceOpen(false);
    router.push('/ai-practice/add-recommended');
  }, [router]);

  const handleAddChoiceCustom = useCallback(() => {
    setIsAddChoiceOpen(false);
    router.push('/ai-practice/add-custom');
  }, [router]);

  const handleOpenRecommendedDirect = useCallback(() => {
    // Quick-access link: skip the choice sheet, jump straight to the
    // recommended page. The [+] button still goes through the sheet
    // so users can also reach the custom generator from there.
    router.push('/ai-practice/add-recommended');
  }, [router]);

  const topicRows = pairItems(homeTopics);

  return (
    <View style={styles.container}>
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={[styles.scrollContent, { paddingBottom: Math.max(120, insets.bottom + 96) }]}
        showsVerticalScrollIndicator={false}
        refreshControl={<RefreshControl refreshing={isPullRefreshing} onRefresh={handlePullRefresh} />}
      >
        <View style={styles.pageHeaderRow}>
          <View style={sectionStyles.pageHeaderInfo}>
            <Text style={sectionStyles.pageTitle}>AI陪练</Text>
          </View>
          <View style={styles.pageHeaderActions}>
            <Pressable
              hitSlop={6}
              onPress={handleOpenRecommendedDirect}
              style={styles.recommendedLinkWrap}
            >
              <Text style={styles.recommendedLinkText}>推荐话题</Text>
              <ChevronRight size={14} color={colors.primary} />
            </Pressable>
            <Pressable
              hitSlop={8}
              onPress={handleOpenAddPage}
              style={styles.addButton}
              accessibilityLabel="加入话题"
            >
              <Plus size={22} color={colors.text.primary} />
            </Pressable>
          </View>
        </View>

        {isLoading ? (
          <View style={styles.loadingWrap}>
            <ActivityIndicator size="small" color={colors.primary} />
            <Text style={styles.loadingText}>正在加载…</Text>
          </View>
        ) : homeTopics.length === 0 ? (
          <View style={styles.emptyState}>
            <Text style={styles.emptyTitle}>还没有加入话题</Text>
            <Text style={styles.emptyDesc}>
              点右上角 + 进入「推荐话题 / 自定义话题」挑选你想练的场景。
            </Text>
            <Pressable style={styles.emptyCta} onPress={handleOpenAddPage}>
              <Plus size={16} color="#FFFFFF" />
              <Text style={styles.emptyCtaText}>去加入话题</Text>
            </Pressable>
          </View>
        ) : (
          topicRows.map(([left, right], rowIndex) => (
            <View key={`home-row-${rowIndex}`} style={styles.topicRow}>
              <View style={styles.topicCell}>
                <HomeTopicCard
                  record={left}
                  onOpen={() => void handleOpenTopic(left)}
                  onRemove={() => void handleRemoveTopic(left)}
                />
              </View>
              {right ? (
                <View style={styles.topicCell}>
                  <HomeTopicCard
                    record={right}
                    onOpen={() => void handleOpenTopic(right)}
                    onRemove={() => void handleRemoveTopic(right)}
                  />
                </View>
              ) : (
                <View style={styles.topicCellPlaceholder} />
              )}
            </View>
          ))
        )}
      </ScrollView>

      <Modal
        visible={isAddChoiceOpen}
        transparent
        animationType="slide"
        onRequestClose={() => setIsAddChoiceOpen(false)}
      >
        <View style={styles.choiceSheetOverlay}>
          <Pressable style={styles.choiceSheetBackdrop} onPress={() => setIsAddChoiceOpen(false)} />
          <View style={styles.choiceSheet}>
            <View style={styles.choiceSheetHandle} />
            <Text style={styles.choiceSheetTitle}>选择加入方式</Text>
            <Pressable style={styles.choiceItem} onPress={handleAddChoiceRecommended}>
              <View style={[styles.choiceItemIcon, styles.choiceItemIconRecommended]}>
                <BookmarkPlus size={20} color="#1E40AF" />
              </View>
              <View style={styles.choiceItemBody}>
                <Text style={styles.choiceItemTitle}>推荐话题</Text>
                <Text style={styles.choiceItemDesc}>从「我的合集」视频的预生成话题里挑</Text>
              </View>
            </Pressable>
            <Pressable style={styles.choiceItem} onPress={handleAddChoiceCustom}>
              <View style={[styles.choiceItemIcon, styles.choiceItemIconCustom]}>
                <Sparkles size={20} color="#7C3AED" />
              </View>
              <View style={styles.choiceItemBody}>
                <Text style={styles.choiceItemTitle}>自定义话题</Text>
                <Text style={styles.choiceItemDesc}>描述场景，让 AI 给你出几个新题</Text>
              </View>
            </Pressable>
            <Pressable
              style={styles.choiceCancel}
              onPress={() => setIsAddChoiceOpen(false)}
            >
              <Text style={styles.choiceCancelText}>取消</Text>
            </Pressable>
          </View>
        </View>
      </Modal>
    </View>
  );
}

function pairItems<T>(items: T[]): Array<[T, T | null]> {
  const rows: Array<[T, T | null]> = [];
  for (let index = 0; index < items.length; index += 2) {
    rows.push([items[index], items[index + 1] ?? null]);
  }
  return rows;
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
    paddingTop: spacing.sm,
  },
  pageHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.md,
    backgroundColor: colors.background,
    paddingTop: spacing.sm,
  },
  pageHeaderActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  recommendedLinkWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
    paddingHorizontal: 4,
    paddingVertical: 4,
  },
  recommendedLinkText: {
    fontSize: fontSize.sm,
    color: colors.primary,
    fontWeight: fontWeight.medium,
  },
  addButton: {
    width: 36,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
  },
  loadingWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.xl,
    justifyContent: 'center',
  },
  loadingText: {
    fontSize: fontSize.sm,
    color: colors.text.secondary,
  },
  emptyState: {
    paddingVertical: spacing.xxl,
    paddingHorizontal: spacing.lg,
    alignItems: 'center',
    gap: spacing.sm,
  },
  emptyTitle: {
    fontSize: fontSize.base,
    fontWeight: fontWeight.semibold,
    color: colors.text.primary,
  },
  emptyDesc: {
    fontSize: fontSize.sm,
    color: colors.text.secondary,
    textAlign: 'center',
    lineHeight: 20,
  },
  emptyCta: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: 10,
    borderRadius: borderRadius.full,
    backgroundColor: colors.primary,
  },
  emptyCtaText: {
    fontSize: fontSize.sm,
    color: '#FFFFFF',
    fontWeight: fontWeight.semibold,
  },
  topicRow: {
    flexDirection: 'row',
    gap: spacing.md,
    marginTop: spacing.md,
  },
  topicCell: {
    flex: 1,
  },
  topicCellPlaceholder: {
    flex: 1,
  },
  topicCard: {
    borderRadius: borderRadius.xl,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border.light,
    paddingHorizontal: 12,
    paddingVertical: 12,
  },
  topicCardBody: {
    gap: 8,
  },
  topicCardTopRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  topicEmoji: {
    fontSize: 20,
    lineHeight: 24,
  },
  topicCardMetaRow: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    flexWrap: 'wrap',
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
  removeBtn: {
    width: 24,
    height: 24,
    borderRadius: borderRadius.full,
    backgroundColor: '#F8FAFC',
    alignItems: 'center',
    justifyContent: 'center',
  },
  topicCardTitle: {
    fontSize: fontSize.sm,
    fontWeight: fontWeight.bold,
    color: colors.text.primary,
    lineHeight: 18,
  },
  topicCardDesc: {
    fontSize: fontSize.xs,
    color: colors.text.secondary,
    lineHeight: 16,
  },

  // ── Add-choice bottom sheet ────────────────────────────────
  choiceSheetOverlay: {
    flex: 1,
    backgroundColor: 'rgba(15, 23, 42, 0.4)',
    justifyContent: 'flex-end',
  },
  choiceSheetBackdrop: {
    flex: 1,
  },
  choiceSheet: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    paddingBottom: Math.max(28, spacing.xl),
    gap: spacing.sm,
  },
  choiceSheetHandle: {
    width: 40,
    height: 5,
    borderRadius: borderRadius.full,
    backgroundColor: colors.border.default,
    alignSelf: 'center',
  },
  choiceSheetTitle: {
    fontSize: fontSize.lg,
    fontWeight: fontWeight.bold,
    color: colors.text.primary,
    marginTop: spacing.xs,
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
  choiceItemIconRecommended: {
    backgroundColor: '#DBEAFE',
  },
  choiceItemIconCustom: {
    backgroundColor: 'rgba(124,58,237,0.12)',
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
});

export default AiPracticeHome;
