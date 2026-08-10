/**
 * Chat sessions — SQLite-backed (v3).
 *
 * Source of truth: chat_sessions + chat_turns tables.
 * Replaces the legacy `chat_sessions` AsyncStorage JSON array.
 *
 * appendTurn() is now O(1) (single INSERT) instead of rewriting the
 * whole sessions array.
 *
 * See docs/2026-08-05-storage-migration-plan.md.
 */

import { getDatabase } from './schema';

export interface Turn {
  role: 'npc' | 'user';
  text: string;
  ts: number;
}

export interface ChatSession {
  session_id: string;
  user_id: string;
  scenario_id: string;
  scenario_title: string;
  status: 'active' | 'completed';
  transcript: Turn[];
  created_at: number;
  completed_at: number | null;
}

function uuid(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function rowToSession(row: any, turns: Turn[]): ChatSession {
  return {
    session_id: row.session_id,
    user_id: row.user_id,
    scenario_id: row.scenario_id,
    scenario_title: row.scenario_title,
    status: row.status,
    transcript: turns,
    created_at: row.created_at,
    completed_at: row.completed_at,
  };
}

async function getTurnsForSession(sessionId: string): Promise<Turn[]> {
  const db = await getDatabase();
  const rows: any[] = await db.getAllAsync(
    'SELECT role, text, ts FROM chat_turns WHERE session_id = ? ORDER BY turn_seq ASC',
    [sessionId],
  );
  return rows.map((row) => ({
    role: row.role === 'npc' ? 'npc' : 'user',
    text: row.text,
    ts: row.ts,
  }));
}

export async function createSession(
  scenarioId: string,
  scenarioTitle: string,
  userId = 'local',
): Promise<ChatSession> {
  const session: ChatSession = {
    session_id: uuid(),
    user_id: userId,
    scenario_id: scenarioId,
    scenario_title: scenarioTitle,
    status: 'active',
    transcript: [],
    created_at: Date.now(),
    completed_at: null,
  };
  const db = await getDatabase();
  await db.runAsync(
    `INSERT INTO chat_sessions (
      session_id, user_id, scenario_id, scenario_title, status, created_at, completed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      session.session_id, session.user_id, session.scenario_id, session.scenario_title,
      session.status, session.created_at, session.completed_at,
    ],
  );
  return session;
}

export async function appendTurn(
  sessionId: string,
  turn: Omit<Turn, 'ts'>,
): Promise<void> {
  const db = await getDatabase();
  const row: any = await db.getFirstAsync(
    'SELECT COALESCE(MAX(turn_seq), -1) AS max_seq FROM chat_turns WHERE session_id = ?',
    [sessionId],
  );
  const nextSeq = (row?.max_seq ?? -1) + 1;
  await db.runAsync(
    'INSERT INTO chat_turns (session_id, turn_seq, role, text, ts) VALUES (?, ?, ?, ?, ?)',
    [sessionId, nextSeq, turn.role, turn.text, Date.now()],
  );
}

export async function completeSession(sessionId: string): Promise<ChatSession | null> {
  const db = await getDatabase();
  const completedAt = Date.now();
  await db.runAsync(
    "UPDATE chat_sessions SET status = 'completed', completed_at = ? WHERE session_id = ?",
    [completedAt, sessionId],
  );
  return await getSession(sessionId);
}

export async function getSession(sessionId: string): Promise<ChatSession | null> {
  const db = await getDatabase();
  const row: any = await db.getFirstAsync(
    'SELECT * FROM chat_sessions WHERE session_id = ?',
    [sessionId],
  );
  if (!row) return null;
  const turns = await getTurnsForSession(sessionId);
  return rowToSession(row, turns);
}

export async function getCompletedSessions(limit = 20): Promise<ChatSession[]> {
  const db = await getDatabase();
  const rows: any[] = await db.getAllAsync(
    "SELECT * FROM chat_sessions WHERE status = 'completed' ORDER BY completed_at DESC LIMIT ?",
    [limit],
  );
  // Hydrate transcripts. For histories this is a few sessions so the
  // small N+1 query is fine; if this becomes hot we can add a
  // JSON-grouped query or join.
  const sessions: ChatSession[] = [];
  for (const row of rows) {
    const turns = await getTurnsForSession(row.session_id);
    sessions.push(rowToSession(row, turns));
  }
  return sessions;
}
