/**
 * /membership — Pro membership detail page.
 *
 * Three sections, in order:
 *   1. Status card (Pro or Free) with tier + expiry / count summary
 *   2. 今日用量 — AI / ASR / TTS for the current tier
 *   3. 会员权益 (含底部 CTA) — 5 行 Free vs Pro 对照表 + 升级/延期入口
 *      CTA 嵌在卡片底部, 把"看到权益"和"去升级"绑成一个模块
 *
 * Bottom Sheet (在 UpgradeSheet 组件里):
 *   - Tab 1 "联系作者" (默认, Free 用户): QR + 4 步购买指南
 *   - Tab 2 "兑换码" (默认, Pro 用户想延期): 输入表单
 *
 * /redeem 页面保留 — 仍然可作为 deep-link 入口 (例如邮件里的 /redeem?code=XXX)
 *
 * Display rules (per user):
 *   - 每个字段只展示一个数字:
 *       Free → 硬限 (30 / 60 / 150). 软限概念对 Free 没意义, 隐藏
 *       Pro  → 软限 (200 / 500 / 2000). 硬限是静默的"墙", UI 不暴露
 *   - 状态卡的"今日已用 0/X" = 各字段 limit 之和
 *       Free: 30+60+150 = 240
 *       Pro:  200+500+2000 = 2700
 *   - NO pricing / plans grid / "立即升级" hard-sell.
 *   - 升级入口不强制 "立即升级" 语气, 用中性 "升级 Pro 会员" / "继续兑换 / 延期"
 *   - Refreshes the snapshot on focus, so coming back from sheet close
 *     immediately shows the new Pro state without a manual reload.
 */

import React, { useCallback, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { Crown, Sparkles, X } from 'lucide-react-native';
import { FullUsageBars, useUsageSnapshot } from '../components/quota/UsageBar';
import { BenefitComparison } from '../components/membership/BenefitComparison';
import { UpgradeSheet } from '../components/membership/UpgradeSheet';
import { getProState, type ProState } from '../lib/quota';
import { useAuth } from '../lib/auth';
import { colors, spacing, borderRadius, fontSize, fontWeight } from '../constants/theme';

function formatExpiry(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return '';
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function daysUntil(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return null;
  const diffMs = d.getTime() - Date.now();
  return Math.max(0, Math.ceil(diffMs / (24 * 60 * 60 * 1000)));
}

export default function MembershipScreen() {
  const router = useRouter();
  const { user } = useAuth();
  const snap = useUsageSnapshot();
  const [proState, setProState] = React.useState<ProState>({
    tier: 'free',
    expiresAt: null,
    updatedAt: 0,
  });
  const [showUpgrade, setShowUpgrade] = useState(false);

  const reloadProState = useCallback(async () => {
    try {
      const next = await getProState();
      setProState(next);
    } catch {
      // ignore
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      void snap.reload();
      void reloadProState();
    }, [reloadProState, snap.reload]),
  );

  const isPro =
    proState.tier === 'pro' &&
    (!proState.expiresAt || new Date(proState.expiresAt).getTime() > Date.now());
  const remainingDays = daysUntil(proState.expiresAt);
  const tierLimits = snap.config
    ? snap.config[isPro ? 'pro' : 'free']
    : null;
  // Status card: 展示给用户看的额度
  //   - Free: 硬限之和 (30+60+150 = 240). 软限 = 硬限, 没有"超软限继续用"的概念
  //   - Pro:  软限之和 (200+500+2000 = 2700). 实际硬限是软限的 5x, 但 UI 不暴露
  const totalLimit = tierLimits
    ? (isPro
        ? tierLimits.ai_rounds.soft + tierLimits.asr.soft + tierLimits.tts.soft
        : tierLimits.ai_rounds.hard + tierLimits.asr.hard + tierLimits.tts.hard)
    : 0;
  const totalUsed = snap.usage.ai_rounds + snap.usage.asr + snap.usage.tts;

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <View style={styles.headerSide} />
        <Text style={styles.headerTitle}>Pro 会员</Text>
        <Pressable
          style={styles.headerSide}
          hitSlop={10}
          onPress={() => router.back()}
        >
          <X size={20} color="#5A5A5A" />
        </Pressable>
      </View>

      <ScrollView
        contentContainerStyle={styles.scroll}
        showsVerticalScrollIndicator={false}
      >
        {/* ── Status card ── */}
        {isPro ? (
          <View style={[styles.statusCard, styles.statusCardPro]}>
            <View style={styles.statusHeader}>
              <View style={styles.proBadge}>
                <Crown size={16} color="#B45309" />
                <Text style={styles.proBadgeText}>PRO</Text>
              </View>
              <Text style={styles.proHeading}>Pro 会员</Text>
            </View>
            <Text style={styles.proSubline}>
              {proState.expiresAt
                ? `${formatExpiry(proState.expiresAt)} 到期`
                : '已激活'}
            </Text>
            {remainingDays != null && remainingDays <= 30 && remainingDays > 0 && (
              <Text style={styles.proWarn}>还剩 {remainingDays} 天</Text>
            )}
          </View>
        ) : (
          <View style={[styles.statusCard, styles.statusCardFree]}>
            <View style={styles.statusHeader}>
              <View style={styles.freeBadge}>
                <Sparkles size={16} color="#5A5A5A" />
                <Text style={styles.freeBadgeText}>FREE</Text>
              </View>
              <Text style={styles.freeHeading}>免费用户</Text>
            </View>
            <Text style={styles.freeSubline}>
              {tierLimits
                ? `今日已用 ${totalUsed} / ${totalLimit} 次`
                : '加载中…'}
            </Text>
          </View>
        )}

        {/* ── Usage ── */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>今日用量</Text>
          <FullUsageBars />
        </View>

        {/* ── Benefits comparison + 升级入口 (CTA 嵌在卡片底部) ── */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>会员权益</Text>
          <BenefitComparison
            onUpgradePress={() => {
              if (!user) {
                // 未登录: 走 login, login 完回到 /membership (expo-router 默认行为)
                router.push('/login');
                return;
              }
              setShowUpgrade(true);
            }}
            ctaLabel={isPro ? '继续兑换 / 延期' : '升级 Pro 会员'}
            ctaDesc={
              isPro
                ? '已激活 Pro 仍可叠加新的兑换码延期'
                : '扫码联系作者，或直接输入兑换码激活'
            }
          />
        </View>
      </ScrollView>

      <UpgradeSheet
        visible={showUpgrade}
        onClose={() => setShowUpgrade(false)}
        // Pro 用户多半是想"延期", 默认打开兑换码; Free 用户想"购买", 默认看到 QR
        defaultTab={isPro ? 'redeem' : 'contact'}
      />
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
    paddingHorizontal: 16,
    paddingTop: 16,
    paddingBottom: 12,
  },
  headerSide: {
    minWidth: 40,
    alignItems: 'flex-end',
  },
  headerTitle: {
    fontSize: 15,
    fontWeight: '500',
    color: '#1A1A1A',
  },
  scroll: {
    paddingHorizontal: 16,
    paddingBottom: 32,
    gap: 24,
  },
  statusCard: {
    borderRadius: 16,
    padding: 18,
    borderWidth: 1,
  },
  statusCardPro: {
    backgroundColor: '#FFFBEB',
    borderColor: '#FCD34D',
  },
  statusCardFree: {
    backgroundColor: '#F7F7F7',
    borderColor: '#E5E5E5',
  },
  statusHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginBottom: 6,
  },
  proBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: '#FEF3C7',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: '#FCD34D',
  },
  proBadgeText: {
    fontSize: 11,
    fontWeight: '700',
    color: '#B45309',
    letterSpacing: 0.5,
  },
  proHeading: {
    fontSize: 18,
    fontWeight: '600',
    color: '#1A1A1A',
  },
  proSubline: {
    fontSize: 13,
    color: '#92400E',
    marginTop: 2,
  },
  proWarn: {
    fontSize: 12,
    color: '#B45309',
    marginTop: 6,
  },
  freeBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: '#FFFFFF',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: '#D0D0D0',
  },
  freeBadgeText: {
    fontSize: 11,
    fontWeight: '700',
    color: '#5A5A5A',
    letterSpacing: 0.5,
  },
  freeHeading: {
    fontSize: 18,
    fontWeight: '600',
    color: '#1A1A1A',
  },
  freeSubline: {
    fontSize: 13,
    color: '#5A5A5A',
    marginTop: 2,
  },
  section: {
    gap: 10,
  },
  sectionTitle: {
    fontSize: 13,
    fontWeight: '500',
    color: '#6A6A6A',
  },
});
