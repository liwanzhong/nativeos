import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { VideoView, useVideoPlayer } from 'expo-video';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  ChevronLeft,
  Maximize,
  Minimize,
  PauseCircle,
  PlayCircle,
  RotateCcw,
} from 'lucide-react-native';
import { colors, spacing, borderRadius, fontSize, fontWeight } from '../../../constants/theme';

function formatTime(seconds: number) {
  const s = Math.floor(seconds);
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${r.toString().padStart(2, '0')}`;
}

export default function AdhocVideoPlayer() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ streamUri: string; title: string; provider: string }>();

  const { streamUri, title, provider } = params;

  const [isFullscreen, setIsFullscreen] = useState(false);
  const [isReady, setIsReady] = useState(false);
  const [hasError, setHasError] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);

  const videoRef = useRef<InstanceType<typeof VideoView>>(null);

  const player = useVideoPlayer(
    streamUri
      ? {
          uri: streamUri,
          headers: provider === 'baidu_pan'
            ? { 'User-Agent': 'pan.baidu.com' }
            : undefined,
        }
      : null,
    (p) => {
      p.loop = false;
    },
  );

  useEffect(() => {
    const subscription = player.addListener('playingChange', (e) => {
      setIsPlaying(e.isPlaying);
    });
    return () => subscription.remove();
  }, [player]);

  useEffect(() => {
    const subscription = player.addListener('statusChange', (e) => {
      if (e.status === 'readyToPlay') {
        setIsReady(true);
        setDuration(player.duration ?? 0);
        player.play();
      }
      if (e.status === 'error') {
        setHasError(true);
      }
    });
    return () => subscription.remove();
  }, [player]);

  useEffect(() => {
    const interval = setInterval(() => {
      if (player.playing) {
        setCurrentTime(player.currentTime ?? 0);
        setDuration(player.duration ?? 0);
      }
    }, 500);
    return () => clearInterval(interval);
  }, [player]);

  const handlePlayPause = useCallback(() => {
    if (player.playing) {
      player.pause();
    } else {
      player.play();
    }
  }, [player]);

  const handleReplay = useCallback(() => {
    player.seekBy(-(player.currentTime ?? 0));
    player.play();
  }, [player]);

  const handleToggleFullscreen = useCallback(async () => {
    if (!videoRef.current) return;
    if (isFullscreen) {
      await videoRef.current.exitFullscreen();
    } else {
      await videoRef.current.enterFullscreen();
    }
    setIsFullscreen((v) => !v);
  }, [isFullscreen]);

  if (!streamUri) {
    return (
      <View style={[styles.container, styles.center]}>
        <Text style={styles.errorText}>无效的视频来源</Text>
        <Pressable style={styles.backBtnFallback} onPress={() => router.back()}>
          <Text style={styles.backBtnFallbackText}>返回</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <Pressable style={styles.backBtn} onPress={() => router.back()}>
          <ChevronLeft size={22} color={colors.text.primary} />
        </Pressable>
        <Text style={styles.headerTitle} numberOfLines={1}>{title || '视频播放'}</Text>
        <View style={{ width: 36 }} />
      </View>

      <View style={styles.playerWrapper}>
        <VideoView
          ref={videoRef}
          player={player}
          style={styles.video}
          contentFit="contain"
          nativeControls={false}
        />
        {!isReady && !hasError ? (
          <View style={styles.overlay}>
            <ActivityIndicator size="large" color="#FFFFFF" />
            <Text style={styles.overlayText}>加载中…</Text>
          </View>
        ) : null}
        {hasError ? (
          <View style={styles.overlay}>
            <Text style={styles.overlayError}>视频加载失败</Text>
            <Text style={styles.overlayErrorHint}>请检查网盘授权或网络连接</Text>
          </View>
        ) : null}
      </View>

      <View style={[styles.controls, { paddingBottom: insets.bottom + spacing.md }]}>
        <View style={styles.progressRow}>
          <Text style={styles.timeText}>{formatTime(currentTime)}</Text>
          <View style={styles.progressTrack}>
            <View
              style={[
                styles.progressFill,
                { width: duration > 0 ? `${(currentTime / duration) * 100}%` : '0%' },
              ]}
            />
          </View>
          <Text style={styles.timeText}>{formatTime(duration)}</Text>
        </View>

        <View style={styles.btnRow}>
          <Pressable style={styles.controlBtn} onPress={handleReplay}>
            <RotateCcw size={22} color={colors.text.primary} />
          </Pressable>

          <Pressable style={styles.playBtn} onPress={handlePlayPause} disabled={!isReady}>
            {isPlaying
              ? <PauseCircle size={52} color={colors.primary} />
              : <PlayCircle size={52} color={isReady ? colors.primary : colors.text.secondary} />}
          </Pressable>

          <Pressable style={styles.controlBtn} onPress={handleToggleFullscreen}>
            {isFullscreen
              ? <Minimize size={22} color={colors.text.primary} />
              : <Maximize size={22} color={colors.text.primary} />}
          </Pressable>
        </View>

        <Text style={styles.providerLabel}>
          {provider === 'baidu_pan' ? '百度网盘' : '云盘'}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0A0A0A',
  },
  center: {
    justifyContent: 'center',
    alignItems: 'center',
    gap: spacing.md,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    gap: spacing.sm,
  },
  backBtn: {
    width: 36,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: borderRadius.md,
  },
  headerTitle: {
    flex: 1,
    color: '#FFFFFF',
    fontSize: fontSize.base,
    fontWeight: fontWeight.bold,
    textAlign: 'center',
  },
  playerWrapper: {
    flex: 1,
    backgroundColor: '#000000',
    position: 'relative',
  },
  video: {
    flex: 1,
    width: '100%',
  },
  overlay: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: 'center',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: 'rgba(0,0,0,0.6)',
  },
  overlayText: {
    color: '#FFFFFF',
    fontSize: fontSize.sm,
  },
  overlayError: {
    color: '#FCA5A5',
    fontSize: fontSize.base,
    fontWeight: fontWeight.bold,
  },
  overlayErrorHint: {
    color: '#94A3B8',
    fontSize: fontSize.sm,
  },
  controls: {
    backgroundColor: '#111827',
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    gap: spacing.sm,
  },
  progressRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  timeText: {
    color: '#94A3B8',
    fontSize: fontSize.xs,
    fontWeight: fontWeight.medium,
    minWidth: 36,
    textAlign: 'center',
  },
  progressTrack: {
    flex: 1,
    height: 4,
    borderRadius: 2,
    backgroundColor: '#374151',
    overflow: 'hidden',
  },
  progressFill: {
    height: '100%',
    borderRadius: 2,
    backgroundColor: colors.primary,
  },
  btnRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.xl,
  },
  controlBtn: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  playBtn: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  providerLabel: {
    textAlign: 'center',
    color: '#4B5563',
    fontSize: fontSize.xs,
    fontWeight: fontWeight.medium,
  },
  errorText: {
    color: '#FCA5A5',
    fontSize: fontSize.base,
    fontWeight: fontWeight.bold,
  },
  backBtnFallback: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderRadius: borderRadius.xl,
    backgroundColor: colors.primary,
  },
  backBtnFallbackText: {
    color: '#FFFFFF',
    fontSize: fontSize.sm,
    fontWeight: fontWeight.bold,
  },
});
