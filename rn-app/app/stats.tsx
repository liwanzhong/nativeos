/**
 * /stats — 统计页(完整)
 *
 * 结构(自上而下):
 *   1. 顶部导航(返回 + 标题)
 *   2. 30 天柱状图
 *   3. 今日汇总
 *   4. 本周汇总
 *   5. 按视频列表
 *
 * 数据源:全部从 lib/stats 本地 AsyncStorage 读
 * 加载时机:useFocusEffect(每次进页面刷新)
 */

import { useCallback, useMemo, useState } from 'react';
import { useRouter } from 'expo-router';
import {
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ArrowLeft } from 'lucide-react-native';
import { colors, spacing, fontSize } from '../constants/theme';
import { useFocusEffect } from 'expo-router';
import { forceFlush, getAllVideoStats, getDailyStats } from '../lib/stats';
import { formatLong, formatCount } from '../lib/stats/format';
import type { DailyStats, VideoStats } from '../lib/stats/storage';
import { Recent30DaysBarChart } from '../components/stats/Recent30DaysBarChart';
import { SummaryCard } from '../components/stats/SummaryCard';
import { VideoStatsList } from '../components/stats/VideoStatsList';

// ── 日期工具 ──────────────────────────────────────
function todayStr(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function daysAgoStr(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function aggregate(rows: DailyStats[]): DailyStats {
  return rows.reduce<DailyStats>(
    (acc, r) => ({
      date: r.date,
      foregroundMs: acc.foregroundMs + r.foregroundMs,
      backgroundMs: acc.backgroundMs + r.backgroundMs,
      shadowingCount: acc.shadowingCount + r.shadowingCount,
    }),
    { date: '', foregroundMs: 0, backgroundMs: 0, shadowingCount: 0 }
  );
}

export default function StatsScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const [days, setDays] = useState<DailyStats[]>([]);
  const [allVideos, setAllVideos] = useState<VideoStats[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  // 触发 VideoStatsList 重新拉数据
  const [videoListKey, setVideoListKey] = useState(0);

  const today = useMemo(() => todayStr(), []);
  const weekAgo = useMemo(() => daysAgoStr(6), []); // 包含今天共 7 天
  const monthAgo = useMemo(() => daysAgoStr(29), []); // 包含今天共 30 天

  const load = useCallback(async () => {
    console.log('[stats/page] load START today=', today, 'weekAgo=', weekAgo, 'monthAgo=', monthAgo);
    setRefreshing(true);
    try {
      // 先 flush buffer,确保拿到最新数据
      await forceFlush();
      const [rows, videos] = await Promise.all([
        getDailyStats(monthAgo, today),
        getAllVideoStats(),
      ]);
      const todayRow = rows.find((d) => d.date === today);
      const last7 = rows.slice(-7);
      const weekFg = last7.reduce((s, r) => s + r.foregroundMs, 0);
      const weekBg = last7.reduce((s, r) => s + r.backgroundMs, 0);
      const monthFg = rows.reduce((s, r) => s + r.foregroundMs, 0);
      const monthBg = rows.reduce((s, r) => s + r.backgroundMs, 0);
      console.log(
        `[stats/page] load RESULT today={fg=${todayRow?.foregroundMs}ms bg=${todayRow?.backgroundMs}ms sh=${todayRow?.shadowingCount}} week={fg=${weekFg}ms bg=${weekBg}ms} month={fg=${monthFg}ms bg=${monthBg}ms}`
      );
      setDays(rows);
      setAllVideos(videos);
      setVideoListKey((k) => k + 1);
    } finally {
      setRefreshing(false);
    }
  }, [monthAgo, today, weekAgo]);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load])
  );

  // 今日 / 本周 聚合
  const todayRow = useMemo(
    () => days.find((d) => d.date === today) ?? { date: today, foregroundMs: 0, backgroundMs: 0, shadowingCount: 0 },
    [days, today]
  );
  const weekRow = useMemo(() => {
    // 30 天里的最后 7 天 = 本周
    const last7 = days.slice(-7);
    return aggregate(last7);
  }, [days]);

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <Pressable style={styles.backBtn} onPress={() => router.back()} hitSlop={8}>
          <ArrowLeft size={22} color={colors.text.primary} />
        </Pressable>
        <Text style={styles.headerTitle}>统计</Text>
        <View style={styles.backBtn} />
      </View>

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={[styles.scrollContent, { paddingBottom: insets.bottom + 32 }]}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={load} />}
      >
        <View style={styles.section}>
          <Recent30DaysBarChart days={days} />
        </View>

        <View style={styles.section}>
          <SummaryCard title="今日" stats={todayRow} />
          <SummaryCard title="本周" stats={weekRow} />
        </View>

        <View style={styles.section}>
          {/* 用 key 触发 VideoStatsList 重新挂载刷新数据 */}
          <VideoStatsList key={videoListKey} />
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
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.surfaceSecondary,
  },
  backBtn: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerTitle: {
    fontSize: fontSize.base,
    fontWeight: '600',
    color: colors.text.primary,
  },
  scroll: {
    flex: 1,
  },
  scrollContent: {
    paddingHorizontal: spacing.md,
    paddingTop: spacing.md,
    // ⭐ 关键:Android 上 ScrollView contentContainer 默认 alignItems: flex-start,
    // 子 View 的 inline width(如 chartArea: width: 360)不会被撑开。
    // 加 stretch 后子 View 才能按 inline width 渲染。
    alignItems: 'stretch',
  },
  section: {
    marginBottom: spacing.lg,
  },
});
