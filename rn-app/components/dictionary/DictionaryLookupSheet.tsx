import { useEffect, useState, useCallback, useMemo } from 'react';
import {
  Modal, View, Text, ScrollView, Pressable, StyleSheet,
  ActivityIndicator, Platform, Dimensions,
} from 'react-native';
import { X, RefreshCw, Star } from 'lucide-react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { lookupWord } from '../../lib/dictionary/query';
import {
  getDictionaryDbStatus,
  subscribeDictionaryDbStatus,
  retryDictionaryDbDownload,
} from '../../lib/dictionary/db';
import type { DictionaryResult } from '../../lib/dictionary/types';
import { DictionaryEntryHeader } from './DictionaryEntryHeader';

export interface SaveWordToHistoryPayload {
  queryWord: string;
  normalized: string;
  displayWord: string;
  contextSentence: string;
  segmentId: string | null;
  /**
   * Best translation extracted from the dictionary result. The card
   * persistence layer stores it on the FSRS card directly so the review
   * tab doesn't need to re-query the dictionary.
   */
  translation?: string;
}

interface Props {
  word: string;
  contextSentence?: string;
  segmentId?: string | null;
  /**
   * Whether the currently-looked-up word is already in 单词 list.
   * Drives the star fill on the top bar.
   */
  isWordSaved?: boolean;
  /**
   * Whether the sentence that the current word came from is already in
   * the sentence favorite list. Drives the star in the "当前字幕" box.
   * Same style as the subtitle-card star — explicit reuse, no new icon.
   */
  isSentenceSaved?: boolean;
  onClose: () => void;
  /**
   * Toggles 单词 list membership for the current lookup. Tapping the star
   * in the top bar calls this with the next desired saved state.
   * The sheet itself stays read-only; the caller decides persistence.
   */
  onToggleSave?: (payload: SaveWordToHistoryPayload, nextSaved: boolean) => void;
  /**
   * Toggles 句子 list membership for the current context sentence.
   * Mirrors the subtitle-card star behavior so the two stay in sync.
   */
  onToggleSentenceSave?: () => void;
}

export function DictionaryLookupSheet({
  word,
  contextSentence,
  segmentId,
  isWordSaved = false,
  isSentenceSaved = false,
  onClose,
  onToggleSave,
  onToggleSentenceSave,
}: Props) {
  const insets = useSafeAreaInsets();
  const [result, setResult] = useState<DictionaryResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const [dbStatus, setDbStatus] = useState(() => getDictionaryDbStatus());

  useEffect(() => subscribeDictionaryDbStatus(setDbStatus), []);

  useEffect(() => {
    setLoading(true);
    setResult(null);
    lookupWord(word)
      .then(setResult)
      .catch(() => setResult(null))
      .finally(() => setLoading(false));
  }, [word]);

  const handleBackdropPress = useCallback(() => {
    onClose();
  }, [onClose]);

  const getLoadingHint = () => {
    if (dbStatus.phase === 'preparing' || dbStatus.phase === 'idle') {
      return '正在准备离线词典…';
    }
    if (dbStatus.phase === 'downloading') {
      const percent =
        dbStatus.downloadProgress >= 0
          ? Math.round(dbStatus.downloadProgress * 100)
          : null;
      return percent !== null
        ? `首次使用，正在下载离线词典 (${percent}%)…`
        : '首次使用，正在下载离线词典…';
    }
    if (dbStatus.phase === 'opening') {
      return '离线词典已就位，正在打开…';
    }
    if (dbStatus.phase === 'failed') {
      return dbStatus.errorMessage || '离线词典下载失败';
    }
    return '正在查询词义…';
  };

  const handleRetry = useCallback(() => {
    retryDictionaryDbDownload();
  }, []);

  // Best-effort translation derived from the first entry's first translation line.
  const bestTranslation = useMemo(() => {
    if (!result || result.entries.length === 0) return '';
    for (const e of result.entries) {
      if (!e.translation) continue;
      const firstLine = e.translation.split('\n').find((l) => l.trim().length > 0);
      if (firstLine) {
        // Strip leading POS prefix like "n. " from the translation line.
        const stripped = firstLine.replace(/^[a-zA-Z]+\.\s+/, '').trim();
        if (stripped) return stripped;
      }
    }
    return '';
  }, [result]);

  const canSaveToHistory = !!onToggleSave && !loading && dbStatus.phase !== 'failed' && !!result && result.entries.length > 0;

  const handleToggleSave = useCallback(() => {
    if (!onToggleSave) return;
    const normalized = (result?.normalized || word).trim().toLowerCase();
    const displayWord = (result?.lemma || word).trim();
    onToggleSave(
      {
        queryWord: word,
        normalized,
        displayWord: displayWord || word,
        contextSentence: contextSentence || word,
        segmentId: segmentId ?? null,
        // Pass the best translation along so the word card is self-contained
        // for review — no need to re-query the dictionary on the review tab.
        translation: bestTranslation || undefined,
      },
      !isWordSaved,
    );
  }, [onToggleSave, result, word, contextSentence, segmentId, isWordSaved, bestTranslation]);

  /** ECDICT definition/translation 文本里每行开头都是 "n. " / "v. " / "interj. " 这种词性前缀。
   *  解析出来给 chip 样式用，跟正文区分开。匹配不上时 pos=null，原样当 body 渲染。
   *
   *  POS 形态有 3 种：
   *    1. 单 POS:          "n. body"
   *    2. 多 POS 拼接:     "dat. & obj. body"          （两个 POS 用 " & " 连）
   *    3. 复合 POS 拼接:   "p. pr. & vb. n. of Abase"  （POS 自身内部带 ". "，如 "p. p." / "vb. n."）
   *
   *  旧正则 ^([a-zA-Z]+)\.\s+(.*)$ 只能匹配 #1，把 "dat. & obj." 拆成 "dat" + "& obj. ..."
   *  chip 只显示 "dat."，剩下 "& obj." 散在 body 前面。
   *  新正则一次吃掉整个 POS 前缀（一个或多个 [词 + .] 用 " & " 串起来，每个词内部也允许 ". 子词"）。*/
  const POS_PREFIX = /^((?:[a-zA-Z]+(?:\.\s+[a-zA-Z]+)*\.\s*&\s*)*[a-zA-Z]+(?:\.\s+[a-zA-Z]+)*\.)\s+(.*)$/;
  const splitWithPos = (text: string | null): Array<{ pos: string | null; body: string }> => {
    if (!text) return [];
    return text.split('\n').map((line) => {
      const m = line.match(POS_PREFIX);
      if (m) return { pos: m[1], body: m[2] };
      return { pos: null, body: line };
    });
  };

  const renderSenseLines = (
    lines: Array<{ pos: string | null; body: string }>,
    bodyStyle: object,
  ) => (
    <>
      {lines.map((line, i) => (
        <View key={i} style={styles.senseLine}>
          {line.pos ? (
            <View style={styles.posChip}>
              <Text style={styles.posChipText}>{line.pos}</Text>
            </View>
          ) : null}
          <Text style={[bodyStyle, styles.senseLineBody]}>{line.body}</Text>
        </View>
      ))}
    </>
  );

  const renderEntries = (res: DictionaryResult) => {
    // Group entries by pos
    const grouped = new Map<string, typeof res.entries>();
    for (const e of res.entries) {
      const key = e.pos ?? '—';
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key)!.push(e);
    }

    const posGroups = Array.from(grouped.entries());

    return (
      <>
        {posGroups.map(([posKey, posEntries], groupIdx) => {
          const isExpanded = expandedGroups.has(posKey);
          const sorted = [...posEntries]; // query.ts already sorted by collins / frq
          const LIMIT = 3;
          const display = isExpanded ? sorted : sorted.slice(0, LIMIT);
          const hiddenCount = sorted.length - LIMIT;
          const firstEntry = display[0];

          return (
            <View key={posKey} style={[styles.entryBlock, groupIdx > 0 && styles.entryBlockDivider]}>
              <DictionaryEntryHeader entry={firstEntry} />

              <View style={styles.senseList}>
                {display.map((entry, idx) => {
                  const defLines = splitWithPos(entry.definition);
                  const trLines = splitWithPos(entry.translation);
                  return (
                    <View key={entry.id} style={styles.senseItem}>
                      {display.length > 1 ? (
                        <Text style={styles.senseNumber}>{idx + 1}.</Text>
                      ) : null}
                      <View style={styles.senseBody}>
                        {/* 2026-09-01: English definition hidden per user request.
                            Also drop the "译" divider — when only the Chinese
                            translation is shown, the divider becomes a dead
                            empty band between the meta row and the translation. */}
                        {/*
                        {defLines.length > 0 ? (
                          <View style={styles.definitionBlock}>
                            {renderSenseLines(defLines, styles.definitionText)}
                          </View>
                        ) : null}
                        */}
                        {/*
                        {trLines.length > 0 ? (
                          <View style={styles.trDivider}>
                            <View style={styles.trDividerLine} />
                            <Text style={styles.trDividerLabel}>译</Text>
                            <View style={styles.trDividerLine} />
                          </View>
                        ) : null}
                        */}
                        {trLines.length > 0 ? (
                          <View style={styles.translationBlock}>
                            {renderSenseLines(trLines, styles.definitionZh)}
                          </View>
                        ) : null}
                      </View>
                    </View>
                  );
                })}
              </View>

              {!isExpanded && hiddenCount > 0 ? (
                <Pressable
                  onPress={() => setExpandedGroups(prev => new Set([...prev, posKey]))}
                  style={styles.moreHintBtn}
                >
                  <Text style={styles.moreHint}>查看全部 {sorted.length} 个义项 ›</Text>
                </Pressable>
              ) : null}
            </View>
          );
        })}
      </>
    );
  };

  const content = (
    <View style={styles.sheet}>
      <View style={styles.handleBar} />

      <View style={styles.topBar}>
        <Text style={styles.queryLabel}>"{word}"</Text>
        <View style={styles.topBarRight}>
          {canSaveToHistory ? (
            <Pressable
              onPress={handleToggleSave}
              hitSlop={12}
              style={({ pressed }) => [styles.saveBtn, pressed && { transform: [{ scale: 0.85 }] }]}
              accessibilityLabel={isWordSaved ? '取消收藏' : '收藏到单词列表'}
            >
              <Star
                size={18}
                color={isWordSaved ? '#F59E0B' : '#94A3B8'}
                fill={isWordSaved ? '#FBBF24' : 'transparent'}
                strokeWidth={1.8}
              />
            </Pressable>
          ) : null}
          <Pressable onPress={onClose} hitSlop={12} style={styles.closeBtn}>
            <X size={18} color="#64748B" />
          </Pressable>
        </View>
      </View>

      {loading ? (
        <View style={styles.loadingArea}>
          <ActivityIndicator size="large" color="#3B82F6" />
          <Text style={styles.loadingHint}>{getLoadingHint()}</Text>
          {dbStatus.phase === 'downloading' && dbStatus.downloadProgress >= 0 ? (
            <View style={styles.progressTrack}>
              <View
                style={[
                  styles.progressFill,
                  { width: `${Math.min(100, Math.round(dbStatus.downloadProgress * 100))}%` },
                ]}
              />
            </View>
          ) : null}
        </View>
      ) : dbStatus.phase === 'failed' ? (
        <View style={styles.emptyArea}>
          <Text style={styles.emptyText}>离线词典暂时不可用</Text>
          <Text style={styles.emptyHint}>{dbStatus.errorMessage || '词典下载失败，请检查网络后重试'}</Text>
          <Pressable onPress={handleRetry} style={styles.retryBtn} hitSlop={8}>
            <RefreshCw size={14} color="#3B82F6" />
            <Text style={styles.retryText}>重新下载</Text>
          </Pressable>
        </View>
      ) : !result || result.matchKind === 'none' || result.entries.length === 0 ? (
        <View style={styles.emptyArea}>
          <Text style={styles.emptyText}>未找到 "{word}" 的词条</Text>
          <Text style={styles.emptyHint}>该词可能不在当前词典范围内</Text>
        </View>
      ) : (
        <ScrollView
          style={styles.scroll}
          contentContainerStyle={[styles.scrollContent, { paddingBottom: Math.max(insets.bottom + 24, 32) }]}
          showsVerticalScrollIndicator={false}
        >
          {contextSentence ? (
            <View style={styles.contextBox}>
              <View style={styles.contextHeader}>
                <Text style={styles.contextLabel}>当前字幕</Text>
                {onToggleSentenceSave && segmentId ? (
                  <Pressable
                    onPress={onToggleSentenceSave}
                    hitSlop={8}
                    style={({ pressed }) => [styles.sentenceStarBtn, pressed && { transform: [{ scale: 0.85 }] }]}
                    accessibilityLabel={isSentenceSaved ? '取消句子收藏' : '收藏整个句子'}
                  >
                    <Star
                      size={14}
                      color={isSentenceSaved ? '#F59E0B' : '#94A3B8'}
                      fill={isSentenceSaved ? '#FBBF24' : 'transparent'}
                    />
                  </Pressable>
                ) : null}
              </View>
              <Text style={styles.contextText}>{contextSentence}</Text>
            </View>
          ) : null}

          {result.matchKind === 'form' && result.lemma && result.lemma !== result.normalized ? (
            <View style={styles.lemmaHint}>
              <Text style={styles.lemmaHintText}>
                词形 "{result.normalized}" → 原型 <Text style={styles.lemmaHintEmphasis}>{result.lemma}</Text>
              </Text>
            </View>
          ) : null}

          {renderEntries(result)}
        </ScrollView>
      )}
    </View>
  );

  if (Platform.OS === 'web') {
    return null;
  }

  return (
    <Modal
      visible={true}
      transparent
      animationType="slide"
      onRequestClose={onClose}
    >
      <View style={styles.modalRoot}>
        <Pressable style={styles.backdrop} onPress={handleBackdropPress} />
        <View style={styles.sheetWrapper}>
          {content}
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  modalRoot: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.45)',
  },
  sheetWrapper: {
    height: Dimensions.get('window').height * 0.75,
  },
  sheet: {
    flex: 1,
    backgroundColor: '#FFFFFF',
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    overflow: 'hidden',
  },
  handleBar: {
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: '#E2E8F0',
    alignSelf: 'center',
    marginTop: 10,
    marginBottom: 4,
  },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: '#F1F5F9',
  },
  topBarRight: {
    flexDirection: 'row',
    alignItems: 'center',
    marginLeft: 'auto',
  },
  queryLabel: {
    fontSize: 13,
    color: '#94A3B8',
    fontStyle: 'italic',
  },
  closeBtn: {
    width: 32,
    height: 32,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 16,
    backgroundColor: '#F8FAFC',
  },
  saveBtn: {
    width: 32,
    height: 32,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 16,
  },
  loadingArea: {
    height: 180,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
  },
  loadingHint: {
    fontSize: 13,
    color: '#64748B',
    lineHeight: 20,
    textAlign: 'center',
    paddingHorizontal: 24,
  },
  progressTrack: {
    marginTop: 8,
    width: '60%',
    height: 4,
    backgroundColor: '#E2E8F0',
    borderRadius: 2,
    overflow: 'hidden',
  },
  progressFill: {
    height: '100%',
    backgroundColor: '#3B82F6',
    borderRadius: 2,
  },
  retryBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 14,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 16,
    backgroundColor: '#EFF6FF',
  },
  retryText: {
    fontSize: 13,
    color: '#3B82F6',
    fontWeight: '600',
  },
  emptyArea: {
    height: 160,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
  },
  emptyText: {
    fontSize: 15,
    fontWeight: '600',
    color: '#334155',
  },
  emptyHint: {
    fontSize: 13,
    color: '#94A3B8',
  },
  moreHintBtn: {
    alignItems: 'center',
    paddingVertical: 10,
  },
  moreHint: {
    fontSize: 13,
    color: '#3B82F6',
    textAlign: 'center',
  },
  scroll: {
    flex: 1,
  },
  scrollContent: {
    paddingHorizontal: 20,
    paddingTop: 16,
    gap: 20,
  },
  contextBox: {
    backgroundColor: '#F8FAFC',
    borderRadius: 12,
    padding: 12,
    gap: 4,
    borderLeftWidth: 3,
    borderLeftColor: '#3B82F6',
  },
  contextHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 2,
  },
  sentenceStarBtn: {
    width: 24,
    height: 24,
    alignItems: 'center',
    justifyContent: 'center',
  },
  contextLabel: {
    fontSize: 11,
    fontWeight: '700',
    color: '#94A3B8',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  contextText: {
    fontSize: 13,
    color: '#334155',
    lineHeight: 20,
  },
  entryBlock: {
    gap: 16,
  },
  entryBlockDivider: {
    paddingTop: 20,
    borderTopWidth: 1,
    borderTopColor: '#F1F5F9',
  },
  definitionBlock: {
    gap: 4,
  },
  translationBlock: {
    gap: 4,
  },
  trDivider: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginVertical: 10,
  },
  trDividerLine: {
    flex: 1,
    height: 1,
    backgroundColor: '#E2E8F0',
  },
  trDividerLabel: {
    fontSize: 10,
    fontWeight: '700',
    color: '#94A3B8',
    letterSpacing: 1,
  },
  sectionLabel: {
    fontSize: 11,
    fontWeight: '700',
    color: '#94A3B8',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  definitionText: {
    fontSize: 15,
    color: '#0F172A',
    lineHeight: 24,
  },
  definitionZh: {
    fontSize: 13,
    color: '#64748B',
    lineHeight: 20,
  },
  senseList: {
    gap: 14,
  },
  senseItem: {
    flexDirection: 'row',
    gap: 6,
    alignItems: 'flex-start',
  },
  senseNumber: {
    fontSize: 14,
    fontWeight: '700',
    color: '#3B82F6',
    minWidth: 20,
    marginTop: 2,
  },
  posChip: {
    alignSelf: 'flex-start',
    backgroundColor: '#EFF6FF',
    paddingHorizontal: 6,
    paddingVertical: 1,
    borderRadius: 4,
    marginRight: 6,
    marginTop: 4,
  },
  posChipText: {
    fontSize: 11,
    color: '#3B82F6',
    fontWeight: '700',
    lineHeight: 16,
  },
  senseLine: {
    flexDirection: 'row',
    alignItems: 'flex-start',
  },
  senseLineBody: {
    flex: 1,
    // flex:1 让 text 拿满 chip 剩下的宽度，文本在 Text 节点内自然换行；
    // 之前只有 flexShrink:1 是不够的 —— text 的 basis 是自然宽度（一长串），
    // 跟 chip 加起来超过行宽时整个 text 节点被 wrap 到下一行，导致 chip 单独占一行。
  },
  senseBody: {
    flex: 1,
    gap: 6,
  },
  inlineExample: {
    backgroundColor: '#F8FAFC',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
    marginTop: 4,
    gap: 2,
  },
  inlineExampleEn: {
    fontSize: 13,
    color: '#334155',
    lineHeight: 20,
    fontStyle: 'italic',
  },
  inlineExampleZh: {
    fontSize: 12,
    color: '#94A3B8',
    lineHeight: 18,
  },
  lemmaHint: {
    backgroundColor: '#EFF6FF',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  lemmaHintText: {
    fontSize: 12,
    color: '#475569',
  },
  lemmaHintEmphasis: {
    fontSize: 13,
    fontWeight: '700',
    color: '#3B82F6',
  },
});
