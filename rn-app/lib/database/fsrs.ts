/**
 * FSRS Data Access Layer
 * Implements FSRS algorithm using ts-fsrs library against SQLite
 */

import { getDatabase } from './schema';
import { FSRS, createEmptyCard } from 'ts-fsrs';

const fsrs = new FSRS({});

export interface FSRSReview {
  cardId: string;
  difficulty: number;
  stability: number;
  elapsedDays: number;
  scheduledDays: number;
  reps: number;
  lapses: number;
  state: number;
  lastReview?: number;
  due: number;
}

/**
 * Initialize FSRS state for a new card. The card is due now (treated as
 * brand new for the scheduler to schedule it on first review).
 */
export async function initializeCardReview(cardId: string): Promise<void> {
  const db = await getDatabase();
  const card = createEmptyCard();
  const now = Date.now();

  await db.runAsync(
    `INSERT OR REPLACE INTO fsrs_reviews
     (card_id, difficulty, stability, elapsed_days, scheduled_days, reps, lapses, state, last_review, due)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      cardId,
      card.difficulty,
      card.stability,
      card.elapsed_days,
      card.scheduled_days,
      card.reps,
      card.lapses,
      card.state,
      null,
      now,
    ],
  );
}

export async function getReview(cardId: string): Promise<FSRSReview | null> {
  const db = await getDatabase();

  const row: any = await db.getFirstAsync(
    'SELECT * FROM fsrs_reviews WHERE card_id = ?',
    [cardId],
  );

  if (!row) return null;

  return {
    cardId: row.card_id,
    difficulty: row.difficulty,
    stability: row.stability,
    elapsedDays: row.elapsed_days,
    scheduledDays: row.scheduled_days,
    reps: row.reps,
    lapses: row.lapses,
    state: row.state,
    lastReview: row.last_review ?? undefined,
    due: row.due,
  };
}

/**
 * Apply a rating to a card. Returns the updated review state.
 * Rating is the ts-fsrs Rating enum (1=Again, 2=Hard, 3=Good, 4=Easy).
 */
export async function scheduleReview(
  cardId: string,
  rating: number,
): Promise<FSRSReview> {
  const db = await getDatabase();
  const now = new Date();

  const current = await getReview(cardId);
  if (!current) {
    throw new Error(`Review not found for card ${cardId}`);
  }

  // Restore card state
  const card = createEmptyCard(new Date(current.due));
  card.difficulty = current.difficulty;
  card.stability = current.stability;
  card.elapsed_days = current.elapsedDays;
  card.scheduled_days = current.scheduledDays;
  card.reps = current.reps;
  card.lapses = current.lapses;
  card.state = current.state;
  if (current.lastReview) {
    card.last_review = new Date(current.lastReview);
  }

  // Apply rating through ts-fsrs
  const scheduling = fsrs.repeat(card, now);
  const recordLog = scheduling[rating] ?? scheduling[3]; // default to Good
  const updated = recordLog.card;

  await db.runAsync(
    `UPDATE fsrs_reviews
     SET difficulty = ?, stability = ?, elapsed_days = ?, scheduled_days = ?,
         reps = ?, lapses = ?, state = ?, last_review = ?, due = ?
     WHERE card_id = ?`,
    [
      updated.difficulty,
      updated.stability,
      updated.elapsed_days,
      updated.scheduled_days,
      updated.reps,
      updated.lapses,
      updated.state,
      now.getTime(),
      updated.due.getTime(),
      cardId,
    ],
  );

  return {
    cardId,
    difficulty: updated.difficulty,
    stability: updated.stability,
    elapsedDays: updated.elapsed_days,
    scheduledDays: updated.scheduled_days,
    reps: updated.reps,
    lapses: updated.lapses,
    state: updated.state,
    lastReview: now.getTime(),
    due: updated.due.getTime(),
  };
}

/**
 * Get all cards that are due for review. Cards without an FSRS row yet are
 * treated as due immediately (will be initialized on first review).
 */
export async function getDueCards(limit: number = 20): Promise<any[]> {
  const db = await getDatabase();
  const now = Date.now();

  // Cards with a review state and due <= now
  const reviewedDue: any[] = await db.getAllAsync(
    `SELECT c.id, c.type, c.source, c.content, c.translation, c.notes,
            c.video_context, c.practice_context, c.created_at,
            r.due as fsrs_due, r.state, r.reps, r.lapses, r.difficulty, r.stability
     FROM learning_cards c
     JOIN fsrs_reviews r ON r.card_id = c.id
     WHERE r.due <= ?
     ORDER BY r.due ASC
     LIMIT ?`,
    [now, limit],
  );

  // Cards with no FSRS row yet (orphans) — also due now
  const orphans: any[] = await db.getAllAsync(
    `SELECT c.id, c.type, c.source, c.content, c.translation, c.notes,
            c.video_context, c.practice_context, c.created_at,
            c.created_at as fsrs_due, 0 as state, 0 as reps, 0 as lapses, 5.0 as difficulty, 1.0 as stability
     FROM learning_cards c
     LEFT JOIN fsrs_reviews r ON r.card_id = c.id
     WHERE r.card_id IS NULL
     ORDER BY c.created_at ASC
     LIMIT ?`,
    [limit],
  );

  return [...reviewedDue, ...orphans]
    .map(mapRowToCard)
    .sort((a, b) => (a.due ?? 0) - (b.due ?? 0))
    .slice(0, limit);
}

export async function getDueCardCount(): Promise<number> {
  const db = await getDatabase();
  const now = Date.now();

  const result: any = await db.getFirstAsync(
    `SELECT
       (SELECT COUNT(*) FROM fsrs_reviews WHERE due <= ?) +
       (SELECT COUNT(*) FROM learning_cards c
        LEFT JOIN fsrs_reviews r ON r.card_id = c.id
        WHERE r.card_id IS NULL) as count`,
    [now],
  );

  return result?.count || 0;
}

/**
 * Get all cards for a given video (optionally filtered by type), ordered
 * by FSRS due time. Cards with no review state yet are treated as due
 * immediately and sort by createdAt.
 *
 * Used by the video page to render the 单词 / 句子 lists.
 */
export async function getCardsByVideo(
  videoId: string,
  type?: 'word' | 'sentence',
  limit: number = 500,
): Promise<any[]> {
  const db = await getDatabase();

  const typeFilter = type
    ? `AND c.type = '${type}'`
    : '';

  const reviewed: any[] = await db.getAllAsync(
    `SELECT c.id, c.type, c.source, c.content, c.translation, c.notes,
            c.video_context, c.practice_context, c.created_at,
            r.due as fsrs_due, r.state, r.reps, r.lapses, r.difficulty, r.stability
     FROM learning_cards c
     JOIN fsrs_reviews r ON r.card_id = c.id
     WHERE json_extract(c.video_context, '$.videoId') = ?
       ${typeFilter}
     ORDER BY r.due ASC
     LIMIT ?`,
    [videoId, limit],
  );

  const orphans: any[] = await db.getAllAsync(
    `SELECT c.id, c.type, c.source, c.content, c.translation, c.notes,
            c.video_context, c.practice_context, c.created_at,
            c.created_at as fsrs_due, 0 as state, 0 as reps, 0 as lapses, 5.0 as difficulty, 1.0 as stability
     FROM learning_cards c
     LEFT JOIN fsrs_reviews r ON r.card_id = c.id
     WHERE r.card_id IS NULL
       AND json_extract(c.video_context, '$.videoId') = ?
       ${typeFilter}
     ORDER BY c.created_at ASC
     LIMIT ?`,
    [videoId, limit],
  );

  return [...reviewed, ...orphans]
    .map(mapRowToCard)
    .sort((a, b) => (a.due ?? 0) - (b.due ?? 0))
    .slice(0, limit);
}

/**
 * Count of due cards (due <= now) for a given video, optionally
 * filtered by type. Used by the "开始复习 (N)" button on each tab.
 */
export async function getDueCardCountByVideo(
  videoId: string,
  type?: 'word' | 'sentence',
): Promise<number> {
  const db = await getDatabase();
  const now = Date.now();

  const typeFilter = type
    ? `AND c.type = '${type}'`
    : '';

  const result: any = await db.getFirstAsync(
    `SELECT
       (SELECT COUNT(*) FROM fsrs_reviews r
        JOIN learning_cards c ON c.id = r.card_id
        WHERE r.due <= ?
          AND json_extract(c.video_context, '$.videoId') = ?
          ${typeFilter}) +
       (SELECT COUNT(*) FROM learning_cards c
        LEFT JOIN fsrs_reviews r ON r.card_id = c.id
        WHERE r.card_id IS NULL
          AND json_extract(c.video_context, '$.videoId') = ?
          ${typeFilter}) as count`,
    [now, videoId, videoId],
  );

  return result?.count || 0;
}

export async function getReviewStats(): Promise<{
  total: number;
  due: number;
  learning: number;
  review: number;
  relearning: number;
}> {
  const db = await getDatabase();
  const now = Date.now();

  const total: any = await db.getFirstAsync(
    'SELECT COUNT(*) as count FROM learning_cards',
  );
  const due: any = await db.getFirstAsync(
    `SELECT
       (SELECT COUNT(*) FROM fsrs_reviews WHERE due <= ?) +
       (SELECT COUNT(*) FROM learning_cards c
        LEFT JOIN fsrs_reviews r ON r.card_id = c.id
        WHERE r.card_id IS NULL) as count`,
    [now],
  );
  const learning: any = await db.getFirstAsync(
    'SELECT COUNT(*) as count FROM fsrs_reviews WHERE state = 1',
  );
  const review: any = await db.getFirstAsync(
    'SELECT COUNT(*) as count FROM fsrs_reviews WHERE state = 2',
  );
  const relearning: any = await db.getFirstAsync(
    'SELECT COUNT(*) as count FROM fsrs_reviews WHERE state = 3',
  );

  return {
    total: total?.count || 0,
    due: due?.count || 0,
    learning: learning?.count || 0,
    review: review?.count || 0,
    relearning: relearning?.count || 0,
  };
}

function mapRowToCard(row: any) {
  return {
    id: row.id,
    type: row.type,
    source: row.source,
    content: row.content,
    translation: row.translation,
    notes: row.notes ?? null,
    videoContext: parseJsonField(row.video_context),
    practiceContext: parseJsonField(row.practice_context),
    createdAt: row.created_at,
    due: row.fsrs_due ?? null,
    state: row.state,
    reps: row.reps,
    lapses: row.lapses,
    difficulty: row.difficulty,
    stability: row.stability,
  };
}

function parseJsonField(raw: any): any {
  if (!raw) return null;
  if (typeof raw !== 'string') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
