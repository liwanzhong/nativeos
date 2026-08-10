/**
 * QuotaBlockedDialog — gentle, non-salesy "额度用完啦" dialog shown when
 * a hard-limit consume attempt is rejected.
 *
 * Design rules (per user):
 *   - DO NOT mention pricing, "立即升级", "Pro 用户 X 倍", or "限时" anywhere.
 *   - The primary action is "好的" (default focus, Enter to close).
 *   - The secondary action is "了解 Pro" — only present if the user is
 *     NOT already on the Pro path. It opens a neutral info view, not a
 *     checkout. If the user is not signed in, "了解 Pro" routes to /login.
 *   - Tone is conversational: "今天的额度用完啦" rather than
 *     "You have exceeded your quota".
 *   - The "用完的是什么" hint is just a small muted line below the body
 *     so the user knows which subsystem is throttled.
 *
 * Usage:
 *   const verdict = await consumeAndNotify('asr');
 *   if (!verdict.allowed) {
 *     quotaDialog.show({ field: verdict.field, tier: verdict.tier });
 *   }
 */

import React, { useEffect, useRef, useState } from 'react';
import { Modal, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { quotaFieldLabel, type QuotaField, type Tier } from '../../lib/quota';
import { useAuth } from '../../lib/auth';

interface BlockedInfo {
  field: QuotaField;
  tier: Tier;
  /** Optional: how many were used when blocked. */
  used?: number;
  /** Optional: the hard limit that was hit. */
  hard?: number;
}

interface DialogApi {
  show: (info: BlockedInfo) => void;
  hide: () => void;
}

let _externalShow: ((info: BlockedInfo) => void) | null = null;

export const quotaDialog: DialogApi = {
  show(info) {
    _externalShow?.(info);
  },
  hide() {
    _externalShow?.(null as any);
  },
};

export function QuotaBlockedDialog() {
  const [info, setInfo] = useState<BlockedInfo | null>(null);
  const router = useRouter();
  const { user } = useAuth();
  const primaryRef = useRef<View>(null);

  useEffect(() => {
    _externalShow = (next) => {
      if (!next) {
        setInfo(null);
      } else {
        setInfo(next);
      }
    };
    return () => {
      _externalShow = null;
    };
  }, []);

  if (!info) return null;

  const bodyText = info.tier === 'pro'
    ? '今天的 Pro 额度用完啦，明天再来吧。'
    : '今天的免费额度用完啦，明天再来吧。';

  const fieldHint = info.used != null && info.hard != null
    ? `${quotaFieldLabel(info.field)} · 已用 ${info.used}/${info.hard} 次`
    : `${quotaFieldLabel(info.field)}额度已用完`;

  return (
    <Modal
      visible
      transparent
      animationType="fade"
      onRequestClose={() => setInfo(null)}
    >
      <Pressable style={styles.backdrop} onPress={() => setInfo(null)}>
        <Pressable style={styles.card} onPress={() => { /* eat press */ }}>
          <Text style={styles.title}>先休息一下吧</Text>
          <Text style={styles.body}>{bodyText}</Text>
          <Text style={styles.hint}>{fieldHint}</Text>

          <View style={styles.actions}>
            <Pressable
              ref={primaryRef as any}
              style={({ pressed }) => [
                styles.primaryBtn,
                pressed && styles.primaryBtnPressed,
              ]}
              onPress={() => setInfo(null)}
              // Auto-focus the primary button on web/desktop so Enter closes.
              {...(Platform.OS === 'web' ? ({ autoFocus: true } as any) : {})}
            >
              <Text style={styles.primaryBtnText}>好的</Text>
            </Pressable>
            <Pressable
              style={({ pressed }) => [styles.secondaryBtn, pressed && styles.secondaryBtnPressed]}
              onPress={() => {
                setInfo(null);
                if (!user) {
                  router.push('/login');
                } else {
                  router.push('/redeem');
                }
              }}
            >
              <Text style={styles.secondaryBtnText}>了解 Pro</Text>
            </Pressable>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.45)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  card: {
    width: '100%',
    maxWidth: 360,
    backgroundColor: '#FFFFFF',
    borderRadius: 16,
    paddingHorizontal: 22,
    paddingTop: 22,
    paddingBottom: 18,
    shadowColor: '#000',
    shadowOpacity: 0.18,
    shadowRadius: 24,
    shadowOffset: { width: 0, height: 12 },
    elevation: 8,
  },
  title: {
    fontSize: 17,
    fontWeight: '600',
    color: '#1A1A1A',
    marginBottom: 8,
  },
  body: {
    fontSize: 14,
    color: '#3A3A3A',
    lineHeight: 22,
    marginBottom: 6,
  },
  hint: {
    fontSize: 12,
    color: '#9A9A9A',
    marginBottom: 18,
  },
  actions: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: 8,
  },
  primaryBtn: {
    paddingHorizontal: 18,
    paddingVertical: 10,
    backgroundColor: '#1A1A1A',
    borderRadius: 10,
  },
  primaryBtnPressed: {
    backgroundColor: '#000',
  },
  primaryBtnText: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '500',
  },
  secondaryBtn: {
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 10,
  },
  secondaryBtnPressed: {
    backgroundColor: 'rgba(0,0,0,0.04)',
  },
  secondaryBtnText: {
    color: '#6A6A6A',
    fontSize: 13,
  },
});
