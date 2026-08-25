/**
 * SummaryCard · 今日 / 本周数字汇总
 *
 * 显示 3 行:看视频 / 听音频 / 跟读
 * 接收汇总后的 DailyStats,内部用 formatLong/formatCount 显示
 */

import { memo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { colors, spacing, fontSize } from '../../constants/theme';
import { formatLong, formatCount } from '../../lib/stats/format';
import type { DailyStats } from '../../lib/stats/storage';

interface Props {
  title: string;
  stats: DailyStats | null;
}

function SummaryCardInner({ title, stats }: Props) {
  const foregroundMs = stats?.foregroundMs ?? 0;
  const backgroundMs = stats?.backgroundMs ?? 0;
  const shadowingCount = stats?.shadowingCount ?? 0;

  return (
    <View style={styles.card}>
      <Text style={styles.title}>{title}</Text>
      <View style={styles.row}>
        <Text style={styles.label}>看视频</Text>
        <Text style={styles.value}>{formatLong(foregroundMs)}</Text>
      </View>
      <View style={styles.row}>
        <Text style={styles.label}>听音频</Text>
        <Text style={styles.value}>{formatLong(backgroundMs)}</Text>
      </View>
      <View style={styles.row}>
        <Text style={styles.label}>跟读</Text>
        <Text style={styles.value}>{formatCount(shadowingCount)}</Text>
      </View>
    </View>
  );
}

export const SummaryCard = memo(SummaryCardInner);

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.surface,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.surfaceSecondary,
    padding: 14,
    marginBottom: 12,
  },
  title: {
    fontSize: 12,
    color: colors.text.tertiary,
    fontWeight: '500',
    letterSpacing: 0.05,
    marginBottom: 8,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 4,
  },
  label: {
    fontSize: 14,
    color: colors.text.secondary,
  },
  value: {
    fontSize: 14,
    color: colors.text.primary,
    fontWeight: '500',
  },
});
