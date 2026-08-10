import { View, Text, StyleSheet, ScrollView, Pressable, Platform } from 'react-native';
import { useRouter } from 'expo-router';
import { useState, useEffect } from 'react';
import { ChevronRight } from 'lucide-react-native';
import { colors, spacing, borderRadius, fontSize, fontWeight } from '../../constants/theme';
import { updateUserProfile } from '../../lib/user-profile';

interface Domain { id: string; label: string; }

const DOMAINS_BY_LEVEL: Record<string, Domain[]> = {
  A1: [
    { id: 'greet',      label: '👋 打招呼' },
    { id: 'selfintro',  label: '🙋 自我介绍' },
    { id: 'numbers',    label: '🔢 数字金额' },
    { id: 'ask_dir',    label: '🗺️ 问路指路' },
    { id: 'order_food', label: '🍜 点餐外卖' },
    { id: 'shopping',   label: '🛒 基础购物' },
    { id: 'time_date',  label: '🕐 时间日期' },
    { id: 'weather',    label: '⛅ 天气闲聊' },
    { id: 'family',     label: '👨‍👩‍👧 家庭成员' },
    { id: 'transport',  label: '🚌 乘车出行' },
    { id: 'hotel',      label: '🏨 酒店入住' },
    { id: 'pharmacy',   label: '💊 药店购药' },
  ],
  A2: [
    { id: 'daily',      label: '💬 日常闲聊' },
    { id: 'shopping2',  label: '🏬 逛街砍价' },
    { id: 'restaurant', label: '🍽️ 餐厅点餐' },
    { id: 'social',     label: '☕ 社交搭话' },
    { id: 'phone',      label: '📱 打电话' },
    { id: 'hobby',      label: '🎨 兴趣爱好' },
    { id: 'weekend',    label: '🏖️ 周末计划' },
    { id: 'neighbors',  label: '🏘️ 邻居邻居' },
    { id: 'kids',       label: '👨‍👧 教孩子英语' },
    { id: 'pet',        label: '🐾 宠物话题' },
    { id: 'gym',        label: '🏋️ 健身运动' },
    { id: 'cinema',     label: '🎬 看电影' },
    { id: 'post',       label: '📮 邮局快递' },
    { id: 'bank_basic', label: '🏦 银行取款' },
  ],
  B1: [
    { id: 'work',       label: '💼 职场沟通' },
    { id: 'meeting',    label: '📋 会议讨论' },
    { id: 'travel',     label: '✈️ 出国旅行' },
    { id: 'airport',    label: '🛫 机场问题' },
    { id: 'medical',    label: '🏥 就医问诊' },
    { id: 'complaint',  label: '😤 投诉维权' },
    { id: 'negotiate',  label: '🤝 基础谈判' },
    { id: 'gaming',     label: '🎮 游戏社交' },
    { id: 'interview1', label: '🎤 初级面试' },
    { id: 'rent',       label: '🏠 租房看房' },
    { id: 'collab',     label: '🧑‍💻 跨部门协作' },
    { id: 'email',      label: '📧 商务邮件' },
    { id: 'presentation', label: '📊 简单汇报' },
    { id: 'study_abroad1', label: '🎓 留学咨询' },
    { id: 'social_b1',  label: '🥂 社交活动' },
  ],
  B2: [
    { id: 'interview2', label: '🎯 高级面试' },
    { id: 'negotiation',label: '💡 商务谈判' },
    { id: 'it',         label: '💻 IT与编程' },
    { id: 'finance',    label: '📈 金融理财' },
    { id: 'hr',         label: '🧑‍💼 人事管理' },
    { id: 'study2',     label: '🎓 留学申请' },
    { id: 'academic',   label: '📚 学术讨论' },
    { id: 'media',      label: '📰 新闻媒体' },
    { id: 'startup',    label: '🚀 创业融资' },
    { id: 'legal',      label: '⚖️ 法律合同' },
    { id: 'marketing',  label: '📣 市场营销' },
    { id: 'remote',     label: '🌍 远程办公' },
    { id: 'conflict',   label: '🔥 职场冲突' },
    { id: 'design',     label: '🎨 创意设计' },
    { id: 'science',    label: '🔬 科技话题' },
    { id: 'ethics',     label: '🤔 职业伦理' },
  ],
  C1: [
    { id: 'leadership', label: '👑 领导力' },
    { id: 'crisis',     label: '🚨 危机公关' },
    { id: 'boardroom',  label: '🏛️ 董事会汇报' },
    { id: 'academia',   label: '🔭 学术演讲' },
    { id: 'policy',     label: '🗳️ 政策讨论' },
    { id: 'crosscult',  label: '🌐 跨文化沟通' },
    { id: 'phd',        label: '📜 博士申请' },
    { id: 'pitch',      label: '💼 投资路演' },
    { id: 'debate',     label: '🎭 辩论说服' },
    { id: 'mentoring',  label: '🧑‍🏫 导师对话' },
    { id: 'satire',     label: '😏 幽默反讽' },
    { id: 'media_c1',   label: '📡 媒体采访' },
    { id: 'philosophy', label: '💭 哲学思辨' },
    { id: 'law',        label: '⚖️ 法庭陈述' },
    { id: 'diplomacy',  label: '🤝 外交谈判' },
    { id: 'literature', label: '📖 文学评析' },
    { id: 'startup_c1', label: '🦄 创业融资' },
    { id: 'complex_neg',label: '🔑 复杂谈判' },
  ],
  C2: [
    { id: 'native_humor',label: '😂 母语幽默' },
    { id: 'idiom',      label: '🎯 俚语习语' },
    { id: 'subtle_neg', label: '🎲 弦外之音' },
    { id: 'exec_comm',  label: '🌟 高管沟通' },
    { id: 'storytell',  label: '📖 叙事演讲' },
    { id: 'improv',     label: '🎭 即兴应变' },
    { id: 'cultural',   label: '🎪 文化典故' },
    { id: 'poetry',     label: '✍️ 诗歌创作' },
    { id: 'think_tank', label: '🧠 智库研讨' },
    { id: 'global_biz', label: '🌍 全球商务' },
    { id: 'crisis_c2',  label: '🚨 极限危机' },
    { id: 'memoir',     label: '💫 个人陈述' },
    { id: 'ceo',        label: '👔 CEO发言' },
    { id: 'nuance',     label: '🔮 语义细微差别' },
  ],
};

export default function LevelTestScreen() {
  const router = useRouter();
  const [selected, setSelected] = useState<string[]>([]);
  const [userLevel, setUserLevel] = useState<string>('B1');

  useEffect(() => {
    import('@react-native-async-storage/async-storage').then(m => {
      m.default.getItem('user_level').then(lv => { if (lv) setUserLevel(lv); }).catch(() => {});
    });
  }, []);

  const MAX_SELECT = 3;

  const toggle = (id: string) => {
    setSelected(prev =>
      prev.includes(id)
        ? prev.filter(x => x !== id)
        : prev.length >= MAX_SELECT ? prev : [...prev, id]
    );
  };

  const canFinish = selected.length > 0;

  const handleFinish = async () => {
    if (!canFinish) return;
    const domains = DOMAINS_BY_LEVEL[userLevel] ?? DOMAINS_BY_LEVEL['B1'];
    const interests = selected.map(id => domains.find((d: Domain) => d.id === id)?.label ?? id);
    try {
      const AsyncStorage = (await import('@react-native-async-storage/async-storage')).default;
      await AsyncStorage.setItem('user_interests', JSON.stringify(interests));
      await AsyncStorage.setItem('onboarding_completed', 'true');
      if (Platform.OS !== 'web') {
        await updateUserProfile({ interests, onboardingCompleted: true });
      }
    } catch (e) {
      console.warn('Failed to save interests:', e);
    }
    router.replace('/(tabs)/videos');
  };

  return (
    <View style={styles.container}>
      {/* Step indicator */}
      <View style={styles.stepBar}>
        <View style={styles.stepDotDone} />
        <View style={styles.stepLineDone} />
        <View style={[styles.stepDot, styles.stepDotActive]} />
      </View>

      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={styles.scrollContent}
      >
        <View style={styles.titleBlock}>
          <Text style={styles.stepLabel}>STEP 2 / 2</Text>
          <Text style={styles.mainTitle}>核心实战场景</Text>
          <Text style={styles.subtitle}>选择你最想突破的场景，AI陪练会优先生成对应任务；进入应用后会先进入视频跟练，也可以在底部切到AI陪练。最多选 3 项。</Text>
        </View>

        <View style={styles.domainGrid}>
          {(DOMAINS_BY_LEVEL[userLevel] ?? DOMAINS_BY_LEVEL['B1']).map((item: Domain) => {
            const isSelected = selected.includes(item.id);
            return (
              <Pressable
                key={item.id}
                style={[styles.domainCard, isSelected && styles.domainCardSelected]}
                onPress={() => toggle(item.id)}
              >
                <Text style={[styles.domainLabel, isSelected && styles.domainLabelSelected]}>
                  {item.label}
                </Text>
              </Pressable>
            );
          })}
        </View>

        {selected.length > 0 && (
          <Text style={styles.hint}>已选 {selected.length} / {MAX_SELECT} 个场景</Text>
        )}
      </ScrollView>

      <View style={styles.footer}>
        <Pressable
          style={[styles.finishBtn, !canFinish && styles.finishBtnDisabled]}
          onPress={handleFinish}
          disabled={!canFinish}
        >
          <Text style={[styles.finishBtnText, !canFinish && styles.finishBtnTextDisabled]}>
            开始重塑
          </Text>
          <ChevronRight size={20} color={canFinish ? colors.text.inverse : '#9CA3AF'} />
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
  stepDotDone: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: colors.primary,
  },
  stepLine: {
    flex: 1,
    height: 2,
    backgroundColor: colors.border.light,
    borderRadius: 1,
  },
  stepLineDone: {
    flex: 1,
    height: 2,
    backgroundColor: colors.primary,
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

  domainGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
  domainCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: spacing.md,
    paddingVertical: 12,
    borderRadius: borderRadius.xl,
    backgroundColor: colors.surface,
    borderWidth: 1.5,
    borderColor: colors.border.default,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.04,
    shadowRadius: 4,
    elevation: 1,
  },
  domainCardSelected: {
    backgroundColor: '#111827',
    borderColor: '#111827',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.15,
    shadowRadius: 8,
    elevation: 4,
  },
  domainLabel: {
    fontSize: fontSize.sm,
    fontWeight: fontWeight.medium,
    color: colors.text.secondary,
  },
  domainLabelSelected: {
    color: '#fff',
    fontWeight: fontWeight.bold,
  },
  hint: {
    fontSize: fontSize.xs,
    color: colors.primary,
    fontWeight: fontWeight.semibold,
    textAlign: 'center',
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
  finishBtn: {
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
  finishBtnDisabled: {
    backgroundColor: '#E5E7EB',
    shadowOpacity: 0,
    elevation: 0,
  },
  finishBtnText: {
    color: colors.text.inverse,
    fontSize: fontSize.lg,
    fontWeight: fontWeight.bold,
  },
  finishBtnTextDisabled: { color: '#9CA3AF' },
});
