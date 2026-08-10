/**
 * BackupProgressModal — shows the live progress of export or restore.
 *
 * Driven by BackupProgress / RestoreProgress. The same component handles
 * both because the shapes overlap (phase + current + message + bytes).
 *
 * Phases have friendly names:
 *   - export: scan / pack_db / copy_files / zip / share / done / error
 *   - restore: verify / auth / pull_pro / rollback / restore_db / restore_asyncstorage / restore_files / done / error
 *
 * On done, shows a "重启 app" hint for restore and a "已保存到 <path>"
 * hint for export. On error, shows the error message + dismiss.
 */

import React from 'react';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { CheckCircle2, X } from 'lucide-react-native';
import { borderRadius, colors, fontSize, fontWeight, spacing } from '../../../../constants/theme';
import type {
  BackupProgress,
  RestoreProgress,
} from '../../../../lib/backup/types';

export type AnyProgress = (BackupProgress | RestoreProgress) & {
  /** Optional footer text to render when done (e.g. restart hint). */
  doneHint?: string;
  /** Optional zip path to show when done. */
  zipPath?: string;
};

interface Props {
  visible: boolean;
  progress: AnyProgress | null;
  mode: 'export' | 'restore';
  onClose: () => void;
}

const PHASE_LABELS: Record<string, string> = {
  scan: '扫描中',
  pack_db: '打包数据库',
  copy_files: '复制文件',
  zip: '正在打包',
  share: '打开分享面板',
  verify: '校验备份',
  auth: '检查登录',
  pull_pro: '同步 Pro 状态',
  rollback: '建立回滚点',
  restore_db: '恢复数据库',
  restore_asyncstorage: '恢复设置',
  restore_files: '恢复文件',
  done: '完成',
  error: '出错了',
};

export function BackupProgressModal({ visible, progress, mode, onClose }: Props) {
  const insets = useSafeAreaInsets();
  const isDone = progress?.phase === 'done';
  const isError = progress?.phase === 'error';
  const phaseLabel = progress ? PHASE_LABELS[progress.phase] ?? progress.phase : '';
  const pct = progress ? Math.round((progress.current || 0) * 100) : 0;

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={isDone || isError ? onClose : undefined}
      statusBarTranslucent
    >
      <View style={styles.backdrop}>
        <View style={[styles.card, { paddingBottom: insets.bottom > 0 ? insets.bottom : spacing.lg }]}>
          <View style={styles.header}>
            <Text style={styles.title}>
              {mode === 'export' ? '正在备份' : '正在恢复'}
            </Text>
            {(isDone || isError) && (
              <Pressable onPress={onClose} hitSlop={12} style={styles.closeBtn}>
                <X size={20} color={colors.text.secondary} />
              </Pressable>
            )}
          </View>

          {isDone ? (
            <View style={styles.doneIcon}>
              <CheckCircle2 size={48} color={colors.primary} />
            </View>
          ) : isError ? (
            <View style={styles.errorIcon}>
              <Text style={styles.errorIconText}>!</Text>
            </View>
          ) : (
            <View style={styles.spinnerWrap}>
              <ActivityIndicator size="large" color={colors.primary} />
            </View>
          )}

          <Text style={styles.phase}>{phaseLabel}</Text>
          <Text style={styles.message} numberOfLines={3}>
            {progress?.message ?? '准备中…'}
          </Text>

          {!isDone && !isError && (
            <View style={styles.barTrack}>
              <View style={[styles.barFill, { width: `${pct}%` }]} />
            </View>
          )}

          {progress?.bytesTotal ? (
            <Text style={styles.bytesText}>
              {((progress.bytesProcessed ?? 0) / 1024 / 1024).toFixed(1)} MB /{' '}
              {(progress.bytesTotal / 1024 / 1024).toFixed(1)} MB
            </Text>
          ) : null}

          {isDone && progress?.doneHint ? (
            <View style={styles.hintBox}>
              <Text style={styles.hintText}>{progress.doneHint}</Text>
            </View>
          ) : null}

          {(isDone || isError) && (
            <Pressable
              style={({ pressed }) => [styles.closeBtnPrimary, pressed && { opacity: 0.9 }]}
              onPress={onClose}
            >
              <Text style={styles.closeBtnPrimaryText}>
                {isError ? '关闭' : '完成'}
              </Text>
            </Pressable>
          )}
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: spacing.lg,
  },
  card: {
    width: '100%',
    maxWidth: 380,
    backgroundColor: colors.surface,
    borderRadius: borderRadius.xxl,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.lg,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
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
  spinnerWrap: {
    alignItems: 'center',
    paddingVertical: spacing.lg,
  },
  doneIcon: {
    alignItems: 'center',
    paddingVertical: spacing.lg,
  },
  errorIcon: {
    width: 56, height: 56,
    borderRadius: 28,
    backgroundColor: '#FEE2E2',
    alignSelf: 'center',
    alignItems: 'center', justifyContent: 'center',
    marginVertical: spacing.lg,
  },
  errorIconText: {
    fontSize: 32,
    color: '#EF4444',
    fontWeight: '700',
    lineHeight: 36,
  },
  phase: {
    fontSize: fontSize.sm,
    color: colors.text.secondary,
    textAlign: 'center',
    marginTop: spacing.sm,
  },
  message: {
    fontSize: fontSize.sm,
    color: colors.text.primary,
    textAlign: 'center',
    marginTop: 4,
    minHeight: 20,
  },
  barTrack: {
    marginTop: spacing.md,
    height: 6,
    backgroundColor: colors.surfaceSecondary,
    borderRadius: 3,
    overflow: 'hidden',
  },
  barFill: {
    height: 6,
    backgroundColor: colors.primary,
    borderRadius: 3,
  },
  bytesText: {
    fontSize: 10,
    color: colors.text.tertiary,
    textAlign: 'center',
    marginTop: 6,
  },
  hintBox: {
    marginTop: spacing.md,
    padding: spacing.md,
    backgroundColor: colors.primaryLight,
    borderRadius: borderRadius.md,
  },
  hintText: {
    fontSize: fontSize.xs,
    color: colors.text.primary,
    lineHeight: 18,
  },
  closeBtnPrimary: {
    marginTop: spacing.lg,
    backgroundColor: colors.primary,
    paddingVertical: spacing.md,
    borderRadius: borderRadius.xl,
    alignItems: 'center',
  },
  closeBtnPrimaryText: {
    color: '#fff',
    fontSize: fontSize.sm,
    fontWeight: fontWeight.bold,
  },
});
