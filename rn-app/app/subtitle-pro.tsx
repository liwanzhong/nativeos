/**
 * /subtitle-pro — Pro gate page shown when a Free user tries to
 * generate video subtitles.
 *
 * Design philosophy: this is a marketing page, not an error page. Free
 * users see a Pro-only lock + value props + clear upgrade path. The
 * page mirrors `app/byok.tsx`'s gate so any other Pro-only feature can
 * reuse the same layout later (extracted into a `ProGateScreen`
 * component when we have 3+ gates).
 *
 * Flow:
 *   1. Free user taps "生成字幕" on a video card
 *   2. `requestUserVideoSubtitleGeneration` throws `SubtitleProRequiredError`
 *   3. UI catches it and routes here via `router.push('/subtitle-pro')`
 *   4. User redeems a Pro code on /redeem → comes back, the gate
 *      disappears and the action they were trying becomes available.
 */

import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useRouter } from 'expo-router';
import { Crown, Lock, Sparkles, ChevronRight, X } from 'lucide-react-native';
import { getProState, type ProState } from '../lib/quota';
import { colors } from '../constants/theme';

export default function SubtitleProScreen() {
  const router = useRouter();
  const [proState, setProState] = useState<ProState | null>(null);
  const reloadPro = useCallback(async () => {
    try {
      setProState(await getProState());
    } catch {
      setProState(null);
    }
  }, []);
  useEffect(() => {
    void reloadPro();
  }, [reloadPro]);

  // proState === null means we're still checking; don't flash the
  // gate to a Pro user who navigated here transiently (e.g. from
  // a deep link while loading).
  const isPro =
    proState !== null &&
    proState.tier === 'pro' &&
    (!proState.expiresAt || new Date(proState.expiresAt).getTime() > Date.now());

  if (proState === null) {
    return (
      <View style={styles.container}>
        <ActivityIndicator style={{ marginTop: 80 }} />
      </View>
    );
  }

  // Pro user landed here for some reason — close instead of flashing
  // the gate. This handles the case where they upgraded in another
  // tab and came back.
  if (isPro) {
    return (
      <View style={styles.container}>
        <View style={styles.header}>
          <View style={styles.headerSide} />
          <Text style={styles.headerTitle}>视频字幕</Text>
          <Pressable style={styles.headerSide} hitSlop={10} onPress={() => router.back()}>
            <X size={20} color="#5A5A5A" />
          </Pressable>
        </View>
        <View style={styles.gateContainer}>
          <Text style={styles.alreadyProTitle}>你已经是 Pro 会员</Text>
          <Text style={styles.alreadyProDesc}>字幕生成已解锁,返回视频页继续即可。</Text>
          <Pressable style={styles.secondary} onPress={() => router.back()}>
            <Text style={styles.secondaryText}>返回</Text>
          </Pressable>
        </View>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <View style={styles.headerSide} />
        <Text style={styles.headerTitle}>视频字幕</Text>
        <Pressable style={styles.headerSide} hitSlop={10} onPress={() => router.back()}>
          <X size={20} color="#5A5A5A" />
        </Pressable>
      </View>

      <View style={styles.gateContainer}>
        <View style={styles.gateIconWrap}>
          <Lock size={28} color="#F59E0B" strokeWidth={2.2} />
        </View>

        <View style={styles.gateCrownRow}>
          <Crown size={14} color="#F59E0B" />
          <Text style={styles.gateCrownLabel}>Pro 专属功能</Text>
        </View>

        <Text style={styles.gateTitle}>视频字幕生成</Text>
        <Text style={styles.gateDesc}>
          为本地视频和网盘导入视频自动生成英中双语字幕,{'\n'}
          按视频时长计费,字幕与视频画面逐句对齐。
        </Text>

        {/* Value props — short, only what matters for the decision */}
        <View style={styles.gateProps}>
          <View style={styles.gatePropRow}>
            <Sparkles size={14} color="#60A5FA" />
            <Text style={styles.gatePropText}>导入视频即可一键生成英中字幕</Text>
          </View>
          <View style={styles.gatePropRow}>
            <Sparkles size={14} color="#60A5FA" />
            <Text style={styles.gatePropText}>按分钟计费,字幕与画面逐句同步</Text>
          </View>
          <View style={styles.gatePropRow}>
            <Sparkles size={14} color="#60A5FA" />
            <Text style={styles.gatePropText}>网盘视频同样支持,下载一次永久离线</Text>
          </View>
        </View>

        {/* Primary CTA — single, can't miss */}
        <Pressable
          style={styles.gateCta}
          onPress={() => router.push('/redeem')}
        >
          <Crown size={16} color="#fff" />
          <Text style={styles.gateCtaText}>兑换 / 升级 Pro</Text>
        </Pressable>
        {/* Secondary — neutral, more info, no pressure */}
        <Pressable
          style={styles.gateSecondary}
          onPress={() => router.push('/membership')}
        >
          <Text style={styles.gateSecondaryText}>了解 Pro 会员权益</Text>
          <ChevronRight size={14} color="rgba(255,255,255,0.45)" />
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
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingTop: 16,
    paddingBottom: 12,
  },
  headerSide: { minWidth: 40, alignItems: 'flex-end' },
  headerTitle: { fontSize: 15, fontWeight: '500', color: '#1A1A1A' },
  gateContainer: {
    flex: 1,
    paddingHorizontal: 28,
    paddingTop: 40,
    alignItems: 'center',
  },
  gateIconWrap: {
    width: 72,
    height: 72,
    borderRadius: 36,
    backgroundColor: 'rgba(245,158,11,0.12)',
    borderWidth: 1,
    borderColor: 'rgba(245,158,11,0.25)',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 20,
  },
  gateCrownRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: 'rgba(245,158,11,0.12)',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: 'rgba(245,158,11,0.2)',
    marginBottom: 20,
  },
  gateCrownLabel: {
    fontSize: 11,
    fontWeight: '700' as const,
    color: '#F59E0B',
    letterSpacing: 1,
  },
  gateTitle: {
    fontSize: 22,
    fontWeight: '800' as const,
    color: '#F1F5F9',
    textAlign: 'center',
    marginBottom: 12,
  },
  gateDesc: {
    fontSize: 14,
    color: 'rgba(255,255,255,0.6)',
    textAlign: 'center',
    lineHeight: 22,
    marginBottom: 32,
  },
  gateProps: {
    alignSelf: 'stretch',
    backgroundColor: 'rgba(255,255,255,0.04)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.06)',
    borderRadius: 16,
    paddingVertical: 4,
    paddingHorizontal: 16,
    marginBottom: 32,
  },
  gatePropRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 12,
  },
  gatePropText: {
    fontSize: 13,
    color: 'rgba(255,255,255,0.75)',
    flex: 1,
  },
  gateCta: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: '#F59E0B',
    paddingVertical: 14,
    paddingHorizontal: 24,
    borderRadius: 14,
    alignSelf: 'stretch',
    shadowColor: '#F59E0B',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 12,
    elevation: 4,
  },
  gateCtaText: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '700' as const,
  },
  gateSecondary: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    paddingVertical: 14,
    marginTop: 4,
  },
  gateSecondaryText: {
    color: 'rgba(255,255,255,0.45)',
    fontSize: 13,
    fontWeight: '600' as const,
  },
  // "Already Pro" state
  alreadyProTitle: {
    fontSize: 18,
    fontWeight: '700' as const,
    color: '#1F7A3A',
    marginBottom: 8,
  },
  alreadyProDesc: {
    fontSize: 14,
    color: '#5A5A5A',
    textAlign: 'center',
    marginBottom: 24,
  },
  secondary: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 12,
    paddingHorizontal: 28,
    borderRadius: 12,
    backgroundColor: 'rgba(0,0,0,0.04)',
  },
  secondaryText: {
    fontSize: 14,
    fontWeight: '600' as const,
    color: '#1A1A1A',
  },
});
