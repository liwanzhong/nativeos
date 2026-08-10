/**
 * Tab 1: 联系作者
 *
 * 用户扫码后, 在微信里跟作者沟通购买
 * - 头部: 头像(同 contact-author 页) + QR 大图
 * - 中部: 作者名 + 地区
 * - 4 步购买指南
 * - 底部: 礼貌 tip
 *
 * 故意不放价格/套餐, 只描述"怎么买到兑换码"的流程
 * (用户红线: NO pricing/plans grid, NO 立即升级 hard-sell)
 */

import React from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import {
  AUTHOR_APP_NAME,
  AUTHOR_NAME,
  AUTHOR_REGION,
  PURCHASE_STEPS,
} from '../../constants/membership';
import {
  borderRadius,
  colors,
  fontSize,
  fontWeight,
  spacing,
} from '../../constants/theme';
import { AuthorQR } from './AuthorQR';

export function UpgradeQrPanel() {
  return (
    <ScrollView
      showsVerticalScrollIndicator={false}
      contentContainerStyle={styles.scroll}
    >
      <Text style={styles.appName}>{AUTHOR_APP_NAME}</Text>

      <View style={styles.qrRow}>
        <AuthorQR size={200} />
      </View>

      <View style={styles.authorBlock}>
        <Text style={styles.authorName}>{AUTHOR_NAME}</Text>
        <Text style={styles.authorMeta}>NativeOS 作者 · {AUTHOR_REGION}</Text>
      </View>

      <View style={styles.stepsCard}>
        <Text style={styles.stepsTitle}>购买步骤</Text>
        {PURCHASE_STEPS.map((step, idx) => (
          <View key={idx} style={styles.stepRow}>
            <View style={styles.stepNum}>
              <Text style={styles.stepNumText}>{idx + 1}</Text>
            </View>
            <Text style={styles.stepText}>{step}</Text>
          </View>
        ))}
      </View>

      <Text style={styles.tip}>
        如有问题，扫码后可先发个 "Pro" 测试，收到回复即表示作者在线
      </Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scroll: {
    paddingBottom: spacing.xl,
    alignItems: 'stretch',
  },
  appName: {
    fontSize: fontSize.lg,
    fontWeight: fontWeight.semibold,
    color: colors.text.primary,
    textAlign: 'center',
    marginBottom: spacing.md,
  },
  qrRow: {
    alignItems: 'center',
    paddingVertical: spacing.sm,
  },
  authorBlock: {
    alignItems: 'center',
    marginTop: spacing.sm,
    marginBottom: spacing.md,
  },
  authorName: {
    fontSize: fontSize.lg,
    fontWeight: fontWeight.semibold,
    color: colors.text.primary,
  },
  authorMeta: {
    fontSize: fontSize.sm,
    color: colors.text.secondary,
    marginTop: 2,
  },
  stepsCard: {
    backgroundColor: colors.surface,
    borderRadius: borderRadius.lg,
    borderWidth: 1,
    borderColor: colors.border.light,
    padding: spacing.md,
    gap: 10,
  },
  stepsTitle: {
    fontSize: fontSize.sm,
    fontWeight: fontWeight.semibold,
    color: colors.text.primary,
    marginBottom: spacing.xs,
  },
  stepRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm + 2,
  },
  stepNum: {
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 1,
  },
  stepNumText: {
    color: '#FFFFFF',
    fontSize: fontSize.xs,
    fontWeight: fontWeight.semibold,
  },
  stepText: {
    flex: 1,
    fontSize: fontSize.sm,
    color: colors.text.primary,
    lineHeight: 20,
  },
  tip: {
    fontSize: fontSize.xs,
    color: colors.text.tertiary,
    lineHeight: 18,
    textAlign: 'center',
    paddingHorizontal: spacing.md,
    marginTop: spacing.md,
  },
});
