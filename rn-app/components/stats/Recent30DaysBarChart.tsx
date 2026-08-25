/**
 * Recent30DaysBarChart · 30 天每日总时长柱状图
 *
 * 极简 flexbox 实现,完全不依赖 position: absolute:
 *   - chartArea: width 100% × height 120, flexDirection: row, alignItems: flex-end
 *   - 柱子: 固定 width 8, height = ratio × 120, 贴底
 *   - 网格: View 横向条,dashed border (cross-platform)
 *   - baseline: View 1.5px 实线,贴底
 *
 * 之前的问题: 父容器宽度没撑开 → chartArea width=0 → 柱子 0 宽 → 不可见
 * 修法: chartArea 用 width: '100%' + ScrollView contentContainer alignItems: stretch
 */

import { memo, useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { colors, fontSize } from '../../constants/theme';
import { formatShort } from '../../lib/stats/format';
import type { DailyStats } from '../../lib/stats/storage';

interface Props {
  days: DailyStats[];
  todayIndex?: number;
  barWidth?: number;
  barGap?: number;
}

const CHART_HEIGHT = 120;
const BASELINE_COLOR = '#94A3B8';
const GRID_COLOR = '#E2E8F0';
// 0 数据柱子的颜色:必须比背景 #F0F0F0 浅灰更深,否则看不见
// 之前用 #CBD5E1 + opacity 0.5 在浅灰背景上几乎透明,以为是 RN flex bug
const SKELETON_COLOR = '#94A3B8';
const ACCENT = '#c97b3f';
const DEFAULT_BAR = '#2f6f5e';
const TICK_HEIGHT = 2;

function Recent30DaysBarChartInner({
  days,
  todayIndex,
  // 6+4=10px,30 根 = 300px 可放进 chartArea 304px 宽容器
  // 之前 8+4=12px × 30 = 360px 撑爆 304px,今天柱子在 i=29 溢出右边
  barWidth = 6,
  barGap = 4,
}: Props) {
  const { maxValue, total } = useMemo(() => {
    let mx = 0;
    let sum = 0;
    for (const d of days) {
      const t = d.foregroundMs + d.backgroundMs;
      if (t > mx) mx = t;
      sum += t;
    }
    if (mx === 0) mx = 60_000;
    return { maxValue: mx, total: sum };
  }, [days]);

  const today = todayIndex ?? (days.length > 0 ? days.length - 1 : 0);
  const barAreaHeight = CHART_HEIGHT - 1;

  return (
    <View style={styles.container}>
      <View style={styles.headerRow}>
        <Text style={styles.eyebrow}>最近 30 天</Text>
        <Text style={styles.totalText}>共 {formatShort(total)}</Text>
      </View>

      {/* chartArea: 100% 宽撑满父容器,固定 120 高 */}
      <View style={styles.chartArea}>
        {/* 网格虚线 1/3 高度 */}
        <View
          pointerEvents="none"
          style={[styles.gridLine, { top: CHART_HEIGHT * 1 / 3 }]}
        />
        {/* 网格虚线 2/3 高度 */}
        <View
          pointerEvents="none"
          style={[styles.gridLine, { top: CHART_HEIGHT * 2 / 3 }]}
        />
        {/* baseline 1.5px 实线,贴底 */}
        <View
          pointerEvents="none"
          style={[styles.baseline, { bottom: 0 }]}
        />

        {/* 30 根柱子(纯 flex row,alignItems: flex-end 让所有柱子自动贴底) */}
        {days.map((d, i) => {
          const t = d.foregroundMs + d.backgroundMs;
          const isToday = i === today;
          if (t === 0) {
            return (
              <View
                key={d.date}
                style={{
                  width: barWidth,
                  height: TICK_HEIGHT,
                  marginRight: barGap,
                  backgroundColor: SKELETON_COLOR,
                }}
              />
            );
          }
          const ratio = t / maxValue;
          const h = ratio * barAreaHeight;
          return (
            <View
              key={d.date}
              style={{
                width: barWidth,
                height: h,
                marginRight: barGap,
                backgroundColor: isToday ? ACCENT : DEFAULT_BAR,
                borderRadius: 2,
              }}
            />
          );
        })}
      </View>

      <View style={styles.xAxisRow}>
        <Text style={styles.xAxisText}>{formatAxisDate(days[0]?.date)}</Text>
        <Text style={styles.xAxisText}>今天</Text>
      </View>
    </View>
  );
}

function formatAxisDate(s: string | undefined): string {
  if (!s) return '';
  const [, m, d] = s.split('-');
  return `${Number(m)}/${Number(d)}`;
}

export const Recent30DaysBarChart = memo(Recent30DaysBarChartInner);

const styles = StyleSheet.create({
  container: {
    paddingVertical: 8,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 8,
  },
  eyebrow: {
    fontSize: 12,
    color: colors.text.tertiary,
    fontWeight: '500',
    letterSpacing: 0.05,
  },
  totalText: {
    fontSize: 12,
    color: colors.text.secondary,
  },
  chartArea: {
    width: '100%',         // 撑满父容器(ScrollView contentContainer stretch)
    height: CHART_HEIGHT,
    flexDirection: 'row',
    alignItems: 'flex-end', // 子元素贴底
  },
  baseline: {
    position: 'absolute',
    left: 0,
    right: 0,
    height: 1.5,
    backgroundColor: BASELINE_COLOR,
  },
  gridLine: {
    position: 'absolute',
    left: 0,
    right: 0,
    height: 0,
    borderTopWidth: 1,
    borderColor: GRID_COLOR,
    borderStyle: 'dashed',
  },
  xAxisRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 4,
  },
  xAxisText: {
    fontSize: 10,
    color: colors.text.tertiary,
  },
});
