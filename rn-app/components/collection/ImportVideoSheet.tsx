/**
 * ImportVideoSheet — full-screen bottom sheet for importing a video
 * into a user collection. Self-contained: owns the inline target
 * selector, the collection picker sub-sheet, and the source picker
 * (local file / cloud drive). Calls `onImportSuccess(entry)` after a
 * successful import so the caller can refresh whatever it owns
 * (home page cards, detail page, etc.).
 *
 * Reused by:
 *   - `app/(tabs)/videos.tsx` — home page, picks a target on open.
 *   - `app/collection/[id].tsx` — detail page, opens from the
 *     three-dot menu and pre-selects the current collection.
 *
 * Why one component for both call sites:
 *   Both flows need identical state machinery (target ref, picker
 *   sub-sheet, lazy default creation, collectionId propagation
 *   through VideoSourcePickerContent's internal cloud import path).
 *   Copy-pasting would re-introduce the cloud-import-ignores-target
 *   bug we just fixed. Extraction is the only safe move.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { Platform } from 'react-native';
import { Check, ChevronDown, Folder, Plus, X } from 'lucide-react-native';
import {
  VideoSourcePickerContent,
  type SelectedCloudVideoFile,
} from '../cloud-drive/VideoSourcePickerContent';
import {
  createUserCollection,
  encodeUserCollectionId,
  getOrCreateDefaultCollection,
  listUserCollections,
  type UserCollectionRow,
} from '../../lib/content/user-collections';
import {
  createCloudVideoReference,
  pickAndImportLocalVideo,
  isDuplicateLocalVideoImportError,
  triggerImportedVideoSubtitleGeneration,
  type UserVideoEntry,
} from '../../lib/content/user-videos';
import { colors, spacing, borderRadius, fontSize, fontWeight } from '../../constants/theme';

const LOG_PREFIX = '[ImportVideoSheet]';

function warnTrace(message: string, payload?: unknown) {
  if (payload === undefined) {
    console.warn(`${LOG_PREFIX} ${message}`);
    return;
  }
  console.warn(`${LOG_PREFIX} ${message}`, payload);
}

export interface ImportVideoSheetProps {
  visible: boolean;
  /**
   * Wire id of the collection to pre-select when the sheet opens.
   * When absent the sheet lazy-creates the user's default
   * collection and pre-selects that. The user can change the
   * target via the inline selector at any time before picking a
   * file.
   */
  defaultCollectionId?: string;
  onClose: () => void;
  /**
   * Fired after a successful import. Receives the created entry so
   * the caller can update its own state (e.g. refresh the home
   * grid or the collection detail page) and trigger downstream
   * work like subtitle auto-generation. The sheet has already
   * hidden itself by the time this fires.
   */
  onImportSuccess?: (entry: { id: string; title: string; sourceType?: string }) => void;
}

type PickerMode = 'list' | 'create';

export function ImportVideoSheet({
  visible,
  defaultCollectionId,
  onClose,
  onImportSuccess,
}: ImportVideoSheetProps) {
  // ── Target state ──────────────────────────────────────────────
  const [targetCollectionId, setTargetCollectionId] = useState<string | null>(null);
  // Mirror the state in a ref so the import handlers read the
  // latest value at call time (no stale closure when the user
  // changes the target mid-import).
  const targetCollectionIdRef = useRef<string | null>(null);
  useEffect(() => {
    targetCollectionIdRef.current = targetCollectionId;
  }, [targetCollectionId]);

  // ── Picker sub-sheet state ────────────────────────────────────
  const [isCollectionPickerVisible, setIsCollectionPickerVisible] = useState(false);
  const [userCollectionsForPicker, setUserCollectionsForPicker] = useState<UserCollectionRow[]>([]);
  const [isCollectionPickerLoading, setIsCollectionPickerLoading] = useState(false);
  const [pickerMode, setPickerMode] = useState<PickerMode>('list');
  const [pickerNewTitle, setPickerNewTitle] = useState('');

  // ── Import-in-flight guard ────────────────────────────────────
  const [isImporting, setIsImporting] = useState(false);

  // Refs to the current visible state, used by the source picker's
  // cloud-internal import path so it can see the latest values
  // without re-creating the component.
  const targetCollectionIdRenderRef = useRef<string | null>(null);
  targetCollectionIdRenderRef.current = targetCollectionId;

  // ── Open / close bookkeeping ──────────────────────────────────
  // When the sheet opens, seed the target to `defaultCollectionId`
  // (if provided) or lazy-create the user's default. Reset to
  // `null` first so a stale value from the previous open doesn't
  // carry over.
  useEffect(() => {
    if (!visible) return;
    setTargetCollectionId(defaultCollectionId ?? null);
    void primeDefaultTarget(defaultCollectionId ?? null);
  }, [visible, defaultCollectionId]);

  const primeDefaultTarget = useCallback(async (seed: string | null) => {
    // If a seed is provided (caller knows the target), respect it
    // and don't override. Otherwise lazy-create the default and
    // set it ONLY if the user hasn't already picked something in
    // this session.
    if (seed) {
      // seed already in state via the open effect; nothing to do.
      return;
    }
    try {
      const row = await getOrCreateDefaultCollection();
      const defaultWireId = encodeUserCollectionId(row.id);
      setTargetCollectionId((current) => current ?? defaultWireId);
    } catch (err) {
      warnTrace('primeDefaultTarget failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }, []);

  // ── Picker sub-sheet handlers ──────────────────────────────────
  const handleOpenCollectionPicker = useCallback(async () => {
    setIsCollectionPickerVisible(true);
    setPickerMode('list');
    setPickerNewTitle('');
    setIsCollectionPickerLoading(true);
    try {
      const list = await listUserCollections();
      setUserCollectionsForPicker(list);
    } catch (err) {
      warnTrace('loadUserCollectionsForPicker failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      setUserCollectionsForPicker([]);
    } finally {
      setIsCollectionPickerLoading(false);
    }
  }, []);

  const handlePickCollection = useCallback((wireId: string) => {
    setTargetCollectionId(wireId);
    setIsCollectionPickerVisible(false);
  }, []);

  const handleStartQuickCreate = useCallback(() => {
    setPickerMode('create');
    setPickerNewTitle('');
  }, []);

  const handleCancelQuickCreate = useCallback(() => {
    setPickerMode('list');
    setPickerNewTitle('');
  }, []);

  const handleSubmitQuickCreate = useCallback(async () => {
    const title = pickerNewTitle.trim();
    if (!title) {
      Alert.alert('合集名不能为空');
      return;
    }
    try {
      const row = await createUserCollection({ title });
      setUserCollectionsForPicker((prev) => [row, ...prev.filter((r) => r.id !== row.id)]);
      setTargetCollectionId(encodeUserCollectionId(row.id));
      setIsCollectionPickerVisible(false);
      setPickerMode('list');
      setPickerNewTitle('');
    } catch (err) {
      Alert.alert('创建失败', err instanceof Error ? err.message : String(err));
    }
  }, [pickerNewTitle]);

  // ── Import flow (mirrors the home page's importAfterPicker) ───
  const runImport = useCallback(
    async (importFn: () => Promise<UserVideoEntry | null>, options?: { force?: boolean }) => {
      if (isImporting) return;
      setIsImporting(true);
      try {
        const entry = await importFn();
        if (!entry) return;
        onClose();
        if (onImportSuccess) {
          onImportSuccess({ id: entry.id, title: entry.title, sourceType: entry.sourceType });
        }
        // Fire-and-forget: kick off subtitle auto-generation.
        // Honors the pro / quota gate silently for local files;
        // runs immediately for cloud references. See
        // `triggerImportedVideoSubtitleGeneration` for the full
        // gate semantics.
        void triggerImportedVideoSubtitleGeneration(entry);
      } catch (err) {
        if (isDuplicateLocalVideoImportError(err)) {
          // The dedup hit a same-name (and same-size if known)
          // entry. Default to a non-destructive "Import anyway"
          // prompt — if the user has an orphan entry, this is the
          // escape hatch; if they re-picked the same file, they
          // can back out. Skipped when `force` already came from
          // a retry (avoid bouncing into the same dialog twice).
          if (options?.force) {
            Alert.alert('导入失败', err.message);
            return;
          }
          Alert.alert(
            '检测到同名视频',
            '系统里已经有一份同名视频(可能来自之前的导入,且不在可见合集中)。是否仍然再导入一份?',
            [
              { text: '取消', style: 'cancel' },
              {
                text: '再次导入',
                onPress: () => {
                  void runImport(importFn, { force: true });
                },
              },
            ],
          );
          return;
        }
        const msg = err instanceof Error ? err.message : '导入失败,请稍后重试';
        Alert.alert('导入失败', msg);
      } finally {
        setIsImporting(false);
      }
    },
    [isImporting, onClose, onImportSuccess],
  );

  const handlePickLocalVideo = useCallback(async () => {
    const collectionId = targetCollectionIdRef.current ?? undefined;
    await runImport(async () => {
      return await pickAndImportLocalVideo({ collectionId });
    });
  }, [runImport]);

  const handlePickCloudVideo = useCallback(async (file: SelectedCloudVideoFile) => {
    const collectionId = targetCollectionIdRef.current ?? undefined;
    await runImport(async () => {
      return await createCloudVideoReference({
        provider: file.provider,
        title: file.remoteFileName,
        remotePath: file.remotePath,
        remoteFileId: file.remoteFileId,
        remoteFileName: file.remoteFileName,
        fileSize: file.fileSize,
        collectionId,
      });
    });
  }, [runImport]);

  // Called by the cloud browser's internal import path (which
  // calls createCloudVideoReference directly). The picker should
  // still close and the parent should still be notified.
  const handleCloudImportSuccess = useCallback(
    (entry: UserVideoEntry) => {
      if (isImporting) return;
      setIsImporting(true);
      onClose();
      if (onImportSuccess) {
        onImportSuccess({ id: entry.id, title: entry.title, sourceType: entry.sourceType });
      }
      // Fire-and-forget: cloud references bypass the pro/quota
      // gate and trigger immediately.
      void triggerImportedVideoSubtitleGeneration(entry);
      setIsImporting(false);
    },
    [isImporting, onClose, onImportSuccess],
  );

  // ── Derived: title shown in the inline selector ────────────────
  const targetCollectionTitle = useMemo(() => {
    if (!targetCollectionId) return '默认合集';
    const fromPicker = userCollectionsForPicker.find(
      (r) => encodeUserCollectionId(r.id) === targetCollectionId,
    );
    if (fromPicker) return fromPicker.title;
    return '默认合集';
  }, [targetCollectionId, userCollectionsForPicker]);

  // Web builds can't import local files via expo-document-picker.
  const isNativeVideoImportSupported = Platform.OS !== 'web';

  if (!visible && !isCollectionPickerVisible) return null;

  return (
    <>
      {/* ── Source binding sheet ──────────────────────────────── */}
      <Modal
        visible={visible}
        transparent
        animationType="slide"
        onRequestClose={() => !isImporting && onClose()}
      >
        <View style={styles.sheetOverlay}>
          <Pressable
            style={{ flex: 1 }}
            onPress={() => !isImporting && onClose()}
          />
          <View style={styles.customSheet}>
            <View style={styles.customSheetHandle} />
            <View style={styles.customSheetHeader}>
              <View style={styles.headerInfo}>
                <Text style={styles.sheetTitle}>导入视频</Text>
                <Text style={styles.sheetHint}>
                  从已连接网盘或本地设备导入视频文件。
                </Text>
              </View>
              <Pressable
                onPress={() => !isImporting && onClose()}
                hitSlop={8}
              >
                <X size={20} color={colors.text.secondary} />
              </Pressable>
            </View>
            <Pressable
              style={styles.targetSelector}
              onPress={isImporting ? undefined : handleOpenCollectionPicker}
              hitSlop={6}
            >
              <Folder size={16} color={colors.primary} />
              <Text style={styles.targetSelectorLabel}>导入到</Text>
              <Text style={styles.targetSelectorValue} numberOfLines={1}>
                {targetCollectionTitle}
              </Text>
              <ChevronDown size={16} color={colors.text.secondary} />
            </Pressable>
            <VideoSourcePickerContent
              visible={visible}
              allowLocalImport={isNativeVideoImportSupported}
              onImportLocalVideo={handlePickLocalVideo}
              onCloudFileSelected={handlePickCloudVideo}
              onCloudImportSuccess={handleCloudImportSuccess}
              collectionId={targetCollectionIdRenderRef.current ?? undefined}
            />
          </View>
        </View>
      </Modal>

      {/* ── Collection picker sub-sheet ────────────────────────── */}
      <Modal
        visible={isCollectionPickerVisible}
        transparent
        animationType="slide"
        onRequestClose={() => {
          if (pickerMode === 'create') {
            handleCancelQuickCreate();
            return;
          }
          setIsCollectionPickerVisible(false);
        }}
      >
        <View style={styles.sheetOverlay}>
          <Pressable
            style={{ flex: 1 }}
            onPress={() => {
              if (pickerMode === 'create') {
                handleCancelQuickCreate();
                return;
              }
              setIsCollectionPickerVisible(false);
            }}
          />
          <View style={styles.pickerSheet}>
            <View style={styles.customSheetHandle} />
            {pickerMode === 'list' ? (
              <>
                <Text style={styles.pickerSheetTitle}>选择导入到哪个合集</Text>
                {isCollectionPickerLoading ? (
                  <View style={styles.pickerLoading}>
                    <ActivityIndicator size="small" color={colors.primary} />
                  </View>
                ) : (
                  <ScrollView style={styles.pickerList} showsVerticalScrollIndicator={false}>
                    {userCollectionsForPicker.length === 0 ? (
                      <Text style={styles.pickerEmpty}>还没有合集</Text>
                    ) : (
                      userCollectionsForPicker.map((c) => {
                        const wireId = encodeUserCollectionId(c.id);
                        const selected = wireId === targetCollectionId;
                        return (
                          <Pressable
                            key={c.id}
                            style={[styles.pickerRow, selected && styles.pickerRowSelected]}
                            onPress={() => handlePickCollection(wireId)}
                          >
                            <Folder
                              size={18}
                              color={selected ? colors.primary : colors.text.secondary}
                            />
                            <View style={styles.pickerRowText}>
                              <Text
                                style={[
                                  styles.pickerRowTitle,
                                  selected && styles.pickerRowTitleSelected,
                                ]}
                                numberOfLines={1}
                              >
                                {c.title}
                              </Text>
                              {c.is_default ? (
                                <Text style={styles.pickerRowBadge}>默认</Text>
                              ) : null}
                            </View>
                            {selected ? <Check size={18} color={colors.primary} /> : null}
                          </Pressable>
                        );
                      })
                    )}
                    <Pressable style={styles.pickerCreateBtn} onPress={handleStartQuickCreate}>
                      <Plus size={16} color={colors.primary} />
                      <Text style={styles.pickerCreateBtnText}>新建合集</Text>
                    </Pressable>
                  </ScrollView>
                )}
              </>
            ) : (
              <>
                <Text style={styles.pickerSheetTitle}>新建合集</Text>
                <Text style={styles.pickerSheetHint}>
                  创建后会自动选为导入目标。
                </Text>
                <TextInput
                  style={styles.sheetInput}
                  value={pickerNewTitle}
                  onChangeText={setPickerNewTitle}
                  autoFocus
                  maxLength={40}
                  placeholder="合集名"
                  placeholderTextColor={colors.text.tertiary}
                />
                <View style={styles.createSheetActions}>
                  <Pressable
                    style={[styles.sheetBtn, styles.sheetBtnGhost]}
                    onPress={handleCancelQuickCreate}
                  >
                    <Text style={styles.sheetBtnGhostText}>取消</Text>
                  </Pressable>
                  <Pressable
                    style={[styles.sheetBtn, styles.sheetBtnPrimary]}
                    onPress={handleSubmitQuickCreate}
                  >
                    <Check size={16} color="#FFFFFF" />
                    <Text style={styles.sheetBtnPrimaryText}>创建并使用</Text>
                  </Pressable>
                </View>
              </>
            )}
          </View>
        </View>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  sheetOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.4)',
    justifyContent: 'flex-end',
  },
  customSheet: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    paddingBottom: 48,
    gap: spacing.md,
    height: '75%',
  },
  customSheetHandle: {
    width: 40,
    height: 5,
    backgroundColor: colors.border.default,
    borderRadius: borderRadius.full,
    alignSelf: 'center',
    marginBottom: spacing.sm,
  },
  customSheetHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  headerInfo: {
    flex: 1,
    gap: 4,
    paddingRight: spacing.md,
  },
  sheetTitle: {
    fontSize: fontSize.lg,
    fontWeight: fontWeight.bold,
    color: colors.text.primary,
  },
  sheetHint: {
    fontSize: fontSize.sm,
    color: colors.text.secondary,
    lineHeight: 20,
  },
  targetSelector: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.sm + 2,
    paddingHorizontal: spacing.md,
    borderRadius: borderRadius.md,
    backgroundColor: 'rgba(0,0,0,0.03)',
    borderWidth: 1,
    borderColor: colors.border.default,
  },
  targetSelectorLabel: {
    fontSize: fontSize.sm,
    color: colors.text.secondary,
  },
  targetSelectorValue: {
    flex: 1,
    fontSize: fontSize.base,
    color: colors.text.primary,
    fontWeight: fontWeight.medium,
  },

  pickerSheet: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    paddingBottom: spacing.xl,
    gap: spacing.md,
    maxHeight: '70%',
  },
  pickerSheetTitle: {
    fontSize: fontSize.lg,
    fontWeight: fontWeight.bold,
    color: colors.text.primary,
  },
  pickerSheetHint: {
    fontSize: fontSize.sm,
    color: colors.text.secondary,
    lineHeight: 20,
  },
  pickerLoading: {
    paddingVertical: spacing.xl,
    alignItems: 'center',
  },
  pickerList: {
    maxHeight: 360,
  },
  pickerEmpty: {
    fontSize: fontSize.sm,
    color: colors.text.tertiary,
    textAlign: 'center',
    paddingVertical: spacing.lg,
  },
  pickerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.border.default,
  },
  pickerRowSelected: {
    backgroundColor: 'rgba(0,0,0,0.02)',
  },
  pickerRowText: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  pickerRowTitle: {
    fontSize: fontSize.base,
    color: colors.text.primary,
    fontWeight: fontWeight.medium,
    flexShrink: 1,
  },
  pickerRowTitleSelected: {
    color: colors.primary,
  },
  pickerRowBadge: {
    fontSize: fontSize.xs,
    color: colors.text.tertiary,
    backgroundColor: 'rgba(0,0,0,0.04)',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: borderRadius.sm,
    overflow: 'hidden',
  },
  pickerCreateBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.md,
    marginTop: spacing.sm,
  },
  pickerCreateBtnText: {
    fontSize: fontSize.base,
    color: colors.primary,
    fontWeight: fontWeight.medium,
  },

  sheetInput: {
    borderWidth: 1,
    borderColor: 'rgba(0,0,0,0.12)',
    borderRadius: borderRadius.md,
    paddingHorizontal: spacing.sm,
    paddingVertical: 10,
    fontSize: fontSize.base,
    color: colors.text.primary,
  },
  createSheetActions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: spacing.sm,
    paddingTop: spacing.sm,
  },
  sheetBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: spacing.md,
    paddingVertical: 10,
    borderRadius: borderRadius.md,
  },
  sheetBtnGhost: { backgroundColor: 'rgba(0,0,0,0.05)' },
  sheetBtnGhostText: { color: colors.text.primary, fontWeight: fontWeight.medium },
  sheetBtnPrimary: { backgroundColor: colors.primary },
  sheetBtnPrimaryText: { color: '#FFFFFF', fontWeight: fontWeight.semibold },
});
