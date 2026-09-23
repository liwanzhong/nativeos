import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View, Text, StyleSheet, Pressable, ActivityIndicator,
  ScrollView, Image, useWindowDimensions,
} from 'react-native';
import { VideoView, useVideoPlayer } from 'expo-video';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  X, Video, MessageCircle, RotateCcw, Play,
} from 'lucide-react-native';
import * as Haptics from 'expo-haptics';
import { colors, borderRadius } from '../constants/theme';
import {
  getDueCards, scheduleReview, getCardsByVideo,
  getRangeGroupById, scheduleRangeReview,
} from '../lib/database';
import type { LearningCard } from '../lib/database/cards';
import type { RangeGroup } from '../lib/database/cards';

export default function ReviewSessionScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{
    videoId?: string;
    type?: 'word' | 'sentence';
    groupId?: string;
  }>();
  const videoFilter = params.videoId;
  const typeFilter = params.type;
  const groupIdParam = params.groupId;
  const filtered = Boolean(videoFilter);
  const isGroupMode = Boolean(groupIdParam);

  const [cards, setCards] = useState<LearningCard[]>([]);
  const [group, setGroup] = useState<RangeGroup | null>(null);
  const [loading, setLoading] = useState(true);

  // Index of the current card being reviewed.
  const [reviewIndex, setReviewIndex] = useState(0);
  const [flipped, setFlipped] = useState(false);
  const [reviewed, setReviewed] = useState(0);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        if (isGroupMode && groupIdParam) {
          const g = await getRangeGroupById(groupIdParam);
          if (!cancelled) {
            setGroup(g);
            setCards(g?.cards ?? []);
            setReviewIndex(0);
            setReviewed(0);
            setFlipped(false);
          }
        } else if (filtered && videoFilter) {
          const data = await getCardsByVideo(videoFilter, typeFilter, 500);
          if (!cancelled) {
            setGroup(null);
            setCards(data);
            setReviewIndex(0);
            setReviewed(0);
            setFlipped(false);
          }
        } else {
          const data = await getDueCards(200);
          if (!cancelled) {
            setGroup(null);
            setCards(data);
            setReviewIndex(0);
            setReviewed(0);
            setFlipped(false);
          }
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [filtered, videoFilter, typeFilter, isGroupMode, groupIdParam]);

  const currentReview = cards[reviewIndex];

  const handleRate = useCallback(async (rating: 1 | 2 | 3 | 4) => {
    if (!currentReview) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
    if (isGroupMode && group) {
      // Plan b: rate the whole group with one rating. Per-card FSRS rows
      // are independent, but identical initial state + identical rating
      // produces identical due/state/reps, keeping the schedule in lockstep.
      await scheduleRangeReview(group.groupId, rating);
    } else {
      await scheduleReview(currentReview.id, rating);
    }
    setReviewed((n) => n + 1);
    setFlipped(false);
    if (reviewIndex + 1 < cards.length) {
      setReviewIndex((i) => i + 1);
    } else {
      // Session done — return to the previous page (the list).
      router.back();
    }
  }, [currentReview, reviewIndex, cards.length, router, isGroupMode, group]);

  if (loading) {
    return (
      <View style={[styles.container, styles.center]}>
        <ActivityIndicator size="large" color={colors.text.primary} />
      </View>
    );
  }

  if (cards.length === 0) {
    return (
      <View style={[styles.container, styles.center, { paddingTop: insets.top }]}>
        <Text style={styles.emptyTitle}>没有要复习的卡片</Text>
        <Text style={styles.emptyHint}>回到知识库再攒点卡吧</Text>
        <Pressable style={styles.exitBtn} onPress={() => router.back()}>
          <Text style={styles.exitBtnText}>返回</Text>
        </Pressable>
      </View>
    );
  }

  if (!currentReview) {
    // Defensive — should not happen, but guard against null deref.
    return null;
  }

  return (
    <ReviewSessionView
      card={currentReview}
      group={isGroupMode ? group : null}
      groupIndex={reviewIndex}
      flipped={flipped}
      onFlip={() => setFlipped(true)}
      onRate={handleRate}
      onExit={() => router.back()}
      index={reviewIndex}
      total={cards.length}
      reviewed={reviewed}
      topInset={insets.top}
    />
  );
}

// ─────────────────────────────────────────────────────────────────────
// Sub-views
// ─────────────────────────────────────────────────────────────────────

class ClipPlayerErrorBoundary extends React.Component<
  { fallback?: React.ReactNode; children: React.ReactNode },
  { hasError: boolean }
> {
  constructor(props: { fallback?: React.ReactNode; children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false };
  }
  static getDerivedStateFromError() { return { hasError: true }; }
  render() {
    if (this.state.hasError) return this.props.fallback ?? null;
    return this.props.children;
  }
}

function ClipPlayerInner({ clipUri }: { clipUri: string }) {
  const player = useVideoPlayer({ uri: clipUri }, (p) => {
    p.loop = true;
    p.muted = false;
    p.pause();
  });
  const [isPlaying, setIsPlaying] = useState(false);

  useEffect(() => {
    const sub = player.addListener('playingChange', ({ isPlaying: next }) => {
      setIsPlaying(next);
    });
    return () => { sub.remove(); };
  }, [player]);

  useEffect(() => {
    return () => { try { player.pause(); } catch { } };
  }, [player]);

  const toggle = useCallback(() => {
    try {
      if (player.playing) {
        player.pause();
      } else {
        player.play();
      }
    } catch { /* ignore */ }
  }, [player]);

  return (
    <Pressable style={styles.cardHero} onPress={toggle}>
      <VideoView
        player={player}
        style={StyleSheet.absoluteFill}
        contentFit="cover"
        nativeControls={false}
        pointerEvents="none"
      />
      {!isPlaying ? (
        <View style={styles.cardHeroPlayOverlay} pointerEvents="none">
          <View style={styles.cardHeroPlayCircle}>
            <Play size={28} color="#fff" fill="#fff" />
          </View>
        </View>
      ) : null}
    </Pressable>
  );
}

function ClipPlayer({ clipUri, fallbackUri }: { clipUri: string; fallbackUri?: string | null }) {
  return (
    <ClipPlayerErrorBoundary
      fallback={fallbackUri
        ? <Image source={{ uri: fallbackUri }} style={styles.cardHero} resizeMode="cover" />
        : null}
    >
      <ClipPlayerInner clipUri={clipUri} />
    </ClipPlayerErrorBoundary>
  );
}

// V2 — plays a shared range clip while tracking which sentence in the
// group is "now". The timeline bar shows all N sentences; the active
// one is filled in primary color. When the user flips and rates, the
// parent advances activeIndex, and the player seeks to that sentence's
// start within the range clip and pauses for the user to read.
function RangeClipPlayer({
  clipUri, fallbackUri, group, activeIndex,
}: {
  clipUri: string;
  fallbackUri?: string | null;
  group: RangeGroup;
  activeIndex: number;
}) {
  const rangeStartMs = group.rangeStartMs ?? 0;
  const player = useVideoPlayer({ uri: clipUri }, (p) => {
    p.loop = false;
    p.muted = false;
    p.pause();
  });
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentMs, setCurrentMs] = useState(0);

  // Subscribe to time updates for the highlight overlay.
  useEffect(() => {
    const sub = player.addListener('timeUpdate', ({ currentTime }: any) => {
      setCurrentMs(Math.round((currentTime ?? 0) * 1000));
    });
    return () => { sub.remove(); };
  }, [player]);

  useEffect(() => {
    const sub = player.addListener('playingChange', ({ isPlaying: next }) => {
      setIsPlaying(next);
    });
    return () => { sub.remove(); };
  }, [player]);

  useEffect(() => {
    return () => { try { player.pause(); } catch { /* ignore */ } };
  }, [player]);

  // Plan β: when the active card changes, seek to that sentence's start
  // within the range clip and pause. The user reads the prompt, flips,
  // and rates; only then do we advance to the next sentence.
  useEffect(() => {
    const card = group.cards[activeIndex];
    if (!card) return;
    const cardStartInRangeMs = (card.videoContext?.startMs ?? rangeStartMs) - rangeStartMs;
    const seekSec = Math.max(0, cardStartInRangeMs / 1000);
    try {
      player.currentTime = seekSec;
      player.pause();
    } catch { /* ignore */ }
  }, [activeIndex, group.cards, player, rangeStartMs]);

  const toggle = useCallback(() => {
    try {
      if (player.playing) {
        player.pause();
      } else {
        player.play();
      }
    } catch { /* ignore */ }
  }, [player]);

  const renderPlayer = (
    <Pressable style={styles.cardHero} onPress={toggle}>
      <VideoView
        player={player}
        style={StyleSheet.absoluteFill}
        contentFit="cover"
        nativeControls={false}
        pointerEvents="none"
      />
      {!isPlaying ? (
        <View style={styles.cardHeroPlayOverlay} pointerEvents="none">
          <View style={styles.cardHeroPlayCircle}>
            <Play size={28} color="#fff" fill="#fff" />
          </View>
        </View>
      ) : null}
    </Pressable>
  );

  return (
    <ClipPlayerErrorBoundary
      fallback={fallbackUri
        ? <Image source={{ uri: fallbackUri }} style={styles.cardHero} resizeMode="cover" />
        : null}
    >
      <View>
        {renderPlayer}
        <View style={styles.rangeTimeline}>
          {group.cards.map((c, i) => {
            const cardStartInRange = (c.videoContext?.startMs ?? 0) - rangeStartMs;
            const cardEndInRange = (c.videoContext?.endMs ?? 0) - rangeStartMs;
            const isActive = i === activeIndex;
            const isPast = currentMs >= cardStartInRange && i < activeIndex;
            return (
              <View
                key={c.id}
                style={[
                  styles.rangeTimelineSegment,
                  isPast && styles.rangeTimelineSegmentPast,
                  isActive && styles.rangeTimelineSegmentActive,
                ]}
              >
                <Text style={styles.rangeTimelineLabel}>{i + 1}</Text>
              </View>
            );
          })}
        </View>
        <Text style={styles.rangeTimelineHint}>
          {activeIndex + 1}/{group.cards.length}  ·  点视频可播/停
        </Text>
      </View>
    </ClipPlayerErrorBoundary>
  );
}

function ReviewSessionView({
  card, group, groupIndex, flipped, onFlip, onRate, onExit, index, total, reviewed, topInset,
}: {
  card: LearningCard;
  group: RangeGroup | null;
  groupIndex: number;
  flipped: boolean;
  onFlip: () => void;
  onRate: (rating: 1 | 2 | 3 | 4) => void;
  onExit: () => void;
  index: number;
  total: number;
  reviewed: number;
  topInset: number;
}) {
  const { width: viewportWidth } = useWindowDimensions();
  const heroMaxWidth = Math.min(viewportWidth - 48, 480);
  const clipUri = card.videoContext?.clipUri ?? null;
  const thumbUri = card.videoContext?.thumbUri;
  const coverUri = card.videoContext?.coverUri;
  const heroUri = thumbUri ?? coverUri ?? null;
  const hasClip = !!clipUri;
  // V2 — when in group mode, render the shared range clip with per-sentence
  // highlight overlay instead of the single-segment player.
  const rangeClipUri = group?.rangeClipUri ?? null;
  const isGroup = !!group && (group.cards.length > 1 || !!rangeClipUri);

  return (
    <View style={styles.container}>
      <View style={[styles.reviewTopBar, { paddingTop: topInset + 12 }]}>
        <Pressable onPress={onExit} hitSlop={8}>
          <X size={22} color={colors.text.primary} />
        </Pressable>
        <Text style={styles.reviewProgress}>
          {index + 1} / {total}  ·  已复习 {reviewed}
        </Text>
        <View style={{ width: 22 }} />
      </View>

      <View style={styles.cardFace}>
        {isGroup && rangeClipUri ? (
          <RangeClipPlayer
            clipUri={rangeClipUri}
            fallbackUri={heroUri}
            group={group!}
            activeIndex={groupIndex}
          />
        ) : hasClip ? (
          <ClipPlayer clipUri={clipUri!} fallbackUri={heroUri} />
        ) : heroUri ? (
          <Image source={{ uri: heroUri }} style={[styles.cardHero, { maxWidth: heroMaxWidth }]} resizeMode="cover" />
        ) : null}
        <View style={styles.cardTypeBadge}>
          {card.source === 'video'
            ? <Video size={12} color={colors.text.tertiary} />
            : <MessageCircle size={12} color={colors.text.tertiary} />
          }
          <Text style={styles.cardTypeBadgeText}>
            {card.source === 'video' ? '视频' : '陪练'} · {card.type === 'word' ? '单词' : '句子'}
          </Text>
        </View>
        <Pressable
          style={styles.cardTextArea}
          onPress={onFlip}
        >
          <ScrollView
            contentContainerStyle={styles.cardTextScroll}
            showsVerticalScrollIndicator={false}
            bounces={false}
          >
            <Text style={styles.cardFrontText} adjustsFontSizeToFit numberOfLines={4}>
              {card.content}
            </Text>
            {flipped ? (
              <Text style={styles.cardBackText} adjustsFontSizeToFit numberOfLines={6}>
                {card.translation || '(未填翻译)'}
              </Text>
            ) : (
              <View style={styles.flipHint}>
                <RotateCcw size={14} color={colors.text.tertiary} />
                <Text style={styles.flipHintText}>点按翻面</Text>
              </View>
            )}
            {card.notes ? (
              <Text style={styles.cardNotesText} numberOfLines={3}>📝 {card.notes}</Text>
            ) : null}
          </ScrollView>
        </Pressable>
      </View>

      <View style={styles.reviewBottomBar}>
        {flipped ? (
          <View style={styles.ratingRow}>
            <RatingBtn label="重来" tone="red" onPress={() => onRate(1)} />
            <RatingBtn label="困难" tone="orange" onPress={() => onRate(2)} />
            <RatingBtn label="良好" tone="green" onPress={() => onRate(3)} />
            <RatingBtn label="轻松" tone="blue" onPress={() => onRate(4)} />
          </View>
        ) : (
          <Pressable style={styles.flipBigBtn} onPress={onFlip}>
            <Text style={styles.flipBigBtnText}>显示释义</Text>
          </Pressable>
        )}
      </View>
    </View>
  );
}

function RatingBtn({ label, tone, onPress }: { label: string; tone: 'red' | 'orange' | 'green' | 'blue'; onPress: () => void }) {
  const colorMap = {
    red: { bg: '#FEE2E2', fg: '#B91C1C' },
    orange: { bg: '#FED7AA', fg: '#C2410C' },
    green: { bg: '#D1FAE5', fg: '#047857' },
    blue: { bg: '#DBEAFE', fg: '#1D4ED8' },
  } as const;
  const c = colorMap[tone];
  return (
    <Pressable
      style={[styles.ratingBtn, { backgroundColor: c.bg }]}
      onPress={onPress}
    >
      <Text style={[styles.ratingBtnText, { color: c.fg }]}>{label}</Text>
    </Pressable>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Styles
// ─────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background, paddingHorizontal: 20 },
  center: { alignItems: 'center', justifyContent: 'center' },

  emptyTitle: { fontSize: 18, fontWeight: '700' as any, color: colors.text.primary, marginBottom: 8 },
  emptyHint: { fontSize: 13, color: colors.text.tertiary, marginBottom: 24 },
  exitBtn: { paddingHorizontal: 24, paddingVertical: 12, borderRadius: 12, backgroundColor: colors.text.primary },
  exitBtnText: { color: '#fff', fontSize: 14, fontWeight: '600' as any },

  reviewTopBar: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingBottom: 12,
  },
  reviewProgress: { fontSize: 13, color: colors.text.secondary, fontWeight: '600' as any },
  cardFace: {
    flex: 1, backgroundColor: colors.surface, borderRadius: 24, padding: 16,
    alignItems: 'stretch', justifyContent: 'flex-start',
    borderWidth: 1, borderColor: colors.border.light,
  },
  cardHero: {
    width: '100%', aspectRatio: 16 / 9, maxHeight: 200,
    borderRadius: 12, marginBottom: 12, backgroundColor: colors.background,
    overflow: 'hidden', alignSelf: 'center',
  },
  cardHeroPlayOverlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.18)',
  },
  cardHeroPlayCircle: {
    width: 56, height: 56, borderRadius: 28,
    backgroundColor: 'rgba(0,0,0,0.55)',
    alignItems: 'center', justifyContent: 'center',
  },
  rangeTimeline: {
    flexDirection: 'row',
    gap: 4,
    paddingHorizontal: 12,
    paddingTop: 8,
  },
  rangeTimelineSegment: {
    flex: 1,
    height: 8,
    borderRadius: 4,
    backgroundColor: '#E2E8F0',
    alignItems: 'center',
    justifyContent: 'center',
  },
  rangeTimelineSegmentPast: { backgroundColor: '#94A3B8' },
  rangeTimelineSegmentActive: { backgroundColor: colors.primary ?? '#1D4ED8' },
  rangeTimelineLabel: { fontSize: 9, color: '#fff', fontWeight: '700' as any },
  rangeTimelineHint: {
    fontSize: 11,
    color: colors.text.tertiary,
    textAlign: 'center',
    paddingTop: 4,
    paddingBottom: 4,
  },
  cardTypeBadge: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    alignSelf: 'center', marginBottom: 8, paddingHorizontal: 10, paddingVertical: 4,
    borderRadius: 12, backgroundColor: colors.background,
  },
  cardTypeBadgeText: { fontSize: 11, color: colors.text.tertiary, fontWeight: '600' as any },
  cardTextArea: { flex: 1 },
  cardTextScroll: { flexGrow: 1, alignItems: 'center', justifyContent: 'center', paddingVertical: 4 },
  cardFrontText: {
    fontSize: 24, fontWeight: '800' as any, color: colors.text.primary,
    textAlign: 'center', lineHeight: 32,
  },
  cardBackText: {
    fontSize: 15, color: colors.text.secondary,
    textAlign: 'center', marginTop: 12, lineHeight: 22,
  },
  cardNotesText: {
    fontSize: 13, color: colors.text.tertiary, marginTop: 10, fontStyle: 'italic',
  },
  flipHint: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 12, justifyContent: 'center' },
  flipHintText: { fontSize: 12, color: colors.text.tertiary },
  reviewBottomBar: { paddingVertical: 16, gap: 10 },
  flipBigBtn: { backgroundColor: colors.text.primary, paddingVertical: 14, borderRadius: 14, alignItems: 'center' },
  flipBigBtnText: { color: '#fff', fontSize: 15, fontWeight: '700' as any },
  ratingRow: { flexDirection: 'row', gap: 8 },
  ratingBtn: { flex: 1, paddingVertical: 13, borderRadius: 12, alignItems: 'center' },
  ratingBtnText: { fontSize: 14, fontWeight: '800' as any },
});
