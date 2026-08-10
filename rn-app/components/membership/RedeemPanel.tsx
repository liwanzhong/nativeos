/**
 * Tab 2: 兑换码输入
 *
 * 直接 port /redeem 页面的表单逻辑 (validate → redeemProCode → refresh profile)
 * 成功兑换后, 调 onSuccess 关闭 Bottom Sheet 并把新状态带回去
 *
 * 跟 /redeem 的差别:
 *   - 没有自己的 header (header 在 UpgradeSheet 里)
 *   - 没有"关闭"按钮 (用 sheet 的 X)
 *   - 没有 useEffect 重定向到 /login — 由外层 UpgradeSheet 决策:
 *     父级没登录, 不应打开 sheet (membership.tsx 控制)
 *   - 没登录时显示行内错误, 不跳转
 */

import React, { useState } from 'react';
import {
  ActivityIndicator,
  Keyboard,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { redeemProCode } from '../../lib/quota';
import { useAuth } from '../../lib/auth';
import { supabase } from '../../lib/supabase';
import {
  borderRadius,
  colors,
  fontSize,
  fontWeight,
  spacing,
} from '../../constants/theme';

type StatusKind = 'idle' | 'error' | 'success';

export function RedeemPanel({ onSuccess }: { onSuccess: () => void }) {
  const { user, refreshProfile, pullProfileToLocal } = useAuth();
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [statusKind, setStatusKind] = useState<StatusKind>('idle');

  const onSubmit = async () => {
    if (busy) return;
    const trimmed = code.trim();
    if (!trimmed) {
      setStatusKind('error');
      setStatusMsg('请输入兑换码');
      return;
    }
    if (!user) {
      setStatusKind('error');
      setStatusMsg('请先登录后再兑换');
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
        // refreshProfile 只更新 React state, 本地 SQLite cache (user_profile
        // 表) 还得自己 sync. 跟 /redeem 一样, 直接读 supabase 拿全行.
        try {
          if (supabase) {
            const { data } = await supabase
              .from('profiles')
              .select('*')
              .maybeSingle();
            if (data) {
              await pullProfileToLocal(data as any);
            }
          }
        } catch {
          /* ignore — UI 已经展示成功了, 同步失败下次启动会自愈 */
        }
        setTimeout(onSuccess, 1200);
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

  return (
    <View style={styles.container}>
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
          placeholderTextColor={colors.text.tertiary}
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
        兑换码由 NativeOS 作者发放，购买后请在微信聊天记录中查看
      </Text>
    </View>
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

const styles = StyleSheet.create({
  container: {
    paddingTop: spacing.xs,
  },
  lead: {
    fontSize: fontSize.lg,
    fontWeight: fontWeight.semibold,
    color: colors.text.primary,
    marginBottom: 6,
  },
  leadHint: {
    fontSize: fontSize.sm,
    color: colors.text.secondary,
    lineHeight: 20,
    marginBottom: spacing.md,
  },
  inputWrap: {
    borderWidth: 1,
    borderColor: colors.border.default,
    borderRadius: borderRadius.md,
    backgroundColor: colors.surfaceSecondary,
    paddingHorizontal: spacing.md - 2,
    paddingVertical: 4,
  },
  input: {
    fontSize: fontSize.base,
    color: colors.text.primary,
    paddingVertical: 12,
    letterSpacing: 1,
  },
  statusText: {
    marginTop: 10,
    fontSize: fontSize.sm,
    color: colors.text.secondary,
    minHeight: 18,
  },
  statusError: { color: colors.error },
  statusSuccess: { color: colors.success },
  submitBtn: {
    marginTop: spacing.md + 4,
    backgroundColor: '#1A1A1A',
    paddingVertical: 14,
    borderRadius: borderRadius.md,
    alignItems: 'center',
  },
  submitBtnPressed: { backgroundColor: '#000000' },
  submitBtnDisabled: { opacity: 0.6 },
  submitBtnText: {
    color: '#FFFFFF',
    fontSize: fontSize.base,
    fontWeight: fontWeight.medium,
  },
  footnote: {
    marginTop: spacing.md,
    fontSize: fontSize.xs,
    color: colors.text.tertiary,
    lineHeight: 18,
  },
});
