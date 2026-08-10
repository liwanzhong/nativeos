import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'expo-router';
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
import { ChevronLeft, Cloud, HardDriveDownload, RotateCw } from 'lucide-react-native';
import { borderRadius, colors, fontSize, fontWeight, spacing } from '../../constants/theme';
import {
  clearBaiduPanAuthorization,
  getBaiduPanAppConfig,
  getBaiduPanBinding,
  getConfiguredCloudProviders,
  getDefaultCloudProvider,
  saveBaiduPanAppConfig,
  saveBaiduPanBinding,
  saveDefaultCloudProvider,
  type BaiduPanAppConfig,
  type BaiduPanToken,
  type CloudVideoProvider,
} from '../../lib/content/cloud-drive-bindings';
import {
  getOfficialSceneSyncSummary,
  rescanOfficialSceneSyncStatus,
  type OfficialSceneSyncSummary,
} from '../../lib/content/cloud-drive-sync';
import { BaiduAuthWebView } from './BaiduAuthWebView';
import { listBaiduPanDirectory } from '../../lib/content/baidu-pan-fs';
import { listUserVideos } from '../../lib/content/user-videos';

type CloudDriveManagerContentProps = {
  allowLocalImport?: boolean;
  onBindingsChanged?: () => Promise<void> | void;
  onImportLocalPack?: () => Promise<void> | void;
  visible?: boolean;
};

type CloudManagerView = 'picker' | CloudVideoProvider;

type DirectoryPickerEntry = {
  name: string;
  path: string;
};

type DirectoryPickerState = {
  visible: boolean;
  provider: CloudVideoProvider | null;
  currentPath: string;
  selectedPath: string;
  items: DirectoryPickerEntry[];
  loading: boolean;
  error: string;
};

function normalizeDirectoryPath(path: string, fallback: string = '/') {
  const raw = (path || fallback).trim();
  if (!raw || raw === '/') return '/';
  const withLeadingSlash = raw.startsWith('/') ? raw : `/${raw}`;
  return withLeadingSlash.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/+$/, '') || '/';
}

function getParentDirectoryPath(path: string) {
  const normalized = normalizeDirectoryPath(path);
  if (normalized === '/') {
    return '/';
  }
  const parts = normalized.split('/').filter(Boolean);
  parts.pop();
  return parts.length ? `/${parts.join('/')}` : '/';
}

function createEmptyDirectoryPickerState(): DirectoryPickerState {
  return {
    visible: false,
    provider: null,
    currentPath: '/',
    selectedPath: '/',
    items: [],
    loading: false,
    error: '',
  };
}

const PROVIDER_META: Record<CloudVideoProvider, { title: string; subtitle: string }> = {
  baidu_pan: {
    title: '百度网盘',
    subtitle: '百度授权与目录设置',
  },
};

function getProviderLabel(provider: CloudVideoProvider) {
  return provider === 'baidu_pan' ? '百度网盘' : '云盘';
}

function createEmptySyncSummary(): OfficialSceneSyncSummary {
  return {
    totalScenes: 0,
    connectedProviders: [],
    providers: {
      baidu_pan: {
        total: 0,
        available: 0,
        notSynced: 0,
        stale: 0,
        error: 0,
      },
    },
    issues: [],
  };
}

function ProviderCardIcon() {
  return <Cloud size={18} color="#2563EB" />;
}

export function CloudDriveManagerContent({
  allowLocalImport = false,
  onBindingsChanged,
  onImportLocalPack,
  visible,
}: CloudDriveManagerContentProps) {
  const router = useRouter();
  const [activeView, setActiveView] = useState<CloudManagerView>('picker');
  const [isSavingBinding, setIsSavingBinding] = useState(false);
  const [isImportingLocal, setIsImportingLocal] = useState(false);
  const [notice, setNotice] = useState('');
  const [baiduRootPath, setBaiduRootPath] = useState('/');
  const [baiduConfig, setBaiduConfig] = useState<BaiduPanAppConfig | null>(null);
  const [hasBaiduBinding, setHasBaiduBinding] = useState(false);
  const [configuredProviders, setConfiguredProviders] = useState<CloudVideoProvider[]>([]);
  const [defaultProvider, setDefaultProvider] = useState<CloudVideoProvider | null>(null);
  const [showBaiduWebView, setShowBaiduWebView] = useState(false);
  const [cloudVideoCounts, setCloudVideoCounts] = useState<Record<CloudVideoProvider, number>>({
    baidu_pan: 0,
  });
  const [syncSummary, setSyncSummary] = useState<OfficialSceneSyncSummary>(createEmptySyncSummary);
  const [isScanningSync, setIsScanningSync] = useState(false);
  const [directoryPicker, setDirectoryPicker] = useState<DirectoryPickerState>(createEmptyDirectoryPickerState);

  useEffect(() => {
    if (!notice) {
      return;
    }
    const timer = setTimeout(() => setNotice(''), 2200);
    return () => clearTimeout(timer);
  }, [notice]);

  const loadBindings = useCallback(async () => {
    const [baiduConfig, baiduBinding, configured, nextDefaultProvider, userVideos, nextSyncSummary] = await Promise.all([
      getBaiduPanAppConfig(),
      getBaiduPanBinding(),
      getConfiguredCloudProviders(),
      getDefaultCloudProvider(),
      listUserVideos(),
      getOfficialSceneSyncSummary(),
    ]);
    const nextCloudVideoCounts: Record<CloudVideoProvider, number> = {
      baidu_pan: 0,
    };
    userVideos.forEach((item) => {
      if (item.sourceType !== 'cloud_reference' || !item.provider) {
        return;
      }
      nextCloudVideoCounts[item.provider] = (nextCloudVideoCounts[item.provider] ?? 0) + 1;
    });
    setBaiduConfig(baiduConfig);
    setBaiduRootPath(baiduBinding?.rootPath || '/');
    setHasBaiduBinding(Boolean(baiduBinding?.token?.accessToken));
    setConfiguredProviders(configured);
    setDefaultProvider(nextDefaultProvider);
    setCloudVideoCounts(nextCloudVideoCounts);
    setSyncSummary(nextSyncSummary);
  }, []);

  useEffect(() => {
    if (visible === false) {
      return;
    }
    void loadBindings();
  }, [loadBindings, visible]);

  useEffect(() => {
    if (visible) {
      setActiveView('picker');
    }
  }, [visible]);

  const refreshAfterBindingChange = useCallback(async () => {
    await loadBindings();
    if (onBindingsChanged) {
      await onBindingsChanged();
    }
  }, [loadBindings, onBindingsChanged]);

  const handleSaveBaiduBinding = useCallback(async () => {
    setIsSavingBinding(true);
    try {
      const config = baiduConfig ?? await getBaiduPanAppConfig();
      if (!config.appKey || !config.secretKey || !config.redirectUri) {
        throw new Error('当前缺少百度应用配置，需由应用内部预置后才能授权');
      }
      const existing = await getBaiduPanBinding();
      await saveBaiduPanAppConfig(config);
      await saveBaiduPanBinding({
        rootPath: baiduRootPath,
        token: existing?.token || null,
      });
      await refreshAfterBindingChange();
      setNotice('百度网盘授权已保存');
      setActiveView('picker');
    } catch (error) {
      Alert.alert('百度网盘保存授权失败', error instanceof Error ? error.message : '请稍后重试');
    } finally {
      setIsSavingBinding(false);
    }
  }, [baiduConfig, baiduRootPath, refreshAfterBindingChange]);

  const handleOpenBaiduAuth = useCallback(async () => {
    try {
      const config = baiduConfig ?? await getBaiduPanAppConfig();
      if (!config.appKey || !config.secretKey || !config.redirectUri) {
        throw new Error('当前缺少百度应用配置，需由应用内部预置后才能打开授权页');
      }
      const existing = await getBaiduPanBinding();
      await saveBaiduPanAppConfig(config);
      await saveBaiduPanBinding({
        rootPath: baiduRootPath,
        token: existing?.token || null,
      });
      setShowBaiduWebView(true);
    } catch (error) {
      Alert.alert('打开百度授权失败', error instanceof Error ? error.message : '请稍后重试');
    }
  }, [baiduConfig, baiduRootPath]);

  const handleBaiduAuthSuccess = useCallback(async (_token: BaiduPanToken) => {
    setShowBaiduWebView(false);
    await refreshAfterBindingChange();
    setNotice('百度网盘授权成功');
    setActiveView('picker');
  }, [refreshAfterBindingChange]);

  const handleStopBaiduAuthorization = useCallback(() => {
    Alert.alert('停止百度授权', '这会清除本地保存的百度授权信息和该网盘的推荐内容状态记录。', [
      { text: '取消', style: 'cancel' },
      {
        text: '停止授权',
        style: 'destructive',
        onPress: () => {
          void (async () => {
            try {
              await clearBaiduPanAuthorization();
              await refreshAfterBindingChange();
              setNotice('已停止百度授权');
              setActiveView('picker');
            } catch (error) {
              Alert.alert('停止百度授权失败', error instanceof Error ? error.message : '请稍后重试');
            }
          })();
        },
      },
    ]);
  }, [refreshAfterBindingChange]);

  const closeDirectoryPicker = useCallback(() => {
    setDirectoryPicker(createEmptyDirectoryPickerState());
  }, []);

  const loadDirectoryEntries = useCallback(async (
    provider: CloudVideoProvider,
    targetPath: string,
  ) => {
    const normalizedPath = normalizeDirectoryPath(targetPath);
    setDirectoryPicker((prev) => ({
      ...prev,
      visible: true,
      provider,
      currentPath: normalizedPath,
      selectedPath: normalizedPath,
      loading: true,
      error: '',
      items: [],
    }));

    try {
      if (provider === 'baidu_pan') {
        const binding = await getBaiduPanBinding();
        if (!binding?.token?.accessToken) {
          throw new Error('请先完成百度网盘授权');
        }
        const directories = await listBaiduPanDirectory(binding.token.accessToken, normalizedPath);
        setDirectoryPicker((prev) => ({
          ...prev,
          visible: true,
          provider,
          currentPath: normalizedPath,
          selectedPath: normalizedPath,
          loading: false,
          error: '',
          items: directories
            .filter((item) => item.isDirectory)
            .map((item) => ({ name: item.name, path: item.path })),
        }));
        return;
      }

      throw new Error('该网盘来源暂不支持目录选择');
    } catch (error) {
      setDirectoryPicker((prev) => ({
        ...prev,
        visible: true,
        provider,
        currentPath: normalizedPath,
        selectedPath: normalizedPath,
        loading: false,
        items: [],
        error: error instanceof Error ? error.message : '加载目录失败',
      }));
    }
  }, []);

  const handleOpenDirectoryPicker = useCallback(async (provider: CloudVideoProvider) => {
    const initialPath = provider === 'baidu_pan' ? baiduRootPath : '/';
    await loadDirectoryEntries(provider, initialPath || '/');
  }, [baiduRootPath, loadDirectoryEntries]);

  const handleOpenParentDirectory = useCallback(async () => {
    if (!directoryPicker.provider) {
      return;
    }
    await loadDirectoryEntries(directoryPicker.provider, getParentDirectoryPath(directoryPicker.currentPath));
  }, [directoryPicker.currentPath, directoryPicker.provider, loadDirectoryEntries]);

  const handleOpenChildDirectory = useCallback(async (path: string) => {
    if (!directoryPicker.provider) {
      return;
    }
    await loadDirectoryEntries(directoryPicker.provider, path);
  }, [directoryPicker.provider, loadDirectoryEntries]);

  const handleConfirmDirectoryPicker = useCallback(async () => {
    const selectedPath = normalizeDirectoryPath(directoryPicker.selectedPath || directoryPicker.currentPath);
    if (directoryPicker.provider === 'baidu_pan') {
      // Persist immediately — no separate "保存" button.
      try {
        const existing = await getBaiduPanBinding();
        await saveBaiduPanBinding({
          rootPath: selectedPath,
          token: existing?.token || null,
        });
        setBaiduRootPath(selectedPath);
        setNotice(`已切换授权目录到 ${selectedPath}`);
      } catch (error) {
        Alert.alert('保存目录失败', error instanceof Error ? error.message : '请稍后重试');
      }
    }
    closeDirectoryPicker();
  }, [closeDirectoryPicker, directoryPicker.currentPath, directoryPicker.provider, directoryPicker.selectedPath]);

  const handleSelectDefaultProvider = useCallback(async (provider: CloudVideoProvider) => {
    if (!configuredProviders.includes(provider)) {
      return;
    }
    try {
      await saveDefaultCloudProvider(provider);
      await loadBindings();
      setNotice(`推荐默认网盘已切换为${provider === 'baidu_pan' ? '百度网盘' : '云盘'}`);
    } catch (error) {
      Alert.alert('推荐默认网盘保存失败', error instanceof Error ? error.message : '请稍后重试');
    }
  }, [configuredProviders, loadBindings]);

  const handleRescanSync = useCallback(async () => {
    if (isScanningSync) {
      return;
    }
    if (configuredProviders.length === 0) {
      Alert.alert('还没有可扫描的网盘', '请先连接百度网盘，并设置同步目录。');
      return;
    }
    if (!defaultProvider && configuredProviders.length > 1) {
      Alert.alert('请先设置推荐默认网盘', '当前连接了多个网盘，请先选择推荐默认网盘，再扫描推荐视频状态。');
      return;
    }
    setIsScanningSync(true);
    try {
      const nextSummary = await rescanOfficialSceneSyncStatus(true);
      setSyncSummary(nextSummary);
      await loadBindings();
      if (onBindingsChanged) {
        await onBindingsChanged();
      }
      setNotice('已完成推荐内容状态扫描');
    } catch (error) {
      Alert.alert('同步扫描失败', error instanceof Error ? error.message : '请稍后重试');
    } finally {
      setIsScanningSync(false);
    }
  }, [configuredProviders.length, defaultProvider, isScanningSync, loadBindings, onBindingsChanged]);

  const handleImportLocalPack = useCallback(async () => {
    if (!onImportLocalPack || isImportingLocal) {
      return;
    }
    setIsImportingLocal(true);
    try {
      await onImportLocalPack();
    } finally {
      setIsImportingLocal(false);
    }
  }, [isImportingLocal, onImportLocalPack]);

  const activeProviderSync = defaultProvider ? syncSummary.providers[defaultProvider] : null;
  const totalStaleScenes = activeProviderSync?.stale ?? 0;
  const totalErrorScenes = activeProviderSync?.error ?? 0;
  const totalPendingScenes = (activeProviderSync?.notSynced ?? 0) + totalStaleScenes + totalErrorScenes;
  const canChooseDefaultProvider = configuredProviders.length > 1;
  const handleOpenOfficialVideoTransfer = useCallback(() => {
    router.push('/official-video-transfer');
  }, [router]);

  return (
    <View style={styles.container}>
      {activeView === 'picker' ? (
        <ScrollView
          showsVerticalScrollIndicator={false}
          style={styles.scroll}
          contentContainerStyle={styles.scrollContent}
        >
          {(['baidu_pan'] as CloudVideoProvider[]).map((provider) => {
            const meta = PROVIDER_META[provider];
            const isConfigured = provider === 'baidu_pan' ? hasBaiduBinding : false;
            const rootPath = provider === 'baidu_pan' ? baiduRootPath : '/';
            const importedCount = cloudVideoCounts[provider] ?? 0;
            const providerSync = syncSummary.providers[provider] ?? {
              total: 0,
              available: 0,
              notSynced: 0,
              stale: 0,
              error: 0,
            };
            const isRecommendedDefault = defaultProvider === provider || (configuredProviders.length === 1 && isConfigured);
            const providerPendingCount = providerSync.notSynced + providerSync.stale + providerSync.error;
            const currentDefaultLabel = defaultProvider ? getProviderLabel(defaultProvider) : '未设置';
            return (
              <View key={provider} style={[styles.providerCard, isRecommendedDefault && styles.providerCardRecommended]}>
                <View style={styles.providerCardTop}>
                  <View style={styles.providerCardIconWrap}>
                    <ProviderCardIcon />
                  </View>
                  <View style={styles.providerCardBody}>
                    <Text style={styles.providerCardTitle}>{meta.title}</Text>
                    <Text style={styles.providerCardHint}>{meta.subtitle}</Text>
                    <Pressable style={styles.providerInlineLinkBtn} onPress={handleOpenOfficialVideoTransfer}>
                      <Text style={styles.providerInlineLinkText}>转存推荐视频</Text>
                    </Pressable>
                    <View style={[styles.providerStatusPill, isConfigured ? styles.providerStatusPillActive : styles.providerStatusPillInactive]}>
                      <Text style={[styles.providerStatusText, isConfigured ? styles.providerStatusTextActive : styles.providerStatusTextInactive]}>
                        {isConfigured ? configuredProviders.length === 1 ? '自动默认' : isRecommendedDefault ? '当前默认' : '已连接' : '未连接'}
                      </Text>
                    </View>
                  </View>
                </View>
                <View style={styles.providerMetaRow}>
                  <View style={styles.providerMetaChip}>
                    <Text style={styles.providerMetaChipText}>{isConfigured ? `目录 ${rootPath}` : '待连接后设置目录'}</Text>
                  </View>
                  {isConfigured && isRecommendedDefault ? (
                    <>
                      <View style={styles.providerMetaChip}>
                        <Text style={styles.providerMetaChipText}>就绪 {providerSync.available}/{syncSummary.totalScenes}</Text>
                      </View>
                      <View style={styles.providerMetaChip}>
                        <Text style={styles.providerMetaChipText}>待处理 {providerPendingCount}</Text>
                      </View>
                    </>
                  ) : isConfigured ? (
                    <View style={styles.providerMetaChip}>
                      <Text style={styles.providerMetaChipText}>
                        {canChooseDefaultProvider
                          ? defaultProvider
                            ? `默认 ${currentDefaultLabel}`
                            : '可设默认'
                          : '自动默认'}
                      </Text>
                    </View>
                  ) : null}
                  {importedCount > 0 ? (
                    <View style={styles.providerMetaChip}>
                      <Text style={styles.providerMetaChipText}>已导入 {importedCount}</Text>
                    </View>
                  ) : null}
                </View>
                <View style={styles.providerCardActionRow}>
                  <Pressable style={styles.providerCardSecondaryAction} onPress={() => setActiveView(provider)}>
                    <Text style={styles.providerCardSecondaryActionText}>{isConfigured ? '授权管理' : '去授权'}</Text>
                  </Pressable>
                  {isConfigured ? (
                    isRecommendedDefault ? (
                      <Pressable
                        style={styles.rescanIconBtn}
                        onPress={handleRescanSync}
                        disabled={isScanningSync}
                        hitSlop={8}
                      >
                        {isScanningSync ? (
                          <ActivityIndicator size="small" color={colors.primary} />
                        ) : (
                          <RotateCw size={16} color={colors.primary} />
                        )}
                      </Pressable>
                    ) : canChooseDefaultProvider ? (
                      <Pressable style={styles.providerCardPrimaryAction} onPress={() => handleSelectDefaultProvider(provider)}>
                        <Text style={styles.providerCardPrimaryActionText}>设默认</Text>
                      </Pressable>
                    ) : null
                  ) : null}
                </View>
              </View>
            );
          })}
          {allowLocalImport ? (
            <View style={styles.localImportCard}>
              <View style={styles.localImportHeader}>
                <View style={styles.providerCardIconWrap}>
                  <HardDriveDownload size={18} color="#7C3AED" />
                </View>
                <View style={styles.providerCardBody}>
                  <Text style={styles.providerCardTitle}>本地视频包</Text>
                  <Text style={styles.providerCardHint}>保留本地导入，但不再作为右上角的主入口。</Text>
                </View>
              </View>
              <Pressable
                style={[styles.primaryBtn, isImportingLocal && styles.primaryBtnDisabled]}
                onPress={handleImportLocalPack}
                disabled={isImportingLocal}
              >
                <Text style={styles.primaryBtnText}>{isImportingLocal ? '导入中' : '导入本地视频包'}</Text>
              </Pressable>
            </View>
          ) : null}
        </ScrollView>
      ) : (
        <ScrollView
          showsVerticalScrollIndicator={false}
          style={styles.scroll}
          contentContainerStyle={styles.scrollContent}
        >
          <Pressable style={styles.backBtn} onPress={() => setActiveView('picker')}>
            <ChevronLeft size={18} color={colors.text.secondary} />
            <Text style={styles.backBtnText}>返回选择网盘</Text>
          </Pressable>
          {activeView === 'baidu_pan' ? (
            <View style={styles.formCard}>
              {hasBaiduBinding ? (
                // ─── Connected state ──────────────────────────────────
                <>
                  <View style={styles.baiduStatusRow}>
                    <View style={styles.baiduStatusDotOk} />
                    <Text style={styles.sectionTitle}>百度网盘</Text>
                    <View style={styles.baiduStatusChipOk}>
                      <Text style={styles.baiduStatusChipOkText}>
                        {defaultProvider === 'baidu_pan' ? '已连接 · 推荐来源' : '已连接'}
                      </Text>
                    </View>
                  </View>

                  <View style={styles.baiduCurrentDirCard}>
                    <View style={styles.baiduCurrentDirTextCol}>
                      <Text style={styles.directoryFieldLabel}>当前目录</Text>
                      <Text
                        style={styles.directoryFieldValue}
                        numberOfLines={1}
                        ellipsizeMode="middle"
                      >{baiduRootPath || '/'}</Text>
                    </View>
                    <Pressable
                      style={styles.baiduChangeDirBtn}
                      onPress={() => handleOpenDirectoryPicker('baidu_pan')}
                    >
                      <Text style={styles.baiduChangeDirBtnText}>更换</Text>
                    </Pressable>
                  </View>

                  <Pressable
                    style={styles.baiduReconnectBtn}
                    onPress={handleOpenBaiduAuth}
                  >
                    <Text style={styles.baiduReconnectBtnText}>重新授权（换账号）</Text>
                  </Pressable>

                  <Pressable
                    style={styles.dangerTextBtn}
                    onPress={handleStopBaiduAuthorization}
                  >
                    <Text style={styles.dangerTextBtnText}>停止授权</Text>
                  </Pressable>
                </>
              ) : (
                // ─── Disconnected state ────────────────────────────────
                <>
                  <View style={styles.baiduStatusRow}>
                    <View style={styles.baiduStatusDotOff} />
                    <Text style={styles.sectionTitle}>百度网盘</Text>
                    <View style={styles.baiduStatusChipOff}>
                      <Text style={styles.baiduStatusChipOffText}>未授权</Text>
                    </View>
                  </View>
                  <Text style={styles.sectionHint}>授权后可解析官方推荐视频的云端目录。</Text>
                  <Pressable
                    style={[styles.primaryBtn, styles.baiduAuthCta]}
                    onPress={handleOpenBaiduAuth}
                  >
                    <Text style={styles.primaryBtnText}>百度授权</Text>
                  </Pressable>
                </>
              )}
            </View>
          ) : null}
        </ScrollView>
      )}
      {notice ? (
        <View style={styles.notice} pointerEvents="none">
          <Text style={styles.noticeText}>{notice}</Text>
        </View>
      ) : null}
      <BaiduAuthWebView
        visible={showBaiduWebView}
        onSuccess={handleBaiduAuthSuccess}
        onError={(msg) => Alert.alert('百度授权失败', msg)}
        onClose={() => setShowBaiduWebView(false)}
      />
      <Modal visible={directoryPicker.visible} transparent animationType="slide" onRequestClose={closeDirectoryPicker}>
        <View style={styles.directoryModalOverlay}>
          <View style={styles.directoryModalCard}>
            <View style={styles.directoryModalHeader}>
              <View style={styles.directoryModalHeaderTextWrap}>
                <Text style={styles.sectionTitle}>选择授权目录</Text>
                <Text style={styles.directoryCurrentPathText}>{directoryPicker.currentPath}</Text>
              </View>
              <Pressable style={styles.directoryCloseBtn} onPress={closeDirectoryPicker}>
                <Text style={styles.directoryCloseBtnText}>关闭</Text>
              </Pressable>
            </View>

            {directoryPicker.error ? (
              <Text style={styles.directoryErrorText}>{directoryPicker.error}</Text>
            ) : null}

            {directoryPicker.loading ? (
              <View style={styles.directoryLoadingWrap}>
                <ActivityIndicator color={colors.primary} />
              </View>
            ) : (
              <ScrollView style={styles.directoryList} contentContainerStyle={styles.directoryListContent}>
                {directoryPicker.currentPath !== '/' ? (
                  <Pressable
                    style={[styles.directoryItem, styles.directoryItemParent]}
                    onPress={handleOpenParentDirectory}
                  >
                    <View style={styles.directoryItemIconWrap}>
                      <ChevronLeft size={16} color={colors.text.secondary} />
                    </View>
                    <View style={styles.directoryItemBody}>
                      <Text style={styles.directoryItemTitle}>.. 上一级</Text>
                    </View>
                  </Pressable>
                ) : null}
                {directoryPicker.items.length === 0 ? (
                  <Text style={styles.sectionHint}>当前目录下没有子目录。</Text>
                ) : directoryPicker.items.map((item) => (
                  <Pressable
                    key={item.path}
                    style={styles.directoryItem}
                    onPress={() => {
                      // 子目录: 进入下层; 已是当前目录: 选中并关闭
                      // 这里按下 item 默认进入下层, 用户要选当前目录点底部「使用此目录」
                      void handleOpenChildDirectory(item.path);
                    }}
                  >
                    <View style={styles.directoryItemIconWrap}>
                      <Cloud size={16} color={colors.primary} />
                    </View>
                    <View style={styles.directoryItemBody}>
                      <Text style={styles.directoryItemTitle}>{item.name}</Text>
                      <Text style={styles.directoryItemPath} numberOfLines={1}>{item.path}</Text>
                    </View>
                  </Pressable>
                ))}
              </ScrollView>
            )}

            <Pressable style={styles.directoryUseBtn} onPress={handleConfirmDirectoryPicker}>
              <Text style={styles.directoryUseBtnText}>使用此目录</Text>
            </Pressable>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  scroll: {
    flex: 1,
  },
  scrollContent: {
    gap: spacing.md,
    paddingBottom: spacing.xl,
  },
  providerCard: {
    borderRadius: borderRadius.xxl,
    borderWidth: 1,
    borderColor: colors.border.light,
    backgroundColor: colors.surface,
    padding: spacing.md,
    gap: spacing.sm,
  },
  providerCardRecommended: {
    borderColor: '#93C5FD',
    backgroundColor: '#F8FBFF',
  },
  providerCardTop: {
    flexDirection: 'row',
    gap: spacing.md,
  },
  providerCardIconWrap: {
    width: 42,
    height: 42,
    borderRadius: borderRadius.lg,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#EFF6FF',
  },
  providerCardBody: {
    flex: 1,
    gap: 4,
  },
  providerMetaRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.xs,
    marginTop: spacing.xs,
  },
  providerMetaChip: {
    borderRadius: borderRadius.full,
    backgroundColor: '#F8FAFC',
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  providerMetaChipText: {
    color: colors.text.secondary,
    fontSize: fontSize.xs,
    fontWeight: fontWeight.medium,
  },
  providerCardActionRow: {
    flexDirection: 'row',
    gap: spacing.sm,
    marginTop: spacing.xs,
  },
  providerCardPrimaryAction: {
    flex: 1,
    minHeight: 40,
    borderRadius: borderRadius.xl,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.md,
  },
  providerCardPrimaryActionText: {
    color: '#FFFFFF',
    fontSize: fontSize.sm,
    fontWeight: fontWeight.bold,
  },
  providerCardSecondaryAction: {
    flex: 1,
    minHeight: 40,
    borderRadius: borderRadius.xl,
    borderWidth: 1,
    borderColor: '#CBD5E1',
    backgroundColor: '#FFFFFF',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.md,
  },
  providerCardSecondaryActionText: {
    color: colors.text.primary,
    fontSize: fontSize.sm,
    fontWeight: fontWeight.bold,
  },
  providerCardTitle: {
    color: colors.text.primary,
    fontSize: fontSize.base,
    fontWeight: fontWeight.bold,
  },
  providerCardHint: {
    color: colors.text.secondary,
    fontSize: fontSize.sm,
    lineHeight: 20,
  },
  providerInlineLinkBtn: {
    alignSelf: 'flex-start',
    paddingVertical: 2,
  },
  providerInlineLinkText: {
    color: '#2563EB',
    fontSize: fontSize.sm,
    fontWeight: fontWeight.medium,
  },
  providerStatusPill: {
    alignSelf: 'flex-start',
    marginTop: spacing.xs,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: borderRadius.full,
  },
  providerStatusPillActive: {
    backgroundColor: '#DBEAFE',
  },
  providerStatusPillInactive: {
    backgroundColor: '#E2E8F0',
  },
  providerStatusText: {
    fontSize: fontSize.xs,
    fontWeight: fontWeight.bold,
  },
  providerStatusTextActive: {
    color: '#1D4ED8',
  },
  providerStatusTextInactive: {
    color: '#64748B',
  },
  sectionTitle: {
    color: colors.text.primary,
    fontSize: fontSize.base,
    fontWeight: fontWeight.bold,
  },
  sectionHint: {
    color: colors.text.secondary,
    fontSize: fontSize.sm,
    lineHeight: 21,
  },
  localImportCard: {
    gap: spacing.md,
    borderRadius: borderRadius.xxl,
    borderWidth: 1,
    borderColor: colors.border.light,
    backgroundColor: colors.surface,
    padding: spacing.md,
  },
  localImportHeader: {
    flexDirection: 'row',
    gap: spacing.md,
  },
  backBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: 4,
    paddingVertical: spacing.xs,
  },
  backBtnText: {
    color: colors.text.secondary,
    fontSize: fontSize.sm,
    fontWeight: fontWeight.medium,
  },
  formCard: {
    gap: spacing.sm,
    borderRadius: borderRadius.xxl,
    borderWidth: 1,
    borderColor: colors.border.light,
    backgroundColor: colors.surface,
    padding: spacing.md,
  },
  directoryField: {
    minHeight: 54,
    borderRadius: borderRadius.lg,
    borderWidth: 1,
    borderColor: colors.border.light,
    backgroundColor: '#F8FAFC',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    justifyContent: 'center',
    gap: 4,
  },
  directoryFieldLabel: {
    color: colors.text.secondary,
    fontSize: fontSize.xs,
    fontWeight: fontWeight.medium,
  },
  directoryFieldValue: {
    color: colors.text.primary,
    fontSize: fontSize.sm,
    fontWeight: fontWeight.medium,
  },
  actionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    flexWrap: 'wrap',
  },
  primaryBtn: {
    minHeight: 42,
    borderRadius: borderRadius.xl,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.md,
  },
  primaryBtnDisabled: {
    opacity: 0.72,
  },
  primaryBtnText: {
    color: '#FFFFFF',
    fontSize: fontSize.sm,
    fontWeight: fontWeight.bold,
  },
  secondaryBtn: {
    minHeight: 42,
    borderRadius: borderRadius.xl,
    borderWidth: 1,
    borderColor: '#BFDBFE',
    backgroundColor: '#EFF6FF',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.md,
  },
  secondaryBtnText: {
    color: '#2563EB',
    fontSize: fontSize.sm,
    fontWeight: fontWeight.bold,
  },
  dangerBtn: {
    minHeight: 42,
    borderRadius: borderRadius.xl,
    borderWidth: 1,
    borderColor: '#FECACA',
    backgroundColor: '#FEF2F2',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.md,
  },
  dangerBtnText: {
    color: '#DC2626',
    fontSize: fontSize.sm,
    fontWeight: fontWeight.bold,
  },
  directoryModalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(15,23,42,0.32)',
    justifyContent: 'flex-end',
  },
  directoryModalCard: {
    maxHeight: '78%',
    borderTopLeftRadius: borderRadius.xxl,
    borderTopRightRadius: borderRadius.xxl,
    backgroundColor: colors.surface,
    padding: spacing.md,
    gap: spacing.sm,
  },
  directoryModalHeader: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: spacing.md,
  },
  directoryModalHeaderTextWrap: {
    flex: 1,
    gap: 4,
  },
  directoryCloseBtn: {
    minHeight: 36,
    borderRadius: borderRadius.full,
    backgroundColor: '#EFF6FF',
    paddingHorizontal: spacing.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  directoryCloseBtnText: {
    color: '#2563EB',
    fontSize: fontSize.sm,
    fontWeight: fontWeight.bold,
  },
  directoryCurrentPathCard: {
    borderRadius: borderRadius.lg,
    backgroundColor: '#F8FAFC',
    padding: spacing.md,
    gap: 4,
  },
  directoryCurrentPathText: {
    color: colors.text.primary,
    fontSize: fontSize.sm,
    fontWeight: fontWeight.medium,
  },
  directoryErrorText: {
    color: '#B91C1C',
    fontSize: fontSize.sm,
    lineHeight: 20,
  },
  directoryLoadingWrap: {
    paddingVertical: spacing.xl,
    alignItems: 'center',
    justifyContent: 'center',
  },
  directoryList: {
    maxHeight: 340,
  },
  directoryListContent: {
    gap: spacing.sm,
    paddingBottom: spacing.md,
  },
  directoryItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    borderRadius: borderRadius.lg,
    borderWidth: 1,
    borderColor: colors.border.light,
    backgroundColor: '#FFFFFF',
    padding: spacing.md,
  },
  directoryItemIconWrap: {
    width: 34,
    height: 34,
    borderRadius: borderRadius.lg,
    backgroundColor: '#EFF6FF',
    alignItems: 'center',
    justifyContent: 'center',
  },
  directoryItemBody: {
    flex: 1,
    gap: 2,
  },
  directoryItemTitle: {
    color: colors.text.primary,
    fontSize: fontSize.sm,
    fontWeight: fontWeight.bold,
  },
  directoryItemPath: {
    color: colors.text.secondary,
    fontSize: fontSize.xs,
  },
  directoryItemChevron: {
    transform: [{ rotate: '180deg' }],
  },
  notice: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: spacing.md,
    alignItems: 'center',
  },
  noticeText: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: borderRadius.xl,
    backgroundColor: 'rgba(15,23,42,0.92)',
    color: '#FFFFFF',
    fontSize: fontSize.sm,
    fontWeight: fontWeight.medium,
  },

  /* Baidu provider detail — connected state */
  baiduStatusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  baiduStatusDotOk: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: '#10B981',
  },
  baiduStatusDotOff: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: colors.text.tertiary,
  },
  baiduStatusChipOk: {
    marginLeft: 'auto',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: borderRadius.full,
    backgroundColor: '#D1FAE5',
  },
  baiduStatusChipOkText: {
    fontSize: fontSize.xs,
    fontWeight: fontWeight.semibold,
    color: '#065F46',
  },
  baiduStatusChipOff: {
    marginLeft: 'auto',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: borderRadius.full,
    backgroundColor: colors.surfaceSecondary,
  },
  baiduStatusChipOffText: {
    fontSize: fontSize.xs,
    fontWeight: fontWeight.semibold,
    color: colors.text.tertiary,
  },
  baiduCurrentDirCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.surfaceSecondary,
    borderRadius: borderRadius.lg,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.md,
    gap: spacing.md,
  },
  baiduCurrentDirTextCol: {
    flex: 1,
    minWidth: 0,            // allow the Text child to actually shrink
  },
  baiduChangeDirBtn: {
    flexShrink: 0,
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
    borderRadius: borderRadius.full,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.primary,
  },
  baiduChangeDirBtnText: {
    fontSize: fontSize.sm,
    fontWeight: fontWeight.semibold,
    color: colors.primary,
  },
  baiduReconnectBtn: {
    alignItems: 'center',
    paddingVertical: 10,
    borderRadius: borderRadius.lg,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border.light,
  },
  baiduReconnectBtnText: {
    fontSize: fontSize.sm,
    fontWeight: fontWeight.semibold,
    color: colors.text.primary,
  },
  dangerTextBtn: {
    alignItems: 'center',
    paddingVertical: 8,
  },
  dangerTextBtnText: {
    fontSize: fontSize.sm,
    color: '#EF4444',
  },
  baiduAuthCta: {
    marginTop: spacing.md,
  },

  /* Picker: bottom-aligned "use this dir" CTA */
  directoryUseBtn: {
    marginTop: spacing.md,
    paddingVertical: 12,
    borderRadius: borderRadius.lg,
    backgroundColor: colors.primary,
    alignItems: 'center',
  },
  directoryUseBtnText: {
    fontSize: fontSize.base,
    fontWeight: fontWeight.bold,
    color: colors.text.inverse,
  },
  directoryItemParent: {
    backgroundColor: colors.surfaceSecondary,
  },

  /* Rescan: secondary icon button on the provider card */
  rescanIconBtn: {
    width: 36,
    height: 36,
    borderRadius: borderRadius.full,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
