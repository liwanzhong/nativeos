/**
 * Re-export of the SQLite-backed chat sessions module.
 *
 * Historical: this file used to wrap a single AsyncStorage JSON array
 * (`chat_sessions`) which meant every appendTurn() rewrote the whole
 * array. As of schema v3 the data lives in chat_sessions + chat_turns
 * (see docs/2026-08-05-storage-migration-plan.md) — appendTurn() is
 * now a single-row INSERT.
 */

export {
  appendTurn,
  completeSession,
  createSession,
  getCompletedSessions,
  getSession,
} from '../database/chat-sessions';

export type { ChatSession, Turn } from '../database/chat-sessions';
