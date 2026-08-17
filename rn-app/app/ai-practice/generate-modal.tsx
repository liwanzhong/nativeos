/**
 * Shared generation modal for both AI 陪练 custom-topic entries:
 *   - /ai-practice/add-custom (natural-language free text)
 *   - /ai-practice/add-custom-guide (multi-turn chip selection)
 *
 * UX states:
 *   - 'generating':  streaming cards in. Each new card is appended
 *                    below the previous one; the user sees progress
 *                    without leaving the modal. They can hit
 *                    "取消" to abort.
 *   - 'done':        all cards landed. The cards become a checkbox
 *                    list (defaulted to all-checked). User can
 *                    "全选/清空" or uncheck individual cards, then
 *                    "加入主页 (N)" to write them to the home grid.
 *   - 'error':       LLM call failed. Show a retry button.
 *
 * Why a modal: keeps focus tight during generation. The user
 * previously was on a fairly empty input page; without a modal,
 * generation just appears below an empty form which feels like
 * "did anything happen?". A modal with state copy ("正在理解你的
 * 需求…") tells the user the app is working AND the cards
 * stream in the same place.
 */

import {
  View,
  Text,
  StyleSheet,
  Pressable,
  Modal,
  ActivityIndicator,
  Alert,
  ScrollView,
} from 'react-native';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, Plus, Sparkles, X } from 'lucide-react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors, spacing, borderRadius, fontSize, fontWeight } from '../../constants/theme';
import {
  generateDailyScenariosStream,
  type ScenarioCard,
} from '../../lib/ai/scenario-generator';
import {
  buildAiPracticeTopicSnapshot,
  addAiTopicToHome,
  type AiPracticeHomeOrigin,
} from '../../lib/ai/ai-practice-user-meta';
import { consumeAndNotify, isByokEnabled } from '../../lib/quota';
import { quotaDialog } from '../../components/quota/QuotaBlockedDialog';

type Status = 'generating' | 'done' | 'error';

interface GenerateModalProps {
  visible: boolean;
  onClose: () => void;
  /** Free-text description (natural-language entry). When > 10 chars,
   *  this routes to buildCustomQueryPrompt and binds ALL generated
   *  cards to the same situation. */
  prompt: string;
  /** interests array passed straight to generateDailyScenariosStream.
   *  For the multi-turn guide, this is the joined (scene, person,
   *  situation) tuple. */
  interests: string[];
  userLevel: string;
  count: number;
}

const STATUS_TEXT: Record<Status, string> = {
  generating: '正在理解你的需求…',
  done: '生成完成',
  error: '生成失败',
};

/**
 * Pre-flight quota gate for the LLM call. Returns true when the call
 * is allowed (Pro / BYOK / still within daily cap). When the cap is
 * already hit we surface the standard "额度用完啦" dialog and return
 * false so the caller can bail cleanly.
 *
 * We charge `count` units up front (one per card requested). If the
 * stream returns fewer cards the overage is fine — the user paid for
 * the generation work, not a per-card deliverable.
 */
async function ensureAiRoundQuota(count: number): Promise<boolean> {
  const byokOn = await isByokEnabled();
  if (byokOn) return true;
  const verdict = await consumeAndNotify('ai_rounds', Math.max(1, count));
  if (!verdict.allowed) {
    quotaDialog.show({ field: verdict.field, tier: verdict.tier, used: verdict.used, hard: verdict.hard });
    return false;
  }
  return true;
}

export function GenerateModal({
  visible,
  onClose,
  prompt,
  interests,
  userLevel,
  count,
}: GenerateModalProps) {
  const insets = useSafeAreaInsets();
  const [status, setStatus] = useState<Status>('generating');
  const [cards, setCards] = useState<ScenarioCard[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [isAdding, setIsAdding] = useState(false);
  // Monotonically-incrementing invocation id. Every LLM call
  // captures the current value at start; its onCard callback
  // then checks `invocationIdRef.current === myId` to decide
  // whether it is still the active run. If the user hits
  // "取消" and re-opens the modal, the next useEffect bumps the
  // id, and any in-flight callbacks from the previous run see a
  // mismatch and silently drop — so a long-running stream that
  // the user "cancelled" can't keep appending cards into the new
  // run's state. (We can't actually abort the network call from
  // RN fetch, so this is the only soft-cancel mechanism.)
  const invocationIdRef = useRef(0);

  // Reset state on every open so a second invocation starts clean.
  useEffect(() => {
    if (!visible) return;
    invocationIdRef.current += 1;
    const myId = invocationIdRef.current;
    setStatus('generating');
    setCards([]);
    setSelectedIds(new Set());

    (async () => {
      // Quota gate. If the user is over the daily cap, surface the
      // standard dialog and bail to the 'error' state so the modal
      // doesn't sit forever on a spinner.
      const allowed = await ensureAiRoundQuota(count);
      if (!allowed) {
        if (invocationIdRef.current !== myId) return;
        setStatus('error');
        return;
      }
      try {
        await generateDailyScenariosStream(
          {
            userLevel: userLevel as any,
            interests,
            count,
          },
          (card) => {
            // Stale callback: another run has started. Drop.
            if (invocationIdRef.current !== myId) return;
            setCards((prev) => {
              if (prev.some((c) => c.id === card.id)) return prev;
              // Default new arrivals to checked. The user can uncheck
              // before hitting "加入陪练".
              setSelectedIds((sel) => {
                if (sel.has(card.id)) return sel;
                const next = new Set(sel);
                next.add(card.id);
                return next;
              });
              return [...prev, card];
            });
          },
        );
        // Stale completion: skip status update.
        if (invocationIdRef.current !== myId) return;
        setStatus('done');
      } catch (error) {
        console.warn('[GenerateModal] stream failed', error);
        if (invocationIdRef.current !== myId) return;
        setStatus('error');
      }
    })();
    // No cleanup: each new run increments the id, which is what
    // actually invalidates the previous run's callbacks.
  }, [visible, prompt, interests.join('|'), userLevel, count]);

  const handleCancel = useCallback(() => {
    // Bump the id so any in-flight callbacks (including late
    // arrivals from the network stream) drop on the floor. Then
    // close — the parent component re-mounts us with fresh state
    // the next time the user opens the modal.
    invocationIdRef.current += 1;
    onClose();
  }, [onClose]);

  const handleRetry = useCallback(() => {
    // Same id-bump trick so the failed call's late callbacks
    // can't write to state; then re-run.
    invocationIdRef.current += 1;
    const myId = invocationIdRef.current;
    setStatus('generating');
    setCards([]);
    setSelectedIds(new Set());
    (async () => {
      // Quota: retry is a fresh LLM call — charge again. If the
      // user is over the cap, the dialog is shown and we exit to
      // the error state instead of looping.
      const allowed = await ensureAiRoundQuota(count);
      if (!allowed) {
        if (invocationIdRef.current !== myId) return;
        setStatus('error');
        return;
      }
      try {
        await generateDailyScenariosStream(
          { userLevel: userLevel as any, interests, count },
          (card) => {
            if (invocationIdRef.current !== myId) return;
            setCards((prev) => (prev.some((c) => c.id === card.id) ? prev : [...prev, card]));
            setSelectedIds((sel) => {
              if (sel.has(card.id)) return sel;
              const next = new Set(sel);
              next.add(card.id);
              return next;
            });
          },
        );
        if (invocationIdRef.current === myId) setStatus('done');
      } catch (error) {
        console.warn('[GenerateModal] retry failed', error);
        if (invocationIdRef.current === myId) setStatus('error');
      }
    })();
  }, [count, interests, userLevel]);

  const toggleCard = useCallback((cardId: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(cardId)) {
        next.delete(cardId);
      } else {
        next.add(cardId);
      }
      return next;
    });
  }, []);

  const handleSelectAll = useCallback(() => {
    setSelectedIds(new Set(cards.map((c) => c.id)));
  }, [cards]);

  const handleClearSelection = useCallback(() => {
    setSelectedIds(new Set());
  }, []);

  const handleAdd = useCallback(async () => {
    if (isAdding) return;
    if (selectedIds.size === 0) {
      Alert.alert('还没勾选', '请先勾选要加入的话题。');
      return;
    }
    setIsAdding(true);
    try {
      const selected = cards.filter((c) => selectedIds.has(c.id));
      for (const card of selected) {
        const snapshot = buildAiPracticeTopicSnapshot({
          card,
          origin: 'from_custom',
          sourceType: 'custom_topic',
          sourceLabel: '自定义话题',
        });
        await addAiTopicToHome({ ...snapshot, homeOrigin: 'from_custom' as AiPracticeHomeOrigin });
      }
      Alert.alert('已加入', `${selected.length} 个话题已加入陪练。`, [
        { text: '好的', onPress: onClose },
      ]);
    } catch (error) {
      console.warn('[GenerateModal] add failed', error);
      Alert.alert('加入失败', '请稍后再试。');
    } finally {
      setIsAdding(false);
    }
  }, [cards, isAdding, onClose, selectedIds]);

  const allSelected = cards.length > 0 && selectedIds.size === cards.length;
  const showEmptyPlaceholder = status === 'generating' && cards.length === 0;

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={handleCancel}>
      <View style={[styles.container, { paddingTop: insets.top }]}>
        <View style={styles.header}>
          <Pressable hitSlop={8} onPress={handleCancel} style={styles.headerBack}>
            <ArrowLeft size={20} color={colors.text.primary} />
          </Pressable>
          <Text style={styles.headerTitle}>{status === 'done' ? '生成完成' : '生成中'}</Text>
          <View style={styles.headerBack} />
        </View>

        <View style={styles.statusBar}>
          <Text style={styles.statusText}>{STATUS_TEXT[status]}</Text>
          {prompt ? (
            <Text style={styles.statusPrompt} numberOfLines={2}>
              "{prompt}"
            </Text>
          ) : null}
        </View>

        <ScrollView
          style={styles.scroll}
          contentContainerStyle={[styles.scrollContent, { paddingBottom: Math.max(120, insets.bottom + 96) }]}
          showsVerticalScrollIndicator={false}
        >
          {showEmptyPlaceholder ? (
            <View style={styles.emptyPlaceholder}>
              <ActivityIndicator size="small" color={colors.primary} />
              <Text style={styles.emptyText}>正在生成第一个话题…</Text>
            </View>
          ) : null}

          {status === 'error' ? (
            <View style={styles.errorBlock}>
              <Text style={styles.errorTitle}>生成失败</Text>
              <Text style={styles.errorHint}>网络或服务端异常，重试一次试试。</Text>
              <Pressable style={styles.retryBtn} onPress={handleRetry}>
                <Text style={styles.retryBtnText}>重试</Text>
              </Pressable>
            </View>
          ) : null}

          {cards.length > 0 ? (
            <View style={styles.resultList}>
              {cards.map((card, index) => {
                const checked = selectedIds.has(card.id);
                return (
                  <Pressable
                    key={`gen-${card.id}`}
                    style={[styles.resultRow, checked && styles.resultRowChecked]}
                    onPress={() => status === 'done' && toggleCard(card.id)}
                  >
                    <View style={[styles.checkbox, checked && styles.checkboxChecked]}>
                      {checked ? <Text style={styles.checkboxMark}>✓</Text> : null}
                    </View>
                    <Text style={styles.resultIndex}>{index + 1}/{cards.length > count ? cards.length : count}</Text>
                    <Text style={styles.resultEmoji}>{card.icon || '💬'}</Text>
                    <View style={styles.resultRowBody}>
                      <View style={styles.resultRowMetaRow}>
                        {card.level ? (
                          <View style={styles.levelBadge}>
                            <Text style={styles.levelText}>{card.level}</Text>
                          </View>
                        ) : null}
                        {card.category ? (
                          <Text style={styles.categoryText} numberOfLines={1}>
                            {card.category}
                          </Text>
                        ) : null}
                      </View>
                      <Text style={styles.resultRowTitle} numberOfLines={2}>{card.title}</Text>
                      {card.descZh || card.desc ? (
                        <Text style={styles.resultRowDesc} numberOfLines={1}>
                          {card.descZh || card.desc}
                        </Text>
                      ) : null}
                    </View>
                  </Pressable>
                );
              })}

              {status === 'generating' ? (
                <View style={styles.streamingHint}>
                  <ActivityIndicator size="small" color={colors.primary} />
                  <Text style={styles.streamingHintText}>
                    正在生成 {cards.length < count ? `${cards.length + 1}-${count}` : '剩余'}…
                  </Text>
                </View>
              ) : null}
            </View>
          ) : null}
        </ScrollView>

        {status === 'done' ? (
          <View style={[styles.footer, { paddingBottom: Math.max(20, insets.bottom + 12) }]}>
            <View style={styles.footerActions}>
              <Pressable onPress={allSelected ? handleClearSelection : handleSelectAll} hitSlop={6}>
                <Text style={styles.footerLink}>{allSelected ? '清空' : '全选'}</Text>
              </Pressable>
            </View>
            <Pressable
              style={[
                styles.addBtn,
                (selectedIds.size === 0 || isAdding) && styles.addBtnDisabled,
              ]}
              onPress={() => void handleAdd()}
              disabled={selectedIds.size === 0 || isAdding}
            >
              {isAdding ? (
                <ActivityIndicator size="small" color="#FFFFFF" />
              ) : (
                <Plus size={16} color="#FFFFFF" />
              )}
              <Text style={styles.addBtnText}>
                {isAdding ? '正在加入…' : `加入陪练 (${selectedIds.size})`}
              </Text>
            </Pressable>
          </View>
        ) : null}

        {status === 'generating' ? (
          <View style={[styles.footer, { paddingBottom: Math.max(20, insets.bottom + 12) }]}>
            <Pressable style={styles.cancelBtn} onPress={handleCancel}>
              <X size={16} color={colors.text.secondary} />
              <Text style={styles.cancelBtnText}>取消</Text>
            </Pressable>
          </View>
        ) : null}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  headerBack: {
    width: 28,
    height: 28,
  },
  headerTitle: {
    fontSize: fontSize.lg,
    fontWeight: fontWeight.semibold,
    color: colors.text.primary,
  },
  statusBar: {
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.md,
    gap: 6,
  },
  statusText: {
    fontSize: fontSize.base,
    fontWeight: fontWeight.semibold,
    color: colors.primary,
  },
  statusPrompt: {
    fontSize: fontSize.xs,
    color: colors.text.tertiary,
    lineHeight: 18,
  },
  scroll: {
    flex: 1,
  },
  scrollContent: {
    paddingHorizontal: spacing.lg,
  },
  emptyPlaceholder: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.xl,
    justifyContent: 'center',
  },
  emptyText: {
    fontSize: fontSize.sm,
    color: colors.text.secondary,
  },
  errorBlock: {
    padding: spacing.lg,
    backgroundColor: 'rgba(220, 38, 38, 0.08)',
    borderRadius: borderRadius.lg,
    borderWidth: 1,
    borderColor: 'rgba(220, 38, 38, 0.2)',
    alignItems: 'center',
    gap: spacing.sm,
  },
  errorTitle: {
    fontSize: fontSize.base,
    fontWeight: fontWeight.semibold,
    color: '#DC2626',
  },
  errorHint: {
    fontSize: fontSize.sm,
    color: colors.text.secondary,
    textAlign: 'center',
  },
  retryBtn: {
    paddingHorizontal: spacing.lg,
    paddingVertical: 8,
    borderRadius: borderRadius.full,
    backgroundColor: '#DC2626',
    marginTop: spacing.xs,
  },
  retryBtnText: {
    fontSize: fontSize.sm,
    color: '#FFFFFF',
    fontWeight: fontWeight.semibold,
  },
  resultList: {
    gap: spacing.sm,
  },
  resultRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    paddingVertical: 12,
    paddingHorizontal: 12,
    borderRadius: borderRadius.lg,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border.light,
  },
  resultRowChecked: {
    backgroundColor: '#EFF6FF',
    borderColor: colors.primary,
  },
  checkbox: {
    width: 20,
    height: 20,
    borderRadius: 5,
    borderWidth: 1.5,
    borderColor: '#CBD5E1',
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 4,
  },
  checkboxChecked: {
    backgroundColor: colors.primary,
    borderColor: colors.primary,
  },
  checkboxMark: {
    fontSize: 12,
    fontWeight: fontWeight.bold,
    color: '#FFFFFF',
    lineHeight: 14,
  },
  resultIndex: {
    fontSize: 11,
    color: colors.text.tertiary,
    fontWeight: fontWeight.semibold,
    minWidth: 30,
    marginTop: 4,
  },
  resultEmoji: {
    fontSize: 22,
    lineHeight: 26,
    marginTop: 2,
  },
  resultRowBody: {
    flex: 1,
    gap: 4,
  },
  resultRowMetaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  resultRowTitle: {
    fontSize: fontSize.sm,
    fontWeight: fontWeight.bold,
    color: colors.text.primary,
    lineHeight: 18,
  },
  resultRowDesc: {
    fontSize: fontSize.xs,
    color: colors.text.secondary,
    lineHeight: 16,
  },
  levelBadge: {
    paddingHorizontal: 6,
    paddingVertical: 1,
    borderRadius: borderRadius.sm,
    backgroundColor: '#DBEAFE',
  },
  levelText: {
    fontSize: 10,
    fontWeight: fontWeight.bold,
    color: '#1E40AF',
  },
  categoryText: {
    flexShrink: 1,
    fontSize: 10,
    fontWeight: fontWeight.bold,
    color: '#9CA3AF',
  },
  streamingHint: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.md,
    justifyContent: 'center',
  },
  streamingHintText: {
    fontSize: fontSize.sm,
    color: colors.primary,
    fontWeight: fontWeight.medium,
  },
  footer: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    borderTopWidth: 1,
    borderTopColor: colors.border.light,
    backgroundColor: colors.surface,
    gap: spacing.sm,
  },
  footerActions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
  },
  footerLink: {
    fontSize: fontSize.sm,
    color: colors.primary,
    fontWeight: fontWeight.medium,
  },
  addBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 13,
    borderRadius: borderRadius.full,
    backgroundColor: colors.primary,
  },
  addBtnDisabled: {
    opacity: 0.5,
  },
  addBtnText: {
    fontSize: fontSize.base,
    fontWeight: fontWeight.bold,
    color: '#FFFFFF',
  },
  cancelBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 12,
    borderRadius: borderRadius.full,
    backgroundColor: '#F1F5F9',
  },
  cancelBtnText: {
    fontSize: fontSize.sm,
    color: colors.text.secondary,
    fontWeight: fontWeight.medium,
  },
});
