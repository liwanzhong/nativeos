import { Modal, View, Text, Pressable, StyleSheet, ActivityIndicator, ScrollView } from 'react-native';
import { borderRadius, colors, fontSize, fontWeight, spacing } from '../constants/theme';
import type { AndroidUpdateInfo } from '../lib/app-update';

interface AndroidAppUpdateModalProps {
  visible: boolean;
  update: AndroidUpdateInfo | null;
  isDownloading: boolean;
  progress: number;
  errorMessage: string | null;
  onUpdateNow: () => void;
  onLater: () => void;
}

function formatFileSize(sizeBytes?: number) {
  if (!sizeBytes || sizeBytes <= 0) return null;
  const mb = sizeBytes / (1024 * 1024);
  if (mb >= 1024) {
    return `${(mb / 1024).toFixed(2)} GB`;
  }
  return `${mb.toFixed(1)} MB`;
}

function formatProgress(progress: number) {
  return `${Math.round(Math.max(0, Math.min(1, progress)) * 100)}%`;
}

export function AndroidAppUpdateModal({
  visible,
  update,
  isDownloading,
  progress,
  errorMessage,
  onUpdateNow,
  onLater,
}: AndroidAppUpdateModalProps) {
  if (!update) {
    return null;
  }

  const apkSizeLabel = formatFileSize(update.apkSizeBytes);
  const releaseNotes = update.releaseNotes || [];

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={() => {
        if (!update.isMandatory && !isDownloading) {
          onLater();
        }
      }}
    >
      <View style={styles.overlay}>
        <View style={styles.card}>
          <Text style={styles.title}>{update.isMandatory ? '发现重要更新' : '发现新版本'}</Text>
          <Text style={styles.versionText}>
            当前 {update.localVersionName} ({update.localVersionCode})  →  最新 {update.versionName} ({update.versionCode})
          </Text>
          {apkSizeLabel ? <Text style={styles.metaText}>安装包大小：{apkSizeLabel}</Text> : null}
          {releaseNotes.length > 0 ? (
            <View style={styles.notesBlock}>
              <Text style={styles.notesTitle}>更新内容</Text>
              <ScrollView style={styles.notesScroll} nestedScrollEnabled>
                {releaseNotes.map((note, index) => (
                  <Text key={`${index}-${note}`} style={styles.noteItem}>{`- ${note}`}</Text>
                ))}
              </ScrollView>
            </View>
          ) : null}
          {isDownloading ? (
            <View style={styles.downloadBlock}>
              <View style={styles.progressRow}>
                <ActivityIndicator size="small" color={colors.primary} />
                <Text style={styles.progressText}>正在下载更新包 {formatProgress(progress)}</Text>
              </View>
              <View style={styles.progressTrack}>
                <View style={[styles.progressFill, { width: `${Math.round(Math.max(0, Math.min(1, progress)) * 100)}%` }]} />
              </View>
            </View>
          ) : null}
          {errorMessage ? <Text style={styles.errorText}>{errorMessage}</Text> : null}
          <View style={styles.actionsRow}>
            {!update.isMandatory ? (
              <Pressable style={[styles.actionBtn, styles.secondaryBtn]} onPress={onLater} disabled={isDownloading}>
                <Text style={styles.secondaryBtnText}>稍后再说</Text>
              </Pressable>
            ) : null}
            <Pressable style={[styles.actionBtn, styles.primaryBtn, isDownloading && styles.primaryBtnDisabled]} onPress={onUpdateNow} disabled={isDownloading}>
              <Text style={styles.primaryBtnText}>{isDownloading ? '下载中...' : '立即更新'}</Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(2, 6, 23, 0.72)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: spacing.lg,
  },
  card: {
    width: '100%',
    maxWidth: 420,
    backgroundColor: '#FFFFFF',
    borderRadius: borderRadius.xl,
    padding: spacing.lg,
    gap: spacing.md,
  },
  title: {
    fontSize: fontSize.xl,
    fontWeight: fontWeight.bold,
    color: '#0F172A',
  },
  versionText: {
    fontSize: fontSize.sm,
    color: '#334155',
    lineHeight: 20,
  },
  metaText: {
    fontSize: fontSize.sm,
    color: '#475569',
  },
  notesBlock: {
    gap: spacing.xs,
  },
  notesTitle: {
    fontSize: fontSize.base,
    fontWeight: fontWeight.semibold,
    color: '#0F172A',
  },
  notesScroll: {
    maxHeight: 160,
  },
  noteItem: {
    fontSize: fontSize.sm,
    color: '#334155',
    lineHeight: 20,
    marginBottom: 6,
  },
  downloadBlock: {
    gap: spacing.sm,
  },
  progressRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  progressText: {
    fontSize: fontSize.sm,
    color: '#0F172A',
    fontWeight: fontWeight.medium,
  },
  progressTrack: {
    width: '100%',
    height: 8,
    borderRadius: borderRadius.full,
    backgroundColor: '#E2E8F0',
    overflow: 'hidden',
  },
  progressFill: {
    height: '100%',
    borderRadius: borderRadius.full,
    backgroundColor: colors.primary,
  },
  errorText: {
    fontSize: fontSize.sm,
    color: '#DC2626',
    lineHeight: 20,
  },
  actionsRow: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: spacing.sm,
    marginTop: spacing.xs,
  },
  actionBtn: {
    minWidth: 108,
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderRadius: borderRadius.full,
    alignItems: 'center',
    justifyContent: 'center',
  },
  primaryBtn: {
    backgroundColor: colors.primary,
  },
  primaryBtnDisabled: {
    opacity: 0.7,
  },
  primaryBtnText: {
    fontSize: fontSize.sm,
    fontWeight: fontWeight.semibold,
    color: '#FFFFFF',
  },
  secondaryBtn: {
    backgroundColor: '#F8FAFC',
    borderWidth: 1,
    borderColor: '#CBD5E1',
  },
  secondaryBtnText: {
    fontSize: fontSize.sm,
    fontWeight: fontWeight.medium,
    color: '#334155',
  },
});
