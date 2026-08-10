/**
 * Session Manager — Sandbox State Machine
 *
 * Lifecycle:
 *   enterSandbox()    → creates session (status=active), returns sessionId
 *   recordTurn()      → appends turn to transcript
 *   exitSandbox()     → marks session completed
 *
 * Card extraction is manual only — user triggers OmniCaptureSheet to add cards to FSRS.
 */

import { createSession, appendTurn, completeSession } from './sessions';
import type { Turn } from './sessions';

let _currentSessionId: string | null = null;

/**
 * Call when user enters a sandbox scenario.
 * Persists a new active session and caches the id in memory.
 */
export async function enterSandbox(
  scenarioId: string,
  scenarioTitle: string,
): Promise<string> {
  try {
    const session = await createSession(scenarioId, scenarioTitle);
    _currentSessionId = session.session_id;
    return session.session_id;
  } catch (e) {
    console.warn('[SessionManager] enterSandbox failed:', e);
    // Return a temp id so the sandbox still works even if persistence fails
    _currentSessionId = `tmp-${Date.now()}`;
    return _currentSessionId;
  }
}

/**
 * Call after every message exchange (both NPC and user turns).
 */
export async function recordTurn(
  sessionId: string,
  turn: Omit<Turn, 'ts'>,
): Promise<void> {
  try {
    await appendTurn(sessionId, turn);
  } catch (e) {
    console.warn('[SessionManager] recordTurn failed:', e);
  }
}

/**
 * Call when user exits (back button) or achieves the scenario goal.
 * Marks session completed. Card extraction is manual via OmniCaptureSheet.
 */
export async function exitSandbox(sessionId: string): Promise<void> {
  try {
    await completeSession(sessionId);
  } catch (e) {
    console.warn('[SessionManager] exitSandbox failed:', e);
  } finally {
    if (_currentSessionId === sessionId) {
      _currentSessionId = null;
    }
  }
}

/**
 * Convenience getter for the active session id.
 */
export function getCurrentSessionId(): string | null {
  return _currentSessionId;
}
