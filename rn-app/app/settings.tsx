/**
 * Settings screen — secondary settings + dangerous actions (logout).
 *
 * Reached from "我的" tab → tap a "设置" entry in the list.
 * Tab bar is hidden while this is mounted (it's a non-tab stack route).
 *
 * Logout lives here (not on the profile card) so the card stays focused
 * on user identity. Confirmation alert because logout is destructive.
 *
 * Backup/Restore: lives in the "数据" section. Both flows are manual,
 * launched from this page. The user picks a backup zip from disk via
 * the system file picker (expo-document-picker); the app handles the
 * rest.
 */

import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useRouter } from 'expo-router';
import {
  ChevronLeft,
  LogOut,
  ChevronRight,
  Info,
  Database,
  RotateCcw,
  Share2,
  MessageSquareWarning,
} from 'lucide-react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Constants from 'expo-constants';
import { borderRadius, colors, fontSize, fontWeight, spacing } from '../constants/theme';
import { sectionStyles } from '../constants/sectionStyles';
import { useAuth } from '../lib/auth';
import {
  BackupItemsSheet,
} from './settings/components/backup/BackupItemsSheet';
import { RestoreStrategySheet } from './settings/components/backup/RestoreStrategySheet';
import {
  BackupProgressModal,
  type AnyProgress,
} from './settings/components/backup/BackupProgressModal';
import { scanBackupInventory } from '../lib/backup/inventory';
import { runExport, listExistingBackups, deleteBackup } from '../lib/backup/export';
import { runRestore, precheckBackup, isZipMagic } from '../lib/backup/import';
import { shareBackupZip } from '../lib/backup/share';
import { saveBackupZipToDir } from '../lib/backup/saveToDir';
import type { BackupItem, BackupItemKind } from '../lib/backup/types';
import type { RestoreStrategy } from '../lib/backup/types';

export default function SettingsScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { user, signOut, isAuthAvailable } = useAuth();

  // ── Backup state ────────────────────────────────────────────────
  const [showItemsSheet, setShowItemsSheet] = useState(false);
  const [inventory, setInventory] = useState<BackupItem[] | null>(null);
  const [scanning, setScanning] = useState(false);
  const [exportProgress, setExportProgress] = useState<AnyProgress | null>(null);
  const [exportModalVisible, setExportModalVisible] = useState(false);

  // ── Restore state ───────────────────────────────────────────────
  const [showStrategySheet, setShowStrategySheet] = useState(false);
  const [restoreProgress, setRestoreProgress] = useState<AnyProgress | null>(null);
  const [restoreModalVisible, setRestoreModalVisible] = useState(false);

  // ── Existing backups list ───────────────────────────────────────
  const [existingBackups, setExistingBackups] = useState<
    Array<{ path: string; sizeBytes: number; mtime: number }>
  >([]);
  const [historyVisible, setHistoryVisible] = useState(false);
  const [shareSheetPath, setShareSheetPath] = useState<string | null>(null);

  const refreshExisting = useCallback(async () => {
    const list = await listExistingBackups();
    setExistingBackups(list);
  }, []);

  useEffect(() => {
    refreshExisting();
  }, [refreshExisting]);

  // ── Handlers ────────────────────────────────────────────────────

  const handleSignOut = useCallback(() => {
    if (!isAuthAvailable) {
      Alert.alert('当前未配置登录', '未配置 Supabase，无法退出。');
      return;
    }
    Alert.alert('退出登录', '确认要退出登录吗？本机的本地数据会保留。', [
      { text: '取消', style: 'cancel' },
      {
        text: '退出',
        style: 'destructive',
        onPress: async () => {
          try {
            await signOut();
            router.back();
          } catch (e) {
            const msg = e instanceof Error ? e.message : '退出失败';
            Alert.alert('退出失败', msg);
          }
        },
      },
    ]);
  }, [isAuthAvailable, signOut, router]);

  const openBackupFlow = useCallback(async () => {
    setShowItemsSheet(true);
    if (inventory === null) {
      setScanning(true);
      try {
        const inv = await scanBackupInventory();
        setInventory(inv);
      } catch (e) {
        console.warn('[settings] scan failed', e);
      } finally {
        setScanning(false);
      }
    }
  }, [inventory]);

  const startExport = useCallback(
    async (selected: Set<BackupItemKind>) => {
      setShowItemsSheet(false);
      setExportModalVisible(true);
      setExportProgress({
        phase: 'scan',
        current: 0,
        message: '准备备份…',
      });
      try {
        const versionName = Constants.expoConfig?.version ?? '0.0.0';
        const result = await runExport(
          {
            selected,
            inventory: inventory ?? [],
            appVersion: versionName,
            dbSchemaVersion: 5,
          },
          (p) => setExportProgress(p as AnyProgress),
        );
        // Refresh history now that there's a new file
        await refreshExisting();
        setExportProgress({
          ...(exportProgress ?? { phase: 'done' as const, current: 1, message: '已保存' }),
          phase: 'done',
          current: 1,
          message: `已生成备份包（${(result.zipSizeBytes / 1024 / 1024).toFixed(1)} MB）`,
          doneHint: '已通过系统分享面板发送。可在「查看历史备份」中找到此文件，再次分享或删除。',
          zipPath: result.zipPath,
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : '备份失败';
        setExportProgress({ phase: 'error', current: 0, message: msg });
      }
    },
    [inventory, refreshExisting, exportProgress],
  );

  const startRestoreFlow = useCallback(
    async (strategy: RestoreStrategy) => {
      setShowStrategySheet(false);
      if (!isAuthAvailable || !user) {
        Alert.alert('需要先登录', '恢复备份前请先登录账号，确保 Pro 状态能正确同步。', [
          { text: '去登录', onPress: () => router.push('/login') },
        ]);
        return;
      }

      // Pick the zip via system file picker
      let pickedUri: string;
      let pickedName: string;
      try {
        const DocumentPicker = await import('expo-document-picker');
        // 只允许真正的 zip MIME/UTI。Android 资源管理器对 jpg 也可能返回
        // application/octet-stream,刻意不放进来 — 靠 picker 后的 ZIP magic
        // 校验兜底,而不是放宽白名单。'*/*' 一定要排除,否则 react-native-zip-archive
        // 对非 zip 输入会 native crash(JS 抓不到,app 直接挂)。
        const result = await DocumentPicker.getDocumentAsync({
          type: [
            'application/zip',
            'application/x-zip-compressed',
            'public.zip-archive',
            'com.pkware.zip-archive',
          ],
          copyToCacheDirectory: true,
        });
        if (result.canceled || result.canceled === undefined && (result as any).type === 'cancel') {
          return;
        }
        const asset = (result as any).assets?.[0] ?? (result as any);
        if (!asset?.uri) {
          Alert.alert('未选择文件', '请选择一个 .zip 备份文件。');
          return;
        }
        pickedUri = asset.uri;
        pickedName = asset.name ?? '';

        // 扩展名兜底:Android 资源管理器可能漏掉 .zip 后缀的文件,这里
        // 没拿到名字 / 后缀不对,先弹提示而不是直接进 unzip。
        if (pickedName && !/\.zip$/i.test(pickedName)) {
          Alert.alert(
            '文件类型不对',
            `请选择 .zip 格式的备份文件，你选的是「${pickedName}」。`,
          );
          return;
        }

        // ZIP magic 校验 —— 在 unzip 之前最后一道闸。pickedName 拿到的是
        // .zip 但内容被换成了图,或者 Android 资源管理器对 jpg 也返回了
        // application/zip(MIME 撒谎),这一关把 native crash 挡掉,改成
        // 友好的 Alert。
        const isZip = await isZipMagic(pickedUri);
        if (!isZip) {
          Alert.alert(
            '不是有效的 ZIP 文件',
            '请选择 NativeOS 导出的 .zip 备份,而不是其他类型的文件。',
          );
          return;
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : '无法打开文件选择器';
        Alert.alert('选择文件失败', msg);
        return;
      }

      // Precheck
      setRestoreModalVisible(true);
      setRestoreProgress({
        phase: 'verify',
        current: 0.1,
        message: '正在校验备份文件…',
      });
      try {
        const pre = await precheckBackup(pickedUri);
        if (!pre.ok || !pre.manifest) {
          setRestoreProgress({
            phase: 'error',
            current: 0,
            message: pre.reason || '备份文件无法识别',
          });
          return;
        }
        const manifest = pre.manifest;
        const itemCount = manifest.items?.length ?? 0;
        const dateStr = manifest.createdAt
          ? new Date(manifest.createdAt).toLocaleString('zh-CN')
          : '';
        const sizeStr = pre.zipSizeBytes
          ? `${(pre.zipSizeBytes / 1024 / 1024).toFixed(1)} MB`
          : '';
        Alert.alert(
          '确认恢复？',
          `备份时间：${dateStr}\n包含：${itemCount} 项内容\n大小：${sizeStr}\n\n将完全覆盖当前数据。恢复前会自动备份当前状态，可在 7 天内回滚。`,
          [
            { text: '取消', style: 'cancel', onPress: () => setRestoreModalVisible(false) },
            { text: '开始恢复', style: 'destructive', onPress: () => doRestore(pickedUri) },
          ],
        );
      } catch (e) {
        const msg = e instanceof Error ? e.message : '校验失败';
        setRestoreProgress({ phase: 'error', current: 0, message: msg });
      }
    },
    [isAuthAvailable, user, router],
  );

  const doRestore = useCallback(async (zipPath: string) => {
    setRestoreProgress({ phase: 'verify', current: 0.2, message: '准备恢复…' });
    try {
      const result = await runRestore({
        zipPath,
        strategy: 'overwrite',
        onProgress: (p) => setRestoreProgress(p as AnyProgress),
      });
      const proText =
        result.proStatusAfter === 'pro_active'
          ? '已激活'
          : result.proStatusAfter === 'pro_inactive'
            ? '未激活'
            : '未知';
      setRestoreProgress({
        phase: 'done',
        current: 1,
        message: '恢复完成',
        doneHint: `Pro 状态已从账号刷新：${proText}\n\n请手动重启 app 以加载新数据。`,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : '恢复失败';
      setRestoreProgress({ phase: 'error', current: 0, message: msg });
    }
  }, []);

  const handleShareExisting = useCallback((path: string) => {
    // Pop the share/save action sheet instead of going straight to the
    // system chooser — the user may want to write to a real folder
    // (e.g. their Downloads) without bouncing through a third-party
    // app.
    setShareSheetPath(path);
  }, []);

  const closeShareSheet = useCallback(() => setShareSheetPath(null), []);

  const handleShareViaChooser = useCallback(async () => {
    const path = shareSheetPath;
    console.log('[settings] click 分享到应用', { path });
    if (!path) return;
    closeShareSheet();
    try {
      const r = await shareBackupZip(path);
      console.log('[settings] shareBackupZip returned', r);
      if (r.outcome === 'error') {
        Alert.alert('分享失败', r.message ?? '未知错误');
      } else if (r.message) {
        Alert.alert(r.outcome === 'shared' ? '已分享' : '已取消', r.message);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : '分享失败';
      console.log('[settings] shareBackupZip threw', msg);
      Alert.alert('分享失败', msg);
    }
  }, [shareSheetPath, closeShareSheet]);

  const handleSaveToDir = useCallback(async () => {
    const path = shareSheetPath;
    if (!path) return;
    closeShareSheet();
    try {
      const r = await saveBackupZipToDir(path);
      if (r.outcome === 'cancelled') {
        // User dismissed the SAF picker — silent no-op (no alert spam).
        return;
      }
      if (r.outcome === 'error') {
        Alert.alert('保存失败', r.message ?? '未知错误');
        return;
      }
      Alert.alert('已保存', r.message ?? '已写入选定目录');
    } catch (e) {
      const msg = e instanceof Error ? e.message : '保存失败';
      Alert.alert('保存失败', msg);
    }
  }, [shareSheetPath, closeShareSheet]);

  const handleSaveToAnotherDir = useCallback(async () => {
    const path = shareSheetPath;
    if (!path) return;
    // Keep the sheet open while the picker is up; close it once we
    // actually start writing.
    try {
      const r = await saveBackupZipToDir(path, { forcePickDir: true });
      closeShareSheet();
      if (r.outcome === 'cancelled') return;
      if (r.outcome === 'error') {
        Alert.alert('保存失败', r.message ?? '未知错误');
        return;
      }
      Alert.alert('已保存', r.message ?? '已写入选定目录');
    } catch (e) {
      closeShareSheet();
      const msg = e instanceof Error ? e.message : '保存失败';
      Alert.alert('保存失败', msg);
    }
  }, [shareSheetPath, closeShareSheet]);

  const handleDeleteExisting = useCallback(
    async (path: string) => {
      Alert.alert('删除备份', '确认删除这个本地备份文件？删除后无法恢复。', [
        { text: '取消', style: 'cancel' },
        {
          text: '删除',
          style: 'destructive',
          onPress: async () => {
            await deleteBackup(path);
            await refreshExisting();
          },
        },
      ]);
    },
    [refreshExisting],
  );

  const versionName = Constants.expoConfig?.version ?? '未知';
  const versionCode = Constants.expoConfig?.android?.versionCode;
  const versionLabel = versionCode ? `${versionName} (${versionCode})` : versionName;

  return (
    <View style={styles.container}>
      <View style={[styles.header, { paddingTop: insets.top + 6 }]}>
        <Pressable style={styles.backBtn} onPress={() => router.back()}>
          <ChevronLeft size={20} color={colors.text.primary} />
        </Pressable>
        <Text style={styles.headerTitle} numberOfLines={1}>
          设置
        </Text>
        <View style={styles.headerSpacer} />
      </View>

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={[styles.scrollContent, { paddingBottom: insets.bottom + 32 }]}
        showsVerticalScrollIndicator={false}
      >
        {/* Account section */}
        <View style={sectionStyles.sectionBlock}>
          <View style={sectionStyles.sectionHeaderRow}>
            <View style={sectionStyles.sectionHeaderInfo}>
              <Text style={sectionStyles.sectionTitle}>账户</Text>
            </View>
          </View>

          <View style={styles.list}>
            <Pressable
              style={[styles.row, styles.rowBorder]}
              onPress={() => router.push('/profile-edit')}
              disabled={!user}
            >
              <View style={[styles.iconBox, { backgroundColor: colors.primaryLight }]}>
                <ChevronRight size={20} color={colors.primary} />
              </View>
              <View style={styles.rowText}>
                <Text style={styles.rowTitle}>编辑资料</Text>
                <Text style={styles.rowDesc}>昵称、等级、兴趣场景、头像</Text>
              </View>
              <ChevronRight size={18} color={colors.text.tertiary} />
            </Pressable>

            {user ? (
              <Pressable
                style={[styles.row, styles.dangerRow]}
                onPress={handleSignOut}
              >
                <View style={[styles.iconBox, { backgroundColor: '#FEE2E2' }]}>
                  <LogOut size={20} color="#EF4444" />
                </View>
                <View style={styles.rowText}>
                  <Text style={[styles.rowTitle, styles.dangerText]}>退出登录</Text>
                  <Text style={styles.rowDesc}>{user.email}</Text>
                </View>
              </Pressable>
            ) : (
              <Pressable
                style={[styles.row, styles.rowBorder]}
                onPress={() => router.push('/login')}
              >
                <View style={[styles.iconBox, { backgroundColor: colors.primaryLight }]}>
                  <ChevronRight size={20} color={colors.primary} />
                </View>
                <View style={styles.rowText}>
                  <Text style={styles.rowTitle}>登录 / 注册</Text>
                  <Text style={styles.rowDesc}>登录后可同步资料到云端</Text>
                </View>
                <ChevronRight size={18} color={colors.text.tertiary} />
              </Pressable>
            )}
          </View>
        </View>

        {/* Data section */}
        <View style={sectionStyles.sectionBlock}>
          <View style={sectionStyles.sectionHeaderRow}>
            <View style={sectionStyles.sectionHeaderInfo}>
              <Text style={sectionStyles.sectionTitle}>数据</Text>
            </View>
          </View>

          <View style={styles.list}>
            <Pressable
              style={[styles.row, styles.rowBorder]}
              onPress={openBackupFlow}
              disabled={scanning}
            >
              <View style={[styles.iconBox, { backgroundColor: colors.primaryLight }]}>
                <Database size={20} color={colors.primary} />
              </View>
              <View style={styles.rowText}>
                <Text style={styles.rowTitle}>备份数据</Text>
                <Text style={styles.rowDesc}>
                  把生词、对话历史、设置等打包成 .zip 文件，可发到微信收藏
                </Text>
              </View>
              {scanning ? (
                <ActivityIndicator size="small" color={colors.primary} />
              ) : (
                <ChevronRight size={18} color={colors.text.tertiary} />
              )}
            </Pressable>

            <Pressable
              style={[styles.row, styles.rowBorder]}
              onPress={() => setShowStrategySheet(true)}
            >
              <View style={[styles.iconBox, { backgroundColor: colors.primaryLight }]}>
                <RotateCcw size={20} color={colors.primary} />
              </View>
              <View style={styles.rowText}>
                <Text style={styles.rowTitle}>恢复数据</Text>
                <Text style={styles.rowDesc}>
                  从 .zip 备份还原。需要登录账号以恢复 Pro 状态
                </Text>
              </View>
              <ChevronRight size={18} color={colors.text.tertiary} />
            </Pressable>

            <Pressable style={[styles.row, styles.dangerRow]} onPress={() => setHistoryVisible(true)}>
              <View style={[styles.iconBox, { backgroundColor: colors.surfaceSecondary }]}>
                <Share2 size={20} color={colors.text.secondary} />
              </View>
              <View style={styles.rowText}>
                <Text style={styles.rowTitle}>本地备份历史</Text>
                <Text style={styles.rowDesc}>
                  {existingBackups.length > 0
                    ? `${existingBackups.length} 个备份文件`
                    : '尚无历史备份'}
                </Text>
              </View>
              <ChevronRight size={18} color={colors.text.tertiary} />
            </Pressable>
          </View>
        </View>

        {/* About section */}
        <View style={sectionStyles.sectionBlock}>
          <View style={sectionStyles.sectionHeaderRow}>
            <View style={sectionStyles.sectionHeaderInfo}>
              <Text style={sectionStyles.sectionTitle}>关于</Text>
            </View>
          </View>

          <View style={styles.list}>
            <Pressable
              style={[styles.row, styles.rowBorder]}
              onPress={() => router.push('/settings/feedback')}
            >
              <View style={[styles.iconBox, { backgroundColor: colors.warningLight }]}>
                <MessageSquareWarning size={20} color={colors.warning} />
              </View>
              <View style={styles.rowText}>
                <Text style={styles.rowTitle}>反馈问题</Text>
                <Text style={styles.rowDesc}>
                  遇到 bug 或异常？生成一个包含日志和设备信息的文本文件，可发到飞书
                </Text>
              </View>
              <ChevronRight size={18} color={colors.text.tertiary} />
            </Pressable>

            <View style={styles.row}>
              <View style={[styles.iconBox, { backgroundColor: colors.surfaceSecondary }]}>
                <Info size={20} color={colors.text.secondary} />
              </View>
              <View style={styles.rowText}>
                <Text style={styles.rowTitle}>NativeOS</Text>
                <Text style={styles.rowDesc}>当前版本 {versionLabel}</Text>
              </View>
            </View>
          </View>
        </View>
      </ScrollView>

      {/* Sheets & modals */}
      <BackupItemsSheet
        visible={showItemsSheet}
        onClose={() => setShowItemsSheet(false)}
        inventory={inventory}
        onStart={startExport}
      />
      <RestoreStrategySheet
        visible={showStrategySheet}
        onClose={() => setShowStrategySheet(false)}
        onConfirm={startRestoreFlow}
      />
      <BackupProgressModal
        visible={exportModalVisible}
        progress={exportProgress}
        mode="export"
        onClose={() => setExportModalVisible(false)}
      />
      <BackupProgressModal
        visible={restoreModalVisible}
        progress={restoreProgress}
        mode="restore"
        onClose={() => setRestoreModalVisible(false)}
      />

      {/* History modal */}
      <Modal
        visible={historyVisible}
        transparent
        animationType="slide"
        onRequestClose={() => setHistoryVisible(false)}
        statusBarTranslucent
      >
        <View style={styles.backdrop}>
          <Pressable style={StyleSheet.absoluteFill} onPress={() => setHistoryVisible(false)} />
          <View style={[styles.sheet, { paddingBottom: insets.bottom + spacing.lg }]}>
            <View style={styles.handle} />
            <Text style={styles.sheetTitle}>本地备份历史</Text>
            <Text style={styles.sheetSubtitle}>
              备份文件存于本机 documentDirectory，未分享到外部的备份易随系统清理而丢失
            </Text>
            <ScrollView style={styles.historyScroll}>
              {existingBackups.length === 0 ? (
                <Text style={styles.emptyText}>尚无备份</Text>
              ) : (
                existingBackups.map((b) => {
                  const dt = new Date(b.mtime || 0).toLocaleString('zh-CN');
                  return (
                    <View key={b.path} style={styles.historyRow}>
                      <View style={styles.historyInfo}>
                        <Text style={styles.historyName} numberOfLines={1}>
                          {b.path.split('/').pop()}
                        </Text>
                        <Text style={styles.historyMeta}>
                          {(b.sizeBytes / 1024 / 1024).toFixed(1)} MB · {dt}
                        </Text>
                      </View>
                      <Pressable
                        style={styles.historyBtn}
                        onPress={() => handleShareExisting(b.path)}
                      >
                        <Text style={styles.historyBtnText}>分享</Text>
                      </Pressable>
                      <Pressable
                        style={[styles.historyBtn, styles.historyBtnDanger]}
                        onPress={() => handleDeleteExisting(b.path)}
                      >
                        <Text style={[styles.historyBtnText, styles.historyBtnTextDanger]}>
                          删除
                        </Text>
                      </Pressable>
                    </View>
                  );
                })
              )}
            </ScrollView>
            <Pressable
              style={styles.sheetCloseBtn}
              onPress={() => setHistoryVisible(false)}
            >
              <Text style={styles.sheetCloseBtnText}>关闭</Text>
            </Pressable>
          </View>
        </View>
      </Modal>

      {/* Backup share/save action sheet — user picks "share to app" or
          "save to a real folder on this device". */}
      <Modal
        visible={shareSheetPath !== null}
        transparent
        animationType="fade"
        onRequestClose={closeShareSheet}
        statusBarTranslucent
      >
        <View style={styles.backdrop}>
          <Pressable style={StyleSheet.absoluteFill} onPress={closeShareSheet} />
          <View style={[styles.sheet, { paddingBottom: insets.bottom + spacing.lg }]}>
            <View style={styles.handle} />
            <Text style={styles.sheetTitle}>备份文件</Text>
            <Text style={styles.sheetSubtitle}>
              选择如何导出该备份：调起第三方应用，或直接写入本机目录
            </Text>

            <Pressable
              style={styles.actionRow}
              onPress={handleShareViaChooser}
            >
              <View style={styles.actionRowText}>
                <Text style={styles.actionRowTitle}>分享到应用</Text>
                <Text style={styles.actionRowSubtitle}>
                  调起系统选择器，发送到微信、QQ、网盘、蓝牙等
                </Text>
              </View>
              <ChevronRight size={18} color={colors.text.tertiary} />
            </Pressable>

            <View style={styles.actionDivider} />

            <Pressable
              style={styles.actionRow}
              onPress={handleSaveToDir}
            >
              <View style={styles.actionRowText}>
                <Text style={styles.actionRowTitle}>保存到选定目录</Text>
                <Text style={styles.actionRowSubtitle}>
                  首次会弹目录选择器；之后直接写入同一位置
                </Text>
              </View>
              <ChevronRight size={18} color={colors.text.tertiary} />
            </Pressable>

            <View style={styles.actionDivider} />

            <Pressable
              style={styles.actionRow}
              onPress={handleSaveToAnotherDir}
            >
              <View style={styles.actionRowText}>
                <Text style={styles.actionRowTitle}>保存到其他目录</Text>
                <Text style={styles.actionRowSubtitle}>
                  重新选择保存位置
                </Text>
              </View>
              <ChevronRight size={18} color={colors.text.tertiary} />
            </Pressable>

            <Pressable
              style={[styles.sheetCloseBtn, { marginTop: spacing.md }]}
              onPress={closeShareSheet}
            >
              <Text style={styles.sheetCloseBtnText}>取消</Text>
            </Pressable>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },

  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.md,
    gap: spacing.sm,
  },
  backBtn: {
    width: 36, height: 36, borderRadius: borderRadius.full,
    backgroundColor: colors.surface,
    alignItems: 'center', justifyContent: 'center',
    borderWidth: 1, borderColor: colors.border.light,
  },
  headerTitle: {
    flex: 1,
    color: colors.text.primary,
    fontSize: fontSize.lg,
    fontWeight: fontWeight.bold,
  },
  headerSpacer: { width: 36, height: 36 },

  scroll: { flex: 1 },
  scrollContent: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    gap: spacing.lg,
  },

  list: {
    backgroundColor: colors.surface,
    borderRadius: borderRadius.xxl,
    borderWidth: 1,
    borderColor: colors.border.light,
    overflow: 'hidden',
  },

  row: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: spacing.md,
    gap: spacing.md,
  },
  rowBorder: {
    borderBottomWidth: 1,
    borderBottomColor: colors.border.light,
  },
  dangerRow: {},
  dangerText: { color: '#EF4444' },
  iconBox: {
    width: 40, height: 40, borderRadius: borderRadius.md,
    alignItems: 'center', justifyContent: 'center',
  },
  rowText: { flex: 1 },
  rowTitle: {
    fontSize: fontSize.sm,
    fontWeight: fontWeight.bold,
    color: colors.text.primary,
    marginBottom: 2,
  },
  rowDesc: {
    fontSize: fontSize.xs,
    color: colors.text.secondary,
  },

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
    maxHeight: '80%',
  },
  handle: {
    width: 36, height: 4, borderRadius: 2,
    backgroundColor: colors.border.light,
    alignSelf: 'center',
    marginBottom: spacing.sm,
  },
  sheetTitle: {
    fontSize: fontSize.lg,
    fontWeight: fontWeight.bold,
    color: colors.text.primary,
  },
  sheetSubtitle: {
    fontSize: fontSize.xs,
    color: colors.text.secondary,
    marginTop: 2,
    marginBottom: spacing.md,
  },
  historyScroll: {
    flexGrow: 0,
    flexShrink: 1,
  },
  emptyText: {
    textAlign: 'center',
    color: colors.text.tertiary,
    fontSize: fontSize.sm,
    paddingVertical: spacing.lg,
  },
  historyRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.border.light,
    gap: spacing.sm,
  },
  historyInfo: { flex: 1 },
  historyName: {
    fontSize: fontSize.sm,
    fontWeight: '500',
    color: colors.text.primary,
  },
  historyMeta: {
    fontSize: 10,
    color: colors.text.tertiary,
    marginTop: 2,
  },
  historyBtn: {
    paddingHorizontal: spacing.sm,
    paddingVertical: 6,
    backgroundColor: colors.primaryLight,
    borderRadius: borderRadius.md,
  },
  historyBtnText: {
    fontSize: fontSize.xs,
    color: colors.primary,
    fontWeight: '600',
  },
  historyBtnDanger: {
    backgroundColor: '#FEE2E2',
  },
  historyBtnTextDanger: {
    color: '#EF4444',
  },
  sheetCloseBtn: {
    marginTop: spacing.md,
    paddingVertical: spacing.md,
    backgroundColor: colors.surfaceSecondary,
    borderRadius: borderRadius.xl,
    alignItems: 'center',
  },
  sheetCloseBtnText: {
    fontSize: fontSize.sm,
    color: colors.text.primary,
    fontWeight: '600',
  },

  // Backup share/save action sheet rows
  actionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.sm,
    gap: spacing.sm,
  },
  actionRowText: { flex: 1 },
  actionRowTitle: {
    fontSize: fontSize.sm,
    fontWeight: '600',
    color: colors.text.primary,
    marginBottom: 2,
  },
  actionRowSubtitle: {
    fontSize: fontSize.xs,
    color: colors.text.tertiary,
  },
  actionDivider: {
    height: 1,
    backgroundColor: colors.border.light,
    marginHorizontal: spacing.sm,
  },
});
