/**
 * Generate a text feedback bundle, write it to the app's document
 * directory, and hand it off to the system share sheet.
 *
 * Flow:
 *   user fills form → submitFeedback(payload)
 *     → collectSnapshot() (device, app, route, schema, cache, logs)
 *     → render .txt
 *     → write to documentDirectory/feedback/<timestamp>.txt
 *     → share via NativeChooser (same channel as backup.zip sharing)
 *
 * The file is text-only by design (user said "导出为文本的形式").
 * No screenshots, no zip, no json — keeps it trivially copy-pasteable
 * into a Lark/IM message and human-skimmable.
 */

import { NativeModules, Platform } from 'react-native';
import { writeAsStringAsync, getInfoAsync, getContentUriAsync, documentDirectory } from 'expo-file-system/legacy';
import { collectSnapshot, type FeedbackSnapshot } from './snapshot';
import { clearLogs } from './logStore';

export type FeedbackCategory =
  | 'subtitle'
  | 'video'
  | 'ai_practice'
  | 'collection'
  | 'performance'
  | 'other';

export const FEEDBACK_CATEGORIES: ReadonlyArray<{ value: FeedbackCategory; label: string }> = [
  { value: 'subtitle', label: '字幕' },
  { value: 'video', label: '视频播放' },
  { value: 'ai_practice', label: 'AI 陪练' },
  { value: 'collection', label: '合集' },
  { value: 'performance', label: '性能/卡顿' },
  { value: 'other', label: '其他' },
];

export type FeedbackSeverity = 'crash' | 'blocker' | 'minor';

export const FEEDBACK_SEVERITIES: ReadonlyArray<{ value: FeedbackSeverity; label: string; desc: string }> = [
  { value: 'crash', label: '崩溃', desc: 'app 闪退 / 白屏' },
  { value: 'blocker', label: '用不了', desc: '核心功能不可用' },
  { value: 'minor', label: '小问题', desc: '能用但有问题' },
];

export interface FeedbackPayload {
  description: string; // user-typed, required
  category: FeedbackCategory;
  severity: FeedbackSeverity;
  clearLogsAfter: boolean; // wipe the ring buffer after submit
}

export interface SubmitResult {
  outcome: 'shared' | 'dismissed' | 'error' | 'no_native_module';
  message?: string;
  /** Internal file path — useful when share fails and the user wants to adb-pull. */
  internalPath?: string;
}

const FEEDBACK_DIR = 'feedback';
const CHOOSER_TITLE = 'NativeOS 反馈';

interface NativeChooser {
  open(contentUri: string, mimeType: string, title: string): Promise<void>;
}

const NativeChooserModule: NativeChooser | undefined = (NativeModules as Record<string, unknown>)
  .NativeChooser as NativeChooser | undefined;

function severityLabel(v: FeedbackSeverity): string {
  return FEEDBACK_SEVERITIES.find((s) => s.value === v)?.label ?? v;
}

function categoryLabel(v: FeedbackCategory): string {
  return FEEDBACK_CATEGORIES.find((c) => c.value === v)?.label ?? v;
}

function formatAppState(s: FeedbackSnapshot): string {
  const lines: string[] = [];
  lines.push(`SQLite schema: ${s.appState.schemaVersion ?? '未知'}`);
  if (s.appState.aiCardsCacheFetchedAt != null) {
    const ageMin = Math.round((s.appState.aiCardsCacheAgeSec ?? 0) / 60);
    lines.push(
      `AI 陪练 cache: ${new Date(s.appState.aiCardsCacheFetchedAt).toISOString()} (${ageMin} 分钟前)`,
    );
  } else {
    lines.push('AI 陪练 cache: 空');
  }
  return lines.join('\n');
}

function formatLogLine(e: FeedbackSnapshot['logs'][number]): string {
  const d = new Date(e.ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  const ms = String(d.getMilliseconds()).padStart(3, '0');
  const ts =
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    ` ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${ms}`;
  return `${ts} [${e.level.toUpperCase()}] ${e.msg}`;
}

export function renderFeedbackText(payload: FeedbackPayload, snap: FeedbackSnapshot): string {
  const sections: string[] = [];

  sections.push('=== NativeOS 反馈报告 ===');
  sections.push(`时间: ${snap.generatedAt}`);
  sections.push(`Session: ${snap.sessionId}`);
  sections.push(`用户: ${snap.user.isSignedIn ? snap.user.userEmail ?? snap.user.userId : 'anonymous'}`);
  sections.push(
    `应用版本: ${snap.app.appVersion ?? '?'} (build ${snap.app.buildVersion ?? '?'})`,
  );
  sections.push(`Platform: ${snap.device.platform} ${snap.device.osVersion ?? ''}`.trim());

  sections.push('');
  sections.push('=== 类别 / 严重度 ===');
  sections.push(`类别: ${categoryLabel(payload.category)}`);
  sections.push(`严重度: ${severityLabel(payload.severity)}`);

  sections.push('');
  sections.push('=== 用户描述 ===');
  sections.push(payload.description.trim() || '(未填写)');

  sections.push('');
  sections.push('=== 设备信息 ===');
  sections.push(`Platform: ${snap.device.platform}`);
  sections.push(`OS: ${snap.device.osVersion ?? '?'}${snap.device.sdkVersion ? ` (SDK ${snap.device.sdkVersion})` : ''}`);
  sections.push(`Model: ${snap.device.manufacturer ?? ''} ${snap.device.brand ?? ''} ${snap.device.modelName ?? ''}`.trim());
  sections.push(`Is device: ${snap.device.isDevice}`);
  sections.push(`Locale: ${snap.device.locale}`);
  sections.push(`Timezone: ${snap.device.timezone}`);
  if (snap.device.totalMemoryMb != null) {
    sections.push(`Total memory: ${snap.device.totalMemoryMb} MB`);
  }

  sections.push('');
  sections.push('=== App 信息 ===');
  sections.push(`Version: ${snap.app.appVersion ?? '?'}`);
  sections.push(`Build: ${snap.app.buildVersion ?? '?'}`);
  sections.push(`Native version: ${snap.app.nativeAppVersion ?? '?'} (${snap.app.nativeBuildVersion ?? '?'})`);
  sections.push(`Expo SDK: ${snap.app.expoVersion ?? '?'}`);
  sections.push(`Runtime version: ${snap.app.runtimeVersion ?? '?'}`);
  sections.push(`Scheme: ${snap.app.scheme ?? '?'}`);

  sections.push('');
  sections.push('=== App 状态 ===');
  sections.push(formatAppState(snap));

  sections.push('');
  sections.push(`=== 最近日志 (${snap.logs.length} 条) ===`);
  if (snap.logs.length === 0) {
    sections.push('(无日志)');
  } else {
    for (const e of snap.logs) {
      sections.push(formatLogLine(e));
    }
  }

  sections.push('');
  sections.push('--- end of report ---');
  return sections.join('\n');
}

function buildFileName(snap: FeedbackSnapshot): string {
  // e.g. feedback-20260817-143022-20260817-xxx.txt
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp =
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  return `feedback-${stamp}-${snap.sessionId}.txt`;
}

async function writeFeedbackFile(text: string, fileName: string): Promise<string> {
  // documentDirectory on RN is the per-app writable sandbox. The
  // legacy `documentDirectory` export from expo-file-system is a URL-
  // like string ending in `/`.
  const dir = `${documentDirectory ?? ''}${FEEDBACK_DIR}`;
  const path = `${dir}/${fileName}`;
  // Ensure dir exists — writeAsStringAsync creates intermediate dirs
  // on some platforms but not all. mkdirp via legacy.
  const dirInfo = await getInfoAsync(dir);
  if (!dirInfo.exists) {
    const { makeDirectoryAsync } = await import('expo-file-system/legacy');
    await makeDirectoryAsync(dir, { intermediates: true });
  }
  await writeAsStringAsync(path, text, { encoding: 'utf8' });
  return path;
}

export async function submitFeedback(payload: FeedbackPayload): Promise<SubmitResult> {
  if (Platform.OS === 'web') {
    return { outcome: 'error', message: '反馈功能仅在原生端可用' };
  }
  if (!payload.description.trim()) {
    return { outcome: 'error', message: '请先填写问题描述' };
  }
  if (!NativeChooserModule) {
    return {
      outcome: 'no_native_module',
      message: 'NativeChooser 模块未注册。请检查 MainApplication.kt 是否添加了 ChooserPackage。',
    };
  }

  let snap: FeedbackSnapshot;
  try {
    snap = await collectSnapshot();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { outcome: 'error', message: `生成快照失败：${msg}` };
  }

  const text = renderFeedbackText(payload, snap);
  const fileName = buildFileName(snap);

  let path: string;
  try {
    path = await writeFeedbackFile(text, fileName);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { outcome: 'error', message: `写入文件失败：${msg}` };
  }

  let contentUri: string;
  try {
    contentUri = await getContentUriAsync(path);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      outcome: 'error',
      internalPath: path,
      message: `准备分享失败：${msg}`,
    };
  }

  try {
    await NativeChooserModule.open(contentUri, 'text/plain', CHOOSER_TITLE);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      outcome: 'error',
      internalPath: path,
      message: `调起分享失败：${msg}`,
    };
  }

  if (payload.clearLogsAfter) {
    clearLogs();
  }

  // NativeChooser.open() resolves immediately after startActivity — we
  // don't know whether the user actually shared or dismissed. Treat
  // every successful open as "shared" from the JS side; the user
  // gets to see the chooser and decide.
  return { outcome: 'shared', internalPath: path };
}
