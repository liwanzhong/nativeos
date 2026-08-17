/**
 * App-state snapshot for the feedback bundle.
 *
 * Collects everything an engineer needs to triage a bug without
 * asking the user 20 questions: device, app version, current route,
 * login state, SQLite schema version, AI practice card cache state,
 * and the last N log lines.
 *
 * All fields are best-effort — every getter is wrapped in try/catch
 * so a failure in one collector doesn't kill the whole snapshot.
 */

import { Platform, NativeModules } from 'react-native';
import Constants from 'expo-constants';
import * as Application from 'expo-application';
import * as Device from 'expo-device';
import { getRecentLogs, type LogEntry } from './logStore';
import { getLatestAiCardsFetchedAt } from '../database/official-ai-practice-cache';
import { getSchemaVersion } from '../database/schema';
import { supabase } from '../supabase';

const SESSION_ID_KEY = '__diagnosticsSessionId';

export interface FeedbackSnapshot {
  generatedAt: string; // ISO 8601, local TZ offset
  sessionId: string;
  user: {
    isSignedIn: boolean;
    userId: string | null;
    userEmail: string | null;
  };
  app: {
    expoVersion: string | null;
    appVersion: string | null;
    buildVersion: string | null;
    nativeAppVersion: string | null;
    nativeBuildVersion: string | null;
    scheme: string | null;
    runtimeVersion: string | null;
  };
  device: {
    platform: typeof Platform.OS;
    osVersion: string | null;
    sdkVersion: number | null;
    modelName: string | null;
    manufacturer: string | null;
    brand: string | null;
    isDevice: boolean;
    locale: string;
    timezone: string;
    totalMemoryMb: number | null;
  };
  appState: {
    schemaVersion: number | null;
    aiCardsCacheFetchedAt: number | null;
    aiCardsCacheAgeSec: number | null;
  };
  logs: LogEntry[];
}

function getSessionId(): string {
  // Per-process, per-launch ID. We don't persist this across launches
  // because each bug report should be self-contained.
  const g = globalThis as unknown as Record<string, string | undefined>;
  if (!g[SESSION_ID_KEY]) {
    const ts = Date.now().toString(36);
    const rnd = Math.random().toString(36).slice(2, 8);
    g[SESSION_ID_KEY] = `${ts}-${rnd}`;
  }
  return g[SESSION_ID_KEY]!;
}

function formatTimestamp(ms: number): string {
  // Local ISO-ish: 2026-08-17T14:30:22+08:00
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  const tzOffset = -d.getTimezoneOffset();
  const tzSign = tzOffset >= 0 ? '+' : '-';
  const tzH = pad(Math.floor(Math.abs(tzOffset) / 60));
  const tzM = pad(Math.abs(tzOffset) % 60);
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
    `${tzSign}${tzH}:${tzM}`
  );
}

async function safeCall<T>(label: string, fn: () => Promise<T> | T, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    // Don't recurse through console.error (which would loop into our
    // own log buffer) — use the original console method captured at
    // install time.
    const origErr = (console as unknown as { error: (...a: unknown[]) => void }).error;
    origErr?.(`[diagnostics] ${label} failed:`, e instanceof Error ? e.message : String(e));
    return fallback;
  }
}

export async function collectSnapshot(): Promise<FeedbackSnapshot> {
  // Best-effort Supabase user check. We don't await long — if it
  // hangs the snapshot still goes out, just with isSignedIn=false.
  const userInfo = await safeCall<{ isSignedIn: boolean; userId: string | null; userEmail: string | null }>(
    'supabase.user',
    async () => {
      // Hard timeout: don't let a slow network stall feedback.
      const result = await Promise.race([
        supabase.auth.getUser(),
        new Promise<{ data: { user: null }; error: { message: string } }>((resolve) =>
          setTimeout(() => resolve({ data: { user: null }, error: { message: 'timeout' } }), 1500),
        ),
      ]);
      const u = (result as { data: { user: { id: string; email?: string | null } | null } }).data?.user;
      return {
        isSignedIn: !!u,
        userId: u?.id ?? null,
        userEmail: u?.email ?? null,
      };
    },
    { isSignedIn: false, userId: null, userEmail: null },
  );

  const appBlock = await safeCall('expo.application', () => {
    const expoCfg = Constants.expoConfig;
    // expo-constants types `scheme` as `string | string[]` because some
    // configs declare multiple schemes; we only ever ship one, coerce
    // to a scalar.
    const rawScheme = expoCfg?.scheme;
    const scheme = typeof rawScheme === 'string'
      ? rawScheme
      : Array.isArray(rawScheme)
        ? rawScheme[0] ?? null
        : null;
    // runtimeVersion in newer expo can be `string | { version: string } | null`
    const rawRuntime = expoCfg?.runtimeVersion as unknown;
    const runtimeVersion = typeof rawRuntime === 'string'
      ? rawRuntime
      : rawRuntime && typeof rawRuntime === 'object' && 'version' in rawRuntime
        ? String((rawRuntime as { version: unknown }).version ?? '')
        : null;
    return {
      expoVersion: Constants.expoVersion ?? null,
      appVersion: expoCfg?.version ?? null,
      buildVersion: expoCfg?.android?.versionCode?.toString() ?? expoCfg?.ios?.buildNumber ?? null,
      nativeAppVersion: Application.nativeApplicationVersion ?? null,
      nativeBuildVersion: Application.nativeBuildVersion ?? null,
      scheme,
      runtimeVersion,
    };
  }, {
    expoVersion: null, appVersion: null, buildVersion: null,
    nativeAppVersion: null, nativeBuildVersion: null, scheme: null, runtimeVersion: null,
  });

  const deviceBlock = await safeCall('expo.device', () => ({
    platform: Platform.OS,
    osVersion: Device.osVersion ?? null,
    sdkVersion: Device.platformApiLevel ?? null,
    modelName: Device.modelName ?? null,
    manufacturer: Device.manufacturer ?? null,
    brand: Device.brand ?? null,
    isDevice: Device.isDevice,
    locale: `${Intl.DateTimeFormat().resolvedOptions().locale ?? 'unknown'}`,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'unknown',
    totalMemoryMb: Device.totalMemory != null ? Math.round(Device.totalMemory / 1024 / 1024) : null,
  }), {
    platform: Platform.OS,
    osVersion: String(Platform.Version ?? ''),
    sdkVersion: typeof Platform.Version === 'number' ? Platform.Version : null,
    modelName: null, manufacturer: null, brand: null,
    isDevice: true, // we don't know but assume real device; better than null
    locale: 'unknown', timezone: 'unknown', totalMemoryMb: null,
  });

  // SQLite + AI cards cache state. Both are fast local reads.
  const schemaVersion = await safeCall('db.schemaVersion', () => getSchemaVersion(), null as number | null);
  const aiCardsCacheFetchedAt = await safeCall(
    'aiCards.fetchedAt',
    () => getLatestAiCardsFetchedAt(),
    null as number | null,
  );
  const aiCardsCacheAgeSec = aiCardsCacheFetchedAt != null
    ? Math.round((Date.now() - aiCardsCacheFetchedAt) / 1000)
    : null;

  return {
    generatedAt: formatTimestamp(Date.now()),
    sessionId: getSessionId(),
    user: userInfo,
    app: appBlock,
    device: deviceBlock,
    appState: {
      schemaVersion,
      aiCardsCacheFetchedAt,
      aiCardsCacheAgeSec,
    },
    logs: getRecentLogs().slice(),
  };
}

// Re-export the native module probe so the form page can show
// "share module not registered" inline if needed.
export function isNativeShareModuleAvailable(): boolean {
  return !!NativeModules.NativeChooser;
}
