import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Mic, RotateCcw, Volume2, X } from 'lucide-react-native';
import { colors, spacing, borderRadius, fontSize, fontWeight } from '../../constants/theme';
import type { ShadowingDiffResult, ShadowingTokenComparison } from '../../lib/shadowing/diff';

interface Props {
  targetText: string;
  targetTextZh?: string;
  isRecording: boolean;
  isProcessing: boolean;
  liveTranscript: string;
  diffResult: ShadowingDiffResult | null;
  onReplay: () => void;
  onPressIn: () => void;
  onPressOut: () => void;
  onRetry: () => void;
  onClose?: () => void;
  inModal?: boolean;
}

function renderIssueLabel(result: ShadowingDiffResult | null): string {
  if (!result) return '点按录音，跟读当前句';
  if (result.pass && result.issues.length === 0) return '跟读完成度很好';
  const missing = result.issues.filter((issue) => issue.type === 'missing').length;
  const substitution = result.issues.filter((issue) => issue.type === 'substitution').length;
  const extra = result.issues.filter((issue) => issue.type === 'extra').length;
  const parts: string[] = [];
  if (missing > 0) parts.push(`漏词 ${missing}`);
  if (substitution > 0) parts.push(`替换 ${substitution}`);
  if (extra > 0) parts.push(`多词 ${extra}`);
  return parts.join(' · ') || '再跟一遍会更稳';
}

function tokenStyleFor(status: ShadowingTokenComparison['status']) {
  switch (status) {
    case 'match':
      return [styles.tokenChip, styles.tokenChipMatch, styles.tokenTextMatch] as const;
    case 'missing':
      return [styles.tokenChip, styles.tokenChipMissing, styles.tokenTextMissing] as const;
    case 'extra':
      return [styles.tokenChip, styles.tokenChipExtra, styles.tokenTextExtra] as const;
    case 'substitution':
      return [styles.tokenChip, styles.tokenChipSubstitution, styles.tokenTextSubstitution] as const;
  }
}

function ComparisonRow({
  label,
  items,
}: {
  label: string;
  items: ShadowingTokenComparison[];
}) {
  return (
    <View style={styles.comparisonBlock}>
      <Text style={styles.comparisonLabel}>{label}</Text>
      <View style={styles.tokenWrap}>
        {items.map((item, index) => {
          const [chipStyle, statusStyle, textStyle] = tokenStyleFor(item.status);
          return (
            <View key={`${label}-${index}-${item.text}`} style={[chipStyle, statusStyle]}>
              <Text style={[styles.tokenText, textStyle]}>{item.text}</Text>
              {item.status === 'substitution' && item.counterpart ? (
                <Text style={styles.tokenCounterpart}>↔ {item.counterpart}</Text>
              ) : null}
            </View>
          );
        })}
      </View>
    </View>
  );
}

export function ShadowingPanel({
  targetText,
  targetTextZh,
  isRecording,
  isProcessing,
  liveTranscript,
  diffResult,
  onReplay,
  onPressIn,
  onPressOut,
  onRetry,
  onClose,
  inModal = false,
}: Props) {
  return (
    <View style={[styles.card, inModal && styles.cardModal]}>
      {inModal ? <View style={styles.sheetHandle} /> : null}
      <View style={styles.headerRow}>
        <Text style={styles.title}>句子跟读</Text>
        <View style={styles.headerActions}>
          <Text style={[styles.badge, diffResult?.pass ? styles.badgePass : null]}>{renderIssueLabel(diffResult)}</Text>
          {onClose ? (
            <Pressable style={styles.closeBtn} onPress={onClose}>
              <X size={16} color="#64748B" />
            </Pressable>
          ) : null}
        </View>
      </View>

      <ScrollView style={styles.contentScroll} contentContainerStyle={styles.contentScrollContent} showsVerticalScrollIndicator={false}>
        <View style={styles.targetBox}>
          <Text style={styles.targetLabel}>当前句</Text>
          <Text style={styles.targetText}>{targetText}</Text>
          {targetTextZh ? <Text style={styles.targetZh}>{targetTextZh}</Text> : null}
        </View>

        {liveTranscript ? (
          <View style={styles.transcriptBox}>
            <Text style={styles.transcriptLabel}>{isProcessing ? '识别结果' : '实时转写'}</Text>
            <Text style={styles.transcriptText}>{liveTranscript}</Text>
          </View>
        ) : null}

        {diffResult ? (
          <View style={styles.resultBox}>
            <View style={styles.scoreRow}>
              <View style={styles.scoreChip}>
                <Text style={styles.scoreChipLabel}>完成度</Text>
                <Text style={styles.scoreChipValue}>{Math.round(diffResult.completionScore * 100)}%</Text>
              </View>
              <View style={styles.scoreChip}>
                <Text style={styles.scoreChipLabel}>准确度</Text>
                <Text style={styles.scoreChipValue}>{Math.round(diffResult.accuracyScore * 100)}%</Text>
              </View>
            </View>

            <View style={styles.comparisonCard}>
              <ComparisonRow label="目标句" items={diffResult.targetComparisons} />
              <ComparisonRow label="你的跟读" items={diffResult.transcriptComparisons} />
              <View style={styles.legendRow}>
                <View style={[styles.legendDot, styles.legendDotMatch]} />
                <Text style={styles.legendText}>一致</Text>
                <View style={[styles.legendDot, styles.legendDotMissing]} />
                <Text style={styles.legendText}>缺失 / 多词</Text>
                <View style={[styles.legendDot, styles.legendDotSubstitution]} />
                <Text style={styles.legendText}>不准确</Text>
              </View>
            </View>
          </View>
        ) : null}
      </ScrollView>

      <View style={styles.footerActions}>
        <View style={styles.actionRow}>
          <Pressable style={styles.secondaryBtn} onPress={onReplay}>
            <Volume2 size={16} color="#334155" />
            <Text style={styles.secondaryBtnText}>播放原句</Text>
          </Pressable>
          <Pressable style={styles.secondaryBtn} onPress={onRetry}>
            <RotateCcw size={16} color="#334155" />
            <Text style={styles.secondaryBtnText}>重新录这一句</Text>
          </Pressable>
        </View>

        <Pressable
          style={[styles.recordBtn, isRecording && styles.recordBtnActive, isProcessing && styles.recordBtnDisabled]}
          onPressIn={onPressIn}
          onPressOut={onPressOut}
          disabled={isProcessing}
        >
          <Mic size={18} color="#FFFFFF" />
          <Text style={styles.recordBtnText}>
            {isProcessing ? '识别中…' : isRecording ? '松开发送跟读' : '按住开始跟读'}
          </Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    marginHorizontal: spacing.sm,
    marginBottom: spacing.xs,
    borderRadius: 18,
    backgroundColor: '#F8FAFC',
    borderWidth: 1,
    borderColor: '#DBEAFE',
    overflow: 'hidden',
  },
  cardModal: {
    marginHorizontal: 0,
    marginBottom: 0,
    backgroundColor: '#FFFFFF',
    maxHeight: '100%',
  },
  sheetHandle: {
    alignSelf: 'center',
    width: 40,
    height: 4,
    borderRadius: borderRadius.full,
    backgroundColor: '#E2E8F0',
    marginTop: spacing.sm,
    marginBottom: spacing.sm,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.sm,
  },
  headerActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
  },
  title: {
    color: '#0F172A',
    fontSize: fontSize.base,
    fontWeight: fontWeight.bold,
  },
  badge: {
    color: '#475569',
    fontSize: fontSize.xs,
    fontWeight: fontWeight.bold,
  },
  badgePass: {
    color: colors.primary,
  },
  closeBtn: {
    width: 28,
    height: 28,
    borderRadius: borderRadius.full,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#F1F5F9',
  },
  targetBox: {
    gap: 6,
  },
  contentScroll: {
    flexGrow: 0,
  },
  contentScrollContent: {
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.md,
    gap: spacing.sm,
  },
  targetLabel: {
    color: '#64748B',
    fontSize: fontSize.xs,
    fontWeight: fontWeight.bold,
  },
  targetText: {
    color: '#0F172A',
    fontSize: fontSize.base,
    fontWeight: fontWeight.bold,
    lineHeight: 24,
  },
  targetZh: {
    color: '#64748B',
    fontSize: fontSize.sm,
    lineHeight: 20,
  },
  actionRow: {
    flexDirection: 'row',
    gap: spacing.sm,
  },
  footerActions: {
    paddingHorizontal: spacing.md,
    paddingTop: spacing.sm,
    paddingBottom: spacing.md,
    borderTopWidth: 1,
    borderTopColor: '#E2E8F0',
    backgroundColor: '#FFFFFF',
    gap: spacing.sm,
  },
  secondaryBtn: {
    flex: 1,
    minHeight: 40,
    borderRadius: borderRadius.lg,
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: '#E2E8F0',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
  },
  secondaryBtnText: {
    color: '#334155',
    fontSize: fontSize.sm,
    fontWeight: fontWeight.bold,
  },
  recordBtn: {
    minHeight: 48,
    borderRadius: 999,
    backgroundColor: colors.primary,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  recordBtnActive: {
    backgroundColor: '#DC2626',
  },
  recordBtnDisabled: {
    opacity: 0.7,
  },
  recordBtnText: {
    color: '#FFFFFF',
    fontSize: fontSize.sm,
    fontWeight: fontWeight.bold,
  },
  transcriptBox: {
    padding: spacing.sm,
    borderRadius: borderRadius.lg,
    backgroundColor: '#FFFFFF',
    gap: 6,
  },
  transcriptLabel: {
    color: '#64748B',
    fontSize: fontSize.xs,
    fontWeight: fontWeight.bold,
  },
  transcriptText: {
    color: '#0F172A',
    fontSize: fontSize.sm,
    lineHeight: 20,
  },
  resultBox: {
    gap: spacing.sm,
  },
  comparisonCard: {
    padding: spacing.sm,
    borderRadius: borderRadius.lg,
    backgroundColor: '#FFFFFF',
    gap: spacing.sm,
  },
  comparisonBlock: {
    gap: 8,
  },
  comparisonLabel: {
    color: '#475569',
    fontSize: fontSize.xs,
    fontWeight: fontWeight.bold,
  },
  tokenWrap: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  tokenChip: {
    minHeight: 30,
    paddingHorizontal: 8,
    paddingVertical: 5,
    borderRadius: 10,
    borderWidth: 1,
    gap: 2,
  },
  tokenChipMatch: {
    backgroundColor: '#ECFDF5',
    borderColor: '#A7F3D0',
  },
  tokenChipMissing: {
    backgroundColor: '#FEF2F2',
    borderColor: '#FECACA',
  },
  tokenChipExtra: {
    backgroundColor: '#FFF1F2',
    borderColor: '#FDA4AF',
  },
  tokenChipSubstitution: {
    backgroundColor: '#FFFBEB',
    borderColor: '#FCD34D',
  },
  tokenText: {
    fontSize: fontSize.sm,
    fontWeight: fontWeight.bold,
  },
  tokenTextMatch: {
    color: '#047857',
  },
  tokenTextMissing: {
    color: '#B91C1C',
  },
  tokenTextExtra: {
    color: '#BE123C',
  },
  tokenTextSubstitution: {
    color: '#B45309',
  },
  tokenCounterpart: {
    color: '#92400E',
    fontSize: 10,
  },
  legendRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 6,
    paddingTop: 2,
  },
  legendDot: {
    width: 8,
    height: 8,
    borderRadius: 999,
  },
  legendDotMatch: {
    backgroundColor: '#10B981',
  },
  legendDotMissing: {
    backgroundColor: '#EF4444',
  },
  legendDotSubstitution: {
    backgroundColor: '#F59E0B',
  },
  legendText: {
    color: '#64748B',
    fontSize: 11,
  },
  scoreRow: {
    flexDirection: 'row',
    gap: spacing.sm,
  },
  scoreChip: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: borderRadius.lg,
    backgroundColor: '#FFFFFF',
    alignItems: 'center',
    gap: 4,
  },
  scoreChipLabel: {
    color: '#64748B',
    fontSize: fontSize.xs,
  },
  scoreChipValue: {
    color: '#0F172A',
    fontSize: fontSize.base,
    fontWeight: fontWeight.bold,
  },
 });
