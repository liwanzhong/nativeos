/**
 * BackupItemsSheet — modal sheet listing every backupable item, with
 * checkboxes. User picks which items to include before tapping "开始备份".
 *
 * Layout:
 *   ┌─ handle bar ─────────────────┐
 *   │ 备份数据                       │
 *   │ 勾选要备份的内容，未勾选的不打包  │
 *   │                                │
 *   │ [全选] [仅高价值] [清空]         │
 *   │ ──────────────────────────────  │
 *   │ ☐ 生词本与复习状态  ~600 KB  200│
 *   │ ☐ NPC 对话历史      ~400 KB  12 │
 *   │ ⚠ ☐ 自带 API Key     ~200 B    │  ← sensitive, second confirm
 *   │ ...                             │
 *   │ ─────────────────────────────  │
 *   │ 已选 X 项 · 约 Y MB             │
 *   │ [       开始备份         ]      │
 *   └────────────────────────────────┘
 *
 * Uses the same Modal-based bottom sheet pattern as UpgradeSheet.
 */

import React, { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Cloud, TriangleAlert, X } from 'lucide-react-native';
import { borderRadius, colors, fontSize, fontWeight, spacing } from '../../../../constants/theme';
import { BACKUP_ITEMS, defaultSelection, formatBytes } from '../../../../lib/backup/inventory';
import type { BackupItem, BackupItemKind } from '../../../../lib/backup/types';

interface Props {
  visible: boolean;
  onClose: () => void;
  inventory: BackupItem[] | null; // null = still scanning
  onStart: (selected: Set<BackupItemKind>, sensitiveConfirmed: boolean) => void;
}

export function BackupItemsSheet({ visible, onClose, inventory, onStart }: Props) {
  const insets = useSafeAreaInsets();
  const [selected, setSelected] = useState<Set<BackupItemKind>>(() => defaultSelection());
  const [sensitiveAck, setSensitiveAck] = useState(false);

  // Reset on open
  useEffect(() => {
    if (visible) {
      setSelected(defaultSelection());
      setSensitiveAck(false);
    }
  }, [visible]);

  const liveByKind = useMemo(() => {
    const m = new Map<BackupItemKind, BackupItem>();
    (inventory ?? []).forEach((it) => m.set(it.kind, it));
    return m;
  }, [inventory]);

  const totalBytes = useMemo(() => {
    let sum = 0;
    for (const it of inventory ?? []) {
      if (selected.has(it.kind)) sum += it.sizeBytes || 0;
    }
    return sum;
  }, [inventory, selected]);

  const hasSensitiveSelected = useMemo(() => {
    for (const spec of BACKUP_ITEMS) {
      if (spec.sensitive && selected.has(spec.kind)) return true;
    }
    return false;
  }, [selected]);

  // Split the inventory into the "can pick" and "cloud-only info"
  // sections. The cloud section is rendered last with a divider so
  // it visually reads as a separate group, and its rows don't get
  // a checkbox (the data lives in Supabase, not in the zip).
  const cloudItems = useMemo(
    () => (inventory ?? []).filter((it) => it.cloudOnly),
    [inventory],
  );
  const pickableItems = useMemo(
    () => (inventory ?? []).filter((it) => !it.cloudOnly),
    [inventory],
  );

  const toggle = (kind: BackupItemKind) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(kind)) next.delete(kind);
      else next.add(kind);
      return next;
    });
  };

  const selectAll = () =>
    setSelected(new Set(BACKUP_ITEMS.filter((it) => !it.cloudOnly).map((it) => it.kind)));
  const selectHighValue = () => {
    // 11 P0 items (no files) — fast, safe baseline. Skip cloudOnly.
    const set = new Set<BackupItemKind>();
    for (const it of BACKUP_ITEMS) {
      if (it.source === 'db' && !it.cloudOnly) set.add(it.kind);
    }
    setSelected(set);
  };
  const selectNone = () => setSelected(new Set());

  const handleStart = () => {
    if (selected.size === 0) {
      Alert.alert('请至少选择一项', '没有勾选内容，无法备份。');
      return;
    }
    if (hasSensitiveSelected && !sensitiveAck) {
      Alert.alert(
        '包含敏感信息',
        '你勾选了自带 API Key 或云盘绑定等敏感项。建议在备份完成后立即通过安全渠道传输，并从源设备删除。',
        [
          { text: '我再看看', style: 'cancel' },
          {
            text: '我已知晓风险，继续',
            onPress: () => onStart(selected, true),
          },
        ],
      );
      return;
    }
    onStart(selected, true);
  };

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
            <Text style={styles.title}>备份数据</Text>
            <Pressable onPress={onClose} hitSlop={12} style={styles.closeBtn}>
              <X size={20} color={colors.text.secondary} />
            </Pressable>
          </View>
          <Text style={styles.subtitle}>勾选要备份的内容，未勾选的不打包</Text>

          <View style={styles.quickRow}>
            <Pressable style={styles.quickBtn} onPress={selectAll}>
              <Text style={styles.quickBtnText}>全选</Text>
            </Pressable>
            <Pressable style={styles.quickBtn} onPress={selectHighValue}>
              <Text style={styles.quickBtnText}>仅高价值</Text>
            </Pressable>
            <Pressable style={styles.quickBtn} onPress={selectNone}>
              <Text style={styles.quickBtnText}>清空</Text>
            </Pressable>
          </View>

          <ScrollView
            style={styles.scroll}
            contentContainerStyle={styles.scrollContent}
            showsVerticalScrollIndicator={false}
          >
            {inventory === null ? (
              <View style={styles.loadingRow}>
                <ActivityIndicator size="small" color={colors.primary} />
                <Text style={styles.loadingText}>正在扫描可备份内容…</Text>
              </View>
            ) : (
              <>
                {pickableItems.map((it) => {
                  const spec = BACKUP_ITEMS.find((s) => s.kind === it.kind)!;
                  const isSelected = selected.has(it.kind);
                  return (
                    <Pressable
                      key={it.kind}
                      style={({ pressed }) => [
                        styles.itemRow,
                        pressed && styles.itemRowPressed,
                      ]}
                      onPress={() => toggle(it.kind)}
                    >
                      <View
                        style={[
                          styles.checkbox,
                          isSelected && styles.checkboxOn,
                        ]}
                      >
                        {isSelected ? <Text style={styles.checkmark}>✓</Text> : null}
                      </View>
                      <View style={styles.itemText}>
                        <View style={styles.itemTitleRow}>
                          {spec.sensitive ? (
                            <TriangleAlert
                              size={14}
                              color="#F59E0B"
                              style={{ marginRight: 4 }}
                            />
                          ) : null}
                          <Text style={styles.itemTitle} numberOfLines={1}>
                            {it.label}
                          </Text>
                        </View>
                        <Text style={styles.itemDesc} numberOfLines={2}>
                          {it.description}
                        </Text>
                      </View>
                      <View style={styles.itemMeta}>
                        <Text style={styles.itemSize}>{formatBytes(it.sizeBytes)}</Text>
                        {it.recordCount ? (
                          <Text style={styles.itemCount}>
                            {it.recordCount > 1
                              ? `${it.recordCount} 条`
                              : it.sizeBytes > 0
                                ? '1 项'
                                : '空'}
                          </Text>
                        ) : it.sizeBytes === 0 ? (
                          <Text style={styles.itemCount}>空</Text>
                        ) : null}
                      </View>
                    </Pressable>
                  );
                })}
                {cloudItems.length > 0 ? (
                  <>
                    <View style={styles.cloudDivider} />
                    <View style={styles.cloudHeaderRow}>
                      <Cloud size={14} color={colors.text.tertiary} />
                      <Text style={styles.cloudHeader}>云端数据（不备份）</Text>
                    </View>
                    {cloudItems.map((it) => (
                      <View key={it.kind} style={styles.cloudItemRow}>
                        <View style={styles.itemText}>
                          <View style={styles.itemTitleRow}>
                            <Text style={styles.cloudItemTitle} numberOfLines={1}>
                              {it.label}
                            </Text>
                          </View>
                          <Text style={styles.itemDesc} numberOfLines={3}>
                            {it.description}
                          </Text>
                        </View>
                      </View>
                    ))}
                  </>
                ) : null}
              </>
            )}
          </ScrollView>

          <View style={styles.footer}>
            <Text style={styles.footerText}>
              已选 {selected.size} 项 · 约 {formatBytes(totalBytes)}
            </Text>
            <Pressable
              style={({ pressed }) => [
                styles.startBtn,
                pressed && styles.startBtnPressed,
                selected.size === 0 && styles.startBtnDisabled,
              ]}
              onPress={handleStart}
              disabled={selected.size === 0}
            >
              <Text style={styles.startBtnText}>开始备份</Text>
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
    maxHeight: '88%',
  },
  handle: {
    width: 36,
    height: 4,
    borderRadius: 2,
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
  quickRow: {
    flexDirection: 'row',
    gap: spacing.sm,
    marginBottom: spacing.md,
  },
  quickBtn: {
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
    backgroundColor: colors.surfaceSecondary,
    borderRadius: borderRadius.full,
  },
  quickBtnText: {
    fontSize: fontSize.xs,
    color: colors.text.primary,
    fontWeight: '500',
  },
  scroll: {
    flexGrow: 0,
    flexShrink: 1,
  },
  scrollContent: {
    paddingBottom: spacing.md,
    gap: 2,
  },
  loadingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.lg,
    justifyContent: 'center',
  },
  loadingText: {
    fontSize: fontSize.sm,
    color: colors.text.secondary,
  },
  itemRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.sm,
    borderRadius: borderRadius.md,
    gap: spacing.sm,
  },
  itemRowPressed: {
    backgroundColor: colors.surfaceSecondary,
  },
  checkbox: {
    width: 22, height: 22,
    borderRadius: 6,
    borderWidth: 1.5,
    borderColor: colors.border.default,
    alignItems: 'center', justifyContent: 'center',
  },
  checkboxOn: {
    backgroundColor: colors.primary,
    borderColor: colors.primary,
  },
  checkmark: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '700',
    lineHeight: 16,
  },
  itemText: { flex: 1 },
  itemTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  itemTitle: {
    fontSize: fontSize.sm,
    fontWeight: fontWeight.semibold ?? '600',
    color: colors.text.primary,
  },
  itemDesc: {
    fontSize: fontSize.xs,
    color: colors.text.secondary,
    marginTop: 2,
  },
  itemMeta: {
    alignItems: 'flex-end',
  },
  itemSize: {
    fontSize: fontSize.xs,
    color: colors.text.primary,
    fontWeight: '500',
  },
  itemCount: {
    fontSize: 10,
    color: colors.text.tertiary,
    marginTop: 2,
  },
  footer: {
    paddingTop: spacing.md,
    borderTopWidth: 1,
    borderTopColor: colors.border.light,
    gap: spacing.sm,
  },
  footerText: {
    fontSize: fontSize.xs,
    color: colors.text.secondary,
  },
  startBtn: {
    backgroundColor: colors.primary,
    paddingVertical: spacing.md,
    borderRadius: borderRadius.xl,
    alignItems: 'center',
  },
  startBtnPressed: {
    opacity: 0.92,
  },
  startBtnDisabled: {
    opacity: 0.5,
  },
  startBtnText: {
    color: '#fff',
    fontSize: fontSize.sm,
    fontWeight: fontWeight.bold,
  },

  // ── Cloud-only info section ──────────────────────────────────────
  cloudDivider: {
    height: 1,
    backgroundColor: colors.border.light,
    marginVertical: spacing.md,
  },
  cloudHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: spacing.sm,
    marginBottom: spacing.xs,
  },
  cloudHeader: {
    fontSize: fontSize.xs,
    color: colors.text.tertiary,
    fontWeight: '500',
  },
  cloudItemRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.sm,
    borderRadius: borderRadius.md,
    backgroundColor: 'transparent',
  },
  cloudItemTitle: {
    fontSize: fontSize.sm,
    color: colors.text.secondary,
    fontWeight: '500',
  },
});
