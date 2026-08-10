/**
 * Free vs Pro 5 行权益对照表 + 底部 CTA
 *
 * 5 行 (能砍的字段先砍):
 *   AI 对话 / 语音识别 / 语音朗读 / 视频字幕 / 自带 API Key
 *
 * 底部 CTA 是「会员权益」模块的出口 — 看完权益就该升级/延期
 * 不再单独占一栏的「兑换」section, 视觉上把权益和入口绑成一个整体
 */

import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { ChevronRight, Ticket } from 'lucide-react-native';
import {
  borderRadius,
  colors,
  fontSize,
  fontWeight,
  spacing,
} from '../../constants/theme';
import { BENEFIT_ROWS } from '../../constants/membership';

const VALUE_COL_WIDTH = 92;

export type BenefitComparisonProps = {
  /** CTA 按钮点击 — 父级打开 UpgradeSheet */
  onUpgradePress: () => void;
  /**
   * CTA 标签: Free → 「升级 Pro 会员」, Pro → 「继续兑换 / 延期」
   * 父级根据 isPro 切换
   */
  ctaLabel: string;
  /**
   * CTA 副文案, 1 行说明. Free: 介绍流程. Pro: 鼓励叠加
   */
  ctaDesc: string;
};

export function BenefitComparison({
  onUpgradePress,
  ctaLabel,
  ctaDesc,
}: BenefitComparisonProps) {
  return (
    <View style={styles.container}>
      <View style={styles.headerRow}>
        <View style={styles.labelCol} />
        <Text style={[styles.headerText, styles.headerFree]}>免费</Text>
        <Text style={[styles.headerText, styles.headerPro]}>Pro</Text>
      </View>
      {BENEFIT_ROWS.map((row, idx) => (
        <View
          key={row.key}
          style={[styles.row, idx < BENEFIT_ROWS.length - 1 && styles.rowDivider]}
        >
          <Text style={styles.rowLabel}>{row.label}</Text>
          <Text style={styles.rowFree}>{row.free}</Text>
          <Text style={styles.rowPro}>{row.pro}</Text>
        </View>
      ))}

      <View style={styles.ctaDivider} />

      <Pressable
        style={({ pressed }) => [styles.cta, pressed && styles.ctaPressed]}
        onPress={onUpgradePress}
      >
        <View style={styles.ctaIcon}>
          <Ticket size={18} color="#FFFFFF" />
        </View>
        <View style={styles.ctaTextCol}>
          <Text style={styles.ctaTitle}>{ctaLabel}</Text>
          <Text style={styles.ctaDesc}>{ctaDesc}</Text>
        </View>
        <ChevronRight size={18} color="#FFFFFF" />
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: colors.surface,
    borderRadius: borderRadius.lg,
    borderWidth: 1,
    borderColor: colors.border.light,
    overflow: 'hidden',
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    backgroundColor: colors.surfaceSecondary,
  },
  labelCol: { flex: 1 },
  headerText: {
    width: VALUE_COL_WIDTH,
    textAlign: 'right',
    fontSize: fontSize.xs,
  },
  headerFree: {
    color: colors.text.secondary,
    fontWeight: fontWeight.medium,
  },
  headerPro: {
    color: colors.primary,
    fontWeight: fontWeight.semibold,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.md,
    paddingVertical: 10,
  },
  rowDivider: {
    borderBottomWidth: 1,
    borderBottomColor: colors.border.light,
  },
  rowLabel: {
    flex: 1,
    fontSize: fontSize.sm,
    color: colors.text.primary,
  },
  rowFree: {
    width: VALUE_COL_WIDTH,
    textAlign: 'right',
    fontSize: fontSize.sm,
    color: colors.text.secondary,
  },
  rowPro: {
    width: VALUE_COL_WIDTH,
    textAlign: 'right',
    fontSize: fontSize.sm,
    color: colors.text.primary,
    fontWeight: fontWeight.semibold,
  },
  ctaDivider: {
    height: 1,
    backgroundColor: colors.border.light,
  },
  cta: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#1A1A1A',
    paddingHorizontal: spacing.md,
    paddingVertical: 12,
    gap: spacing.sm + 4,
  },
  ctaPressed: {
    backgroundColor: '#000000',
  },
  ctaIcon: {
    width: 32,
    height: 32,
    borderRadius: 8,
    backgroundColor: 'rgba(255, 255, 255, 0.12)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  ctaTextCol: {
    flex: 1,
    minWidth: 0,
  },
  ctaTitle: {
    fontSize: fontSize.base,
    fontWeight: fontWeight.medium,
    color: '#FFFFFF',
  },
  ctaDesc: {
    fontSize: fontSize.xs,
    color: 'rgba(255, 255, 255, 0.65)',
    marginTop: 2,
    lineHeight: 16,
  },
});
