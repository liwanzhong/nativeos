/**
 * /ai-practice/add-custom — natural-language entry for the 自定义话题
 * flow.
 *
 * UX (2026-08-13 redesign):
 *   - ONE hero input. User describes the situation in their own
 *     words. >10 chars routes the LLM to buildCustomQueryPrompt
 *     and binds ALL generated cards to that one situation.
 *   - ONE count chip row (3 / 5 / 8) and ONE primary button.
 *   - Tapping the primary button opens a full-screen GenerateModal
 *     (see ./generate-modal.tsx) that streams cards in. The user
 *     never sits on a blank page waiting.
 *   - "让 AI 引导我" is a de-emphasised link to the multi-turn
 *     guide (./add-custom-guide) for users who can't think of
 *     what to type.
 *
 * The previous template/chip-grid version was deemed "平铺"
 * (6 templates + 2 counts = 8 decisions before any feedback).
 * The new flow has exactly 2 decisions: type + count.
 */

import {
  View,
  Text,
  StyleSheet,
  Pressable,
  TextInput,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
} from 'react-native';
import { Stack, useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { ArrowLeft, Sparkles, Wand2 } from 'lucide-react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors, spacing, borderRadius, fontSize, fontWeight } from '../../constants/theme';
import { GenerateModal } from './generate-modal';

const MAX_INPUT_LENGTH = 200;
const COUNT_OPTIONS: ReadonlyArray<number> = [3, 5, 8];
const DEFAULT_COUNT = 5;

export default function AiPracticeAddCustomPage() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [customInput, setCustomInput] = useState('');
  const [selectedCount, setSelectedCount] = useState<number>(DEFAULT_COUNT);
  const [isInputFocused, setIsInputFocused] = useState(false);
  const [userLevel, setUserLevel] = useState('B1');
  const [isGenerateOpen, setIsGenerateOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const AsyncStorage = (await import('@react-native-async-storage/async-storage')).default;
        const level = (await AsyncStorage.getItem('user_level')) || 'B1';
        if (!cancelled) setUserLevel(level);
      } catch {
        // B1 default.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleOpenGenerate = useCallback(() => {
    setIsGenerateOpen(true);
  }, []);

  const handleCloseGenerate = useCallback(() => {
    setIsGenerateOpen(false);
  }, []);

  const handleOpenGuide = useCallback(() => {
    router.push('/ai-practice/add-custom-guide');
  }, [router]);

  return (
    <>
      <Stack.Screen
        options={{
          headerShown: true,
          title: '自定义话题',
          headerShadowVisible: false,
          headerStyle: { backgroundColor: colors.background },
          headerTitleStyle: { color: colors.text.primary, fontSize: fontSize.lg, fontWeight: fontWeight.semibold },
          headerLeft: () => (
            <Pressable hitSlop={8} onPress={() => router.back()} style={styles.headerBack}>
              <ArrowLeft size={20} color={colors.text.primary} />
            </Pressable>
          ),
        }}
      />
      <KeyboardAvoidingView
        style={styles.container}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView
          style={styles.scroll}
          contentContainerStyle={[styles.scrollContent, { paddingBottom: Math.max(120, insets.bottom + 96) }]}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
        >
          {/* Hero 输入框 */}
          <View
            style={[
              styles.heroInputWrap,
              isInputFocused && styles.heroInputWrapFocused,
            ]}
          >
            <TextInput
              style={styles.heroInput}
              value={customInput}
              onChangeText={(text) => setCustomInput(text.slice(0, MAX_INPUT_LENGTH))}
              onFocus={() => setIsInputFocused(true)}
              onBlur={() => setIsInputFocused(false)}
              placeholder="描述你想练的话题（比如：在咖啡店点单时遇到过敏原问题）"
              placeholderTextColor={colors.text.tertiary}
              multiline
              maxLength={MAX_INPUT_LENGTH}
            />
            <Text style={styles.charCount}>{customInput.length} / {MAX_INPUT_LENGTH}</Text>
          </View>

          {/* 数量 + 主按钮（一行） */}
          <View style={styles.actionRow}>
            <View style={styles.countRow}>
              {COUNT_OPTIONS.map((count) => {
                const active = selectedCount === count;
                return (
                  <Pressable
                    key={`count-chip-${count}`}
                    style={[styles.countChip, active && styles.countChipActive]}
                    onPress={() => setSelectedCount(count)}
                  >
                    <Text style={[styles.countChipText, active && styles.countChipTextActive]}>
                      {count} 个
                    </Text>
                  </Pressable>
                );
              })}
            </View>
            <Pressable style={styles.primaryBtn} onPress={handleOpenGenerate}>
              <Sparkles size={16} color="#FFFFFF" />
              <Text style={styles.primaryBtnText}>生成</Text>
            </Pressable>
          </View>

          {/* 引导入口：让 AI 引导我（蓝色链接样式） */}
          <Pressable style={styles.guideLink} onPress={handleOpenGuide} hitSlop={12}>
            <Wand2 size={18} color={colors.primary} />
            <Text style={styles.guideLinkText}>不知道怎么写？让 AI 引导我</Text>
            <Text style={styles.guideLinkArrow}>›</Text>
          </Pressable>
        </ScrollView>
      </KeyboardAvoidingView>

      <GenerateModal
        visible={isGenerateOpen}
        onClose={handleCloseGenerate}
        prompt={customInput.trim()}
        interests={customInput.trim().length > 10 ? [customInput.trim()] : ['日常']}
        userLevel={userLevel}
        count={selectedCount}
      />
    </>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
  },
  headerBack: {
    paddingHorizontal: 4,
    paddingVertical: 4,
  },
  scroll: {
    flex: 1,
  },
  scrollContent: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
  },

  // Hero 输入框
  heroInputWrap: {
    backgroundColor: '#F0F7FF',
    borderRadius: borderRadius.xl,
    borderWidth: 1.5,
    borderColor: '#DBEAFE',
    paddingHorizontal: 16,
    paddingTop: 14,
    paddingBottom: 10,
  },
  heroInputWrapFocused: {
    borderColor: colors.primary,
    backgroundColor: '#FFFFFF',
  },
  heroInput: {
    minHeight: 120,
    fontSize: 15,
    lineHeight: 22,
    color: colors.text.primary,
    textAlignVertical: 'top',
    fontWeight: fontWeight.medium,
  },
  charCount: {
    fontSize: 11,
    color: colors.text.tertiary,
    textAlign: 'right',
    marginTop: 6,
  },

  // 数量 + 主按钮
  actionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginTop: spacing.md,
  },
  countRow: {
    flexDirection: 'row',
    gap: 6,
    flex: 1,
  },
  countChip: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: borderRadius.full,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border.light,
    alignItems: 'center',
  },
  countChipActive: {
    backgroundColor: '#EFF6FF',
    borderColor: colors.primary,
  },
  countChipText: {
    fontSize: fontSize.sm,
    color: colors.text.secondary,
    fontWeight: fontWeight.medium,
  },
  countChipTextActive: {
    color: colors.primary,
    fontWeight: fontWeight.bold,
  },
  primaryBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingHorizontal: spacing.lg,
    paddingVertical: 12,
    borderRadius: borderRadius.full,
    backgroundColor: colors.primary,
  },
  primaryBtnText: {
    fontSize: fontSize.sm,
    fontWeight: fontWeight.bold,
    color: '#FFFFFF',
  },

  // 引导链接（蓝色，明显可点）
  guideLink: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 14,
    paddingHorizontal: 18,
    marginTop: spacing.lg,
    borderRadius: borderRadius.full,
    backgroundColor: 'rgba(37, 99, 235, 0.08)',
    borderWidth: 1,
    borderColor: 'rgba(37, 99, 235, 0.25)',
  },
  guideLinkText: {
    fontSize: fontSize.base,
    color: colors.primary,
    fontWeight: fontWeight.semibold,
  },
  guideLinkArrow: {
    fontSize: 22,
    color: colors.primary,
    fontWeight: fontWeight.medium,
    lineHeight: 22,
  },
});
