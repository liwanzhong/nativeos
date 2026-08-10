/**
 * Inner Monologue Response Screen
 * Allows users to record their English thoughts
 */

import { useState, useEffect } from 'react';
import { View, Text, TextInput, Pressable, StyleSheet, ScrollView, Alert } from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { AlertCircle, CheckCircle, X } from 'lucide-react-native';

const colors = {
  background: '#0A0A0A',
  surface: '#1A1A1A',
  primary: '#3B82F6',
  success: '#10B981',
  warning: '#F59E0B',
  error: '#EF4444',
  text: '#FFFFFF',
  textSecondary: '#9CA3AF',
  border: '#374151',
};

const spacing = { xs: 4, sm: 8, md: 16, lg: 24, xl: 32 };
const fontSize = { sm: 12, base: 14, md: 16, lg: 18, xl: 24 };
const fontWeight = { normal: '400', medium: '500', semibold: '600', bold: '700' };

export default function InnerMonologueScreen() {
  const router = useRouter();
  const params = useLocalSearchParams();
  
  const prompt = params.prompt as string || 'Think in English: What are you doing right now?';
  const expectedLength = parseInt(params.expectedLength as string) || 30;
  
  const [response, setResponse] = useState('');
  const [wordCount, setWordCount] = useState(0);
  const [usedChinese, setUsedChinese] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  useEffect(() => {
    const words = response.trim().split(/\s+/).filter(w => w.length > 0);
    setWordCount(words.length);
    
    // Check for Chinese characters
    const hasChinese = /[\u4e00-\u9fa5]/.test(response);
    if (hasChinese && !usedChinese) {
      setUsedChinese(true);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
    }
  }, [response]);

  const handleSubmit = () => {
    if (wordCount < 10) {
      Alert.alert('Too Short', 'Please write at least 10 words.');
      return;
    }

    if (usedChinese) {
      Alert.alert(
        '⚠️ Chinese Detected',
        'You used Chinese! The goal is to think purely in English. Try again?',
        [
          { text: 'Try Again', style: 'cancel' },
          { text: 'Submit Anyway', onPress: () => submitResponse() },
        ]
      );
    } else {
      submitResponse();
    }
  };

  const submitResponse = () => {
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    setSubmitted(true);
    
    // TODO: Save to database for tracking
    console.log('Inner monologue submitted:', {
      prompt,
      response,
      wordCount,
      usedChinese,
      timestamp: new Date().toISOString(),
    });

    setTimeout(() => {
      router.back();
    }, 2000);
  };

  const getProgressColor = () => {
    const ratio = wordCount / expectedLength;
    if (ratio < 0.5) return colors.error;
    if (ratio < 0.8) return colors.warning;
    return colors.success;
  };

  if (submitted) {
    return (
      <View style={styles.container}>
        <View style={styles.successContainer}>
          <CheckCircle size={64} color={colors.success} />
          <Text style={styles.successTitle}>Great Job!</Text>
          <Text style={styles.successText}>
            You practiced thinking in English.
          </Text>
          {!usedChinese && (
            <Text style={styles.bonusText}>
              🎉 Bonus: No Chinese used!
            </Text>
          )}
        </View>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      {/* Header */}
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} style={styles.closeButton}>
          <X size={24} color={colors.text} />
        </Pressable>
        <Text style={styles.headerTitle}>Inner Monologue</Text>
        <View style={{ width: 40 }} />
      </View>

      <ScrollView style={styles.content} contentContainerStyle={styles.contentContainer}>
        {/* Prompt */}
        <View style={styles.promptBox}>
          <Text style={styles.promptLabel}>💭 Challenge</Text>
          <Text style={styles.promptText}>{prompt}</Text>
        </View>

        {/* Warning if Chinese detected */}
        {usedChinese && (
          <View style={styles.warningBox}>
            <AlertCircle size={18} color={colors.warning} />
            <Text style={styles.warningText}>
              Chinese detected! Try to think purely in English.
            </Text>
          </View>
        )}

        {/* Input */}
        <View style={styles.inputContainer}>
          <Text style={styles.inputLabel}>Your Thoughts (in English)</Text>
          <TextInput
            style={styles.input}
            value={response}
            onChangeText={setResponse}
            placeholder="Start thinking in English..."
            placeholderTextColor={colors.textSecondary}
            multiline
            autoFocus
            textAlignVertical="top"
          />
        </View>

        {/* Word Count */}
        <View style={styles.statsContainer}>
          <View style={styles.statBox}>
            <Text style={[styles.statNumber, { color: getProgressColor() }]}>
              {wordCount}
            </Text>
            <Text style={styles.statLabel}>words</Text>
          </View>
          <View style={styles.statBox}>
            <Text style={styles.statNumber}>{expectedLength}</Text>
            <Text style={styles.statLabel}>target</Text>
          </View>
          <View style={styles.statBox}>
            <Text style={[styles.statNumber, { color: usedChinese ? colors.error : colors.success }]}>
              {usedChinese ? '❌' : '✅'}
            </Text>
            <Text style={styles.statLabel}>no Chinese</Text>
          </View>
        </View>

        {/* Tips */}
        <View style={styles.tipsBox}>
          <Text style={styles.tipsTitle}>💡 Tips</Text>
          <Text style={styles.tipText}>• Don't translate from Chinese</Text>
          <Text style={styles.tipText}>• Think directly in English</Text>
          <Text style={styles.tipText}>• Use simple words if needed</Text>
          <Text style={styles.tipText}>• It's okay to make mistakes!</Text>
        </View>
      </ScrollView>

      {/* Submit Button */}
      <View style={styles.footer}>
        <Pressable
          style={[styles.submitButton, wordCount < 10 && styles.submitButtonDisabled]}
          onPress={handleSubmit}
          disabled={wordCount < 10}
        >
          <Text style={styles.submitButtonText}>
            {wordCount < 10 ? `Write ${10 - wordCount} more words` : 'Submit'}
          </Text>
        </Pressable>
      </View>
    </View>
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
    paddingTop: spacing.xl + 20,
    paddingBottom: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  closeButton: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerTitle: {
    fontSize: fontSize.lg,
    fontWeight: fontWeight.semibold,
    color: colors.text,
  },
  content: {
    flex: 1,
  },
  contentContainer: {
    padding: spacing.lg,
  },
  promptBox: {
    backgroundColor: colors.surface,
    padding: spacing.lg,
    borderRadius: 12,
    marginBottom: spacing.lg,
    borderLeftWidth: 4,
    borderLeftColor: colors.primary,
  },
  promptLabel: {
    fontSize: fontSize.sm,
    color: colors.textSecondary,
    marginBottom: spacing.sm,
    fontWeight: fontWeight.medium,
  },
  promptText: {
    fontSize: fontSize.md,
    color: colors.text,
    lineHeight: 24,
  },
  warningBox: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.warning + '20',
    padding: spacing.md,
    borderRadius: 8,
    marginBottom: spacing.lg,
    gap: spacing.sm,
  },
  warningText: {
    flex: 1,
    fontSize: fontSize.sm,
    color: colors.warning,
    fontWeight: fontWeight.medium,
  },
  inputContainer: {
    marginBottom: spacing.lg,
  },
  inputLabel: {
    fontSize: fontSize.sm,
    color: colors.textSecondary,
    marginBottom: spacing.sm,
    fontWeight: fontWeight.medium,
  },
  input: {
    backgroundColor: colors.surface,
    borderRadius: 12,
    padding: spacing.md,
    fontSize: fontSize.base,
    color: colors.text,
    minHeight: 200,
    borderWidth: 1,
    borderColor: colors.border,
  },
  statsContainer: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    marginBottom: spacing.lg,
    backgroundColor: colors.surface,
    padding: spacing.md,
    borderRadius: 12,
  },
  statBox: {
    alignItems: 'center',
  },
  statNumber: {
    fontSize: fontSize.xl,
    fontWeight: fontWeight.bold,
    color: colors.text,
  },
  statLabel: {
    fontSize: fontSize.sm,
    color: colors.textSecondary,
    marginTop: spacing.xs,
  },
  tipsBox: {
    backgroundColor: colors.surface,
    padding: spacing.md,
    borderRadius: 12,
    marginBottom: spacing.xl,
  },
  tipsTitle: {
    fontSize: fontSize.base,
    fontWeight: fontWeight.semibold,
    color: colors.text,
    marginBottom: spacing.sm,
  },
  tipText: {
    fontSize: fontSize.sm,
    color: colors.textSecondary,
    marginBottom: spacing.xs,
    lineHeight: 20,
  },
  footer: {
    padding: spacing.lg,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  submitButton: {
    backgroundColor: colors.primary,
    paddingVertical: spacing.md,
    borderRadius: 12,
    alignItems: 'center',
  },
  submitButtonDisabled: {
    backgroundColor: colors.border,
  },
  submitButtonText: {
    fontSize: fontSize.md,
    fontWeight: fontWeight.semibold,
    color: colors.text,
  },
  successContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.xl,
  },
  successTitle: {
    fontSize: fontSize.xl,
    fontWeight: fontWeight.bold,
    color: colors.text,
    marginTop: spacing.lg,
    marginBottom: spacing.sm,
  },
  successText: {
    fontSize: fontSize.md,
    color: colors.textSecondary,
    textAlign: 'center',
  },
  bonusText: {
    fontSize: fontSize.md,
    color: colors.success,
    marginTop: spacing.md,
    fontWeight: fontWeight.semibold,
  },
});
