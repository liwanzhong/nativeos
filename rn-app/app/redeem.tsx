/**
 * /redeem — Pro code redemption page.
 *
 * Minimal layout: a single text input, a primary "兑换" button, and a
 * status line. No pricing list, no plans grid — payment integration is
 * explicitly deferred per the user's spec.
 *
 * On success: refreshes Pro state via the quota engine and pops back.
 */

import React, { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useRouter } from 'expo-router';
import { redeemProCode } from '../lib/quota';
import { useAuth } from '../lib/auth';
import { supabase } from '../lib/supabase';

export default function RedeemScreen() {
  const router = useRouter();
  const { user, refreshProfile, pullProfileToLocal } = useAuth();
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [statusKind, setStatusKind] = useState<'idle' | 'error' | 'success'>('idle');

  useEffect(() => {
    if (!user) {
      // Force the user to sign in first; this keeps redeem a pure
      // post-login flow so the RLS `used_by = auth.uid()` check has
      // a real uid to verify against.
      router.replace('/login');
    }
  }, [user, router]);

  const onSubmit = async () => {
    if (busy) return;
    const trimmed = code.trim();
    if (!trimmed) {
      setStatusKind('error');
      setStatusMsg('请输入兑换码');
      return;
    }
    Keyboard.dismiss();
    setBusy(true);
    setStatusKind('idle');
    setStatusMsg(null);
    try {
      const result = await redeemProCode(trimmed);
      if (result.ok) {
        setStatusKind('success');
        const days = result.durationDays ?? 30;
        setStatusMsg(`兑换成功！Pro 会员 ${days} 天已激活`);
        // Pull updated cloud profile so other parts of the app see isPro.
        await refreshProfile();
        // We also need to refresh profile's quota_config / is_pro; refreshProfile
        // already fetches the row, so the local cache is up to date next time
        // the auth effect runs.
        try { await pullProfileToLocal((await getCloudProfile()) as any); } catch { /* ignore */ }
        setTimeout(() => router.back(), 1200);
      } else {
        setStatusKind('error');
        setStatusMsg(redeemErrorMessage(result.reason));
      }
    } catch (err) {
      setStatusKind('error');
      setStatusMsg('兑换失败，请稍后再试');
    } finally {
      setBusy(false);
    }
  };

  if (!user) {
    // Will redirect via useEffect; render nothing in the meantime.
    return <View style={styles.container} />;
  }

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <View style={styles.header}>
        <Pressable hitSlop={10} onPress={() => router.back()} style={styles.closeBtn}>
          <Text style={styles.closeBtnText}>关闭</Text>
        </Pressable>
        <Text style={styles.headerTitle}>兑换 Pro</Text>
        <View style={styles.closeBtn} />
      </View>

      <View style={styles.body}>
        <Text style={styles.lead}>输入 Pro 兑换码</Text>
        <Text style={styles.leadHint}>
          Pro 会员可获得更大的 AI 对话、语音识别、语音朗读额度。
        </Text>

        <View style={styles.inputWrap}>
          <TextInput
            value={code}
            onChangeText={(t) => {
              setCode(t.toUpperCase());
              setStatusKind('idle');
              setStatusMsg(null);
            }}
            placeholder="例如：NATIVEOS-XXXX-XXXX"
            placeholderTextColor="#9A9A9A"
            style={styles.input}
            autoCapitalize="characters"
            autoCorrect={false}
            autoComplete="off"
            spellCheck={false}
            editable={!busy}
            returnKeyType="done"
            onSubmitEditing={onSubmit}
          />
        </View>

        {statusMsg && (
          <Text
            style={[
              styles.statusText,
              statusKind === 'error' && styles.statusError,
              statusKind === 'success' && styles.statusSuccess,
            ]}
          >
            {statusMsg}
          </Text>
        )}

        <Pressable
          style={({ pressed }) => [
            styles.submitBtn,
            pressed && styles.submitBtnPressed,
            busy && styles.submitBtnDisabled,
          ]}
          onPress={onSubmit}
          disabled={busy}
        >
          {busy ? (
            <ActivityIndicator color="#FFFFFF" />
          ) : (
            <Text style={styles.submitBtnText}>兑换</Text>
          )}
        </Pressable>

        <Text style={styles.footnote}>
          兑换码由 NativeOS 团队发放，请在购买后查看邮件或聊天记录。
        </Text>
      </View>
    </KeyboardAvoidingView>
  );
}

function redeemErrorMessage(reason?: string): string {
  switch (reason) {
    case 'invalid':
      return '兑换码无效，请检查后重试';
    case 'expired':
      return '兑换码已过期';
    case 'used':
      return '兑换码已被使用过';
    case 'not_signed_in':
      return '请先登录后再兑换';
    default:
      return '兑换失败，请稍后再试';
  }
}

async function getCloudProfile() {
  if (!supabase) return null;
  const { data } = await supabase.from('profiles').select('*').maybeSingle();
  return data;
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#FFFFFF',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingTop: 16,
    paddingBottom: 12,
  },
  closeBtn: {
    minWidth: 48,
    alignItems: 'flex-start',
  },
  closeBtnText: {
    fontSize: 14,
    color: '#6A6A6A',
  },
  headerTitle: {
    fontSize: 15,
    fontWeight: '500',
    color: '#1A1A1A',
  },
  body: {
    flex: 1,
    paddingHorizontal: 24,
    paddingTop: 12,
  },
  lead: {
    fontSize: 18,
    fontWeight: '600',
    color: '#1A1A1A',
    marginBottom: 6,
  },
  leadHint: {
    fontSize: 13,
    color: '#6A6A6A',
    lineHeight: 20,
    marginBottom: 24,
  },
  inputWrap: {
    borderWidth: 1,
    borderColor: '#E0E0E0',
    borderRadius: 10,
    backgroundColor: '#FAFAFA',
    paddingHorizontal: 14,
    paddingVertical: 4,
  },
  input: {
    fontSize: 15,
    color: '#1A1A1A',
    paddingVertical: 12,
    letterSpacing: 1,
  },
  statusText: {
    marginTop: 10,
    fontSize: 13,
    color: '#6A6A6A',
    minHeight: 18,
  },
  statusError: {
    color: '#C44545',
  },
  statusSuccess: {
    color: '#1F7A3A',
  },
  submitBtn: {
    marginTop: 24,
    backgroundColor: '#1A1A1A',
    paddingVertical: 14,
    borderRadius: 10,
    alignItems: 'center',
  },
  submitBtnPressed: {
    backgroundColor: '#000',
  },
  submitBtnDisabled: {
    opacity: 0.6,
  },
  submitBtnText: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '500',
  },
  footnote: {
    marginTop: 18,
    fontSize: 12,
    color: '#9A9A9A',
    lineHeight: 18,
  },
});
