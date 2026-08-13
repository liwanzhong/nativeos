import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Alert, View, Text, StyleSheet, Pressable, FlatList, ActivityIndicator, Platform, Modal, useWindowDimensions, Image, ScrollView, ToastAndroid, type StyleProp, type TextStyle, type ListRenderItem } from 'react-native';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { VideoView, useVideoPlayer } from 'expo-video';
import * as Haptics from 'expo-haptics';
import { ChevronDown, ChevronLeft, ChevronUp, PlayCircle, PauseCircle, RefreshCw, RotateCcw, Clapperboard, Languages, Gauge, SkipBack, SkipForward, Star, Maximize, Minimize, Mic, Headphones, MessageCircle, X, MoreVertical } from 'lucide-react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors, spacing, borderRadius, fontSize, fontWeight } from '../../../constants/theme';
import { getVideoSceneById, getVideoSceneSummaryById, invalidateVideoSceneCaches, type VideoSceneDetail, type VideoSceneSegment, type WordTiming } from '../../../lib/content/video-scenes';
import { getOrCreateClipThumb } from '../../../lib/clip-thumbnail';
import { extractVideoClip, deleteClipSegment } from '../../../lib/media/ffmpeg-clip';
import { selectScenario, type ScenarioCard } from '../../../lib/ai/scenario-generator';
import { buildAiPracticeTopicSnapshot, markAiPracticeTopicUsed } from '../../../lib/ai/ai-practice-user-meta';
import { startVolcASR, type ASRHandle } from '../../../lib/volcengine/asr';
import { diffShadowing, type ShadowingDiffResult } from '../../../lib/shadowing/diff';
import { DictionaryLookupSheet } from '../../../components/dictionary/DictionaryLookupSheet';
import { ShadowingPanel } from '../../../components/video/ShadowingPanel';
import { VideoSourcePickerContent, type SelectedCloudVideoFile } from '../../../components/cloud-drive/VideoSourcePickerContent';
import { getCachedVideoUri } from '../../../lib/video-cache';
import { bindOfficialSceneToProvider, getBaiduPanBinding, getDownloadedSceneSource, getOfficialSceneProviderStates, type CloudVideoProvider, type DownloadedSceneSource, type VideoSourceProviderState, unbindOfficialSceneFromProvider } from '../../../lib/content/cloud-drive-bindings';
import { CLOUD_DOWNLOAD_SLOW_HELP_MESSAGE, CLOUD_DOWNLOAD_SLOW_HELP_TITLE } from '../../../lib/content/cloud-download-help';
import { downloadImportedCloudVideo, downloadOfficialSceneVideo, pauseOfficialSceneVideoDownload, removeOfficialSceneVideoDownload, resolveCloudReferencedVideoSource, resolveOfficialSceneVideoSource, resumeOfficialSceneVideoDownload } from '../../../lib/content/cloud-video-playback';
import { generateVideoAiPracticeCards, getVideoAiPracticeGenerationState, loadGeneratedVideoAiPracticeCards, subscribeVideoAiPracticeGenerationState, type VideoAiPracticeGenerationState, type VideoAiPracticeGenerationStatus } from '../../../lib/content/video-ai-practice';
import {
  generateUserVideoAiPracticeCards,
  getUserVideoAiPracticeState,
  loadGeneratedUserVideoAiPracticeCards,
  subscribeUserVideoAiPracticeState,
} from '../../../lib/content/user-video-ai-practice';
import { getVideoUserMeta, markVideoScenePracticed } from '../../../lib/content/video-user-meta';
import {
  createCard,
  deleteCard,
  getCardsByVideo,
  getDueCardCountByVideo,
} from '../../../lib/database';
import { prewarmDictionaryDb } from '../../../lib/dictionary/db';
import { lookupWord as queryDictionaryWord } from '../../../lib/dictionary/query';
import { deleteUserVideoEntry, setUserVideoCollection, triggerCloudVideoSubtitleGeneration, triggerUserVideoSubtitleGeneration } from '../../../lib/content/user-videos';
import { encodeUserCollectionId, listUserCollections } from '../../../lib/content/user-collections';
import { invalidateCollectionsCache } from '../../../lib/content/collections';

function WordHighlightText({
  words,
  text,
  positionMs,
  isActive,
  textStyle,
  highlightStyle,
  numberOfLines,
  onWordPress,
  segmentId,
}: {
  words?: WordTiming[];
  text: string;
  positionMs: number;
  isActive: boolean;
  textStyle?: StyleProp<TextStyle>;
  highlightStyle?: StyleProp<TextStyle>;
  numberOfLines?: number;
  onWordPress?: (word: WordTiming, segmentText: string, segmentId?: string) => void;
  segmentId?: string;
}) {
  if (!words || words.length <= 1) {
    return (
      <Text numberOfLines={numberOfLines} style={[styles.segmentText, isActive && styles.segmentTextActive, textStyle]}>{text}</Text>
    );
  }
  return (
    <Text numberOfLines={numberOfLines} style={[styles.segmentText, isActive && styles.segmentTextActive, textStyle]}>
      {words.map((w, i) => {
        const highlighted = isActive && positionMs >= w.startMs && positionMs < w.endMs;
        return (
          <Text
            key={i}
            style={highlighted ? [styles.wordHighlight, highlightStyle] : undefined}
            onPress={onWordPress ? (e) => { e.stopPropagation?.(); onWordPress(w, text, segmentId); } : undefined}
            suppressHighlighting
          >
            {w.text}
          </Text>
        );
      })}
    </Text>
  );
}

function getFullscreenSubtitleMetrics(text: string, shortEdge: number) {
  const normalizedLength = text.replace(/\s+/g, ' ').trim().length;
  if (normalizedLength > 72 || shortEdge < 390) {
    return {
      fontSize: 16,
      lineHeight: 22,
      maxLines: 4,
    };
  }
  if (normalizedLength > 48 || shortEdge < 430) {
    return {
      fontSize: 18,
      lineHeight: 24,
      maxLines: 3,
    };
  }
  return {
    fontSize: 22,
    lineHeight: 28,
    maxLines: 2,
  };
}

function getFullscreenTranslationMetrics(text: string | undefined, shortEdge: number) {
  const normalizedLength = (text || '').replace(/\s+/g, ' ').trim().length;
  if (normalizedLength > 28 || shortEdge < 390) {
    return {
      fontSize: 12,
      lineHeight: 16,
      maxLines: 2,
    };
  }
  return {
    fontSize: 13,
    lineHeight: 18,
    maxLines: 2,
  };
}

function formatPlaybackTime(ms: number) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

function formatClipRelativeTime(ms: number, clipStartMs: number) {
  return formatPlaybackTime(Math.max(0, ms - clipStartMs));
}

type SubtitlePanelTabKey = 'subtitles' | 'words' | 'favorites';

type WebOrientationLock =
  | 'any'
  | 'natural'
  | 'landscape'
  | 'portrait'
  | 'portrait-primary'
  | 'portrait-secondary'
  | 'landscape-primary'
  | 'landscape-secondary';

type FullscreenTranslationMode = 'always' | 'tap' | 'hidden';

async function requestLandscapeOrientationLock() {
  if (typeof screen === 'undefined') return;
  const orientationApi = screen.orientation as ScreenOrientation & {
    lock?: (orientation: WebOrientationLock) => Promise<void>;
    unlock?: () => void;
  };
  if (typeof orientationApi?.lock !== 'function') return;
  try {
    await orientationApi.lock('landscape');
  } catch {
  }
}

function releaseOrientationLock() {
  if (typeof screen === 'undefined') return;
  const orientationApi = screen.orientation as ScreenOrientation & {
    unlock?: () => void;
  };
  if (typeof orientationApi?.unlock !== 'function') return;
  try {
    orientationApi.unlock();
  } catch {
  }
}

function isReleasedVideoPlayerError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error ?? '');
  return message.includes('already released') || message.includes('Cannot use shared object that was already released');
}

function getProviderSyncStatusLabel(status: 'not_connected' | 'not_synced' | 'available' | 'cached' | 'stale' | 'error') {
  if (status === 'cached') return '本地缓存';
  if (status === 'available') return '已同步';
  if (status === 'stale') return '有更新';
  if (status === 'error') return '同步异常';
  if (status === 'not_synced') return '未同步';
  return '未连接';
}

function formatDownloadPercent(progress?: number) {
  return `${Math.round(Math.max(0, Math.min(1, progress || 0)) * 100)}%`;
}

function formatBytes(bytes?: number) {
  const value = bytes || 0;
  if (value <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let next = value;
  let unitIndex = 0;
  while (next >= 1024 && unitIndex < units.length - 1) {
    next /= 1024;
    unitIndex += 1;
  }
  return `${next >= 10 || unitIndex === 0 ? next.toFixed(unitIndex === 0 ? 0 : 1) : next.toFixed(2)} ${units[unitIndex]}`;
}

function formatSpeed(bytesPerSecond?: number) {
  if (!bytesPerSecond || bytesPerSecond <= 0) {
    return '0 B/s';
  }
  return `${formatBytes(bytesPerSecond)}/s`;
}

function getDownloadStatusLabel(status?: DownloadedSceneSource['status']) {
  if (status === 'resolving') return '准备中';
  if (status === 'downloading') return '缓存中';
  if (status === 'paused') return '已暂停';
  if (status === 'completed') return '已缓存';
  if (status === 'error') return '缓存失败';
  return '未开始';
}

function isUserManagedImportedScene(scene?: VideoSceneDetail | null) {
  if (!scene || scene.contentOrigin !== 'imported') {
    return false;
  }
  return scene.id.startsWith('user_video_') || scene.id.startsWith('user_cloud_video_');
}

function getImportedVideoDeleteConfirmation(scene: VideoSceneDetail) {
  if (scene.selectedCloudProvider) {
    return {
      title: '移除这条云盘视频记录？',
      message: '只会移除这条本地记录，不会删除云盘中的原文件。',
      confirmText: '删除',
    };
  }
  return {
    title: '删除这个本地视频？',
    message: '将从 App 中删除该视频及其本地字幕缓存。此操作不可恢复。',
    confirmText: '删除',
  };
}

function pausePlayerSafely(player: ReturnType<typeof useVideoPlayer>) {
  try {
    if (player.playing) {
      player.pause();
    }
  } catch (error) {
    if (isReleasedVideoPlayerError(error)) {
      return;
    }
    console.warn('[VideoScene] pause failed unexpectedly', error);
  }
}

function findActiveSegmentIndex(positionMs: number, segments: VideoSceneSegment[]): number {
  if (segments.length === 0) return 0;

  for (let i = segments.length - 1; i >= 0; i--) {
    const seg = segments[i];
    if (positionMs >= seg.startMs && positionMs < seg.endMs) {
      return i;
    }
  }

  for (let i = segments.length - 1; i >= 0; i--) {
    if (positionMs >= segments[i].startMs) {
      return i;
    }
  }

  return 0;
}

const SegmentCard = memo(function SegmentCard({
  segment,
  index,
  isActive,
  clipStartMs,
  isFavorited,
  subtitleMode,
  positionMs,
  onSeek,
  onMeasure,
  onToggleFavorite,
  onWordPress,
  onShadowingPress,
}: {
  segment: VideoSceneSegment;
  index: number;
  isActive: boolean;
  clipStartMs: number;
  isFavorited: boolean;
  subtitleMode: 'bilingual' | 'english';
  positionMs: number;
  onSeek: (index: number) => void;
  onMeasure: (index: number, y: number) => void;
  onToggleFavorite: (segmentId: string) => void;
  onWordPress?: (word: WordTiming, segmentText: string, segmentId?: string) => void;
  onShadowingPress?: () => void;
}) {
  return (
    <Pressable
      style={[styles.segmentCard, isActive && styles.segmentCardActive]}
      onLayout={(e) => { onMeasure(index, e.nativeEvent.layout.y); }}
      onPress={() => onSeek(index)}
    >
      <View style={styles.segmentCardTopRow}>
        <Text style={[styles.segmentTime, isActive && styles.segmentTimeActive]}>{formatClipRelativeTime(segment.startMs, clipStartMs)}</Text>
        <View style={styles.segmentTopRowActions}>
          {isActive && onShadowingPress ? (
            <Pressable
              hitSlop={8}
              style={styles.segmentMicBtn}
              onPress={(event) => {
                event.stopPropagation();
                onShadowingPress();
              }}
            >
              <Mic size={14} color="#2563EB" />
            </Pressable>
          ) : null}
          <Pressable
            hitSlop={8}
            style={styles.segmentStarBtn}
            onPress={(event) => {
              event.stopPropagation();
              onToggleFavorite(segment.id);
            }}
          >
            <Star
              size={16}
              color={isFavorited ? '#F59E0B' : '#94A3B8'}
              fill={isFavorited ? '#FBBF24' : 'transparent'}
            />
          </Pressable>
        </View>
      </View>
      <Pressable onPress={() => {}}>
        <WordHighlightText
          words={segment.words}
          text={segment.text}
          positionMs={positionMs}
          isActive={isActive}
          segmentId={segment.id}
          onWordPress={onWordPress}
        />
      </Pressable>
      {subtitleMode === 'bilingual' ? (
        <Pressable onPress={() => {}}>
          <Text style={[styles.segmentTextZh, isActive && styles.segmentTextZhActive]}>{segment.textZh}</Text>
        </Pressable>
      ) : null}
    </Pressable>
  );
});

const ProgressScrubber = memo(function ProgressScrubber({
  ratio,
  leftLabel,
  rightLabel,
  rightAccessory,
  onChange,
  onComplete,
}: {
  ratio: number;
  leftLabel: string;
  rightLabel?: string;
  rightAccessory?: ReactNode;
  onChange: (ratio: number) => void;
  onComplete: (ratio: number) => void;
}) {
  const [trackWidth, setTrackWidth] = useState(0);

  const clampRatio = useCallback((value: number) => {
    if (Number.isNaN(value)) return 0;
    return Math.max(0, Math.min(1, value));
  }, []);

  const ratioForLocation = useCallback((locationX: number) => {
    if (trackWidth <= 0) return 0;
    return clampRatio(locationX / trackWidth);
  }, [clampRatio, trackWidth]);

  const handleMove = useCallback((locationX: number) => {
    onChange(ratioForLocation(locationX));
  }, [onChange, ratioForLocation]);

  const handleEnd = useCallback((locationX: number) => {
    onComplete(ratioForLocation(locationX));
  }, [onComplete, ratioForLocation]);

  return (
    <View style={styles.playerProgressSection}>
      <View style={styles.playerProgressLabelsRow}>
        <Text style={styles.playerProgressLabel}>{leftLabel}</Text>
        <View style={styles.playerProgressRightGroup}>
          {rightLabel ? <Text style={styles.playerProgressRightLabel}>{rightLabel}</Text> : null}
          {rightAccessory}
        </View>
      </View>
      <View
        style={styles.playerProgressTrack}
        onLayout={(event) => setTrackWidth(event.nativeEvent.layout.width)}
        onStartShouldSetResponder={() => true}
        onMoveShouldSetResponder={() => true}
        onResponderGrant={(event) => handleMove(event.nativeEvent.locationX)}
        onResponderMove={(event) => handleMove(event.nativeEvent.locationX)}
        onResponderRelease={(event) => handleEnd(event.nativeEvent.locationX)}
      >
        <View style={[styles.playerProgressFill, { width: `${ratio * 100}%` }]} />
        <View style={[styles.playerProgressThumb, { left: `${ratio * 100}%` }]} />
      </View>
    </View>
  );
});

function VideoLearningPlayer({
  scene,
  onRefreshScene,
  onRefreshSubtitles,
}: {
  scene: VideoSceneDetail;
  onRefreshScene?: (forceRefresh?: boolean) => Promise<void>;
  onRefreshSubtitles?: (forceRefresh?: boolean) => Promise<void>;
 }) {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { width: viewportWidth, height: viewportHeight } = useWindowDimensions();
  const clipStartMs = scene.clipStartMs ?? 0;
  const clipStartSeconds = (scene.clipStartMs ?? 0) / 1000;
  const [videoPlaybackUri, setVideoPlaybackUri] = useState<string | null>(scene.videoUri ?? null);
  const [videoPlaybackHeaders, setVideoPlaybackHeaders] = useState<Record<string, string> | undefined>(scene.videoHeaders);
  const [videoPlaybackContentType, setVideoPlaybackContentType] = useState<'auto' | 'hls' | undefined>(scene.videoContentType);
  const [videoPlaybackOverrideFileExtensionAndroid, setVideoPlaybackOverrideFileExtensionAndroid] = useState<string | undefined>(scene.videoOverrideFileExtensionAndroid);
  const [isVideoSourcePreparing, setIsVideoSourcePreparing] = useState(Boolean(!scene.videoAsset && (scene.videoUri || scene.contentOrigin === 'official')));
  const playerSource = useMemo(() => (
    scene.videoAsset
      ? scene.videoAsset
      : videoPlaybackUri
        ? {
            uri: videoPlaybackUri,
            headers: videoPlaybackHeaders,
            contentType: videoPlaybackContentType,
            overrideFileExtensionAndroid: videoPlaybackOverrideFileExtensionAndroid,
          }
        : null
  ), [scene.videoAsset, videoPlaybackContentType, videoPlaybackHeaders, videoPlaybackOverrideFileExtensionAndroid, videoPlaybackUri]);
  const resolvedPlayerSource = playerSource;
  const primedRef = useRef(false);
  const practicedRecordedSceneIdRef = useRef<string | null>(null);
  const fullscreenHostRef = useRef<React.ElementRef<typeof View>>(null);
  const scrollRef = useRef<FlatList<VideoSceneSegment>>(null);
  const segmentYPositions = useRef<Record<number, number>>({});
  const [isVideoReady, setIsVideoReady] = useState(false);
  const [hasStartedPlaybackOnce, setHasStartedPlaybackOnce] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [durationSeconds, setDurationSeconds] = useState(scene.durationSeconds);
  const [playerError, setPlayerError] = useState<string | null>(null);
  const [providerStates, setProviderStates] = useState(scene.availableCloudProviders || []);
  const [selectedProvider, setSelectedProvider] = useState<CloudVideoProvider | null>(scene.selectedCloudProvider ?? null);
  const [isBindPickerVisible, setIsBindPickerVisible] = useState(false);
  const [isRefreshingCloudSourceStatus, setIsRefreshingCloudSourceStatus] = useState(false);
  const [isGeneratingSubtitle, setIsGeneratingSubtitle] = useState(false);
  const resolvedDurationSeconds = durationSeconds > 0 ? durationSeconds : scene.durationSeconds;
  const effectiveClipEndMs = scene.clipEndMs ?? Math.round(resolvedDurationSeconds * 1000);
  const effectiveClipEndSeconds = effectiveClipEndMs / 1000;
  const [subtitleMode, setSubtitleMode] = useState<'bilingual' | 'english'>('bilingual');
  const [playbackRate, setPlaybackRate] = useState(1);
  const [isBackgroundAudioEnabled, setIsBackgroundAudioEnabled] = useState(false);
  const [repeatSentence, setRepeatSentence] = useState(false);
  const [lockedRepeatRange, setLockedRepeatRange] = useState<{ startSeconds: number; endSeconds: number } | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [isFullscreenHudVisible, setIsFullscreenHudVisible] = useState(true);
  const [fullscreenHudBottomHeight, setFullscreenHudBottomHeight] = useState(0);
  const [fullscreenHudRefreshTick, setFullscreenHudRefreshTick] = useState(0);
  const [isFullscreenSubtitleVisible, setIsFullscreenSubtitleVisible] = useState(true);
  const [fullscreenTranslationMode, setFullscreenTranslationMode] = useState<FullscreenTranslationMode>('always');
  const [isFullscreenTranslationPeekVisible, setIsFullscreenTranslationPeekVisible] = useState(false);
  const [subtitlePanelTab, setSubtitlePanelTab] = useState<SubtitlePanelTabKey>('subtitles');
  // KB state is now SQLite-backed. Both the 单词 tab and the 句子 tab are
  // just filtered views of the same `learning_cards` table.
  const [wordCards, setWordCards] = useState<any[]>([]);
  const [sentenceCards, setSentenceCards] = useState<any[]>([]);
  const [dueWordCount, setDueWordCount] = useState(0);
  const [dueSentenceCount, setDueSentenceCount] = useState(0);
  const [scrubRatio, setScrubRatio] = useState<number | null>(null);
  const [isPlayerPanelCollapsed, setIsPlayerPanelCollapsed] = useState(false);
  const [lookupWord, setLookupWord] = useState<string | null>(null);
  const [lookupContext, setLookupContext] = useState<string>('');
  const [lookupSegmentId, setLookupSegmentId] = useState<string | null>(null);
  const [isShadowingVisible, setIsShadowingVisible] = useState(false);
  const [isVideoAiPickerVisible, setIsVideoAiPickerVisible] = useState(false);
  const [videoAiPickerCards, setVideoAiPickerCards] = useState<ScenarioCard[]>([]);
  const [isGeneratingVideoAiPractice, setIsGeneratingVideoAiPractice] = useState(false);
  const [videoAiGenerationStatus, setVideoAiGenerationStatus] = useState<VideoAiPracticeGenerationStatus>('idle');
  const [videoAiGenerationError, setVideoAiGenerationError] = useState<string | null>(null);
  const [videoAiProgressText, setVideoAiProgressText] = useState('正在准备生成 AI陪练...');
  const [videoAiStreamParsedCount, setVideoAiStreamParsedCount] = useState(0);
  const [videoAiStreamTargetCount, setVideoAiStreamTargetCount] = useState(0);
  const [shadowingSegmentIndex, setShadowingSegmentIndex] = useState<number | null>(null);
  const [shadowingLiveTranscript, setShadowingLiveTranscript] = useState('');
  const [isShadowingRecording, setIsShadowingRecording] = useState(false);
  const [isShadowingProcessing, setIsShadowingProcessing] = useState(false);
  const [shadowingDiffResult, setShadowingDiffResult] = useState<ShadowingDiffResult | null>(null);
  const wasPlayingBeforeLookupRef = useRef(false);
  const wasPlayingBeforeShadowingRef = useRef(false);
  const shadowingAsrRef = useRef<ASRHandle | null>(null);
  const shadowingReplayRangeRef = useRef<{ startSeconds: number; endSeconds: number } | null>(null);
  const fullscreenHudTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const filterValidAiCards = useCallback((cards?: ScenarioCard[]) => {
    return (cards || []).filter((card) => Boolean(card.npcSystemPrompt || card.openingLine || card.npcName));
  }, []);

  const canUseOfficialCloudSource = scene.contentOrigin === 'official' && !!scene.officialAssetKeys;
  const currentProviderState = providerStates.find((item) => item.isSelected) ?? null;
  const hasConfiguredProvider = providerStates.some((item) => item.isConfigured);
  const hasReadyCloudSource = currentProviderState?.syncStatus === 'available' || currentProviderState?.syncStatus === 'cached';
  const hasConnectedProvider = currentProviderState?.syncStatus != null && currentProviderState.syncStatus !== 'not_connected';
  const hasStaleProvider = currentProviderState?.syncStatus === 'stale';

  const handleOpenCloudDriveSettings = useCallback(() => {
    router.push('/cloud-drives');
  }, [router]);

  const handleOpenBindPicker = useCallback(() => {
    if (!currentProviderState?.provider) {
      Alert.alert(
        '当前没有默认网盘',
        hasConfiguredProvider
          ? '你已经授权了网盘，但还没有设置推荐默认网盘。请先去「我的」→「我的网盘」里完成设置。'
          : '请先在「我的」→「我的网盘」里授权至少一个网盘来源。',
      );
      return;
    }
    setIsBindPickerVisible(true);
  }, [currentProviderState?.provider, hasConfiguredProvider]);

  const handleOpenMyCloudDrives = useCallback(() => {
    if (!canUseOfficialCloudSource) {
      handleOpenCloudDriveSettings();
      return;
    }

    if (currentProviderState?.provider) {
      Alert.alert(
        '去我的网盘',
        `你可以先去「我的网盘」检查授权、同步目录和默认来源，也可以直接从当前默认的${currentProviderState.label}里绑定这条视频。\n\n注意：这条视频也可能实际保存在其他网盘来源里。`,
        [
          {
            text: '取消',
            style: 'cancel',
          },
          {
            text: '去授权/配置',
            onPress: handleOpenCloudDriveSettings,
          },
          {
            text: `从默认${currentProviderState.label}绑定`,
            onPress: handleOpenBindPicker,
          },
        ],
      );
      return;
    }

    Alert.alert(
      '去我的网盘',
      hasConfiguredProvider
        ? '你已经授权了网盘，但当前还没有设置推荐默认网盘。请先去「我的网盘」设置默认来源；如果这条视频实际保存在其他网盘，也需要在那里完成同步或切换默认来源。'
        : '你还没有授权可用网盘。请先去「我的网盘」完成授权；如果之后发现视频保存在其他网盘，也可以回来重新选择来源。',
      [
        {
          text: '取消',
          style: 'cancel',
        },
        {
          text: hasConfiguredProvider ? '去设置默认网盘' : '去授权网盘',
          onPress: handleOpenCloudDriveSettings,
        },
      ],
    );
  }, [canUseOfficialCloudSource, currentProviderState?.label, currentProviderState?.provider, handleOpenBindPicker, handleOpenCloudDriveSettings, hasConfiguredProvider]);

  const refreshCloudProviderStates = useCallback(async () => {
    if (!canUseOfficialCloudSource) {
      setProviderStates([]);
      setSelectedProvider(null);
      return [];
    }
    const states = await getOfficialSceneProviderStates(scene.id);
    setProviderStates(states);
    const nextSelected = states.find((item) => item.isSelected)?.provider
      ?? scene.selectedCloudProvider
      ?? null;
    setSelectedProvider(nextSelected);
    return states;
  }, [canUseOfficialCloudSource, scene.id, scene.selectedCloudProvider]);

  const player = useVideoPlayer(resolvedPlayerSource ?? null, (videoPlayer) => {
    videoPlayer.loop = false;
    videoPlayer.showNowPlayingNotification = isBackgroundAudioEnabled;
    videoPlayer.staysActiveInBackground = isBackgroundAudioEnabled;
    videoPlayer.timeUpdateEventInterval = Platform.OS === 'android' ? 0.25 : 0.12;
    videoPlayer.playbackRate = playbackRate;
  });

  useEffect(() => {
    player.playbackRate = playbackRate;
  }, [playbackRate, player]);

  useEffect(() => {
    player.showNowPlayingNotification = isBackgroundAudioEnabled;
    player.staysActiveInBackground = isBackgroundAudioEnabled;
    import('expo-av').then(({ Audio }) => {
      Audio.setAudioModeAsync({
        allowsRecordingIOS: false,
        playsInSilentModeIOS: true,
        staysActiveInBackground: isBackgroundAudioEnabled,
      }).catch(() => {});
    }).catch(() => {});
  }, [isBackgroundAudioEnabled, player]);

  const [nativePositionSeconds, setNativePositionSeconds] = useState(clipStartSeconds);
  const nativePositionSecondsRef = useRef(clipStartSeconds);
  const lastNativePositionUpdateRef = useRef(0);
  const isSeekingRef = useRef(false);
  // 用户拖动进度条期间为 true,期间 useEffect 不滚 list(避免和显式 scroll 抢)
  const isUserScrubbingRef = useRef(false);
  // 当前已下发的 videoUri,useEffect 准备新源时若 next === current 则跳过,避免 player currentTime 被重置
  const lastDispatchedVideoUriRef = useRef<string | null>(scene.videoUri ?? null);
  const updateNativePositionSeconds = useCallback((nextSeconds: number) => {
    nativePositionSecondsRef.current = nextSeconds;
    setNativePositionSeconds(nextSeconds);
  }, []);

  const [webPositionSeconds, setWebPositionSeconds] = useState(clipStartSeconds);
  const rafRef = useRef<number | null>(null);
  useEffect(() => {
    if (Platform.OS !== 'web') return;
    const tick = () => {
      const t = player.currentTime;
      if (typeof t === 'number' && !Number.isNaN(t)) {
        setWebPositionSeconds(t);
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => { if (rafRef.current !== null) cancelAnimationFrame(rafRef.current); };
  }, [player]);

  useEffect(() => {
    void refreshCloudProviderStates();
  }, [refreshCloudProviderStates]);

  useEffect(() => {
    let active = true;
    primedRef.current = false;
    setPlayerError(null);
    setIsVideoReady(false);
    setHasStartedPlaybackOnce(false);

    if (scene.videoAsset) {
      setVideoPlaybackUri(null);
      setVideoPlaybackHeaders(undefined);
      setVideoPlaybackContentType(undefined);
      setVideoPlaybackOverrideFileExtensionAndroid(undefined);
      setIsVideoSourcePreparing(false);
      return () => {
        active = false;
      };
    }

    if (canUseOfficialCloudSource && scene.officialAssetKeys) {
      const officialAssetKeys = scene.officialAssetKeys;
      setIsVideoSourcePreparing(true);

      (async () => {
        const latestProviderStates = await getOfficialSceneProviderStates(scene.id);
        if (!active) return;
        setProviderStates(latestProviderStates);
        const latestCurrentProviderState = latestProviderStates.find((item) => item.isSelected)
          ?? (scene.selectedCloudProvider ? latestProviderStates.find((item) => item.provider === scene.selectedCloudProvider) ?? null : null);
        const latestHasConfiguredProvider = latestProviderStates.some((item) => item.isConfigured);
        const latestHasConnectedProvider = latestCurrentProviderState?.syncStatus != null && latestCurrentProviderState.syncStatus !== 'not_connected';
        const latestHasStaleProvider = latestCurrentProviderState?.syncStatus === 'stale';
        const resolved = await resolveOfficialSceneVideoSource({
          sceneId: scene.id,
          officialAssetKeys,
          providerStates: latestProviderStates,
        });
        if (!active) return;
        if (!resolved) {
          if (lastDispatchedVideoUriRef.current !== null) {
            lastDispatchedVideoUriRef.current = null;
            setVideoPlaybackUri(null);
            setVideoPlaybackHeaders(undefined);
            setVideoPlaybackContentType(undefined);
            setVideoPlaybackOverrideFileExtensionAndroid(undefined);
          }
          setPlayerError(
            latestHasStaleProvider
              ? '这条官方内容已有更新，请先在「我的」→「我的网盘」里重新扫描并同步最新版本。'
              : latestHasConfiguredProvider && !latestCurrentProviderState
                ? '你已经连接了网盘，但还没有设置推荐默认网盘。请先去「我的」→「我的网盘」完成设置。'
                : latestHasConnectedProvider
                  ? '你已经连接了网盘，但这条官方内容还没有同步到可播放状态。请先去「我的」→「我的网盘」完成同步。'
                  : '请先在「我的」→「我的网盘」里连接百度网盘。'
          );
          setIsVideoSourcePreparing(false);
          return;
        }
        setSelectedProvider(resolved.provider);
        if (lastDispatchedVideoUriRef.current !== resolved.videoUri) {
          lastDispatchedVideoUriRef.current = resolved.videoUri;
          setVideoPlaybackUri(resolved.videoUri);
          setVideoPlaybackHeaders(resolved.videoHeaders);
          setVideoPlaybackContentType(resolved.videoContentType);
          setVideoPlaybackOverrideFileExtensionAndroid(resolved.videoOverrideFileExtensionAndroid);
        }
        setPlayerError(null);
        setIsVideoSourcePreparing(false);
      })().catch((error) => {
        if (!active) return;
        if (lastDispatchedVideoUriRef.current !== null) {
          lastDispatchedVideoUriRef.current = null;
          setVideoPlaybackUri(null);
          setVideoPlaybackHeaders(undefined);
          setVideoPlaybackContentType(undefined);
          setVideoPlaybackOverrideFileExtensionAndroid(undefined);
        }
        setPlayerError(error instanceof Error ? error.message : '视频来源准备失败');
        setIsVideoSourcePreparing(false);
      });

      return () => {
        active = false;
      };
    }

    // Imported + cloud-reference: stream from cloud HLS while background
    // download+ASR runs in parallel. Playback must NOT block on the local
    // download completing.
    if (
      scene.contentOrigin === 'imported'
      && scene.selectedCloudProvider
      && scene.cloudRemotePath
    ) {
      const cloudProvider = scene.selectedCloudProvider;
      const cloudRemotePath = scene.cloudRemotePath;
      setIsVideoSourcePreparing(true);

      (async () => {
        // Prefer a fully-downloaded local cache so the player doesn't have to
        // re-fetch on every detail-page open. Otherwise fall through to the
        // streaming URL so the user can watch immediately.
        let localEntry: Awaited<ReturnType<typeof getDownloadedSceneSource>> = null;
        try {
          localEntry = await getDownloadedSceneSource(scene.id, cloudProvider);
        } catch {
          localEntry = null;
        }
        if (!active) return;
        if (localEntry?.localVideoUri && localEntry.status === 'completed') {
          if (lastDispatchedVideoUriRef.current !== localEntry.localVideoUri) {
            lastDispatchedVideoUriRef.current = localEntry.localVideoUri;
            setVideoPlaybackUri(localEntry.localVideoUri);
            setVideoPlaybackHeaders(undefined);
            setVideoPlaybackContentType(undefined);
            setVideoPlaybackOverrideFileExtensionAndroid(undefined);
          }
          setPlayerError(null);
          setIsVideoSourcePreparing(false);
          return;
        }

        // No local cache yet → use Baidu's m3u8 HLS stream so playback
        // starts immediately. The background subtitle pipeline is a
        // separate concern: it has its own download→extract→ASR flow.
        const resolved = await resolveCloudReferencedVideoSource({
          provider: cloudProvider,
          remotePath: cloudRemotePath,
        });
        if (!active) return;
        if (lastDispatchedVideoUriRef.current !== resolved.videoUri) {
          lastDispatchedVideoUriRef.current = resolved.videoUri;
          setVideoPlaybackUri(resolved.videoUri);
          setVideoPlaybackHeaders(resolved.videoHeaders);
          setVideoPlaybackContentType(resolved.videoContentType);
          setVideoPlaybackOverrideFileExtensionAndroid(resolved.videoOverrideFileExtensionAndroid);
        }
        setPlayerError(null);
        setIsVideoSourcePreparing(false);
      })().catch((error) => {
        if (!active) return;
        if (lastDispatchedVideoUriRef.current !== null) {
          lastDispatchedVideoUriRef.current = null;
          setVideoPlaybackUri(null);
          setVideoPlaybackHeaders(undefined);
          setVideoPlaybackContentType(undefined);
          setVideoPlaybackOverrideFileExtensionAndroid(undefined);
        }
        setPlayerError(error instanceof Error ? error.message : '网盘视频流解析失败');
        setIsVideoSourcePreparing(false);
      });

      return () => {
        active = false;
      };
    }

    if (!scene.videoUri) {
      setVideoPlaybackUri(null);
      setVideoPlaybackHeaders(undefined);
      setVideoPlaybackContentType(undefined);
      setVideoPlaybackOverrideFileExtensionAndroid(undefined);
      setIsVideoSourcePreparing(false);
      return () => {
        active = false;
      };
    }

    if (Platform.OS === 'web') {
      setVideoPlaybackUri(scene.videoUri ?? null);
      setVideoPlaybackHeaders(scene.videoHeaders);
      setVideoPlaybackContentType(scene.videoContentType);
      setVideoPlaybackOverrideFileExtensionAndroid(scene.videoOverrideFileExtensionAndroid);
      setIsVideoSourcePreparing(false);
      return () => {
        active = false;
      };
    }

    setIsVideoSourcePreparing(true);

    (async () => {
      const cachedUri = await getCachedVideoUri(scene.id, scene.videoUri!);
      if (!active) return;

      if (cachedUri) {
        const nextUri = cachedUri;
        if (lastDispatchedVideoUriRef.current !== nextUri) {
          lastDispatchedVideoUriRef.current = nextUri;
          setVideoPlaybackUri(nextUri);
          setVideoPlaybackHeaders(undefined);
          setVideoPlaybackContentType(undefined);
          setVideoPlaybackOverrideFileExtensionAndroid(undefined);
        }
        setIsVideoSourcePreparing(false);
        return;
      }

      const nextUri = scene.videoUri ?? null;
      if (lastDispatchedVideoUriRef.current !== nextUri) {
        lastDispatchedVideoUriRef.current = nextUri;
        setVideoPlaybackUri(nextUri);
        setVideoPlaybackHeaders(scene.videoHeaders);
        setVideoPlaybackContentType(scene.videoContentType);
        setVideoPlaybackOverrideFileExtensionAndroid(scene.videoOverrideFileExtensionAndroid);
      }
      setIsVideoSourcePreparing(false);
    })().catch(() => {
      if (!active) return;
      const nextUri = scene.videoUri ?? null;
      if (lastDispatchedVideoUriRef.current !== nextUri) {
        lastDispatchedVideoUriRef.current = nextUri;
        setVideoPlaybackUri(nextUri);
        setVideoPlaybackHeaders(scene.videoHeaders);
        setVideoPlaybackContentType(scene.videoContentType);
        setVideoPlaybackOverrideFileExtensionAndroid(scene.videoOverrideFileExtensionAndroid);
      }
      setIsVideoSourcePreparing(false);
    });

    return () => {
      active = false;
    };
  }, [canUseOfficialCloudSource, scene.id, scene.selectedCloudProvider, scene.officialAssetKeys, scene.videoAsset, scene.videoContentType, scene.videoHeaders, scene.videoOverrideFileExtensionAndroid, scene.videoUri, scene.cloudRemotePath]);

  const handleBindCloudFile = useCallback(async (file: SelectedCloudVideoFile) => {
    if (!scene.officialAssetKeys) {
      return;
    }
    await bindOfficialSceneToProvider({
      sceneId: scene.id,
      provider: file.provider,
      officialVideoKey: scene.officialAssetKeys.videoKey,
      remotePath: file.remotePath,
      remoteFileId: file.remoteFileId,
    });
    setIsBindPickerVisible(false);
    await onRefreshScene?.(true);
    await refreshCloudProviderStates();
    Alert.alert('绑定成功', `已绑定到${file.provider === 'baidu_pan' ? '百度网盘' : '云盘'}，后续会按当前默认网盘来源播放。`);
  }, [onRefreshScene, refreshCloudProviderStates, scene.id, scene.officialAssetKeys]);

  const handleRefreshCloudSourceStatus = useCallback(async () => {
    if (isRefreshingCloudSourceStatus) {
      return;
    }
    setIsRefreshingCloudSourceStatus(true);
    try {
      await onRefreshScene?.(true);
      await refreshCloudProviderStates();
    } finally {
      setIsRefreshingCloudSourceStatus(false);
    }
  }, [isRefreshingCloudSourceStatus, onRefreshScene, refreshCloudProviderStates]);

  useEffect(() => {
    setIsVideoReady(false);
    setHasStartedPlaybackOnce(false);
    updateNativePositionSeconds(clipStartSeconds);
  }, [clipStartSeconds, scene.id, updateNativePositionSeconds]);

  useEffect(() => {
    if (Platform.OS !== 'web' || typeof document === 'undefined') return;
    const handleFullscreenChange = () => {
      const nextFullscreen = Boolean(document.fullscreenElement);
      setIsFullscreen(nextFullscreen);
      if (nextFullscreen) {
        void requestLandscapeOrientationLock();
      } else {
        releaseOrientationLock();
      }
    };
    document.addEventListener('fullscreenchange', handleFullscreenChange);
    return () => document.removeEventListener('fullscreenchange', handleFullscreenChange);
  }, []);

  useEffect(() => {
    if (!isFullscreen) {
      setIsFullscreenHudVisible(true);
      setIsFullscreenTranslationPeekVisible(false);
      if (fullscreenHudTimeoutRef.current) {
        clearTimeout(fullscreenHudTimeoutRef.current);
        fullscreenHudTimeoutRef.current = null;
      }
      return;
    }
    setIsFullscreenHudVisible(true);
    setFullscreenHudRefreshTick((tick) => tick + 1);
  }, [isFullscreen]);

  useEffect(() => {
    if (fullscreenHudTimeoutRef.current) {
      clearTimeout(fullscreenHudTimeoutRef.current);
      fullscreenHudTimeoutRef.current = null;
    }
    if (!isFullscreen || !isFullscreenHudVisible || !isPlaying) return;
    fullscreenHudTimeoutRef.current = setTimeout(() => {
      setIsFullscreenHudVisible(false);
    }, 2400);
    return () => {
      if (fullscreenHudTimeoutRef.current) {
        clearTimeout(fullscreenHudTimeoutRef.current);
        fullscreenHudTimeoutRef.current = null;
      }
    };
  }, [fullscreenHudRefreshTick, isFullscreen, isFullscreenHudVisible, isPlaying]);

  const positionSeconds = Platform.OS === 'web' ? webPositionSeconds : nativePositionSeconds;

  const activeSegmentIndex = useMemo(() => {
    return findActiveSegmentIndex(Math.round(positionSeconds * 1000), scene.segments);
  }, [positionSeconds, scene.segments]);

  useEffect(() => {
    setIsFullscreenTranslationPeekVisible(false);
  }, [activeSegmentIndex, fullscreenTranslationMode]);

  const activeSegment = scene.segments[activeSegmentIndex] ?? scene.segments[0] ?? EMPTY_SEGMENT;
  const shadowingSegment = scene.segments[shadowingSegmentIndex ?? activeSegmentIndex] ?? activeSegment;
  const activeStartSeconds = (activeSegment?.startMs ?? 0) / 1000;
  const activeEndSeconds = (activeSegment?.endMs ?? scene.durationSeconds * 1000) / 1000;
  const shadowingStartSeconds = (shadowingSegment?.startMs ?? activeSegment?.startMs ?? 0) / 1000;
  const shadowingEndSeconds = (shadowingSegment?.endMs ?? activeSegment?.endMs ?? scene.durationSeconds * 1000) / 1000;
  // KB is now SQLite-backed. Two derived maps keep UI lookups O(1):
  //   - sentenceCardBySegmentId: which segments have a sentence card
  //   - wordCardByNormalized: which words (by lowercased form) have a card
  const sentenceCardBySegmentId = useMemo(() => {
    const map = new Map<string, any>();
    for (const c of sentenceCards) {
      const segId = c.videoContext?.segmentId;
      if (segId) map.set(segId, c);
    }
    return map;
  }, [sentenceCards]);

  const wordCardByNormalized = useMemo(() => {
    const map = new Map<string, any>();
    for (const c of wordCards) {
      const key = (c.content ?? '').toLowerCase();
      if (key) map.set(key, c);
    }
    return map;
  }, [wordCards]);

  // Map segmentId → index in scene.segments, used by the 句子 tab to seek
  // to the original subtitle position when the user taps a sentence card.
  const segmentIndexById = useMemo(
    () => new Map(scene.segments.map((segment, index) => [segment.id, index])),
    [scene.segments],
  );

  // Sentence cards backed by segments for the subtitle list / 句子 tab.
  const sentenceSegments = useMemo(() => {
    const ids = new Set(sentenceCardBySegmentId.keys());
    return scene.segments.filter((s) => ids.has(s.id));
  }, [scene.segments, sentenceCardBySegmentId]);

  // Drives the empty / filled star on the dictionary sheet's top bar.
  // We match on the user-tapped form OR the dictionary's normalized form
  // so first-render state is reasonable before the result settles.
  const isCurrentLookupSaved = useMemo(() => {
    if (!lookupWord) return false;
    const key = lookupWord.trim().toLowerCase();
    if (wordCardByNormalized.has(key)) return true;
    return wordCards.some((c) => (c.content ?? '') === lookupWord);
  }, [wordCardByNormalized, wordCards, lookupWord]);
  const displayedPositionSeconds = scrubRatio !== null
    ? clipStartSeconds + scrubRatio * Math.max(effectiveClipEndSeconds - clipStartSeconds, 0)
    : positionSeconds;
  const hasSubtitleSegments = scene.segments.length > 0;
  const isImportedCloudReference = scene.contentOrigin === 'imported' && !scene.videoUri && !!scene.selectedCloudProvider;
  const emptySubtitleTitle = scene.subtitleStatus === 'processing'
    ? '字幕生成中'
    : scene.subtitleStatus === 'error'
      ? '字幕生成失败'
      : scene.subtitleStatus === 'pending'
        ? '等待生成字幕'
        : '暂未生成字幕';
  const isImportedCloudVideo = scene.contentOrigin === 'imported' && !!scene.selectedCloudProvider;
  const emptySubtitleText = scene.subtitleStatus === 'processing'
    ? isImportedCloudVideo
      ? '正在为这个网盘视频生成字幕，请保持网络畅通，生成完成后会缓存到本地。'
      : '正在为这个本地视频生成字幕，请稍后回来查看。'
    : scene.subtitleStatus === 'error'
      ? '这次字幕生成没有成功，你可以稍后重新触发生成。'
      : isImportedCloudVideo
        ? '这个网盘视频可以先在线播放，字幕生成完成后会缓存到本地并显示在这里。'
        : '这个视频现在可以直接播放，字幕生成完成后会显示在这里。';
  const shouldRotateFullscreen = isFullscreen && viewportHeight > viewportWidth;
  const fullscreenShortEdge = Math.min(viewportWidth, viewportHeight);
  const fullscreenSubtitleMetrics = useMemo(
    () => getFullscreenSubtitleMetrics(activeSegment.text, fullscreenShortEdge),
    [activeSegment.text, fullscreenShortEdge]
  );
  const fullscreenTranslationMetrics = useMemo(
    () => getFullscreenTranslationMetrics(activeSegment.textZh, fullscreenShortEdge),
    [activeSegment.textZh, fullscreenShortEdge]
  );
  const fullscreenFrameWidth = shouldRotateFullscreen ? viewportHeight : viewportWidth;
  const fullscreenSubtitleBottomInset = useMemo(() => {
    const safeBottom = Math.max(insets.bottom + 10, 14);
    if (!isFullscreenHudVisible) {
      return safeBottom;
    }
    if (fullscreenHudBottomHeight > 0) {
      return fullscreenHudBottomHeight + 12;
    }
    return safeBottom + Math.min(Math.round(fullscreenShortEdge * 0.22), 112);
  }, [fullscreenHudBottomHeight, fullscreenShortEdge, insets.bottom, isFullscreenHudVisible]);
  const fullscreenSubtitleWrapStyle = useMemo(() => ({
    paddingBottom: fullscreenSubtitleBottomInset,
  }), [fullscreenSubtitleBottomInset]);
  const fullscreenSubtitleCardStyle = useMemo(() => ({
    width: Math.min(Math.round(fullscreenFrameWidth * 0.76), 860),
    maxWidth: Math.min(Math.round(fullscreenFrameWidth * 0.76), 860),
  }), [fullscreenFrameWidth]);

  // Reload cards for the current video. Triggered on mount, when scene.id
  // changes, and after any create/delete that mutates the FSRS set.
  const loadVideoCards = useCallback(async () => {
    const [words, sentences, wDue, sDue] = await Promise.all([
      getCardsByVideo(scene.id, 'word'),
      getCardsByVideo(scene.id, 'sentence'),
      getDueCardCountByVideo(scene.id, 'word'),
      getDueCardCountByVideo(scene.id, 'sentence'),
    ]);
    setWordCards(words);
    setSentenceCards(sentences);
    setDueWordCount(wDue);
    setDueSentenceCount(sDue);
  }, [scene.id]);

  useEffect(() => {
    let active = true;
    setSubtitlePanelTab('subtitles');
    loadVideoCards().catch(() => {
      // best-effort; UI can recover on next interaction
    });
    return () => {
      active = false;
    };
  }, [loadVideoCards]);

  useEffect(() => {
    setShadowingLiveTranscript('');
    setShadowingDiffResult(null);
  }, [activeSegment?.id]);

  useEffect(() => {
    return () => {
      const handle = shadowingAsrRef.current;
      shadowingAsrRef.current = null;
      if (handle) {
        handle.stop().catch(() => {});
      }
    };
  }, []);

  // 累计 content 总高度,onContentSizeChange 时更新。用于按比例估算任意 index 的 y
  const totalContentHeightRef = useRef(0);
  const handleContentSizeChange = useCallback((_w: number, h: number) => {
    totalContentHeightRef.current = h;
  }, []);

  // RN 文档标准答案:提供 getItemLayout 后,scrollToIndex/scrollToOffset 都能跨任意 index 滚
  // item 高度不固定(中英文字数 + 换行差异),给个保守均值 120,差几像素不影响功能
  const SEGMENT_ITEM_HEIGHT = 120;
  const SEGMENT_LIST_GAP = 10;
  const getItemLayout = useCallback((_data: ArrayLike<VideoSceneSegment> | null | undefined, index: number) => ({
    length: SEGMENT_ITEM_HEIGHT,
    offset: (SEGMENT_ITEM_HEIGHT + SEGMENT_LIST_GAP) * index,
    index,
  }), []);

  const scrollToSegmentIndex = useCallback((index: number, animated = false) => {
    if (!scrollRef.current) {
      return;
    }

    // 主链路:scrollToIndex + getItemLayout → RN 文档保证能跨任意 index 滚(不再受 window 限制)
    if (scene.segments.length > 0) {
      try {
        scrollRef.current.scrollToIndex({ index, animated, viewPosition: 0.35 });
        return;
      } catch {
        // fall through to ratio fallback below
      }
    }

    // 兜底 1:按 totalContentHeight 比例算 offset(冷启动或 getItemLayout 失效)
    const total = scene.segments.length;
    if (total > 0) {
      const totalH = totalContentHeightRef.current;
      let targetOffset: number;
      if (totalH > 0) {
        const ratio = total === 1 ? 0 : index / (total - 1);
        targetOffset = Math.max(0, totalH * ratio - 60);
      } else {
        targetOffset = Math.max(0, index * (SEGMENT_ITEM_HEIGHT + SEGMENT_LIST_GAP) - 60);
      }
      scrollRef.current.scrollToOffset({ offset: targetOffset, animated });
    }
  }, [scene.segments.length, SEGMENT_ITEM_HEIGHT, SEGMENT_LIST_GAP]);

  // 字幕跟随 playhead:positionSeconds 变 → activeSegmentIndex 变 → list 滚
  // 用户拖动期间跳过(显式 scroll 已经在 handleScrubComplete 里做了)
  useEffect(() => {
    if (isUserScrubbingRef.current) {
      return;
    }
    scrollToSegmentIndex(activeSegmentIndex, false);
  }, [activeSegmentIndex, scrollToSegmentIndex]);

  useFocusEffect(
    useCallback(() => {
      return () => {
        pausePlayerSafely(player);
      };
    }, [player])
  );

  // Accept ?t=<ms> as an entry point from the review screen so a favorited
  // card can jump the player straight to the line that produced it. We
  // capture the target exactly once in a dedicated effect (rather than
  // during render) so the dev double-invoke can't trip React's
  // "fewer hooks than expected" check.
  const params = useLocalSearchParams<{ id: string; t?: string }>();
  const pendingSeekMsRef = useRef<number | null>(null);
  useEffect(() => {
    if (pendingSeekMsRef.current !== null) return;
    if (!params.t) return;
    const ms = Number(params.t);
    if (Number.isFinite(ms) && ms >= 0) {
      pendingSeekMsRef.current = ms;
    } else {
      pendingSeekMsRef.current = -1; // sentinel: invalid, ignore forever
    }
  }, [params.t]);
  useEffect(() => {
    if (pendingSeekMsRef.current === null || pendingSeekMsRef.current < 0) return;
    if (!isVideoReady || !resolvedPlayerSource) return;
    const ms = pendingSeekMsRef.current;
    pendingSeekMsRef.current = null;
    try {
      player.currentTime = ms / 1000;
      player.play();
    } catch {
      // ignore — player may be tearing down
    }
  }, [isVideoReady, resolvedPlayerSource, player]);

  const getSegmentRepeatRange = useCallback((index: number) => {
    const segment = scene.segments[index];
    if (!segment) return null;
    return {
      startSeconds: segment.startMs / 1000,
      endSeconds: segment.endMs / 1000,
    };
  }, [scene.segments]);

  const clearRepeatSentence = useCallback(() => {
    setRepeatSentence(false);
    setLockedRepeatRange(null);
  }, []);

  const handleToggleRepeatSentence = useCallback(() => {
    if (repeatSentence) {
      clearRepeatSentence();
      return;
    }
    const nextRange = getSegmentRepeatRange(activeSegmentIndex);
    if (!nextRange) return;
    setLockedRepeatRange(nextRange);
    setRepeatSentence(true);
  }, [activeSegmentIndex, clearRepeatSentence, getSegmentRepeatRange, repeatSentence]);

  useEffect(() => {
    const statusSub = player.addListener('statusChange', (event: any) => {
      const nextStatus = String(event?.status ?? player.status ?? 'unknown');
      const nextError = event?.error?.message ?? (typeof event?.error === 'string' ? event.error : null);
      console.log('[VideoScene] player status change', {
        sceneId: scene.id,
        status: nextStatus,
        error: nextError,
      });
      if (nextError) {
        setPlayerError(nextError);
        setIsVideoReady(false);
        return;
      }
      if (nextStatus === 'readyToPlay') {
        setIsVideoReady(true);
        setPlayerError(null);
        // seek 完成兜底：readyToPlay 意味着 seek 已落地，解冻位置更新
        isSeekingRef.current = false;
        if (scene.clipEndMs == null) {
          const actualDuration = typeof player.duration === 'number' && !Number.isNaN(player.duration) && player.duration > 0
            ? player.duration
            : 0;
          if (actualDuration > 0) {
            setDurationSeconds(actualDuration);
          }
        }
        if (!primedRef.current) {
          primedRef.current = true;
          player.currentTime = clipStartSeconds;
        }
      }
    });

    const playingSub = player.addListener('playingChange', (event: any) => {
      const nextPlaying = Boolean(event?.isPlaying ?? event?.playing ?? player.playing);
      setIsPlaying(nextPlaying);
      if (nextPlaying) {
        setHasStartedPlaybackOnce(true);
        if (practicedRecordedSceneIdRef.current !== scene.id) {
          practicedRecordedSceneIdRef.current = scene.id;
          void markVideoScenePracticed(scene.id).catch(() => {});
        }
      }
    });

    const timeSub = player.addListener('timeUpdate', (event: any) => {
      const nextCurrentTime = typeof event?.currentTime === 'number' ? event.currentTime : player.currentTime;
      const nextDuration = typeof player.duration === 'number' && !Number.isNaN(player.duration) && player.duration > 0
        ? player.duration
        : scene.durationSeconds;
      setDurationSeconds((prev) => (Math.abs(prev - nextDuration) > 0.25 ? nextDuration : prev));
      if (Platform.OS !== 'web') {
        // seek 保护：seek 落地前，timeUpdate 仍会报旧位置，忽略掉避免 activeSegmentIndex 打回旧处
        if (isSeekingRef.current) {
          // 当 player 报告的位置已经追上我们 seek 的目标（误差 0.5s 内），认为 seek 完成
          if (Math.abs(nextCurrentTime - nativePositionSecondsRef.current) <= 0.5) {
            isSeekingRef.current = false;
          } else {
            return; // seek 尚未落地，跳过此次 timeUpdate
          }
        }
        const now = Date.now();
        if (now - lastNativePositionUpdateRef.current >= 220 || Math.abs(nextCurrentTime - nativePositionSecondsRef.current) >= 0.35) {
          lastNativePositionUpdateRef.current = now;
          updateNativePositionSeconds(nextCurrentTime);
        }
      }

      const shadowingReplayRange = shadowingReplayRangeRef.current;
      const shadowingReplayEnd = shadowingReplayRange?.endSeconds ?? null;
      const effectiveEnd = shadowingReplayEnd ?? (repeatSentence ? (lockedRepeatRange?.endSeconds ?? activeEndSeconds) : effectiveClipEndSeconds);
      const rewindStart = repeatSentence && shadowingReplayEnd === null
        ? (lockedRepeatRange?.startSeconds ?? activeStartSeconds)
        : clipStartSeconds;
      if (player.playing && shadowingReplayEnd !== null && nextCurrentTime >= shadowingReplayEnd) {
        pausePlayerSafely(player);
        player.currentTime = shadowingReplayEnd;
        shadowingReplayRangeRef.current = null;
        return;
      }
      if (player.playing && nextCurrentTime >= effectiveEnd) {
        if (repeatSentence && shadowingReplayEnd === null) {
          player.currentTime = rewindStart;
          return;
        }
        pausePlayerSafely(player);
        player.currentTime = effectiveEnd;
        shadowingReplayRangeRef.current = null;
      }
    });

    return () => {
      statusSub.remove();
      playingSub.remove();
      timeSub.remove();
    };
  }, [activeEndSeconds, activeStartSeconds, clipStartSeconds, effectiveClipEndSeconds, lockedRepeatRange, player, repeatSentence, scene.clipEndMs, scene.durationSeconds, scene.id, updateNativePositionSeconds]);

  const handleCloseVideoAiPicker = useCallback(() => {
    setIsVideoAiPickerVisible(false);
  }, []);

  const handleSelectVideoAiCard = useCallback(async (card: ScenarioCard) => {
    pausePlayerSafely(player);
    if (scene) {
      const snapshot = buildAiPracticeTopicSnapshot({
        card,
        origin: 'video',
        sourceType: scene.contentOrigin === 'imported' ? 'imported_video' : 'official_video',
        sourceLabel: scene.contentOrigin === 'imported' ? '跟练话题' : '推荐视频',
        sourceId: scene.id,
        sceneTitle: scene.card.title,
        importSourceLabel: scene.contentOrigin === 'imported' ? scene.sourceLabel : undefined,
      });
      await markAiPracticeTopicUsed(snapshot);
      await selectScenario(snapshot.card);
      setIsVideoAiPickerVisible(false);
      router.push(`/scenario/immersive/${snapshot.card.id}`);
      return;
    }
    await selectScenario(card);
    setIsVideoAiPickerVisible(false);
    router.push(`/scenario/immersive/${card.id}`);
  }, [player, router, scene]);

  const applyVideoAiGenerationSnapshot = useCallback((generationState: VideoAiPracticeGenerationState | null, fallbackCards: ScenarioCard[] = []) => {
    const nextCards = filterValidAiCards(generationState?.cards?.length ? generationState.cards : fallbackCards);
    setVideoAiPickerCards(nextCards);
    setVideoAiGenerationStatus(generationState?.status ?? 'idle');
    setVideoAiGenerationError(generationState?.errorMessage ?? null);
    setIsGeneratingVideoAiPractice(generationState?.status === 'generating');
    setVideoAiProgressText(generationState?.progressText ?? '当前还没有 AI陪练主题');
    setVideoAiStreamParsedCount(generationState?.parsedCount ?? nextCards.length);
    setVideoAiStreamTargetCount(generationState?.targetCount ?? 0);
  }, [filterValidAiCards]);

  // Map a user-video AI practice state onto the playback page's
  // existing VideoAiPracticeGenerationStatus shape so the picker
  // UI doesn't have to branch on the underlying data source. The
  // mapping collapses both `processing` phases into 'generating',
  // and treats `ready` / `idle` / null all as 'idle' until the
  // caller refreshes from disk (the user-video load path handles
  // that).
  const applyUserVideoAiSnapshot = useCallback((
    state: { status: 'idle' | 'processing' | 'ready' | 'error'; progressText?: string; errorMessage?: string; parsedCount?: number; targetCount?: number } | null,
    fallbackCards: ScenarioCard[] = [],
  ) => {
    const nextCards = filterValidAiCards(fallbackCards);
    const mapped: VideoAiPracticeGenerationStatus =
      state?.status === 'processing' ? 'generating'
      : state?.status === 'ready' ? 'completed'
      : state?.status === 'error' ? 'failed'
      : 'idle';
    setVideoAiPickerCards(nextCards);
    setVideoAiGenerationStatus(mapped);
    setVideoAiGenerationError(state?.errorMessage ?? null);
    setIsGeneratingVideoAiPractice(mapped === 'generating');
    setVideoAiProgressText(state?.progressText ?? '当前还没有 AI陪练主题');
    setVideoAiStreamParsedCount(state?.parsedCount ?? nextCards.length);
    setVideoAiStreamTargetCount(state?.targetCount ?? 0);
  }, [filterValidAiCards]);

  const syncVideoAiPracticeState = useCallback(async (targetScene: VideoSceneDetail) => {
    // User-managed imported scenes (百度网盘 / 本地导入) share
    // the entry-based user-video-ai-practice storage. The scene
    // id IS the user-video entry id (`user_video_<timestamp>_<hash>`),
    // so we route through the entry pipeline. This keeps the
    // collection-detail page's "AI 话题" chip in sync with
    // whatever the player just generated.
    if (isUserManagedImportedScene(targetScene)) {
      const cards = filterValidAiCards(await loadGeneratedUserVideoAiPracticeCards(targetScene.id));
      const state = await getUserVideoAiPracticeState(targetScene.id);
      applyUserVideoAiSnapshot(state, cards);
      return {
        cards,
        generationState: state
          ? {
              sceneId: targetScene.id,
              status: state.status === 'processing' ? 'generating' : state.status === 'ready' ? 'completed' : state.status === 'error' ? 'failed' : 'idle',
              progressText: state.progressText ?? '',
              parsedCount: state.parsedCount,
              targetCount: state.targetCount,
              cards: state.cards.length > 0 ? state.cards : cards,
              errorMessage: state.errorMessage,
              updatedAt: state.updatedAt,
            }
          : null,
      };
    }
    const builtInCards = filterValidAiCards(targetScene.aiPracticeCards);
    const generatedCards = builtInCards.length > 0 ? builtInCards : filterValidAiCards(await loadGeneratedVideoAiPracticeCards(targetScene.id));
    const generationState = await getVideoAiPracticeGenerationState(targetScene.id);
    applyVideoAiGenerationSnapshot(generationState, generatedCards);
    return {
      cards: generationState?.cards?.length ? filterValidAiCards(generationState.cards) : generatedCards,
      generationState,
    };
  }, [applyUserVideoAiSnapshot, applyVideoAiGenerationSnapshot, filterValidAiCards]);

  const handleStartGenerateVideoAiPractice = useCallback(async (excludeTitles?: string[]) => {
    setIsVideoAiPickerVisible(true);
    if (videoAiGenerationStatus === 'generating') {
      return;
    }
    setVideoAiGenerationError(null);
    setVideoAiGenerationStatus('generating');
    setIsGeneratingVideoAiPractice(true);
    setVideoAiProgressText('正在准备生成 AI陪练...');
    // For regeneration, the previous run's titles get carried
    // over to the LLM as "avoid these" context. For a fresh
    // first run, pass the currently-displayed titles too — they're
    // the same titles the user will see when they hit "换一组",
    // so feeding them in keeps the regen logic consistent.
    const previousTitles = excludeTitles ?? videoAiPickerCards.map((c) => c.title);
    setVideoAiStreamParsedCount(0);
    setVideoAiStreamTargetCount(0);
    try {
      // User-managed imported scenes route through the
      // entry-based user-video pipeline. The user-video-ai-practice
      // module is the single source of truth for these entries,
      // so the collection-detail page's "AI 话题" chip and the
      // picker here stay in sync.
      if (isUserManagedImportedScene(scene)) {
        const cards = filterValidAiCards(
          await generateUserVideoAiPracticeCards(scene.id, { excludeTitles: previousTitles }),
        );
        setVideoAiPickerCards(cards);
        setVideoAiGenerationStatus('completed');
        setVideoAiGenerationError(null);
        setVideoAiStreamParsedCount(cards.length);
        setVideoAiStreamTargetCount(cards.length);
        return;
      }
      const availableCards = filterValidAiCards(await generateVideoAiPracticeCards(scene, {
        excludeTitles: previousTitles,
        onProgress: (message) => {
          setVideoAiProgressText(message);
        },
        onStreamUpdate: ({ cards, parsedCount, targetCount }) => {
          setVideoAiPickerCards(filterValidAiCards(cards));
          setVideoAiStreamParsedCount(parsedCount);
          setVideoAiStreamTargetCount(targetCount);
        },
      }));
      setVideoAiPickerCards(availableCards);
      setVideoAiGenerationStatus('completed');
      setVideoAiGenerationError(null);
    } catch (error) {
      setVideoAiGenerationStatus('failed');
      setVideoAiGenerationError(error instanceof Error ? error.message : 'AI陪练生成失败');
      Alert.alert('生成失败', error instanceof Error ? error.message : 'AI陪练生成失败，请稍后重试');
    } finally {
      setIsGeneratingVideoAiPractice(false);
    }
  }, [filterValidAiCards, scene, videoAiGenerationStatus, videoAiPickerCards]);

  // Regenerate with a fresh batch — feed the currently-displayed
  // titles back to the LLM as "avoid these" so the new set leans
  // into fresh angles instead of re-running near-duplicates.
  const handleRegenerateVideoAiPractice = useCallback(() => {
    void handleStartGenerateVideoAiPractice(videoAiPickerCards.map((c) => c.title));
  }, [handleStartGenerateVideoAiPractice, videoAiPickerCards]);

  const handleOpenVideoAiPractice = useCallback(async () => {
    setIsVideoAiPickerVisible(true);
    await syncVideoAiPracticeState(scene);
  }, [scene, syncVideoAiPracticeState]);

  useEffect(() => {
    let active = true;
    void syncVideoAiPracticeState(scene);
    // Subscribe on the same axis the data lives on. User-managed
    // imported scenes drive off the entry-based pipeline; the
    // collection-detail page's "AI 话题" chip is the same listener
    // so progress / completion shows up in both UIs.
    const unsubscribe = isUserManagedImportedScene(scene)
      ? subscribeUserVideoAiPracticeState(scene.id, (state) => {
          if (!active) return;
          applyUserVideoAiSnapshot(state, state?.cards ?? []);
        })
      : subscribeVideoAiPracticeGenerationState(scene.id, (generationState) => {
          if (!active) {
            return;
          }
          applyVideoAiGenerationSnapshot(generationState, generationState?.cards ?? []);
        });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [applyVideoAiGenerationSnapshot, scene, syncVideoAiPracticeState]);

  const isPlaybackEnded = positionSeconds >= effectiveClipEndSeconds - 0.2;

  const restartPlaybackFromStart = useCallback(() => {
    if (!resolvedPlayerSource || !isVideoReady) return;
    shadowingReplayRangeRef.current = null;
    if (Platform.OS !== 'web') {
      isSeekingRef.current = true;
      updateNativePositionSeconds(clipStartSeconds);
    }
    player.currentTime = clipStartSeconds;
    setTimeout(() => {
      try {
        player.play();
      } catch {
      }
    }, Platform.OS === 'android' ? 60 : 0);
  }, [clipStartSeconds, isVideoReady, player, resolvedPlayerSource, updateNativePositionSeconds]);

  const handleTogglePlayback = () => {
    if (!isVideoReady || !resolvedPlayerSource) return;
    if (isPlaying) {
      pausePlayerSafely(player);
      return;
    }
    if (isPlaybackEnded) {
      restartPlaybackFromStart();
      return;
    }
    player.play();
  };

  const handleReplaySentence = () => {
    if (!isVideoReady || !resolvedPlayerSource) return;
    const nextSeconds = repeatSentence
      ? (lockedRepeatRange?.startSeconds ?? activeStartSeconds)
      : activeStartSeconds;
    if (Platform.OS !== 'web') {
      isSeekingRef.current = true;
      updateNativePositionSeconds(nextSeconds);
    }
    player.currentTime = nextSeconds;
    player.play();
  };

  const handleSeekSentence = useCallback((index: number) => {
    const segment = scene.segments[index];
    if (!segment) return;
    const nextSeconds = segment.startMs / 1000;
    const nextRange = getSegmentRepeatRange(index);
    if (!resolvedPlayerSource) return;
    if (repeatSentence) {
      setLockedRepeatRange(nextRange);
    }
    if (Platform.OS !== 'web') {
      isSeekingRef.current = true;
      updateNativePositionSeconds(nextSeconds);
    }
    player.currentTime = nextSeconds;
    if (isVideoReady) {
      player.play();
    }
  }, [getSegmentRepeatRange, isVideoReady, player, repeatSentence, resolvedPlayerSource, scene.segments, updateNativePositionSeconds]);

  const handlePlaySegmentOnce = useCallback((index: number) => {
    const nextRange = getSegmentRepeatRange(index);
    if (!nextRange || !resolvedPlayerSource || !isVideoReady) return;
    shadowingReplayRangeRef.current = nextRange;
    if (Platform.OS !== 'web') {
      isSeekingRef.current = true;
      updateNativePositionSeconds(nextRange.startSeconds);
    }
    player.currentTime = nextRange.startSeconds;
    player.play();
  }, [getSegmentRepeatRange, isVideoReady, player, resolvedPlayerSource, updateNativePositionSeconds]);

  const handleMeasureSegment = useCallback((index: number, y: number) => {
    segmentYPositions.current[index] = y;
  }, []);

  // Toggles a sentence card in FSRS for the given segment. The star UI on
  // both the subtitle card and the dictionary sheet's "当前字幕" box goes
  // through this — they reflect the same SQLite state.
  const handleToggleSentenceCard = useCallback(async (segmentId: string) => {
    if (!segmentId) return;
    const seg = scene.segments.find((s) => s.id === segmentId);
    const existing = sentenceCardBySegmentId.get(segmentId);
    if (existing) {
      // Also clean up any cached clip when the card is removed
      void deleteClipSegment(scene.id, segmentId);
      await deleteCard(existing.id);
    } else if (seg) {
      const sourceUrl = videoPlaybackUri ?? scene.videoUri ?? null;
      console.log('[ToggleSentenceCard] saving', {
        segmentId,
        startMs: seg.startMs,
        endMs: seg.endMs,
        sourceUrl: sourceUrl?.slice(0, 120) ?? null,
      });

      // 判断本地缓存:
      //   1. videoPlaybackUri 在官方云盘下载完成 / imported 场景本地路径下会指向 file://.../cloud-video-cache/...
      //      (resolveOfficialSceneVideoSource 内部已经 hasPlayableLocalCache 校验过,放心用)
      //   2. 否则 fallback 到 getCachedVideoUri (lib/video-cache.ts 的老 video-cache/ 目录,本地 expo-file-system 缓存)
      // 远端 HLS (http://...?method=streaming) ffmpeg 解析不了(百度网盘分片 URL 带 query,被 allowed_segment_extensions 拒),
      // 所以未下载的句子卡片只存 coverUri,等用户下载后再补 thumb/clip
      let ffmpegSourceUri: string | null = null;
      if (videoPlaybackUri && videoPlaybackUri.startsWith('file://')) {
        ffmpegSourceUri = videoPlaybackUri;
      } else if (scene.videoUri) {
        const cachedLocalUri = await getCachedVideoUri(scene.id, scene.videoUri);
        if (cachedLocalUri) {
          ffmpegSourceUri = cachedLocalUri;
        }
      }
      const isLocalCached = !!ffmpegSourceUri;
      console.log('[ToggleSentenceCard] source resolution', {
        isLocalCached,
        ffmpegSourceUri: ffmpegSourceUri ? ffmpegSourceUri.slice(0, 80) : null,
        playbackSourceUrl: sourceUrl?.slice(0, 80) ?? null,
      });

      let thumbUri: string | undefined;
      let clipUri: string | undefined;
      let needDownloadHint = false;

      if (isLocalCached && ffmpegSourceUri) {
        // 本地缓存命中,走 ffmpeg
        if (typeof seg.startMs === 'number') {
          const captured = await getOrCreateClipThumb(
            scene.id,
            segmentId,
            ffmpegSourceUri,
            seg.startMs + 200,
          );
          thumbUri = captured ?? undefined;
          console.log('[ToggleSentenceCard] thumbUri', { thumbUri: thumbUri ?? null });
        }
        if (typeof seg.startMs === 'number' && typeof seg.endMs === 'number') {
          const clipped = await extractVideoClip({
            videoId: scene.id,
            segmentId,
            sourceUri: ffmpegSourceUri,
            startMs: seg.startMs,
            endMs: seg.endMs,
          });
          clipUri = clipped ?? undefined;
          console.log('[ToggleSentenceCard] clipUri', { clipUri: clipUri ?? null });
        }
      } else if (sourceUrl) {
        // 远端 HLS,跳过 ffmpeg,卡片照建,提示用户下载到本地
        needDownloadHint = true;
        console.log('[ToggleSentenceCard] remote HLS, skip ffmpeg (no local cache)');
      }

      await createCard({
        type: 'sentence',
        source: 'video',
        content: seg.text,
        translation: seg.textZh ?? '',
        videoContext: {
          videoId: scene.id,
          sceneId: scene.id,
          segmentId,
          startMs: seg.startMs,
          endMs: seg.endMs,
          coverUri: scene.coverImageUri ?? undefined,
          thumbUri,
          clipUri,
        },
      });

      if (needDownloadHint) {
        if (Platform.OS === 'android') {
          ToastAndroid.show(
            '已加入 FSRS,下载视频到本地后可补封面截图',
            ToastAndroid.SHORT,
          );
        } else {
          Alert.alert(
            '已加入 FSRS',
            '视频尚未下载到本地,卡片中暂不包含封面截图和小段视频。下载视频到本地后,重新收藏即可补上。',
          );
        }
      }
    }
    await loadVideoCards();
  }, [scene, sentenceCardBySegmentId, loadVideoCards, videoPlaybackUri]);

  const handleWordPress = useCallback((word: WordTiming, segmentText: string, segmentId?: string) => {
    wasPlayingBeforeLookupRef.current = isPlaying;
    pausePlayerSafely(player);
    setLookupContext(segmentText);
    setLookupWord(word.text);
    setLookupSegmentId(segmentId ?? null);
    // DictionaryLookupSheet is now responsible for showing the dictionary
    // and (optionally) collecting a manual "save to 单词 list" tap. We do
    // NOT auto-write the lookup history here — that broke the user
    // expectation that tapping a word is just a "look it up" gesture.
  }, [isPlaying, player]);

  // Toggle a word card in FSRS. The dictionary sheet's top-bar star goes
  // through this. `translation` is captured at toggle time from the
  // DictionaryResult so the card content is self-contained for review.
  const handleSaveWordToHistory = useCallback(async (payload: {
    queryWord: string;
    normalized: string;
    displayWord: string;
    contextSentence: string;
    segmentId: string | null;
    translation?: string;
  }, nextSaved: boolean) => {
    if (!payload.normalized) return;
    const existing = wordCardByNormalized.get(payload.normalized.toLowerCase());
    if (!nextSaved) {
      if (existing) {
        await deleteCard(existing.id);
        await loadVideoCards();
      }
      return;
    }
    if (existing) {
      // Already saved — no-op. (Translation backfill is intentionally not
      // done here — the card already has whatever the user saved the first
      // time around.)
      return;
    }
    const seg = scene.segments.find((s) => s.id === payload.segmentId);
    await createCard({
      type: 'word',
      source: 'video',
      content: payload.displayWord || payload.queryWord,
      translation: payload.translation ?? '',
      videoContext: {
        videoId: scene.id,
        sceneId: scene.id,
        segmentId: payload.segmentId ?? undefined,
        startMs: seg?.startMs,
        endMs: seg?.endMs,
        coverUri: scene.coverImageUri ?? undefined,
      },
    });
    await loadVideoCards();
  }, [scene, wordCardByNormalized, loadVideoCards]);

  /**
   * Toggles the sentence card for the segment that the current lookup came
   * from. Used by the dictionary sheet's "当前字幕" star so users can
   * favorite the whole sentence without closing the sheet.
   */
  const handleToggleSentenceFromLookup = useCallback(async () => {
    if (!lookupSegmentId) return;
    await handleToggleSentenceCard(lookupSegmentId);
  }, [lookupSegmentId, handleToggleSentenceCard]);

  useEffect(() => {
    const idleApi = globalThis as typeof globalThis & {
      requestIdleCallback?: (callback: () => void) => number;
      cancelIdleCallback?: (handle: number) => void;
    };
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
    let idleHandle: number | null = null;

    if (typeof idleApi.requestIdleCallback === 'function') {
      idleHandle = idleApi.requestIdleCallback(() => {
        prewarmDictionaryDb();
      });
    } else {
      timeoutHandle = setTimeout(() => {
        prewarmDictionaryDb();
      }, 0);
    }

    return () => {
      if (idleHandle !== null && typeof idleApi.cancelIdleCallback === 'function') {
        idleApi.cancelIdleCallback(idleHandle);
      }
      if (timeoutHandle !== null) {
        clearTimeout(timeoutHandle);
      }
    };
  }, []);

  const handleCloseLookup = useCallback(() => {
    setLookupWord(null);
    setLookupContext('');
    setLookupSegmentId(null);
    if (wasPlayingBeforeLookupRef.current) {
      try { player.play(); } catch { /* noop */ }
    }
  }, [player]);

  const handleScrubChange = useCallback((nextRatio: number) => {
    setScrubRatio(nextRatio);
    // 拖动期间:暂停 useEffect 自动滚,避免和我们显式 scroll 抢
    isUserScrubbingRef.current = true;
  }, []);

  const handleScrubComplete = useCallback((nextRatio: number) => {
    setScrubRatio(null);
    if (!resolvedPlayerSource) {
      isUserScrubbingRef.current = false;
      return;
    }
    clearRepeatSentence();
    const nextSeconds = clipStartSeconds + nextRatio * Math.max(effectiveClipEndSeconds - clipStartSeconds, 0);
    const nextMs = Math.round(nextSeconds * 1000);
    if (Platform.OS !== 'web') {
      // 先标记 seeking,再同步 nativePositionSeconds,避免 timeUpdate 用旧位置覆盖
      isSeekingRef.current = true;
      updateNativePositionSeconds(nextSeconds);
    }
    player.currentTime = nextSeconds;
    // 主动链路:根据 nextMs 算 segment,立刻显式滚到目标段(不依赖 useEffect 间接链路)
    const targetSegmentIndex = findActiveSegmentIndex(nextMs, scene.segments);
    scrollToSegmentIndex(targetSegmentIndex, true);
    // 解开自动滚守卫
    isUserScrubbingRef.current = false;
  }, [clearRepeatSentence, clipStartSeconds, effectiveClipEndSeconds, player, resolvedPlayerSource, scene.segments, scrollToSegmentIndex, updateNativePositionSeconds]);

  const handleToggleFullscreen = useCallback(async () => {
    if (!resolvedPlayerSource) return;

    if (Platform.OS !== 'web') {
      setIsFullscreen((prev) => !prev);
      return;
    }

    if (typeof document === 'undefined') return;

    if (document.fullscreenElement) {
      await document.exitFullscreen();
      releaseOrientationLock();
      return;
    }

    const hostNode = fullscreenHostRef.current as unknown as { requestFullscreen?: () => Promise<void> } | null;
    if (hostNode?.requestFullscreen) {
      await hostNode.requestFullscreen();
      await requestLandscapeOrientationLock();
    }
  }, [resolvedPlayerSource]);

  const handlePrevSentence = () => {
    handleSeekSentence(Math.max(activeSegmentIndex - 1, 0));
  };

  const handleNextSentence = () => {
    handleSeekSentence(Math.min(activeSegmentIndex + 1, scene.segments.length - 1));
  };

  const handleToggleRate = () => {
    setPlaybackRate((prev) => (prev === 1 ? 0.85 : prev === 0.85 ? 0.7 : 1));
  };

  const handleToggleBackgroundAudio = useCallback(() => {
    setIsBackgroundAudioEnabled((prev) => !prev);
  }, []);

  const handleOpenShadowing = useCallback((index = activeSegmentIndex) => {
    const segment = scene.segments[index];
    if (!segment) return;
    if (isFullscreen) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    wasPlayingBeforeShadowingRef.current = isPlaying;
    pausePlayerSafely(player);
    shadowingReplayRangeRef.current = null;
    setShadowingSegmentIndex(index);
    setShadowingLiveTranscript('');
    setShadowingDiffResult(null);
    setIsShadowingVisible(true);
  }, [activeSegmentIndex, isFullscreen, isPlaying, player, scene.segments]);

  const handleCloseShadowing = useCallback(() => {
    setIsShadowingVisible(false);
    setShadowingSegmentIndex(null);
    const handle = shadowingAsrRef.current;
    shadowingAsrRef.current = null;
    shadowingReplayRangeRef.current = null;
    if (handle) {
      handle.stop().catch(() => {});
    }
    setIsShadowingRecording(false);
    setIsShadowingProcessing(false);
    if (wasPlayingBeforeShadowingRef.current) {
      try { player.play(); } catch { }
    }
  }, [player]);

  const handleShadowingRetry = useCallback(() => {
    shadowingReplayRangeRef.current = null;
    pausePlayerSafely(player);
    if (Platform.OS !== 'web') {
      isSeekingRef.current = true;
      updateNativePositionSeconds(shadowingStartSeconds);
    }
    player.currentTime = shadowingStartSeconds;
    setShadowingLiveTranscript('');
    setShadowingDiffResult(null);
  }, [player, shadowingStartSeconds, updateNativePositionSeconds]);

  const handleReplayShadowingSentence = useCallback(() => {
    if (!isVideoReady || !resolvedPlayerSource) return;
    shadowingReplayRangeRef.current = {
      startSeconds: shadowingStartSeconds,
      endSeconds: shadowingEndSeconds,
    };
    if (Platform.OS !== 'web') {
      isSeekingRef.current = true;
      updateNativePositionSeconds(shadowingStartSeconds);
    }
    player.currentTime = shadowingStartSeconds;
    player.play();
  }, [isVideoReady, player, resolvedPlayerSource, shadowingEndSeconds, shadowingStartSeconds, updateNativePositionSeconds]);

  const handleShadowingPressIn = useCallback(() => {
    if (isShadowingRecording || isShadowingProcessing || !shadowingSegment?.text) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
    pausePlayerSafely(player);
    shadowingReplayRangeRef.current = null;
    setShadowingLiveTranscript('');
    setShadowingDiffResult(null);
    setIsShadowingRecording(true);
    shadowingAsrRef.current = startVolcASR(
      (partial) => {
        setShadowingLiveTranscript(partial);
      },
      () => {
        setIsShadowingRecording(false);
        setIsShadowingProcessing(false);
        shadowingAsrRef.current = null;
      },
    );
  }, [isShadowingProcessing, isShadowingRecording, player, shadowingSegment?.text]);

  const handleShadowingPressOut = useCallback(async () => {
    if (!isShadowingRecording) return;
    setIsShadowingRecording(false);
    const handle = shadowingAsrRef.current;
    shadowingAsrRef.current = null;
    if (!handle || !shadowingSegment?.text) return;
    setIsShadowingProcessing(true);
    const result = await handle.stop();
    const transcript = result.text.trim();
    setShadowingLiveTranscript(transcript);
    if (!transcript) {
      setIsShadowingProcessing(false);
      return;
    }
    const diff = diffShadowing(shadowingSegment.text, transcript);
    setShadowingDiffResult(diff);
    setIsShadowingProcessing(false);
    Haptics.notificationAsync(diff.pass ? Haptics.NotificationFeedbackType.Success : Haptics.NotificationFeedbackType.Warning).catch(() => {});
  }, [isShadowingRecording, shadowingSegment?.text]);

  const revealFullscreenHud = useCallback(() => {
    setIsFullscreenHudVisible(true);
    setFullscreenHudRefreshTick((tick) => tick + 1);
  }, []);

  const handleFullscreenSurfacePress = useCallback(() => {
    if (!isFullscreen) return;
    if (isFullscreenHudVisible) {
      setIsFullscreenHudVisible(false);
      return;
    }
    revealFullscreenHud();
  }, [isFullscreen, isFullscreenHudVisible, revealFullscreenHud]);

  const handleToggleFullscreenSubtitles = useCallback(() => {
    revealFullscreenHud();
    setIsFullscreenSubtitleVisible((prev) => !prev);
  }, [revealFullscreenHud]);

  const handleCycleFullscreenTranslationMode = useCallback(() => {
    revealFullscreenHud();
    setFullscreenTranslationMode((prev) => (prev === 'always' ? 'tap' : prev === 'tap' ? 'hidden' : 'always'));
  }, [revealFullscreenHud]);

  const handleToggleFullscreenTranslationPeek = useCallback(() => {
    if (fullscreenTranslationMode !== 'tap') return;
    revealFullscreenHud();
    setIsFullscreenTranslationPeekVisible((prev) => !prev);
  }, [fullscreenTranslationMode, revealFullscreenHud]);

  const progressRatio = Math.max(0, Math.min(1, (displayedPositionSeconds - clipStartSeconds) / Math.max(effectiveClipEndSeconds - clipStartSeconds, 0.01)));
  const currentLabel = formatClipRelativeTime(Math.round(displayedPositionSeconds * 1000), clipStartMs);
  const durationLabel = formatPlaybackTime(Math.max(0, effectiveClipEndMs - clipStartMs));
  const activePositionMs = Math.round(positionSeconds * 1000);
  const listActivePositionMs = Math.round(activePositionMs / 240) * 240;
  const fullscreenTranslationModeLabel = fullscreenTranslationMode === 'always'
    ? '中文常显'
    : fullscreenTranslationMode === 'tap'
      ? '中文点显'
      : '中文关闭';
  const shouldShowFullscreenTranslation = isFullscreenSubtitleVisible
    && (fullscreenTranslationMode === 'always' || (fullscreenTranslationMode === 'tap' && isFullscreenTranslationPeekVisible));
  const fullscreenFrameStyle = isFullscreen
    ? shouldRotateFullscreen
      ? {
          width: viewportHeight,
          height: viewportWidth,
          borderRadius: 0,
          transform: [{ rotate: '90deg' as const }],
        }
      : styles.fullscreenVideoFrameFill
    : null;
  const fullscreenToggleInsetStyle = isFullscreen
    ? {
        top: Math.max(insets.top + spacing.sm, 16),
        right: Math.max(insets.right + spacing.sm, 16),
      }
    : null;
  const shouldShowPosterOverlay = Boolean(scene.coverImageUri && !hasStartedPlaybackOnce);

  const renderVideoSurface = (fullscreen: boolean) => (
    <View style={fullscreen ? styles.fullscreenViewport : undefined}>
      <View
        style={[
          styles.videoFrame,
          fullscreen ? styles.videoFrameFullscreen : null,
          fullscreen ? styles.fullscreenVideoFrame : null,
          fullscreen ? fullscreenFrameStyle : null,
        ]}
      >
        {resolvedPlayerSource ? (
          <VideoView
            player={player}
            style={styles.video}
            contentFit="cover"
            nativeControls={false}
            surfaceType={Platform.OS === 'android' ? 'textureView' : undefined}
            onFirstFrameRender={() => {
              console.log('[VideoScene] first frame rendered', { sceneId: scene.id });
              setIsVideoReady(true);
              setPlayerError(null);
              if (!primedRef.current) {
                primedRef.current = true;
                player.currentTime = clipStartSeconds;
              }
            }}
          />
        ) : (
          <View style={styles.videoDeferredPlaceholder}>
            <ActivityIndicator color="#CBD5E1" />
            <Text style={styles.videoDeferredText}>{isVideoSourcePreparing ? '正在检查本地缓存并准备视频…' : '正在准备视频...'}</Text>
          </View>
        )}
        {shouldShowPosterOverlay ? (
          <View pointerEvents="none" style={styles.videoPosterOverlay}>
            <Image source={{ uri: scene.coverImageUri! }} style={styles.videoPosterImage} resizeMode="cover" />
          </View>
        ) : null}
        {fullscreen ? <Pressable style={styles.fullscreenTouchLayer} onPress={handleFullscreenSurfacePress} /> : null}
        {fullscreen && isFullscreenSubtitleVisible && activeSegment.id !== '__empty__' && activeSegment.text.trim().length > 0 ? (
          <View style={[styles.fullscreenSubtitleWrap, fullscreenSubtitleWrapStyle]} pointerEvents="box-none">
            <Pressable style={[styles.fullscreenSubtitleCard, fullscreenSubtitleCardStyle]} onPress={handleToggleFullscreenTranslationPeek}>
              <WordHighlightText
                words={activeSegment.words}
                text={activeSegment.text}
                positionMs={activePositionMs}
                isActive={true}
                numberOfLines={fullscreenSubtitleMetrics.maxLines}
                textStyle={[
                  styles.fullscreenSubtitleText,
                  {
                    fontSize: fullscreenSubtitleMetrics.fontSize,
                    lineHeight: fullscreenSubtitleMetrics.lineHeight,
                  },
                ]}
                highlightStyle={styles.fullscreenWordHighlight}
              />
              {shouldShowFullscreenTranslation && activeSegment.textZh ? (
                <Text
                  numberOfLines={fullscreenTranslationMetrics.maxLines}
                  style={[
                    styles.fullscreenSubtitleZh,
                    {
                      fontSize: fullscreenTranslationMetrics.fontSize,
                      lineHeight: fullscreenTranslationMetrics.lineHeight,
                    },
                  ]}
                >
                  {activeSegment.textZh}
                </Text>
              ) : null}
            </Pressable>
          </View>
        ) : null}
        {fullscreen && isFullscreenHudVisible ? (
          <View style={styles.fullscreenHudLayer} pointerEvents="box-none">
            <View style={[styles.fullscreenHudTopRow, { paddingTop: Math.max(insets.top + 12, 18) }]}>
              <View style={styles.fullscreenStatusPill}>
                <Text style={styles.fullscreenStatusText}>{currentLabel} / {durationLabel}</Text>
              </View>
              <Pressable style={[styles.fullscreenToggleBtn, styles.fullscreenToggleBtnFullscreen, fullscreenToggleInsetStyle]} onPress={handleToggleFullscreen}>
                {fullscreen ? <Minimize size={18} color="#FFFFFF" /> : <Maximize size={18} color="#FFFFFF" />}
              </Pressable>
            </View>

            <View
              style={[styles.fullscreenHudBottom, { paddingBottom: Math.max(insets.bottom + 18, 24) }]}
              onLayout={(event) => {
                const nextHeight = Math.round(event.nativeEvent.layout.height);
                if (nextHeight !== fullscreenHudBottomHeight) {
                  setFullscreenHudBottomHeight(nextHeight);
                }
              }}
            >
              <View style={styles.fullscreenToolRow}>
                <Pressable style={[styles.fullscreenToolBtn, !isFullscreenSubtitleVisible && styles.fullscreenToolBtnMuted]} onPress={handleToggleFullscreenSubtitles}>
                  <Text style={styles.fullscreenToolLabel}>{isFullscreenSubtitleVisible ? '字幕开' : '字幕关'}</Text>
                </Pressable>
                <Pressable style={styles.fullscreenToolBtn} onPress={handleCycleFullscreenTranslationMode}>
                  <Text style={styles.fullscreenToolLabel}>{fullscreenTranslationModeLabel}</Text>
                </Pressable>
                <Pressable style={[styles.fullscreenToolBtn, isBackgroundAudioEnabled && styles.fullscreenToolBtnActive]} onPress={() => { revealFullscreenHud(); handleToggleBackgroundAudio(); }}>
                  <Text style={styles.fullscreenToolLabel}>{isBackgroundAudioEnabled ? '锁屏播开' : '锁屏播关'}</Text>
                </Pressable>
                <Pressable style={styles.fullscreenToolBtn} onPress={() => { revealFullscreenHud(); handleToggleRate(); }}>
                  <Text style={styles.fullscreenToolLabel}>{playbackRate}x</Text>
                </Pressable>
                <Pressable style={[styles.fullscreenToolBtn, repeatSentence && styles.fullscreenToolBtnActive]} onPress={() => { revealFullscreenHud(); handleToggleRepeatSentence(); }}>
                  <Text style={styles.fullscreenToolLabel}>{repeatSentence ? '单句循环开' : '单句循环关'}</Text>
                </Pressable>
              </View>

              <View style={styles.fullscreenTransportRow}>
                <Pressable style={styles.fullscreenTransportBtn} onPress={() => { revealFullscreenHud(); handlePrevSentence(); }}>
                  <SkipBack size={18} color="#FFFFFF" />
                  <Text style={styles.fullscreenTransportText}>上句</Text>
                </Pressable>
                <Pressable style={styles.fullscreenPlayBtn} onPress={() => { revealFullscreenHud(); handleTogglePlayback(); }} disabled={!resolvedPlayerSource || !isVideoReady}>
                  {isPlaying ? <PauseCircle size={24} color="#FFFFFF" /> : isPlaybackEnded ? <RotateCcw size={24} color="#FFFFFF" /> : <PlayCircle size={24} color="#FFFFFF" />}
                </Pressable>
                <Pressable style={styles.fullscreenTransportBtn} onPress={() => { revealFullscreenHud(); handleNextSentence(); }}>
                  <SkipForward size={18} color="#FFFFFF" />
                  <Text style={styles.fullscreenTransportText}>下句</Text>
                </Pressable>
              </View>
            </View>
          </View>
        ) : null}
        {!fullscreen ? (
          <Pressable style={[styles.videoTopMaximizeBtn, { top: -2 }]} onPress={handleToggleFullscreen}>
            <Maximize size={22} color="#FFFFFF" />
          </Pressable>
        ) : null}
      </View>
    </View>
  );

  const renderSegmentItem = useCallback<ListRenderItem<VideoSceneSegment>>(({ item, index }) => {
    const isActive = index === activeSegmentIndex;
    return (
      <SegmentCard
        segment={item}
        index={index}
        isActive={isActive}
        clipStartMs={clipStartMs}
        isFavorited={sentenceCardBySegmentId.has(item.id)}
        subtitleMode={subtitleMode}
        positionMs={isActive ? listActivePositionMs : 0}
        onSeek={handleSeekSentence}
        onMeasure={handleMeasureSegment}
        onToggleFavorite={handleToggleSentenceCard}
        onWordPress={handleWordPress}
        onShadowingPress={() => handleOpenShadowing(index)}
      />
    );
  }, [activeSegmentIndex, clipStartMs, sentenceCardBySegmentId, handleMeasureSegment, handleOpenShadowing, handleSeekSentence, handleToggleSentenceCard, handleWordPress, listActivePositionMs, subtitleMode]);

  const renderFavoriteSegmentItem = useCallback<ListRenderItem<VideoSceneSegment>>(({ item }) => {
    const originalIndex = segmentIndexById.get(item.id) ?? 0;
    const isActive = originalIndex === activeSegmentIndex;
    return (
      <SegmentCard
        segment={item}
        index={originalIndex}
        isActive={isActive}
        clipStartMs={clipStartMs}
        isFavorited={sentenceCardBySegmentId.has(item.id)}
        subtitleMode={subtitleMode}
        positionMs={isActive ? listActivePositionMs : 0}
        onSeek={handlePlaySegmentOnce}
        onMeasure={() => {}}
        onToggleFavorite={handleToggleSentenceCard}
        onWordPress={handleWordPress}
        onShadowingPress={() => handleOpenShadowing(originalIndex)}
      />
    );
  }, [activeSegmentIndex, clipStartMs, sentenceCardBySegmentId, handleOpenShadowing, handlePlaySegmentOnce, handleToggleSentenceCard, handleWordPress, listActivePositionMs, segmentIndexById, subtitleMode]);

  // Tap a word card → seek to its source segment + open dictionary sheet
  const handleOpenWordCard = useCallback((card: any) => {
    const segId = card.videoContext?.segmentId;
    if (segId) {
      const index = segmentIndexById.get(segId);
      if (typeof index === 'number') handleSeekSentence(index);
      const seg = scene.segments.find((s) => s.id === segId);
      setLookupContext(seg?.text ?? card.content);
    } else {
      setLookupContext(card.content);
    }
    setLookupWord(card.content);
    setLookupSegmentId(segId ?? null);
  }, [handleSeekSentence, segmentIndexById, scene.segments]);

  const renderWordCardItem = useCallback<ListRenderItem<any>>(({ item }) => {
    const seg = scene.segments.find((s) => s.id === item.videoContext?.segmentId);
    const isSaved = true; // every card in this list is in FSRS by definition
    return (
      <Pressable style={styles.wordCard} onPress={() => handleOpenWordCard(item)}>
        <View style={styles.wordCardTopRow}>
          <View style={styles.wordCardHeadwordWrap}>
            <Text style={styles.wordCardHeadword} numberOfLines={1}>{item.content}</Text>
          </View>
          <Pressable
            hitSlop={8}
            onPress={(e) => {
              e.stopPropagation();
              handleSaveWordToHistory({
                queryWord: item.content,
                normalized: (item.content ?? '').toLowerCase(),
                displayWord: item.content,
                contextSentence: item.videoContext?.contextSentence ?? item.content,
                segmentId: item.videoContext?.segmentId ?? null,
              }, false);
            }}
            style={styles.wordCardStarBtn}
            accessibilityLabel="从 FSRS 移除"
          >
            <Star
              size={16}
              color="#F59E0B"
              fill="#FBBF24"
            />
          </Pressable>
        </View>
        {item.translation ? (
          <Text style={styles.wordCardTranslation} numberOfLines={2}>{item.translation}</Text>
        ) : null}
        {seg ? (
          <Text style={styles.wordCardContext} numberOfLines={2}>{seg.text}</Text>
        ) : null}
      </Pressable>
    );
  }, [scene, handleOpenWordCard, handleSaveWordToHistory]);

  const renderSentenceCardItem = useCallback<ListRenderItem<VideoSceneSegment>>(({ item }) => {
    const card = sentenceCardBySegmentId.get(item.id);
    if (!card) return null;
    return (
      <Pressable
        style={styles.wordCard}
        onPress={() => {
          const index = segmentIndexById.get(item.id);
          if (typeof index === 'number') handleSeekSentence(index);
        }}
      >
        <View style={styles.wordCardTopRow}>
          <View style={styles.wordCardHeadwordWrap}>
            <Text style={styles.wordCardHeadword} numberOfLines={1}>{item.text}</Text>
          </View>
          <Pressable
            hitSlop={8}
            onPress={(e) => {
              e.stopPropagation();
              handleToggleSentenceCard(item.id);
            }}
            style={styles.wordCardStarBtn}
            accessibilityLabel="从 FSRS 移除"
          >
            <Star
              size={16}
              color="#F59E0B"
              fill="#FBBF24"
            />
          </Pressable>
        </View>
        {item.textZh ? (
          <Text style={styles.wordCardTranslation} numberOfLines={2}>{item.textZh}</Text>
        ) : null}
        {card.due ? (
          <Text style={styles.wordCardDueLabel}>
            复习时间 · {new Date(card.due).toLocaleDateString('zh-CN')}
          </Text>
        ) : null}
      </Pressable>
    );
  }, [sentenceCardBySegmentId, segmentIndexById, handleSeekSentence, handleToggleSentenceCard]);

  const segmentListExtraData = useMemo(() => ({
    activeSegmentIndex,
    activePositionMs: listActivePositionMs,
    subtitleMode,
  }), [activeSegmentIndex, listActivePositionMs, subtitleMode]);

  const canGenerateLocalSubtitle = scene.contentOrigin === 'imported' && !!scene.videoUri && scene.selectedCloudProvider == null;
  const canGenerateCloudSubtitle = scene.contentOrigin === 'imported' && !!scene.selectedCloudProvider;
  const canGenerateSubtitle = canGenerateLocalSubtitle || canGenerateCloudSubtitle;
  const isLocalSubtitleGenerationBusy = canGenerateLocalSubtitle && scene.subtitleStatus === 'processing';
  const isCloudSubtitleGenerationBusy = canGenerateCloudSubtitle && (isGeneratingSubtitle || scene.subtitleStatus === 'processing');
  const isSubtitleGenerationBusy = isLocalSubtitleGenerationBusy || isCloudSubtitleGenerationBusy;
  const subtitleActionLabel = scene.subtitleStatus === 'error'
    ? '重新生成字幕'
    : scene.subtitleStatus === 'ready'
      ? '重新生成字幕'
      : canGenerateCloudSubtitle
        ? '生成网盘字幕'
      : '立即生成字幕';
  const subtitleSuccessMessage = canGenerateCloudSubtitle
    ? '已经为这个网盘视频生成字幕，并缓存到本地。'
    : '已经为这个本地视频生成字幕。';

  const handleGenerateSubtitle = useCallback(async () => {
    if (!canGenerateSubtitle) {
      return;
    }
    if (isSubtitleGenerationBusy) {
      // Card UI on the list page is the canonical place to start a
      // subtitle run; the auto-trigger there runs the same pipeline.
      // If the user opens the detail page while a run is in flight
      // and taps the (disabled) button anyway, we surface a soft
      // toast instead of silently no-op'ing. Critically, we DO NOT
      // re-launch the pipeline — that would burn quota and double
      // the ASR cost.
      if (Platform.OS === 'android') {
        ToastAndroid.show('字幕正在生成中，请稍候', ToastAndroid.SHORT);
      } else {
        Alert.alert('字幕生成中', '字幕正在生成中，请稍候再试。');
      }
      return;
    }
    setIsGeneratingSubtitle(true);
    try {
      if (canGenerateCloudSubtitle) {
        await triggerCloudVideoSubtitleGeneration(scene.id, {
          expectedDurationSeconds: resolvedDurationSeconds > 0 ? resolvedDurationSeconds : undefined,
        });
      } else {
        await triggerUserVideoSubtitleGeneration(scene.id, {
          expectedDurationSeconds: resolvedDurationSeconds > 0 ? resolvedDurationSeconds : undefined,
        });
      }
      if (canGenerateCloudSubtitle) {
        await onRefreshSubtitles?.(true);
      } else {
        await onRefreshScene?.(true);
      }
      Alert.alert('字幕生成完成', subtitleSuccessMessage);
    } catch (error) {
      if (canGenerateCloudSubtitle) {
        await onRefreshSubtitles?.(true);
      } else {
        await onRefreshScene?.(true);
      }
      Alert.alert('字幕生成失败', error instanceof Error ? error.message : '请稍后重试');
    } finally {
      setIsGeneratingSubtitle(false);
    }
  }, [canGenerateCloudSubtitle, canGenerateSubtitle, isSubtitleGenerationBusy, onRefreshScene, onRefreshSubtitles, resolvedDurationSeconds, scene.id, subtitleSuccessMessage]);

  return (
    <>
      {Platform.OS !== 'web' ? (
        <Modal
          visible={isFullscreen}
          animationType="fade"
          presentationStyle="fullScreen"
          statusBarTranslucent
          onRequestClose={() => setIsFullscreen(false)}
        >
          <View style={styles.nativeFullscreenModal}>
            {playerSource ? renderVideoSurface(true) : null}
          </View>
        </Modal>
      ) : null}

      {Platform.OS === 'web' || !isFullscreen ? (
        <View ref={fullscreenHostRef} style={[styles.videoCard, isFullscreen && styles.videoCardFullscreen]}>
          {playerSource ? renderVideoSurface(isFullscreen) : (
            <View style={styles.videoPlaceholder}>
              <Clapperboard size={28} color="#64748B" />
              <Text style={styles.videoPlaceholderTitle}>
                {canUseOfficialCloudSource
                  ? hasStaleProvider
                    ? '当前场景的网盘内容需要更新'
                    : hasConfiguredProvider && !currentProviderState
                      ? '当前还没有设置推荐默认网盘'
                    : hasConnectedProvider
                      ? '当前场景还没有同步到可播放状态'
                      : '当前场景还没有可用云来源'
                  : isImportedCloudReference
                    ? '当前网盘视频暂时无法解析播放'
                    : '当前场景还没有绑定真实视频'}
              </Text>
              <Text style={styles.videoPlaceholderText}>
                {canUseOfficialCloudSource
                  ? hasStaleProvider
                    ? '请先在「我的」→「我的网盘」里重新扫描并同步最新内容，然后再回来播放。'
                    : hasConfiguredProvider && !currentProviderState
                      ? '请先在「我的」→「我的网盘」里设置推荐默认网盘，然后再回来播放。'
                    : hasConnectedProvider
                      ? '请先在「我的」→「我的网盘」里完成同步，然后再回来播放。'
                      : '请先在「我的」→「我的网盘」里连接百度网盘，然后再回来播放。'
                  : isImportedCloudReference
                    ? '请检查网盘授权状态、文件路径是否仍然有效，然后稍后重试。'
                    : '先用下面的句子列表做基础预习，后面再接入真实画面。'}
              </Text>
            </View>
          )}
          {playerError ? <Text style={styles.playerErrorText}>{playerError}</Text> : null}
        </View>
      ) : null}

      <View style={styles.subtitlePanelTabWrap}>
        <View style={styles.subtitlePanelTabRow}>
          <Pressable
            style={[styles.subtitlePanelTabChip, subtitlePanelTab === 'subtitles' && styles.subtitlePanelTabChipActive]}
            onPress={() => setSubtitlePanelTab('subtitles')}
          >
            <Text style={[styles.subtitlePanelTabText, subtitlePanelTab === 'subtitles' && styles.subtitlePanelTabTextActive]}>字幕</Text>
          </Pressable>
          <Pressable
            style={[styles.subtitlePanelTabChip, subtitlePanelTab === 'words' && styles.subtitlePanelTabChipActive]}
            onPress={() => setSubtitlePanelTab('words')}
          >
            <Text style={[styles.subtitlePanelTabText, subtitlePanelTab === 'words' && styles.subtitlePanelTabTextActive]}>单词</Text>
          </Pressable>
          <Pressable
            style={[styles.subtitlePanelTabChip, subtitlePanelTab === 'favorites' && styles.subtitlePanelTabChipActive]}
            onPress={() => setSubtitlePanelTab('favorites')}
          >
            <Text style={[styles.subtitlePanelTabText, subtitlePanelTab === 'favorites' && styles.subtitlePanelTabTextActive]}>句子</Text>
          </Pressable>
        </View>
      </View>

      {subtitlePanelTab === 'subtitles' ? (
        !hasSubtitleSegments ? (
          <View style={styles.emptySubtitleState}>
            <Text style={styles.emptySubtitleTitle}>{emptySubtitleTitle}</Text>
            <Text style={styles.emptySubtitleText}>{emptySubtitleText}</Text>
            {canGenerateSubtitle ? (
              <Pressable
                style={[styles.emptySubtitleActionBtn, isSubtitleGenerationBusy && styles.emptySubtitleActionBtnDisabled]}
                onPress={handleGenerateSubtitle}
                disabled={isSubtitleGenerationBusy}
              >
                {isSubtitleGenerationBusy ? (
                  <ActivityIndicator size="small" color="#FFFFFF" />
                ) : null}
                <Text style={styles.emptySubtitleActionText}>
                  {isSubtitleGenerationBusy
                    // Surface the real 3-stage progress message so the
                    // user knows what's happening (download / extract /
                    // asr). Falls back to a generic label if no message
                    // is set yet.
                    ? (scene.subtitlePhaseMessage ?? '正在生成字幕…')
                    : subtitleActionLabel}
                </Text>
              </Pressable>
            ) : null}
          </View>
        ) : (
          <FlatList
            ref={scrollRef}
            data={scene.segments}
            keyExtractor={(item) => item.id}
            renderItem={renderSegmentItem}
            initialScrollIndex={Math.max(0, Math.min(activeSegmentIndex - 2, scene.segments.length - 1))}
            onScrollToIndexFailed={({ index, averageItemLength }) => {
              // 平均高度不可靠,改用 segmentYPositions 插值(在 scrollToSegmentIndex 里做)
              // 这里只做最后兜底:如果连 segmentYPositions 都没数据,用 averageItemLength 顶
              const measuredKeys = Object.keys(segmentYPositions.current).map(Number);
              if (measuredKeys.length === 0) {
                const fallbackOffset = Math.max(0, averageItemLength * index - 60);
                scrollRef.current?.scrollToOffset({ offset: fallbackOffset, animated: false });
              }
              // 否则 scrollToSegmentIndex 的下一次 useEffect 会重新算
            }}
            extraData={segmentListExtraData}
            onContentSizeChange={handleContentSizeChange}
            getItemLayout={getItemLayout}
            style={styles.segmentScroll}
            contentContainerStyle={styles.segmentList}
            showsVerticalScrollIndicator={false}
            initialNumToRender={15}
            maxToRenderPerBatch={10}
            updateCellsBatchingPeriod={60}
            windowSize={9}
            removeClippedSubviews={Platform.OS === 'android'}
          />
        )
      ) : subtitlePanelTab === 'words' ? (
        <View style={{ flex: 1 }}>
          <Pressable
            style={[styles.reviewCtaBtn, dueWordCount === 0 && styles.reviewCtaBtnDisabled]}
            onPress={() => router.push(`/(tabs)/review?videoId=${encodeURIComponent(scene.id)}&type=word`)}
            disabled={dueWordCount === 0}
          >
            <Text style={styles.reviewCtaBtnText}>
              {dueWordCount === 0
                ? '本视频单词都已复习'
                : `开始复习 (${dueWordCount})`}
            </Text>
          </Pressable>
          {wordCards.length === 0 ? (
            <View style={styles.panelEmptyState}>
              <Text style={styles.panelEmptyTitle}>还没有单词</Text>
              <Text style={styles.panelEmptyText}>在字幕里点词后,字典卡片点 ⭐ 收藏,会出现在这里。</Text>
            </View>
          ) : (
            <FlatList
              data={wordCards}
              keyExtractor={(item) => item.id}
              renderItem={renderWordCardItem}
              style={styles.segmentScroll}
              contentContainerStyle={styles.lookupWordList}
              showsVerticalScrollIndicator={false}
            />
          )}
        </View>
      ) : (
        <View style={{ flex: 1 }}>
          <Pressable
            style={[styles.reviewCtaBtn, dueSentenceCount === 0 && styles.reviewCtaBtnDisabled]}
            onPress={() => router.push(`/(tabs)/review?videoId=${encodeURIComponent(scene.id)}&type=sentence`)}
            disabled={dueSentenceCount === 0}
          >
            <Text style={styles.reviewCtaBtnText}>
              {dueSentenceCount === 0
                ? '本视频句子都已复习'
                : `开始复习 (${dueSentenceCount})`}
            </Text>
          </Pressable>
          {sentenceSegments.length === 0 ? (
            <View style={styles.panelEmptyState}>
              <Text style={styles.panelEmptyTitle}>还没有句子</Text>
              <Text style={styles.panelEmptyText}>点字幕或字典 sheet 里句子右上角的 ⭐,会出现在这里。</Text>
            </View>
          ) : (
            <FlatList
              data={sentenceSegments}
              keyExtractor={(item) => item.id}
              renderItem={renderSentenceCardItem}
              style={styles.segmentScroll}
              contentContainerStyle={styles.lookupWordList}
              showsVerticalScrollIndicator={false}
            />
          )}
        </View>
      )}
      <Modal
        visible={isBindPickerVisible}
        transparent
        animationType="slide"
        onRequestClose={() => setIsBindPickerVisible(false)}
      >
        <View style={styles.sheetOverlay}>
          <Pressable style={{ flex: 1 }} onPress={() => setIsBindPickerVisible(false)} />
          <View style={styles.customSheet}>
            <View style={styles.customSheetHandle} />
            <View style={styles.customSheetHeader}>
              <View style={styles.videoAiPickerHeaderInfo}>
                <Text style={styles.customSheetTitle}>绑定推荐视频</Text>
                <Text style={styles.videoAiPickerHint} numberOfLines={2}>{scene.card.title}</Text>
              </View>
              <Pressable onPress={() => setIsBindPickerVisible(false)}>
                <X size={20} color={colors.text.secondary} />
              </Pressable>
            </View>
            <View style={styles.bindPickerSheetBody}>
              <VideoSourcePickerContent
                mode="bind"
                visible={isBindPickerVisible}
                fixedProvider={currentProviderState?.provider ?? null}
                onRequestGoToMountDrives={handleOpenMyCloudDrives}
                onCloudFileSelected={handleBindCloudFile}
              />
            </View>
          </View>
        </View>
      </Modal>

      <View style={styles.playerPanel}>
        {!isPlayerPanelCollapsed ? (
          <View style={styles.playerToolRow}>
            <Pressable style={styles.toolBtn} onPress={() => setSubtitleMode((prev) => (prev === 'bilingual' ? 'english' : 'bilingual'))}>
              <Languages size={16} color="#334155" />
              <Text style={styles.toolText}>{subtitleMode === 'bilingual' ? '双语' : '英文'}</Text>
            </Pressable>
            <Pressable style={styles.toolBtn} onPress={handleToggleRate}>
              <Gauge size={16} color="#334155" />
              <Text style={styles.toolText}>{playbackRate}x</Text>
            </Pressable>
            <Pressable style={[styles.toolBtn, isBackgroundAudioEnabled && styles.toolBtnActive]} onPress={handleToggleBackgroundAudio}>
              <Headphones size={16} color="#334155" />
              <Text style={styles.toolText}>{isBackgroundAudioEnabled ? '锁屏播开' : '锁屏播关'}</Text>
            </Pressable>
            <Pressable style={[styles.toolBtn, !hasSubtitleSegments && styles.toolBtnDisabled]} onPress={() => handleOpenShadowing(activeSegmentIndex)} disabled={!hasSubtitleSegments}>
              <Mic size={16} color="#334155" />
              <Text style={[styles.toolText, !hasSubtitleSegments && styles.toolTextDisabled]}>{hasSubtitleSegments ? '视频跟练' : '等待字幕'}</Text>
            </Pressable>
            <Pressable style={[styles.toolBtn, isGeneratingVideoAiPractice && styles.toolBtnDisabled]} onPress={() => {
              if (isGeneratingVideoAiPractice) {
                setIsVideoAiPickerVisible(true);
                return;
              }
              void handleOpenVideoAiPractice();
            }}>
              <MessageCircle size={16} color="#334155" />
              <Text style={[styles.toolText, isGeneratingVideoAiPractice && styles.toolTextDisabled]}>{isGeneratingVideoAiPractice ? '生成中…' : 'AI陪练'}</Text>
            </Pressable>
          </View>
        ) : null}

        <ProgressScrubber
          ratio={progressRatio}
          leftLabel={`${currentLabel} / ${durationLabel}`}
          rightAccessory={(
            <View style={styles.playerPanelAccessoryRow}>
              <Pressable style={styles.playerPanelIconBtn} onPress={handleToggleFullscreen}>
                <Maximize size={18} color="#475569" />
              </Pressable>
              <Pressable style={styles.playerPanelCollapseBtn} onPress={() => setIsPlayerPanelCollapsed((prev) => !prev)}>
                {isPlayerPanelCollapsed ? (
                  <ChevronUp size={18} color="#475569" />
                ) : (
                  <ChevronDown size={18} color="#475569" />
                )}
              </Pressable>
            </View>
          )}
          onChange={handleScrubChange}
          onComplete={handleScrubComplete}
        />

        <View style={styles.playerTransportRow}>
          <Pressable style={styles.playerTransportBtn} onPress={handlePrevSentence}>
            <SkipBack size={18} color="#475569" />
            <Text style={styles.playerTransportBtnText}>上句</Text>
          </Pressable>
          <Pressable style={styles.playerTransportPlayBtn} onPress={handleTogglePlayback} disabled={!resolvedPlayerSource || !isVideoReady}>
            {isPlaying ? <PauseCircle size={22} color="#FFFFFF" /> : isPlaybackEnded ? <RotateCcw size={22} color="#FFFFFF" /> : <PlayCircle size={22} color="#FFFFFF" />}
          </Pressable>
          <Pressable style={styles.playerTransportBtn} onPress={handleNextSentence}>
            <SkipForward size={18} color="#475569" />
            <Text style={styles.playerTransportBtnText}>下句</Text>
          </Pressable>
        </View>
      </View>

      {lookupWord ? (
        <DictionaryLookupSheet
          word={lookupWord}
          contextSentence={lookupContext}
          segmentId={lookupSegmentId}
          isWordSaved={isCurrentLookupSaved}
          isSentenceSaved={lookupSegmentId ? sentenceCardBySegmentId.has(lookupSegmentId) : false}
          onClose={handleCloseLookup}
          onToggleSave={handleSaveWordToHistory}
          onToggleSentenceSave={handleToggleSentenceFromLookup}
        />
      ) : null}

      <Modal
        visible={isShadowingVisible}
        animationType="fade"
        transparent
        statusBarTranslucent
        onRequestClose={handleCloseShadowing}
      >
        <View style={styles.shadowingModalBackdrop}>
          <Pressable style={styles.shadowingModalDismissLayer} onPress={handleCloseShadowing} />
          <View style={styles.shadowingModalCard}>
            <ShadowingPanel
              targetText={shadowingSegment.text}
              targetTextZh={shadowingSegment.textZh}
              isRecording={isShadowingRecording}
              isProcessing={isShadowingProcessing}
              liveTranscript={shadowingLiveTranscript}
              diffResult={shadowingDiffResult}
              onReplay={handleReplayShadowingSentence}
              onPressIn={handleShadowingPressIn}
              onPressOut={handleShadowingPressOut}
              onRetry={handleShadowingRetry}
              onClose={handleCloseShadowing}
              inModal
            />
          </View>
        </View>
      </Modal>

      <Modal
        visible={isVideoAiPickerVisible}
        animationType="slide"
        transparent
        statusBarTranslucent
        onRequestClose={handleCloseVideoAiPicker}
      >
        <View style={styles.sheetOverlay}>
          <Pressable style={styles.videoAiPickerDismissLayer} onPress={handleCloseVideoAiPicker} />
          <View style={[styles.customSheet, styles.videoAiPickerSheet]}>
            <View style={styles.customSheetHandle} />
            <View style={styles.customSheetHeader}>
              <View style={styles.videoAiPickerHeaderInfo}>
                <Text style={styles.customSheetTitle}>{isGeneratingVideoAiPractice ? 'AI陪练生成中' : '选择 AI陪练主题'}</Text>
                <Text style={styles.videoAiPickerHint} numberOfLines={2}>{scene.card.title}</Text>
              </View>
              <Pressable style={styles.videoAiPickerCloseBtn} onPress={handleCloseVideoAiPicker}>
                <X size={20} color="#64748B" />
              </Pressable>
            </View>
            {isGeneratingVideoAiPractice ? (
              <View style={styles.videoAiPickerProgressSection}>
                <View style={styles.videoAiPickerProgressTopRow}>
                  <ActivityIndicator size="small" color="#2563EB" />
                  <Text style={styles.videoAiPickerProgressText}>{videoAiProgressText}</Text>
                </View>
                {videoAiStreamTargetCount > 0 ? (
                  <Text style={styles.videoAiPickerProgressCount}>
                    {`已实时解析 ${videoAiStreamParsedCount}/${videoAiStreamTargetCount} 个话题`}
                  </Text>
                ) : null}
              </View>
            ) : null}
            <FlatList
              data={videoAiPickerCards}
              keyExtractor={(item) => item.id}
              ListHeaderComponent={videoAiPickerCards.length > 0 ? (
                <View style={styles.videoAiPickerListHeader}>
                  <Text style={styles.videoAiPickerSectionTitle}>{isGeneratingVideoAiPractice ? '已生成的话题' : '可选话题'}</Text>
                  {/* "换一组" — regenerate with the displayed
                      titles fed back as "avoid these" so the new
                      batch leans into fresh angles. Hidden while
                      a generation is in flight to avoid double
                      triggers. */}
                  {!isGeneratingVideoAiPractice ? (
                    <Pressable
                      style={styles.videoAiPickerRegenerateBtn}
                      onPress={handleRegenerateVideoAiPractice}
                      hitSlop={6}
                    >
                      <RefreshCw size={14} color={colors.primary} />
                      <Text style={styles.videoAiPickerRegenerateBtnText}>换一组</Text>
                    </Pressable>
                  ) : null}
                </View>
              ) : null}
              ListEmptyComponent={(
                <View style={styles.videoAiPickerEmptyState}>
                  <Text style={styles.videoAiPickerEmptyTitle}>
                    {isGeneratingVideoAiPractice ? '正在生成主题列表' : '还没有 AI陪练主题'}
                  </Text>
                  <Text style={styles.videoAiPickerEmptyHint}>
                    {isGeneratingVideoAiPractice
                      ? '新的陪练话题会随着模型输出实时出现在下面。'
                      : '你可以直接开始生成，让系统根据当前视频内容和字幕创建一组 AI陪练主题。'}
                  </Text>
                  {!isGeneratingVideoAiPractice ? (
                    <Pressable style={styles.videoAiPickerGenerateBtn} onPress={() => { void handleStartGenerateVideoAiPractice(); }}>
                      <Text style={styles.videoAiPickerGenerateBtnText}>
                        {videoAiGenerationStatus === 'failed' ? '重新生成 AI陪练' : '开始生成 AI陪练'}
                      </Text>
                    </Pressable>
                  ) : null}
                  {videoAiGenerationError ? (
                    <Text style={styles.videoAiPickerErrorHint}>{videoAiGenerationError}</Text>
                  ) : null}
                </View>
              )}
              renderItem={({ item }) => (
                <Pressable style={styles.videoAiPickerOption} onPress={() => handleSelectVideoAiCard(item)}>
                  <View style={styles.videoAiPickerOptionIconWrap}>
                    <Text style={styles.videoAiPickerOptionIcon}>{item.icon}</Text>
                  </View>
                  <View style={styles.videoAiPickerOptionBody}>
                    <View style={styles.videoAiPickerMetaRow}>
                      <Text style={styles.videoAiPickerLevel}>{item.level}</Text>
                      <Text style={styles.videoAiPickerCategory}>{item.category}</Text>
                    </View>
                    <Text style={styles.videoAiPickerOptionTitle}>{item.title}</Text>
                    <Text style={styles.videoAiPickerOptionDesc} numberOfLines={2}>{item.descZh || item.desc}</Text>
                  </View>
                </Pressable>
              )}
              style={styles.videoAiPickerList}
              contentContainerStyle={styles.videoAiPickerListContent}
              showsVerticalScrollIndicator={false}
            />
          </View>
        </View>
      </Modal>
    </>
  );
}

const EMPTY_SEGMENT: VideoSceneSegment = {
  id: '__empty__',
  startMs: 0,
  endMs: 0,
  speaker: 'narration',
  text: '',
  textZh: '',
};

export default function VideoSceneDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [scene, setScene] = useState<VideoSceneDetail | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [headerProviderState, setHeaderProviderState] = useState<VideoSourceProviderState | null>(null);
  const [headerDownloadEntry, setHeaderDownloadEntry] = useState<DownloadedSceneSource | null>(null);
  const [isHeaderMenuVisible, setIsHeaderMenuVisible] = useState(false);
  const [isHeaderBindPickerVisible, setIsHeaderBindPickerVisible] = useState(false);
  const [isCacheSheetVisible, setIsCacheSheetVisible] = useState(false);
  const [isCacheActionBusy, setIsCacheActionBusy] = useState(false);
  // Move-to-collection picker (for user-imported videos). Distinct
  // from the cache / delete modals above — opens when the user
  // picks "移动到合集" in the three-dot menu.
  const [isMovePickerVisible, setIsMovePickerVisible] = useState(false);
  const [movePickerCollections, setMovePickerCollections] = useState<{ id: number; title: string; is_default: boolean }[]>([]);
  const [isMovePickerLoading, setIsMovePickerLoading] = useState(false);
  const hasCompletedInitialSceneLoadRef = useRef(false);
  const lastHeaderDownloadStatusRef = useRef<DownloadedSceneSource['status'] | null>(null);

  const loadScene = useCallback(async (forceRefresh: boolean = false, silent: boolean = false) => {
    if (!silent) {
      setIsLoading(true);
    }
    try {
      const result = await getVideoSceneById(id as string, forceRefresh);
      setScene(result);
    } finally {
      if (!silent) {
        setIsLoading(false);
      }
    }
  }, [id]);

  const refreshSceneSubtitles = useCallback(async (forceRefresh: boolean = true) => {
    const result = await getVideoSceneById(id as string, forceRefresh);
    setScene((current) => {
      if (!result || !current || current.id !== result.id) {
        return result;
      }
      return {
        ...current,
        subtitleStatus: result.subtitleStatus,
        subtitleCursorMs: result.subtitleCursorMs,
        subtitleFileName: result.subtitleFileName,
        subtitleSourcePath: result.subtitleSourcePath,
        segments: result.segments,
        durationSeconds: result.durationSeconds || current.durationSeconds,
      };
    });
  }, [id]);

  const refreshHeaderCloudCacheState = useCallback(async () => {
    if (!scene) {
      setHeaderProviderState(null);
      setHeaderDownloadEntry(null);
      return null;
    }

    if (scene.contentOrigin === 'official' && scene.officialAssetKeys) {
      const states = await getOfficialSceneProviderStates(scene.id);
      const current = states.find((item) => item.isSelected)
        ?? (scene.selectedCloudProvider ? states.find((item) => item.provider === scene.selectedCloudProvider) ?? null : null);
      setHeaderProviderState(current);
      if (!current?.provider) {
        setHeaderDownloadEntry(null);
        return { current: null, entry: null };
      }
      const entry = await getDownloadedSceneSource(scene.id, current.provider);
      setHeaderDownloadEntry(entry);
      return { current, entry };
    }

    if (scene.contentOrigin === 'imported' && scene.selectedCloudProvider && scene.cloudRemotePath) {
      const provider = scene.selectedCloudProvider;
      const entry = await getDownloadedSceneSource(scene.id, provider);
      const isConfigured = provider === 'baidu_pan'
        ? Boolean((await getBaiduPanBinding())?.token?.accessToken)
        : false;
      const current: VideoSourceProviderState = {
        provider,
        label: provider === 'baidu_pan' ? '百度' : '云盘',
        isConfigured,
        isSelected: true,
        hasLocalCache: entry?.status === 'completed' && Boolean(entry.localVideoUri),
        isReady: isConfigured,
        playbackMode: entry?.status === 'completed' && entry.localVideoUri ? 'local' : 'remote',
        syncStatus: entry?.status === 'completed' && entry.localVideoUri ? 'cached' : isConfigured ? 'available' : 'not_connected',
        remotePath: scene.cloudRemotePath,
      };
      setHeaderProviderState(current);
      setHeaderDownloadEntry(entry);
      return { current, entry };
    }

    setHeaderProviderState(null);
    setHeaderDownloadEntry(null);
    return { current: null, entry: null };
  }, [scene]);

  useFocusEffect(
    useCallback(() => {
      if (!hasCompletedInitialSceneLoadRef.current) {
        return () => {};
      }
      void loadScene(true, true);
    }, [loadScene])
  );

  useEffect(() => {
    let active = true;
    hasCompletedInitialSceneLoadRef.current = false;
    setIsLoading(true);
    setScene(null);
    (async () => {
      let summary: VideoSceneDetail | null = null;
      try {
        summary = await getVideoSceneSummaryById(id as string);
        if (!active) return;
        setScene(summary);
      } finally {
        if (active) {
          hasCompletedInitialSceneLoadRef.current = true;
          setIsLoading(false);
        }
      }

      try {
        const result = await getVideoSceneById(id as string);
        if (!active || !result) {
          return;
        }
        setScene(result);
      } catch {
      }
    })();
    return () => {
      active = false;
    };
  }, [id]);

  useEffect(() => {
    if (!scene) return;
    console.log('[VideoScene] detail screen ready', {
      sceneId: scene.id,
      hasVideoAsset: !!scene.videoAsset,
      hasVideoUri: !!scene.videoUri,
      clipStartMs: scene.clipStartMs,
      clipEndMs: scene.clipEndMs,
    });
  }, [scene]);

  useEffect(() => {
    if (!scene) return;
    const shouldPoll = scene.contentOrigin === 'imported'
      && scene.selectedCloudProvider == null
      && scene.subtitleStatus === 'processing';
    if (!shouldPoll) {
      return;
    }
    const timer = setInterval(() => {
      void loadScene(true, true);
    }, 2500);
    return () => {
      clearInterval(timer);
    };
  }, [loadScene, scene]);

  useEffect(() => {
    void refreshHeaderCloudCacheState();
  }, [refreshHeaderCloudCacheState]);

  useEffect(() => {
    const previousStatus = lastHeaderDownloadStatusRef.current;
    const nextStatus = headerDownloadEntry?.status ?? null;
    if (previousStatus && previousStatus !== 'completed' && nextStatus === 'completed') {
      void loadScene(true, true);
    }
    lastHeaderDownloadStatusRef.current = nextStatus;
  }, [headerDownloadEntry?.status, loadScene]);

  useEffect(() => {
    if (!scene || scene.contentOrigin !== 'official' || !scene.officialAssetKeys) {
      if (!(scene?.contentOrigin === 'imported' && scene.selectedCloudProvider && scene.cloudRemotePath)) {
        return;
      }
    }
    const shouldPoll = isCacheSheetVisible
      || headerDownloadEntry?.status === 'resolving'
      || headerDownloadEntry?.status === 'downloading'
      || headerDownloadEntry?.status === 'paused';
    if (!shouldPoll) {
      return;
    }
    const timer = setInterval(() => {
      void refreshHeaderCloudCacheState();
    }, 900);
    return () => {
      clearInterval(timer);
    };
  }, [headerDownloadEntry?.status, isCacheSheetVisible, refreshHeaderCloudCacheState, scene]);

  const handleOpenCloudDriveSettings = useCallback(() => {
    router.push('/cloud-drives');
  }, [router]);

  const handleOpenHeaderBindPicker = useCallback(() => {
    const hasConfiguredProvider = scene?.availableCloudProviders?.some((item) => item.isConfigured) ?? false;
    if (!headerProviderState?.provider) {
      Alert.alert(
        '当前没有默认网盘',
        hasConfiguredProvider
          ? '你已经授权了网盘，但还没有设置推荐默认网盘。请先去「我的」→「我的网盘」里完成设置。'
          : '请先在「我的」→「我的网盘」里授权至少一个网盘来源。',
      );
      return;
    }
    setIsHeaderBindPickerVisible(true);
  }, [headerProviderState?.provider, scene?.availableCloudProviders]);

  const handleOpenMyCloudDrives = useCallback(() => {
    const hasConfiguredProvider = scene?.availableCloudProviders?.some((item) => item.isConfigured) ?? false;
    if (!scene || scene.contentOrigin !== 'official' || !scene.officialAssetKeys) {
      handleOpenCloudDriveSettings();
      return;
    }

    if (headerProviderState?.provider) {
      Alert.alert(
        '去我的网盘',
        `你可以先去「我的网盘」检查授权、同步目录和默认来源，也可以直接从当前默认的${headerProviderState.label}里绑定这条视频。\n\n注意：这条视频也可能实际保存在其他网盘来源里。`,
        [
          {
            text: '取消',
            style: 'cancel',
          },
          {
            text: '去授权/配置',
            onPress: handleOpenCloudDriveSettings,
          },
          {
            text: `从默认${headerProviderState.label}绑定`,
            onPress: handleOpenHeaderBindPicker,
          },
        ],
      );
      return;
    }

    Alert.alert(
      '去我的网盘',
      hasConfiguredProvider
        ? '你已经授权了网盘，但当前还没有设置推荐默认网盘。请先去「我的网盘」设置默认来源；如果这条视频实际保存在其他网盘，也需要在那里完成同步或切换默认来源。'
        : '你还没有授权可用网盘。请先去「我的网盘」完成授权；如果之后发现视频保存在其他网盘，也可以回来重新选择来源。',
      [
        {
          text: '取消',
          style: 'cancel',
        },
        {
          text: hasConfiguredProvider ? '去设置默认网盘' : '去授权网盘',
          onPress: handleOpenCloudDriveSettings,
        },
      ],
    );
  }, [handleOpenCloudDriveSettings, handleOpenHeaderBindPicker, headerProviderState?.label, headerProviderState?.provider, scene]);

  const handleBindHeaderCloudFile = useCallback(async (file: SelectedCloudVideoFile) => {
    if (!scene?.officialAssetKeys) {
      return;
    }
    await bindOfficialSceneToProvider({
      sceneId: scene.id,
      provider: file.provider,
      officialVideoKey: scene.officialAssetKeys.videoKey,
      remotePath: file.remotePath,
      remoteFileId: file.remoteFileId,
    });
    setIsHeaderBindPickerVisible(false);
    await loadScene(true, true);
    await refreshHeaderCloudCacheState();
    Alert.alert('绑定成功', `已绑定到${file.provider === 'baidu_pan' ? '百度网盘' : '云盘'}，后续会按当前默认网盘来源播放。`);
  }, [loadScene, refreshHeaderCloudCacheState, scene]);

  const handleStartCacheDownload = useCallback(async () => {
    if (!scene) {
      return;
    }
    const provider = headerProviderState?.provider;
    const providerSyncStatus = headerProviderState?.syncStatus;
    if (!provider) {
      Alert.alert('暂无可缓存来源', '请先在「我的」→「我的网盘」里完成当前视频来源配置。');
      return;
    }
    if (scene.contentOrigin === 'imported' && scene.selectedCloudProvider && scene.cloudRemotePath) {
      if (providerSyncStatus === 'not_connected') {
        handleOpenMyCloudDrives();
        return;
      }
      setIsCacheActionBusy(true);
      try {
        await downloadImportedCloudVideo({
          sceneId: scene.id,
          provider,
          remotePath: scene.cloudRemotePath,
        });
        setIsCacheSheetVisible(true);
        await refreshHeaderCloudCacheState();
      } catch (error) {
        Alert.alert('缓存失败', error instanceof Error ? error.message : '请稍后重试');
      } finally {
        setIsCacheActionBusy(false);
      }
      return;
    }
    if (!scene.officialAssetKeys || (providerSyncStatus !== 'available' && providerSyncStatus !== 'cached')) {
      Alert.alert('暂无可缓存来源', '请先在「我的」→「我的网盘」里完成当前视频来源同步。');
      return;
    }
    setIsCacheActionBusy(true);
    try {
      await downloadOfficialSceneVideo({
        sceneId: scene.id,
        provider,
        officialAssetKeys: scene.officialAssetKeys,
      });
      setIsCacheSheetVisible(true);
      await refreshHeaderCloudCacheState();
    } catch (error) {
      Alert.alert('缓存失败', error instanceof Error ? error.message : '请稍后重试');
    } finally {
      setIsCacheActionBusy(false);
    }
  }, [handleOpenMyCloudDrives, headerProviderState, refreshHeaderCloudCacheState, scene]);

  const handlePauseCacheDownload = useCallback(async () => {
    if (!scene || !headerProviderState?.provider) {
      return;
    }
    setIsCacheActionBusy(true);
    try {
      await pauseOfficialSceneVideoDownload(scene.id, headerProviderState.provider);
      await refreshHeaderCloudCacheState();
    } catch (error) {
      Alert.alert('暂停失败', error instanceof Error ? error.message : '请稍后重试');
    } finally {
      setIsCacheActionBusy(false);
    }
  }, [headerProviderState?.provider, refreshHeaderCloudCacheState, scene]);

  const handleResumeCacheDownload = useCallback(async () => {
    if (!scene || !headerProviderState?.provider) {
      return;
    }
    setIsCacheActionBusy(true);
    try {
      await resumeOfficialSceneVideoDownload(scene.id, headerProviderState.provider);
      await refreshHeaderCloudCacheState();
    } catch (error) {
      Alert.alert('继续失败', error instanceof Error ? error.message : '请稍后重试');
    } finally {
      setIsCacheActionBusy(false);
    }
  }, [headerProviderState?.provider, refreshHeaderCloudCacheState, scene]);

  const handleDeleteCacheDownload = useCallback(async () => {
    if (!scene || !headerProviderState?.provider) {
      return;
    }
    Alert.alert('删除缓存', '这会删除当前视频的本地缓存文件和下载记录。', [
      { text: '取消', style: 'cancel' },
      {
        text: '删除',
        style: 'destructive',
        onPress: () => {
          void (async () => {
            setIsCacheActionBusy(true);
            try {
              await removeOfficialSceneVideoDownload(scene.id, headerProviderState.provider);
              await refreshHeaderCloudCacheState();
              await loadScene(true, true);
            } catch (error) {
              Alert.alert('删除失败', error instanceof Error ? error.message : '请稍后重试');
            } finally {
              setIsCacheActionBusy(false);
            }
          })();
        },
      },
    ]);
  }, [headerProviderState?.provider, loadScene, refreshHeaderCloudCacheState, scene]);

  const handleShowSlowDownloadHelp = useCallback(() => {
    Alert.alert(CLOUD_DOWNLOAD_SLOW_HELP_TITLE, CLOUD_DOWNLOAD_SLOW_HELP_MESSAGE);
  }, []);

  const headerCacheStatusText = headerDownloadEntry
    && (headerDownloadEntry.status === 'resolving' || headerDownloadEntry.status === 'downloading' || headerDownloadEntry.status === 'paused')
    ? `${getDownloadStatusLabel(headerDownloadEntry.status)} ${formatDownloadPercent(headerDownloadEntry.progress)}`
    : headerDownloadEntry?.status === 'completed'
      ? '已缓存'
      : null;
  const isImportedDeleteMenuEnabled = isUserManagedImportedScene(scene);
  const isImportedCloudCacheEnabled = Boolean(
    scene?.contentOrigin === 'imported'
    && scene.selectedCloudProvider
    && scene.cloudRemotePath
  );
  const canOpenHeaderCacheMenu = Boolean(
    scene
  );
  const isCacheTaskActive = headerDownloadEntry?.status === 'resolving' || headerDownloadEntry?.status === 'downloading' || headerDownloadEntry?.status === 'paused';
  const shouldShowCacheSheetEntry = Boolean(headerDownloadEntry || isCacheActionBusy);
  const cacheProgressRatio = Math.max(0, Math.min(1, headerDownloadEntry?.progress || 0));
  const cachePrimaryActionLabel = isImportedCloudCacheEnabled && headerProviderState?.syncStatus === 'not_connected'
    ? '去我的网盘'
    : headerDownloadEntry?.status === 'paused'
      ? '继续缓存'
      : headerDownloadEntry?.status === 'completed'
        ? '重新缓存'
        : headerDownloadEntry?.status === 'error'
          ? '重新缓存'
          : '缓存该视频';
  const shouldShowHeaderCachePrimaryAction = Boolean(
    headerProviderState?.provider
    && !isCacheTaskActive
    && headerDownloadEntry?.status !== 'completed'
  );
  const cacheDetailText = `${formatBytes(headerDownloadEntry?.totalBytesWritten)} / ${formatBytes(headerDownloadEntry?.totalBytesExpectedToWrite)}`;
  const isManualHeaderBinding = headerProviderState?.bindingType === 'manual';

  const handleBack = () => router.back();

  const handleDeleteImportedVideo = useCallback(() => {
    if (!scene || !isImportedDeleteMenuEnabled || isCacheActionBusy) {
      return;
    }
    const currentScene = scene;
    const config = getImportedVideoDeleteConfirmation(currentScene);
    Alert.alert(config.title, config.message, [
      { text: '取消', style: 'cancel' },
      {
        text: config.confirmText,
        style: 'destructive',
        onPress: () => {
          void (async () => {
            setIsCacheActionBusy(true);
            try {
              await deleteUserVideoEntry(currentScene.id);
              invalidateVideoSceneCaches([currentScene.id]);
              setIsHeaderMenuVisible(false);
              router.back();
            } catch (error) {
              Alert.alert('删除失败', error instanceof Error ? error.message : '请稍后重试');
            } finally {
              setIsCacheActionBusy(false);
            }
          })();
        },
      },
    ]);
  }, [isCacheActionBusy, isImportedDeleteMenuEnabled, router, scene]);

  // ── Move-to-collection (user-imported videos only) ────────
  // Tapping "移动到合集" in the three-dot menu opens a sub-sheet
  // listing every user collection. Pick a target → rewrite the
  // entry's `collectionId`, refresh caches, close the menu and
  // stay on the player (so the user can keep practicing without
  // losing their place).
  const handleOpenMovePicker = useCallback(async () => {
    if (!scene) return;
    setIsHeaderMenuVisible(false);
    setIsMovePickerVisible(true);
    setIsMovePickerLoading(true);
    try {
      const list = await listUserCollections();
      setMovePickerCollections(list.map((c) => ({
        id: c.id,
        title: c.title,
        is_default: c.is_default,
      })));
    } catch (error) {
      console.warn('[VideoScene] load move picker collections failed', {
        sceneId: scene.id,
        error: error instanceof Error ? error.message : String(error),
      });
      setMovePickerCollections([]);
    } finally {
      setIsMovePickerLoading(false);
    }
  }, [scene]);

  const handleCloseMovePicker = useCallback(() => {
    setIsMovePickerVisible(false);
  }, []);

  const handlePickMoveTarget = useCallback(
    async (targetWireId: string) => {
      const currentScene = scene;
      if (!currentScene) return;
      try {
        const updated = await setUserVideoCollection(currentScene.id, targetWireId);
        if (!updated) {
          Alert.alert('移动失败', '找不到这个视频');
          return;
        }
        // Bust caches so the home grid and the back-navigated
        // collection detail both re-read the new collectionId.
        invalidateVideoSceneCaches([currentScene.id]);
        invalidateCollectionsCache();
        setIsMovePickerVisible(false);
        const targetTitle = movePickerCollections.find(
          (c) => encodeUserCollectionId(c.id) === targetWireId,
        )?.title ?? '合集';
        Alert.alert('已移动', `已移到 ${targetTitle}`);
      } catch (error) {
        Alert.alert('移动失败', error instanceof Error ? error.message : String(error));
      }
    },
    [movePickerCollections, scene],
  );

  const handleUnbindCloudVideo = useCallback(() => {
    if (!scene || !headerProviderState?.provider || !isManualHeaderBinding) {
      return;
    }
    Alert.alert('解绑云盘视频', '这会移除当前视频与该网盘文件的绑定关系，并清除这一路来源的本地缓存记录。', [
      {
        text: '取消',
        style: 'cancel',
      },
      {
        text: '解绑',
        style: 'destructive',
        onPress: () => {
          void (async () => {
            setIsCacheActionBusy(true);
            try {
              await unbindOfficialSceneFromProvider(scene.id, headerProviderState.provider);
              await removeOfficialSceneVideoDownload(scene.id, headerProviderState.provider);
              setIsHeaderMenuVisible(false);
              await refreshHeaderCloudCacheState();
              await loadScene(true, true);
              Alert.alert('已解绑', '当前视频已解除与该云盘文件的绑定。');
            } catch (error) {
              Alert.alert('解绑失败', error instanceof Error ? error.message : '请稍后重试');
            } finally {
              setIsCacheActionBusy(false);
            }
          })();
        },
      },
    ]);
  }, [headerProviderState?.provider, isManualHeaderBinding, loadScene, refreshHeaderCloudCacheState, scene]);

  if (isLoading) {
    return (
      <View style={styles.loadingContainer}>
        <ActivityIndicator size="large" color={colors.primary} />
        <Text style={styles.loadingText}>正在准备视频场景…</Text>
      </View>
    );
  }

  if (!scene) {
    return (
      <View style={styles.loadingContainer}>
        <Text style={styles.emptyTitle}>未找到该视频场景</Text>
        <Pressable style={styles.backOnlyBtn} onPress={handleBack}>
          <Text style={styles.backOnlyBtnText}>返回</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <View pointerEvents="box-none" style={[styles.headerRow, { paddingTop: Math.max(insets.top - 2, 0) }]}> 
        <Pressable style={styles.backBtn} onPress={handleBack}>
          <ChevronLeft size={24} color="#FFFFFF" />
        </Pressable>
        <View pointerEvents="none" style={styles.headerSpacer} />
        {canOpenHeaderCacheMenu ? (
          <Pressable style={styles.headerMenuBtn} onPress={() => setIsHeaderMenuVisible(true)}>
            {headerCacheStatusText ? <Text style={styles.headerMenuMetaText}>{headerCacheStatusText}</Text> : null}
            <MoreVertical size={22} color="#FFFFFF" />
          </Pressable>
        ) : null}
      </View>

      <View style={[styles.content, { paddingTop: insets.top, paddingBottom: Math.max(insets.bottom + 18, 18) }]}> 
        <VideoLearningPlayer
          scene={scene}
          onRefreshScene={loadScene}
          onRefreshSubtitles={refreshSceneSubtitles}
        />
      </View>

      <Modal
        visible={isHeaderMenuVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setIsHeaderMenuVisible(false)}
      >
        <View style={styles.headerMenuOverlay}>
          <Pressable style={StyleSheet.absoluteFillObject} onPress={() => setIsHeaderMenuVisible(false)} />
          <View style={[styles.headerMenuCard, { top: Math.max(insets.top + 34, 34) }]}>
            {scene?.contentOrigin === 'official' && scene.officialAssetKeys ? (
              <>
                {headerCacheStatusText ? (
                  <View style={styles.headerMenuStatusRow}>
                    <Text style={styles.headerMenuStatusLabel}>{headerCacheStatusText}</Text>
                    {headerProviderState?.label ? <Text style={styles.headerMenuStatusHint}>{headerProviderState.label}</Text> : null}
                  </View>
                ) : null}
                {shouldShowCacheSheetEntry ? (
                  <Pressable
                    style={styles.headerMenuItem}
                    onPress={() => {
                      setIsHeaderMenuVisible(false);
                      setIsCacheSheetVisible(true);
                    }}
                  >
                    <Text style={styles.headerMenuItemText}>查看缓存下载</Text>
                  </Pressable>
                ) : null}
                {isManualHeaderBinding ? (
                  <Pressable
                    style={styles.headerMenuItem}
                    onPress={handleUnbindCloudVideo}
                  >
                    <Text style={styles.headerMenuItemText}>解绑</Text>
                  </Pressable>
                ) : (
                  <Pressable
                    style={styles.headerMenuItem}
                    onPress={() => {
                      setIsHeaderMenuVisible(false);
                      handleOpenMyCloudDrives();
                    }}
                  >
                    <Text style={styles.headerMenuItemText}>绑定云盘视频</Text>
                  </Pressable>
                )}
                {shouldShowHeaderCachePrimaryAction ? (
                  <Pressable
                    style={styles.headerMenuItem}
                    onPress={() => {
                      setIsHeaderMenuVisible(false);
                      void handleStartCacheDownload();
                    }}
                  >
                    <Text style={styles.headerMenuItemText}>{cachePrimaryActionLabel}</Text>
                  </Pressable>
                ) : null}
              </>
            ) : isImportedDeleteMenuEnabled ? (
              <>
                {isImportedCloudCacheEnabled && headerCacheStatusText ? (
                  <View style={styles.headerMenuStatusRow}>
                    <Text style={styles.headerMenuStatusLabel}>{headerCacheStatusText}</Text>
                    {headerProviderState?.label ? <Text style={styles.headerMenuStatusHint}>{headerProviderState.label}</Text> : null}
                  </View>
                ) : null}
                {isImportedCloudCacheEnabled && shouldShowCacheSheetEntry ? (
                  <Pressable
                    style={styles.headerMenuItem}
                    onPress={() => {
                      setIsHeaderMenuVisible(false);
                      setIsCacheSheetVisible(true);
                    }}
                  >
                    <Text style={styles.headerMenuItemText}>查看缓存下载</Text>
                  </Pressable>
                ) : null}
                {isImportedCloudCacheEnabled && shouldShowHeaderCachePrimaryAction ? (
                  <Pressable
                    style={styles.headerMenuItem}
                    onPress={() => {
                      setIsHeaderMenuVisible(false);
                      void handleStartCacheDownload();
                    }}
                  >
                    <Text style={styles.headerMenuItemText}>{cachePrimaryActionLabel}</Text>
                  </Pressable>
                ) : null}
                <Pressable
                  style={styles.headerMenuItem}
                  onPress={handleOpenMovePicker}
                >
                  <Text style={styles.headerMenuItemText}>移动到合集</Text>
                </Pressable>
                <Pressable
                  style={styles.headerMenuItem}
                  onPress={handleDeleteImportedVideo}
                >
                  <Text style={styles.headerMenuItemText}>删除</Text>
                </Pressable>
              </>
            ) : null}
          </View>
        </View>
      </Modal>

      <Modal
        visible={isHeaderBindPickerVisible}
        transparent
        animationType="slide"
        onRequestClose={() => setIsHeaderBindPickerVisible(false)}
      >
        <View style={styles.sheetOverlay}>
          <Pressable style={{ flex: 1 }} onPress={() => setIsHeaderBindPickerVisible(false)} />
          <View style={styles.customSheet}>
            <View style={styles.customSheetHandle} />
            <View style={styles.customSheetHeader}>
              <View style={styles.videoAiPickerHeaderInfo}>
                <Text style={styles.customSheetTitle}>绑定推荐视频</Text>
                <Text style={styles.videoAiPickerHint} numberOfLines={2}>{scene.card.title}</Text>
              </View>
              <Pressable onPress={() => setIsHeaderBindPickerVisible(false)}>
                <X size={20} color={colors.text.secondary} />
              </Pressable>
            </View>
            <View style={styles.bindPickerSheetBody}>
              <VideoSourcePickerContent
                mode="bind"
                visible={isHeaderBindPickerVisible}
                fixedProvider={headerProviderState?.provider ?? null}
                onRequestGoToMountDrives={handleOpenCloudDriveSettings}
                onCloudFileSelected={handleBindHeaderCloudFile}
              />
            </View>
          </View>
        </View>
      </Modal>

      <Modal
        visible={isCacheSheetVisible}
        transparent
        animationType="slide"
        onRequestClose={() => setIsCacheSheetVisible(false)}
      >
        <View style={styles.sheetOverlay}>
          <Pressable style={{ flex: 1 }} onPress={() => setIsCacheSheetVisible(false)} />
          <View style={styles.customSheet}>
            <View style={styles.customSheetHandle} />
            <View style={styles.customSheetHeader}>
              <View style={styles.videoAiPickerHeaderInfo}>
                <Text style={styles.customSheetTitle}>缓存下载</Text>
                <View style={styles.sheetHintRow}>
                  <Text style={styles.videoAiPickerHint} numberOfLines={2}>{scene.card.title}</Text>
                  <Pressable onPress={handleShowSlowDownloadHelp} hitSlop={8}>
                    <Text style={styles.sheetHintLink}>下载慢？</Text>
                  </Pressable>
                </View>
              </View>
              <Pressable onPress={() => setIsCacheSheetVisible(false)}>
                <X size={20} color={colors.text.secondary} />
              </Pressable>
            </View>

            {headerProviderState ? (
              <View style={styles.cacheStatusCard}>
                <View style={styles.cacheStatusTopRow}>
                  <View style={styles.cacheStatusTextWrap}>
                    <Text style={styles.cacheStatusTitle}>{headerProviderState.label} · {getDownloadStatusLabel(headerDownloadEntry?.status)}</Text>
                    <Text style={styles.cacheStatusHint}>{headerDownloadEntry?.errorMessage || cacheDetailText}</Text>
                  </View>
                  <Text style={styles.cacheStatusPercent}>{formatDownloadPercent(cacheProgressRatio)}</Text>
                </View>
                <View style={styles.cacheProgressTrack}>
                  <View style={[styles.cacheProgressFill, { width: `${cacheProgressRatio * 100}%` }]} />
                </View>
                <View style={styles.cacheMetaRow}>
                  <Text style={styles.cacheMetaText}>速度 {formatSpeed(headerDownloadEntry?.speedBytesPerSecond)}</Text>
                  <Text style={styles.cacheMetaText}>{getProviderSyncStatusLabel(headerProviderState.syncStatus)}</Text>
                </View>
              </View>
            ) : (
              <View style={styles.cacheEmptyCard}>
                <Text style={styles.cacheEmptyTitle}>当前没有可缓存的云来源</Text>
                <Text style={styles.cacheEmptyText}>请先在「我的」→「我的网盘」里完成来源同步，然后回来缓存这个视频。</Text>
              </View>
            )}

            <View style={styles.cacheActionRow}>
              {headerProviderState?.provider ? (
                isCacheTaskActive ? (
                  headerDownloadEntry?.status === 'paused' ? (
                    <Pressable style={[styles.cachePrimaryBtn, isCacheActionBusy && styles.cacheBtnDisabled]} onPress={() => void handleResumeCacheDownload()} disabled={isCacheActionBusy}>
                      <Text style={styles.cachePrimaryBtnText}>{isCacheActionBusy ? '处理中…' : '继续缓存'}</Text>
                    </Pressable>
                  ) : (
                    <Pressable style={[styles.cachePrimaryBtn, isCacheActionBusy && styles.cacheBtnDisabled]} onPress={() => void handlePauseCacheDownload()} disabled={isCacheActionBusy}>
                      <Text style={styles.cachePrimaryBtnText}>{isCacheActionBusy ? '处理中…' : '暂停缓存'}</Text>
                    </Pressable>
                  )
                ) : (
                  <Pressable style={[styles.cachePrimaryBtn, isCacheActionBusy && styles.cacheBtnDisabled]} onPress={() => void handleStartCacheDownload()} disabled={isCacheActionBusy}>
                    <Text style={styles.cachePrimaryBtnText}>{isCacheActionBusy ? '处理中…' : cachePrimaryActionLabel}</Text>
                  </Pressable>
                )
              ) : (
                <Pressable style={styles.cachePrimaryBtn} onPress={handleOpenMyCloudDrives}>
                  <Text style={styles.cachePrimaryBtnText}>去我的网盘</Text>
                </Pressable>
              )}
              {headerDownloadEntry ? (
                <Pressable style={[styles.cacheSecondaryBtn, isCacheActionBusy && styles.cacheBtnDisabled]} onPress={() => void handleDeleteCacheDownload()} disabled={isCacheActionBusy}>
                  <Text style={styles.cacheSecondaryBtnText}>{headerDownloadEntry.status === 'completed' ? '删除缓存' : '取消并删除'}</Text>
                </Pressable>
              ) : null}
            </View>
          </View>
        </View>
      </Modal>

      {/* ── Move-to-collection picker (user-imported videos only) ──
            Same visual family as the collection-detail move picker:
            list of user collections with a "默认" badge on the
            default one. We don't pre-filter "current" because the
            video player doesn't know which collection the user
            opened it from — any non-default target is valid. */}
      <Modal
        visible={isMovePickerVisible}
        transparent
        animationType="slide"
        onRequestClose={handleCloseMovePicker}
      >
        <View style={styles.sheetOverlay}>
          <Pressable
            style={{ flex: 1 }}
            onPress={handleCloseMovePicker}
          />
          <View style={styles.movePickerSheet}>
            <View style={styles.movePickerSheetHandle} />
            <Text style={styles.movePickerSheetTitle}>移动到哪个合集</Text>
            {isMovePickerLoading ? (
              <ActivityIndicator size="small" color={colors.primary} />
            ) : (
              <ScrollView style={styles.movePickerSheetList} showsVerticalScrollIndicator={false}>
                {movePickerCollections.map((c) => {
                  const wireId = encodeUserCollectionId(c.id);
                  return (
                    <Pressable
                      key={c.id}
                      style={styles.movePickerSheetRow}
                      onPress={() => void handlePickMoveTarget(wireId)}
                    >
                      <Text style={styles.movePickerSheetRowText} numberOfLines={1}>
                        {c.title}
                      </Text>
                      {c.is_default ? (
                        <Text style={styles.movePickerSheetRowBadge}>默认</Text>
                      ) : null}
                    </Pressable>
                  );
                })}
                {movePickerCollections.length === 0 ? (
                  <Text style={styles.movePickerSheetEmpty}>还没有合集可移动</Text>
                ) : null}
              </ScrollView>
            )}
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#000000',
  },
  sheetOverlay: {
    flex: 1,
    backgroundColor: 'rgba(15, 23, 42, 0.22)',
    justifyContent: 'flex-end',
  },
  customSheet: {
    maxHeight: '78%',
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    backgroundColor: '#FFFFFF',
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
    paddingBottom: spacing.lg,
  },

  // ── Move-to-collection picker (user-imported videos) ─────
  // Visually matches the home page's addMenu / pickerSheet:
  // surface card, 28px top radius, hugged content. The handle
  // sits at the top so it reads as "another bottom sheet" in
  // this same UX family.
  movePickerSheet: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    paddingBottom: spacing.xl,
    gap: spacing.md,
    maxHeight: '70%',
  },
  movePickerSheetHandle: {
    width: 40,
    height: 5,
    backgroundColor: colors.border.default,
    borderRadius: borderRadius.full,
    alignSelf: 'center',
    marginBottom: spacing.sm,
  },
  movePickerSheetTitle: {
    fontSize: fontSize.lg,
    fontWeight: fontWeight.bold,
    color: colors.text.primary,
  },
  movePickerSheetList: {
    maxHeight: 360,
  },
  movePickerSheetRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.border.default,
  },
  movePickerSheetRowText: {
    flex: 1,
    fontSize: fontSize.base,
    color: colors.text.primary,
    fontWeight: fontWeight.medium,
  },
  movePickerSheetRowBadge: {
    fontSize: fontSize.xs,
    color: colors.text.tertiary,
    backgroundColor: 'rgba(0,0,0,0.04)',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: borderRadius.sm,
    overflow: 'hidden',
    marginLeft: spacing.sm,
  },
  movePickerSheetEmpty: {
    fontSize: fontSize.sm,
    color: colors.text.tertiary,
    textAlign: 'center',
    paddingVertical: spacing.lg,
  },
  bindPickerSheetBody: {
    minHeight: 360,
  },
  customSheetHandle: {
    alignSelf: 'center',
    width: 44,
    height: 5,
    borderRadius: borderRadius.full,
    backgroundColor: '#CBD5E1',
    marginBottom: spacing.md,
  },
  customSheetHeader: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: spacing.md,
    marginBottom: spacing.md,
  },
  videoAiPickerHeaderInfo: {
    flex: 1,
    gap: 4,
  },
  sheetHintRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    columnGap: 8,
    rowGap: 4,
  },
  customSheetTitle: {
    color: '#0F172A',
    fontSize: fontSize.base,
    fontWeight: fontWeight.bold,
  },
  videoAiPickerHint: {
    color: '#64748B',
    fontSize: fontSize.sm,
    lineHeight: 20,
  },
  sheetHintLink: {
    color: colors.primary,
    fontSize: fontSize.sm,
    fontWeight: fontWeight.bold,
    textDecorationLine: 'underline',
  },
  loadingContainer: {
    flex: 1,
    backgroundColor: '#F5F7FB',
    justifyContent: 'center',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.xl,
  },
  loadingText: {
    color: '#64748B',
    fontSize: fontSize.sm,
  },
  emptyTitle: {
    color: '#0F172A',
    fontSize: fontSize.lg,
    fontWeight: fontWeight.bold,
  },
  backOnlyBtn: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    backgroundColor: '#E2E8F0',
    borderRadius: borderRadius.lg,
  },
  backOnlyBtnText: {
    color: '#0F172A',
    fontSize: fontSize.sm,
    fontWeight: fontWeight.bold,
  },
  headerRow: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    zIndex: 10,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.xs,
    paddingBottom: 0,
  },
  headerMenuBtn: {
    minHeight: 40,
    paddingHorizontal: spacing.sm,
    backgroundColor: 'transparent',
    borderWidth: 0,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
  },
  headerMenuMetaText: {
    color: '#FFFFFF',
    fontSize: fontSize.xs,
    fontWeight: fontWeight.bold,
  },
  headerSpacer: {
    flex: 1,
  },
  backBtn: {
    minWidth: 40,
    minHeight: 40,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'transparent',
    borderWidth: 0,
  },
  headerTitle: {
    flex: 1,
    color: '#FFFFFF',
    fontSize: fontSize.lg,
    fontWeight: fontWeight.bold,
  },
  headerMenuOverlay: {
    flex: 1,
    backgroundColor: 'rgba(15, 23, 42, 0.08)',
  },
  headerMenuCard: {
    position: 'absolute',
    right: spacing.xs,
    minWidth: 180,
    borderRadius: 18,
    backgroundColor: '#FFFFFF',
    paddingVertical: spacing.xs,
    borderWidth: 1,
    borderColor: '#E2E8F0',
    shadowColor: '#0F172A',
    shadowOpacity: 0.12,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 8 },
    elevation: 8,
  },
  headerMenuStatusRow: {
    paddingHorizontal: spacing.md,
    paddingTop: spacing.sm,
    paddingBottom: spacing.xs,
    gap: 2,
  },
  headerMenuStatusLabel: {
    color: '#0F172A',
    fontSize: fontSize.sm,
    fontWeight: fontWeight.bold,
  },
  headerMenuStatusHint: {
    color: '#64748B',
    fontSize: fontSize.xs,
  },
  headerMenuItem: {
    minHeight: 42,
    paddingHorizontal: spacing.md,
    justifyContent: 'center',
  },
  headerMenuItemText: {
    color: '#0F172A',
    fontSize: fontSize.sm,
    fontWeight: fontWeight.medium,
  },
  headerSubTitle: {
    paddingHorizontal: spacing.lg,
    marginTop: spacing.sm,
    marginBottom: spacing.md,
    color: '#64748B',
    fontSize: fontSize.sm,
  },
  content: {
    flex: 1,
    paddingHorizontal: spacing.lg,
    backgroundColor: '#F5F7FB',
  },
  videoCard: {
    marginHorizontal: -spacing.lg,
    backgroundColor: '#000000',
    borderRadius: 0,
    padding: 0,
    borderWidth: 0,
    marginBottom: spacing.xs,
  },
  videoCardFullscreen: {
    width: '100%',
    height: '100%',
    marginBottom: 0,
    padding: 0,
    borderWidth: 0,
    borderRadius: 0,
    backgroundColor: '#000000',
  },
  videoFrame: {
    width: '100%',
    aspectRatio: 16 / 9,
    borderRadius: 0,
    overflow: 'hidden',
    backgroundColor: '#111827',
  },
  videoFrameFullscreen: {
    width: '100%',
    backgroundColor: '#000000',
  },
  fullscreenViewport: {
    flex: 1,
    width: '100%',
    height: '100%',
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
    backgroundColor: '#000000',
  },
  fullscreenVideoFrame: {
    backgroundColor: '#000000',
  },
  fullscreenVideoFrameFill: {
    width: '100%',
    height: '100%',
    flex: 0,
    aspectRatio: undefined,
    borderRadius: 0,
  },
  video: {
    width: '100%',
    height: '100%',
  },
  videoPosterOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: '#020617',
    zIndex: 2,
  },
  videoPosterImage: {
    width: '100%',
    height: '100%',
  },
  fullscreenTouchLayer: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 1,
  },
  fullscreenHudLayer: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 3,
    justifyContent: 'space-between',
  },
  fullscreenHudTopRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.md,
  },
  fullscreenStatusPill: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: borderRadius.full,
    backgroundColor: 'rgba(15,23,42,0.58)',
  },
  fullscreenStatusText: {
    color: '#FFFFFF',
    fontSize: fontSize.xs,
    fontWeight: fontWeight.bold,
  },
  fullscreenHudBottom: {
    paddingHorizontal: spacing.md,
    gap: spacing.sm,
  },
  fullscreenToolRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'center',
    alignItems: 'center',
    gap: 8,
  },
  fullscreenToolBtn: {
    minHeight: 38,
    paddingHorizontal: 12,
    borderRadius: 999,
    backgroundColor: 'rgba(15,23,42,0.68)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  fullscreenToolBtnActive: {
    backgroundColor: 'rgba(37,99,235,0.88)',
  },
  fullscreenToolBtnMuted: {
    backgroundColor: 'rgba(71,85,105,0.82)',
  },
  fullscreenToolLabel: {
    color: '#FFFFFF',
    fontSize: fontSize.xs,
    fontWeight: fontWeight.bold,
  },
  fullscreenTransportRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    gap: spacing.sm,
  },
  fullscreenTransportBtn: {
    minWidth: 72,
    minHeight: 58,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 18,
    backgroundColor: 'rgba(15,23,42,0.68)',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
  },
  fullscreenTransportText: {
    color: '#FFFFFF',
    fontSize: fontSize.xs,
    fontWeight: fontWeight.bold,
  },
  fullscreenPlayBtn: {
    width: 72,
    height: 72,
    borderRadius: 999,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(37,99,235,0.95)',
  },
  fullscreenToggleBtn: {
    position: 'absolute',
    top: spacing.sm,
    right: spacing.sm,
    width: 36,
    height: 36,
    borderRadius: borderRadius.full,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(15,23,42,0.55)',
  },
  fullscreenToggleBtnFullscreen: {
    top: 16,
    right: 16,
  },
  videoTopMaximizeBtn: {
    position: 'absolute',
    top: spacing.xs,
    right: 42,
    zIndex: 12,
    elevation: 12,
    minWidth: 40,
    minHeight: 40,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'transparent',
  },
  nativeFullscreenModal: {
    flex: 1,
    backgroundColor: '#000000',
  },
  shadowingModalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(15,23,42,0.45)',
    justifyContent: 'flex-end',
  },
  shadowingModalDismissLayer: {
    ...StyleSheet.absoluteFillObject,
  },
  shadowingModalCard: {
    width: '100%',
    maxHeight: '86%',
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    overflow: 'hidden',
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: '#DBEAFE',
  },
  videoAiPickerBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(15,23,42,0.45)',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.lg,
  },
  videoAiPickerDismissLayer: {
    ...StyleSheet.absoluteFillObject,
  },
  videoAiPickerModalCard: {
    width: '100%',
    maxWidth: 560,
    maxHeight: '72%',
    borderRadius: 24,
    overflow: 'hidden',
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: '#DBEAFE',
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.lg,
    paddingBottom: spacing.md,
    gap: spacing.md,
  },
  videoAiPickerHeader: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: spacing.sm,
  },
  videoAiPickerHeaderTextWrap: {
    flex: 1,
    gap: 4,
  },
  videoAiPickerTitle: {
    color: '#0F172A',
    fontSize: fontSize.lg,
    fontWeight: fontWeight.bold,
  },
  videoAiPickerSubtitle: {
    color: '#64748B',
    fontSize: fontSize.sm,
    lineHeight: 20,
  },
  videoAiPickerCloseBtn: {
    width: 34,
    height: 34,
    borderRadius: 999,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#F8FAFC',
    borderWidth: 1,
    borderColor: '#E2E8F0',
  },
  videoAiPickerSheet: {
    maxHeight: '82%',
    minHeight: 320,
  },
  videoAiPickerProgressSection: {
    gap: spacing.xs,
    paddingHorizontal: spacing.xs,
    paddingBottom: spacing.sm,
  },
  videoAiPickerProgressTopRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  videoAiPickerProgressText: {
    flex: 1,
    color: '#0F172A',
    fontSize: fontSize.sm,
    lineHeight: 20,
    fontWeight: fontWeight.medium,
  },
  videoAiPickerProgressCount: {
    color: '#2563EB',
    fontSize: fontSize.xs,
    fontWeight: fontWeight.bold,
    marginLeft: 24,
  },
  videoAiPickerListHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingTop: spacing.xs,
    paddingBottom: spacing.xs,
  },
  videoAiPickerRegenerateBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: borderRadius.full,
    backgroundColor: 'rgba(37,99,235,0.08)',
  },
  videoAiPickerRegenerateBtnText: {
    fontSize: fontSize.xs,
    color: colors.primary,
    fontWeight: fontWeight.semibold,
  },
  videoAiPickerSectionTitle: {
    color: '#64748B',
    fontSize: fontSize.xs,
    fontWeight: fontWeight.bold,
  },
  videoAiPickerEmptyState: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: spacing.xl,
    paddingHorizontal: spacing.lg,
    gap: spacing.xs,
  },
  videoAiPickerEmptyTitle: {
    color: '#0F172A',
    fontSize: fontSize.base,
    fontWeight: fontWeight.bold,
  },
  videoAiPickerEmptyHint: {
    color: '#64748B',
    fontSize: fontSize.sm,
    lineHeight: 20,
    textAlign: 'center',
  },
  videoAiPickerGenerateBtn: {
    minHeight: 42,
    paddingHorizontal: spacing.lg,
    borderRadius: borderRadius.full,
    backgroundColor: '#2563EB',
    alignItems: 'center',
    justifyContent: 'center',
  },
  videoAiPickerGenerateBtnText: {
    color: '#FFFFFF',
    fontSize: fontSize.sm,
    fontWeight: fontWeight.bold,
  },
  videoAiPickerErrorHint: {
    color: '#DC2626',
    fontSize: fontSize.xs,
    lineHeight: 18,
    textAlign: 'center',
  },
  videoAiPickerList: {
    flexGrow: 0,
  },
  videoAiPickerListContent: {
    gap: spacing.sm,
  },
  videoAiPickerOption: {
    flexDirection: 'row',
    gap: spacing.md,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: '#E2E8F0',
    backgroundColor: '#FFFFFF',
    padding: spacing.md,
  },
  videoAiPickerOptionIconWrap: {
    width: 44,
    height: 44,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#EFF6FF',
  },
  videoAiPickerOptionIcon: {
    fontSize: 22,
  },
  videoAiPickerOptionBody: {
    flex: 1,
    gap: 4,
  },
  videoAiPickerMetaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  videoAiPickerLevel: {
    color: '#2563EB',
    fontSize: fontSize.xs,
    fontWeight: fontWeight.bold,
  },
  videoAiPickerCategory: {
    color: '#64748B',
    fontSize: fontSize.xs,
    fontWeight: fontWeight.medium,
  },
  videoAiPickerOptionTitle: {
    color: '#0F172A',
    fontSize: fontSize.base,
    fontWeight: fontWeight.bold,
  },
  videoAiPickerOptionDesc: {
    color: '#475569',
    fontSize: fontSize.sm,
    lineHeight: 20,
  },
  videoAiProgressBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(15,23,42,0.45)',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.lg,
  },
  videoAiProgressDismissLayer: {
    ...StyleSheet.absoluteFillObject,
  },
  videoAiProgressCard: {
    width: '100%',
    maxWidth: 420,
    borderRadius: 24,
    overflow: 'hidden',
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: '#DBEAFE',
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.lg,
    paddingBottom: spacing.lg,
    gap: spacing.md,
  },
  videoAiProgressHeader: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: spacing.sm,
  },
  videoAiProgressBody: {
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.md,
  },
  videoAiProgressText: {
    color: '#0F172A',
    fontSize: fontSize.base,
    fontWeight: fontWeight.bold,
    textAlign: 'center',
    lineHeight: 24,
  },
  videoAiProgressCount: {
    color: '#2563EB',
    fontSize: fontSize.sm,
    fontWeight: fontWeight.bold,
    textAlign: 'center',
  },
  videoAiProgressPreviewList: {
    width: '100%',
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'center',
    gap: spacing.xs,
  },
  videoAiProgressPreviewChip: {
    maxWidth: '46%',
    borderRadius: 999,
    paddingHorizontal: spacing.sm,
    paddingVertical: 6,
    backgroundColor: '#EFF6FF',
    borderWidth: 1,
    borderColor: '#BFDBFE',
  },
  videoAiProgressPreviewText: {
    color: '#1D4ED8',
    fontSize: fontSize.xs,
    fontWeight: fontWeight.medium,
  },
  videoAiProgressHint: {
    color: '#64748B',
    fontSize: fontSize.sm,
    lineHeight: 20,
    textAlign: 'center',
  },
  fullscreenSubtitleWrap: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: 'flex-end',
    alignItems: 'center',
    paddingHorizontal: spacing.lg,
    zIndex: 2,
  },
  fullscreenSubtitleCard: {
    width: '100%',
    maxWidth: 860,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    borderRadius: 14,
    backgroundColor: 'rgba(15,23,42,0.68)',
    alignItems: 'center',
    gap: 2,
    overflow: 'hidden',
  },
  fullscreenSubtitleText: {
    color: '#FFFFFF',
    fontSize: 22,
    lineHeight: 28,
    textAlign: 'center',
  },
  fullscreenWordHighlight: {
    color: '#FDE68A',
  },
  fullscreenSubtitleZh: {
    color: 'rgba(226,232,240,0.9)',
    fontSize: 13,
    lineHeight: 18,
    textAlign: 'center',
  },
  fullscreenSubtitleHint: {
    color: 'rgba(191,219,254,0.92)',
    fontSize: fontSize.xs,
    lineHeight: 18,
    textAlign: 'center',
  },
  progressTrack: {
    height: 4,
    backgroundColor: '#E5E7EB',
    borderRadius: borderRadius.full,
    marginTop: spacing.sm,
    overflow: 'hidden',
  },
  progressFill: {
    height: '100%',
    backgroundColor: '#3B82F6',
    borderRadius: borderRadius.full,
  },
  videoMetaRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: 8,
    gap: spacing.sm,
  },
  videoMetaText: {
    flex: 1,
    color: '#64748B',
    fontSize: fontSize.xs,
  },
  videoMetaTextRight: {
    textAlign: 'right',
  },
  videoPlaceholder: {
    aspectRatio: 16 / 9,
    borderRadius: 0,
    backgroundColor: '#0F172A',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.lg,
    gap: spacing.sm,
  },
  videoDeferredPlaceholder: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    backgroundColor: '#020617',
  },
  videoDeferredText: {
    color: '#CBD5E1',
    fontSize: fontSize.sm,
  },
  videoPlaceholderTitle: {
    color: '#FFFFFF',
    fontSize: fontSize.base,
    fontWeight: fontWeight.bold,
  },
  videoPlaceholderText: {
    color: '#CBD5E1',
    fontSize: fontSize.sm,
    lineHeight: 20,
    textAlign: 'center',
  },
  playerErrorText: {
    marginTop: spacing.sm,
    color: '#DC2626',
    fontSize: fontSize.xs,
    lineHeight: 18,
  },
  subtitlePanelTabWrap: {
    marginBottom: spacing.xs,
  },
  subtitlePanelTabRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.lg,
    alignSelf: 'flex-start',
    paddingBottom: 2,
  },
  subtitlePanelTabChip: {
    paddingHorizontal: 2,
    paddingVertical: 4,
    borderBottomWidth: 1.5,
    borderBottomColor: 'transparent',
    alignItems: 'center',
    justifyContent: 'center',
  },
  subtitlePanelTabChipActive: {
    borderBottomColor: '#2563EB',
  },
  subtitlePanelTabText: {
    color: '#64748B',
    fontSize: fontSize.sm,
    fontWeight: fontWeight.medium,
  },
  subtitlePanelTabTextActive: {
    color: '#2563EB',
    fontWeight: fontWeight.bold,
  },
  segmentList: {
    gap: 10,
    paddingBottom: spacing.md,
  },
  lookupWordList: {
    gap: spacing.sm,
    paddingBottom: spacing.md,
  },
  segmentScroll: {
    flex: 1,
    marginBottom: spacing.md,
  },
  segmentCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 16,
    borderWidth: 1,
    borderColor: '#E5E7EB',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    gap: 6,
  },
  segmentCardActive: {
    backgroundColor: '#EFF6FF',
    borderColor: '#93C5FD',
  },
  segmentCardTopRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: spacing.md,
  },
  segmentTime: {
    color: '#94A3B8',
    fontSize: fontSize.xs,
    fontWeight: fontWeight.bold,
  },
  segmentTimeActive: {
    color: '#2563EB',
  },
  segmentTopRowActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
  },
  segmentMicBtn: {
    width: 26,
    height: 26,
    borderRadius: borderRadius.full,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#EFF6FF',
    borderWidth: 1,
    borderColor: '#BFDBFE',
  },
  segmentStarBtn: {
    width: 26,
    height: 26,
    borderRadius: borderRadius.full,
    alignItems: 'center',
    justifyContent: 'center',
  },
  segmentText: {
    color: '#111827',
    fontSize: fontSize.base,
    fontWeight: fontWeight.bold,
    lineHeight: 26,
  },
  segmentTextActive: {
    color: '#0F172A',
  },
  wordHighlight: {
    color: '#7C3AED',
    fontWeight: fontWeight.bold,
  },
  segmentTextZh: {
    color: '#94A3B8',
    fontSize: fontSize.sm,
    lineHeight: 20,
  },
  segmentTextZhActive: {
    color: '#64748B',
  },
  lookupWordCard: { display: 'none' }, // legacy alias, kept to avoid a stale ref
  wordCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 16,
    borderWidth: 1,
    borderColor: '#E5E7EB',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    gap: 6,
  },
  wordCardTopRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  wordCardHeadwordWrap: { flex: 1 },
  wordCardHeadword: {
    color: '#111827',
    fontSize: fontSize.base,
    fontWeight: fontWeight.bold,
  },
  wordCardStarBtn: {
    width: 28,
    height: 28,
    alignItems: 'center',
    justifyContent: 'center',
  },
  wordCardTranslation: {
    color: '#334155',
    fontSize: fontSize.sm,
    lineHeight: 20,
  },
  wordCardContext: {
    color: '#94A3B8',
    fontSize: fontSize.xs,
    lineHeight: 18,
    fontStyle: 'italic',
  },
  wordCardDueLabel: {
    color: '#F59E0B',
    fontSize: fontSize.xs,
    fontWeight: '600' as any,
    marginTop: 2,
  },
  reviewCtaBtn: {
    margin: spacing.sm,
    paddingVertical: 12,
    backgroundColor: colors.text.primary,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  reviewCtaBtnDisabled: { backgroundColor: colors.border.light },
  reviewCtaBtnText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '700' as any,
  },
  panelEmptyState: {
    flex: 1,
    marginBottom: spacing.md,
    borderRadius: borderRadius.xl,
    borderWidth: 1,
    borderColor: '#E5E7EB',
    backgroundColor: '#FFFFFF',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.lg,
    gap: spacing.xs,
  },
  panelEmptyTitle: {
    color: '#0F172A',
    fontSize: fontSize.base,
    fontWeight: fontWeight.bold,
  },
  panelEmptyText: {
    color: '#64748B',
    fontSize: fontSize.sm,
    lineHeight: 20,
  },
  segmentCardActionRow: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
  },
  segmentShadowingBtn: {
    minHeight: 30,
    paddingHorizontal: 10,
    borderRadius: 999,
    backgroundColor: '#EFF6FF',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    borderWidth: 1,
    borderColor: '#BFDBFE',
  },
  segmentShadowingBtnText: {
    color: '#2563EB',
    fontSize: fontSize.xs,
    fontWeight: fontWeight.bold,
  },
  toolBtn: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    minHeight: 48,
  },
  toolBtnDisabled: {
    opacity: 0.45,
  },
  toolBtnActive: {
    backgroundColor: '#EFF6FF',
  },
  toolText: {
    color: '#0F172A',
    fontSize: fontSize.xs,
    fontWeight: fontWeight.bold,
  },
  toolTextDisabled: {
    color: '#94A3B8',
  },
  playerPanel: {
    backgroundColor: '#FFFFFF',
    borderRadius: 22,
    borderWidth: 1,
    borderColor: '#E5E7EB',
    paddingTop: spacing.xs,
    paddingBottom: spacing.md,
    paddingHorizontal: spacing.sm,
    gap: spacing.sm,
    marginBottom: spacing.sm,
    shadowColor: '#0F172A',
    shadowOpacity: 0.04,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 6 },
    elevation: 2,
  },
  playerPanelCollapseBtn: {
    width: 30,
    height: 30,
    borderRadius: borderRadius.full,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#F8FAFC',
    borderWidth: 1,
    borderColor: '#E2E8F0',
  },
  playerPanelAccessoryRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
  },
  playerPanelIconBtn: {
    width: 30,
    height: 30,
    borderRadius: borderRadius.full,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#F8FAFC',
    borderWidth: 1,
    borderColor: '#E2E8F0',
  },
  playerPanelCollapsedBar: {
    marginBottom: spacing.sm,
    minHeight: 46,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: '#E5E7EB',
    backgroundColor: '#FFFFFF',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.xs,
  },
  playerPanelCollapsedText: {
    color: '#334155',
    fontSize: fontSize.sm,
    fontWeight: fontWeight.bold,
  },
  cacheStatusCard: {
    borderRadius: 18,
    borderWidth: 1,
    borderColor: '#DBEAFE',
    backgroundColor: '#F8FBFF',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    gap: spacing.sm,
  },
  cacheStatusTopRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: spacing.md,
  },
  cacheStatusTextWrap: {
    flex: 1,
    gap: 4,
  },
  cacheStatusTitle: {
    color: '#0F172A',
    fontSize: fontSize.base,
    fontWeight: fontWeight.bold,
  },
  cacheStatusHint: {
    color: '#64748B',
    fontSize: fontSize.sm,
    lineHeight: 20,
  },
  cacheStatusPercent: {
    color: '#2563EB',
    fontSize: fontSize.sm,
    fontWeight: fontWeight.bold,
  },
  cacheProgressTrack: {
    height: 8,
    borderRadius: borderRadius.full,
    backgroundColor: '#DBEAFE',
    overflow: 'hidden',
  },
  cacheProgressFill: {
    height: '100%',
    borderRadius: borderRadius.full,
    backgroundColor: '#2563EB',
  },
  cacheMetaRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: spacing.sm,
  },
  cacheMetaText: {
    color: '#64748B',
    fontSize: fontSize.xs,
  },
  cacheEmptyCard: {
    borderRadius: 18,
    borderWidth: 1,
    borderColor: '#E2E8F0',
    backgroundColor: '#FFFFFF',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    gap: spacing.xs,
  },
  cacheEmptyTitle: {
    color: '#0F172A',
    fontSize: fontSize.base,
    fontWeight: fontWeight.bold,
  },
  cacheEmptyText: {
    color: '#64748B',
    fontSize: fontSize.sm,
    lineHeight: 20,
  },
  cacheActionRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
    marginTop: spacing.md,
  },
  cachePrimaryBtn: {
    minHeight: 42,
    borderRadius: borderRadius.xl,
    backgroundColor: '#2563EB',
    paddingHorizontal: spacing.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cachePrimaryBtnText: {
    color: '#FFFFFF',
    fontSize: fontSize.sm,
    fontWeight: fontWeight.bold,
  },
  cacheSecondaryBtn: {
    minHeight: 42,
    borderRadius: borderRadius.xl,
    borderWidth: 1,
    borderColor: '#CBD5E1',
    backgroundColor: '#FFFFFF',
    paddingHorizontal: spacing.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cacheSecondaryBtnText: {
    color: '#334155',
    fontSize: fontSize.sm,
    fontWeight: fontWeight.bold,
  },
  cacheBtnDisabled: {
    opacity: 0.72,
  },
  cloudSourcePanel: {
    gap: spacing.sm,
    paddingHorizontal: spacing.sm,
    marginBottom: spacing.sm,
  },
  cloudSourcePanelHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
  },
  cloudSourcePanelTitle: {
    color: '#0F172A',
    fontSize: fontSize.sm,
    fontWeight: fontWeight.bold,
  },
  cloudDownloadBtn: {
    minHeight: 34,
    paddingHorizontal: 10,
    borderRadius: borderRadius.full,
    borderWidth: 1,
    borderColor: '#BFDBFE',
    backgroundColor: '#EFF6FF',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
  },
  cloudDownloadBtnDisabled: {
    opacity: 0.7,
  },
  cloudDownloadBtnText: {
    color: '#2563EB',
    fontSize: fontSize.xs,
    fontWeight: fontWeight.bold,
  },
  cloudManageBtn: {
    minHeight: 34,
    paddingHorizontal: 12,
    borderRadius: borderRadius.full,
    backgroundColor: '#2563EB',
    alignItems: 'center',
    justifyContent: 'center',
  },
  cloudManageBtnText: {
    color: '#FFFFFF',
    fontSize: fontSize.xs,
    fontWeight: fontWeight.bold,
  },
  cloudSourceChipRow: {
    flexDirection: 'row',
    gap: spacing.xs,
  },
  cloudSourceChip: {
    flex: 1,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: '#DBEAFE',
    backgroundColor: '#F8FAFC',
    paddingHorizontal: 12,
    paddingVertical: 10,
    gap: 2,
  },
  cloudSourceChipActive: {
    borderColor: '#2563EB',
    backgroundColor: '#EFF6FF',
  },
  cloudSourceChipDisabled: {
    opacity: 0.58,
  },
  cloudSourceChipLabel: {
    color: '#0F172A',
    fontSize: fontSize.sm,
    fontWeight: fontWeight.bold,
  },
  cloudSourceChipLabelActive: {
    color: '#1D4ED8',
  },
  cloudSourceChipStatus: {
    color: '#64748B',
    fontSize: fontSize.xs,
  },
  cloudSourceChipStatusActive: {
    color: '#2563EB',
  },
  cloudSourceHintBox: {
    borderRadius: 16,
    borderWidth: 1,
    borderColor: '#DBEAFE',
    backgroundColor: '#EFF6FF',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  cloudSourceHintText: {
    color: '#1E3A8A',
    fontSize: fontSize.xs,
    lineHeight: 18,
  },
  cloudSourceHintActionRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.xs,
    marginTop: spacing.sm,
  },
  cloudHintPrimaryBtn: {
    minHeight: 34,
    paddingHorizontal: 12,
    borderRadius: borderRadius.full,
    backgroundColor: '#2563EB',
    alignItems: 'center',
    justifyContent: 'center',
  },
  cloudHintPrimaryBtnText: {
    color: '#FFFFFF',
    fontSize: fontSize.xs,
    fontWeight: fontWeight.bold,
  },
  cloudHintSecondaryBtn: {
    minHeight: 34,
    paddingHorizontal: 12,
    borderRadius: borderRadius.full,
    borderWidth: 1,
    borderColor: '#93C5FD',
    backgroundColor: '#FFFFFF',
    alignItems: 'center',
    justifyContent: 'center',
  },
  cloudHintSecondaryBtnDisabled: {
    opacity: 0.7,
  },
  cloudHintSecondaryBtnText: {
    color: '#1D4ED8',
    fontSize: fontSize.xs,
    fontWeight: fontWeight.bold,
  },
  playerToolRow: {
    flexDirection: 'row',
    alignItems: 'stretch',
    justifyContent: 'space-between',
    gap: spacing.xs,
  },
  playerProgressSection: {
    paddingHorizontal: spacing.sm,
    gap: 10,
  },
  playerProgressLabelsRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: spacing.sm,
  },
  playerProgressLabel: {
    flex: 1,
    color: '#64748B',
    fontSize: fontSize.xs,
  },
  playerProgressRightGroup: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
  },
  playerProgressRightLabel: {
    color: '#64748B',
    fontSize: fontSize.xs,
    textAlign: 'right',
  },
  playerProgressTrack: {
    height: 6,
    borderRadius: borderRadius.full,
    backgroundColor: '#E5E7EB',
    overflow: 'visible',
    justifyContent: 'center',
  },
  playerProgressFill: {
    position: 'absolute',
    left: 0,
    top: 0,
    bottom: 0,
    backgroundColor: '#3B82F6',
    borderRadius: borderRadius.full,
  },
  playerProgressThumb: {
    position: 'absolute',
    marginLeft: -9,
    width: 18,
    height: 18,
    borderRadius: 999,
    backgroundColor: '#FFFFFF',
    borderWidth: 3,
    borderColor: '#3B82F6',
    shadowColor: '#3B82F6',
    shadowOpacity: 0.18,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
    elevation: 2,
  },
  playerTransportRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
    paddingHorizontal: spacing.sm,
  },
  playerTransportBtn: {
    minWidth: 58,
    minHeight: 52,
    borderRadius: 16,
    backgroundColor: '#F8FAFC',
    borderWidth: 1,
    borderColor: '#E2E8F0',
    paddingHorizontal: 10,
    paddingVertical: 8,
    justifyContent: 'center',
    alignItems: 'center',
    gap: 4,
  },
  playerTransportBtnText: {
    color: '#334155',
    fontSize: fontSize.xs,
    fontWeight: fontWeight.bold,
  },
  playerTransportPlayBtn: {
    width: 62,
    height: 62,
    borderRadius: 999,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.primary,
  },
  emptySubtitleState: {
    flex: 1,
    marginBottom: spacing.md,
    borderRadius: borderRadius.xl,
    backgroundColor: '#F8FAFC',
    borderWidth: 1,
    borderColor: '#E2E8F0',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.xl,
    justifyContent: 'center',
    alignItems: 'center',
    gap: spacing.sm,
  },
  emptySubtitleTitle: {
    fontSize: fontSize.base,
    fontWeight: fontWeight.bold,
    color: '#0F172A',
  },
  emptySubtitleText: {
    fontSize: fontSize.sm,
    lineHeight: 20,
    textAlign: 'center',
    color: '#64748B',
  },
  emptySubtitleActionBtn: {
    minHeight: 42,
    borderRadius: borderRadius.full,
    backgroundColor: colors.primary,
    paddingHorizontal: spacing.lg,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.xs,
  },
  emptySubtitleActionBtnDisabled: {
    opacity: 0.7,
  },
  emptySubtitleActionText: {
    color: '#FFFFFF',
    fontSize: fontSize.sm,
    fontWeight: fontWeight.bold,
  },
});
