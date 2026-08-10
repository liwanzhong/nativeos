/**
 * Video AI practice — SQLite-backed (v3).
 *
 * Source of truth: video_ai_practice_card + video_ai_practice_state.
 * Replaces the legacy AsyncStorage stores
 *   - `generated_video_ai_practice_v1`
 *   - `generated_video_ai_practice_generation_state_v1`
 *
 * Only the per-scene CRUD lives here. Prompt construction, stream
 * parsing, listener fan-out and other business logic stay in
 * `lib/content/video-ai-practice.ts`.
 *
 * See docs/2026-08-05-storage-migration-plan.md.
 */

import { getDatabase } from './schema';

export type VideoAiPracticeGenerationStatus =
  | 'idle' | 'generating' | 'completed' | 'failed';

export interface VideoAiPracticeGenerationState {
  sceneId: string;
  status: VideoAiPracticeGenerationStatus;
  progressText: string;
  parsedCount: number;
  targetCount: number;
  cards: any[]; // ScenarioCard[] — kept loose to avoid a hard dep cycle
  errorMessage?: string;
  updatedAt: number;
}

const STALE_GENERATING_STATE_MS = 2 * 60 * 1000;

function rowToState(row: any): VideoAiPracticeGenerationState {
  let cards: any[] = [];
  try {
    const parsed = JSON.parse(row.cards_json);
    if (Array.isArray(parsed)) cards = parsed;
  } catch {
    cards = [];
  }
  return {
    sceneId: row.scene_id,
    status: row.status,
    progressText: row.progress_text,
    parsedCount: row.parsed_count,
    targetCount: row.target_count,
    cards,
    errorMessage: row.error_message ?? undefined,
    updatedAt: row.updated_at,
  };
}

function normalizeState(
  state: VideoAiPracticeGenerationState | null,
): VideoAiPracticeGenerationState | null {
  if (!state) return null;
  if (
    state.status === 'generating'
    && Date.now() - state.updatedAt > STALE_GENERATING_STATE_MS
  ) {
    return {
      ...state,
      status: 'failed' as const,
      progressText: state.cards.length > 0
        ? '上次生成已中断，可重新开始生成。'
        : '上次生成未完成，请重新开始。',
      errorMessage: state.errorMessage || 'generation_interrupted',
      updatedAt: Date.now(),
    };
  }
  return state;
}

// ── Cards (per-scene ScenarioCard[]) ────────────────────────────────

export async function loadVideoAiPracticeCards(sceneId: string): Promise<any[]> {
  const db = await getDatabase();
  const rows: any[] = await db.getAllAsync(
    'SELECT card_json FROM video_ai_practice_card WHERE scene_id = ? ORDER BY position ASC',
    [sceneId],
  );
  const cards: any[] = [];
  for (const row of rows) {
    try {
      cards.push(JSON.parse(row.card_json));
    } catch {
      // skip corrupt row
    }
  }
  return cards;
}

export async function saveVideoAiPracticeCards(
  sceneId: string,
  cards: any[],
): Promise<void> {
  const db = await getDatabase();
  await db.execAsync('BEGIN');
  try {
    await db.runAsync('DELETE FROM video_ai_practice_card WHERE scene_id = ?', [sceneId]);
    const now = Date.now();
    for (let i = 0; i < cards.length; i += 1) {
      await db.runAsync(
        'INSERT INTO video_ai_practice_card (scene_id, position, card_json, created_at) VALUES (?, ?, ?, ?)',
        [sceneId, i, JSON.stringify(cards[i]), now],
      );
    }
    await db.execAsync('COMMIT');
  } catch (e) {
    try { await db.execAsync('ROLLBACK'); } catch { /* ignore */ }
    throw e;
  }
}

// ── Generation state (1 row per scene) ─────────────────────────────

export async function loadVideoAiPracticeState(
  sceneId: string,
): Promise<VideoAiPracticeGenerationState | null> {
  const db = await getDatabase();
  const row: any = await db.getFirstAsync(
    'SELECT * FROM video_ai_practice_state WHERE scene_id = ?',
    [sceneId],
  );
  return row ? normalizeState(rowToState(row)) : null;
}

export async function saveVideoAiPracticeState(
  sceneId: string,
  state: VideoAiPracticeGenerationState | null,
): Promise<void> {
  const db = await getDatabase();
  if (!state) {
    await db.runAsync(
      'DELETE FROM video_ai_practice_state WHERE scene_id = ?',
      [sceneId],
    );
    return;
  }
  await db.runAsync(
    `INSERT OR REPLACE INTO video_ai_practice_state (
      scene_id, status, progress_text, parsed_count, target_count,
      cards_json, error_message, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      sceneId, state.status, state.progressText,
      state.parsedCount, state.targetCount,
      JSON.stringify(state.cards || []),
      state.errorMessage ?? null, state.updatedAt || Date.now(),
    ],
  );
}
