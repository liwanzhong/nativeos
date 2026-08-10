/**
 * RestoreStrategySheet — modal sheet asking the user how to merge a
 * picked backup into the current app state.
 *
 * In v1 only "overwrite" is implemented. "merge" is shown but disabled
 * (Q5) so the user can see it exists and why it's unavailable.
 *
 *   ┌─ handle bar ─────────────────┐
 *   │ 恢复数据                       │
 *   │ 选择合并方式（建议先看清楚）     │
 *   │                                │
 *   │ ● 完全覆盖  ← 默认              │
 *   │   清空当前数据，替换为备份       │
 *   │   推荐 · 恢复前自动备份 7 天     │
 *   │                                │
 *   │ ○ 合并（实现中）                 │
 *   │   保留两边数据                  │
 *   │   v2 规划中                    │
 *   │                                │
 *   │ [       下一步           ]      │
 *   └────────────────────────────────┘
 */

import React, { useState } from 'react';
import {
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { X } from 'lucide-react-native';
import { borderRadius, colors, fontSize, fontWeight, spacing } from '../../../../constants/theme';
import type { RestoreStrategy } from '../../../../lib/backup/types';

interface Props {
  visible: boolean;
  onClose: () => void;
  onConfirm: (strategy: RestoreStrategy) => void;
}

export function RestoreStrategySheet({ visible, onClose, onConfirm }: Props) {
  const insets = useSafeAreaInsets();
  const [strategy, setStrategy] = useState<RestoreStrategy>('overwrite');

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onClose}
      statusBarTranslucent
    >
      <View style={styles.backdrop}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} />
        <View style={[styles.sheet, { paddingBottom: insets.bottom + spacing.lg }]}>
          <View style={styles.handle} />
          <View style={styles.headerRow}>
            <Text style={styles.title}>恢复数据</Text>
            <Pressable onPress={onClose} hitSlop={12} style={styles.closeBtn}>
              <X size={20} color={colors.text.secondary} />
            </Pressable>
          </View>
          <Text style={styles.subtitle}>
            请选择合并方式。建议先在「我的」→「设置」→「退出登录」之外，确保已理解后果。
          </Text>

          <Pressable
            style={({ pressed }) => [
              styles.optionRow,
              strategy === 'overwrite' && styles.optionRowActive,
              pressed && { opacity: 0.85 },
            ]}
            onPress={() => setStrategy('overwrite')}
          >
            <View style={[styles.radio, strategy === 'overwrite' && styles.radioOn]} />
            <View style={styles.optionText}>
              <View style={styles.optionTitleRow}>
                <Text style={styles.optionTitle}>完全覆盖</Text>
                <View style={styles.recommendPill}>
                  <Text style={styles.recommendPillText}>推荐</Text>
                </View>
              </View>
              <Text style={styles.optionDesc}>
                清空当前数据，替换为备份。恢复前会自动备份当前状态，可在 7 天内回滚。
              </Text>
            </View>
          </Pressable>

          <Pressable
            style={({ pressed }) => [
              styles.optionRow,
              styles.optionRowDisabled,
              pressed && { opacity: 0.85 },
            ]}
            disabled
          >
            <View style={[styles.radio, styles.radioDisabled]} />
            <View style={styles.optionText}>
              <View style={styles.optionTitleRow}>
                <Text style={[styles.optionTitle, styles.optionTitleDisabled]}>合并</Text>
                <View style={styles.disabledPill}>
                  <Text style={styles.disabledPillText}>实现中</Text>
                </View>
              </View>
              <Text style={styles.optionDesc}>
                保留两边数据。涉及冲突解决规则，二期再开放。
              </Text>
            </View>
          </Pressable>

          <View style={styles.footer}>
            <Pressable
              style={({ pressed }) => [styles.nextBtn, pressed && styles.nextBtnPressed]}
              onPress={() => onConfirm(strategy)}
            >
              <Text style={styles.nextBtnText}>下一步</Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.45)',
    justifyContent: 'flex-end',
  },
  sheet: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
  },
  handle: {
    width: 36, height: 4, borderRadius: 2,
    backgroundColor: colors.border.light,
    alignSelf: 'center',
    marginBottom: spacing.sm,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 2,
  },
  title: {
    fontSize: fontSize.lg,
    fontWeight: fontWeight.bold,
    color: colors.text.primary,
  },
  closeBtn: {
    width: 32, height: 32,
    alignItems: 'center', justifyContent: 'center',
    borderRadius: borderRadius.full,
  },
  subtitle: {
    fontSize: fontSize.xs,
    color: colors.text.secondary,
    marginBottom: spacing.md,
  },
  optionRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    padding: spacing.md,
    backgroundColor: colors.surfaceSecondary,
    borderRadius: borderRadius.lg,
    borderWidth: 1.5,
    borderColor: 'transparent',
    marginBottom: spacing.sm,
    gap: spacing.md,
  },
  optionRowActive: {
    borderColor: colors.primary,
    backgroundColor: colors.surface,
  },
  optionRowDisabled: {
    opacity: 0.6,
  },
  radio: {
    width: 22, height: 22,
    borderRadius: 11,
    borderWidth: 2,
    borderColor: colors.text.tertiary,
    marginTop: 2,
  },
  radioOn: {
    borderColor: colors.primary,
    backgroundColor: colors.primary,
  },
  radioDisabled: {
    borderColor: colors.text.tertiary,
  },
  optionText: { flex: 1 },
  optionTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginBottom: 4,
  },
  optionTitle: {
    fontSize: fontSize.sm,
    fontWeight: fontWeight.bold,
    color: colors.text.primary,
  },
  optionTitleDisabled: {
    color: colors.text.tertiary,
  },
  optionDesc: {
    fontSize: fontSize.xs,
    color: colors.text.secondary,
    lineHeight: 18,
  },
  recommendPill: {
    backgroundColor: colors.primary,
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 10,
  },
  recommendPillText: {
    fontSize: 10,
    color: '#fff',
    fontWeight: '600',
  },
  disabledPill: {
    backgroundColor: colors.surfaceSecondary,
    borderWidth: 1,
    borderColor: colors.border.light,
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 10,
  },
  disabledPillText: {
    fontSize: 10,
    color: colors.text.secondary,
    fontWeight: '500',
  },
  footer: {
    paddingTop: spacing.md,
  },
  nextBtn: {
    backgroundColor: colors.primary,
    paddingVertical: spacing.md,
    borderRadius: borderRadius.xl,
    alignItems: 'center',
  },
  nextBtnPressed: { opacity: 0.92 },
  nextBtnText: {
    color: '#fff',
    fontSize: fontSize.sm,
    fontWeight: fontWeight.bold,
  },
});
