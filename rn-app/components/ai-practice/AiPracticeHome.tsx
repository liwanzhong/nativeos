import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  Pressable,
  RefreshControl,
  ActivityIndicator,
  Modal,
} from 'react-native';
import { useRouter, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, Shuffle, Star, X } from 'lucide-react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors, spacing, borderRadius, fontSize, fontWeight } from '../../constants/theme';
import { sectionStyles } from '../../constants/sectionStyles';
import { generateDailyScenariosStream, selectScenario, type ScenarioCard } from '../../lib/ai/scenario-generator';
import {
  buildRecommendedAiTopicItems,
  getAiPracticeFitBand,
  getAiPracticeFitScore,
  isTimestampInHistoryFilter,
  listVideoAiTopicGroups,
  type AiPracticeFitBand,
  type AiPracticeHistoryTimeFilter,
  type RecommendedAiTopicItem,
  type VideoAiTopicGroup,
  type VideoAiTopicItem,
} from '../../lib/ai/ai-practice-hub';
import {
  buildAiPracticeTopicSnapshot,
  listAiPracticeUserMeta,
  markAiPracticeTopicUsed,
  toggleAiPracticeTopicFavorite,
  type AiPracticeTopicSnapshot,
  type AiPracticeUserMetaRecord,
} from '../../lib/ai/ai-practice-user-meta';
import { loadGeneratedUserVideoAiPracticeCards } from '../../lib/content/user-video-ai-practice';

const RECOMMENDED_TOPIC_COUNT = 6;
const RECOMMENDED_TOPIC_CACHE_VERSION = 'v2';

const LEVEL_COLORS: Record<string, { bg: string; text: string }> = {
  A1: { bg: '#DCFCE7', text: '#166534' },
  A2: { bg: '#D1FAE5', text: '#065F46' },
  B1: { bg: '#DBEAFE', text: '#1E40AF' },
  B2: { bg: '#EDE9FE', text: '#5B21B6' },
  C1: { bg: '#FEE2E2', text: '#991B1B' },
  C2: { bg: '#FFE4E6', text: '#BE123C' },
};

const IMMERSIVE_HISTORY_PREFIX = 'npc_immersive_messages_v2__';
const LEGACY_HISTORY_PREFIX = 'npc_messages__';

type PrimaryTabKey = 'topics' | 'history' | 'favorites';
type TopicListSourceFilterKey = 'all' | 'recommended' | 'video';
type VideoTopicLevelFilterKey = AiPracticeFitBand | 'A1' | 'A2' | 'B1' | 'B2' | 'C1' | 'C2';

function normalizeScenarioCard(card: ScenarioCard): ScenarioCard {
  return {
    ...card,
    sourceType: card.sourceType || 'ai_scenario',
  };
}

function stripFallbackScenarios(cards: ScenarioCard[]): ScenarioCard[] {
  return cards.filter((card) => !/^f\d+$/.test(card.id));
}

function mergeUniqueScenarioCards(existing: ScenarioCard[], incoming: ScenarioCard[]) {
  const seenIds = new Set(existing.map((card) => card.id));
  const seenTitles = new Set(existing.map((card) => card.title.trim()));
  const merged = [...existing];

  incoming.forEach((card) => {
    const normalizedTitle = card.title.trim();
    if (seenIds.has(card.id) || seenTitles.has(normalizedTitle)) {
      return;
    }
    seenIds.add(card.id);
    seenTitles.add(normalizedTitle);
    merged.push(card);
  });

  return merged;
}

function pairItems<T>(items: T[]) {
  const rows: Array<[T, T | null]> = [];
  for (let index = 0; index < items.length; index += 2) {
    rows.push([items[index], items[index + 1] ?? null]);
  }
  return rows;
}

function getSourceTypeLabel(value: TopicListSourceFilterKey) {
  if (value === 'recommended') return '推荐话题';
  if (value === 'video') return '跟练话题';
  return '全部来源';
}

function getFitBandLabel(value: AiPracticeFitBand) {
  if (value === 'fit') return '适合我';
  if (value === 'challenge') return '稍有挑战';
  if (value === 'easy') return '偏简单';
  return '全部';
}

function getVideoTopicSortLabel(value: 'fit' | 'recent') {
  if (value === 'recent') return '最近使用';
  return '最适合我';
}

function getTopicFitBandFromRecord(record: AiPracticeUserMetaRecord, userLevel: string) {
  return getAiPracticeFitBand(record.level, userLevel);
}

function topicSnapshotFromRecommended(item: RecommendedAiTopicItem) {
  return item.snapshot;
}

function topicSnapshotFromVideo(item: VideoAiTopicItem) {
  return item.snapshot;
}

function formatMetaTimestamp(timestamp?: number) {
  if (!timestamp) return '暂无记录';
  const date = new Date(timestamp);
  const month = `${date.getMonth() + 1}`.padStart(2, '0');
  const day = `${date.getDate()}`.padStart(2, '0');
  const hours = `${date.getHours()}`.padStart(2, '0');
  const minutes = `${date.getMinutes()}`.padStart(2, '0');
  return `${month}-${day} ${hours}:${minutes}`;
}

function TopicFavoriteButton({ active, onPress }: { active: boolean; onPress: () => void }) {
  return (
    <Pressable style={styles.favoriteBtn} onPress={onPress}>
      <Star size={16} color={active ? '#F59E0B' : '#94A3B8'} fill={active ? '#FCD34D' : 'transparent'} />
    </Pressable>
  );
}

export function AiPracticeHome() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const loadingRef = useRef(false);
  const lastLevelRef = useRef<string>('');
  const lastInterestsRef = useRef<string>('');
  // Mirrors videoGroups.length so loadVideoTopics can read it without
  // making the callback depend on the array length (which would rebuild
  // the callback every render and tear down useFocusEffect).
  const hasVideoGroupsRef = useRef(false);

  const [activeTab, setActiveTab] = useState<PrimaryTabKey>('topics');
  const [recommendedCards, setRecommendedCards] = useState<ScenarioCard[]>([]);
  const [videoGroups, setVideoGroups] = useState<VideoAiTopicGroup[]>([]);
  const [userLevel, setUserLevel] = useState('B1');
  const [isRecommendedLoading, setIsRecommendedLoading] = useState(false);
  const [isVideoLoading, setIsVideoLoading] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isPullRefreshing, setIsPullRefreshing] = useState(false);
  const [selectedFitBand, setSelectedFitBand] = useState<VideoTopicLevelFilterKey>('fit');
  const [selectedVideoCategories, setSelectedVideoCategories] = useState<string[]>([]);
  const [draftVideoCategories, setDraftVideoCategories] = useState<string[]>([]);
  const [selectedVideoTopicSort, setSelectedVideoTopicSort] = useState<'fit' | 'recent'>('fit');
  const [isVideoSortMenuOpen, setIsVideoSortMenuOpen] = useState(false);
  const [isVideoSceneSheetOpen, setIsVideoSceneSheetOpen] = useState(false);
  const [selectedHistoryTime, setSelectedHistoryTime] = useState<AiPracticeHistoryTimeFilter>('month');
  const [selectedHistorySource, setSelectedHistorySource] = useState<TopicListSourceFilterKey>('all');
  const [selectedFavoriteSource, setSelectedFavoriteSource] = useState<TopicListSourceFilterKey>('all');
  const [selectedFavoriteFit, setSelectedFavoriteFit] = useState<AiPracticeFitBand>('all');
  const [userMetaMap, setUserMetaMap] = useState<Record<string, AiPracticeUserMetaRecord>>({});

  const loadMeta = useCallback(async () => {
    const items = await listAiPracticeUserMeta();
    setUserMetaMap(Object.fromEntries(items.map((item) => [item.topicId, item])));
  }, []);

  const loadRecommended = useCallback(async (force: boolean = false, excludeTitles?: string[]) => {
    if (loadingRef.current) {
      return;
    }
    try {
      loadingRef.current = true;
      const AsyncStorage = (await import('@react-native-async-storage/async-storage')).default;
      const level = (await AsyncStorage.getItem('user_level')) || 'B1';
      const interestsRaw = await AsyncStorage.getItem('user_interests') ?? '[]';
      const interests: string[] = JSON.parse(interestsRaw);
      const today = new Date().toISOString().slice(0, 10);
      const cacheKey = `daily_scenarios__${today}__${level}__${interestsRaw}__${RECOMMENDED_TOPIC_CACHE_VERSION}`;
      const levelChanged = level !== lastLevelRef.current;
      const interestsChanged = interestsRaw !== lastInterestsRef.current;

      setUserLevel(level);

      if (!force && !levelChanged && !interestsChanged && recommendedCards.length > 0) {
        return;
      }

      lastLevelRef.current = level;
      lastInterestsRef.current = interestsRaw;

      if (!excludeTitles || excludeTitles.length === 0) {
        const cached = await AsyncStorage.getItem(cacheKey);
        if (cached) {
          try {
            const parsed: ScenarioCard[] = JSON.parse(cached);
            const cachedUsable = stripFallbackScenarios(parsed).map(normalizeScenarioCard);
            if (cachedUsable.length >= RECOMMENDED_TOPIC_COUNT) {
              setRecommendedCards(cachedUsable.slice(0, RECOMMENDED_TOPIC_COUNT));
              return;
            }
            await AsyncStorage.removeItem(cacheKey);
          } catch {
          }
        }
      }

      const allKeys = await AsyncStorage.getAllKeys();
      const staleKeys = allKeys.filter((key) => key.startsWith('daily_scenarios__') && key !== cacheKey);
      if (staleKeys.length > 0) {
        await AsyncStorage.multiRemove(staleKeys);
      }

      setIsRecommendedLoading(true);
      setRecommendedCards([]);
      let usable: ScenarioCard[] = [];
      let nextExcludeTitles = [...(excludeTitles ?? [])];

      for (let attempt = 0; attempt < 3 && usable.length < RECOMMENDED_TOPIC_COUNT; attempt += 1) {
        const remainingCount = RECOMMENDED_TOPIC_COUNT - usable.length;
        const finalScenarios = await generateDailyScenariosStream(
          { userLevel: level as any, interests, count: remainingCount, excludeTitles: nextExcludeTitles },
          (card) => {
            const merged = mergeUniqueScenarioCards(usable, [normalizeScenarioCard(card)]);
            if (merged.length !== usable.length) {
              usable = merged;
              nextExcludeTitles = Array.from(new Set([...nextExcludeTitles, card.title]));
              setRecommendedCards([...usable]);
            }
          },
        );

        usable = mergeUniqueScenarioCards(usable, stripFallbackScenarios(finalScenarios).map(normalizeScenarioCard));
        nextExcludeTitles = Array.from(new Set([...nextExcludeTitles, ...usable.map((item) => item.title)]));
      }

      usable = usable.slice(0, RECOMMENDED_TOPIC_COUNT);
      setRecommendedCards(usable.length === RECOMMENDED_TOPIC_COUNT ? usable : []);
      if (usable.length === RECOMMENDED_TOPIC_COUNT) {
        await AsyncStorage.setItem(cacheKey, JSON.stringify(usable));
      }
    } catch {
      setRecommendedCards([]);
    } finally {
      setIsRecommendedLoading(false);
      loadingRef.current = false;
    }
  }, [recommendedCards.length]);

  // Mirror of the user's "我的合集" → official series id set. We
  // re-load on every focus (cheap — single Supabase SELECT) so
  // the topics section stays in sync with pick/unpick from the
  // videos tab. Self-built user_collections don't contribute —
  // they have no manifest, so no AI practice topics — and the
  // union with pickedSeriesIds is the "我的合集" filter for this
  // section.
  const [pickedSeriesIds, setPickedSeriesIds] = useState<Set<string>>(new Set());

  const loadPickedSeriesIds = useCallback(async () => {
    try {
      const { listMyPickedSeriesIds } = await import('../../lib/content/user-picked-series');
      const ids = await listMyPickedSeriesIds();
      setPickedSeriesIds(ids);
    } catch {
      // Treat as "no picks" — the section will just be empty.
      setPickedSeriesIds(new Set());
    }
  }, []);

  const loadVideoTopics = useCallback(async (forceRefresh: boolean = false, levelOverride?: string) => {
    // Don't show the spinner if we already have data. Tab switches
    // would otherwise flicker the loading state even though SQLite
    // gives us the data in <50ms. Pull-to-refresh wants the spinner,
    // so it sets forceRefresh and the call site resets hasVideoGroupsRef
    // first to force a show.
    const hadData = hasVideoGroupsRef.current;
    const showSpinner = !hadData || forceRefresh;
    if (showSpinner) {
      setIsVideoLoading(true);
    }
    try {
      // Filter to only the user's subscribed official collections.
      // After the videos-tab redesign ("我的合集" grid), the AI
      // practice tab is no longer a "show me everything" directory
      // — it surfaces topics derived from the same series the user
      // has curated in their home grid.
      const groups = await listVideoAiTopicGroups(
        levelOverride || userLevel,
        forceRefresh,
        pickedSeriesIds,
      );
      setVideoGroups(groups);
    } catch {
      if (!hadData) setVideoGroups([]);
    } finally {
      if (showSpinner) {
        setIsVideoLoading(false);
      }
    }
  }, [pickedSeriesIds, userLevel]);

  const refreshAll = useCallback(async (forceRefresh: boolean = false) => {
    const AsyncStorage = (await import('@react-native-async-storage/async-storage')).default;
    const level = (await AsyncStorage.getItem('user_level')) || 'B1';
    setUserLevel(level);
    await Promise.all([
      loadRecommended(forceRefresh),
      loadPickedSeriesIds(),
      loadVideoTopics(forceRefresh, level),
      loadMeta(),
    ]);
  }, [loadMeta, loadPickedSeriesIds, loadRecommended, loadVideoTopics]);

  useFocusEffect(useCallback(() => {
    // Tab focus: read from SQLite cache (fast path, <50 ms warm).
    // No background force-refresh — the cache is reliable after the
    // saveSceneInfoCache merge fix, and a force on every focus
    // re-shows the loading spinner and burns 6 OSS round-trips per
    // tab switch. Pull-to-refresh is the explicit escape hatch.
    void refreshAll(false);
  }, [refreshAll]));

  // ── User-video "deep link" highlight ─────────────────────────
  // When the AI 话题 chip on a user-video row deep-links here
  // (router.push with `videoId` / `videoTitle` params), the home
  // tab should surface the freshly generated cards right at the
  // top so the user can pick a topic without scrolling. The
  // highlight is a self-contained section above the regular
  // 推荐 / 视频 topics; it lives only as long as the user keeps
  // it open (tapping the close button clears it AND strips the
  // params so a back-and-forth doesn't re-open it).
  const searchParams = useLocalSearchParams<{ videoId?: string; videoTitle?: string }>();
  const highlightVideoId = typeof searchParams.videoId === 'string' ? searchParams.videoId : null;
  const highlightVideoTitleParam = typeof searchParams.videoTitle === 'string' ? searchParams.videoTitle : null;
  const [userVideoHighlight, setUserVideoHighlight] = useState<{
    entryId: string;
    title: string;
    items: VideoAiTopicItem[];
  } | null>(null);
  useEffect(() => {
    let cancelled = false;
    if (!highlightVideoId) {
      setUserVideoHighlight(null);
      return;
    }
    (async () => {
      try {
        const cards = await loadGeneratedUserVideoAiPracticeCards(highlightVideoId);
        if (cancelled) return;
        // Build a title fallback chain: param → entry lookup → id.
        let title = highlightVideoTitleParam || '';
        if (!title) {
          try {
            const { getUserVideoEntryById } = await import('../../lib/content/user-videos');
            const entry = await getUserVideoEntryById(highlightVideoId);
            if (entry?.title) title = entry.title;
          } catch {
            // fall through
          }
        }
        if (!title) title = highlightVideoId;
        if (cards.length === 0) {
          // No cards saved yet (e.g. the user just kicked off
          // generation; chip shows pending → navigating here
          // before the run completes is possible). Surface an
          // empty highlight with a friendly message rather than
          // hiding it.
          setUserVideoHighlight({ entryId: highlightVideoId, title, items: [] });
          return;
        }
        const items: VideoAiTopicItem[] = cards.map((card) => {
          const snapshot = buildAiPracticeTopicSnapshot({
            card,
            origin: 'video',
            sourceType: 'imported_video',
            sourceLabel: '导入视频',
            sourceId: highlightVideoId,
            sceneTitle: title,
          });
          return {
            topicId: snapshot.topicId,
            card: snapshot.card,
            snapshot,
            fitBand: getAiPracticeFitBand(card.level, userLevel),
            fitScore: getAiPracticeFitScore(card.level, userLevel),
          };
        });
        setUserVideoHighlight({ entryId: highlightVideoId, title, items });
      } catch {
        if (!cancelled) {
          setUserVideoHighlight(null);
        }
      }
    })();
    return () => { cancelled = true; };
  }, [highlightVideoId, highlightVideoTitleParam, userLevel]);

  const handlePullRefresh = useCallback(async () => {
    setIsPullRefreshing(true);
    try {
      // Pull-to-refresh = "give me the latest from the server". Bypass
      // SQLite cache and force re-fetch the OSS manifest + per-scene
      // info. New data lands in SQLite for the next cold start.
      await refreshAll(true);
    } finally {
      setIsPullRefreshing(false);
    }
  }, [refreshAll]);

  const confirmRefresh = useCallback(async () => {
    setIsRefreshing(true);
    try {
      const AsyncStorage = (await import('@react-native-async-storage/async-storage')).default;
      const allKeys = await AsyncStorage.getAllKeys();
      const cacheKeys = allKeys.filter((key) => key.startsWith('daily_scenarios__'));
      if (cacheKeys.length > 0) {
        await AsyncStorage.multiRemove(cacheKeys);
      }
      const currentAiIds = recommendedCards.map((item) => item.id).filter((id) => id.startsWith('ai-'));
      const chatKeys = currentAiIds.flatMap((id) => [
        `${IMMERSIVE_HISTORY_PREFIX}ai_scenario__${id}`,
        `${IMMERSIVE_HISTORY_PREFIX}video_scene__${id}`,
        `${IMMERSIVE_HISTORY_PREFIX}static_scenario__${id}`,
        `${LEGACY_HISTORY_PREFIX}${id}`,
      ]);
      if (chatKeys.length > 0) {
        await AsyncStorage.multiRemove(chatKeys);
      }
      lastLevelRef.current = '';
      lastInterestsRef.current = '';
      await refreshAll(true);
    } finally {
      setIsRefreshing(false);
    }
  }, [recommendedCards, refreshAll]);

  const recommendedItems = useMemo(() => buildRecommendedAiTopicItems(recommendedCards, userLevel), [recommendedCards, userLevel]);
  const recommendedRows = useMemo(() => pairItems(recommendedItems), [recommendedItems]);
  const videoTopicItems = useMemo(() => videoGroups.flatMap((group) => group.topics.map((topic) => ({
    ...topic,
    sceneId: group.sceneId,
    sceneTitle: group.sceneTitle,
  }))), [videoGroups]);
  const videoCategories = useMemo(() => Array.from(new Set(videoTopicItems.map((item) => item.card.category).filter(Boolean))), [videoTopicItems]);
  const isRefreshingRecommendations = isRecommendedLoading || isRefreshing;

  useEffect(() => {
    setSelectedVideoCategories((prev) => prev.filter((item) => videoCategories.includes(item)));
    setDraftVideoCategories((prev) => prev.filter((item) => videoCategories.includes(item)));
  }, [videoCategories]);

  // Keep hasVideoGroupsRef in sync with videoGroups.length so
  // loadVideoTopics (a stable callback) can decide whether to show the
  // spinner without depending on the array length itself.
  useEffect(() => {
    hasVideoGroupsRef.current = videoGroups.length > 0;
  }, [videoGroups.length]);

  const filteredVideoTopics = useMemo(() => {
    const next = videoTopicItems.filter((topic) => {
      if (selectedVideoCategories.length > 0 && !selectedVideoCategories.includes(topic.card.category)) {
        return false;
      }
      if (selectedFitBand !== 'all') {
        if (['A1', 'A2', 'B1', 'B2', 'C1', 'C2'].includes(selectedFitBand)) {
          if (topic.card.level !== selectedFitBand) {
            return false;
          }
        } else if (topic.fitBand !== selectedFitBand) {
          return false;
        }
      }
      return true;
    });
    return next.sort((a, b) => {
      if (selectedVideoTopicSort === 'recent') {
        const aTime = userMetaMap[a.topicId]?.lastUsedAt ?? 0;
        const bTime = userMetaMap[b.topicId]?.lastUsedAt ?? 0;
        return bTime - aTime;
      }
      return b.fitScore - a.fitScore;
    });
  }, [selectedFitBand, selectedVideoCategories, selectedVideoTopicSort, userMetaMap, videoTopicItems]);
  const filteredVideoTopicRows = useMemo(() => pairItems(filteredVideoTopics), [filteredVideoTopics]);

  const historyItems = useMemo(() => Object.values(userMetaMap)
    .filter((item) => typeof item.lastUsedAt === 'number')
    .filter((item) => isTimestampInHistoryFilter(item.lastUsedAt, selectedHistoryTime))
    .filter((item) => selectedHistorySource === 'all' ? true : selectedHistorySource === 'recommended' ? item.origin === 'recommended' : item.origin === 'video')
    .sort((a, b) => (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0)), [selectedHistorySource, selectedHistoryTime, userMetaMap]);
  const historyRows = useMemo(() => pairItems(historyItems), [historyItems]);

  const favoriteItems = useMemo(() => Object.values(userMetaMap)
    .filter((item) => item.isFavorite)
    .filter((item) => selectedFavoriteSource === 'all' ? true : selectedFavoriteSource === 'recommended' ? item.origin === 'recommended' : item.origin === 'video')
    .filter((item) => selectedFavoriteFit === 'all' ? true : getTopicFitBandFromRecord(item, userLevel) === selectedFavoriteFit)
    .sort((a, b) => (b.favoritedAt ?? 0) - (a.favoritedAt ?? 0)), [selectedFavoriteFit, selectedFavoriteSource, userLevel, userMetaMap]);
  const favoriteRows = useMemo(() => pairItems(favoriteItems), [favoriteItems]);

  const openAiTopic = useCallback(async (snapshot: AiPracticeTopicSnapshot) => {
    await markAiPracticeTopicUsed(snapshot);
    setUserMetaMap((prev) => ({
      ...prev,
      [snapshot.topicId]: {
        ...(prev[snapshot.topicId] ?? {}),
        ...snapshot,
        isFavorite: prev[snapshot.topicId]?.isFavorite,
        favoritedAt: prev[snapshot.topicId]?.favoritedAt,
        lastUsedAt: Date.now(),
        useCount: (prev[snapshot.topicId]?.useCount ?? 0) + 1,
        updatedAt: Date.now(),
      },
    }));
    await selectScenario(snapshot.card);
    router.push(`/scenario/immersive/${snapshot.card.id}`);
  }, [router]);

  const toggleFavorite = useCallback(async (snapshot: AiPracticeTopicSnapshot) => {
    const next = await toggleAiPracticeTopicFavorite(snapshot);
    setUserMetaMap((prev) => ({
      ...prev,
      [snapshot.topicId]: next,
    }));
  }, []);

  const stickyIndices = activeTab === 'topics' ? [1, 3] : [1];

  return (
    <View style={styles.container}>
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={[styles.scrollContent, { paddingBottom: Math.max(120, insets.bottom + 96) }]}
        showsVerticalScrollIndicator={false}
        stickyHeaderIndices={stickyIndices}
        refreshControl={<RefreshControl refreshing={isPullRefreshing} onRefresh={handlePullRefresh} />}
      >
        <View style={sectionStyles.pageHeader}>
          <View style={sectionStyles.pageHeaderInfo}>
            <Text style={sectionStyles.pageTitle}>AI陪练</Text>
          </View>
        </View>

        {/* User-video deep-link highlight.
            Renders ONLY when a row's AI 话题 chip deep-linked
            into this tab with `videoId`. Tapping the close
            button clears the local state AND strips the params
            so a back-and-forth doesn't re-open it. Auto-switches
            to the "话题" tab (deep link usually follows a fresh
            generation; the user is here to pick a topic, not to
            browse history). */}
        {userVideoHighlight ? (
          <View style={styles.userVideoHighlight}>
            <View style={styles.userVideoHighlightHeader}>
              <View style={styles.userVideoHighlightHeaderInfo}>
                <Text style={styles.userVideoHighlightEyebrow}>来自视频</Text>
                <Text style={styles.userVideoHighlightTitle} numberOfLines={1}>
                  《{userVideoHighlight.title}》
                </Text>
              </View>
              <Pressable
                hitSlop={8}
                onPress={() => {
                  setUserVideoHighlight(null);
                  // Strip the params so re-focusing the tab
                  // (e.g. via tab-bar tap) doesn't re-mount the
                  // highlight. router.setParams is the official
                  // expo-router escape hatch for this.
                  try {
                    router.setParams({ videoId: undefined, videoTitle: undefined });
                  } catch {
                    // Older expo-router versions don't expose
                    // setParams on the router instance; fall
                    // through silently — the highlight won't
                    // re-open because the next focus will
                    // re-read params and they were never set
                    // back. The user can re-trigger it from
                    // the source row if they want.
                  }
                }}
                style={styles.userVideoHighlightClose}
              >
                <X size={16} color={colors.text.secondary} />
              </Pressable>
            </View>
            {userVideoHighlight.items.length === 0 ? (
              <View style={styles.userVideoHighlightEmpty}>
                <Text style={styles.userVideoHighlightEmptyText}>
                  这个视频的 AI 话题还没生成,可以在视频跟练页点 AI 话题 chip 触发生成。
                </Text>
              </View>
            ) : (
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={styles.userVideoHighlightScroll}
              >
                {userVideoHighlight.items.map((item) => (
                  <Pressable
                    key={`uv-highlight-${item.topicId}`}
                    style={styles.userVideoHighlightCard}
                    onPress={() => void openAiTopic(item.snapshot)}
                  >
                    <View style={styles.recommendedCardTopRow}>
                      <Text style={styles.recommendedEmoji}>{item.card.icon}</Text>
                      <View style={[styles.cardMetaCompact, styles.recommendedCardMetaRow]}>
                        <View style={[styles.levelBadge, { backgroundColor: (LEVEL_COLORS[item.card.level] || LEVEL_COLORS.B1).bg }]}>
                          <Text style={[styles.levelText, { color: (LEVEL_COLORS[item.card.level] || LEVEL_COLORS.B1).text }]}>{item.card.level}</Text>
                        </View>
                        <Text style={styles.categoryText} numberOfLines={1}>{item.card.category}</Text>
                      </View>
                    </View>
                    <Text style={styles.recommendedCardTitle} numberOfLines={2}>{item.card.title}</Text>
                    <Text style={styles.recommendedCardDesc} numberOfLines={1}>
                      {item.card.descZh || item.card.desc}
                    </Text>
                  </Pressable>
                ))}
              </ScrollView>
            )}
          </View>
        ) : null}

        <View style={styles.primaryStickyWrap}>
          <View style={styles.primaryTabRow}>
            {([
              ['topics', '话题'],
              ['history', '历史'],
              ['favorites', '收藏'],
            ] as const).map(([key, label]) => {
              const active = activeTab === key;
              return (
                <Pressable key={`ai-tab-${key}`} style={[styles.primaryTabChip, active && styles.primaryTabChipActive]} onPress={() => setActiveTab(key)}>
                  <Text style={[styles.primaryTabText, active && styles.primaryTabTextActive]}>{label}</Text>
                </Pressable>
              );
            })}
          </View>
        </View>

        {activeTab === 'topics' ? (
          <>
            <View style={sectionStyles.sectionBlock}>
              <View style={sectionStyles.sectionHeaderRow}>
                <View style={sectionStyles.sectionHeaderInfo}>
                  <Text style={sectionStyles.sectionTitle}>推荐话题</Text>
                </View>
                <View style={sectionStyles.sectionHeaderActions}>
                  <Pressable
                    style={[styles.headerIconBtn, isRefreshingRecommendations && styles.headerIconBtnDisabled]}
                    onPress={() => void confirmRefresh()}
                    disabled={isRefreshingRecommendations}
                  >
                    {isRefreshingRecommendations ? <ActivityIndicator size="small" color={colors.primary} /> : <Shuffle size={18} color={colors.text.secondary} />}
                  </Pressable>
                </View>
              </View>
              {recommendedRows.length === 0 ? (
                <View style={styles.emptySectionState}>
                  <Text style={styles.emptySectionText}>推荐话题正在准备中，稍后会自动出现在这里。</Text>
                </View>
              ) : recommendedRows.map(([left, right], rowIndex) => (
                <View key={`recommended-row-${rowIndex}`} style={styles.recommendedGridRow}>
                  {[left, right].map((item, columnIndex) => item ? (
                    <Pressable key={`${item.topicId}-${columnIndex}`} style={styles.recommendedCard} onPress={() => void openAiTopic(topicSnapshotFromRecommended(item))}>
                      <View style={styles.recommendedCardTopRow}>
                        <Text style={styles.recommendedEmoji}>{item.card.icon}</Text>
                        <View style={[styles.cardMetaCompact, styles.recommendedCardMetaRow]}>
                          <View style={[styles.levelBadge, { backgroundColor: (LEVEL_COLORS[item.card.level] || LEVEL_COLORS.B1).bg }]}> 
                            <Text style={[styles.levelText, { color: (LEVEL_COLORS[item.card.level] || LEVEL_COLORS.B1).text }]}>{item.card.level}</Text>
                          </View>
                          <Text style={styles.categoryText} numberOfLines={1}>{item.card.category}</Text>
                        </View>
                        <TopicFavoriteButton
                          active={Boolean(userMetaMap[item.topicId]?.isFavorite)}
                          onPress={() => void toggleFavorite(topicSnapshotFromRecommended(item))}
                        />
                      </View>
                      <Text style={styles.recommendedCardTitle} numberOfLines={2}>{item.card.title}</Text>
                      <Text style={styles.recommendedCardDesc} numberOfLines={1}>{item.card.descZh || item.card.desc}</Text>
                    </Pressable>
                  ) : <View key={`recommended-empty-${rowIndex}-${columnIndex}`} style={styles.recommendedCardPlaceholder} />)}
                </View>
              ))}
            </View>

            <View style={styles.secondaryStickyWrap}>
              <View style={sectionStyles.sectionHeaderRow}>
                <View style={sectionStyles.sectionHeaderInfo}>
                  <Text style={sectionStyles.sectionTitle}>跟练话题</Text>
                </View>
                <View style={sectionStyles.sectionHeaderActions}>
                  <Pressable
                    style={[styles.sceneFilterBtn, selectedVideoCategories.length > 0 && styles.sceneFilterBtnActive]}
                    onPress={() => {
                      setIsVideoSortMenuOpen(false);
                      setDraftVideoCategories(selectedVideoCategories);
                      setIsVideoSceneSheetOpen(true);
                    }}
                  >
                    <Text style={[styles.sceneFilterBtnText, selectedVideoCategories.length > 0 && styles.sceneFilterBtnTextActive]}>
                      {selectedVideoCategories.length > 0 ? `场景筛选(${selectedVideoCategories.length})` : '场景筛选'}
                    </Text>
                  </Pressable>
                <View style={styles.sortMenuWrap}>
                  {isVideoSortMenuOpen ? <Pressable style={styles.sortMenuBackdrop} onPress={() => setIsVideoSortMenuOpen(false)} /> : null}
                  <Pressable style={styles.sortMenuTrigger} onPress={() => setIsVideoSortMenuOpen((prev) => !prev)}>
                    <Text style={styles.sortMenuTriggerText}>{getVideoTopicSortLabel(selectedVideoTopicSort)}</Text>
                    <ChevronDown size={14} color={colors.text.secondary} />
                  </Pressable>
                  {isVideoSortMenuOpen ? (
                    <View style={styles.sortMenuDropdown}>
                      {([
                        ['fit', '最适合我'],
                        ['recent', '最近使用'],
                      ] as const).map(([value, label]) => {
                        const active = selectedVideoTopicSort === value;
                        return (
                          <Pressable
                            key={`video-topic-sort-${value}`}
                            style={[styles.sortMenuOption, active && styles.sortMenuOptionActive]}
                            onPress={() => {
                              setSelectedVideoTopicSort(value);
                              setIsVideoSortMenuOpen(false);
                            }}
                          >
                            <Text style={[styles.sortMenuOptionText, active && styles.sortMenuOptionTextActive]}>{label}</Text>
                          </Pressable>
                        );
                      })}
                    </View>
                  ) : null}
                </View>
                </View>
              </View>
              <View style={styles.filterGroup}>
                <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.filterScrollContent}>
                  {([
                    ['fit', '适合我'],
                    ['challenge', '稍有挑战'],
                    ['all', '全部'],
                    ['A1', 'A1'],
                    ['A2', 'A2'],
                    ['B1', 'B1'],
                    ['B2', 'B2'],
                    ['C1', 'C1'],
                    ['C2', 'C2'],
                  ] as const).map(([value, label]) => {
                    const active = selectedFitBand === value;
                    return (
                      <Pressable key={`fit-band-${value}`} style={[styles.filterChip, active && styles.filterChipActive]} onPress={() => setSelectedFitBand(value)}>
                        <Text style={[styles.filterChipText, active && styles.filterChipTextActive]}>{label}</Text>
                      </Pressable>
                    );
                  })}
                </ScrollView>
              </View>
            </View>

            <View style={sectionStyles.sectionBlock}>
              {isVideoLoading ? (
                <View style={styles.loadingBanner}>
                  <ActivityIndicator size="small" color={colors.primary} />
                  <Text style={styles.loadingBannerText}>正在整理跟练话题…</Text>
                </View>
              ) : filteredVideoTopics.length === 0 ? (
                <View style={styles.emptySectionState}>
                  <Text style={styles.emptySectionText}>当前筛选下还没有可用的跟练话题。你可以先去视频跟练页生成或打开 AI陪练话题。</Text>
                </View>
              ) : filteredVideoTopicRows.map(([left, right], rowIndex) => (
                <View key={`video-topic-row-${rowIndex}`} style={styles.recommendedGridRow}>
                  {[left, right].map((item, columnIndex) => item ? (
                    <Pressable key={`${item.topicId}-${columnIndex}`} style={styles.recommendedCard} onPress={() => void openAiTopic(topicSnapshotFromVideo(item))}>
                      <View style={styles.recommendedCardTopRow}>
                        <Text style={styles.recommendedEmoji}>{item.card.icon}</Text>
                        <View style={[styles.cardMetaCompact, styles.recommendedCardMetaRow]}>
                          <View style={[styles.levelBadge, { backgroundColor: (LEVEL_COLORS[item.card.level] || LEVEL_COLORS.B1).bg }]}> 
                            <Text style={[styles.levelText, { color: (LEVEL_COLORS[item.card.level] || LEVEL_COLORS.B1).text }]}>{item.card.level}</Text>
                          </View>
                          <Text style={styles.categoryText} numberOfLines={1}>{item.card.category}</Text>
                        </View>
                        <TopicFavoriteButton
                          active={Boolean(userMetaMap[item.topicId]?.isFavorite)}
                          onPress={() => void toggleFavorite(topicSnapshotFromVideo(item))}
                        />
                      </View>
                      <Text style={styles.recommendedCardTitle} numberOfLines={2}>{item.card.title}</Text>
                      <Text style={styles.recommendedCardDesc} numberOfLines={1}>{item.card.descZh || item.card.desc}</Text>
                    </Pressable>
                  ) : <View key={`video-topic-empty-${rowIndex}-${columnIndex}`} style={styles.recommendedCardPlaceholder} />)}
                </View>
              ))}
            </View>
          </>
        ) : activeTab === 'history' ? (
          <View style={sectionStyles.sectionBlock}>
            <View style={styles.filterGroup}>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.filterScrollContent}>
                {([
                  ['today', '今天'],
                  ['week', '本周'],
                  ['month', '本月'],
                  ['older', '更早'],
                ] as const).map(([value, label]) => {
                  const active = selectedHistoryTime === value;
                  return (
                    <Pressable key={`history-time-${value}`} style={[styles.filterChip, active && styles.filterChipActive]} onPress={() => setSelectedHistoryTime(value)}>
                      <Text style={[styles.filterChipText, active && styles.filterChipTextActive]}>{label}</Text>
                    </Pressable>
                  );
                })}
              </ScrollView>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.filterScrollContent}>
                {(['all', 'recommended', 'video'] as const).map((value) => {
                  const active = selectedHistorySource === value;
                  return (
                    <Pressable key={`history-source-${value}`} style={[styles.filterChip, active && styles.filterChipActive]} onPress={() => setSelectedHistorySource(value)}>
                      <Text style={[styles.filterChipText, active && styles.filterChipTextActive]}>{getSourceTypeLabel(value)}</Text>
                    </Pressable>
                  );
                })}
              </ScrollView>
            </View>
            {historyItems.length === 0 ? (
              <View style={styles.emptySectionState}><Text style={styles.emptySectionText}>当前筛选下还没有 AI陪练历史。</Text></View>
            ) : historyRows.map(([left, right], rowIndex) => (
              <View key={`history-row-${rowIndex}`} style={styles.recommendedGridRow}>
                {[left, right].map((item, columnIndex) => item ? (
                  <Pressable key={`${item.topicId}-${columnIndex}`} style={styles.recommendedCard} onPress={() => void openAiTopic(buildAiPracticeTopicSnapshot({
                    card: item.card,
                    origin: item.origin,
                    sourceType: item.sourceType,
                    sourceLabel: item.sourceLabel,
                    sourceId: item.sourceId,
                    sceneTitle: item.sceneTitle,
                    importSourceLabel: item.importSourceLabel,
                  }))}>
                    <View style={styles.recommendedCardTopRow}>
                      <Text style={styles.recommendedEmoji}>{item.card.icon}</Text>
                      <View style={[styles.cardMetaCompact, styles.recommendedCardMetaRow]}>
                        <View style={[styles.levelBadge, { backgroundColor: (LEVEL_COLORS[item.level] || LEVEL_COLORS.B1).bg }]}> 
                          <Text style={[styles.levelText, { color: (LEVEL_COLORS[item.level] || LEVEL_COLORS.B1).text }]}>{item.level}</Text>
                        </View>
                        <Text style={styles.categoryText} numberOfLines={1}>{item.category}</Text>
                      </View>
                      <TopicFavoriteButton active={Boolean(item.isFavorite)} onPress={() => void toggleFavorite(buildAiPracticeTopicSnapshot({
                        card: item.card,
                        origin: item.origin,
                        sourceType: item.sourceType,
                        sourceLabel: item.sourceLabel,
                        sourceId: item.sourceId,
                        sceneTitle: item.sceneTitle,
                        importSourceLabel: item.importSourceLabel,
                      }))} />
                    </View>
                    <Text style={styles.recommendedCardTitle} numberOfLines={2}>{item.title}</Text>
                    <Text style={styles.recommendedCardDesc} numberOfLines={1}>{item.card.descZh || item.card.desc}</Text>
                    <Text style={styles.listTopicMeta}>{formatMetaTimestamp(item.lastUsedAt)}</Text>
                  </Pressable>
                ) : <View key={`history-empty-${rowIndex}-${columnIndex}`} style={styles.recommendedCardPlaceholder} />)}
              </View>
            ))}
          </View>
        ) : (
          <View style={sectionStyles.sectionBlock}>
            <View style={styles.filterGroup}>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.filterScrollContent}>
                {(['all', 'recommended', 'video'] as const).map((value) => {
                  const active = selectedFavoriteSource === value;
                  return (
                    <Pressable key={`favorite-source-${value}`} style={[styles.filterChip, active && styles.filterChipActive]} onPress={() => setSelectedFavoriteSource(value)}>
                      <Text style={[styles.filterChipText, active && styles.filterChipTextActive]}>{getSourceTypeLabel(value)}</Text>
                    </Pressable>
                  );
                })}
              </ScrollView>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.filterScrollContent}>
                {(['all', 'fit', 'challenge'] as const).map((value) => {
                  const active = selectedFavoriteFit === value;
                  return (
                    <Pressable key={`favorite-fit-${value}`} style={[styles.filterChip, active && styles.filterChipActive]} onPress={() => setSelectedFavoriteFit(value)}>
                      <Text style={[styles.filterChipText, active && styles.filterChipTextActive]}>{getFitBandLabel(value)}</Text>
                    </Pressable>
                  );
                })}
              </ScrollView>
            </View>
            {favoriteItems.length === 0 ? (
              <View style={styles.emptySectionState}><Text style={styles.emptySectionText}>当前还没有收藏的 AI陪练话题。</Text></View>
            ) : favoriteRows.map(([left, right], rowIndex) => (
              <View key={`favorite-row-${rowIndex}`} style={styles.recommendedGridRow}>
                {[left, right].map((item, columnIndex) => item ? (
                  <Pressable key={`${item.topicId}-${columnIndex}`} style={styles.recommendedCard} onPress={() => void openAiTopic(buildAiPracticeTopicSnapshot({
                    card: item.card,
                    origin: item.origin,
                    sourceType: item.sourceType,
                    sourceLabel: item.sourceLabel,
                    sourceId: item.sourceId,
                    sceneTitle: item.sceneTitle,
                    importSourceLabel: item.importSourceLabel,
                  }))}>
                    <View style={styles.recommendedCardTopRow}>
                      <Text style={styles.recommendedEmoji}>{item.card.icon}</Text>
                      <View style={[styles.cardMetaCompact, styles.recommendedCardMetaRow]}>
                        <View style={[styles.levelBadge, { backgroundColor: (LEVEL_COLORS[item.level] || LEVEL_COLORS.B1).bg }]}> 
                          <Text style={[styles.levelText, { color: (LEVEL_COLORS[item.level] || LEVEL_COLORS.B1).text }]}>{item.level}</Text>
                        </View>
                        <Text style={styles.categoryText} numberOfLines={1}>{item.category}</Text>
                      </View>
                      <TopicFavoriteButton active={Boolean(item.isFavorite)} onPress={() => void toggleFavorite(buildAiPracticeTopicSnapshot({
                        card: item.card,
                        origin: item.origin,
                        sourceType: item.sourceType,
                        sourceLabel: item.sourceLabel,
                        sourceId: item.sourceId,
                        sceneTitle: item.sceneTitle,
                        importSourceLabel: item.importSourceLabel,
                      }))} />
                    </View>
                    <Text style={styles.recommendedCardTitle} numberOfLines={2}>{item.title}</Text>
                    <Text style={styles.recommendedCardDesc} numberOfLines={1}>{item.card.descZh || item.card.desc}</Text>
                    <Text style={styles.listTopicMeta}>{formatMetaTimestamp(item.favoritedAt)}</Text>
                  </Pressable>
                ) : <View key={`favorite-empty-${rowIndex}-${columnIndex}`} style={styles.recommendedCardPlaceholder} />)}
              </View>
            ))}
          </View>
        )}
      </ScrollView>

      <Modal visible={isVideoSceneSheetOpen} transparent animationType="slide" onRequestClose={() => setIsVideoSceneSheetOpen(false)}>
        <View style={styles.sceneSheetOverlay}>
          <Pressable style={styles.sceneSheetBackdrop} onPress={() => setIsVideoSceneSheetOpen(false)} />
          <View style={styles.sceneSheet}>
            <View style={styles.sceneSheetHandle} />
            <View style={styles.sceneSheetHeader}>
              <Text style={styles.sceneSheetTitle}>场景筛选</Text>
              <View style={styles.sceneSheetHeaderActions}>
                <Pressable onPress={() => {
                  setSelectedVideoCategories(draftVideoCategories);
                  setIsVideoSceneSheetOpen(false);
                }}>
                  <Text style={styles.sceneSheetConfirmText}>确定</Text>
                </Pressable>
                <Pressable onPress={() => setDraftVideoCategories([])}>
                  <Text style={styles.sceneSheetClearText}>清空</Text>
                </Pressable>
                <Pressable onPress={() => setIsVideoSceneSheetOpen(false)}>
                  <X size={18} color={colors.text.secondary} />
                </Pressable>
              </View>
            </View>
            <ScrollView style={styles.sceneSheetScroll} showsVerticalScrollIndicator={false}>
              <View style={styles.sceneSheetOptionsWrap}>
                {videoCategories.map((value) => {
                  const active = draftVideoCategories.includes(value);
                  return (
                    <Pressable
                      key={`scene-filter-${value}`}
                      style={[styles.sceneSheetChip, active && styles.sceneSheetChipActive]}
                      onPress={() => setDraftVideoCategories((prev) => active ? prev.filter((item) => item !== value) : [...prev, value])}
                    >
                      <Text style={[styles.sceneSheetChipText, active && styles.sceneSheetChipTextActive]}>{value}</Text>
                    </Pressable>
                  );
                })}
              </View>
            </ScrollView>
          </View>
        </View>
      </Modal>
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
    gap: 0,
  },
  headerIconBtn: {
    width: 30,
    height: 30,
    borderRadius: borderRadius.full,
    backgroundColor: colors.surfaceSecondary,
    justifyContent: 'center',
    alignItems: 'center',
  },
  headerIconBtnDisabled: {
    opacity: 0.72,
  },
  primaryStickyWrap: {
    backgroundColor: colors.background,
    paddingBottom: spacing.sm,
    alignItems: 'center',
  },
  primaryTabRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    padding: 4,
    borderRadius: borderRadius.full,
    backgroundColor: '#E2E8F0',
    alignSelf: 'center',
  },
  primaryTabChip: {
    paddingHorizontal: spacing.md,
    paddingVertical: 10,
    borderRadius: borderRadius.full,
  },
  primaryTabChipActive: {
    backgroundColor: colors.surface,
  },
  primaryTabText: {
    fontSize: fontSize.sm,
    color: colors.text.secondary,
    fontWeight: fontWeight.medium,
  },
  primaryTabTextActive: {
    color: colors.text.primary,
    fontWeight: fontWeight.bold,
  },
  sortMenuWrap: {
    position: 'relative',
    alignItems: 'flex-end',
    zIndex: 20,
  },
  sortMenuBackdrop: {
    position: 'absolute',
    top: -2000,
    right: -2000,
    bottom: -2000,
    left: -2000,
    zIndex: 1,
  },
  sortMenuTrigger: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: borderRadius.full,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border.light,
    zIndex: 2,
  },
  sortMenuTriggerText: {
    fontSize: fontSize.sm,
    color: colors.text.secondary,
    fontWeight: fontWeight.medium,
  },
  sortMenuDropdown: {
    position: 'absolute',
    top: '100%',
    right: 0,
    marginTop: 8,
    minWidth: 120,
    paddingVertical: 6,
    borderRadius: borderRadius.xl,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border.light,
    shadowColor: '#0F172A',
    shadowOpacity: 0.12,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 6 },
    elevation: 6,
    zIndex: 3,
  },
  sortMenuOption: {
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  sortMenuOptionActive: {
    backgroundColor: '#EFF6FF',
  },
  sortMenuOptionText: {
    fontSize: fontSize.sm,
    color: colors.text.secondary,
    fontWeight: fontWeight.medium,
  },
  sortMenuOptionTextActive: {
    color: colors.primary,
    fontWeight: fontWeight.bold,
  },
  secondaryStickyWrap: {
    backgroundColor: colors.background,
    paddingTop: spacing.sm,
    paddingBottom: spacing.sm,
    gap: spacing.sm,
    zIndex: 10,
  },
  filterGroup: {
    gap: spacing.sm,
  },
  filterScrollContent: {
    paddingRight: spacing.md,
    gap: spacing.sm,
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
  sceneFilterBtn: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: borderRadius.full,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border.light,
  },
  sceneFilterBtnActive: {
    backgroundColor: '#EFF6FF',
    borderColor: '#93C5FD',
  },
  sceneFilterBtnText: {
    fontSize: fontSize.sm,
    color: colors.text.secondary,
    fontWeight: fontWeight.medium,
  },
  sceneFilterBtnTextActive: {
    color: colors.primary,
    fontWeight: fontWeight.bold,
  },
  loadingBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: spacing.lg,
    paddingVertical: 12,
    backgroundColor: '#EFF6FF',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#BFDBFE',
  },
  loadingBannerText: {
    fontSize: 13,
    color: colors.primary,
    fontWeight: fontWeight.medium,
  },
  emptySectionState: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    backgroundColor: '#F8FAFC',
    borderRadius: borderRadius.xl,
    borderWidth: 1,
    borderColor: '#E2E8F0',
  },
  emptySectionText: {
    fontSize: fontSize.sm,
    lineHeight: 20,
    color: colors.text.secondary,
  },
  recommendedGridRow: {
    flexDirection: 'row',
    gap: spacing.md,
  },
  recommendedCard: {
    flex: 1,
    borderRadius: borderRadius.xxl,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border.light,
    paddingHorizontal: 12,
    paddingVertical: 12,
    gap: 8,
  },
  recommendedCardPlaceholder: {
    flex: 1,
  },
  recommendedCardTopRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
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
  favoriteBtn: {
    width: 24,
    height: 24,
    borderRadius: borderRadius.full,
    backgroundColor: '#F8FAFC',
    alignItems: 'center',
    justifyContent: 'center',
  },
  cardMetaCompact: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    flexWrap: 'wrap',
  },
  recommendedCardMetaRow: {
    flex: 1,
  },
  levelBadge: {
    paddingHorizontal: 6,
    paddingVertical: 1,
    borderRadius: borderRadius.sm,
  },
  levelText: {
    fontSize: 10,
    fontWeight: fontWeight.bold,
  },
  categoryText: {
    flexShrink: 1,
    fontSize: 10,
    fontWeight: fontWeight.bold,
    color: '#9CA3AF',
  },
  listTopicMeta: {
    fontSize: fontSize.xs,
    color: colors.text.secondary,
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

  // ── User-video deep-link highlight ──────────────────────────
  // A tinted block above the regular 推荐 / 跟练 sections that
  // appears ONLY when a row's AI 话题 chip deep-linked here with
  // `videoId`. Visually distinct (light violet wash + a small
  // "来自视频" eyebrow) so the user knows these topics are
  // specific to a video they just generated from.
  userVideoHighlight: {
    backgroundColor: 'rgba(124,58,237,0.06)',
    borderRadius: borderRadius.lg,
    padding: spacing.md,
    marginBottom: spacing.md,
    gap: spacing.sm,
    borderWidth: 1,
    borderColor: 'rgba(124,58,237,0.15)',
  },
  userVideoHighlightHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  userVideoHighlightHeaderInfo: { flex: 1, minWidth: 0 },
  userVideoHighlightEyebrow: {
    fontSize: 11,
    color: '#7C3AED',
    fontWeight: fontWeight.semibold,
    letterSpacing: 0.3,
    textTransform: 'uppercase',
    marginBottom: 2,
  },
  userVideoHighlightTitle: {
    fontSize: fontSize.base,
    color: colors.text.primary,
    fontWeight: fontWeight.semibold,
  },
  userVideoHighlightClose: {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.04)',
  },
  userVideoHighlightScroll: {
    gap: spacing.sm,
    paddingRight: spacing.md,
  },
  // Highlight cards re-use the same `recommendedCardTopRow` /
  // `recommendedEmoji` / `recommendedCardTitle` / etc. styles as
  // the 推荐话题 section. Only the outer Pressable + width is
  // different (fixed-width for a horizontal scroller).
  userVideoHighlightCard: {
    width: 200,
    backgroundColor: colors.surface,
    borderRadius: borderRadius.md,
    padding: spacing.sm,
    gap: 4,
    borderWidth: 1,
    borderColor: 'rgba(0,0,0,0.05)',
  },
  userVideoHighlightEmpty: {
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.sm,
  },
  userVideoHighlightEmptyText: {
    fontSize: fontSize.sm,
    color: colors.text.secondary,
    lineHeight: 18,
  },
});

export default AiPracticeHome;
