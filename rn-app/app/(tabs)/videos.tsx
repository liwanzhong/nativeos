import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  Pressable,
  ImageBackground,
  RefreshControl,
  Modal,
  ActivityIndicator,
  Alert,
  Platform,
} from 'react-native';
import { useRouter, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { HardDriveDownload, MessageCircle, Pause, Play, Plus, Trash2, X } from 'lucide-react-native';
import * as Sharing from 'expo-sharing';
import { colors, spacing, borderRadius, fontSize, fontWeight } from '../../constants/theme';
import { sectionStyles } from '../../constants/sectionStyles';
import { buildAiPracticeTopicSnapshot, markAiPracticeTopicUsed } from '../../lib/ai/ai-practice-user-meta';
import { selectScenario, type ScenarioCard } from '../../lib/ai/scenario-generator';
import { getFeaturedVideoScenes, getVideoSceneById, invalidateVideoSceneCaches, type VideoSceneDetail } from '../../lib/content/video-scenes';
import { getOfficialVideoSeriesList, type OfficialVideoSeriesSummary } from '../../lib/content/video-series';
import { bindOfficialSceneToProvider, listDownloadedSceneSources, type DownloadedSceneSource } from '../../lib/content/cloud-drive-bindings';
import { CLOUD_DOWNLOAD_SLOW_HELP_MESSAGE, CLOUD_DOWNLOAD_SLOW_HELP_TITLE } from '../../lib/content/cloud-download-help';
import { loadGeneratedVideoAiPracticeCards } from '../../lib/content/video-ai-practice';
import { listVideoUserMeta, type VideoUserMetaRecord } from '../../lib/content/video-user-meta';
import { createCloudVideoReference, deleteUserVideoEntry, importLocalVideoFromUri, isDuplicateLocalVideoImportError, isVideoCandidate, pickAndImportLocalVideo, triggerCloudVideoSubtitleGeneration, triggerUserVideoSubtitleGeneration, SubtitleProRequiredError, SubtitleQuotaExhaustedError } from '../../lib/content/user-videos';
import { checkSubtitleQuota, getTodayUsage, getQuotaConfig, isProNow, minutesForAudioSeconds } from '../../lib/quota';
import { VideoSourcePickerContent, type SelectedCloudVideoFile } from '../../components/cloud-drive/VideoSourcePickerContent';
import { downloadImportedCloudVideo, pauseOfficialSceneVideoDownload, removeOfficialSceneVideoDownload, resumeOfficialSceneVideoDownload } from '../../lib/content/cloud-video-playback';

const LEVEL_ORDER = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'];
const VIDEO_SCREEN_LOG_PREFIX = '[VideosScreen]';

function logVideosScreenTrace(message: string, payload?: unknown) {
  if (payload === undefined) {
    console.log(`${VIDEO_SCREEN_LOG_PREFIX} ${message}`);
    return;
  }
  console.log(`${VIDEO_SCREEN_LOG_PREFIX} ${message}`, payload);
}

function warnVideosScreenTrace(message: string, payload?: unknown) {
  if (payload === undefined) {
    console.warn(`${VIDEO_SCREEN_LOG_PREFIX} ${message}`);
    return;
  }
  console.warn(`${VIDEO_SCREEN_LOG_PREFIX} ${message}`, payload);
}

type VideoTabKey = 'explore' | 'mine' | 'history' | 'favorites';

type VideoHistoryFilterKey = 'today' | 'week' | 'month' | 'older';
type VideoLevelFilterKey = 'all' | 'recommended' | 'A1' | 'A2' | 'B1' | 'B2' | 'C1' | 'C2';

const LEVEL_COLORS: Record<string, { bg: string; text: string }> = {
  A1: { bg: '#DCFCE7', text: '#166534' },
  A2: { bg: '#D1FAE5', text: '#065F46' },
  B1: { bg: '#DBEAFE', text: '#1E40AF' },
  B2: { bg: '#EDE9FE', text: '#5B21B6' },
  C1: { bg: '#FEE2E2', text: '#991B1B' },
  C2: { bg: '#FFE4E6', text: '#BE123C' },
};

function formatVideoDuration(seconds: number) {
  const totalSeconds = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
  const minutes = Math.floor(totalSeconds / 60);
  const remainingSeconds = totalSeconds % 60;
  return `${minutes}:${remainingSeconds.toString().padStart(2, '0')}`;
}

function formatFileSize(bytes?: number) {
  if (!bytes || bytes <= 0) {
    return '0 B';
  }
  if (bytes < 1024) {
    return `${bytes.toFixed(0)} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(0)} KB`;
  }
  if (bytes < 1024 * 1024 * 1024) {
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  }
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function getCloudProviderLabel(provider: DownloadedSceneSource['provider']) {
  return provider === 'baidu_pan' ? '百度网盘' : '云盘';
}

function getDownloadStatusLabel(status: DownloadedSceneSource['status']) {
  if (status === 'resolving') return '准备中';
  if (status === 'downloading') return '下载中';
  if (status === 'paused') return '已暂停';
  if (status === 'completed') return '已完成';
  if (status === 'error') return '失败';
  return '空闲';
}

function getLevelDistance(level: string, target: string) {
  const baseIndex = LEVEL_ORDER.indexOf(level);
  const targetIndex = LEVEL_ORDER.indexOf(target);
  if (baseIndex < 0 || targetIndex < 0) {
    return Number.MAX_SAFE_INTEGER;
  }
  return Math.abs(baseIndex - targetIndex);
}

function isVideoSceneInHistoryFilter(timestamp: number | undefined, filter: VideoHistoryFilterKey) {
  if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) {
    return false;
  }
  const dayMs = 24 * 60 * 60 * 1000;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayStart = today.getTime();
  const weekStart = todayStart - 7 * dayMs;
  const monthStart = todayStart - 30 * dayMs;
  if (filter === 'today') {
    return timestamp >= todayStart;
  }
  if (filter === 'week') {
    return timestamp >= weekStart;
  }
  if (filter === 'month') {
    return timestamp >= monthStart;
  }
  return timestamp < monthStart;
}

function getCurrentOfficialProvider(scene: VideoSceneDetail) {
  return (scene.availableCloudProviders || []).find((provider) => provider.isSelected) ?? null;
}

function isUserManagedVideoScene(scene: VideoSceneDetail) {
  return scene.id.startsWith('user_video_') || scene.id.startsWith('user_cloud_video_');
}

function getVideoDeleteActionLabel(scene: VideoSceneDetail) {
  return scene.selectedCloudProvider ? '从我的视频中移除' : '删除视频';
}

function getVideoDeleteConfirmation(scene: VideoSceneDetail) {
  if (scene.selectedCloudProvider) {
    return {
      title: '移除这条云盘视频记录？',
      message: '只会移除这条本地记录，不会删除云盘中的原文件。',
      confirmText: '移除',
      successText: '已从我的视频中移除',
    };
  }
  return {
    title: '删除这个本地视频？',
    message: '将从 App 中删除该视频及其本地字幕缓存。此操作不可恢复。',
    confirmText: '删除',
    successText: '已删除本地视频',
  };
}

/**
 * Map a user-managed video's persisted subtitle state into the
 * single label + visual hint the card needs. Returns `null` for
 * non-imported scenes (the official ones have no subtitle pipeline
 * here) and for "subtitle is fully ready and integrated" — those
 * don't need a third button.
 *
 * `kind` tells the on-press handler which action to take:
 *   'generate' → run the subtitle generation flow (with download
 *                confirm modal for cloud, or direct kickoff for
 *                local/cached)
 *   'view'     → jump straight to the subtitle view (since the
 *                pipeline has finished, the "video practice" CTA
 *                already covers this; we use it as a hint for
 *                the user that subtitles are available)
 *   'retry'    → re-trigger the same flow (the previous run errored)
 *   'none'     → no action (status row only)
 */
type SubtitleSummary = {
  kind: 'generate' | 'view' | 'retry' | 'none';
  label: string;
  actionLabel: string;
  disabled: boolean;
  phase: 'downloading' | 'extracting' | 'asr' | 'ready' | 'error' | 'idle';
  progress: number | null;
};

function buildSubtitleSummary(
  scene: VideoSceneDetail,
  proTier: 'free' | 'pro' | 'loading',
  minutesAvailable: number | null,
): SubtitleSummary | null {
  // Only imported videos have the subtitle pipeline.
  if (scene.contentOrigin !== 'imported') {
    return null;
  }
  const status = scene.subtitleStatus ?? 'none';

  // ── Generation in flight: 3-stage state machine ─────────────────
  if (status === 'processing') {
    const phase = scene.subtitlePhase ?? 'asr';
    if (phase === 'downloading') {
      return {
        kind: 'none',
        label: scene.subtitlePhaseMessage ?? '下载中…',
        actionLabel: '下载中',
        disabled: true,
        phase,
        progress: scene.subtitlePhaseProgress ?? null,
      };
    }
    if (phase === 'extracting') {
      return {
        kind: 'none',
        label: scene.subtitlePhaseMessage ?? '正在准备生成…',
        actionLabel: '准备中',
        disabled: true,
        phase,
        progress: null,
      };
    }
    // phase === 'asr' (or unknown → treat as asr)
    return {
      kind: 'none',
      label: scene.subtitlePhaseMessage ?? '正在生成字幕…',
      actionLabel: '生成中',
      disabled: true,
      phase: 'asr',
      progress: scene.subtitlePhaseProgress ?? null,
    };
  }

  // ── Legacy `pending` state (shouldn't happen post-3-stage refactor
  // but kept for forward compat) ───────────────────────────────────
  if (status === 'pending') {
    return {
      kind: 'none',
      label: '排队生成中…',
      actionLabel: '排队中',
      disabled: true,
      phase: 'extracting',
      progress: null,
    };
  }

  // ── Errored → show retry ─────────────────────────────────────────
  if (status === 'error') {
    if (proTier === 'free') {
      return {
        kind: 'generate',
        label: '字幕生成失败 · 升级 Pro 重试',
        actionLabel: '🔒 字幕',
        disabled: false,
        phase: 'error',
        progress: null,
      };
    }
    // No retry button on the card — the user should open the detail
    // page where the trigger is gated on Pro tier and quota, and shows
    // a precise error message.
    return {
      kind: 'none',
      label: '字幕生成失败',
      actionLabel: '',
      disabled: false,
      phase: 'error',
      progress: null,
    };
  }

  // ── Ready → no extra button needed, but show a one-liner ─────────
  if (status === 'ready') {
    return {
      kind: 'view',
      label: scene.subtitleChargedMinutes != null
        ? `✓ 字幕已生成 · 约 ${scene.subtitleChargedMinutes} 分钟`
        : '✓ 字幕已生成',
      actionLabel: '查看字幕',
      disabled: false,
      phase: 'ready',
      progress: null,
    };
  }

  // ── 'none' → offer the entry point. Free users see a lock + label;
  // Pro users see the remaining-minutes hint. ─────────────────────
  if (proTier === 'loading') {
    return {
      kind: 'generate',
      label: '字幕生成 · 准备中…',
      actionLabel: '…',
      disabled: true,
      phase: 'idle',
      progress: null,
    };
  }
  if (proTier === 'free') {
    return {
      kind: 'generate',
      label: '字幕生成是 Pro 专属功能',
      actionLabel: '🔒 字幕',
      disabled: false,
      phase: 'idle',
      progress: null,
    };
  }
  // Pro. Show remaining minutes if we know it; if quota is exhausted
  // for today, the user can still tap to get a friendly toast.
  if (typeof minutesAvailable === 'number' && minutesAvailable <= 0) {
    return {
      kind: 'generate',
      label: '今日字幕额度已用完',
      actionLabel: '已用完',
      disabled: false,
      phase: 'idle',
      progress: null,
    };
  }
  return {
    kind: 'generate',
    label: typeof minutesAvailable === 'number' && minutesAvailable > 0
      ? `生成字幕（剩 ${minutesAvailable} 分钟）`
      : '生成字幕',
    actionLabel: '生成字幕',
    disabled: false,
    phase: 'idle',
    progress: null,
  };
}

export default function VideosScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ shared?: string }>();
  const scrollViewRef = useRef<ScrollView | null>(null);
  const [activeTab, setActiveTab] = useState<VideoTabKey>('explore');
  const [historyFilter, setHistoryFilter] = useState<VideoHistoryFilterKey>('month');
  const [selectedImportSource, setSelectedImportSource] = useState('全部');
  const [userLevel, setUserLevel] = useState('B1');
  const [selectedVideoLevel, setSelectedVideoLevel] = useState<VideoLevelFilterKey>('all');
  const [selectedVideoCategory, setSelectedVideoCategory] = useState('全部');
  const [videoScenarios, setVideoScenarios] = useState<VideoSceneDetail[]>([]);
  const [officialSeriesList, setOfficialSeriesList] = useState<OfficialVideoSeriesSummary[]>([]);
  const [videoUserMetaMap, setVideoUserMetaMap] = useState<Record<string, VideoUserMetaRecord>>({});
  const [videoAiPickerScene, setVideoAiPickerScene] = useState<VideoSceneDetail | null>(null);
  const [videoActionMenuScene, setVideoActionMenuScene] = useState<VideoSceneDetail | null>(null);
  const [officialBindScene, setOfficialBindScene] = useState<VideoSceneDetail | null>(null);
  const [isPullRefreshing, setIsPullRefreshing] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [isImporting, setIsImporting] = useState(false);
  const [isDeletingVideo, setIsDeletingVideo] = useState(false);
  const [toast, setToast] = useState('');
  const [isSourceBindingVisible, setIsSourceBindingVisible] = useState(false);
  const [isDownloadSheetVisible, setIsDownloadSheetVisible] = useState(false);
  const [downloadEntries, setDownloadEntries] = useState<DownloadedSceneSource[]>([]);
  const [downloadActionKey, setDownloadActionKey] = useState<string | null>(null);
  // Subtitle generation state — see handleGenerateSubtitle + the
  // download confirm modal below. `confirmSubtitleEntry` is the
  // entry that needs an explicit download confirmation (Baidu
  // videos that haven't been cached yet); `subtitleProTier` and
  // `subtitleMinutesAvailable` power the button label
  // ("生成字幕 · 剩 X 分钟" vs "🔒 生成字幕 (Pro)").
  const [confirmSubtitleEntry, setConfirmSubtitleEntry] = useState<VideoSceneDetail | null>(null);
  const [subtitleProTier, setSubtitleProTier] = useState<'free' | 'pro' | 'loading'>('loading');
  const [subtitleMinutesAvailable, setSubtitleMinutesAvailable] = useState<number | null>(null);
  const isNativeVideoImportSupported = Platform.OS !== 'web';
  const { resolvedSharedPayloads, isResolving: isResolvingSharedPayloads } = Sharing.useIncomingShare();

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(''), 2000);
  }, []);

  const loadVideoScenarios = useCallback(async (forceRefresh: boolean = false) => {
    setIsLoading(true);
    logVideosScreenTrace('loadVideoScenarios start', { forceRefresh });
    try {
      const AsyncStorage = (await import('@react-native-async-storage/async-storage')).default;
      const [levelRaw, scenes, seriesList, metaList] = await Promise.all([
        AsyncStorage.getItem('user_level'),
        getFeaturedVideoScenes(forceRefresh),
        getOfficialVideoSeriesList(forceRefresh),
        listVideoUserMeta(),
      ]);
      const level = (levelRaw as string) || 'B1';
      setUserLevel(level);
      setVideoScenarios(scenes);
      setOfficialSeriesList(seriesList);
      setVideoUserMetaMap(Object.fromEntries(metaList.map((item) => [item.sceneId, item])));
      logVideosScreenTrace('loadVideoScenarios success', {
        forceRefresh,
        userLevel: level,
        sceneCount: scenes.length,
        seriesCount: seriesList.length,
        metaCount: metaList.length,
      });
    } catch (error) {
      warnVideosScreenTrace('loadVideoScenarios failed', {
        forceRefresh,
        error: error instanceof Error ? error.message : String(error),
      });
      setVideoScenarios([]);
      setOfficialSeriesList([]);
      setVideoUserMetaMap({});
    } finally {
      setIsLoading(false);
      logVideosScreenTrace('loadVideoScenarios finished', { forceRefresh });
    }
  }, []);

  const loadDownloadEntries = useCallback(async () => {
    try {
      const entries = await listDownloadedSceneSources();
      setDownloadEntries(entries
        .filter((item) => item.sceneId.startsWith('user_cloud_video_'))
        .sort((a, b) => Date.parse(b.updatedAt || '') - Date.parse(a.updatedAt || '')));
    } catch {
      setDownloadEntries([]);
    }
  }, []);

  // Refresh the Pro tier + remaining subtitle minutes so the "生成字幕"
  // button on each card shows the right state. We re-read on focus
  // (when the user comes back from /redeem) and on every load so a
  // mid-session upgrade reflects immediately.
  const refreshSubtitleGateState = useCallback(async () => {
    if (Platform.OS === 'web') {
      // Web has no enforcement — show "Pro" so the button reads
      // "生成字幕（剩 X 分钟）" instead of the lock.
      setSubtitleProTier('pro');
      setSubtitleMinutesAvailable(null);
      return;
    }
    try {
      const pro = await isProNow();
      if (pro) {
        setSubtitleProTier('pro');
        const [config, usage] = await Promise.all([
          getQuotaConfig(),
          getTodayUsage(),
        ]);
        const limits = config.pro.asr_subtitle;
        setSubtitleMinutesAvailable(Math.max(0, limits.hard - usage.asr_subtitle));
      } else {
        setSubtitleProTier('free');
        setSubtitleMinutesAvailable(0);
      }
    } catch {
      // Best-effort. Default to "free" so we never accidentally
      // expose a paywall-bypass.
      setSubtitleProTier('free');
      setSubtitleMinutesAvailable(0);
    }
  }, []);

  useFocusEffect(useCallback(() => {
    loadVideoScenarios();
    void loadDownloadEntries();
    void refreshSubtitleGateState();
  }, [loadDownloadEntries, loadVideoScenarios, refreshSubtitleGateState]));

  const handleSelectScenario = async (sc: ScenarioCard) => {
    await selectScenario(sc);
    router.push(`/scenario/video/${sc.id}`);
  };

  const handleOpenCloudDriveSettings = useCallback(() => {
    router.push('/cloud-drives');
  }, [router]);

  const handleOpenOfficialBindPicker = useCallback((scene: VideoSceneDetail) => {
    const currentOfficialProvider = getCurrentOfficialProvider(scene);
    const hasConfiguredProvider = (scene.availableCloudProviders || []).some((provider) => provider.isConfigured);
    if (!currentOfficialProvider?.provider) {
      Alert.alert(
        '当前没有默认网盘',
        hasConfiguredProvider
          ? '你已经授权了网盘，但还没有设置推荐默认网盘。请先去「我的」→「我的网盘」里完成设置。'
          : '请先在「我的」→「我的网盘」里授权至少一个网盘来源。',
      );
      return;
    }
    setOfficialBindScene(scene);
  }, []);

  const handleOpenOfficialCloudDrivePrompt = useCallback((scene: VideoSceneDetail) => {
    const currentOfficialProvider = getCurrentOfficialProvider(scene);
    const hasConfiguredProvider = (scene.availableCloudProviders || []).some((provider) => provider.isConfigured);
    if (currentOfficialProvider?.provider) {
      Alert.alert(
        '去我的网盘',
        `你可以先去「我的网盘」检查授权、同步目录和默认来源，也可以直接从当前默认的${currentOfficialProvider.label}里绑定这条视频。\n\n注意：这条视频也可能实际保存在其他网盘来源里。`,
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
            text: `从默认${currentOfficialProvider.label}绑定`,
            onPress: () => handleOpenOfficialBindPicker(scene),
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
  }, [handleOpenCloudDriveSettings, handleOpenOfficialBindPicker]);

  const handleBindOfficialCloudFile = useCallback(async (file: SelectedCloudVideoFile) => {
    if (!officialBindScene?.officialAssetKeys) {
      return;
    }
    await bindOfficialSceneToProvider({
      sceneId: officialBindScene.id,
      provider: file.provider,
      officialVideoKey: officialBindScene.officialAssetKeys.videoKey,
      remotePath: file.remotePath,
      remoteFileId: file.remoteFileId,
    });
    setOfficialBindScene(null);
    // No force=true: per-scene info/ai-practice now live in SQLite
    // (schema v5 cache), so re-reading from disk reflects the new
    // binding without re-fetching OSS.
    await loadVideoScenarios(false);
    showToast(`已绑定到${file.provider === 'baidu_pan' ? '百度网盘' : '云盘'}`);
  }, [loadVideoScenarios, officialBindScene, showToast]);

  const handleCloseVideoAiPicker = () => {
    setVideoAiPickerScene(null);
  };

  const handleOpenDownloadSheet = useCallback(() => {
    setIsDownloadSheetVisible(true);
    void loadDownloadEntries();
  }, [loadDownloadEntries]);

  const handleCloseDownloadSheet = useCallback(() => {
    setIsDownloadSheetVisible(false);
  }, []);

  const handleShowSlowDownloadHelp = useCallback(() => {
    Alert.alert(CLOUD_DOWNLOAD_SLOW_HELP_TITLE, CLOUD_DOWNLOAD_SLOW_HELP_MESSAGE);
  }, []);

  const handleCloseVideoActionMenu = useCallback(() => {
    if (isDeletingVideo) {
      return;
    }
    setVideoActionMenuScene(null);
  }, [isDeletingVideo]);

  const handleOpenVideoActionMenu = useCallback((scene: VideoSceneDetail) => {
    if (!isUserManagedVideoScene(scene)) {
      return;
    }
    setVideoActionMenuScene(scene);
  }, []);

  const confirmDeleteVideo = useCallback(async (scene: VideoSceneDetail) => {
    if (isDeletingVideo) {
      return;
    }
    setIsDeletingVideo(true);
    try {
      const deleted = await deleteUserVideoEntry(scene.id);
      // 必须清 featuredScenesCache:loadVideoScenarios(false) 默认走缓存命中,
      // 不清就还会看到刚删的 entry。详情页删除路径 ([id].tsx) 已经在删除
      // 时显式调过 invalidateVideoSceneCaches,这里路径不同所以也要清。
      invalidateVideoSceneCaches([scene.id]);
      await loadVideoScenarios(false);
      setVideoActionMenuScene(null);
      showToast(deleted?.sourceType === 'cloud_reference' ? '已从我的视频中移除' : '已删除本地视频');
    } catch (error) {
      const message = error instanceof Error ? error.message : '删除失败，请稍后重试';
      Alert.alert('删除失败', message);
    } finally {
      setIsDeletingVideo(false);
    }
  }, [isDeletingVideo, loadVideoScenarios, showToast]);

  const handleRequestDeleteVideo = useCallback((scene: VideoSceneDetail) => {
    const config = getVideoDeleteConfirmation(scene);
    setVideoActionMenuScene(null);
    Alert.alert(config.title, config.message, [
      {
        text: '取消',
        style: 'cancel',
      },
      {
        text: config.confirmText,
        style: 'destructive',
        onPress: () => {
          void confirmDeleteVideo(scene);
        },
      },
    ]);
  }, [confirmDeleteVideo]);

  const handleSelectVideoAiCard = async (card: ScenarioCard, sceneOverride?: VideoSceneDetail | null) => {
    const sourceScene = sceneOverride ?? videoAiPickerScene;
    if (sourceScene) {
      const snapshot = buildAiPracticeTopicSnapshot({
        card,
        origin: 'video',
        sourceType: sourceScene.contentOrigin === 'imported' ? 'imported_video' : 'official_video',
        sourceLabel: sourceScene.contentOrigin === 'imported' ? '跟练话题' : '推荐视频',
        sourceId: sourceScene.id,
        sceneTitle: sourceScene.card.title,
        importSourceLabel: sourceScene.contentOrigin === 'imported' ? sourceScene.sourceLabel : undefined,
      });
      await markAiPracticeTopicUsed(snapshot);
      await selectScenario(snapshot.card);
      handleCloseVideoAiPicker();
      router.push(`/scenario/immersive/${snapshot.card.id}`);
      return;
    }
    await selectScenario(card);
    handleCloseVideoAiPicker();
    router.push(`/scenario/immersive/${card.id}`);
  };

  const handleStartVideoAiPractice = async (scene: VideoSceneDetail) => {
    let latestScene = scene;
    let availableAiCards = (latestScene.aiPracticeCards || []).filter((card) => Boolean(card.npcSystemPrompt || card.openingLine || card.npcName));
    let preferredAiCard = availableAiCards[0];

    if (!preferredAiCard?.npcSystemPrompt && !preferredAiCard?.openingLine && !preferredAiCard?.npcName) {
      const refreshedScene = await getVideoSceneById(scene.id, true);
      if (refreshedScene) {
        latestScene = refreshedScene;
        availableAiCards = (refreshedScene.aiPracticeCards || []).filter((card) => Boolean(card.npcSystemPrompt || card.openingLine || card.npcName));
        preferredAiCard = availableAiCards[0];
        setVideoScenarios((prev) => prev.map((item) => (item.id === refreshedScene.id ? refreshedScene : item)));
      }
    }

    if (!preferredAiCard?.npcSystemPrompt && !preferredAiCard?.openingLine && !preferredAiCard?.npcName) {
      const cachedGeneratedAiCards = (await loadGeneratedVideoAiPracticeCards(scene.id))
        .filter((card) => Boolean(card.npcSystemPrompt || card.openingLine || card.npcName));
      if (cachedGeneratedAiCards.length > 0) {
        latestScene = {
          ...latestScene,
          aiPracticeCards: cachedGeneratedAiCards,
        };
        availableAiCards = cachedGeneratedAiCards;
        preferredAiCard = cachedGeneratedAiCards[0];
        setVideoScenarios((prev) => prev.map((item) => (item.id === latestScene.id ? latestScene : item)));
      }
    }

    if (!preferredAiCard?.npcSystemPrompt && !preferredAiCard?.openingLine && !preferredAiCard?.npcName) {
      showToast('这个视频的 AI陪练正在准备中');
      return;
    }

    if (availableAiCards.length <= 1) {
      await handleSelectVideoAiCard(preferredAiCard, latestScene);
      return;
    }

    setVideoAiPickerScene({
      ...latestScene,
      aiPracticeCards: availableAiCards,
    });
  };

  const seriesCategories = ['全部', ...Array.from(new Set(officialSeriesList.map((series) => series.category).filter(Boolean)))];
  const visibleSeriesCards = officialSeriesList
    .filter((series) => {
      if (selectedVideoLevel === 'all') {
        return true;
      }
      return selectedVideoLevel === 'recommended' ? getLevelDistance(series.level, userLevel) <= 1 : series.level === selectedVideoLevel;
    })
    .filter((series) => (selectedVideoCategory === '全部' ? true : series.category === selectedVideoCategory))
    .sort((a, b) => {
      if (selectedVideoLevel === 'recommended') {
        return getLevelDistance(a.level, userLevel) - getLevelDistance(b.level, userLevel);
      }
      const aLevelIndex = LEVEL_ORDER.indexOf(a.level);
      const bLevelIndex = LEVEL_ORDER.indexOf(b.level);
      return (aLevelIndex < 0 ? Number.MAX_SAFE_INTEGER : aLevelIndex) - (bLevelIndex < 0 ? Number.MAX_SAFE_INTEGER : bLevelIndex);
    });

  useEffect(() => {
    if (selectedVideoCategory !== '全部' && !seriesCategories.includes(selectedVideoCategory)) {
      setSelectedVideoCategory('全部');
    }
  }, [selectedVideoCategory, seriesCategories]);

  const handlePullRefresh = async () => {
    setIsPullRefreshing(true);
    try {
      // Pull-to-refresh: force re-fetch the OSS manifest so we pick up
      // new scenes. Per-scene info/ai-practice stays in SQLite cache
      // (cache-first on the list path) so this is ~6 network round
      // trips, not 30+.
      await loadVideoScenarios(true);
    } finally {
      setIsPullRefreshing(false);
    }
  };

  const triggerImportedVideoSubtitleGeneration = useCallback((entry?: { id?: string | null; sourceType?: string | null } | null) => {
    if (!entry?.id) {
      return;
    }
    // Capture non-null id for the inner async IIFE (TS narrowing is
    // lost across closure boundaries otherwise).
    const entryId: string = entry.id;
    const entrySourceType = entry.sourceType;
    // ── Silent gate for local-file auto-trigger ───────────────────
    // For local imports fired from `handleImportedEntry`, the user
    // just imported a video. They haven't seen a Pro gate page or a
    // quota toast yet — surfacing those on auto-trigger feels like
    // spam. Instead, when the user is Free or quota is exhausted,
    // skip the background work entirely; the entry stays at
    // `subtitleStatus: 'none'`, the card shows the standard "🔒 字幕"
    // or "今日字幕额度已用完" label, and the user can decide whether
    // to open the detail page and try manually (where the trigger
    // is gated and shows a precise message).
    //
    // Cloud-reference auto-trigger keeps the previous behavior: the
    // user has already done a more involved flow (browse Baidu,
    // pick a file, etc.), and the toast on gate failure is fine.
    if (entrySourceType === 'local_file' && subtitleProTier !== 'loading') {
      void (async () => {
        if (subtitleProTier !== 'pro') {
          // Free user — silent. The user can still open the detail
          // page and tap 生成字幕 to see the Pro gate page.
          return;
        }
        // Pro user — soft quota pre-check. The actual generation
        // does the precise check against the real duration; this
        // is a cheap skip-if-fully-exhausted short-circuit.
        const [usage, config] = await Promise.all([
          getTodayUsage(),
          getQuotaConfig(),
        ]);
        const hard = config.pro.asr_subtitle.hard;
        if (usage.asr_subtitle >= hard) {
          // Quota already used up today — silent. User can still
          // enter detail and tap to see the friendly "today used
          // up" message.
          return;
        }
        runLocalSubtitleTask(entryId, entrySourceType);
      })();
      return;
    }
    runLocalSubtitleTask(entryId, entrySourceType);

    function runLocalSubtitleTask(id: string, sourceType?: string | null) {
      const task = sourceType === 'cloud_reference'
        ? triggerCloudVideoSubtitleGeneration(id)
        : sourceType === 'local_file'
          ? triggerUserVideoSubtitleGeneration(id)
          : null;
      if (!task) {
        return;
      }
      void task
        .then(() => loadVideoScenarios(false))
        .catch((error) => {
          // Gate errors: surface as a soft failure (don't mark entry
          // as 'error'; the user is just not entitled). The most
          // likely path: the user upgraded, came back, and the
          // previous error state lingered.
          if (error instanceof SubtitleProRequiredError) {
            showToast('字幕生成是 Pro 专属功能');
            void loadVideoScenarios(false);
            return;
          }
          if (error instanceof SubtitleQuotaExhaustedError) {
            showToast('今日字幕额度已用完，明天再来');
            void loadVideoScenarios(false);
            return;
          }
          void loadVideoScenarios(false);
        });
    }
  }, [loadVideoScenarios, showToast, subtitleProTier]);

  const activeDownloadCount = useMemo(() => downloadEntries.filter((entry) => entry.status !== 'completed').length, [downloadEntries]);

  useEffect(() => {
    const hasRunningDownload = downloadEntries.some((entry) => entry.status === 'resolving' || entry.status === 'downloading');
    if (!isDownloadSheetVisible && !hasRunningDownload && activeTab !== 'mine') {
      return;
    }
    const timer = setInterval(() => {
      void loadDownloadEntries();
    }, 1200);
    return () => clearInterval(timer);
  }, [activeTab, downloadEntries, isDownloadSheetVisible, loadDownloadEntries]);

  const handleDownloadCloudVideo = useCallback(async (file: SelectedCloudVideoFile) => {
    const entry = await createCloudVideoReference({
      provider: file.provider,
      title: file.remoteFileName,
      remotePath: file.remotePath,
      remoteFileId: file.remoteFileId,
      remoteFileName: file.remoteFileName,
      fileSize: file.fileSize,
    });
    await downloadImportedCloudVideo({
      sceneId: entry.id,
      provider: file.provider,
      remotePath: file.remotePath,
    });
    await Promise.all([
      loadVideoScenarios(false),
      loadDownloadEntries(),
    ]);
    showToast(`已加入下载：${entry.title || file.remoteFileName}`);
  }, [loadDownloadEntries, loadVideoScenarios, showToast]);

  const handlePauseDownload = useCallback(async (entry: DownloadedSceneSource) => {
    const taskKey = `${entry.sceneId}__${entry.provider}`;
    if (downloadActionKey) {
      return;
    }
    setDownloadActionKey(taskKey);
    try {
      await pauseOfficialSceneVideoDownload(entry.sceneId, entry.provider);
      await loadDownloadEntries();
      showToast('已暂停下载');
    } catch (error) {
      Alert.alert('暂停失败', error instanceof Error ? error.message : '请稍后重试');
    } finally {
      setDownloadActionKey(null);
    }
  }, [downloadActionKey, loadDownloadEntries, showToast]);

  const handleResumeDownload = useCallback(async (entry: DownloadedSceneSource) => {
    const taskKey = `${entry.sceneId}__${entry.provider}`;
    if (downloadActionKey) {
      return;
    }
    setDownloadActionKey(taskKey);
    try {
      await resumeOfficialSceneVideoDownload(entry.sceneId, entry.provider);
      await loadDownloadEntries();
      showToast('已恢复下载');
    } catch (error) {
      Alert.alert('恢复失败', error instanceof Error ? error.message : '请稍后重试');
    } finally {
      setDownloadActionKey(null);
    }
  }, [downloadActionKey, loadDownloadEntries, showToast]);

  const handleRemoveDownload = useCallback((entry: DownloadedSceneSource) => {
    Alert.alert('移除下载记录', '将清除当前下载记录和本地缓存文件。', [
      {
        text: '取消',
        style: 'cancel',
      },
      {
        text: '移除',
        style: 'destructive',
        onPress: () => {
          const taskKey = `${entry.sceneId}__${entry.provider}`;
          if (downloadActionKey) {
            return;
          }
          setDownloadActionKey(taskKey);
          void removeOfficialSceneVideoDownload(entry.sceneId, entry.provider)
            .then(async () => {
              await Promise.all([
                loadDownloadEntries(),
                loadVideoScenarios(false),
              ]);
              showToast('已移除下载记录');
            })
            .catch((error) => {
              Alert.alert('移除失败', error instanceof Error ? error.message : '请稍后重试');
            })
            .finally(() => {
              setDownloadActionKey(null);
            });
        },
      },
    ]);
  }, [downloadActionKey, loadDownloadEntries, loadVideoScenarios, showToast]);

  // User-initiated "生成字幕" entry point. Three branches:
  //   1. Free user → push them to the Pro gate page
  //   2. Pro + cloud (Baidu) + not yet cached → show the download
  //      confirm modal so they can opt out of a surprise download
  //   3. Pro + (local OR cached cloud) → kick off the subtitle task
  //      directly, no modal needed (the work is local or already done)
  const handleGenerateSubtitle = useCallback((scene: VideoSceneDetail) => {
    if (subtitleProTier === 'loading') {
      return; // Wait for tier check to settle.
    }
    if (subtitleProTier === 'free') {
      router.push('/subtitle-pro');
      return;
    }
    const isCloudUncached = scene.contentOrigin === 'imported'
      && scene.selectedCloudProvider === 'baidu_pan'
      && !scene.cachedLocalUri;
    if (isCloudUncached) {
      setConfirmSubtitleEntry(scene);
      return;
    }
    // Pro + ready to extract — just kick it off.
    triggerImportedVideoSubtitleGeneration({
      id: scene.id,
      sourceType: scene.contentOrigin === 'imported' && scene.selectedCloudProvider ? 'cloud_reference' : 'local_file',
    });
  }, [router, subtitleProTier, triggerImportedVideoSubtitleGeneration]);

  // Refresh the gate state right after a successful subtitle run
  // so the "剩 X 分钟" label updates with the new used amount.
  useEffect(() => {
    void refreshSubtitleGateState();
  }, [refreshSubtitleGateState, videoScenarios]);

  const renderVideoPosterCard = useCallback((scene: VideoSceneDetail, source: VideoTabKey) => {
    const showActionMenu = isUserManagedVideoScene(scene);
    const currentOfficialProvider = scene.contentOrigin === 'official' ? getCurrentOfficialProvider(scene) : null;
    const hasOfficialPlayableSource = scene.contentOrigin !== 'official'
      || currentOfficialProvider?.syncStatus === 'available'
      || currentOfficialProvider?.syncStatus === 'cached';
    // Subtitle state for imported videos. Maps the persisted
    // `subtitleStatus` + 3-stage `subtitlePhase` into a single label
    // + visual hint for the card.
    const subtitleSummary = buildSubtitleSummary(scene, subtitleProTier, subtitleMinutesAvailable);
    const posterContent = (
      <View style={styles.videoPosterOverlay}>
        <View style={styles.videoPosterTopRow}>
          <View style={styles.videoPosterBadgeRow}>
            {scene.contentOrigin !== 'imported' ? (
              <View style={[styles.levelBadge, { backgroundColor: (LEVEL_COLORS[scene.card.level] || LEVEL_COLORS.B1).bg }]}>
                <Text style={[styles.levelText, { color: (LEVEL_COLORS[scene.card.level] || LEVEL_COLORS.B1).text }]}>{scene.card.level}</Text>
              </View>
            ) : null}
            {scene.contentOrigin === 'imported' ? (
              <View style={[styles.videoPosterMetaPill, styles.videoSourceStatusPillImported]}>
                <Text style={[styles.videoPosterMetaText, styles.videoSourceStatusTextImported]}>{scene.sourceLabel || '已导入'}</Text>
              </View>
            ) : (
              <View style={styles.videoPosterMetaPill}>
                <Text style={styles.videoPosterMetaText}>{scene.card.category}</Text>
              </View>
            )}
          </View>
          <View style={styles.videoPosterTopActions}>
            {showActionMenu ? (
              <Pressable style={styles.videoPosterMenuBtn} onPress={() => handleOpenVideoActionMenu(scene)}>
                <Text style={styles.videoPosterMenuBtnText}>···</Text>
              </Pressable>
            ) : null}
            <View style={styles.videoPosterDurationPill}>
              <Text style={styles.videoPosterDurationText}>{formatVideoDuration(scene.durationSeconds)}</Text>
            </View>
          </View>
        </View>

        <View style={styles.videoPosterBottomContent}>
          <Text style={styles.videoPosterTitle} numberOfLines={3}>{scene.card.title}</Text>
          {subtitleSummary ? (
            <View style={styles.subtitleSummaryRow}>
              {subtitleSummary.phase === 'downloading' && subtitleSummary.progress != null ? (
                <View style={styles.subtitleProgressTrack}>
                  <View
                    style={[
                      styles.subtitleProgressFill,
                      { width: `${Math.min(100, Math.max(0, subtitleSummary.progress * 100))}%` },
                    ]}
                  />
                </View>
              ) : null}
              <Text style={styles.subtitleSummaryText} numberOfLines={1}>
                {subtitleSummary.label}
              </Text>
            </View>
          ) : null}
          <View style={styles.videoPosterActionRow}>
            <Pressable
              style={styles.videoPosterPrimaryActionBtn}
              onPress={() => {
                if (scene.contentOrigin === 'official' && !hasOfficialPlayableSource) {
                  handleOpenOfficialCloudDrivePrompt(scene);
                  return;
                }
                handleSelectScenario(scene.card);
              }}
            >
              <Text style={styles.videoPosterPrimaryActionText}>{scene.contentOrigin === 'official' && !hasOfficialPlayableSource ? '绑定云盘视频' : '视频跟练'}</Text>
            </Pressable>
            <Pressable style={styles.videoPosterSecondaryActionBtn} onPress={() => handleStartVideoAiPractice(scene)}>
              <MessageCircle size={14} color="#FFFFFF" />
              <Text style={styles.videoPosterSecondaryActionText}>AI陪练</Text>
            </Pressable>
            {/* 字幕按钮已删除:用户点 "视频跟练" 进去后详情页有"立即生成字幕" / 字幕面板,
                列表卡片上的 "查看字幕"/"生成字幕" 入口是冗余的,简化卡片。 */}
          </View>
        </View>
      </View>
    );

    return (
      <View key={scene.id} style={styles.videoPosterCard}>
        {scene.coverImageUri ? (
          <ImageBackground source={{ uri: scene.coverImageUri }} style={styles.videoPosterBackground} imageStyle={styles.videoPosterImage}>
            {posterContent}
          </ImageBackground>
        ) : (
          <View style={[styles.videoPosterBackground, styles.videoPosterFallback]}>
            {posterContent}
          </View>
        )}
      </View>
    );
  }, [handleGenerateSubtitle, handleOpenOfficialCloudDrivePrompt, handleOpenVideoActionMenu, handleSelectScenario, handleStartVideoAiPractice, subtitleMinutesAvailable, subtitleProTier]);

  const handleOpenSeriesDetail = useCallback((series: OfficialVideoSeriesSummary) => {
    router.push(`/series/${encodeURIComponent(series.id)}`);
  }, [router]);

  const handleContinueSeries = useCallback((series: OfficialVideoSeriesSummary) => {
    if (series.resumeSceneId) {
      router.push(`/scenario/video/${encodeURIComponent(series.resumeSceneId)}`);
      return;
    }
    handleOpenSeriesDetail(series);
  }, [handleOpenSeriesDetail, router]);

  const renderSeriesCard = useCallback((series: OfficialVideoSeriesSummary) => {
    const levelColors = LEVEL_COLORS[series.level] || LEVEL_COLORS.B1;
    const progressRatio = series.episodeCount > 0 ? Math.max(0, Math.min(1, series.completedEpisodeCount / series.episodeCount)) : 0;
    const subtitle = series.description || `共 ${series.episodeCount} 集，按系列浏览更轻松。`;

    return (
      <View key={series.id} style={styles.seriesCard}>
        {series.coverImageUri ? (
          <ImageBackground source={{ uri: series.coverImageUri }} style={styles.seriesCardBackground} imageStyle={styles.seriesCardImage}>
            <View style={styles.seriesCardOverlay}>
              <View style={styles.seriesCardTopRow}>
                <View style={styles.videoPosterBadgeRow}>
                  <View style={[styles.levelBadge, { backgroundColor: levelColors.bg }]}>
                    <Text style={[styles.levelText, { color: levelColors.text }]}>{series.level}</Text>
                  </View>
                  <View style={styles.videoPosterMetaPill}>
                    <Text style={styles.videoPosterMetaText}>{series.category}</Text>
                  </View>
                </View>
                <View style={styles.seriesEpisodePill}>
                  <Text style={styles.seriesEpisodePillText}>{series.episodeCount} 集</Text>
                </View>
              </View>

              <View style={styles.seriesCardBottom}>
                <Text style={styles.seriesCardTitle} numberOfLines={2}>{series.title}</Text>
                <Text style={styles.seriesCardSubtitle} numberOfLines={2}>{subtitle}</Text>
                <View style={styles.seriesProgressRow}>
                  <View style={styles.seriesProgressTrack}>
                    <View style={[styles.seriesProgressFill, { width: `${progressRatio * 100}%` }]} />
                  </View>
                  <Text style={styles.seriesProgressText}>{series.completedEpisodeCount}/{series.episodeCount}</Text>
                </View>
                <View style={styles.seriesActionRow}>
                  <Pressable style={styles.seriesPrimaryBtn} onPress={() => handleOpenSeriesDetail(series)}>
                    <Text style={styles.seriesPrimaryBtnText}>进入系列</Text>
                  </Pressable>
                  <Pressable style={styles.seriesSecondaryBtn} onPress={() => handleContinueSeries(series)}>
                    <Text style={styles.seriesSecondaryBtnText}>{series.lastPracticedAt ? '继续学习' : '开始学习'}</Text>
                  </Pressable>
                </View>
              </View>
            </View>
          </ImageBackground>
        ) : (
          <View style={[styles.seriesCardBackground, styles.videoPosterFallback]}>
            <View style={styles.seriesCardOverlay}>
              <View style={styles.seriesCardTopRow}>
                <View style={styles.videoPosterBadgeRow}>
                  <View style={[styles.levelBadge, { backgroundColor: levelColors.bg }]}>
                    <Text style={[styles.levelText, { color: levelColors.text }]}>{series.level}</Text>
                  </View>
                  <View style={styles.videoPosterMetaPill}>
                    <Text style={styles.videoPosterMetaText}>{series.category}</Text>
                  </View>
                </View>
                <View style={styles.seriesEpisodePill}>
                  <Text style={styles.seriesEpisodePillText}>{series.episodeCount} 集</Text>
                </View>
              </View>

              <View style={styles.seriesCardBottom}>
                <Text style={styles.seriesCardTitle} numberOfLines={2}>{series.title}</Text>
                <Text style={styles.seriesCardSubtitle} numberOfLines={2}>{subtitle}</Text>
                <View style={styles.seriesProgressRow}>
                  <View style={styles.seriesProgressTrack}>
                    <View style={[styles.seriesProgressFill, { width: `${progressRatio * 100}%` }]} />
                  </View>
                  <Text style={styles.seriesProgressText}>{series.completedEpisodeCount}/{series.episodeCount}</Text>
                </View>
                <View style={styles.seriesActionRow}>
                  <Pressable style={styles.seriesPrimaryBtn} onPress={() => handleOpenSeriesDetail(series)}>
                    <Text style={styles.seriesPrimaryBtnText}>进入系列</Text>
                  </Pressable>
                  <Pressable style={styles.seriesSecondaryBtn} onPress={() => handleContinueSeries(series)}>
                    <Text style={styles.seriesSecondaryBtnText}>{series.lastPracticedAt ? '继续学习' : '开始学习'}</Text>
                  </Pressable>
                </View>
              </View>
            </View>
          </View>
        )}
      </View>
    );
  }, [handleContinueSeries, handleOpenSeriesDetail]);

  const handleImportedEntry = useCallback(async (action: () => Promise<{ id?: string | null; title?: string | null; sourceType?: string | null } | null>) => {
    if (isImporting) {
      return;
    }
    setIsImporting(true);
    try {
      const entry = await action();
      if (!entry) {
        return;
      }
      setActiveTab('mine');
      setIsSourceBindingVisible(false);
      // 清 featuredScenesCache:loadVideoScenarios(false) 默认走缓存命中,
      // 不清就看不到刚导入的 entry。
      invalidateVideoSceneCaches();
      await loadVideoScenarios(false);
      showToast(`已导入：${entry.title || '视频'}`);
      triggerImportedVideoSubtitleGeneration(entry);
    } catch (error) {
      if (isDuplicateLocalVideoImportError(error)) {
        Alert.alert('无需重复导入', '视频已经导入过，无需重复导入');
        return;
      }
      const message = error instanceof Error ? error.message : '导入失败，请稍后重试';
      Alert.alert('视频导入失败', message);
    } finally {
      setIsImporting(false);
    }
  }, [isImporting, loadVideoScenarios, showToast, triggerImportedVideoSubtitleGeneration]);

  const handleImportVideo = useCallback(async () => {
    await handleImportedEntry(() => pickAndImportLocalVideo());
  }, [handleImportedEntry]);

  const handleOpenSourceBinding = useCallback(() => {
    setIsSourceBindingVisible(true);
  }, []);

  const handleGoToMountDrives = useCallback(() => {
    setIsSourceBindingVisible(false);
    handleOpenCloudDriveSettings();
  }, [handleOpenCloudDriveSettings]);

  const handleChangeTopTab = useCallback((nextTab: VideoTabKey) => {
    setActiveTab(nextTab);
    scrollViewRef.current?.scrollTo({ y: 0, animated: true });
  }, []);

  useEffect(() => {
    if (!isNativeVideoImportSupported || params.shared !== '1' || isResolvingSharedPayloads) {
      return;
    }
    const candidate = resolvedSharedPayloads.find((payload) => payload.contentUri);
    if (!candidate?.contentUri) {
      return;
    }
    // ── Pre-flight MIME/extension check ─────────────────────────
    // `expo-sharing` payloads aren't only videos — when the user
    // shares a backup .zip from the in-app share sheet on some
    // emulators (notably MuMu), the .zip round-trips back into the
    // app's own incoming-share queue. Without this guard we'd call
    // `importLocalVideoFromUri` on a .zip and surface a confusing
    // "视频导入失败" alert on the videos tab. Same story for any
    // non-video file (image, pdf, apk, …) that some other app
    // decides to share at us — silently drop it instead.
    if (
      !isVideoCandidate(
        candidate.originalName ?? null,
        candidate.contentUri,
        candidate.contentMimeType ?? null,
      )
    ) {
      console.log(
        '[VideosScreen] dropping incoming share — not a video',
        JSON.stringify({
          mimeType: candidate.contentMimeType,
          originalName: candidate.originalName,
        }),
      );
      Sharing.clearSharedPayloads();
      return;
    }
    const contentUri = candidate.contentUri;
    void handleImportedEntry(async () => {
      const imported = await importLocalVideoFromUri(contentUri, {
        sourceName: candidate.originalName ?? undefined,
        mimeType: candidate.contentMimeType,
      });
      Sharing.clearSharedPayloads();
      router.replace('/(tabs)/videos');
      return imported;
    });
  }, [handleImportedEntry, isNativeVideoImportSupported, isResolvingSharedPayloads, params.shared, resolvedSharedPayloads, router]);

  const featuredVideoCards = videoScenarios.filter((scene) => scene.contentOrigin !== 'imported');
  const importedVideoCards = videoScenarios.filter((scene) => scene.contentOrigin === 'imported');
  const importedVideoTitleMap = useMemo(() => Object.fromEntries(
    importedVideoCards.map((scene) => [scene.id, scene.card.title]),
  ), [importedVideoCards]);
  const importSourceOptions = ['全部', ...Array.from(new Set(importedVideoCards.map((scene) => scene.sourceLabel).filter(Boolean)))];
  const filteredImportedVideoCards = importedVideoCards
    .filter((scene) => (selectedImportSource === '全部' ? true : scene.sourceLabel === selectedImportSource));
  const favoriteVideoCards = useMemo(() => videoScenarios
    .filter((scene) => videoUserMetaMap[scene.id]?.isFavorite)
    .sort((a, b) => (videoUserMetaMap[b.id]?.favoritedAt ?? 0) - (videoUserMetaMap[a.id]?.favoritedAt ?? 0)), [videoScenarios, videoUserMetaMap]);
  const historyVideoCards = useMemo(() => videoScenarios
    .filter((scene) => typeof videoUserMetaMap[scene.id]?.lastPracticedAt === 'number')
    .sort((a, b) => (videoUserMetaMap[b.id]?.lastPracticedAt ?? 0) - (videoUserMetaMap[a.id]?.lastPracticedAt ?? 0)), [videoScenarios, videoUserMetaMap]);
  const filteredHistoryVideoCards = useMemo(() => historyVideoCards
    .filter((scene) => isVideoSceneInHistoryFilter(videoUserMetaMap[scene.id]?.lastPracticedAt, historyFilter)), [historyFilter, historyVideoCards, videoUserMetaMap]);
  const historyFilterCounts = useMemo(() => ({
    today: historyVideoCards.filter((scene) => isVideoSceneInHistoryFilter(videoUserMetaMap[scene.id]?.lastPracticedAt, 'today')).length,
    week: historyVideoCards.filter((scene) => isVideoSceneInHistoryFilter(videoUserMetaMap[scene.id]?.lastPracticedAt, 'week')).length,
    month: historyVideoCards.filter((scene) => isVideoSceneInHistoryFilter(videoUserMetaMap[scene.id]?.lastPracticedAt, 'month')).length,
    older: historyVideoCards.filter((scene) => isVideoSceneInHistoryFilter(videoUserMetaMap[scene.id]?.lastPracticedAt, 'older')).length,
  }), [historyVideoCards, videoUserMetaMap]);

  useEffect(() => {
    if (selectedImportSource !== '全部' && !importSourceOptions.includes(selectedImportSource)) {
      setSelectedImportSource('全部');
    }
  }, [importSourceOptions, selectedImportSource]);

  return (
    <View style={styles.container}>
      <ScrollView
        ref={scrollViewRef}
        style={styles.scroll}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={styles.scrollContent}
        stickyHeaderIndices={[1]}
        refreshControl={
          <RefreshControl refreshing={isPullRefreshing} onRefresh={handlePullRefresh} />
        }
      >
        <View style={sectionStyles.pageHeader}>
          <View style={sectionStyles.sectionHeaderRow}>
            <Text style={sectionStyles.pageTitle}>视频跟练</Text>
            {activeTab === 'mine' && isNativeVideoImportSupported ? (
              <View style={sectionStyles.sectionHeaderActions}>
                <Pressable style={styles.downloadProgressBtn} onPress={handleOpenDownloadSheet}>
                  <HardDriveDownload size={16} color="#0F766E" />
                  <Text style={styles.downloadProgressBtnText}>网盘下载</Text>
                  {activeDownloadCount > 0 ? (
                    <View style={styles.downloadProgressBadge}>
                      <Text style={styles.downloadProgressBadgeText}>{activeDownloadCount}</Text>
                    </View>
                  ) : null}
                </Pressable>
                <Pressable
                  style={[styles.importBtn, isImporting && styles.importBtnDisabled]}
                  onPress={handleOpenSourceBinding}
                  disabled={isImporting}
                >
                  {isImporting ? (
                    <ActivityIndicator size="small" color="#FFFFFF" />
                  ) : (
                    <Plus size={16} color="#FFFFFF" />
                  )}
                  <Text style={styles.importBtnText}>{isImporting ? '处理中' : '导入视频'}</Text>
                </Pressable>
              </View>
            ) : null}
          </View>
        </View>

        <View style={styles.stickyTabHeader}>
          <View style={styles.tabSwitchRow}>
            <Pressable
              style={[styles.tabSwitchChip, activeTab === 'explore' && styles.tabSwitchChipActive]}
              onPress={() => handleChangeTopTab('explore')}
            >
              <Text style={[styles.tabSwitchText, activeTab === 'explore' && styles.tabSwitchTextActive]}>推荐</Text>
            </Pressable>
            <Pressable
              style={[styles.tabSwitchChip, activeTab === 'mine' && styles.tabSwitchChipActive]}
              onPress={() => handleChangeTopTab('mine')}
            >
              <Text style={[styles.tabSwitchText, activeTab === 'mine' && styles.tabSwitchTextActive]}>导入</Text>
            </Pressable>
            <Pressable
              style={[styles.tabSwitchChip, activeTab === 'history' && styles.tabSwitchChipActive]}
              onPress={() => handleChangeTopTab('history')}
            >
              <Text style={[styles.tabSwitchText, activeTab === 'history' && styles.tabSwitchTextActive]}>历史</Text>
            </Pressable>
            <Pressable
              style={[styles.tabSwitchChip, activeTab === 'favorites' && styles.tabSwitchChipActive]}
              onPress={() => handleChangeTopTab('favorites')}
            >
              <Text style={[styles.tabSwitchText, activeTab === 'favorites' && styles.tabSwitchTextActive]}>收藏</Text>
            </Pressable>
          </View>
        </View>

        <View style={sectionStyles.sectionBlock}>
          {activeTab === 'explore' ? (
            <>
              <View style={styles.filterGroup}>
                <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.filterScrollContent}>
                  <Pressable
                    style={[styles.filterChip, selectedVideoLevel === 'all' && styles.filterChipActive]}
                    onPress={() => setSelectedVideoLevel('all')}
                  >
                    <Text style={[styles.filterChipText, selectedVideoLevel === 'all' && styles.filterChipTextActive]}>全部</Text>
                  </Pressable>
                  <Pressable
                    style={[styles.filterChip, selectedVideoLevel === 'recommended' && styles.filterChipActive]}
                    onPress={() => setSelectedVideoLevel('recommended')}
                  >
                    <Text style={[styles.filterChipText, selectedVideoLevel === 'recommended' && styles.filterChipTextActive]}>适合我</Text>
                  </Pressable>
                  {LEVEL_ORDER.map((level) => {
                    const active = selectedVideoLevel === level;
                    return (
                      <Pressable
                        key={`video-level-${level}`}
                        style={[styles.filterChip, active && styles.filterChipActive]}
                        onPress={() => setSelectedVideoLevel(level as 'A1' | 'A2' | 'B1' | 'B2' | 'C1' | 'C2')}
                      >
                        <Text style={[styles.filterChipText, active && styles.filterChipTextActive]}>{level}</Text>
                      </Pressable>
                    );
                  })}
                </ScrollView>
                <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.filterScrollContent}>
                  {seriesCategories.map((category) => {
                    const active = selectedVideoCategory === category;
                    return (
                      <Pressable
                        key={`video-category-${category}`}
                        style={[styles.filterChip, active && styles.filterChipActive]}
                        onPress={() => setSelectedVideoCategory(category)}
                      >
                        <Text style={[styles.filterChipText, active && styles.filterChipTextActive]}>{category}</Text>
                      </Pressable>
                    );
                  })}
                </ScrollView>
              </View>

              {isLoading && visibleSeriesCards.length === 0 ? (
                <View style={styles.loadingBanner}>
                  <ActivityIndicator size="small" color={colors.primary} />
                  <Text style={styles.loadingBannerText}>视频列表加载中…</Text>
                </View>
              ) : visibleSeriesCards.length === 0 ? (
                <View style={styles.emptySectionState}>
                  <Text style={styles.emptySectionText}>当前筛选下还没有合适的视频，试试切回“全部”、其他等级或更换分类。</Text>
                  <Pressable
                    style={styles.filterResetBtn}
                    onPress={() => {
                      setSelectedVideoLevel('all');
                      setSelectedVideoCategory('全部');
                    }}
                  >
                    <Text style={styles.filterResetBtnText}>查看全部视频</Text>
                  </Pressable>
                </View>
              ) : visibleSeriesCards.map((series) => renderSeriesCard(series))}
            </>
          ) : activeTab === 'mine' ? (isLoading && importedVideoCards.length === 0 ? (
            <View style={styles.loadingBanner}>
              <ActivityIndicator size="small" color={colors.primary} />
              <Text style={styles.loadingBannerText}>导入视频加载中…</Text>
            </View>
          ) : importedVideoCards.length === 0 ? (
            <View style={styles.emptySectionState}>
              <Text style={styles.emptyStateTitle}>你还没有导入视频</Text>
              <Text style={styles.emptySectionText}>可以从本地视频文件导入，或从已连接网盘中选择视频建立关系记录。</Text>
              {isNativeVideoImportSupported ? (
                <View style={styles.emptyActionRow}>
                  <Pressable style={styles.emptyPrimaryBtn} onPress={handleOpenSourceBinding}>
                    <Plus size={16} color="#FFFFFF" />
                    <Text style={styles.emptyPrimaryBtnText}>导入视频</Text>
                  </Pressable>
                  <Pressable style={styles.emptySecondaryBtn} onPress={handleGoToMountDrives}>
                    <Text style={styles.emptySecondaryBtnText}>管理网盘</Text>
                  </Pressable>
                </View>
              ) : null}
            </View>
          ) : (
            <>
              {importSourceOptions.length > 1 ? (
                <View style={styles.filterGroup}>
                  <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.filterScrollContent}>
                    {importSourceOptions.map((source) => {
                      const active = selectedImportSource === source;
                      return (
                        <Pressable
                          key={`video-import-source-${source}`}
                          style={[styles.filterChip, active && styles.filterChipActive]}
                          onPress={() => setSelectedImportSource(source)}
                        >
                          <Text style={[styles.filterChipText, active && styles.filterChipTextActive]}>{source}</Text>
                        </Pressable>
                      );
                    })}
                  </ScrollView>
                </View>
              ) : null}
              {filteredImportedVideoCards.length === 0 ? (
                <View style={styles.emptySectionState}>
                  <Text style={styles.emptyStateTitle}>这个来源下还没有导入视频</Text>
                  <Text style={styles.emptySectionText}>切换到其他导入来源，或者从当前来源继续导入视频。</Text>
                </View>
              ) : filteredImportedVideoCards.map((scene) => renderVideoPosterCard(scene, 'mine'))}
            </>
          )) : activeTab === 'history' ? (
            <>
              <View style={styles.filterGroup}>
                <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.filterScrollContent}>
                  {([
                    ['today', '今天'],
                    ['week', '本周'],
                    ['month', '本月'],
                    ['older', '一个月前'],
                  ] as const).map(([key, label]) => {
                    const active = historyFilter === key;
                    const count = historyFilterCounts[key];
                    return (
                      <Pressable
                        key={`video-history-${key}`}
                        style={[styles.filterChip, active && styles.filterChipActive]}
                        onPress={() => setHistoryFilter(key)}
                      >
                        <Text style={[styles.filterChipText, active && styles.filterChipTextActive]}>{count > 0 ? `${label} ${count}` : label}</Text>
                      </Pressable>
                    );
                  })}
                </ScrollView>
              </View>
              {isLoading && historyVideoCards.length === 0 ? (
                <View style={styles.loadingBanner}>
                  <ActivityIndicator size="small" color={colors.primary} />
                  <Text style={styles.loadingBannerText}>历史记录加载中…</Text>
                </View>
              ) : historyVideoCards.length === 0 ? (
                <View style={styles.emptySectionState}>
                  <Text style={styles.emptyStateTitle}>还没有跟练历史</Text>
                  <Text style={styles.emptySectionText}>当你进入视频跟练详情页后，对应视频会自动出现在这里，并按最近时间排序。</Text>
                </View>
              ) : filteredHistoryVideoCards.length === 0 ? (
                <View style={styles.emptySectionState}>
                  <Text style={styles.emptyStateTitle}>这个时间范围里还没有记录</Text>
                  <Text style={styles.emptySectionText}>试试切换到其他时间筛选，查看更早的跟练视频。</Text>
                </View>
              ) : filteredHistoryVideoCards.map((scene) => renderVideoPosterCard(scene, 'history'))}
            </>
          ) : isLoading && favoriteVideoCards.length === 0 ? (
            <View style={styles.loadingBanner}>
              <ActivityIndicator size="small" color={colors.primary} />
              <Text style={styles.loadingBannerText}>收藏视频加载中…</Text>
            </View>
          ) : favoriteVideoCards.length === 0 ? (
            <View style={styles.emptySectionState}>
              <Text style={styles.emptyStateTitle}>你还没有收藏视频</Text>
              <Text style={styles.emptySectionText}>去视频详情页右上角三点菜单里收藏视频，之后就会集中显示在这里。</Text>
            </View>
          ) : favoriteVideoCards.map((scene) => renderVideoPosterCard(scene, 'favorites'))}
        </View>
      </ScrollView>

      <Modal
        visible={isDownloadSheetVisible}
        transparent
        animationType="slide"
        onRequestClose={handleCloseDownloadSheet}
      >
        <View style={styles.sheetOverlay}>
          <Pressable style={{ flex: 1 }} onPress={handleCloseDownloadSheet} />
          <View style={styles.customSheet}>
            <View style={styles.customSheetHandle} />
            <View style={styles.customSheetHeader}>
              <View style={styles.videoAiPickerHeaderInfo}>
                <Text style={styles.customSheetTitle}>下载进度</Text>
                <View style={styles.sheetHintRow}>
                  <Text style={styles.videoAiPickerHint}>查看已加入下载的视频，并在这里暂停、恢复或移除。</Text>
                  <Pressable onPress={handleShowSlowDownloadHelp} hitSlop={8}>
                    <Text style={styles.sheetHintLink}>下载慢？</Text>
                  </Pressable>
                </View>
              </View>
              <Pressable onPress={handleCloseDownloadSheet}>
                <X size={20} color={colors.text.secondary} />
              </Pressable>
            </View>
            <ScrollView showsVerticalScrollIndicator={false} style={styles.resultsScroll} contentContainerStyle={styles.downloadSheetContent}>
              {downloadEntries.length === 0 ? (
                <View style={styles.emptySectionState}>
                  <Text style={styles.emptyStateTitle}>还没有下载任务</Text>
                  <Text style={styles.emptySectionText}>在导入视频列表里点击“下载”后，就可以在这里查看进度和控制下载。</Text>
                </View>
              ) : downloadEntries.map((entry) => {
                const taskKey = `${entry.sceneId}__${entry.provider}`;
                const isActing = downloadActionKey === taskKey;
                const title = importedVideoTitleMap[entry.sceneId]
                  || entry.remotePath?.split('/').filter(Boolean).pop()
                  || entry.sceneId;
                const progressPercent = Math.max(0, Math.min(100, Math.round((entry.progress || 0) * 100)));
                const progressText = entry.totalBytesExpectedToWrite && entry.totalBytesExpectedToWrite > 0
                  ? `${formatFileSize(entry.totalBytesWritten)} / ${formatFileSize(entry.totalBytesExpectedToWrite)}`
                  : formatFileSize(entry.totalBytesWritten);
                const speedText = entry.speedBytesPerSecond && entry.speedBytesPerSecond > 0
                  ? `${formatFileSize(entry.speedBytesPerSecond)}/s`
                  : '';
                return (
                  <View key={taskKey} style={styles.downloadTaskCard}>
                    <View style={styles.downloadTaskHeader}>
                      <View style={styles.downloadTaskTitleWrap}>
                        <Text style={styles.downloadTaskTitle} numberOfLines={2}>{title}</Text>
                        <Text style={styles.downloadTaskMeta}>
                          {getCloudProviderLabel(entry.provider)} · {getDownloadStatusLabel(entry.status)}
                        </Text>
                      </View>
                      <Text style={styles.downloadTaskPercent}>{progressPercent}%</Text>
                    </View>
                    <View style={styles.downloadProgressTrack}>
                      <View style={[styles.downloadProgressFill, { width: `${progressPercent}%` }]} />
                    </View>
                    <View style={styles.downloadTaskStatsRow}>
                      <Text style={styles.downloadTaskStatsText}>{progressText}</Text>
                      <Text style={styles.downloadTaskStatsText}>{speedText || (entry.status === 'completed' ? '可离线播放' : '等待中')}</Text>
                    </View>
                    {entry.errorMessage ? (
                      <Text style={styles.downloadTaskError} numberOfLines={2}>{entry.errorMessage}</Text>
                    ) : null}
                    <View style={styles.downloadTaskActionRow}>
                      {entry.status === 'downloading' || entry.status === 'resolving' ? (
                        <Pressable
                          style={[styles.downloadTaskSecondaryBtn, isActing && styles.importBtnDisabled]}
                          onPress={() => handlePauseDownload(entry)}
                          disabled={isActing}
                        >
                          <Pause size={14} color="#0F766E" />
                          <Text style={styles.downloadTaskSecondaryBtnText}>暂停</Text>
                        </Pressable>
                      ) : null}
                      {entry.status === 'paused' || entry.status === 'error' ? (
                        <Pressable
                          style={[styles.downloadTaskPrimaryBtn, isActing && styles.importBtnDisabled]}
                          onPress={() => handleResumeDownload(entry)}
                          disabled={isActing}
                        >
                          <Play size={14} color="#FFFFFF" />
                          <Text style={styles.downloadTaskPrimaryBtnText}>{entry.status === 'error' ? '重试' : '继续'}</Text>
                        </Pressable>
                      ) : null}
                      <Pressable
                        style={[styles.downloadTaskDangerBtn, isActing && styles.importBtnDisabled]}
                        onPress={() => handleRemoveDownload(entry)}
                        disabled={isActing}
                      >
                        <Trash2 size={14} color="#B91C1C" />
                        <Text style={styles.downloadTaskDangerBtnText}>移除</Text>
                      </Pressable>
                    </View>
                  </View>
                );
              })}
            </ScrollView>
          </View>
        </View>
      </Modal>

      <Modal
        visible={isSourceBindingVisible}
        transparent
        animationType="slide"
        onRequestClose={() => setIsSourceBindingVisible(false)}
      >
        <View style={styles.sheetOverlay}>
          <Pressable style={{ flex: 1 }} onPress={() => setIsSourceBindingVisible(false)} />
          <View style={styles.customSheet}>
            <View style={styles.customSheetHandle} />
            <View style={styles.customSheetHeader}>
              <View style={styles.videoAiPickerHeaderInfo}>
                <Text style={styles.customSheetTitle}>导入视频</Text>
                <Text style={styles.videoAiPickerHint}>从已连接网盘或本地设备导入视频文件。</Text>
              </View>
              <Pressable onPress={() => setIsSourceBindingVisible(false)}>
                <X size={20} color={colors.text.secondary} />
              </Pressable>
            </View>
            <VideoSourcePickerContent
              visible={isSourceBindingVisible}
              allowLocalImport={isNativeVideoImportSupported}
              onImportLocalVideo={handleImportVideo}
              onDownloadCloudVideo={handleDownloadCloudVideo}
              onRequestGoToMountDrives={handleGoToMountDrives}
              onCloudImportSuccess={async (entry) => {
                setIsSourceBindingVisible(false);
                setActiveTab('mine');
                // 同 handleImportedEntry:必须清 featuredScenesCache
                invalidateVideoSceneCaches();
                await loadVideoScenarios(false);
                showToast(`已导入：${entry.title}`);
                triggerImportedVideoSubtitleGeneration(entry);
              }}
            />
          </View>
        </View>
      </Modal>

      <Modal
        visible={!!officialBindScene}
        transparent
        animationType="slide"
        onRequestClose={() => setOfficialBindScene(null)}
      >
        <View style={styles.sheetOverlay}>
          <Pressable style={{ flex: 1 }} onPress={() => setOfficialBindScene(null)} />
          <View style={styles.customSheet}>
            <View style={styles.customSheetHandle} />
            <View style={styles.customSheetHeader}>
              <View style={styles.videoAiPickerHeaderInfo}>
                <Text style={styles.customSheetTitle}>绑定推荐视频</Text>
                <Text style={styles.videoAiPickerHint} numberOfLines={2}>{officialBindScene?.card.title}</Text>
              </View>
              <Pressable onPress={() => setOfficialBindScene(null)}>
                <X size={20} color={colors.text.secondary} />
              </Pressable>
            </View>
            <VideoSourcePickerContent
              mode="bind"
              visible={!!officialBindScene}
              fixedProvider={officialBindScene ? getCurrentOfficialProvider(officialBindScene)?.provider ?? null : null}
              onRequestGoToMountDrives={handleOpenCloudDriveSettings}
              onCloudFileSelected={handleBindOfficialCloudFile}
            />
          </View>
        </View>
      </Modal>

      <Modal
        visible={!!videoAiPickerScene}
        transparent
        animationType="slide"
        onRequestClose={handleCloseVideoAiPicker}
      >
        <View style={styles.sheetOverlay}>
          <Pressable style={{ flex: 1 }} onPress={handleCloseVideoAiPicker} />
          <View style={styles.customSheet}>
            <View style={styles.customSheetHandle} />
            <View style={styles.customSheetHeader}>
              <View style={styles.videoAiPickerHeaderInfo}>
                <Text style={styles.customSheetTitle}>选择视频延展 AI陪练主题</Text>
                <Text style={styles.videoAiPickerHint} numberOfLines={2}>{videoAiPickerScene?.card.title}</Text>
              </View>
              <Pressable onPress={handleCloseVideoAiPicker}>
                <X size={20} color={colors.text.secondary} />
              </Pressable>
            </View>
            <ScrollView showsVerticalScrollIndicator={false} style={styles.resultsScroll}>
              {(videoAiPickerScene?.aiPracticeCards || []).map((card) => (
                <Pressable key={card.id} style={styles.videoAiPickerCard} onPress={() => handleSelectVideoAiCard(card)}>
                  <View style={styles.resultIconBox}>
                    <Text style={styles.scenarioEmoji}>{card.icon}</Text>
                  </View>
                  <View style={styles.cardBody}>
                    <View style={styles.cardMeta}>
                      <View style={[styles.levelBadge, { backgroundColor: (LEVEL_COLORS[card.level] || LEVEL_COLORS.B1).bg }]}>
                        <Text style={[styles.levelText, { color: (LEVEL_COLORS[card.level] || LEVEL_COLORS.B1).text }]}>{card.level}</Text>
                      </View>
                      <Text style={styles.categoryText}>{card.category}</Text>
                      <Text style={[styles.sourcePill, styles.sourcePillVideo]}>视频延展</Text>
                    </View>
                    <Text style={styles.cardTitle}>{card.title}</Text>
                  </View>
                </Pressable>
              ))}
            </ScrollView>
          </View>
        </View>
      </Modal>

      <Modal
        visible={!!videoActionMenuScene}
        transparent
        animationType="fade"
        onRequestClose={handleCloseVideoActionMenu}
      >
        <View style={styles.sheetOverlay}>
          <Pressable style={{ flex: 1 }} onPress={handleCloseVideoActionMenu} />
          <View style={styles.actionMenuSheet}>
            <View style={styles.customSheetHandle} />
            <Text style={styles.actionMenuTitle} numberOfLines={1}>{videoActionMenuScene?.card.title}</Text>
            <Pressable
              style={[styles.actionMenuItem, isDeletingVideo && styles.actionMenuItemDisabled]}
              onPress={() => videoActionMenuScene ? handleRequestDeleteVideo(videoActionMenuScene) : undefined}
              disabled={isDeletingVideo}
            >
              <Text style={styles.actionMenuDeleteText}>{videoActionMenuScene ? getVideoDeleteActionLabel(videoActionMenuScene) : '删除'}</Text>
            </Pressable>
            <Pressable style={styles.actionMenuCancelBtn} onPress={handleCloseVideoActionMenu} disabled={isDeletingVideo}>
              <Text style={styles.actionMenuCancelText}>取消</Text>
            </Pressable>
          </View>
        </View>
      </Modal>

      <Modal
        visible={!!confirmSubtitleEntry}
        transparent
        animationType="slide"
        onRequestClose={() => setConfirmSubtitleEntry(null)}
      >
        <View style={styles.sheetOverlay}>
          <Pressable style={{ flex: 1 }} onPress={() => setConfirmSubtitleEntry(null)} />
          <View style={styles.customSheet}>
            <View style={styles.customSheetHandle} />
            <View style={styles.customSheetHeader}>
              <View style={styles.videoAiPickerHeaderInfo}>
                <Text style={styles.customSheetTitle}>生成字幕需要先下载</Text>
                <Text style={styles.videoAiPickerHint} numberOfLines={1}>
                  {confirmSubtitleEntry?.card.title}
                </Text>
              </View>
              <Pressable onPress={() => setConfirmSubtitleEntry(null)}>
                <X size={20} color={colors.text.secondary} />
              </Pressable>
            </View>
            <View style={styles.subtitleConfirmBody}>
              <Text style={styles.subtitleConfirmIntro}>
                百度网盘导入的视频，字幕生成需要先把视频下载到本地才能处理。
              </Text>
              <View style={styles.subtitleConfirmStats}>
                <View style={styles.subtitleConfirmStatRow}>
                  <Text style={styles.subtitleConfirmStatLabel}>文件大小</Text>
                  <Text style={styles.subtitleConfirmStatValue}>
                    约 {formatFileSize(estimateDownloadSizeFromScene(confirmSubtitleEntry))}
                  </Text>
                </View>
                <View style={styles.subtitleConfirmStatRow}>
                  <Text style={styles.subtitleConfirmStatLabel}>预计字幕时长</Text>
                  <Text style={styles.subtitleConfirmStatValue}>
                    约 {Math.max(1, minutesForAudioSeconds(confirmSubtitleEntry?.durationSeconds))} 分钟
                  </Text>
                </View>
                <View style={styles.subtitleConfirmStatRow}>
                  <Text style={styles.subtitleConfirmStatLabel}>下载后可离线播放</Text>
                  <Text style={styles.subtitleConfirmStatValue}>✓ 永久有效</Text>
                </View>
                <View style={styles.subtitleConfirmStatRow}>
                  <Text style={styles.subtitleConfirmStatLabel}>今日剩余字幕额度</Text>
                  <Text style={styles.subtitleConfirmStatValue}>
                    {subtitleMinutesAvailable ?? '—'} 分钟
                  </Text>
                </View>
              </View>
              <View style={styles.subtitleConfirmHint}>
                <Text style={styles.subtitleConfirmHintText}>
                  下载速度取决于你的网盘与网络环境。如果已下载过，会直接跳过此步。
                </Text>
              </View>
              <View style={styles.subtitleConfirmActions}>
                <Pressable
                  style={styles.subtitleConfirmBtnSecondary}
                  onPress={() => setConfirmSubtitleEntry(null)}
                >
                  <Text style={styles.subtitleConfirmBtnSecondaryText}>取消</Text>
                </Pressable>
                <Pressable
                  style={styles.subtitleConfirmBtnPrimary}
                  onPress={() => {
                    const scene = confirmSubtitleEntry;
                    setConfirmSubtitleEntry(null);
                    if (!scene) return;
                    triggerImportedVideoSubtitleGeneration({
                      id: scene.id,
                      sourceType: 'cloud_reference',
                    });
                  }}
                >
                  <Text style={styles.subtitleConfirmBtnPrimaryText}>开始下载并生成</Text>
                </Pressable>
              </View>
            </View>
          </View>
        </View>
      </Modal>

      {toast ? (
        <View style={styles.toast} pointerEvents="none">
          <Text style={styles.toastText}>{toast}</Text>
        </View>
      ) : null}
    </View>
  );
}

/**
 * Best-effort byte estimate for the download confirm modal. We
 * don't have a `fileSize` field on `VideoSceneDetail` (it lives on
 * the underlying `UserVideoEntry`), so this is only an "approximate"
 * label. If we ever expose fileSize on the scene we can swap this
 * for the real value.
 */
function estimateDownloadSizeFromScene(scene: VideoSceneDetail | null): number {
  if (!scene) return 0;
  // 1.5 MB / second is a reasonable SD video bitrate assumption.
  // Returns 0 (renders as "0 B") for unknown durations.
  const seconds = scene.durationSeconds;
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) {
    return 0;
  }
  return Math.round(seconds * 1.5 * 1024 * 1024);
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  scroll: { flex: 1 },
  scrollContent: {
    paddingHorizontal: spacing.lg,
    paddingTop: 0,
    paddingBottom: 120,
    gap: 0,
  },
  importBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    minHeight: 32,
    paddingHorizontal: spacing.sm,
    paddingVertical: 6,
    borderRadius: borderRadius.full,
    backgroundColor: colors.primary,
  },
  importBtnDisabled: {
    opacity: 0.72,
  },
  importBtnText: {
    color: '#FFFFFF',
    fontSize: fontSize.xs,
    fontWeight: fontWeight.bold,
  },
  downloadProgressBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    minHeight: 32,
    paddingHorizontal: spacing.sm,
    paddingVertical: 6,
    borderRadius: borderRadius.full,
    borderWidth: 1,
    borderColor: '#99F6E4',
    backgroundColor: '#F0FDFA',
  },
  downloadProgressBtnText: {
    color: '#0F766E',
    fontSize: fontSize.xs,
    fontWeight: fontWeight.bold,
  },
  downloadProgressBadge: {
    minWidth: 18,
    height: 18,
    paddingHorizontal: 5,
    borderRadius: borderRadius.full,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#0F766E',
  },
  downloadProgressBadgeText: {
    color: '#FFFFFF',
    fontSize: 10,
    fontWeight: fontWeight.bold,
  },
  stickyTabHeader: {
    paddingBottom: spacing.sm,
    backgroundColor: colors.background,
    zIndex: 10,
    alignItems: 'center',
  },
  tabSwitchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    padding: 4,
    borderRadius: borderRadius.full,
    backgroundColor: '#E2E8F0',
    alignSelf: 'center',
  },
  tabSwitchChip: {
    paddingHorizontal: spacing.md,
    paddingVertical: 10,
    borderRadius: borderRadius.full,
  },
  tabSwitchChipActive: {
    backgroundColor: colors.surface,
  },
  tabSwitchText: {
    fontSize: fontSize.sm,
    color: colors.text.secondary,
    fontWeight: fontWeight.medium,
  },
  tabSwitchTextActive: {
    color: colors.text.primary,
    fontWeight: fontWeight.bold,
  },
  loadingBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: borderRadius.xl,
    backgroundColor: '#EFF6FF',
  },
  loadingBannerText: {
    fontSize: fontSize.sm,
    color: colors.primary,
    fontWeight: fontWeight.medium,
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
  emptySectionState: {
    padding: spacing.lg,
    borderRadius: borderRadius.xxl,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border.light,
  },
  emptySectionText: {
    fontSize: fontSize.sm,
    color: colors.text.secondary,
    lineHeight: 22,
  },
  emptyStateTitle: {
    fontSize: fontSize.base,
    color: colors.text.primary,
    fontWeight: fontWeight.bold,
    marginBottom: spacing.xs,
  },
  emptyActionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginTop: spacing.md,
  },
  emptyPrimaryBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: spacing.md,
    paddingVertical: 10,
    borderRadius: borderRadius.xl,
    backgroundColor: colors.primary,
  },
  emptyPrimaryBtnText: {
    color: '#FFFFFF',
    fontSize: fontSize.sm,
    fontWeight: fontWeight.bold,
  },
  emptySecondaryBtn: {
    paddingHorizontal: spacing.md,
    paddingVertical: 10,
    borderRadius: borderRadius.xl,
    borderWidth: 1,
    borderColor: '#BFDBFE',
    backgroundColor: '#EFF6FF',
  },
  emptySecondaryBtnText: {
    color: '#2563EB',
    fontSize: fontSize.sm,
    fontWeight: fontWeight.bold,
  },
  filterResetBtn: {
    alignSelf: 'flex-start',
    marginTop: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: 10,
    borderRadius: borderRadius.lg,
    backgroundColor: '#EFF6FF',
  },
  filterResetBtnText: {
    fontSize: fontSize.sm,
    color: colors.primary,
    fontWeight: fontWeight.bold,
  },
  levelBadge: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: borderRadius.sm,
  },
  levelText: {
    fontSize: 10,
    fontWeight: fontWeight.bold,
  },
  categoryText: {
    fontSize: 11,
    fontWeight: fontWeight.bold,
    color: '#9CA3AF',
  },
  cardBody: {
    flex: 1,
    paddingVertical: 2,
  },
  cardMeta: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginBottom: 6,
  },
  cardTitle: {
    fontSize: fontSize.sm,
    fontWeight: fontWeight.bold,
    color: colors.text.primary,
    lineHeight: 20,
  },
  resultIconBox: {
    width: 56,
    height: 56,
    backgroundColor: colors.background,
    borderRadius: borderRadius.xl,
    justifyContent: 'center',
    alignItems: 'center',
  },
  scenarioEmoji: {
    fontSize: 28,
  },
  sourcePill: {
    fontSize: 10,
    fontWeight: fontWeight.bold,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: borderRadius.sm,
    overflow: 'hidden',
  },
  sourcePillVideo: {
    color: '#0F766E',
    backgroundColor: '#CCFBF1',
  },
  videoPosterCard: {
    borderRadius: borderRadius.xxl,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: colors.border.light,
    backgroundColor: '#0F172A',
    minHeight: 196,
    shadowColor: '#0F172A',
    shadowOpacity: 0.12,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 10 },
    elevation: 4,
  },
  seriesCard: {
    borderRadius: borderRadius.xxl,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: colors.border.light,
    backgroundColor: '#0F172A',
    minHeight: 216,
    shadowColor: '#0F172A',
    shadowOpacity: 0.12,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 10 },
    elevation: 4,
  },
  seriesCardBackground: {
    minHeight: 216,
    justifyContent: 'space-between',
  },
  seriesCardImage: {
    borderRadius: borderRadius.xxl,
  },
  seriesCardOverlay: {
    flex: 1,
    justifyContent: 'space-between',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    backgroundColor: 'rgba(15,23,42,0.48)',
  },
  seriesCardTopRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: spacing.sm,
  },
  seriesEpisodePill: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: borderRadius.full,
    backgroundColor: 'rgba(219,234,254,0.92)',
  },
  seriesEpisodePillText: {
    color: '#1E3A8A',
    fontSize: fontSize.xs,
    fontWeight: fontWeight.bold,
  },
  seriesCardBottom: {
    gap: spacing.sm,
  },
  seriesCardTitle: {
    color: '#FFFFFF',
    fontSize: 22,
    lineHeight: 30,
    fontWeight: fontWeight.bold,
  },
  seriesCardSubtitle: {
    color: 'rgba(255,255,255,0.82)',
    fontSize: fontSize.sm,
    lineHeight: 20,
  },
  seriesProgressRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  seriesProgressTrack: {
    flex: 1,
    height: 8,
    borderRadius: borderRadius.full,
    backgroundColor: 'rgba(255,255,255,0.16)',
    overflow: 'hidden',
  },
  seriesProgressFill: {
    height: '100%',
    borderRadius: borderRadius.full,
    backgroundColor: '#60A5FA',
  },
  seriesProgressText: {
    color: '#DBEAFE',
    fontSize: fontSize.xs,
    fontWeight: fontWeight.bold,
    minWidth: 34,
    textAlign: 'right',
  },
  seriesActionRow: {
    flexDirection: 'row',
    gap: spacing.sm,
  },
  seriesPrimaryBtn: {
    minHeight: 40,
    paddingHorizontal: spacing.md,
    borderRadius: borderRadius.xl,
    backgroundColor: '#2563EB',
    alignItems: 'center',
    justifyContent: 'center',
  },
  seriesPrimaryBtnText: {
    color: '#FFFFFF',
    fontSize: fontSize.xs,
    fontWeight: fontWeight.bold,
  },
  seriesSecondaryBtn: {
    minHeight: 40,
    paddingHorizontal: spacing.md,
    borderRadius: borderRadius.xl,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.55)',
    backgroundColor: 'rgba(255,255,255,0.1)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  seriesSecondaryBtnText: {
    color: '#FFFFFF',
    fontSize: fontSize.xs,
    fontWeight: fontWeight.bold,
  },
  videoPosterBackground: {
    minHeight: 196,
    justifyContent: 'space-between',
  },
  videoPosterImage: {
    borderRadius: borderRadius.xxl,
  },
  videoPosterFallback: {
    backgroundColor: '#1E293B',
  },
  videoPosterOverlay: {
    flex: 1,
    justifyContent: 'space-between',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    backgroundColor: 'rgba(15,23,42,0.42)',
  },
  videoPosterTopRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: spacing.sm,
  },
  videoPosterTopActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
  },
  videoPosterBadgeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    flexWrap: 'wrap',
  },
  videoPosterMenuBtn: {
    minWidth: 34,
    minHeight: 34,
    borderRadius: borderRadius.full,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(15,23,42,0.42)',
    paddingHorizontal: 6,
  },
  videoPosterMenuBtnText: {
    color: '#FFFFFF',
    fontSize: 18,
    lineHeight: 18,
    fontWeight: fontWeight.bold,
    marginTop: -6,
  },
  videoPosterMetaPill: {
    paddingHorizontal: 8,
    paddingVertical: 5,
    borderRadius: borderRadius.full,
    backgroundColor: 'rgba(255,255,255,0.18)',
  },
  videoPosterMetaText: {
    color: '#FFFFFF',
    fontSize: fontSize.xs,
    fontWeight: fontWeight.bold,
  },
  videoPosterDurationPill: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: borderRadius.full,
    backgroundColor: 'rgba(219,234,254,0.92)',
  },
  videoPosterDurationText: {
    color: '#1E3A8A',
    fontSize: fontSize.xs,
    fontWeight: fontWeight.bold,
  },
  videoPosterBottomContent: {
    gap: spacing.sm,
  },
  videoSourceStatusPillImported: {
    backgroundColor: 'rgba(16,185,129,0.18)',
  },
  videoSourceStatusPillLocal: {
    backgroundColor: 'rgba(59,130,246,0.22)',
  },
  videoSourceStatusPillRemote: {
    backgroundColor: 'rgba(147,197,253,0.18)',
  },
  videoSourceStatusPillDisabled: {
    backgroundColor: 'rgba(255,255,255,0.08)',
  },
  videoSourceStatusText: {
    color: '#E2E8F0',
    fontSize: fontSize.xs,
    fontWeight: fontWeight.bold,
  },
  videoSourceStatusTextImported: {
    color: '#D1FAE5',
  },
  videoSourceStatusTextLocal: {
    color: '#DBEAFE',
  },
  videoSourceStatusTextRemote: {
    color: '#E0F2FE',
  },
  videoSourceStatusTextDisabled: {
    color: '#CBD5E1',
  },
  videoPosterTitle: {
    color: '#FFFFFF',
    fontSize: 22,
    lineHeight: 30,
    fontWeight: fontWeight.bold,
    maxWidth: '88%',
  },
  videoPosterActionRow: {
    flexDirection: 'row',
    gap: spacing.sm,
    flexWrap: 'wrap',
  },
  videoPosterPrimaryActionBtn: {
    minHeight: 40,
    paddingHorizontal: spacing.md,
    borderRadius: borderRadius.xl,
    backgroundColor: '#2563EB',
    alignItems: 'center',
    justifyContent: 'center',
  },
  videoPosterPrimaryActionText: {
    color: '#FFFFFF',
    fontSize: fontSize.xs,
    fontWeight: fontWeight.bold,
  },
  videoPosterSecondaryActionBtn: {
    minHeight: 40,
    paddingHorizontal: spacing.md,
    borderRadius: borderRadius.xl,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.55)',
    backgroundColor: 'rgba(255,255,255,0.1)',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
  },
  videoPosterSubtitleBtn: {
    minHeight: 40,
    paddingHorizontal: spacing.md,
    borderRadius: borderRadius.xl,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.55)',
    backgroundColor: 'rgba(245,158,11,0.18)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  videoPosterSubtitleBtnDisabled: {
    borderColor: 'rgba(255,255,255,0.25)',
    backgroundColor: 'rgba(255,255,255,0.05)',
  },
  videoPosterSubtitleBtnText: {
    color: '#FFFFFF',
    fontSize: fontSize.xs,
    fontWeight: fontWeight.bold,
  },
  videoPosterSubtitleBtnTextDisabled: {
    color: 'rgba(255,255,255,0.6)',
  },
  subtitleSummaryRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingTop: 2,
    paddingBottom: 4,
  },
  subtitleSummaryText: {
    color: 'rgba(255,255,255,0.85)',
    fontSize: 11,
    fontWeight: '500' as const,
    flex: 1,
  },
  subtitleProgressTrack: {
    height: 3,
    width: 80,
    borderRadius: 2,
    backgroundColor: 'rgba(255,255,255,0.18)',
    overflow: 'hidden',
  },
  subtitleProgressFill: {
    height: 3,
    backgroundColor: '#F59E0B',
    borderRadius: 2,
  },
  // Subtitle download confirm modal — reuses the existing sheet chrome
  // (`customSheet*` styles above). We only need the body content here.
  subtitleConfirmBody: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    paddingBottom: spacing.lg,
    gap: spacing.md,
  },
  subtitleConfirmIntro: {
    fontSize: 14,
    color: '#1A1A1A',
    lineHeight: 22,
  },
  subtitleConfirmStats: {
    backgroundColor: '#F9FAFB',
    borderRadius: borderRadius.lg,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.md,
    gap: 8,
  },
  subtitleConfirmStatRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  subtitleConfirmStatLabel: {
    fontSize: 12,
    color: '#6B7280',
  },
  subtitleConfirmStatValue: {
    fontSize: 13,
    color: '#111827',
    fontWeight: '600' as const,
  },
  subtitleConfirmHint: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 6,
    backgroundColor: '#FEF3C7',
    borderRadius: borderRadius.md,
    padding: spacing.sm,
  },
  subtitleConfirmHintText: {
    flex: 1,
    fontSize: 12,
    color: '#92400E',
    lineHeight: 18,
  },
  subtitleConfirmActions: {
    flexDirection: 'row',
    gap: spacing.sm,
  },
  subtitleConfirmBtnSecondary: {
    flex: 1,
    minHeight: 44,
    borderRadius: borderRadius.xl,
    backgroundColor: '#F3F4F6',
    alignItems: 'center',
    justifyContent: 'center',
  },
  subtitleConfirmBtnSecondaryText: {
    fontSize: 14,
    fontWeight: '600' as const,
    color: '#1A1A1A',
  },
  subtitleConfirmBtnPrimary: {
    flex: 1.4,
    minHeight: 44,
    borderRadius: borderRadius.xl,
    backgroundColor: '#F59E0B',
    alignItems: 'center',
    justifyContent: 'center',
  },
  subtitleConfirmBtnPrimaryText: {
    fontSize: 14,
    fontWeight: '700' as const,
    color: '#FFFFFF',
  },
  videoPosterSecondaryActionText: {
    color: '#FFFFFF',
    fontSize: fontSize.xs,
    fontWeight: fontWeight.bold,
  },
  sheetOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.4)',
  },
  customSheet: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    paddingBottom: 48,
    gap: spacing.md,
    height: '75%',
  },
  actionMenuSheet: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    paddingBottom: spacing.xl,
    gap: spacing.md,
  },
  customSheetHandle: {
    width: 40,
    height: 5,
    backgroundColor: colors.border.default,
    borderRadius: borderRadius.full,
    alignSelf: 'center',
    marginBottom: spacing.sm,
  },
  customSheetHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  customSheetTitle: {
    fontSize: fontSize.lg,
    fontWeight: fontWeight.bold,
    color: colors.text.primary,
  },
  actionMenuTitle: {
    fontSize: fontSize.base,
    fontWeight: fontWeight.bold,
    color: colors.text.primary,
  },
  actionMenuItem: {
    minHeight: 54,
    borderRadius: borderRadius.xl,
    paddingHorizontal: spacing.md,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#FEF2F2',
    borderWidth: 1,
    borderColor: '#FECACA',
  },
  actionMenuItemDisabled: {
    opacity: 0.6,
  },
  actionMenuDeleteText: {
    color: '#DC2626',
    fontSize: fontSize.base,
    fontWeight: fontWeight.bold,
  },
  actionMenuCancelBtn: {
    minHeight: 52,
    borderRadius: borderRadius.xl,
    paddingHorizontal: spacing.md,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#F8FAFC',
    borderWidth: 1,
    borderColor: colors.border.light,
  },
  actionMenuCancelText: {
    color: colors.text.secondary,
    fontSize: fontSize.base,
    fontWeight: fontWeight.medium,
  },
  videoAiPickerHeaderInfo: {
    flex: 1,
    gap: 4,
    paddingRight: spacing.md,
  },
  sheetHintRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    columnGap: 8,
    rowGap: 4,
  },
  sheetHintLink: {
    fontSize: fontSize.sm,
    color: colors.primary,
    fontWeight: fontWeight.bold,
    textDecorationLine: 'underline',
  },
  videoAiPickerHint: {
    fontSize: fontSize.sm,
    color: colors.text.secondary,
    lineHeight: 20,
  },
  resultsScroll: {
    flex: 1,
  },
  downloadSheetContent: {
    gap: spacing.md,
    paddingBottom: spacing.xl,
  },
  downloadTaskCard: {
    gap: spacing.sm,
    padding: spacing.md,
    borderRadius: borderRadius.xxl,
    borderWidth: 1,
    borderColor: colors.border.light,
    backgroundColor: colors.surface,
  },
  downloadTaskHeader: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: spacing.sm,
  },
  downloadTaskTitleWrap: {
    flex: 1,
    gap: 4,
  },
  downloadTaskTitle: {
    color: colors.text.primary,
    fontSize: fontSize.base,
    fontWeight: fontWeight.bold,
    lineHeight: 22,
  },
  downloadTaskMeta: {
    color: colors.text.secondary,
    fontSize: fontSize.xs,
  },
  downloadTaskPercent: {
    color: '#0F766E',
    fontSize: fontSize.sm,
    fontWeight: fontWeight.bold,
  },
  downloadProgressTrack: {
    width: '100%',
    height: 8,
    borderRadius: borderRadius.full,
    backgroundColor: '#E2E8F0',
    overflow: 'hidden',
  },
  downloadProgressFill: {
    height: '100%',
    borderRadius: borderRadius.full,
    backgroundColor: '#14B8A6',
  },
  downloadTaskStatsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
  },
  downloadTaskStatsText: {
    color: colors.text.secondary,
    fontSize: fontSize.xs,
  },
  downloadTaskError: {
    color: '#B91C1C',
    fontSize: fontSize.xs,
    lineHeight: 18,
  },
  downloadTaskActionRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
  downloadTaskPrimaryBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    minHeight: 38,
    paddingHorizontal: spacing.md,
    borderRadius: borderRadius.xl,
    backgroundColor: colors.primary,
  },
  downloadTaskPrimaryBtnText: {
    color: '#FFFFFF',
    fontSize: fontSize.sm,
    fontWeight: fontWeight.bold,
  },
  downloadTaskSecondaryBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    minHeight: 38,
    paddingHorizontal: spacing.md,
    borderRadius: borderRadius.xl,
    borderWidth: 1,
    borderColor: '#99F6E4',
    backgroundColor: '#F0FDFA',
  },
  downloadTaskSecondaryBtnText: {
    color: '#0F766E',
    fontSize: fontSize.sm,
    fontWeight: fontWeight.bold,
  },
  downloadTaskDangerBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    minHeight: 38,
    paddingHorizontal: spacing.md,
    borderRadius: borderRadius.xl,
    borderWidth: 1,
    borderColor: '#FECACA',
    backgroundColor: '#FEF2F2',
  },
  downloadTaskDangerBtnText: {
    color: '#B91C1C',
    fontSize: fontSize.sm,
    fontWeight: fontWeight.bold,
  },
  sourceBindingScrollContent: {
    gap: spacing.md,
    paddingBottom: spacing.xl,
  },
  sourceBindingCard: {
    gap: spacing.sm,
    borderRadius: borderRadius.xxl,
    borderWidth: 1,
    borderColor: colors.border.light,
    backgroundColor: colors.surface,
    padding: spacing.md,
  },
  sourceBindingTitle: {
    color: colors.text.primary,
    fontSize: fontSize.base,
    fontWeight: fontWeight.bold,
  },
  sourceBindingHint: {
    color: colors.text.secondary,
    fontSize: fontSize.sm,
    lineHeight: 20,
  },
  sourceBindingInput: {
    minHeight: 46,
    borderRadius: borderRadius.lg,
    borderWidth: 1,
    borderColor: colors.border.light,
    backgroundColor: '#F8FAFC',
    paddingHorizontal: spacing.md,
    color: colors.text.primary,
    fontSize: fontSize.sm,
  },
  sourceBindingActionRow: {
    flexDirection: 'row',
    gap: spacing.sm,
    alignItems: 'center',
  },
  sourceBindingActionSpacer: {
    flex: 1,
  },
  sourceBindingPrimaryBtn: {
    minHeight: 42,
    borderRadius: borderRadius.xl,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.md,
  },
  sourceBindingPrimaryBtnText: {
    color: '#FFFFFF',
    fontSize: fontSize.sm,
    fontWeight: fontWeight.bold,
  },
  sourceBindingSecondaryBtn: {
    minHeight: 42,
    borderRadius: borderRadius.xl,
    borderWidth: 1,
    borderColor: '#BFDBFE',
    backgroundColor: '#EFF6FF',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.md,
  },
  sourceBindingSecondaryBtnText: {
    color: '#2563EB',
    fontSize: fontSize.sm,
    fontWeight: fontWeight.bold,
  },
  videoAiPickerCard: {
    flexDirection: 'row',
    gap: spacing.md,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border.light,
    borderRadius: borderRadius.xxl,
    padding: spacing.md,
    marginBottom: spacing.sm,
  },
  toast: {
    position: 'absolute',
    left: spacing.lg,
    right: spacing.lg,
    bottom: 112,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: borderRadius.xl,
    backgroundColor: 'rgba(15,23,42,0.92)',
    alignItems: 'center',
  },
  toastText: {
    color: '#FFFFFF',
    fontSize: fontSize.sm,
    fontWeight: fontWeight.medium,
  },
});
