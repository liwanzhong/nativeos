/**
 * Buy Pro Bottom Sheet
 *
 * 容器 — 2 个 tab:
 *   - 联系作者 (默认): QR + 4 步购买指南
 *   - 兑换码: 表单 (port 自 /redeem 页面)
 *
 * 父级 (membership.tsx) 控 visible / onClose
 * 打开时重置到 defaultTab — 防止用户上次停留在 "兑换码" 标签, 这次打开看到表单空白
 *
 * 用 RN 自带 Modal (slide animation) — 不引入 @gorhom/bottom-sheet
 * 避免新 dep + native module rebuild (上次已知: ali-oss 在 RN 0.83 跑不动)
 * 牺牲 swipe-to-dismiss 体验 (但安卓有 system back 可以关, 不算硬伤)
 */

import React, { useEffect, useState } from 'react';
import {
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { X } from 'lucide-react-native';
import {
  borderRadius,
  colors,
  fontSize,
  fontWeight,
  spacing,
} from '../../constants/theme';
import { RedeemPanel } from './RedeemPanel';
import { UpgradeQrPanel } from './UpgradeQrPanel';

type Tab = 'contact' | 'redeem';

export type UpgradeSheetProps = {
  visible: boolean;
  onClose: () => void;
  /**
   * 默认打开哪个 tab. Free 用户默认 contact (先看见 QR)
   * Pro 用户想延期可以传 'redeem'.
   */
  defaultTab?: Tab;
};

export function UpgradeSheet({
  visible,
  onClose,
  defaultTab = 'contact',
}: UpgradeSheetProps) {
  const [tab, setTab] = useState<Tab>(defaultTab);

  // 每次打开都重置回 defaultTab — 防止上次停留在 redeem
  // 这次打开还是 redeem 看到上次残留的输入框
  useEffect(() => {
    if (visible) {
      setTab(defaultTab);
    }
  }, [visible, defaultTab]);

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onClose}
      statusBarTranslucent
    >
      <View style={styles.backdrop}>
        <Pressable style={styles.backdropPress} onPress={onClose} />
        <SafeAreaView edges={['bottom']} style={styles.sheet}>
          <View style={styles.handle} />

          <View style={styles.header}>
            <Text style={styles.title}>升级 Pro</Text>
            <Pressable hitSlop={10} onPress={onClose} style={styles.closeBtn}>
              <X size={20} color="#5A5A5A" />
            </Pressable>
          </View>

          <View style={styles.tabs}>
            <TabButton
              label="联系作者"
              active={tab === 'contact'}
              onPress={() => setTab('contact')}
            />
            <TabButton
              label="兑换码"
              active={tab === 'redeem'}
              onPress={() => setTab('redeem')}
            />
          </View>

          <View style={styles.body}>
            {tab === 'contact' ? (
              <UpgradeQrPanel />
            ) : (
              <RedeemPanel onSuccess={onClose} />
            )}
          </View>
        </SafeAreaView>
      </View>
    </Modal>
  );
}

function TabButton({
  label,
  active,
  onPress,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      style={[styles.tab, active && styles.tabActive]}
      onPress={onPress}
    >
      <Text style={[styles.tabText, active && styles.tabTextActive]}>
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.45)',
    justifyContent: 'flex-end',
  },
  backdropPress: {
    flex: 1,
  },
  sheet: {
    backgroundColor: colors.background,
    borderTopLeftRadius: borderRadius.xl,
    borderTopRightRadius: borderRadius.xl,
    paddingTop: 8,
    maxHeight: '88%',
  },
  handle: {
    alignSelf: 'center',
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: '#D0D0D0',
    marginBottom: 8,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
    paddingBottom: 12,
  },
  title: {
    fontSize: fontSize.lg,
    fontWeight: fontWeight.semibold,
    color: colors.text.primary,
  },
  closeBtn: {
    padding: 4,
  },
  tabs: {
    flexDirection: 'row',
    marginHorizontal: spacing.lg,
    backgroundColor: colors.surfaceSecondary,
    borderRadius: borderRadius.md,
    padding: 3,
    marginBottom: spacing.md,
  },
  tab: {
    flex: 1,
    paddingVertical: 8,
    borderRadius: borderRadius.sm,
    alignItems: 'center',
  },
  tabActive: {
    backgroundColor: colors.surface,
    shadowColor: '#000000',
    shadowOpacity: 0.06,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 1 },
    elevation: 1,
  },
  tabText: {
    fontSize: fontSize.sm,
    color: colors.text.secondary,
    fontWeight: fontWeight.medium,
  },
  tabTextActive: {
    color: colors.text.primary,
    fontWeight: fontWeight.semibold,
  },
  body: {
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.lg,
  },
});
