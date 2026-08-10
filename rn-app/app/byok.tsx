/**
 * /byok — BYOK (Bring Your Own Key) configuration page.
 *
 * Single page covering:
 *   - Master "使用我的 API 密钥" switch
 *   - Provider chip selector (OpenAI / Anthropic / DeepSeek / Doubao / Zhipu / Moonshot / 自定义)
 *   - API key (masked input)
 *   - Base URL (editable, prefilled from preset)
 *   - Model (editable, prefilled from preset)
 *   - "测试连接" — fires a tiny ping via the right adapter
 *   - "保存" — persists + returns to caller
 *   - Danger zone: 删除
 *
 * The same page handles the four "states" of a BYOK config:
 *   empty   — fresh user, just defaults
 *   filled  — key in storage but disabled
 *   active  — enabled, key set
 *   broken  — enabled, but test ping failed (red hint)
 */

import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Keyboard,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useRouter, useFocusEffect } from 'expo-router';
import { KeyRound, X, Check, AlertCircle, ChevronDown, Eye, EyeOff, Crown, Lock, Sparkles, ChevronRight } from 'lucide-react-native';
import { colors, spacing, borderRadius, fontSize, fontWeight } from '../constants/theme';
import {
  BYOK_PROVIDERS,
  decodeKey,
  encodeKey,
  getByokConfig,
  saveByokConfig,
  testByokConnection,
  type ByokConfig,
  type ByokProviderId,
} from '../lib/byok';
import { getProState, type ProState } from '../lib/quota';

export default function ByokScreen() {
  const router = useRouter();
  const [cfg, setCfg] = useState<ByokConfig | null>(null);
  // The plain key as the user types it. We never read the obfuscated
  // form back into the input — always show the user's pending text
  // until they save.
  const [keyInput, setKeyInput] = useState('');
  const [keyDirty, setKeyDirty] = useState(false);
  const [providerMenuOpen, setProviderMenuOpen] = useState(false);
  const [keyVisible, setKeyVisible] = useState(false);

  // ── Pro gate ─────────────────────────────────────────────────────
  // BYOK is a Pro-only feature. Free users land on a clean upgrade
  // page instead of the config form. The gate reads Pro state on
  // every focus so a user who redeemed an upgrade while away comes
  // back to the config form without needing to manually reload.
  const [proState, setProState] = useState<ProState | null>(null);
  const reloadPro = useCallback(async () => {
    try {
      setProState(await getProState());
    } catch {
      setProState(null);
    }
  }, []);
  useEffect(() => { void reloadPro(); }, [reloadPro]);
  useFocusEffect(useCallback(() => { void reloadPro(); }, [reloadPro]));
  const [testState, setTestState] = useState<
    | { kind: 'idle' }
    | { kind: 'testing' }
    | { kind: 'ok'; model: string }
    | { kind: 'fail'; reason: string; status?: number }
  >({ kind: 'idle' });

  // Load on mount
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const stored = await getByokConfig();
      if (cancelled) return;
      setCfg(stored);
      setKeyInput(stored.apiKeyB64 ? decodeKey(stored.apiKeyB64) : '');
      setKeyDirty(false);
    })();
    return () => { cancelled = true; };
  }, []);

  if (!cfg) {
    return (
      <View style={styles.container}>
        <ActivityIndicator style={{ marginTop: 80 }} />
      </View>
    );
  }

  // ── Pro gate rendering ──────────────────────────────────────────
  // proState === null means we're still checking; don't flash the
  // gate to a Pro user while loading.
  const isPro =
    proState !== null &&
    proState.tier === 'pro' &&
    (!proState.expiresAt || new Date(proState.expiresAt).getTime() > Date.now());

  if (proState !== null && !isPro) {
    return (
      <View style={styles.container}>
        <View style={styles.header}>
          <View style={styles.headerSide} />
          <Text style={styles.headerTitle}>我的 API 密钥</Text>
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
          <Text style={styles.gateTitle}>使用你自己的 API Key</Text>
          <Text style={styles.gateDesc}>
            接入 OpenAI、Claude、DeepSeek 等任意供应商的密钥,{'\n'}
            AI 对话走你的额度,不消耗 NativeOS 配额。
          </Text>

          {/* Value props — short, only what matters for the decision */}
          <View style={styles.gateProps}>
            <View style={styles.gatePropRow}>
              <Sparkles size={14} color="#60A5FA" />
              <Text style={styles.gatePropText}>解锁全部 AI 供应商,模型自选</Text>
            </View>
            <View style={styles.gatePropRow}>
              <Sparkles size={14} color="#60A5FA" />
              <Text style={styles.gatePropText}>不计 NativeOS 每日 AI 配额</Text>
            </View>
            <View style={styles.gatePropRow}>
              <Sparkles size={14} color="#60A5FA" />
              <Text style={styles.gatePropText}>密钥本地保存,不上传服务端</Text>
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
  // ── End Pro gate ────────────────────────────────────────────────

  const preset = BYOK_PROVIDERS[cfg.provider];
  const effectiveBaseUrl = cfg.baseUrl || preset.baseUrl;
  const effectiveModel = cfg.model || preset.defaultModel;

  // Build a candidate config to test / save. If the user hasn't
  // edited the key field, keep the stored b64 (so re-saving doesn't
  // accidentally wipe the key on a blank field).
  const buildCandidate = (overrides: Partial<ByokConfig> = {}): ByokConfig => {
    const apiKeyB64 = keyDirty && keyInput
      ? encodeKey(keyInput)
      : (cfg.apiKeyB64 || (keyInput ? encodeKey(keyInput) : ''));
    return {
      ...cfg,
      ...overrides,
      apiKeyB64,
      updatedAt: Date.now(),
    };
  };

  const onPickProvider = (id: ByokProviderId) => {
    const next = BYOK_PROVIDERS[id];
    setCfg({
      ...cfg,
      provider: id,
      baseUrl: next.baseUrl,
      model: next.defaultModel,
    });
    setTestState({ kind: 'idle' });
  };

  const onTest = async () => {
    Keyboard.dismiss();
    setTestState({ kind: 'testing' });
    const candidate = buildCandidate({ enabled: true });
    console.log('[BYOK] onTest candidate', {
      provider: candidate.provider,
      baseUrl: candidate.baseUrl,
      model: candidate.model,
      enabled: candidate.enabled,
      apiKeyB64_len: candidate.apiKeyB64.length,
      apiKeyB64_preview: candidate.apiKeyB64.slice(0, 16),
      cfg_apiKeyB64_len: cfg.apiKeyB64.length,
      keyInput_len: keyInput.length,
      keyDirty,
    });
    const res = await testByokConnection(candidate);
    console.log('[BYOK] onTest result', res);
    if (res.ok) {
      setTestState({ kind: 'ok', model: res.model });
    } else {
      setTestState({ kind: 'fail', reason: res.reason, status: res.status });
    }
  };

  const onSave = async () => {
    Keyboard.dismiss();
    const candidate = buildCandidate();
    if (candidate.enabled && !candidate.apiKeyB64) {
      Alert.alert('无法启用', '请先填写 API 密钥');
      return;
    }
    await saveByokConfig(candidate);
    setCfg(candidate);
    setKeyInput(decodeKey(candidate.apiKeyB64));
    setKeyDirty(false);
    setTimeout(() => router.back(), 300);
  };

  const onDisable = async () => {
    const next = { ...cfg, enabled: false, updatedAt: Date.now() };
    await saveByokConfig(next);
    setCfg(next);
  };

  const onDelete = () => {
    Alert.alert(
      '删除 API 密钥',
      '将清空 provider / key / baseUrl / model,关闭 BYOK。确定吗?',
      [
        { text: '取消', style: 'cancel' },
        {
          text: '删除',
          style: 'destructive',
          onPress: async () => {
            const cleared: ByokConfig = {
              enabled: false,
              provider: 'openai',
              apiKeyB64: '',
              baseUrl: BYOK_PROVIDERS.openai.baseUrl,
              model: BYOK_PROVIDERS.openai.defaultModel,
              updatedAt: Date.now(),
            };
            await saveByokConfig(cleared);
            setCfg(cleared);
            setKeyInput('');
            setKeyDirty(false);
            setTestState({ kind: 'idle' });
          },
        },
      ],
    );
  };

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <View style={styles.header}>
        <View style={styles.headerSide} />
        <Text style={styles.headerTitle}>我的 API 密钥</Text>
        <Pressable style={styles.headerSide} hitSlop={10} onPress={() => router.back()}>
          <X size={20} color="#5A5A5A" />
        </Pressable>
      </View>

      <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
        {/* ── Master switch ── */}
        <View style={styles.masterCard}>
          <View style={styles.masterLeft}>
            <View style={styles.masterIcon}>
              <KeyRound size={18} color="#1A1A1A" />
            </View>
            <View style={styles.masterTextCol}>
              <Text style={styles.masterTitle}>使用我的 API 密钥</Text>
              <Text style={styles.masterDesc}>
                开启后,AI 对话走你的 key,不计 NativeOS 配额
              </Text>
            </View>
          </View>
          <Switch
            value={cfg.enabled}
            onValueChange={(v) => {
              setCfg({ ...cfg, enabled: v });
              setTestState({ kind: 'idle' });
            }}
            trackColor={{ false: '#D0D0D0', true: '#1A1A1A' }}
            thumbColor="#FFFFFF"
          />
        </View>

        {/* ── Provider dropdown ── */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Provider</Text>
          <Pressable
            onPress={() => setProviderMenuOpen(true)}
            style={({ pressed }) => [styles.inputWrap, styles.dropdownTrigger, pressed && styles.dropdownTriggerPressed]}
          >
            <Text style={styles.dropdownText} numberOfLines={1}>
              {preset.label}
            </Text>
            <ChevronDown size={18} color="#5A5A5A" />
          </Pressable>
        </View>

        {/* ── Key ── */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>API Key</Text>
          <View style={[styles.inputWrap, styles.keyInputWrap]}>
            <TextInput
              value={keyInput}
              onChangeText={(t) => {
                setKeyInput(t);
                setKeyDirty(true);
                setTestState({ kind: 'idle' });
              }}
              placeholder={preset.placeholderKeyPrefix ?? 'sk-...'}
              placeholderTextColor="#9A9A9A"
              autoCapitalize="none"
              autoCorrect={false}
              autoComplete="off"
              spellCheck={false}
              secureTextEntry={!keyVisible}
              style={[styles.input, styles.keyInput]}
            />
            <Pressable
              onPress={() => setKeyVisible((v) => !v)}
              hitSlop={8}
              style={styles.eyeBtn}
            >
              {keyVisible ? (
                <EyeOff size={18} color="#6A6A6A" />
              ) : (
                <Eye size={18} color="#6A6A6A" />
              )}
            </Pressable>
          </View>
        </View>

        {/* ── Base URL ── */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Base URL</Text>
          <View style={styles.inputWrap}>
            <TextInput
              value={effectiveBaseUrl}
              onChangeText={(t) => {
                setCfg({ ...cfg, baseUrl: t });
                setTestState({ kind: 'idle' });
              }}
              placeholder="https://..."
              placeholderTextColor="#9A9A9A"
              autoCapitalize="none"
              autoCorrect={false}
              autoComplete="off"
              style={styles.input}
            />
          </View>
        </View>

        {/* ── Model ── */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Model</Text>
          <View style={styles.inputWrap}>
            <TextInput
              value={effectiveModel}
              onChangeText={(t) => {
                setCfg({ ...cfg, model: t });
                setTestState({ kind: 'idle' });
              }}
              placeholder="model name"
              placeholderTextColor="#9A9A9A"
              autoCapitalize="none"
              autoCorrect={false}
              autoComplete="off"
              style={styles.input}
            />
          </View>
        </View>

        {/* ── Test connection ── */}
        <Pressable
          style={({ pressed }) => [styles.testBtn, pressed && styles.testBtnPressed]}
          onPress={onTest}
          disabled={testState.kind === 'testing'}
        >
          {testState.kind === 'testing' ? (
            <ActivityIndicator color="#1A1A1A" />
          ) : (
            <Text style={styles.testBtnText}>测试连接</Text>
          )}
        </Pressable>

        {testState.kind === 'ok' && (
          <View style={styles.testOkRow}>
            <Check size={16} color="#1F7A3A" />
            <Text style={styles.testOkText}>
              连接成功 · 模型 {testState.model}
            </Text>
          </View>
        )}
        {testState.kind === 'fail' && (
          <View style={styles.testFailRow}>
            <AlertCircle size={16} color="#C44545" />
            <Text style={styles.testFailText} numberOfLines={3}>
              连接失败 · {friendlyTestReason(testState.reason, testState.status)}
            </Text>
          </View>
        )}

        {/* ── Save / Disable / Delete ── */}
        <Pressable
          style={({ pressed }) => [styles.saveBtn, pressed && styles.saveBtnPressed]}
          onPress={onSave}
        >
          <Text style={styles.saveBtnText}>保存</Text>
        </Pressable>

        {cfg.apiKeyB64 && cfg.enabled && (
          <Pressable style={styles.secondaryBtn} onPress={onDisable}>
            <Text style={styles.secondaryBtnText}>仅关闭 BYOK(保留密钥)</Text>
          </Pressable>
        )}

        {cfg.apiKeyB64 && (
          <Pressable style={styles.dangerBtn} onPress={onDelete}>
            <Text style={styles.dangerBtnText}>删除密钥</Text>
          </Pressable>
        )}
      </ScrollView>

      {/* ── Provider dropdown modal ── */}
      <Modal
        visible={providerMenuOpen}
        transparent
        animationType="fade"
        onRequestClose={() => setProviderMenuOpen(false)}
      >
        <Pressable
          style={styles.menuBackdrop}
          onPress={() => setProviderMenuOpen(false)}
        >
          <Pressable style={styles.menuCard} onPress={() => { /* eat press */ }}>
            <Text style={styles.menuTitle}>选择 Provider</Text>
            <ScrollView style={styles.menuList} keyboardShouldPersistTaps="handled">
              {(Object.keys(BYOK_PROVIDERS) as ByokProviderId[]).map((id) => {
                const p = BYOK_PROVIDERS[id];
                const active = cfg.provider === id;
                return (
                  <Pressable
                    key={id}
                    onPress={() => {
                      onPickProvider(id);
                      setProviderMenuOpen(false);
                    }}
                    style={({ pressed }) => [
                      styles.menuItem,
                      active && styles.menuItemActive,
                      pressed && styles.menuItemPressed,
                    ]}
                  >
                    <View style={styles.menuItemTextCol}>
                      <Text
                        style={[styles.menuItemLabel, active && styles.menuItemLabelActive]}
                        numberOfLines={1}
                      >
                        {p.label}
                      </Text>
                      <Text style={styles.menuItemHint} numberOfLines={1}>
                        {p.wire === 'openai' ? 'OpenAI 兼容' : 'Anthropic'}
                        {p.defaultModel ? ` · ${p.defaultModel}` : ''}
                      </Text>
                    </View>
                    {active && <Check size={18} color="#1A1A1A" />}
                  </Pressable>
                );
              })}
            </ScrollView>
          </Pressable>
        </Pressable>
      </Modal>
    </KeyboardAvoidingView>
  );
}

function friendlyTestReason(reason: string, status?: number): string {
  if (reason === 'empty_key') return '请先填写密钥';
  if (reason === 'unknown_provider') return '未知的 provider';
  if (reason === 'empty_base_url') return '请填写 Base URL';
  if (reason === 'empty_model') return '请填写 Model';
  if (reason === 'network') return '网络异常';
  if (reason === 'timeout') return '请求超时';
  if (reason === 'http') {
    if (status === 401) return '401 未授权 — 密钥无效';
    if (status === 403) return '403 禁止访问 — 密钥无权限';
    if (status === 404) return '404 — Base URL 或 Model 不存在';
    if (status === 429) return '429 — 请求过快或额度超限';
    if (status && status >= 500) return `${status} — 服务端错误`;
    return status ? `HTTP ${status}` : 'HTTP 错误';
  }
  if (reason === 'empty') return '返回内容为空';
  if (reason === 'invalid_json') return '返回非 JSON 格式';
  return reason;
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
  scroll: {
    paddingHorizontal: 16,
    paddingBottom: 40,
    gap: 18,
  },
  masterCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    padding: 14,
    backgroundColor: '#FFFFFF',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#E5E5E5',
  },
  masterLeft: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  masterIcon: {
    width: 32,
    height: 32,
    borderRadius: 8,
    backgroundColor: '#F3F3F3',
    alignItems: 'center',
    justifyContent: 'center',
  },
  masterTextCol: {
    flex: 1,
    minWidth: 0,
  },
  masterTitle: {
    fontSize: 14,
    fontWeight: '500',
    color: '#1A1A1A',
  },
  masterDesc: {
    fontSize: 12,
    color: '#6A6A6A',
    marginTop: 2,
  },
  section: { gap: 8 },
  sectionTitle: {
    fontSize: 12,
    fontWeight: '500',
    color: '#6A6A6A',
  },
  dropdownTrigger: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 6,
  },
  dropdownTriggerPressed: {
    backgroundColor: '#F0F0F0',
  },
  dropdownText: {
    fontSize: 14,
    color: '#1A1A1A',
    fontWeight: '500',
  },
  menuBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.45)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  menuCard: {
    width: '100%',
    maxWidth: 380,
    maxHeight: '70%',
    backgroundColor: '#FFFFFF',
    borderRadius: 16,
    paddingTop: 8,
    paddingBottom: 8,
    shadowColor: '#000',
    shadowOpacity: 0.18,
    shadowRadius: 24,
    shadowOffset: { width: 0, height: 12 },
    elevation: 8,
  },
  menuTitle: {
    fontSize: 13,
    fontWeight: '600',
    color: '#6A6A6A',
    paddingHorizontal: 18,
    paddingTop: 10,
    paddingBottom: 6,
  },
  menuList: {
    flexShrink: 1,
  },
  menuItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 18,
    paddingVertical: 12,
  },
  menuItemActive: {
    backgroundColor: '#F7F7F7',
  },
  menuItemPressed: {
    backgroundColor: '#EFEFEF',
  },
  menuItemTextCol: {
    flex: 1,
    minWidth: 0,
  },
  menuItemLabel: {
    fontSize: 14,
    fontWeight: '500',
    color: '#1A1A1A',
  },
  menuItemLabelActive: {
    fontWeight: '600',
  },
  menuItemHint: {
    fontSize: 11,
    color: '#9A9A9A',
    marginTop: 2,
  },
  inputWrap: {
    borderWidth: 1,
    borderColor: '#E0E0E0',
    borderRadius: 10,
    backgroundColor: '#FAFAFA',
    paddingHorizontal: 12,
  },
  input: {
    fontSize: 14,
    color: '#1A1A1A',
    paddingVertical: 10,
  },
  keyInputWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingRight: 4,
  },
  keyInput: {
    flex: 1,
  },
  eyeBtn: {
    paddingHorizontal: 8,
    paddingVertical: 6,
  },
  testBtn: {
    paddingVertical: 12,
    borderRadius: 10,
    backgroundColor: '#F3F3F3',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#E0E0E0',
  },
  testBtnPressed: { backgroundColor: '#E8E8E8' },
  testBtnText: { color: '#1A1A1A', fontSize: 14, fontWeight: '500' },
  testOkRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 4,
  },
  testOkText: {
    fontSize: 13,
    color: '#1F7A3A',
  },
  testFailRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 6,
    paddingHorizontal: 4,
  },
  testFailText: {
    fontSize: 13,
    color: '#C44545',
    flex: 1,
  },
  saveBtn: {
    backgroundColor: '#1A1A1A',
    paddingVertical: 14,
    borderRadius: 12,
    alignItems: 'center',
  },
  saveBtnPressed: { backgroundColor: '#000' },
  saveBtnText: { color: '#FFFFFF', fontSize: 15, fontWeight: '500' },
  secondaryBtn: {
    paddingVertical: 12,
    alignItems: 'center',
  },
  secondaryBtnText: {
    color: '#6A6A6A',
    fontSize: 13,
  },
  dangerBtn: {
    paddingVertical: 12,
    alignItems: 'center',
  },
  dangerBtnText: {
    color: '#C44545',
    fontSize: 13,
  },

  // ── Pro gate styles ─────────────────────────────────────────────
  // Originally these were tuned for a dark surface (white/alpha text on
  // a translucent dark card) but the screen sits on `colors.background`
  // which is a light theme — white-on-white made the title, description
  // and the 3 value props invisible. Re-tuned for light theme.
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
    fontWeight: '700' as any,
    color: '#F59E0B',
    letterSpacing: 1,
  },
  gateTitle: {
    fontSize: 22,
    fontWeight: '800' as any,
    color: '#1A1A1A',
    textAlign: 'center',
    marginBottom: 12,
  },
  gateDesc: {
    fontSize: 14,
    color: '#5A5A5A',
    textAlign: 'center',
    lineHeight: 22,
    marginBottom: 32,
  },
  gateProps: {
    alignSelf: 'stretch',
    backgroundColor: '#F7F7F7',
    borderWidth: 1,
    borderColor: '#E5E5E5',
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
    color: '#3A3A3A',
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
    fontWeight: '700' as any,
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
    color: '#5A5A5A',
    fontSize: 13,
    fontWeight: '600' as any,
  },
});
