/**
 * Feedback form — user describes a problem + picks category/severity,
 * and we generate a plain-text bundle (logs + app state + device info)
 * and hand it off to the system share sheet.
 *
 * The form is intentionally short:
 *   - Description (textarea, required, multiline)
 *   - Category (6 options)
 *   - Severity (3 options)
 *   - [Generate & share] button
 *
 * On submit we call `submitFeedback(payload)` (see
 * `lib/diagnostics/feedback.ts`) which:
 *   1. collects the snapshot (async, no UI block)
 *   2. writes a .txt to documentDirectory/feedback/
 *   3. opens the system chooser via NativeChooser
 *   4. resolves immediately (the chooser is fire-and-forget, like the
 *      backup zip share)
 *
 * No server upload. No screenshots. No JSON. Just a human-readable
 * .txt the user can paste into Lark/IM/email.
 */

import React, { useCallback, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ChevronLeft, AlertCircle } from 'lucide-react-native';
import { borderRadius, colors, fontSize, fontWeight, spacing } from '../../constants/theme';
import { sectionStyles } from '../../constants/sectionStyles';
import {
  FEEDBACK_CATEGORIES,
  FEEDBACK_SEVERITIES,
  submitFeedback,
  type FeedbackCategory,
  type FeedbackSeverity,
} from '../../lib/diagnostics/feedback';
import { getLogBufferSize } from '../../lib/diagnostics/logStore';

const DEFAULT_CATEGORY: FeedbackCategory = 'other';
const DEFAULT_SEVERITY: FeedbackSeverity = 'minor';

export default function FeedbackScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const [description, setDescription] = useState('');
  const [category, setCategory] = useState<FeedbackCategory>(DEFAULT_CATEGORY);
  const [severity, setSeverity] = useState<FeedbackSeverity>(DEFAULT_SEVERITY);
  const [submitting, setSubmitting] = useState(false);

  const descTrimmed = description.trim();
  const canSubmit = descTrimmed.length > 0 && !submitting;

  const logCount = useMemo(() => getLogBufferSize(), []);

  const handleSubmit = useCallback(async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    try {
      const result = await submitFeedback({
        description: descTrimmed,
        category,
        severity,
        clearLogsAfter: false,
      });
      if (result.outcome === 'error' || result.outcome === 'no_native_module') {
        Alert.alert(
          '反馈未发出',
          result.message ?? '请稍后再试',
          result.internalPath
            ? [
                { text: '知道了', style: 'cancel' },
                {
                  text: '复制文件路径',
                  onPress: () => {
                    // No clipboard API in our deps; just dismiss with a
                    // toast-like alert so the user can take a screenshot
                    // of the path.
                    Alert.alert('文件已保留', result.internalPath!);
                  },
                },
              ]
            : undefined,
        );
      } else {
        // Success: the chooser is up. Pop back to settings so the user
        // can keep using the app without re-rendering this form.
        router.back();
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      Alert.alert('反馈失败', msg);
    } finally {
      setSubmitting(false);
    }
  }, [canSubmit, category, severity, descTrimmed, router]);

  return (
    <View style={styles.container}>
      <View style={[styles.header, { paddingTop: insets.top + 6 }]}>
        <Pressable style={styles.backBtn} onPress={() => router.back()}>
          <ChevronLeft size={20} color={colors.text.primary} />
        </Pressable>
        <Text style={styles.headerTitle} numberOfLines={1}>
          反馈问题
        </Text>
        <View style={styles.headerSpacer} />
      </View>

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={[styles.scrollContent, { paddingBottom: insets.bottom + 96 }]}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        <View style={sectionStyles.sectionBlock}>
          <View style={styles.introBox}>
            <AlertCircle size={16} color={colors.text.secondary} />
            <Text style={styles.introText}>
              填写下面信息后，会把最近 {logCount} 条日志、设备信息和当前 app 状态打包成一个文本文件，
              通过系统分享面板发出来。整个过程不联网、不上传服务器，文件由你决定发给谁。
            </Text>
          </View>
        </View>

        {/* Description */}
        <View style={sectionStyles.sectionBlock}>
          <Text style={styles.label}>
            问题描述<Text style={styles.required}> *</Text>
          </Text>
          <TextInput
            style={styles.textarea}
            value={description}
            onChangeText={setDescription}
            placeholder="把操作步骤、出错的位置、期望的结果、实际看到的结果写一下。越具体越能定位。"
            placeholderTextColor={colors.text.tertiary}
            multiline
            numberOfLines={6}
            textAlignVertical="top"
            maxLength={4000}
          />
          <Text style={styles.hint}>{descTrimmed.length} / 4000</Text>
        </View>

        {/* Category */}
        <View style={sectionStyles.sectionBlock}>
          <Text style={styles.label}>类别</Text>
          <View style={styles.chipGroup}>
            {FEEDBACK_CATEGORIES.map((c) => {
              const active = c.value === category;
              return (
                <Pressable
                  key={c.value}
                  style={[styles.chip, active && styles.chipActive]}
                  onPress={() => setCategory(c.value)}
                >
                  <Text style={[styles.chipText, active && styles.chipTextActive]}>
                    {c.label}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        </View>

        {/* Severity */}
        <View style={sectionStyles.sectionBlock}>
          <Text style={styles.label}>严重度</Text>
          <View style={styles.severityList}>
            {FEEDBACK_SEVERITIES.map((s) => {
              const active = s.value === severity;
              return (
                <Pressable
                  key={s.value}
                  style={[styles.severityRow, active && styles.severityRowActive]}
                  onPress={() => setSeverity(s.value)}
                >
                  <View style={styles.severityText}>
                    <Text style={[styles.severityTitle, active && styles.severityTitleActive]}>
                      {s.label}
                    </Text>
                    <Text style={styles.severityDesc}>{s.desc}</Text>
                  </View>
                  <View style={[styles.radio, active && styles.radioActive]} />
                </Pressable>
              );
            })}
          </View>
        </View>

        {/* Bottom submit bar — outside the scroll content so it's
            always visible above the keyboard. */}
      </ScrollView>

      <View
        style={[
          styles.submitBar,
          { paddingBottom: insets.bottom + spacing.md },
        ]}
      >
        <Pressable
          style={[styles.submitBtn, !canSubmit && styles.submitBtnDisabled]}
          onPress={handleSubmit}
          disabled={!canSubmit}
        >
          {submitting ? (
            <ActivityIndicator size="small" color={colors.text.inverse} />
          ) : (
            <Text style={styles.submitBtnText}>生成并分享反馈</Text>
          )}
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.background,
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.md,
  },
  backBtn: {
    width: 36,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 18,
  },
  headerTitle: {
    flex: 1,
    fontSize: fontSize.lg,
    fontWeight: fontWeight.semibold,
    color: colors.text.primary,
  },
  headerSpacer: { width: 36 },
  scroll: { flex: 1 },
  scrollContent: { padding: spacing.lg, gap: spacing.xl },
  introBox: {
    flexDirection: 'row',
    gap: spacing.sm,
    backgroundColor: colors.surfaceSecondary,
    borderRadius: borderRadius.md,
    padding: spacing.md,
  },
  introText: {
    flex: 1,
    fontSize: fontSize.sm,
    lineHeight: 18,
    color: colors.text.secondary,
  },
  label: {
    fontSize: fontSize.base,
    fontWeight: fontWeight.semibold,
    color: colors.text.primary,
  },
  required: {
    color: colors.error,
  },
  textarea: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border.default,
    borderRadius: borderRadius.md,
    padding: spacing.md,
    minHeight: 140,
    fontSize: fontSize.base,
    lineHeight: 22,
    color: colors.text.primary,
  },
  hint: {
    fontSize: fontSize.xs,
    color: colors.text.tertiary,
    textAlign: 'right',
  },
  chipGroup: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
  chip: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: 999,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border.default,
  },
  chipActive: {
    backgroundColor: colors.primaryLight,
    borderColor: colors.primaryBorder,
  },
  chipText: {
    fontSize: fontSize.sm,
    color: colors.text.secondary,
  },
  chipTextActive: {
    color: colors.primary,
    fontWeight: fontWeight.semibold,
  },
  severityList: {
    gap: spacing.sm,
  },
  severityRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border.default,
    borderRadius: borderRadius.md,
    padding: spacing.md,
    gap: spacing.md,
  },
  severityRowActive: {
    borderColor: colors.primaryBorder,
    backgroundColor: colors.primaryLight,
  },
  severityText: { flex: 1, gap: 2 },
  severityTitle: {
    fontSize: fontSize.base,
    fontWeight: fontWeight.semibold,
    color: colors.text.primary,
  },
  severityTitleActive: { color: colors.primary },
  severityDesc: {
    fontSize: fontSize.sm,
    color: colors.text.secondary,
  },
  radio: {
    width: 18,
    height: 18,
    borderRadius: 9,
    borderWidth: 2,
    borderColor: colors.border.dark,
  },
  radioActive: {
    borderColor: colors.primary,
    backgroundColor: colors.primary,
  },
  submitBar: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    backgroundColor: colors.background,
    borderTopWidth: 1,
    borderTopColor: colors.border.light,
  },
  submitBtn: {
    backgroundColor: colors.primary,
    borderRadius: borderRadius.md,
    paddingVertical: spacing.md,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 48,
  },
  submitBtnDisabled: {
    backgroundColor: colors.border.default,
  },
  submitBtnText: {
    fontSize: fontSize.base,
    fontWeight: fontWeight.semibold,
    color: colors.text.inverse,
  },
});
