/**
 * VideoStatsList · 统计页底部"按视频"列表
 *
 * 数据源:getAllVideoStats()(本地 AsyncStorage)
 * 排序:按 (foregroundMs + backgroundMs) 倒序
 * 点击行:跳到对应单视频页(/scenario/video/{id})
 * 0 数据视频不显示
 */

import { memo, useCallback, useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { ChevronRight } from 'lucide-react-native';
import { colors, spacing, fontSize } from '../../constants/theme';
import { getAllVideoStats, type VideoStats } from '../../lib/stats';
import { formatShort, formatCount } from '../../lib/stats/format';

function VideoStatsListInner() {
  const router = useRouter();
  const [items, setItems] = useState<VideoStats[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getAllVideoStats().then((all) => {
      if (cancelled) return;
      const sorted = [...all]
        .filter((s) => s.foregroundMs + s.backgroundMs + s.shadowingCount > 0)
        .sort((a, b) => b.foregroundMs + b.backgroundMs - (a.foregroundMs + a.backgroundMs));
      setItems(sorted);
      setLoaded(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const handlePress = useCallback(
    (videoId: string) => {
      router.push(`/scenario/video/${encodeURIComponent(videoId)}`);
    },
    [router]
  );

  if (!loaded) {
    return null;
  }

  if (items.length === 0) {
    return (
      <View style={styles.emptyWrap}>
        <Text style={styles.emptyText}>还没有数据</Text>
      </View>
    );
  }

  return (
    <View>
      <View style={styles.headerRow}>
        <Text style={styles.headerTitle}>按视频</Text>
        <Text style={styles.headerHint}>按总时长排序</Text>
      </View>
      <View style={styles.list}>
        {items.map((s) => {
          const total = s.foregroundMs + s.backgroundMs;
          const parts: string[] = [];
          if (s.foregroundMs > 0) parts.push(`看 ${formatShort(s.foregroundMs)}`);
          if (s.backgroundMs > 0) parts.push(`听 ${formatShort(s.backgroundMs)}`);
          if (s.shadowingCount > 0) parts.push(`跟读 ${formatCount(s.shadowingCount)}`);
          return (
            <Pressable
              key={s.videoId}
              style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
              onPress={() => handlePress(s.videoId)}
            >
              <View style={styles.rowBody}>
                <Text style={styles.rowTitle} numberOfLines={1}>
                  {s.videoId}
                </Text>
                <Text style={styles.rowMeta} numberOfLines={1}>
                  {parts.join(' · ') || '—'}
                </Text>
              </View>
              <Text style={styles.rowTotal}>{formatShort(total)}</Text>
              <ChevronRight size={16} color={colors.text.tertiary} />
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

export const VideoStatsList = memo(VideoStatsListInner);

const styles = StyleSheet.create({
  emptyWrap: {
    paddingVertical: 32,
    alignItems: 'center',
  },
  emptyText: {
    fontSize: fontSize.sm,
    color: colors.text.tertiary,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 8,
  },
  headerTitle: {
    fontSize: fontSize.base,
    fontWeight: '600',
    color: colors.text.primary,
  },
  headerHint: {
    fontSize: 12,
    color: colors.text.tertiary,
  },
  list: {
    backgroundColor: colors.surface,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.surfaceSecondary,
    overflow: 'hidden',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.surfaceSecondary,
    gap: 8,
  },
  rowPressed: {
    opacity: 0.5,
  },
  rowBody: {
    flex: 1,
    minWidth: 0,
  },
  rowTitle: {
    fontSize: 14,
    fontWeight: '500',
    color: colors.text.primary,
  },
  rowMeta: {
    fontSize: 11,
    color: colors.text.secondary,
    marginTop: 2,
  },
  rowTotal: {
    fontSize: 13,
    color: colors.text.secondary,
    fontWeight: '500',
  },
});
