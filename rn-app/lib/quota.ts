/**
 * Quota engine — Free vs Pro usage limits.
 *
 * Design (per the user's four constraints):
 *   1. Payment UI is NOT pushed. Soft limit = silent indicator only.
 *      Hard limit = a gentle "额度用完啦" dialog with NO "立即升级" button.
 *   2. Counting is local-first (per-device daily counter in SQLite app_config)
 *      because AI/ASR/TTS go directly to third-party APIs — there's no
 *      server-side hook to count for us.
 *   3. Local counter IS mirrored to Supabase `profiles.quota_snapshot`
 *      (throttled to once per 60 s, plus on app background) so a user who
 *      reinstalls or uses a second device still has a roughly-accurate
 *      global count. Cross-device merge = max(local, snapshot) per field.
 *   4. Limits themselves live in Supabase `profiles.quota_config` (JSONB),
 *      so adjusting a free-tier ASR cap is a one-row UPDATE in the
 *      dashboard. Falls back to the local `app_config` row, then to the
 *      hardcoded DEFAULT_QUOTA_CONFIG below.
 *
 * Storage (all in the existing `app_config` table — no new migration):
 *   - `quota_config`     : cached QuotaConfig (fallback when offline)
 *   - `quota_pro_state`  : { tier: 'free'|'pro', expiresAt: string|null,
 *                            updatedAt: number }
 *   - `quota_usage_YYYY-MM-DD` : { ai_rounds, asr, tts } (today's counters)
 *   - `quota_last_sync`  : { at: number, date: string } (60 s throttle marker)
 *   - `quota_pending_push`: usage payload waiting for next sync
 *
 * Native-only. The web stub returns unlimited quota (no consumption).
 */

import { AppState, Platform } from 'react-native';
import { supabase } from './supabase';

// ── Types ─────────────────────────────────────────────────────────────

export type QuotaField = 'ai_rounds' | 'asr' | 'tts' | 'asr_subtitle';
export type Tier = 'free' | 'pro';

export interface QuotaTierLimits {
  ai_rounds: { soft: number; hard: number };
  asr: { soft: number; hard: number };
  tts: { soft: number; hard: number };
  /** Video subtitle ASR, charged per minute of audio (rounded up). */
  asr_subtitle: { soft: number; hard: number };
}

export interface QuotaConfig {
  free: QuotaTierLimits;
  pro: QuotaTierLimits;
}

export interface QuotaUsage {
  ai_rounds: number;
  asr: number;
  tts: number;
  /** Minutes of subtitle ASR consumed today. */
  asr_subtitle: number;
}

export type ConsumeReason = 'ok' | 'soft' | 'hard';

export type ConsumeResult =
  | {
      allowed: true;
      reason: 'ok' | 'soft';
      used: number;
      soft: number;
      hard: number;
      field: QuotaField;
      tier: Tier;
    }
  | {
      allowed: false;
      reason: 'hard';
      used: number;
      soft: number;
      hard: number;
      field: QuotaField;
      tier: Tier;
    };

export interface ProState {
  tier: Tier;
  /** ISO string. null = no expiry. */
  expiresAt: string | null;
  updatedAt: number;
}

// ── Default config (last-resort fallback) ────────────────────────────

export const DEFAULT_QUOTA_CONFIG: QuotaConfig = {
  free: {
    ai_rounds: { soft: 10, hard: 30 },
    asr: { soft: 20, hard: 60 },
    tts: { soft: 50, hard: 150 },
    // Video subtitle generation: free users have no access.
    asr_subtitle: { soft: 0, hard: 0 },
  },
  pro: {
    ai_rounds: { soft: 200, hard: 1000 },
    asr: { soft: 500, hard: 2500 },
    tts: { soft: 2000, hard: 10000 },
    // 8h of audio per day; revisit after Volcengine bill lands.
    asr_subtitle: { soft: 120, hard: 480 },
  },
};

// ── Storage keys ─────────────────────────────────────────────────────

const KEY_CONFIG = 'quota_config';
const KEY_PRO_STATE = 'quota_pro_state';
const KEY_LAST_SYNC = 'quota_last_sync';
const KEY_PENDING_PUSH = 'quota_pending_push';

function usageKey(date: string): string {
  return `quota_usage_${date}`;
}

// ── app_config I/O ───────────────────────────────────────────────────

async function readConfigValue<T>(key: string): Promise<T | null> {
  const { ensureDatabaseInitialized, getDatabase } = await import('./database');
  await ensureDatabaseInitialized();
  const db = await getDatabase();
  const row: any = await db.getFirstAsync(
    'SELECT value_json FROM app_config WHERE key = ?',
    [key],
  );
  if (!row?.value_json) return null;
  try {
    return JSON.parse(row.value_json) as T;
  } catch {
    return null;
  }
}

async function writeConfigValue<T>(key: string, value: T): Promise<void> {
  const { ensureDatabaseInitialized, getDatabase } = await import('./database');
  await ensureDatabaseInitialized();
  const db = await getDatabase();
  await db.runAsync(
    `INSERT INTO app_config (key, value_json, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
    [key, JSON.stringify(value), Date.now()],
  );
}

// ── Date helpers ─────────────────────────────────────────────────────

function todayLocalDate(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// ── Pro state ────────────────────────────────────────────────────────

const DEFAULT_PRO_STATE: ProState = {
  tier: 'free',
  expiresAt: null,
  updatedAt: 0,
};

export async function getProState(): Promise<ProState> {
  if (Platform.OS === 'web') return { ...DEFAULT_PRO_STATE };
  const stored = await readConfigValue<ProState>(KEY_PRO_STATE);
  if (!stored) return { ...DEFAULT_PRO_STATE };
  // Defensive: if Pro is expired, treat as free.
  if (stored.tier === 'pro' && stored.expiresAt) {
    const exp = new Date(stored.expiresAt).getTime();
    if (Number.isFinite(exp) && exp <= Date.now()) {
      return { tier: 'free', expiresAt: null, updatedAt: stored.updatedAt };
    }
  }
  return stored;
}

export async function setProState(state: ProState): Promise<void> {
  await writeConfigValue(KEY_PRO_STATE, state);
}

export async function isProNow(): Promise<boolean> {
  const s = await getProState();
  return s.tier === 'pro' && (!s.expiresAt || new Date(s.expiresAt).getTime() > Date.now());
}

/**
 * True when the user has configured BYOK and the AI path will use
 * their own key. Callers (immersive page) skip the ai_rounds quota
 * charge in this case so a BYOK user can chat freely without
 * polluting their NativeOS daily counter.
 *
 * Re-exported from lib/byok so callers don't have to know the
 * storage details. Lazy-imported to keep the dependency graph
 * acyclic (byok.ts pulls in ./database).
 */
export async function isByokEnabled(): Promise<boolean> {
  if (Platform.OS === 'web') return false;
  try {
    const mod = await import('./byok');
    return mod.isByokEnabled();
  } catch {
    return false;
  }
}

// ── Quota config ─────────────────────────────────────────────────────

/**
 * Get the effective quota config. Tries, in order:
 *   1. in-memory cache (60 s)
 *   2. local app_config row
 *   3. Supabase profiles.quota_config (when logged in, fire-and-forget)
 *   4. DEFAULT_QUOTA_CONFIG
 *
 * If the Supabase pull succeeds, it overwrites the local cache so the
 * next call is offline-safe.
 */
let _configCache: { at: number; config: QuotaConfig } | null = null;
const CONFIG_CACHE_TTL_MS = 60_000;

/**
 * Forward-compat merge: take a possibly-stale snapshot and backfill any
 * fields that the current DEFAULT_QUOTA_CONFIG has but the snapshot
 * doesn't. Old cached snapshots predate schema additions (e.g.
 * `asr_subtitle`) and would crash callers that index into the new field.
 */
export function mergeQuotaConfig(local: Partial<QuotaConfig> | null | undefined): QuotaConfig {
  const free = (local as any)?.free ?? {};
  const pro = (local as any)?.pro ?? {};
  return {
    free: { ...DEFAULT_QUOTA_CONFIG.free, ...free },
    pro: { ...DEFAULT_QUOTA_CONFIG.pro, ...pro },
  };
}

export async function getQuotaConfig(): Promise<QuotaConfig> {
  if (Platform.OS === 'web') return DEFAULT_QUOTA_CONFIG;
  if (_configCache && Date.now() - _configCache.at < CONFIG_CACHE_TTL_MS) {
    return _configCache.config;
  }
  // 1. local
  const local = await readConfigValue<QuotaConfig>(KEY_CONFIG);
  if (local && local.free && local.pro) {
    // Forward-compat: backfill any fields added to DEFAULT_QUOTA_CONFIG
    // after this snapshot was written.
    const merged = mergeQuotaConfig(local);
    _configCache = { at: Date.now(), config: merged };
    // Persist the merged snapshot so the next read doesn't have to
    // re-merge, and so a Supabase refresh that fails still leaves us
    // with a complete record.
    if (JSON.stringify(merged) !== JSON.stringify(local)) {
      await writeConfigValue(KEY_CONFIG, merged);
    }
    // 2. try to refresh from Supabase (fire-and-forget)
    refreshQuotaConfigFromSupabase().catch(() => {});
    return merged;
  }
  // 3. fetch from Supabase now (best-effort)
  const remote = await fetchQuotaConfigFromSupabase();
  if (remote) {
    const mergedRemote = mergeQuotaConfig(remote);
    await writeConfigValue(KEY_CONFIG, mergedRemote);
    _configCache = { at: Date.now(), config: mergedRemote };
    return mergedRemote;
  }
  // 4. hardcode
  _configCache = { at: Date.now(), config: DEFAULT_QUOTA_CONFIG };
  return DEFAULT_QUOTA_CONFIG;
}

async function fetchQuotaConfigFromSupabase(): Promise<QuotaConfig | null> {
  if (!isSupabaseReady()) return null;
  try {
    const { data, error } = await supabase
      .from('profiles')
      .select('quota_config, is_pro, pro_expires_at')
      .maybeSingle();
    if (error || !data) return null;
    const cfg = (data as any).quota_config as QuotaConfig | null;
    if (cfg && cfg.free && cfg.pro) return cfg;
    return null;
  } catch {
    return null;
  }
}

/**
 * Force a Supabase → local refresh of the quota config. Call this on
 * login and on app foreground if the user is signed in.
 */
export async function refreshQuotaConfigFromSupabase(): Promise<QuotaConfig | null> {
  if (Platform.OS === 'web') return null;
  const remote = await fetchQuotaConfigFromSupabase();
  if (remote) {
    const mergedRemote = mergeQuotaConfig(remote);
    await writeConfigValue(KEY_CONFIG, mergedRemote);
    _configCache = { at: Date.now(), config: mergedRemote };
  }
  // Also refresh Pro state from the row in the same call.
  if (isSupabaseReady()) {
    try {
      const { data } = await supabase
        .from('profiles')
        .select('is_pro, pro_expires_at')
        .maybeSingle();
      if (data) {
        const isPro = Boolean((data as any).is_pro);
        const exp = (data as any).pro_expires_at as string | null;
        const active = isPro && (!exp || new Date(exp).getTime() > Date.now());
        await setProState({
          tier: active ? 'pro' : 'free',
          expiresAt: active ? exp : null,
          updatedAt: Date.now(),
        });
      }
    } catch {
      // ignore
    }
  }
  return remote;
}

function isSupabaseReady(): boolean {
  return Boolean((supabase as any)?.auth?.getSession);
}

// ── Daily usage ──────────────────────────────────────────────────────

export async function getTodayUsage(): Promise<QuotaUsage> {
  if (Platform.OS === 'web') return { ai_rounds: 0, asr: 0, tts: 0, asr_subtitle: 0 };
  const date = todayLocalDate();
  const stored = await readConfigValue<{ date: string; usage: QuotaUsage }>(usageKey(date));
  if (stored?.date === date && stored.usage) {
    // Defensive defaults for forward-compat: old snapshots from before
    // asr_subtitle existed will be missing the field. Treat as 0.
    return {
      ai_rounds: stored.usage.ai_rounds ?? 0,
      asr: stored.usage.asr ?? 0,
      tts: stored.usage.tts ?? 0,
      asr_subtitle: stored.usage.asr_subtitle ?? 0,
    };
  }
  return { ai_rounds: 0, asr: 0, tts: 0, asr_subtitle: 0 };
}

async function setTodayUsage(usage: QuotaUsage): Promise<void> {
  const date = todayLocalDate();
  await writeConfigValue(usageKey(date), { date, usage });
}

async function incrementUsage(field: QuotaField, amount: number): Promise<QuotaUsage> {
  const usage = await getTodayUsage();
  usage[field] += amount;
  await setTodayUsage(usage);
  return usage;
}

// ── Consume ──────────────────────────────────────────────────────────

/**
 * Consume one quota unit of the given field. Returns the verdict plus
 * the current usage snapshot so the caller can drive a soft indicator or
 * a hard-block dialog. Atomic local-first: if the hard limit is already
 * reached, no counter is mutated.
 */
export async function consumeQuota(field: QuotaField, amount = 1): Promise<ConsumeResult> {
  if (Platform.OS === 'web') {
    // Web has no quota enforcement (no app_config there). Return ok.
    return {
      allowed: true,
      reason: 'ok',
      used: 0,
      soft: Infinity,
      hard: Infinity,
      field,
      tier: 'free',
    };
  }
  const [tier, config, usage] = await Promise.all([
    getProState(),
    getQuotaConfig(),
    getTodayUsage(),
  ]);
  const tierName: Tier = tier.tier === 'pro' && (!tier.expiresAt || new Date(tier.expiresAt).getTime() > Date.now()) ? 'pro' : 'free';
  const limits = config[tierName][field];
  const used = usage[field];
  const projected = used + amount;

  if (projected > limits.hard) {
    // Hard: do NOT mutate counter, return blocked.
    return {
      allowed: false,
      reason: 'hard',
      used,
      soft: limits.soft,
      hard: limits.hard,
      field,
      tier: tierName,
    };
  }

  // Increment local counter first (so the rest of the UI sees the new value).
  await incrementUsage(field, amount);
  // Schedule a throttled push to Supabase. Fire-and-forget; the inner
  // helpers already catch their own errors.
  scheduleQuotaSync();

  return {
    allowed: true,
    reason: projected > limits.soft ? 'soft' : 'ok',
    used: projected,
    soft: limits.soft,
    hard: limits.hard,
    field,
    tier: tierName,
  };
}

// ── Soft indicator (in-memory "just crossed soft" pulse) ─────────────

type FieldKey = QuotaField;

const _softListeners = new Set<(field: FieldKey, used: number) => void>();
const _softCooldown = new Map<FieldKey, number>(); // last fired timestamp

/**
 * Register a listener for "this field just crossed the soft threshold"
 * events. The listener fires at most once per 30 s per field so we don't
 * spam the user mid-session.
 */
export function onSoftThresholdCrossed(cb: (field: FieldKey, used: number) => void): () => void {
  _softListeners.add(cb);
  return () => _softListeners.delete(cb);
}

function emitSoftThreshold(field: FieldKey, used: number): void {
  const last = _softCooldown.get(field) ?? 0;
  if (Date.now() - last < 30_000) return;
  _softCooldown.set(field, Date.now());
  _softListeners.forEach(cb => {
    try { cb(field, used); } catch { /* ignore */ }
  });
}

// Hook into consumeQuota: when the result is 'soft' AND we just crossed
// (i.e. used - amount was below soft), fire the listener. We do this
// inside consumeQuota by intercepting before the early-return for hard.

// (Implementation note: the soft-emit is done by wrapping consumeQuota
// below; or callers can use `consumeQuota` and then `emitSoftThreshold`
// if `result.reason === 'soft' && result.used - amount < result.soft`.)
//
// For minimal call-site noise we expose a higher-level helper:

export async function consumeAndNotify(
  field: QuotaField,
  amount = 1,
): Promise<ConsumeResult> {
  const before = await getTodayUsage();
  const result = await consumeQuota(field, amount);
  if (
    result.allowed &&
    result.reason === 'soft' &&
    before[field] < result.soft &&
    result.used >= result.soft
  ) {
    emitSoftThreshold(field, result.used);
  }
  return result;
}

// ── Supabase sync (throttled + background) ───────────────────────────

const SYNC_THROTTLE_MS = 60_000;
let _syncInFlight: Promise<void> | null = null;
let _syncScheduled = false;

export function scheduleQuotaSync(): void {
  if (_syncScheduled) return;
  _syncScheduled = true;
  // Coalesce: if a sync fires within the throttle window, just mark dirty.
  void throttledSync();
}

async function throttledSync(): Promise<void> {
  const last = await readConfigValue<{ at: number; date: string }>(KEY_LAST_SYNC);
  const today = todayLocalDate();
  const since =
    last && last.date === today ? Date.now() - last.at : Number.POSITIVE_INFINITY;
  if (since < SYNC_THROTTLE_MS) {
    // Within throttle window: stash a "pending" marker; the next forceSync
    // call (e.g. on app background) will flush.
    await writeConfigValue(KEY_PENDING_PUSH, { dirty: true, at: Date.now() });
    return;
  }
  await forceSyncQuota();
}

export async function forceSyncQuota(): Promise<void> {
  if (_syncInFlight) {
    return _syncInFlight;
  }
  _syncInFlight = (async () => {
    try {
      if (!isSupabaseReady()) return;
      const { data: sess } = await supabase.auth.getSession();
      if (!sess?.session?.user?.id) return; // anonymous: nothing to push

      const today = todayLocalDate();
      const usage = await getTodayUsage();
      const payload = {
        date: today,
        usage,
        // device id is implicit (Supabase picks up the auth user)
        updatedAt: new Date().toISOString(),
      };
      // Push to profiles.quota_snapshot via update on the row.
      const { error } = await supabase
        .from('profiles')
        .update({ quota_snapshot: payload })
        .eq('id', sess.session.user.id);
      if (error) {
        // Stash so next try picks it up.
        await writeConfigValue(KEY_PENDING_PUSH, { dirty: true, at: Date.now() });
        return;
      }
      await writeConfigValue(KEY_LAST_SYNC, { at: Date.now(), date: today });
      await writeConfigValue(KEY_PENDING_PUSH, { dirty: false, at: Date.now() });
    } catch {
      await writeConfigValue(KEY_PENDING_PUSH, { dirty: true, at: Date.now() });
    } finally {
      _syncInFlight = null;
      _syncScheduled = false;
    }
  })();
  return _syncInFlight;
}

/**
 * On login: pull the server snapshot for the *most recent* date and
 * merge with local by taking the per-field max. Then re-flush local.
 * This is the "user reinstalled" recovery path.
 */
export async function mergeQuotaSnapshotOnLogin(): Promise<void> {
  if (!isSupabaseReady()) return;
  try {
    const { data: sess } = await supabase.auth.getSession();
    if (!sess?.session?.user?.id) return;
    const { data, error } = await supabase
      .from('profiles')
      .select('quota_snapshot')
      .eq('id', sess.session.user.id)
      .maybeSingle();
    if (error || !data) return;
    const snap = (data as any).quota_snapshot as
      | { date: string; usage: QuotaUsage; updatedAt: string }
      | null;
    if (!snap || !snap.usage) return;
    if (snap.date !== todayLocalDate()) {
      // Snapshot is from a previous day — ignore, today is fresh.
      return;
    }
    const local = await getTodayUsage();
    const merged: QuotaUsage = {
      ai_rounds: Math.max(local.ai_rounds, snap.usage.ai_rounds ?? 0),
      asr: Math.max(local.asr, snap.usage.asr ?? 0),
      tts: Math.max(local.tts, snap.usage.tts ?? 0),
      asr_subtitle: Math.max(local.asr_subtitle, snap.usage.asr_subtitle ?? 0),
    };
    if (
      merged.ai_rounds !== local.ai_rounds ||
      merged.asr !== local.asr ||
      merged.tts !== local.tts ||
      merged.asr_subtitle !== local.asr_subtitle
    ) {
      await setTodayUsage(merged);
    }
    // Now re-flush the merged value so the server sees the same.
    await forceSyncQuota();
  } catch {
    // best-effort
  }
}

// ── Background sync wiring ──────────────────────────────────────────

let _appStateSubInstalled = false;

/**
 * Install the AppState listener that flushes pending quota to Supabase
 * when the app backgrounds. Idempotent — safe to call multiple times.
 */
export function installQuotaBackgroundSync(): void {
  if (_appStateSubInstalled) return;
  _appStateSubInstalled = true;
  AppState.addEventListener('change', (state) => {
    if (state === 'background' || state === 'inactive') {
      void forceSyncQuota();
    }
  });
}

// ── Label helpers (for UI) ───────────────────────────────────────────

const FIELD_LABEL: Record<QuotaField, string> = {
  ai_rounds: 'AI 对话',
  asr: '语音识别',
  tts: '语音朗读',
  asr_subtitle: '视频字幕',
};

export function quotaFieldLabel(field: QuotaField): string {
  return FIELD_LABEL[field];
}

export function quotaFieldUnit(field: QuotaField): string {
  // For display only — short mic ASR / TTS / AI are "次", subtitle ASR
  // is "分钟" (rounded up). The caller should special-case subtitle.
  return '次';
}

/**
 * Pre-flight check for subtitle generation. Returns whether the user can
 * start a subtitle run for a video of `expectedMinutes` minutes, and if
 * not — why. Does NOT mutate any counter; the actual charge happens on
 * success via `consumeQuota('asr_subtitle', actualMinutes)`.
 *
 * - 'pro_required' : user is on free tier; no quota exists.
 * - 'hard'        : Pro user, but the projection would exceed the hard cap.
 * - 'ok' / 'soft' : Pro user, allowed. `soft` means this run will push
 *                    the user past the soft warning threshold.
 */
export type SubtitleQuotaCheck =
  | {
      allowed: true;
      reason: 'ok' | 'soft';
      tier: 'pro';
      minutesAvailable: number;
      minutesNeeded: number;
      soft: number;
      hard: number;
    }
  | {
      allowed: false;
      reason: 'pro_required' | 'hard';
      tier: 'free' | 'pro';
      minutesAvailable: number;
      minutesNeeded: number;
      soft: number;
      hard: number;
    };

/**
 * Round audio duration up to whole minutes. 30s → 1, 60s → 1, 61s → 2.
 * This is the billable unit; a 1-second video still costs 1 minute.
 */
export function minutesForAudioSeconds(durationSeconds: number | null | undefined): number {
  if (typeof durationSeconds !== 'number' || !Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    return 1; // Minimum billable unit when we don't know the length.
  }
  return Math.max(1, Math.ceil(durationSeconds / 60));
}

export async function checkSubtitleQuota(
  expectedMinutes: number,
): Promise<SubtitleQuotaCheck> {
  const minutesNeeded = Math.max(1, Math.ceil(expectedMinutes));
  if (Platform.OS === 'web') {
    // Web has no enforcement; allow (mirrors consumeQuota web behavior).
    return {
      allowed: true,
      reason: 'ok',
      tier: 'pro',
      minutesAvailable: Number.POSITIVE_INFINITY,
      minutesNeeded,
      soft: Number.POSITIVE_INFINITY,
      hard: Number.POSITIVE_INFINITY,
    };
  }
  const [tier, config, usage] = await Promise.all([
    getProState(),
    getQuotaConfig(),
    getTodayUsage(),
  ]);
  const tierName: Tier =
    tier.tier === 'pro' && (!tier.expiresAt || new Date(tier.expiresAt).getTime() > Date.now())
      ? 'pro'
      : 'free';
  const limits = config[tierName].asr_subtitle;
  const minutesAvailable = Math.max(0, limits.hard - usage.asr_subtitle);

  if (tierName !== 'pro') {
    return {
      allowed: false,
      reason: 'pro_required',
      tier: 'free',
      minutesAvailable,
      minutesNeeded,
      soft: limits.soft,
      hard: limits.hard,
    };
  }
  if (minutesAvailable < minutesNeeded) {
    return {
      allowed: false,
      reason: 'hard',
      tier: 'pro',
      minutesAvailable,
      minutesNeeded,
      soft: limits.soft,
      hard: limits.hard,
    };
  }
  const projected = usage.asr_subtitle + minutesNeeded;
  return {
    allowed: true,
    reason: projected > limits.soft ? 'soft' : 'ok',
    tier: 'pro',
    minutesAvailable,
    minutesNeeded,
    soft: limits.soft,
    hard: limits.hard,
  };
}

// ── Pro redemption ──────────────────────────────────────────────────

/**
 * Redeem a Pro code. Atomic via RLS-protected UPDATE on pro_codes:
 * only rows where used_by IS NULL AND expires_at > now() can be flipped,
 * and the CHECK constraint forces used_by to equal auth.uid().
 *
 * On success, extends the user's pro_expires_at (or sets it from now if
 * currently free) and refreshes local state.
 */
export interface RedeemResult {
  ok: boolean;
  /** If ok=false, a human-readable reason for the UI. */
  reason?: 'invalid' | 'expired' | 'used' | 'not_signed_in' | 'error';
  /** New expiry ISO string on success. */
  newExpiresAt?: string;
  durationDays?: number;
}

export async function redeemProCode(rawCode: string): Promise<RedeemResult> {
  if (Platform.OS === 'web') return { ok: false, reason: 'error' };
  if (!isSupabaseReady()) return { ok: false, reason: 'not_signed_in' };
  const { data: sess } = await supabase.auth.getSession();
  const uid = sess?.session?.user?.id;
  if (!uid) return { ok: false, reason: 'not_signed_in' };

  const code = rawCode.trim().toUpperCase();
  if (!code) return { ok: false, reason: 'invalid' };

  try {
    // Single atomic RPC call. The function runs as SECURITY DEFINER
    // and does its own auth/used/expiry checks with a row lock, so we
    // don't need to dance around the pro_codes SELECT RLS policy
    // (which correctly hides unused codes from the client).
    const { data, error } = await supabase.rpc('redeem_pro_code', {
      code_text: code,
    });
    if (error) {
      console.warn('[quota] redeem RPC failed', error.message);
      return { ok: false, reason: 'error' };
    }
    // supabase-js returns a single-row array for RETURNS TABLE; older
    // versions may return a single object. Normalize.
    const row: any = Array.isArray(data) ? data[0] : data;
    if (!row) {
      return { ok: false, reason: 'error' };
    }
    if (!row.ok) {
      const reason = (row.reason as RedeemResult['reason']) ?? 'error';
      return { ok: false, reason };
    }
    const newExpiresAt = row.new_expires_at as string;
    const durationDays = Number(row.duration_days) || 30;
    await setProState({ tier: 'pro', expiresAt: newExpiresAt, updatedAt: Date.now() });
    return { ok: true, newExpiresAt, durationDays };
  } catch (e) {
    console.warn('[quota] redeem RPC threw', e);
    return { ok: false, reason: 'error' };
  }
}

// ── Reset (test helper, not exported in production code) ─────────────

/**
 * Wipe all quota state. Useful for QA. NOT exported in the public surface
 * to avoid accidental misuse; the auth flow can call it explicitly if
 * the user logs out and we want a clean slate on a new device.
 */
export async function _resetAllQuotaState(): Promise<void> {
  if (Platform.OS === 'web') return;
  const { ensureDatabaseInitialized, getDatabase } = await import('./database');
  await ensureDatabaseInitialized();
  const db = await getDatabase();
  await db.runAsync(
    `DELETE FROM app_config WHERE key IN (?, ?, ?, ?) OR key LIKE 'quota_usage_%'`,
    [KEY_CONFIG, KEY_PRO_STATE, KEY_LAST_SYNC, KEY_PENDING_PUSH],
  );
  _configCache = null;
  _syncScheduled = false;
}
