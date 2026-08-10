/**
 * UsageBar — shared quota progress visualization.
 *
 * Two variants:
 *   - <MiniUsageBars />   one-line compact, 3 thin bars under userCard
 *                         on the profile tab. No numbers, just color.
 *   - <FullUsageBars />   the /membership detail page variant. 8 px bars
 *                         with field label + "used / displayed" numbers.
 *
 * Display limit (the number the user sees):
 *   - Free: hard (the only cap that exists; soft is meaningless here).
 *     Exceeded = blocked.
 *   - Pro:  soft (the "normal" allowance; hard is the silent wall).
 *     Exceeded soft = bar stays full + warning color, user can keep
 *     going silently up to hard.
 *
 * Bar color (centralized in `barColor`):
 *   used < 70% of displayed           →  green   (plenty left)
 *   70% displayed .. displayed        →  yellow  (approaching)
 *   at/past displayed (still < hard)  →  orange  (Pro bonus zone / Free about to block)
 *   >= hard                            →  red     (blocked, will hit QuotaBlockedDialog)
 *
 * The hook `useUsageSnapshot` is the single source for config + usage +
 * tier; both variants use it so the two views can never disagree.
 *
 * No "upgrade Pro" copy anywhere. The bars just tell the user where
 * they are. (See /membership.tsx for the redeem entry point.)
 */

import React, { useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import {
  getProState,
  getQuotaConfig,
  getTodayUsage,
  quotaFieldLabel,
  type ProState,
  type QuotaConfig,
  type QuotaField,
  type QuotaUsage,
} from '../../lib/quota';

const FIELDS: QuotaField[] = ['ai_rounds', 'asr', 'tts'];

export interface UsageSnapshot {
  tier: 'free' | 'pro';
  config: QuotaConfig | null;
  usage: QuotaUsage;
  loading: boolean;
}

export function useUsageSnapshot(): UsageSnapshot & { reload: () => void } {
  const [proState, setProState] = useState<ProState>({ tier: 'free', expiresAt: null, updatedAt: 0 });
  const [config, setConfig] = useState<QuotaConfig | null>(null);
  const [usage, setUsage] = useState<QuotaUsage>({ ai_rounds: 0, asr: 0, tts: 0, asr_subtitle: 0 });
  const [loading, setLoading] = useState(true);

  const reload = React.useCallback(async () => {
    try {
      const [ps, cfg, u] = await Promise.all([
        getProState(),
        getQuotaConfig(),
        getTodayUsage(),
      ]);
      setProState(ps);
      setConfig(cfg);
      setUsage(u);
    } catch (e) {
      // Best-effort: keep previous snapshot on error.
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const isProActive =
    proState.tier === 'pro' &&
    (!proState.expiresAt || new Date(proState.expiresAt).getTime() > Date.now());

  return {
    tier: isProActive ? 'pro' : 'free',
    config,
    usage,
    loading,
    reload,
  };
}

/**
 * Display limit for the bar + number.
 *   - Free: hard (the only cap that exists; soft is meaningless here)
 *   - Pro:  soft (the "normal" allowance, hard is the silent wall)
 */
function displayedLimit(snap: UsageSnapshot, field: QuotaField): number {
  if (!snap.config) return 0;
  const limits = snap.config[snap.tier][field];
  return snap.tier === 'pro' ? limits.soft : limits.hard;
}

function fieldLimits(snap: UsageSnapshot, field: QuotaField) {
  if (!snap.config) return { soft: 0, hard: 0 };
  return snap.config[snap.tier][field];
}

/**
 * Bar color (used → hard = the real block, displayed = the visible cap).
 *   - used < 70% of displayed           → green
 *   - 70% of displayed .. displayed     → yellow (approaching)
 *   - at/past displayed (still < hard)  → orange (warning, Pro "bonus" zone)
 *   - >= hard                            → red (will be blocked next call)
 */
function barColor(used: number, displayed: number, hard: number): string {
  if (hard > 0 && used >= hard) return '#EF4444';
  if (displayed > 0 && used >= displayed) return '#F59E0B';
  if (displayed > 0 && used >= displayed * 0.7) return '#EAB308';
  return '#10B981';
}

function clampPct(used: number, displayed: number): number {
  if (displayed <= 0) return 0;
  return Math.max(0, Math.min(1, used / displayed));
}

// ── Mini variant: profile tab under userCard ─────────────────────────

export function MiniUsageBars() {
  const snap = useUsageSnapshot();
  if (snap.loading) {
    return (
      <View style={miniStyles.wrap}>
        <ActivityIndicator size="small" />
      </View>
    );
  }
  return (
    <View style={miniStyles.wrap}>
      {FIELDS.map((field) => {
        const used = snap.usage[field];
        const displayed = displayedLimit(snap, field);
        const { hard } = fieldLimits(snap, field);
        const pct = clampPct(used, displayed);
        const color = barColor(used, displayed, hard);
        return (
          <View key={field} style={miniStyles.row}>
            <Text style={miniStyles.label} numberOfLines={1}>
              {quotaFieldLabel(field)}
            </Text>
            <View style={miniStyles.track}>
              <View
                style={[
                  miniStyles.fill,
                  { width: `${pct * 100}%`, backgroundColor: color },
                ]}
              />
            </View>
          </View>
        );
      })}
    </View>
  );
}

const miniStyles = StyleSheet.create({
  wrap: {
    paddingHorizontal: 16,
    paddingTop: 4,
    paddingBottom: 8,
    gap: 6,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  label: {
    width: 56,
    fontSize: 11,
    color: '#8A8A8A',
  },
  track: {
    flex: 1,
    height: 4,
    borderRadius: 2,
    backgroundColor: '#EEEEEE',
    overflow: 'hidden',
  },
  fill: {
    height: '100%',
    borderRadius: 2,
  },
});

// ── Full variant: /membership detail page ────────────────────────────

interface FullRowProps {
  field: QuotaField;
  used: number;
  displayed: number;
  hard: number;
}

function FullUsageRow({ field, used, displayed, hard }: FullRowProps) {
  const pct = clampPct(used, displayed);
  const color = barColor(used, displayed, hard);
  return (
    <View style={fullStyles.row}>
      <View style={fullStyles.rowHeader}>
        <Text style={fullStyles.label}>{quotaFieldLabel(field)}</Text>
        <Text style={fullStyles.numbers}>
          {used} / {displayed} <Text style={fullStyles.numbersMuted}>次</Text>
        </Text>
      </View>
      <View style={fullStyles.track}>
        <View
          style={[
            fullStyles.fill,
            { width: `${pct * 100}%`, backgroundColor: color },
          ]}
        />
      </View>
    </View>
  );
}

export function FullUsageBars() {
  const snap = useUsageSnapshot();
  if (snap.loading || !snap.config) {
    return (
      <View style={fullStyles.loading}>
        <ActivityIndicator size="small" />
      </View>
    );
  }
  return (
    <View style={fullStyles.wrap}>
      {FIELDS.map((field) => {
        const displayed = displayedLimit(snap, field);
        const { hard } = fieldLimits(snap, field);
        return (
          <FullUsageRow
            key={field}
            field={field}
            used={snap.usage[field]}
            displayed={displayed}
            hard={hard}
          />
        );
      })}
    </View>
  );
}

const fullStyles = StyleSheet.create({
  wrap: {
    gap: 18,
  },
  loading: {
    paddingVertical: 24,
    alignItems: 'center',
  },
  row: {
    gap: 6,
  },
  rowHeader: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
  },
  label: {
    fontSize: 14,
    color: '#1A1A1A',
    fontWeight: '500',
  },
  numbers: {
    fontSize: 15,
    color: '#1A1A1A',
    fontWeight: '600',
    fontVariant: ['tabular-nums'],
  },
  numbersMuted: {
    fontSize: 12,
    fontWeight: '400',
    color: '#9A9A9A',
  },
  track: {
    height: 8,
    borderRadius: 4,
    backgroundColor: '#F0F0F0',
    overflow: 'hidden',
  },
  fill: {
    height: '100%',
    borderRadius: 4,
  },
});
