/**
 * In-memory ring buffer for the app's own console.* output.
 *
 * Purpose: when an internal user hits a bug, they can pull the last
 * 500 lines of the app's own trace logs into a feedback bundle (see
 * ./feedback.ts). NO third-party log capture, NO logcat — just the
 * console.log/warn/error calls we already have everywhere with
 * `[AiPracticeHub]` / `[UserPickedSeries]` / etc. prefixes.
 *
 * Lifetime: in-memory only, dies with the JS context. We don't
 * persist to disk because (a) the user can re-trigger the bug, and
 * (b) feedback bundles are deliberately short-lived — share once,
 * forget.
 *
 * Design notes:
 *  - We override console once at install. installLogStore() is
 *    idempotent so re-init in dev hot-reload is safe.
 *  - Stringification is best-effort: errors get stack, objects get
 *    JSON.stringify with circular-ref fallback to String(arg).
 *  - We DO call the original console.* so logcat / Metro / browser
 *    devtools still see the same output. This module is purely
 *    additive.
 */

const MAX_ENTRIES = 500;

export type LogLevel = 'log' | 'warn' | 'error';

export interface LogEntry {
  ts: number;
  level: LogLevel;
  msg: string;
}

const buffer: LogEntry[] = [];

let installed = false;
let origLog: typeof console.log | null = null;
let origWarn: typeof console.warn | null = null;
let origError: typeof console.error | null = null;

function stringifyArg(a: unknown): string {
  if (a == null) return String(a);
  if (typeof a === 'string') return a;
  if (typeof a === 'number' || typeof a === 'boolean' || typeof a === 'bigint') return String(a);
  if (a instanceof Error) {
    const stack = a.stack ? `\n${a.stack}` : '';
    return `${a.message || '(no message)'}${stack}`;
  }
  try {
    return JSON.stringify(a);
  } catch {
    // circular refs etc.
    try {
      return String(a);
    } catch {
      return '[unstringifiable]';
    }
  }
}

function push(level: LogLevel, args: unknown[]): void {
  let msg: string;
  try {
    msg = args.map(stringifyArg).join(' ');
  } catch {
    msg = '[log stringification failed]';
  }
  // Defensive cap: trim in case MAX_ENTRIES is wrong.
  if (msg.length > 8192) msg = `${msg.slice(0, 8192)}...[truncated]`;
  buffer.push({ ts: Date.now(), level, msg });
  if (buffer.length > MAX_ENTRIES) {
    buffer.splice(0, buffer.length - MAX_ENTRIES);
  }
}

/**
 * Install the console overrides. Idempotent — second call is a no-op
 * so dev hot-reload + tests can call it freely.
 */
export function installLogStore(): void {
  if (installed) return;
  installed = true;

  // Bind to current console methods.
  origLog = console.log.bind(console);
  origWarn = console.warn.bind(console);
  origError = console.error.bind(console);

  console.log = (...args: unknown[]): void => {
    push('log', args);
    origLog!(...args);
  };
  console.warn = (...args: unknown[]): void => {
    push('warn', args);
    origWarn!(...args);
  };
  console.error = (...args: unknown[]): void => {
    push('error', args);
    origError!(...args);
  };
}

/**
 * Snapshot the current buffer. Returns a defensive copy so the caller
 * can iterate without worrying about new entries arriving mid-format.
 */
export function getRecentLogs(): readonly LogEntry[] {
  return buffer.slice();
}

/** Wipe the buffer. Useful from the feedback form's "清空旧日志" button. */
export function clearLogs(): void {
  buffer.length = 0;
}

/** For diagnostics / dev tools. */
export function getLogBufferSize(): number {
  return buffer.length;
}
