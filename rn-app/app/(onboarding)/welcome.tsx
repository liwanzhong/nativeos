import { View, Text, StyleSheet, ScrollView, Pressable, Platform } from 'react-native';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { ChevronRight } from 'lucide-react-native';
import { colors, spacing, borderRadius, fontSize, fontWeight } from '../../constants/theme';
import { updateUserProfile } from '../../lib/user-profile';
import type { CEFRLevel } from '../../types';

const LEVELS = [
  {
    id: 'A1',
    badge: 'A1',
    stage: '🟢',
    title: '入门级 · 零基础',
    vocab: '~500 词',
    desc: '能点餐、问路，靠翻译软件走天下',
    anchor: '小学三年级至六年级',
  },
  {
    id: 'A2',
    badge: 'A2',
    stage: '🟢',
    title: '初级 · 日常基础',
    vocab: '~1,000 - 1,500 词',
    desc: '能描述自身背景和简单需求',
    anchor: '初中毕业水平',
  },
  {
    id: 'B1',
    badge: 'B1',
    stage: '🟡',
    title: '中级 · 中阶瓶颈期',
    vocab: '~2,000 - 3,000 词',
    desc: '开口前要先在脑子里翻译一遍中文',
    anchor: '高考及格 / 雅思 4.0 - 5.0',
  },
  {
    id: 'B2',
    badge: 'B2',
    stage: '🟡',
    title: '中高级 · 职场黄金线',
    vocab: '~4,000 - 6,000 词',
    desc: '看懂专业文章，但俚语和连读还费劲',
    anchor: 'CET-4/6 良好 / 雅思 5.5 - 6.5',
  },
  {
    id: 'C1',
    badge: 'C1',
    stage: '🔴',
    title: '高级 · 学术商务自如',
    vocab: '~8,000 - 10,000 词',
    desc: '能无字幕看剧，懂弦外之音',
    anchor: '专业八级 / 雅思 7.0 - 8.0',
  },
  {
    id: 'C2',
    badge: 'C2',
    stage: '🔴',
    title: '精通级 · 近母语',
    vocab: '15,000+ 词',
    desc: '精准表达极其细微的语义差别',
    anchor: '雅思 8.5 - 9.0',
  },
];

export default function WelcomeScreen() {
  const router = useRouter();
  const [selectedLevel, setSelectedLevel] = useState<string | null>(null);

  const handleNext = async () => {
    if (!selectedLevel) return;
    try {
      const AsyncStorage = (await import('@react-native-async-storage/async-storage')).default;
      await AsyncStorage.setItem('user_level', selectedLevel);
      if (Platform.OS !== 'web') {
        await updateUserProfile({ level: selectedLevel as CEFRLevel });
      }
    } catch (e) {
      console.warn('Failed to save level:', e);
    }
    router.push('/(onboarding)/level-test');
  };

  return (
    <View style={styles.container}>
      {/* Step indicator */}
      <View style={styles.stepBar}>
        <View style={[styles.stepDot, styles.stepDotActive]} />
        <View style={styles.stepLine} />
        <View style={styles.stepDot} />
      </View>

      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={styles.scrollContent}
      >
        <View style={styles.titleBlock}>
          <Text style={styles.stepLabel}>STEP 1 / 2</Text>
          <Text style={styles.mainTitle}>定制你的母语直觉</Text>
          <Text style={styles.subtitle}>拒绝考试，用最真实的状态设定基准线。</Text>
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionLabel}>真实水平自评</Text>
          <View style={styles.levelList}>
            {LEVELS.map(item => (
              <Pressable
                key={item.id}
                style={[
                  styles.levelCard,
                  selectedLevel === item.id && styles.levelCardSelected,
                ]}
                onPress={() => setSelectedLevel(item.id)}
              >
                <View style={[styles.levelBadge, selectedLevel === item.id && styles.levelBadgeSelected]}>
                  <Text style={styles.levelStage}>{item.stage}</Text>
                  <Text style={[styles.levelBadgeText, selectedLevel === item.id && styles.levelBadgeTextSelected]}>
                    {item.badge}
                  </Text>
                </View>
                <View style={styles.levelText}>
                  <Text style={[
                    styles.levelTitle,
                    selectedLevel === item.id && styles.levelTitleSelected,
                  ]}>
                    {item.title}
                  </Text>
                  <Text style={styles.levelDesc}>{item.desc}</Text>
                  <Text style={styles.levelAnchor}>{item.vocab} · {item.anchor}</Text>
                </View>
              </Pressable>
            ))}
          </View>
        </View>
      </ScrollView>

      <View style={styles.footer}>
        <Pressable
          style={[styles.nextBtn, !selectedLevel && styles.nextBtnDisabled]}
          onPress={handleNext}
          disabled={!selectedLevel}
        >
          <Text style={[styles.nextBtnText, !selectedLevel && styles.nextBtnTextDisabled]}>
            下一步
          </Text>
          <ChevronRight size={20} color={selectedLevel ? colors.text.inverse : '#9CA3AF'} />
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#F9FAFB' },

  /* Step indicator */
  stepBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.lg,
    paddingTop: 60,
    paddingBottom: spacing.md,
    gap: spacing.sm,
  },
  stepDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: colors.border.default,
  },
  stepDotActive: {
    backgroundColor: colors.primary,
    width: 24,
    borderRadius: 5,
  },
  stepLine: {
    flex: 1,
    height: 2,
    backgroundColor: colors.border.light,
    borderRadius: 1,
  },

  scrollContent: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    paddingBottom: 120,
    gap: spacing.xl,
  },

  titleBlock: { gap: spacing.xs },
  stepLabel: {
    fontSize: 11,
    fontWeight: fontWeight.bold,
    color: colors.primary,
    letterSpacing: 1.5,
    textTransform: 'uppercase',
    marginBottom: spacing.xs,
  },
  mainTitle: {
    fontSize: 28,
    fontWeight: fontWeight.bold,
    color: colors.text.primary,
    letterSpacing: -0.5,
  },
  subtitle: {
    fontSize: fontSize.sm,
    color: colors.text.secondary,
    lineHeight: 22,
    marginTop: spacing.xs,
  },

  section: { gap: spacing.md },
  sectionLabel: {
    fontSize: fontSize.sm,
    fontWeight: fontWeight.bold,
    color: colors.text.tertiary,
    textTransform: 'uppercase',
    letterSpacing: 1.5,
  },

  levelList: { gap: spacing.sm },
  levelCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    backgroundColor: colors.surface,
    borderRadius: borderRadius.xl,
    padding: spacing.md,
    borderWidth: 2,
    borderColor: colors.border.light,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.04,
    shadowRadius: 4,
    elevation: 1,
  },
  levelCardSelected: {
    borderColor: colors.primary,
    backgroundColor: '#EFF6FF',
    shadowColor: colors.primary,
    shadowOpacity: 0.1,
    shadowRadius: 8,
    elevation: 2,
  },
  levelBadge: {
    width: 52,
    alignItems: 'center',
    gap: 2,
    backgroundColor: '#F3F4F6',
    borderRadius: borderRadius.lg,
    paddingVertical: 8,
    paddingHorizontal: 6,
  },
  levelBadgeSelected: {
    backgroundColor: '#DBEAFE',
  },
  levelStage: { fontSize: 16 },
  levelBadgeText: {
    fontSize: 13,
    fontWeight: fontWeight.bold,
    color: colors.text.secondary,
  },
  levelBadgeTextSelected: {
    color: '#1D4ED8',
  },
  levelText: { flex: 1 },
  levelTitle: {
    fontSize: fontSize.sm,
    fontWeight: fontWeight.bold,
    color: colors.text.primary,
    marginBottom: 2,
  },
  levelTitleSelected: { color: '#1D4ED8' },
  levelDesc: {
    fontSize: fontSize.xs,
    color: colors.text.secondary,
    lineHeight: 18,
  },
  levelAnchor: {
    fontSize: 10,
    color: colors.text.tertiary,
    marginTop: 2,
  },

  footer: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    paddingHorizontal: spacing.lg,
    paddingBottom: 48,
    paddingTop: spacing.lg,
    backgroundColor: '#F9FAFB',
    borderTopWidth: 1,
    borderTopColor: colors.border.light,
  },
  nextBtn: {
    backgroundColor: colors.primary,
    paddingVertical: 16,
    borderRadius: borderRadius.xl,
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    gap: spacing.sm,
    shadowColor: colors.primary,
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.25,
    shadowRadius: 20,
    elevation: 6,
  },
  nextBtnDisabled: {
    backgroundColor: '#E5E7EB',
    shadowOpacity: 0,
    elevation: 0,
  },
  nextBtnText: {
    color: colors.text.inverse,
    fontSize: fontSize.lg,
    fontWeight: fontWeight.bold,
  },
  nextBtnTextDisabled: { color: '#9CA3AF' },
});
