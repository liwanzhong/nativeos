import React, { useCallback, useRef, useState } from 'react';
import {
  View, Text, StyleSheet, Pressable, ActivityIndicator,
  ScrollView, Alert, TextInput, Image, RefreshControl,
} from 'react-native';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Swipeable } from 'react-native-gesture-handler';
import {
  BookOpen, Video, MessageCircle, Trash2, X, Check, Edit3,
} from 'lucide-react-native';
import { colors, spacing, borderRadius, fontSize, fontWeight } from '../../constants/theme';
import { sectionStyles } from '../../constants/sectionStyles';
import {
  getAllCards, getDueCards, getCardCount, getDueCardCount,
  deleteCard, updateCardNotes, getDueRangeGroups,
} from '../../lib/database';
import type { LearningCard } from '../../lib/database/cards';
import type { RangeGroup } from '../../lib/database/cards';

export default function ReviewScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ videoId?: string; type?: 'word' | 'sentence' }>();
  const videoFilter = params.videoId;
  const typeFilter = params.type;
  const filtered = Boolean(videoFilter);

  const [cards, setCards] = useState<LearningCard[]>([]);
  const [groups, setGroups] = useState<Array<RangeGroup & { dueAt: number | null }>>([]);
  const [dueCount, setDueCount] = useState(0);
  const [totalCount, setTotalCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [isPullRefreshing, setIsPullRefreshing] = useState(false);

  const refresh = useCallback(async () => {
    try {
      if (filtered && videoFilter) {
        const { getCardsByVideo, getDueCardCountByVideo } = await import('../../lib/database');
        const [all, dueN] = await Promise.all([
          getCardsByVideo(videoFilter, typeFilter, 500),
          getDueCardCountByVideo(videoFilter, typeFilter),
        ]);
        setCards(all);
        setGroups([]);
        setDueCount(dueN);
        setTotalCount(all.length);
      } else {
        const [all, dueGroups, dueN, totalN] = await Promise.all([
          getAllCards(),
          getDueRangeGroups({ type: typeFilter ?? 'sentence', limit: 500 }),
          getDueCardCount(),
          getCardCount(),
        ]);
        setCards(all);
        setGroups(dueGroups);
        setDueCount(dueGroups.length);
        setTotalCount(totalN);
      }
    } finally {
      setLoading(false);
    }
  }, [filtered, videoFilter, typeFilter]);

  useFocusEffect(useCallback(() => {
    void refresh();
    return () => undefined;
  }, [refresh]));

  const handlePullRefresh = useCallback(async () => {
    setIsPullRefreshing(true);
    try {
      await refresh();
    } finally {
      setIsPullRefreshing(false);
    }
  }, [refresh]);

  const handleStartReview = () => {
    if (dueCount === 0) return;
    // Push to a full-screen route outside (tabs) so the tab bar is hidden
    // during the review session.
    const query: Record<string, string> = {};
    if (videoFilter) query.videoId = videoFilter;
    if (typeFilter) query.type = typeFilter;
    router.push('/review-session', query);
  };

  // ── Edit state (inline modal-style overlay) ────────────────────────
  const [editingCard, setEditingCard] = useState<LearningCard | null>(null);
  const [editNotes, setEditNotes] = useState('');

  const beginEdit = (card: LearningCard) => {
    setEditingCard(card);
    setEditNotes(card.notes ?? '');
  };

  const saveEdit = useCallback(async () => {
    if (!editingCard) return;
    await updateCardNotes(editingCard.id, editNotes);
    setEditingCard(null);
    refresh();
  }, [editingCard, editNotes, refresh]);

  const handleDelete = useCallback((card: LearningCard) => {
    Alert.alert('删除卡片', `确定删除「${card.content}」?`, [
      { text: '取消', style: 'cancel' },
      {
        text: '删除', style: 'destructive',
        onPress: async () => {
          await deleteCard(card.id);
          refresh();
        },
      },
    ]);
  }, [refresh]);

  // V2 — jump straight into group-mode review session.
  const handleOpenGroup = useCallback((g: RangeGroup & { dueAt: number | null }) => {
    const query: Record<string, string> = { groupId: g.groupId };
    router.push('/review-session', query);
  }, [router]);

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
          <RefreshControl refreshing={isPullRefreshing} onRefresh={handlePullRefresh} />
        }
      >
        {/* Page header — matches videos.tsx / AiPracticeHome.tsx style.
            No back arrow: this is a primary tab, not a sub-page. */}
        <View style={sectionStyles.pageHeader}>
          <View style={sectionStyles.pageHeaderInfo}>
            <Text style={sectionStyles.pageTitle}>知识库</Text>
          </View>
        </View>

        {filtered ? (
          <View style={styles.filterBanner}>
            <Text style={styles.filterBannerText} numberOfLines={1}>
              仅显示本视频的{typeFilter === 'word' ? '单词' : typeFilter === 'sentence' ? '句子' : '卡片'}
            </Text>
            <Pressable
              hitSlop={8}
              onPress={() => router.replace('/(tabs)/review')}
              style={styles.filterBannerClear}
            >
              <X size={14} color="#fff" />
              <Text style={styles.filterBannerClearText}>清除</Text>
            </Pressable>
          </View>
        ) : null}

        {/* Stats + CTA section */}
        <View style={styles.statsSection}>
          <View style={styles.statsRow}>
            <View style={styles.statBox}>
              <Text style={styles.statNum}>{dueCount}</Text>
              <Text style={styles.statLabel}>今日到期</Text>
            </View>
            <View style={styles.statBox}>
              <Text style={styles.statNum}>{totalCount}</Text>
              <Text style={styles.statLabel}>总卡数</Text>
            </View>
          </View>
          <Pressable
            style={[styles.startBtn, dueCount === 0 && styles.startBtnDisabled]}
            onPress={handleStartReview}
            disabled={dueCount === 0}
          >
            <BookOpen size={18} color="#fff" />
            <Text style={styles.startBtnText}>
              {dueCount === 0 ? '今天没有要复习的' : `开始复习 (${dueCount})`}
            </Text>
          </Pressable>
        </View>

        {/* Card list section */}
        <View style={styles.listSection}>
          <View style={sectionStyles.sectionHeaderRow}>
            <Text style={sectionStyles.sectionTitle}>{filtered ? '本视频的卡片' : '全部卡片'}</Text>
          </View>
          {loading ? (
            <ActivityIndicator size="large" color={colors.text.primary} style={{ marginTop: 40 }} />
          ) : cards.length === 0 ? (
            <EmptyState />
          ) : (
            <>
              {/* V2 — collapse N contiguous cards in the same range group
                  into one row so review treats them as a single unit. */}
              {groups.map((g) => (
                <GroupRow
                  key={`g_${g.groupId}`}
                  group={g}
                  onEdit={beginEdit}
                  onDelete={handleDelete}
                  onOpen={handleOpenGroup}
                />
              ))}
              {cards
                .filter((c) => !c.videoContext?.rangeGroupId)
                .map((c) => (
                  <CardRow
                    key={c.id}
                    card={c}
                    onEdit={beginEdit}
                    onDelete={handleDelete}
                  />
                ))}
            </>
          )}
        </View>
      </ScrollView>

      {editingCard ? (
        <EditCardOverlay
          content={editingCard.content}
          translation={editingCard.translation}
          notes={editNotes}
          onChangeNotes={setEditNotes}
          onSave={saveEdit}
          onCancel={() => setEditingCard(null)}
        />
      ) : null}
    </View>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Edit overlay (inline modal)
// ─────────────────────────────────────────────────────────────────────

function EditCardOverlay({
  content, translation, notes, onChangeNotes, onSave, onCancel,
}: {
  content: string;
  translation: string;
  notes: string;
  onChangeNotes: (s: string) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  return (
    <View style={styles.editOverlay}>
      <View style={styles.editSheet}>
        <View style={styles.editHeader}>
          <Pressable onPress={onCancel} hitSlop={8}>
            <X size={22} color={colors.text.primary} />
          </Pressable>
          <Text style={styles.editHeaderTitle}>编辑笔记</Text>
          <Pressable onPress={onSave} hitSlop={8}>
            <Check size={22} color={colors.text.primary} />
          </Pressable>
        </View>
        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 20 }}>
          <View style={styles.editField}>
            <Text style={styles.editFieldLabel}>内容（不可改）</Text>
            <View style={styles.editFieldBox}><Text style={styles.editFieldText}>{content}</Text></View>
          </View>
          <View style={styles.editField}>
            <Text style={styles.editFieldLabel}>翻译（不可改）</Text>
            <View style={styles.editFieldBox}><Text style={styles.editFieldText}>{translation || '(空)'}</Text></View>
          </View>
          <View style={styles.editField}>
            <Text style={styles.editFieldLabel}>笔记（可改）</Text>
            <TextInput
              style={styles.editInput}
              value={notes}
              onChangeText={onChangeNotes}
              multiline
              placeholder="个人笔记…"
              placeholderTextColor={colors.text.tertiary}
            />
          </View>
        </ScrollView>
      </View>
    </View>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Card row
// ─────────────────────────────────────────────────────────────────────

function CardRow({
  card, onEdit, onDelete,
}: {
  card: LearningCard;
  onEdit: (c: LearningCard) => void;
  onDelete: (c: LearningCard) => void;
}) {
  const due = card.due;
  const showTranslation = !(card.source === 'ai_practice' && card.type === 'sentence');
  const swipeRef = useRef<Swipeable>(null);
  const thumbUri = card.videoContext?.thumbUri;
  const coverUri = card.videoContext?.coverUri;
  const heroUri = thumbUri ?? coverUri ?? null;

  const renderRightActions = () => (
    <View style={styles.swipeActions}>
      <Pressable
        style={[styles.swipeAction, styles.swipeEdit]}
        onPress={() => { swipeRef.current?.close(); onEdit(card); }}
      >
        <Edit3 size={18} color="#fff" />
      </Pressable>
      <Pressable
        style={[styles.swipeAction, styles.swipeDelete]}
        onPress={() => { swipeRef.current?.close(); onDelete(card); }}
      >
        <Trash2 size={18} color="#fff" />
      </Pressable>
    </View>
  );

  return (
    <Swipeable ref={swipeRef} renderRightActions={renderRightActions} overshootRight={false}>
      <View style={styles.row}>
        <View style={{ flex: 1 }}>
          <View style={styles.rowMetaRow}>
            <Text style={styles.rowType}>{card.type === 'word' ? '单词' : '句子'}</Text>
            <View style={styles.sourceTag}>
              {card.source === 'video'
                ? <Video size={10} color={colors.text.tertiary} />
                : <MessageCircle size={10} color={colors.text.tertiary} />
              }
              <Text style={styles.sourceTagText}>
                {card.source === 'video' ? '视频' : '陪练'}
              </Text>
            </View>
            {typeof due === 'number' ? (
              <Text style={styles.rowDue}>{formatDueRelative(due)}</Text>
            ) : null}
          </View>
          <Text style={styles.rowContent} numberOfLines={2}>{card.content}</Text>
          {showTranslation ? (
            <Text style={styles.rowTranslation} numberOfLines={1}>
              {card.translation || '(未填翻译)'}
            </Text>
          ) : null}
        </View>
        {heroUri ? (
          <Image source={{ uri: heroUri }} style={styles.rowThumb} resizeMode="cover" />
        ) : null}
      </View>
    </Swipeable>
  );
}

// V2 — one row per range group. Same swipe-to-edit/delete as CardRow,
// but the row represents N sentences and the content preview joins the
// first sentence with "…(N-1 more)". Tapping the row jumps straight to
// the group-mode review session.
function GroupRow({
  group, onEdit, onDelete, onOpen,
}: {
  group: RangeGroup & { dueAt: number | null };
  onEdit: (c: LearningCard) => void;
  onDelete: (c: LearningCard) => void;
  onOpen: (g: RangeGroup & { dueAt: number | null }) => void;
}) {
  const due = group.dueAt;
  const first = group.cards[0];
  const showTranslation = !(first.source === 'ai_practice' && first.type === 'sentence');
  const swipeRef = useRef<Swipeable>(null);
  const thumbUri = first.videoContext?.thumbUri;
  const coverUri = first.videoContext?.coverUri;
  const heroUri = thumbUri ?? coverUri ?? null;
  const n = group.cards.length;
  const isRangeGroup = n > 1;
  const previewContent = isRangeGroup
    ? `${first.content} · 等 ${n} 句`
    : first.content;

  const renderRightActions = () => (
    <View style={styles.swipeActions}>
      <Pressable
        style={[styles.swipeAction, styles.swipeEdit]}
        onPress={() => { swipeRef.current?.close(); onEdit(first); }}
      >
        <Edit3 size={18} color="#fff" />
      </Pressable>
      <Pressable
        style={[styles.swipeAction, styles.swipeDelete]}
        onPress={() => { swipeRef.current?.close(); onDelete(first); }}
      >
        <Trash2 size={18} color="#fff" />
      </Pressable>
    </View>
  );

  return (
    <Swipeable ref={swipeRef} renderRightActions={renderRightActions} overshootRight={false}>
      <Pressable
        style={[styles.row, isRangeGroup && styles.rowGroup]}
        onPress={() => onOpen(group)}
      >
        <View style={{ flex: 1 }}>
          <View style={styles.rowMetaRow}>
            <Text style={styles.rowType}>
              {isRangeGroup ? `区间 ${n} 句` : (first.type === 'word' ? '单词' : '句子')}
            </Text>
            <View style={styles.sourceTag}>
              {first.source === 'video'
                ? <Video size={10} color={colors.text.tertiary} />
                : <MessageCircle size={10} color={colors.text.tertiary} />
              }
              <Text style={styles.sourceTagText}>
                {first.source === 'video' ? '视频' : '陪练'}
              </Text>
            </View>
            {typeof due === 'number' ? (
              <Text style={styles.rowDue}>{formatDueRelative(due)}</Text>
            ) : null}
          </View>
          <Text style={styles.rowContent} numberOfLines={2}>{previewContent}</Text>
          {showTranslation ? (
            <Text style={styles.rowTranslation} numberOfLines={1}>
              {first.translation || '(未填翻译)'}
            </Text>
          ) : null}
        </View>
        {heroUri ? (
          <Image source={{ uri: heroUri }} style={styles.rowThumb} resizeMode="cover" />
        ) : null}
      </Pressable>
    </Swipeable>
  );
}

function formatDueRelative(dueMs: number): string {
  const now = Date.now();
  const diffMs = dueMs - now;
  const diffDays = Math.round(diffMs / (24 * 60 * 60 * 1000));

  if (diffDays === 0) return '今天到期';
  if (diffDays === 1) return '明天到期';
  if (diffDays > 1) return `${diffDays} 天后`;
  if (diffDays === -1) return '昨天到期';
  if (diffDays < -1) return `已过期 ${-diffDays} 天`;
  return '今天到期';
}

function EmptyState() {
  return (
    <View style={styles.empty}>
      <BookOpen size={40} color={colors.text.tertiary} />
      <Text style={styles.emptyTitle}>知识库还空着</Text>
      <Text style={styles.emptyHint}>
        视频里点词 / 句子，或在 AI 陪练里点词 / 句子，手动加入。
      </Text>
    </View>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Styles — sectionHeaderBlock / sectionHeaderRow / sectionTitle mirror
// videos.tsx so all three primary tabs feel consistent.
// ─────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  scroll: { flex: 1 },
  scrollContent: { paddingHorizontal: 20 },

  // Filter banner (when navigated with videoId)
  filterBanner: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    backgroundColor: '#1D4ED8', paddingHorizontal: 14, paddingVertical: 8,
    borderRadius: 10, marginBottom: 12, gap: 8,
  },
  filterBannerText: { color: '#fff', fontSize: 13, fontWeight: '600' as any, flex: 1 },
  filterBannerClear: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    backgroundColor: 'rgba(255,255,255,0.18)',
    paddingHorizontal: 10, paddingVertical: 4, borderRadius: 8,
  },
  filterBannerClearText: { color: '#fff', fontSize: 12, fontWeight: '600' as any },

  // Stats + CTA
  statsSection: { marginBottom: spacing.lg, gap: 12 },
  statsRow: { flexDirection: 'row', gap: 12 },
  statBox: { flex: 1, backgroundColor: colors.surface, padding: 16, borderRadius: 14, alignItems: 'center', borderWidth: 1, borderColor: colors.border.light },
  statNum: { fontSize: 28, fontWeight: '800' as any, color: colors.text.primary },
  statLabel: { fontSize: 12, color: colors.text.tertiary, marginTop: 2 },
  startBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    backgroundColor: colors.text.primary, paddingVertical: 14, borderRadius: 14,
  },
  startBtnDisabled: { backgroundColor: colors.border.light },
  startBtnText: { color: '#fff', fontSize: 15, fontWeight: '700' as any },

  // List section
  listSection: { gap: 12 },

  row: {
    flexDirection: 'row',
    backgroundColor: colors.surface,
    padding: 14,
    borderRadius: 12,
    marginBottom: 8,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: colors.border.light,
  },
  rowGroup: {
    borderColor: '#CBD5E1',
    backgroundColor: '#F8FAFC',
  },
  rowMetaRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  rowType: { fontSize: 10, color: colors.text.tertiary, fontWeight: '700' as any, letterSpacing: 0.5 },
  sourceTag: {
    flexDirection: 'row', alignItems: 'center', gap: 3,
    paddingHorizontal: 6, paddingVertical: 2, borderRadius: 8,
    backgroundColor: colors.background,
  },
  sourceTagText: { fontSize: 10, color: colors.text.tertiary, fontWeight: '600' as any },
  rowDue: { fontSize: 10, color: colors.text.tertiary, fontWeight: '600' as any, marginLeft: 'auto' },
  rowContent: { fontSize: 15, fontWeight: '600' as any, color: colors.text.primary, marginTop: 2 },
  rowTranslation: { fontSize: 13, color: colors.text.secondary, marginTop: 2 },
  rowThumb: { width: 64, height: 40, borderRadius: 6, marginLeft: 12, backgroundColor: colors.background },

  swipeActions: { flexDirection: 'row', alignItems: 'stretch' },
  swipeAction: { width: 64, alignItems: 'center', justifyContent: 'center' },
  swipeEdit: { backgroundColor: '#3B82F6' },
  swipeDelete: { backgroundColor: colors.error },

  empty: { alignItems: 'center', justifyContent: 'center', padding: 40 },
  emptyTitle: { fontSize: 18, fontWeight: '700' as any, color: colors.text.primary, marginTop: 16 },
  emptyHint: { fontSize: 13, color: colors.text.tertiary, marginTop: 8, textAlign: 'center', lineHeight: 20 },

  // Edit overlay
  editOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.45)',
    justifyContent: 'flex-end',
  },
  editSheet: {
    backgroundColor: colors.background,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    height: '85%',
  },
  editHeader: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 20, paddingTop: 16, paddingBottom: 12,
    borderBottomWidth: 1, borderColor: colors.border.light,
  },
  editHeaderTitle: { fontSize: 16, fontWeight: '700' as any, color: colors.text.primary },
  editField: { marginBottom: 16 },
  editFieldLabel: { fontSize: 12, color: colors.text.tertiary, fontWeight: '600' as any, marginBottom: 6, letterSpacing: 0.5 },
  editFieldBox: { backgroundColor: colors.surface, borderRadius: 12, padding: 14, borderWidth: 1, borderColor: colors.border.light },
  editFieldText: { fontSize: 15, color: colors.text.primary },
  editInput: {
    backgroundColor: colors.surface, borderRadius: 12, padding: 14, fontSize: 15,
    color: colors.text.primary, borderWidth: 1, borderColor: colors.border.light,
    minHeight: 80, textAlignVertical: 'top',
  },
});
