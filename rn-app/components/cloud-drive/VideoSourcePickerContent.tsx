import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import {
  ChevronLeft,
  ChevronRight,
  Cloud,
  File,
  Film,
  Folder,
  HardDriveDownload,
  Settings,
} from 'lucide-react-native';
import { borderRadius, colors, fontSize, fontWeight, spacing } from '../../constants/theme';
import {
  getBaiduPanBinding,
  getConfiguredCloudProviders,
  getDefaultCloudProvider,
  type CloudVideoProvider,
} from '../../lib/content/cloud-drive-bindings';
import { listBaiduPanDirectory, listBaiduPanVideos } from '../../lib/content/baidu-pan-fs';
import { buildCloudReferenceIdentity, createCloudVideoReference, listUserVideos, type UserVideoEntry } from '../../lib/content/user-videos';

export type SelectedCloudVideoFile = {
  provider: CloudVideoProvider;
  remotePath: string;
  remoteFileId?: number;
  remoteFileName: string;
  fileSize: number;
};

type VideoSourcePickerContentProps = {
  mode?: 'import' | 'bind';
  allowLocalImport?: boolean;
  onImportLocalVideo?: () => Promise<void> | void;
  onCloudImportSuccess?: (entry: UserVideoEntry) => void;
  onDownloadCloudVideo?: (file: SelectedCloudVideoFile) => Promise<void> | void;
  onCloudFileSelected?: (file: SelectedCloudVideoFile) => Promise<void> | void;
  onRequestGoToMountDrives?: () => void;
  fixedProvider?: CloudVideoProvider | null;
  visible?: boolean;
  /**
   * Wire id of the collection the next import should land in. Used
   * by the cloud-browser import path (which calls
   * `createCloudVideoReference` directly, not via `onCloudFileSelected`,
   * so the parent has to pass the target down explicitly).
   */
  collectionId?: string;
};

type PickerView = 'overview' | 'cloud_browser' | 'cloud_video_list';

type UnifiedFileItem = {
  key: string;
  name: string;
  isDirectory: boolean;
  size: number;
  thumbnailUrl?: string;
  baiduFsId?: number;
  baiduPath?: string;
};

function formatFileSize(bytes: number): string {
  if (bytes === 0) return '';
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function isVideoFile(name: string): boolean {
  return /\.(mp4|mov|m4v|mkv|webm|avi|ts|m2ts|3gp)$/i.test(name);
}

export function VideoSourcePickerContent({
  mode = 'import',
  allowLocalImport = false,
  onImportLocalVideo,
  onCloudImportSuccess,
  onDownloadCloudVideo,
  onCloudFileSelected,
  onRequestGoToMountDrives,
  fixedProvider = null,
  visible,
  collectionId,
}: VideoSourcePickerContentProps) {
  const [activeView, setActiveView] = useState<PickerView>('overview');
  const [configuredProviders, setConfiguredProviders] = useState<CloudVideoProvider[]>([]);
  const [defaultProvider, setDefaultProvider] = useState<CloudVideoProvider | null>(null);
  const [isLoadingProviders, setIsLoadingProviders] = useState(false);
  const [isImportingLocal, setIsImportingLocal] = useState(false);

  const [activeBrowserProvider, setActiveBrowserProvider] = useState<CloudVideoProvider | null>(null);
  const [pathStack, setPathStack] = useState<string[]>([]);
  const [fileItems, setFileItems] = useState<UnifiedFileItem[]>([]);
  const [isLoadingFiles, setIsLoadingFiles] = useState(false);
  const [filesError, setFilesError] = useState('');
  const [importingKey, setImportingKey] = useState<string | null>(null);
  const [downloadingKey, setDownloadingKey] = useState<string | null>(null);
  const [importedCloudIdentitySet, setImportedCloudIdentitySet] = useState<Set<string>>(new Set());

  const currentPath = pathStack[pathStack.length - 1] ?? '/';

  const loadProviders = useCallback(async () => {
    setIsLoadingProviders(true);
    try {
      const [configured, def, userVideos] = await Promise.all([
        getConfiguredCloudProviders(),
        getDefaultCloudProvider(),
        listUserVideos().catch(() => [] as UserVideoEntry[]),
      ]);
      setConfiguredProviders(fixedProvider ? configured.filter((item) => item === fixedProvider) : configured);
      setDefaultProvider(def);
      setImportedCloudIdentitySet(new Set(
        userVideos
          .filter((item) => item.sourceType === 'cloud_reference' && item.provider)
          .map((item) => buildCloudReferenceIdentity(item.provider!, item.remotePath, item.remoteFileId)),
      ));
    } finally {
      setIsLoadingProviders(false);
    }
  }, [fixedProvider]);

  useEffect(() => {
    if (visible === false) return;
    void loadProviders();
  }, [loadProviders, visible]);

  useEffect(() => {
    if (visible) {
      setActiveView('overview');
      setActiveBrowserProvider(null);
      setPathStack([]);
      setFileItems([]);
      setFilesError('');
    }
  }, [visible]);

  const filterAlreadyImportedCloudItems = useCallback((provider: CloudVideoProvider, items: UnifiedFileItem[]) => {
    if (mode !== 'import' || importedCloudIdentitySet.size === 0) {
      return items;
    }

    return items.filter((item) => {
      if (item.isDirectory) {
        return true;
      }

      const identity = buildCloudReferenceIdentity(
        provider,
        item.baiduPath,
        item.baiduFsId == null ? undefined : String(item.baiduFsId),
      );

      return !importedCloudIdentitySet.has(identity);
    });
  }, [importedCloudIdentitySet, mode]);

  const loadFilesAtPath = useCallback(async (provider: CloudVideoProvider, path: string) => {
    setIsLoadingFiles(true);
    setFilesError('');
    try {
      const baiduBinding = await getBaiduPanBinding();
      if (!baiduBinding?.token?.accessToken) throw new Error('百度网盘未授权');
      const items = await listBaiduPanDirectory(baiduBinding.token.accessToken, path);
      setFileItems(filterAlreadyImportedCloudItems(provider, items.map((item) => ({
        key: `${item.fsId}`,
        name: item.name,
        isDirectory: item.isDirectory,
        size: item.size,
        baiduFsId: item.fsId,
        baiduPath: item.path,
      }))));
    } catch (e) {
      setFilesError(e instanceof Error ? e.message : '加载失败，请检查网络或配置');
      setFileItems([]);
    } finally {
      setIsLoadingFiles(false);
    }
  }, [filterAlreadyImportedCloudItems]);

  const handleOpenBrowser = useCallback(async (provider: CloudVideoProvider) => {
    let rootPath = '/';
    const binding = await getBaiduPanBinding();
    rootPath = binding?.rootPath || '/';
    setActiveBrowserProvider(provider);
    setPathStack([rootPath]);
    setFileItems([]);
    setActiveView('cloud_browser');
    await loadFilesAtPath(provider, rootPath);
  }, [loadFilesAtPath]);

  const handleOpenQuickVideoList = useCallback(async (provider: CloudVideoProvider) => {
    let rootPath = '/';
    setIsLoadingFiles(true);
    setFilesError('');
    setActiveBrowserProvider(provider);
    setPathStack([]);
    setFileItems([]);
    setActiveView('cloud_video_list');

    try {
      const binding = await getBaiduPanBinding();
      if (!binding?.token?.accessToken) throw new Error('百度网盘未授权');
      rootPath = binding.rootPath || '/';
      setPathStack([rootPath]);
      const items = await listBaiduPanVideos(binding.token.accessToken, rootPath);
      setFileItems(filterAlreadyImportedCloudItems(provider, items.map((item) => ({
        key: `${item.fsId}`,
        name: item.name,
        isDirectory: false,
        size: item.size,
        baiduFsId: item.fsId,
        baiduPath: item.path,
        thumbnailUrl: item.thumbnailUrl,
      }))));
    } catch (e) {
      setFilesError(e instanceof Error ? e.message : '加载失败，请检查网络或配置');
      setFileItems([]);
    } finally {
      setIsLoadingFiles(false);
    }
  }, [filterAlreadyImportedCloudItems]);

  const handleNavigateInto = useCallback(async (item: UnifiedFileItem) => {
    if (!item.isDirectory || !activeBrowserProvider) return;
    const targetPath = item.baiduPath ?? '/';
    const newStack = [...pathStack, targetPath];
    setPathStack(newStack);
    await loadFilesAtPath(activeBrowserProvider, targetPath);
  }, [activeBrowserProvider, pathStack, loadFilesAtPath]);

  const handleBrowserBack = useCallback(async () => {
    if (!activeBrowserProvider) return;
    if (activeView === 'cloud_video_list') {
      setActiveView('overview');
      setActiveBrowserProvider(null);
      setPathStack([]);
      setFileItems([]);
      return;
    }
    if (pathStack.length <= 1) {
      setActiveView('overview');
      setActiveBrowserProvider(null);
      setPathStack([]);
      return;
    }
    const newStack = pathStack.slice(0, -1);
    setPathStack(newStack);
    await loadFilesAtPath(activeBrowserProvider, newStack[newStack.length - 1]);
  }, [activeBrowserProvider, activeView, pathStack, loadFilesAtPath]);

  const handleImportCloudFile = useCallback(async (item: UnifiedFileItem) => {
    if (!activeBrowserProvider || importingKey) return;
    setImportingKey(item.key);
    try {
      if (mode === 'bind') {
        await onCloudFileSelected?.({
          provider: activeBrowserProvider,
          remotePath: item.baiduPath ?? '/',
          remoteFileId: item.baiduFsId,
          remoteFileName: item.name,
          fileSize: item.size,
        });
        return;
      }
      const entry = await createCloudVideoReference({
        provider: activeBrowserProvider,
        title: item.name,
        remotePath: item.baiduPath,
        remoteFileId: item.baiduFsId,
        remoteFileName: item.name,
        fileSize: item.size,
        // Without this, the cloud-browser import path (which calls
        // createCloudVideoReference directly, bypassing the parent)
        // would always land in the default collection — even when
        // the user explicitly picked a custom one in the inline
        // selector.
        collectionId,
      });
      if (entry && onCloudImportSuccess) {
        onCloudImportSuccess(entry);
      }
      if (mode === 'import') {
        setFileItems((prev) => prev.filter((current) => current.key !== item.key));
        setImportedCloudIdentitySet((prev) => {
          const next = new Set(prev);
          next.add(buildCloudReferenceIdentity(
            activeBrowserProvider,
            item.baiduPath,
            item.baiduFsId == null ? undefined : String(item.baiduFsId),
          ));
          return next;
        });
      }
    } catch (e) {
      Alert.alert(mode === 'bind' ? '绑定失败' : '云端导入失败', e instanceof Error ? e.message : '请稍后重试');
    } finally {
      setImportingKey(null);
    }
  }, [activeBrowserProvider, collectionId, importingKey, mode, onCloudFileSelected, onCloudImportSuccess]);

  const handleDownloadCloudFile = useCallback(async (item: UnifiedFileItem) => {
    if (!activeBrowserProvider || !onDownloadCloudVideo || downloadingKey || mode !== 'import') {
      return;
    }
    setDownloadingKey(item.key);
    try {
      await onDownloadCloudVideo({
        provider: activeBrowserProvider,
        remotePath: item.baiduPath ?? '/',
        remoteFileId: item.baiduFsId,
        remoteFileName: item.name,
        fileSize: item.size,
      });
    } catch (e) {
      Alert.alert('加入下载失败', e instanceof Error ? e.message : '请稍后重试');
    } finally {
      setDownloadingKey(null);
    }
  }, [activeBrowserProvider, downloadingKey, mode, onDownloadCloudVideo]);

  const handleReloadCurrentView = useCallback(async () => {
    if (!activeBrowserProvider) {
      return;
    }
    if (activeView === 'cloud_video_list') {
      await handleOpenQuickVideoList(activeBrowserProvider);
      return;
    }
    await loadFilesAtPath(activeBrowserProvider, currentPath);
  }, [activeBrowserProvider, activeView, currentPath, handleOpenQuickVideoList, loadFilesAtPath]);

  const handleImportLocalVideo = useCallback(async () => {
    if (!onImportLocalVideo || isImportingLocal) return;
    setIsImportingLocal(true);
    try {
      await onImportLocalVideo();
    } finally {
      setIsImportingLocal(false);
    }
  }, [isImportingLocal, onImportLocalVideo]);

  if (activeView === 'cloud_browser' || activeView === 'cloud_video_list') {
    const providerLabel = activeBrowserProvider === 'baidu_pan' ? '百度网盘' : '云盘';
    const isQuickListView = activeView === 'cloud_video_list';
    const quickListTitle = '快捷视频列表';
    const quickListHint = '已按当前挂载根目录递归列出可导入视频';
    return (
      <View style={styles.container}>
        <Pressable style={styles.backBtn} onPress={handleBrowserBack}>
          <ChevronLeft size={18} color={colors.text.secondary} />
          <Text style={styles.backBtnText}>
            {isQuickListView || pathStack.length <= 1 ? `返回来源列表` : '返回上级'}
          </Text>
        </Pressable>
        <Text style={styles.browserProvider}>{providerLabel}</Text>
        <Text style={styles.browserPath} numberOfLines={1}>
          {isQuickListView ? `${quickListTitle} · ${pathStack[0] ?? '/'}` : currentPath}
        </Text>
        {isLoadingFiles ? (
          <View style={styles.browserCenter}>
            <ActivityIndicator size="small" color={colors.primary} />
            <Text style={styles.browserHint}>{isQuickListView ? '正在拉取视频列表…' : '加载中…'}</Text>
          </View>
        ) : filesError ? (
          <View style={styles.browserCenter}>
            <Text style={styles.browserError}>{filesError}</Text>
            <Pressable
              style={styles.retryBtn}
              onPress={handleReloadCurrentView}
            >
              <Text style={styles.retryBtnText}>重试</Text>
            </Pressable>
          </View>
        ) : fileItems.length === 0 ? (
          <View style={styles.browserCenter}>
            <Text style={styles.browserHint}>{isQuickListView ? '没有找到可导入的视频' : '当前目录为空'}</Text>
          </View>
        ) : (
          <ScrollView showsVerticalScrollIndicator={false} style={styles.scroll} contentContainerStyle={styles.scrollContent}>
            {isQuickListView ? (
              <View style={styles.quickListSummaryCard}>
                <Text style={styles.quickListSummaryTitle}>{quickListTitle}</Text>
                <Text style={styles.quickListSummaryText}>{quickListHint}，共 {fileItems.length} 个结果</Text>
              </View>
            ) : null}
            {fileItems.map((item) => {
              const isVideo = isVideoFile(item.name);
              const isImportingThis = importingKey === item.key;
              const isDownloadingThis = downloadingKey === item.key;
              const shouldShowThumbnail = isQuickListView && activeBrowserProvider === 'baidu_pan' && isVideo && !!item.thumbnailUrl;
              return (
                <Pressable
                  key={item.key}
                  style={styles.fileItem}
                  onPress={() => item.isDirectory ? handleNavigateInto(item) : undefined}
                  disabled={!item.isDirectory && !isVideo}
                >
                  {shouldShowThumbnail ? (
                    <Image source={{ uri: item.thumbnailUrl }} style={styles.fileThumbnail} resizeMode="cover" />
                  ) : (
                    <View style={styles.fileIconWrap}>
                      {item.isDirectory
                        ? <Folder size={18} color="#F59E0B" />
                        : isVideo
                          ? <Film size={18} color="#7C3AED" />
                          : <File size={18} color="#94A3B8" />}
                    </View>
                  )}
                  <View style={styles.fileBody}>
                    <Text
                      style={[styles.fileName, !item.isDirectory && !isVideo && styles.fileNameMuted]}
                      numberOfLines={2}
                    >
                      {item.name}
                    </Text>
                    {isQuickListView ? (
                      <Text style={styles.filePath} numberOfLines={1}>{item.baiduPath ?? '/'}</Text>
                    ) : null}
                    {!item.isDirectory && item.size > 0 ? (
                      <Text style={styles.fileSize}>{formatFileSize(item.size)}</Text>
                    ) : null}
                  </View>
                  {item.isDirectory ? (
                    <ChevronRight size={16} color={colors.text.secondary} />
                  ) : isVideo ? (
                    <View style={styles.fileActionRow}>
                      {mode === 'import' && onDownloadCloudVideo ? (
                        <Pressable
                          style={[styles.downloadFileBtn, isDownloadingThis && styles.importFileBtnDisabled]}
                          onPress={() => handleDownloadCloudFile(item)}
                          disabled={isDownloadingThis || !!downloadingKey || !!importingKey}
                        >
                          {isDownloadingThis ? (
                            <ActivityIndicator size="small" color="#0F766E" />
                          ) : (
                            <HardDriveDownload size={14} color="#0F766E" />
                          )}
                          <Text style={styles.downloadFileBtnText}>{isDownloadingThis ? '加入中' : '下载'}</Text>
                        </Pressable>
                      ) : null}
                      <Pressable
                        style={[styles.importFileBtn, isImportingThis && styles.importFileBtnDisabled]}
                        onPress={() => handleImportCloudFile(item)}
                        disabled={isImportingThis || !!importingKey || isDownloadingThis}
                      >
                        {isImportingThis ? (
                          <ActivityIndicator size="small" color="#7C3AED" />
                        ) : (
                          <HardDriveDownload size={14} color="#7C3AED" />
                        )}
                        <Text style={styles.importFileBtnText}>
                          {isImportingThis ? (mode === 'bind' ? '绑定中' : '导入中') : (mode === 'bind' ? '绑定' : '导入')}
                        </Text>
                      </Pressable>
                    </View>
                  ) : null}
                </Pressable>
              );
            })}
          </ScrollView>
        )}
      </View>
    );
  }

  return (
    <View style={styles.container}>
      {isLoadingProviders ? (
        <View style={styles.browserCenter}>
          <ActivityIndicator size="small" color={colors.primary} />
        </View>
      ) : (
        <ScrollView showsVerticalScrollIndicator={false} style={styles.scroll} contentContainerStyle={styles.scrollContent}>
          {configuredProviders.length === 0 ? (
            <View style={styles.emptyCard}>
              <Text style={styles.emptyTitle}>还未连接任何网盘</Text>
              <Text style={styles.emptyHint}>
                前往「我的」→「我的网盘」完成百度网盘授权后，即可在此浏览并{mode === 'bind' ? '绑定' : '导入'}视频文件。
              </Text>
              {onRequestGoToMountDrives ? (
                <Pressable style={styles.mountBtn} onPress={onRequestGoToMountDrives}>
                  <Settings size={14} color="#FFFFFF" />
                  <Text style={styles.mountBtnText}>去我的网盘</Text>
                </Pressable>
              ) : null}
            </View>
          ) : (
            <>
              {configuredProviders.includes('baidu_pan') ? (
                <View style={styles.providerCard}>
                  <View style={styles.providerCardTop}>
                    <View style={[styles.providerIconWrap, { backgroundColor: '#EFF6FF' }]}>
                      <Cloud size={18} color="#2563EB" />
                    </View>
                    <View style={styles.providerCardBody}>
                      <Text style={styles.providerTitle}>百度网盘</Text>
                      <View style={[styles.statusPill, styles.statusPillActive]}>
                        <Text style={[styles.statusPillText, styles.statusPillTextActive]}>
                          已连接{defaultProvider === 'baidu_pan' ? ' · 默认' : ''}
                        </Text>
                      </View>
                    </View>
                  </View>
                  <Text style={styles.deckpackHint}>{mode === 'bind' ? '选择当前推荐视频对应的文件后会建立绑定关系' : '选择视频文件后会建立云盘关系记录'}</Text>
                  <View style={styles.providerActionsRow}>
                    <Pressable style={[styles.browseBtn, styles.browseBtnBaidu]} onPress={() => handleOpenBrowser('baidu_pan')}>
                      <Folder size={14} color="#2563EB" />
                      <Text style={[styles.browseBtnText, styles.browseBtnTextBaidu]}>浏览目录</Text>
                    </Pressable>
                    <Pressable style={[styles.browseBtn, styles.browseBtnBaiduSecondary]} onPress={() => handleOpenQuickVideoList('baidu_pan')}>
                      <Film size={14} color="#2563EB" />
                      <Text style={[styles.browseBtnText, styles.browseBtnTextBaidu]}>快捷视频</Text>
                    </Pressable>
                  </View>
                </View>
              ) : null}
            </>
          )}

          {mode === 'import' && allowLocalImport ? (
            <View style={styles.providerCard}>
              <View style={styles.providerCardTop}>
                <View style={[styles.providerIconWrap, { backgroundColor: '#F5F3FF' }]}> 
                  <HardDriveDownload size={18} color="#7C3AED" />
                </View>
                <View style={styles.providerCardBody}>
                  <Text style={styles.providerTitle}>本地视频</Text>
                  <Text style={styles.localHint}>从设备存储选取视频文件导入</Text>
                </View>
              </View>
              <Pressable
                style={[styles.browseBtn, styles.browseBtnLocal, isImportingLocal && styles.browseBtnDisabled]}
                onPress={handleImportLocalVideo}
                disabled={isImportingLocal}
              >
                {isImportingLocal ? (
                  <ActivityIndicator size="small" color="#7C3AED" />
                ) : (
                  <HardDriveDownload size={14} color="#7C3AED" />
                )}
                <Text style={[styles.browseBtnText, styles.browseBtnTextLocal]}>
                  {isImportingLocal ? '导入中…' : '导入本地视频'}
                </Text>
              </Pressable>
            </View>
          ) : null}

          {/* 底部 "管理我的网盘" 入口已删除:用户可以从「我的」tab 进网盘设置,
              弹窗里再多一个入口是冗余的。空状态时仍保留 "去我的网盘" 按钮 (上方)。 */}
        </ScrollView>
      )}
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
  backBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: 4,
    paddingVertical: spacing.xs,
    marginBottom: spacing.xs,
  },
  backBtnText: {
    color: colors.text.secondary,
    fontSize: fontSize.sm,
    fontWeight: fontWeight.medium,
  },
  browserProvider: {
    fontSize: fontSize.sm,
    color: colors.text.primary,
    fontWeight: fontWeight.bold,
    marginBottom: 2,
  },
  browserPath: {
    fontSize: fontSize.xs,
    color: colors.text.secondary,
    fontWeight: fontWeight.medium,
    marginBottom: spacing.sm,
    paddingHorizontal: 2,
  },
  quickListSummaryCard: {
    padding: spacing.md,
    borderRadius: borderRadius.xl,
    backgroundColor: '#F8FAFC',
    borderWidth: 1,
    borderColor: colors.border.light,
    gap: 4,
  },
  quickListSummaryTitle: {
    color: colors.text.primary,
    fontSize: fontSize.sm,
    fontWeight: fontWeight.bold,
  },
  quickListSummaryText: {
    color: colors.text.secondary,
    fontSize: fontSize.xs,
    lineHeight: 18,
  },
  browserCenter: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.xl,
  },
  browserHint: {
    fontSize: fontSize.sm,
    color: colors.text.secondary,
  },
  browserError: {
    fontSize: fontSize.sm,
    color: '#B91C1C',
    textAlign: 'center',
    lineHeight: 20,
    paddingHorizontal: spacing.md,
  },
  retryBtn: {
    paddingHorizontal: spacing.md,
    paddingVertical: 8,
    borderRadius: borderRadius.lg,
    backgroundColor: '#EFF6FF',
  },
  retryBtnText: {
    fontSize: fontSize.sm,
    color: colors.primary,
    fontWeight: fontWeight.bold,
  },
  fileItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    padding: spacing.md,
    borderRadius: borderRadius.xl,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border.light,
  },
  fileIconWrap: {
    width: 36,
    height: 36,
    borderRadius: borderRadius.md,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#F8FAFC',
  },
  fileThumbnail: {
    width: 52,
    height: 52,
    borderRadius: borderRadius.lg,
    backgroundColor: '#E2E8F0',
  },
  fileBody: {
    flex: 1,
    gap: 2,
  },
  fileName: {
    color: colors.text.primary,
    fontSize: fontSize.sm,
    fontWeight: fontWeight.medium,
    lineHeight: 20,
  },
  fileNameMuted: {
    color: colors.text.secondary,
  },
  filePath: {
    color: colors.text.secondary,
    fontSize: fontSize.xs,
  },
  fileSize: {
    color: colors.text.secondary,
    fontSize: fontSize.xs,
  },
  importFileBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 7,
    borderRadius: borderRadius.lg,
    borderWidth: 1,
    borderColor: '#DDD6FE',
    backgroundColor: '#F5F3FF',
  },
  importFileBtnDisabled: {
    opacity: 0.72,
  },
  importFileBtnText: {
    color: '#7C3AED',
    fontSize: fontSize.xs,
    fontWeight: fontWeight.bold,
  },
  fileActionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  downloadFileBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 7,
    borderRadius: borderRadius.lg,
    borderWidth: 1,
    borderColor: '#99F6E4',
    backgroundColor: '#F0FDFA',
  },
  downloadFileBtnText: {
    color: '#0F766E',
    fontSize: fontSize.xs,
    fontWeight: fontWeight.bold,
  },
  emptyCard: {
    padding: spacing.lg,
    borderRadius: borderRadius.xxl,
    borderWidth: 1,
    borderColor: colors.border.light,
    backgroundColor: colors.surface,
    gap: spacing.sm,
  },
  emptyTitle: {
    color: colors.text.primary,
    fontSize: fontSize.base,
    fontWeight: fontWeight.bold,
  },
  emptyHint: {
    color: colors.text.secondary,
    fontSize: fontSize.sm,
    lineHeight: 21,
  },
  mountBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    alignSelf: 'flex-start',
    marginTop: spacing.xs,
    paddingHorizontal: spacing.md,
    paddingVertical: 10,
    borderRadius: borderRadius.xl,
    backgroundColor: colors.primary,
  },
  mountBtnText: {
    color: '#FFFFFF',
    fontSize: fontSize.sm,
    fontWeight: fontWeight.bold,
  },
  providerCard: {
    padding: spacing.md,
    borderRadius: borderRadius.xxl,
    borderWidth: 1,
    borderColor: colors.border.light,
    backgroundColor: colors.surface,
    gap: spacing.sm,
  },
  providerCardTop: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.md,
  },
  providerIconWrap: {
    width: 42,
    height: 42,
    borderRadius: borderRadius.lg,
    alignItems: 'center',
    justifyContent: 'center',
  },
  providerCardBody: {
    flex: 1,
    gap: 6,
  },
  providerTitle: {
    color: colors.text.primary,
    fontSize: fontSize.base,
    fontWeight: fontWeight.bold,
  },
  deckpackHint: {
    fontSize: fontSize.xs,
    color: colors.text.secondary,
    lineHeight: 18,
    paddingLeft: 42 + spacing.md,
  },
  providerActionsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
  statusPill: {
    alignSelf: 'flex-start',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: borderRadius.full,
  },
  statusPillActive: {
    backgroundColor: '#DCFCE7',
  },
  statusPillText: {
    fontSize: fontSize.xs,
    fontWeight: fontWeight.bold,
  },
  statusPillTextActive: {
    color: '#166534',
  },
  browseBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    alignSelf: 'flex-start',
    paddingHorizontal: spacing.md,
    paddingVertical: 10,
    borderRadius: borderRadius.xl,
    borderWidth: 1,
  },
  browseBtnBaidu: {
    borderColor: '#BFDBFE',
    backgroundColor: '#EFF6FF',
  },
  browseBtnBaiduSecondary: {
    borderColor: '#DBEAFE',
    backgroundColor: '#F8FAFF',
  },
  browseBtnLocal: {
    borderColor: '#DDD6FE',
    backgroundColor: '#F5F3FF',
  },
  browseBtnDisabled: {
    opacity: 0.72,
  },
  browseBtnText: {
    fontSize: fontSize.sm,
    fontWeight: fontWeight.bold,
  },
  browseBtnTextBaidu: {
    color: '#2563EB',
  },
  browseBtnTextLocal: {
    color: '#7C3AED',
  },
  localHint: {
    color: colors.text.secondary,
    fontSize: fontSize.sm,
    lineHeight: 20,
  },
  manageLinkRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    paddingVertical: spacing.sm,
  },
  manageLinkText: {
    color: colors.text.secondary,
    fontSize: fontSize.sm,
    fontWeight: fontWeight.medium,
  },
});
