import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Alert, Linking, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { ChevronLeft, Copy, ExternalLink, RefreshCw } from 'lucide-react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { borderRadius, colors, fontSize, fontWeight, spacing } from '../constants/theme';
import {
  buildOfficialVideoTransferCopyText,
  fetchOfficialVideoTransferConfig,
  type OfficialVideoTransferConfig,
  type OfficialVideoTransferProviderInfo,
} from '../lib/content/official-video-transfer';

async function copyText(value: string) {
  try {
    const Clipboard = await import('expo-clipboard');
    await Clipboard.setStringAsync(value);
  } catch (error) {
    if (Platform.OS === 'web' && typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return;
    }
    throw error;
  }
}

function getProviderLabel(item: OfficialVideoTransferProviderInfo) {
  return item.label || '百度网盘';
}

export default function OfficialVideoTransferScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [config, setConfig] = useState<OfficialVideoTransferConfig | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyProvider, setBusyProvider] = useState<string | null>(null);

  const loadConfig = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const next = await fetchOfficialVideoTransferConfig();
      setConfig(next);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : '推荐视频转存配置加载失败，请稍后重试');
      setConfig(null);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadConfig();
  }, [loadConfig]);

  const handleCopy = useCallback(async (item: OfficialVideoTransferProviderInfo) => {
    if (busyProvider) {
      return;
    }
    setBusyProvider(`${item.provider}_copy`);
    try {
      await copyText(buildOfficialVideoTransferCopyText(item));
      Alert.alert('已复制', `${getProviderLabel(item)}转存信息已复制，请打开网盘完成转存。`);
    } catch (copyError) {
      Alert.alert('复制失败', copyError instanceof Error ? copyError.message : '请稍后重试');
    } finally {
      setBusyProvider(null);
    }
  }, [busyProvider]);

  const handleOpen = useCallback(async (item: OfficialVideoTransferProviderInfo) => {
    if (busyProvider) {
      return;
    }
    setBusyProvider(`${item.provider}_open`);
    try {
      const supported = await Linking.canOpenURL(item.shareUrl);
      if (!supported) {
        throw new Error('当前设备无法直接打开该链接，请先复制后在对应网盘中打开');
      }
      await Linking.openURL(item.shareUrl);
    } catch (openError) {
      Alert.alert('打开失败', openError instanceof Error ? openError.message : '请稍后重试');
    } finally {
      setBusyProvider(null);
    }
  }, [busyProvider]);

  return (
    <View style={styles.container}>
      <View style={[styles.header, { paddingTop: insets.top + 6 }]}> 
        <Pressable style={styles.backBtn} onPress={() => router.back()}>
          <ChevronLeft size={20} color={colors.text.primary} />
        </Pressable>
        <Text style={styles.headerTitle} numberOfLines={1}>推荐视频转存</Text>
        <Pressable style={styles.refreshBtn} onPress={() => void loadConfig()}>
          <RefreshCw size={18} color={colors.text.secondary} />
        </Pressable>
      </View>

      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={[styles.scrollContent, { paddingBottom: Math.max(insets.bottom + 20, 24) }]}
      >
        {isLoading ? (
          <View style={styles.centerState}>
            <ActivityIndicator size="small" color={colors.primary} />
            <Text style={styles.centerText}>正在加载转存信息…</Text>
          </View>
        ) : error ? (
          <View style={styles.centerState}>
            <Text style={styles.errorText}>{error}</Text>
            <Pressable style={styles.retryBtn} onPress={() => void loadConfig()}>
              <Text style={styles.retryBtnText}>重新加载</Text>
            </Pressable>
          </View>
        ) : (
          <>
            {(config?.providers || []).map((item) => {
              const providerLabel = getProviderLabel(item);
              const isCopying = busyProvider === `${item.provider}_copy`;
              const isOpening = busyProvider === `${item.provider}_open`;
              return (
                <View key={item.provider} style={styles.providerCard}>
                  <View style={styles.providerHeader}>
                    <View style={[styles.providerBadge, styles.providerBadgeBaidu]}>
                      <Text style={[styles.providerBadgeText, styles.providerBadgeTextBaidu]}>{providerLabel}</Text>
                    </View>
                    {item.accessCode ? <Text style={styles.accessCode}>提取码：{item.accessCode}</Text> : null}
                  </View>

                  <View style={styles.linkBox}>
                    <Text style={styles.linkLabel}>分享链接</Text>
                    <Text style={styles.linkText} selectable>{item.shareUrl}</Text>
                  </View>

                  {item.description ? <Text style={styles.providerDescription}>{item.description}</Text> : null}
                  {item.saveHint ? <Text style={styles.providerHint}>保存提示：{item.saveHint}</Text> : null}

                  {item.steps && item.steps.length > 0 ? (
                    <View style={styles.stepList}>
                      {item.steps.map((step, index) => (
                        <Text key={`${item.provider}_${index}`} style={styles.stepText}>{index + 1}. {step}</Text>
                      ))}
                    </View>
                  ) : null}

                  <View style={styles.actionRow}>
                    <Pressable style={[styles.actionBtn, styles.copyBtn]} onPress={() => void handleCopy(item)} disabled={!!busyProvider}>
                      {isCopying ? <ActivityIndicator size="small" color="#7C3AED" /> : <Copy size={16} color="#7C3AED" />}
                      <Text style={styles.copyBtnText}>{isCopying ? '复制中…' : '复制转存信息'}</Text>
                    </Pressable>
                    <Pressable style={[styles.actionBtn, styles.openBtn]} onPress={() => void handleOpen(item)} disabled={!!busyProvider}>
                      {isOpening ? <ActivityIndicator size="small" color="#2563EB" /> : <ExternalLink size={16} color="#2563EB" />}
                      <Text style={styles.openBtnText}>{isOpening ? '打开中…' : '打开链接'}</Text>
                    </Pressable>
                  </View>
                </View>
              );
            })}
          </>
        )}
      </ScrollView>
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
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.md,
    gap: spacing.sm,
  },
  backBtn: {
    width: 36,
    height: 36,
    borderRadius: borderRadius.full,
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: colors.border.light,
  },
  headerTitle: {
    flex: 1,
    color: colors.text.primary,
    fontSize: fontSize.lg,
    fontWeight: fontWeight.bold,
  },
  refreshBtn: {
    width: 36,
    height: 36,
    borderRadius: borderRadius.full,
    alignItems: 'center',
    justifyContent: 'center',
  },
  scrollContent: {
    paddingHorizontal: spacing.lg,
    gap: spacing.md,
  },
  centerState: {
    paddingVertical: spacing.xl,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
  },
  centerText: {
    color: colors.text.secondary,
    fontSize: fontSize.sm,
  },
  errorText: {
    color: '#DC2626',
    fontSize: fontSize.sm,
    textAlign: 'center',
    lineHeight: 20,
  },
  retryBtn: {
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: borderRadius.full,
    backgroundColor: colors.primary,
  },
  retryBtnText: {
    color: '#FFFFFF',
    fontSize: fontSize.sm,
    fontWeight: fontWeight.bold,
  },
  providerCard: {
    backgroundColor: colors.surface,
    borderRadius: borderRadius.xl,
    padding: spacing.lg,
    gap: spacing.sm,
    borderWidth: 1,
    borderColor: colors.border.light,
  },
  providerHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
  },
  providerBadge: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: borderRadius.full,
  },
  providerBadgeBaidu: {
    backgroundColor: '#EFF6FF',
  },
  providerBadgeText: {
    fontSize: fontSize.xs,
    fontWeight: fontWeight.bold,
  },
  providerBadgeTextBaidu: {
    color: '#2563EB',
  },
  accessCode: {
    color: colors.text.secondary,
    fontSize: fontSize.xs,
    fontWeight: fontWeight.medium,
  },
  linkBox: {
    gap: 6,
    padding: spacing.md,
    borderRadius: borderRadius.lg,
    backgroundColor: '#F8FAFC',
    borderWidth: 1,
    borderColor: colors.border.light,
  },
  linkLabel: {
    color: colors.text.secondary,
    fontSize: fontSize.xs,
  },
  linkText: {
    color: colors.text.primary,
    fontSize: fontSize.sm,
    lineHeight: 20,
  },
  providerDescription: {
    color: colors.text.secondary,
    fontSize: fontSize.sm,
    lineHeight: 21,
  },
  providerHint: {
    color: colors.text.primary,
    fontSize: fontSize.sm,
    lineHeight: 20,
  },
  stepList: {
    gap: 6,
  },
  stepText: {
    color: colors.text.secondary,
    fontSize: fontSize.sm,
    lineHeight: 20,
  },
  actionRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
    marginTop: spacing.xs,
  },
  actionBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: borderRadius.full,
    borderWidth: 1,
  },
  copyBtn: {
    backgroundColor: '#F5F3FF',
    borderColor: '#DDD6FE',
  },
  copyBtnText: {
    color: '#7C3AED',
    fontSize: fontSize.sm,
    fontWeight: fontWeight.bold,
  },
  openBtn: {
    backgroundColor: '#EFF6FF',
    borderColor: '#BFDBFE',
  },
  openBtnText: {
    color: '#2563EB',
    fontSize: fontSize.sm,
    fontWeight: fontWeight.bold,
  },
});
