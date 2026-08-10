/**
 * Login screen — email + 6-digit OTP.
 *
 * No separate "register" entry. Supabase's signInWithOtp auto-creates the
 * auth.users row for unseen emails, so this single screen covers both
 * "first-time" and "returning" users.
 *
 * Two-step UI:
 *   step=email → enter email → tap "获取验证码" → signInWithOtp → step=code
 *   step=code  → enter 6-digit code → tap "登录" → verifyOtp → router.back()
 *
 * "登录即注册": if the email is unseen, Supabase creates the user on the
 * first signInWithOtp call. The DB trigger `on_auth_user_created` then
 * auto-creates a matching `public.profiles` row.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator, Alert, Pressable, StyleSheet, Text, TextInput, View,
} from 'react-native';
import { useRouter } from 'expo-router';
import { ChevronLeft, Mail, ShieldCheck } from 'lucide-react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { borderRadius, colors, fontSize, fontWeight, spacing } from '../constants/theme';
import { supabase } from '../lib/supabase';
import { useAuth } from '../lib/auth';

type Step = 'email' | 'code';

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default function LoginScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { isAuthAvailable, refreshProfile } = useAuth();
  const [step, setStep] = useState<Step>('email');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState(['', '', '', '', '', '']);
  const [sending, setSending] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [resendCooldown, setResendCooldown] = useState(0);
  const codeInputRefs = useRef<Array<TextInput | null>>([]);

  // Resend cooldown ticker
  useEffect(() => {
    if (resendCooldown <= 0) return;
    const t = setInterval(() => {
      setResendCooldown((s) => (s > 0 ? s - 1 : 0));
    }, 1000);
    return () => clearInterval(t);
  }, [resendCooldown]);

  const handleSendCode = useCallback(async () => {
    if (!isAuthAvailable) {
      Alert.alert('登录未配置', 'Supabase URL 或 anon key 未设置，无法登录。');
      return;
    }
    const trimmed = email.trim().toLowerCase();
    if (!EMAIL_REGEX.test(trimmed)) {
      Alert.alert('邮箱格式不对', '请输入有效的邮箱地址。');
      return;
    }
    setSending(true);
    try {
      const { error } = await supabase.auth.signInWithOtp({
        email: trimmed,
        options: {
          // 6-digit OTP (default), no magic-link redirect
          shouldCreateUser: true,
        },
      });
      if (error) throw error;
      setStep('code');
      setResendCooldown(60);
    } catch (e) {
      const msg = e instanceof Error ? e.message : '验证码发送失败';
      Alert.alert('发送失败', msg);
    } finally {
      setSending(false);
    }
  }, [email, isAuthAvailable]);

  const handleCodeChange = useCallback((index: number, value: string) => {
    const digit = value.replace(/\D/g, '').slice(-1);
    setCode((prev) => {
      const next = [...prev];
      next[index] = digit;
      return next;
    });
    if (digit && index < 5) {
      codeInputRefs.current[index + 1]?.focus();
    }
  }, []);

  const handleCodeKeyPress = useCallback((index: number, key: string) => {
    if (key === 'Backspace' && index > 0 && !code[index]) {
      codeInputRefs.current[index - 1]?.focus();
    }
  }, [code]);

  const handleVerify = useCallback(async () => {
    const fullCode = code.join('');
    if (fullCode.length !== 6) {
      Alert.alert('验证码不完整', '请输入 6 位数字。');
      return;
    }
    setVerifying(true);
    try {
      const { error } = await supabase.auth.verifyOtp({
        email: email.trim().toLowerCase(),
        token: fullCode,
        type: 'email',
      });
      if (error) throw error;
      // Pull the profile after the session is established
      await refreshProfile();
      router.back();
    } catch (e) {
      const msg = e instanceof Error ? e.message : '验证码错误';
      Alert.alert('登录失败', msg);
    } finally {
      setVerifying(false);
    }
  }, [code, email, refreshProfile, router]);

  return (
    <View style={styles.container}>
      {/* Top bar — mirrors cloud-drives.tsx / official-video-transfer.tsx */}
      <View style={[styles.header, { paddingTop: insets.top + 6 }]}>
        <Pressable style={styles.backBtn} onPress={() => router.back()}>
          <ChevronLeft size={20} color={colors.text.primary} />
        </Pressable>
        <Text style={styles.headerTitle} numberOfLines={1}>登录 / 注册</Text>
        <View style={styles.headerSpacer} />
      </View>

      <View style={styles.content}>
        <View style={styles.heroBlock}>
          {step === 'email' ? (
            <Mail size={48} color={colors.primary} />
          ) : (
            <ShieldCheck size={48} color={colors.primary} />
          )}
          <Text style={styles.heroTitle}>
            {step === 'email' ? '登录或注册' : '输入验证码'}
          </Text>
          <Text style={styles.heroSubtitle}>
            {step === 'email'
              ? '用邮箱登录 NativeOS。没有账号？输入邮箱即可自动注册。'
              : `验证码已发送到 ${email}，请在邮件中查看 6 位数字。`}
          </Text>
        </View>

        {step === 'email' ? (
          <View style={styles.formBlock}>
            <Text style={styles.label}>邮箱</Text>
            <TextInput
              style={styles.emailInput}
              value={email}
              onChangeText={setEmail}
              placeholder="you@example.com"
              placeholderTextColor={colors.text.tertiary}
              keyboardType="email-address"
              autoCapitalize="none"
              autoCorrect={false}
              editable={!sending}
              returnKeyType="go"
              onSubmitEditing={handleSendCode}
            />
            <Pressable
              style={[styles.primaryBtn, sending && styles.primaryBtnDisabled]}
              onPress={handleSendCode}
              disabled={sending}
            >
              {sending ? (
                <ActivityIndicator color="#fff" />
              ) : (
                <Text style={styles.primaryBtnText}>获取验证码</Text>
              )}
            </Pressable>
          </View>
        ) : (
          <View style={styles.formBlock}>
            <Text style={styles.label}>验证码</Text>
            <View style={styles.codeRow}>
              {code.map((digit, i) => (
                <TextInput
                  key={i}
                  ref={(el) => { codeInputRefs.current[i] = el; }}
                  style={styles.codeInput}
                  value={digit}
                  onChangeText={(v) => handleCodeChange(i, v)}
                  onKeyPress={(e) => handleCodeKeyPress(i, e.nativeEvent.key)}
                  keyboardType="number-pad"
                  maxLength={1}
                  selectTextOnFocus
                />
              ))}
            </View>
            <Pressable
              style={[styles.primaryBtn, verifying && styles.primaryBtnDisabled]}
              onPress={handleVerify}
              disabled={verifying}
            >
              {verifying ? (
                <ActivityIndicator color="#fff" />
              ) : (
                <Text style={styles.primaryBtnText}>登录</Text>
              )}
            </Pressable>
            <View style={styles.codeFooter}>
              <Pressable
                onPress={() => setStep('email')}
                hitSlop={6}
              >
                <Text style={styles.linkText}>换个邮箱</Text>
              </Pressable>
              <Pressable
                onPress={resendCooldown === 0 ? handleSendCode : undefined}
                hitSlop={6}
                disabled={resendCooldown > 0}
              >
                <Text style={[styles.linkText, resendCooldown > 0 && styles.linkTextDisabled]}>
                  {resendCooldown > 0 ? `${resendCooldown}s 后重发` : '重新发送'}
                </Text>
              </Pressable>
            </View>
          </View>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.md,
    gap: spacing.sm,
  },
  backBtn: {
    width: 36, height: 36, borderRadius: borderRadius.full,
    backgroundColor: colors.surface,
    alignItems: 'center', justifyContent: 'center',
    borderWidth: 1, borderColor: colors.border.light,
  },
  headerTitle: {
    flex: 1,
    color: colors.text.primary,
    fontSize: fontSize.lg,
    fontWeight: fontWeight.bold,
  },
  headerSpacer: { width: 36, height: 36 },

  content: {
    flex: 1,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.xl,
  },

  heroBlock: {
    alignItems: 'center',
    gap: spacing.sm,
    marginBottom: spacing.xl,
  },
  heroTitle: {
    fontSize: fontSize.xl,
    fontWeight: fontWeight.bold,
    color: colors.text.primary,
    marginTop: spacing.sm,
  },
  heroSubtitle: {
    fontSize: fontSize.sm,
    color: colors.text.secondary,
    textAlign: 'center',
    lineHeight: 20,
    paddingHorizontal: spacing.md,
  },

  formBlock: {
    gap: spacing.md,
  },
  label: {
    fontSize: fontSize.sm,
    color: colors.text.secondary,
    fontWeight: fontWeight.medium,
  },
  emailInput: {
    backgroundColor: colors.surface,
    borderRadius: borderRadius.lg,
    borderWidth: 1,
    borderColor: colors.border.light,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    fontSize: fontSize.base,
    color: colors.text.primary,
  },
  primaryBtn: {
    backgroundColor: colors.text.primary,
    paddingVertical: 14,
    borderRadius: borderRadius.lg,
    alignItems: 'center',
    marginTop: spacing.sm,
  },
  primaryBtnDisabled: { opacity: 0.6 },
  primaryBtnText: {
    color: '#fff',
    fontSize: fontSize.base,
    fontWeight: fontWeight.bold,
  },

  codeRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: spacing.sm,
  },
  codeInput: {
    flex: 1,
    aspectRatio: 1,
    maxWidth: 56,
    backgroundColor: colors.surface,
    borderRadius: borderRadius.lg,
    borderWidth: 1,
    borderColor: colors.border.light,
    textAlign: 'center',
    fontSize: fontSize.xl,
    fontWeight: fontWeight.bold,
    color: colors.text.primary,
  },
  codeFooter: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.xs,
  },
  linkText: {
    color: colors.primary,
    fontSize: fontSize.sm,
    fontWeight: fontWeight.medium,
  },
  linkTextDisabled: {
    color: colors.text.tertiary,
  },
});
