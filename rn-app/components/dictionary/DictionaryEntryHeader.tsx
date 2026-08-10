import { View, Text, StyleSheet } from 'react-native';
import { DictionaryAudioButton } from './DictionaryAudioButton';
import type { DictionaryEntry } from '../../lib/dictionary/types';

/** 考试/教材标签 → 中文（按 ECDICT README：zk/中考 gk/高考 cet4/四级 cet6/六级 ky/考研） */
const TAG_LABELS: Record<string, string> = {
  zk: '中考',
  gk: '高考',
  cet4: 'CET-4',
  cet6: 'CET-6',
  ky: '考研',
  toefl: '托福',
  ielts: '雅思',
  gre: 'GRE',
};

function collinsStars(collins: number): string {
  // 1-5 星
  const n = Math.max(0, Math.min(5, collins));
  return '★'.repeat(n) + '☆'.repeat(5 - n);
}

function buildAuthorityLine(entry: DictionaryEntry): string | null {
  const bits: string[] = [];
  if (entry.collins > 0) bits.push(`柯林斯 ${collinsStars(entry.collins)}`);
  if (entry.oxford) bits.push('牛津 3000');
  return bits.length > 0 ? bits.join(' · ') : null;
}

function buildExamLine(entry: DictionaryEntry): string | null {
  if (!entry.tag) return null;
  const labels = entry.tag
    .split(/\s+/)
    .map((c) => TAG_LABELS[c] ?? c.toUpperCase())
    .filter(Boolean);
  return labels.length > 0 ? labels.join(' · ') : null;
}

export function DictionaryEntryHeader({ entry }: { entry: DictionaryEntry }) {
  const authority = buildAuthorityLine(entry);
  const exam = buildExamLine(entry);

  return (
    <View style={styles.container}>
      <View style={styles.topRow}>
        <Text style={styles.headword}>{entry.word}</Text>
        <DictionaryAudioButton audioKey={entry.audio} size={18} />
      </View>
      {entry.phonetic ? (
        <Text style={styles.ipa}>/{entry.phonetic}/</Text>
      ) : null}
      {authority ? <Text style={styles.authority}>{authority}</Text> : null}
      {exam ? <Text style={styles.exam}>考试：{exam}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#F1F5F9',
    gap: 4,
  },
  topRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    flexWrap: 'wrap',
  },
  headword: {
    fontSize: 22,
    fontWeight: '700',
    color: '#0F172A',
    letterSpacing: -0.3,
  },
  ipa: {
    fontSize: 14,
    color: '#475569',
    fontStyle: 'italic',
  },
  authority: {
    fontSize: 12,
    color: '#475569',
    fontWeight: '500',
  },
  exam: {
    fontSize: 11,
    color: '#94A3B8',
  },
});
