/**
 * Data Access Layer for Learning Cards
 * 4 fixed templates: word/sentence × video/ai_practice
 */

import { getDatabase } from './schema';

export type CardType = 'word' | 'sentence';
export type CardSource = 'video' | 'ai_practice';

export interface VideoContext {
  videoId?: string;
  sceneId?: string;
  segmentId?: string;
  startMs?: number;
  endMs?: number;
  coverUri?: string;
  /** Local file:// URI of a cached still frame at startMs. */
  thumbUri?: string;
  /** Local file:// URI of an ffmpeg-trimmed video clip for this segment. */
  clipUri?: string;
}

export interface PracticeContext {
  topicId?: string;
  userSaid?: string;
}

export interface LearningCard {
  id: string;
  type: CardType;
  source: CardSource;
  content: string;
  translation: string;
  notes?: string | null;
  videoContext?: VideoContext | null;
  practiceContext?: PracticeContext | null;
  createdAt: number;
  /** FSRS next-due timestamp in ms. Populated by helpers that JOIN fsrs_reviews. */
  due?: number | null;
}

export interface NewCardInput {
  id?: string;
  type: CardType;
  source: CardSource;
  content: string;
  translation: string;
  notes?: string;
  videoContext?: VideoContext;
  practiceContext?: PracticeContext;
}

/**
 * Create a new card and immediately initialize its FSRS state.
 * Returns the new card id.
 */
export async function createCard(input: NewCardInput): Promise<string> {
  const db = await getDatabase();
  const { initializeCardReview } = await import('./fsrs');

  const id = input.id ?? `card_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  const now = Date.now();

  await db.runAsync(
    `INSERT INTO learning_cards
     (id, type, source, content, translation, notes, video_context, practice_context, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.type,
      input.source,
      input.content,
      input.translation,
      input.notes ?? null,
      input.videoContext ? JSON.stringify(input.videoContext) : null,
      input.practiceContext ? JSON.stringify(input.practiceContext) : null,
      now,
    ],
  );

  await initializeCardReview(id);

  return id;
}

export async function getCardById(id: string): Promise<LearningCard | null> {
  const db = await getDatabase();
  const row: any = await db.getFirstAsync(
    'SELECT * FROM learning_cards WHERE id = ?',
    [id],
  );
  return row ? mapRowToCard(row) : null;
}

/**
 * Look up a word-type card by exact (case-insensitive) word content.
 * Used by the sandbox evaluator to find the FSRS card id for an
 * injected review word, so it can call scheduleReview() on it.
 * Returns the first matching id, or null.
 */
export async function findCardIdByWord(word: string): Promise<string | null> {
  if (!word) return null;
  const db = await getDatabase();
  const row: any = await db.getFirstAsync(
    `SELECT id FROM learning_cards
     WHERE type = 'word' AND LOWER(content) = LOWER(?)
     LIMIT 1`,
    [word],
  );
  return row?.id ?? null;
}

/**
 * Get all cards ordered by FSRS due time ascending (most overdue / most
 * urgent first). Cards without a review state yet (orphans) are treated
 * as due immediately and ordered by createdAt asc. Same orphan handling
 * as getDueCards / getCardsByVideo, so the knowledge base list and the
 * 单词/句子 tab lists all sort the same way.
 */
export async function getAllCards(limit: number = 500): Promise<LearningCard[]> {
  const db = await getDatabase();

  const reviewed: any[] = await db.getAllAsync(
    `SELECT c.id, c.type, c.source, c.content, c.translation, c.notes,
            c.video_context, c.practice_context, c.created_at,
            r.due as fsrs_due, r.state, r.reps, r.lapses, r.difficulty, r.stability
     FROM learning_cards c
     JOIN fsrs_reviews r ON r.card_id = c.id
     ORDER BY r.due ASC
     LIMIT ?`,
    [limit],
  );

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

  const mapped = [...reviewed, ...orphans]
    .map((row) => ({
      ...mapRowToCard(row),
      due: row.fsrs_due as number,
      state: row.state as number,
      reps: row.reps as number,
      lapses: row.lapses as number,
      difficulty: row.difficulty as number,
      stability: row.stability as number,
    }))
    .sort((a, b) => (a.due ?? 0) - (b.due ?? 0))
    .slice(0, limit);

  return mapped;
}

export async function getCardsBySource(source: CardSource): Promise<LearningCard[]> {
  const db = await getDatabase();
  const rows = await db.getAllAsync(
    'SELECT * FROM learning_cards WHERE source = ? ORDER BY created_at DESC',
    [source],
  );
  return rows.map(mapRowToCard);
}

export async function getCardCount(): Promise<number> {
  const db = await getDatabase();
  const result: any = await db.getFirstAsync(
    'SELECT COUNT(*) as count FROM learning_cards',
  );
  return result?.count || 0;
}

/**
 * Earliest learning_cards.created_at across all cards (ms epoch).
 * Returns null when the user has no cards yet.
 * Used to compute "累计学习天数" on the profile screen.
 */
export async function getFirstLearningAt(): Promise<number | null> {
  const db = await getDatabase();
  const row: any = await db.getFirstAsync(
    'SELECT MIN(created_at) as first FROM learning_cards',
  );
  return typeof row?.first === 'number' ? (row.first as number) : null;
}

/**
 * Find a card that already exists for a given video + word (normalized).
 * Used to dedup so the user can star/unstar the same word repeatedly
 * without creating duplicate rows. The `normalized` we store as the
 * word's `content` after lowercasing, so the match is exact.
 */
export async function findWordCardByVideo(
  videoId: string,
  normalized: string,
): Promise<LearningCard | null> {
  const db = await getDatabase();
  const row: any = await db.getFirstAsync(
    `SELECT * FROM learning_cards
     WHERE type = 'word'
       AND json_extract(video_context, '$.videoId') = ?
       AND LOWER(content) = ?
     LIMIT 1`,
    [videoId, normalized.toLowerCase()],
  );
  return row ? mapRowToCard(row) : null;
}

/**
 * Find a card that already exists for a given video + segment.
 * Sentences are deduped by segmentId, not by text — the same segment
 * can be favorited and unfavorited freely without duplicates.
 */
export async function findSentenceCardBySegment(
  videoId: string,
  segmentId: string,
): Promise<LearningCard | null> {
  const db = await getDatabase();
  const row: any = await db.getFirstAsync(
    `SELECT * FROM learning_cards
     WHERE type = 'sentence'
       AND json_extract(video_context, '$.videoId') = ?
       AND json_extract(video_context, '$.segmentId') = ?
     LIMIT 1`,
    [videoId, segmentId],
  );
  return row ? mapRowToCard(row) : null;
}

/**
 * Find a word card that already exists for a given AI 陪练 topic + word (normalized).
 * AI 陪练 has no videoId / segmentId, so we key by practiceContext.topicId +
 * LOWER(content). Used to dedup so the user can star/unstar the same word
 * repeatedly without creating duplicate rows.
 */
export async function findWordCardByTopic(
  topicId: string,
  normalized: string,
): Promise<LearningCard | null> {
  const db = await getDatabase();
  const row: any = await db.getFirstAsync(
    `SELECT * FROM learning_cards
     WHERE type = 'word'
       AND source = 'ai_practice'
       AND json_extract(practice_context, '$.topicId') = ?
       AND LOWER(content) = ?
     LIMIT 1`,
    [topicId, normalized.toLowerCase()],
  );
  return row ? mapRowToCard(row) : null;
}

/**
 * Find a sentence card that already exists for a given AI 陪练 topic + sentence text.
 * Sentences are deduped by topicId + LOWER(content). The same sentence can
 * be favorited and unfavorited freely without duplicates.
 */
export async function findSentenceCardByTopic(
  topicId: string,
  content: string,
): Promise<LearningCard | null> {
  const db = await getDatabase();
  const row: any = await db.getFirstAsync(
    `SELECT * FROM learning_cards
     WHERE type = 'sentence'
       AND source = 'ai_practice'
       AND json_extract(practice_context, '$.topicId') = ?
       AND LOWER(content) = ?
     LIMIT 1`,
    [topicId, content.toLowerCase()],
  );
  return row ? mapRowToCard(row) : null;
}

export async function deleteCard(id: string): Promise<void> {
  const db = await getDatabase();
  await db.runAsync('DELETE FROM learning_cards WHERE id = ?', [id]);
}

export async function updateCardNotes(id: string, notes: string): Promise<void> {
  const db = await getDatabase();
  await db.runAsync(
    'UPDATE learning_cards SET notes = ? WHERE id = ?',
    [notes, id],
  );
}

function mapRowToCard(row: any): LearningCard {
  return {
    id: row.id,
    type: row.type,
    source: row.source,
    content: row.content,
    translation: row.translation,
    notes: row.notes ?? null,
    videoContext: parseJson(row.video_context),
    practiceContext: parseJson(row.practice_context),
    createdAt: row.created_at,
  };
}

function parseJson(raw: any): any {
  if (!raw) return null;
  if (typeof raw !== 'string') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
