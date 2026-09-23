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
  /** V2 — groups N contiguous sentence cards into one review unit. */
  rangeGroupId?: string;
  /** V2 — start of the range clip (typically the first segment's startMs). */
  rangeStartMs?: number;
  /** V2 — end of the range clip (typically the last segment's endMs). */
  rangeEndMs?: number;
  /** V2 — shared ffmpeg clip URI for the whole range. */
  rangeClipUri?: string;
  /** V2 — 0-based position within the range group (0..N-1). */
  rangeOrder?: number;
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

// ── V2 range-group API ───────────────────────────────────────────────
//
// A range group = N sentence cards created together from one contiguous
// selection. All cards share `videoContext.rangeGroupId`. Review treats
// the group as one unit: same clip, same review session, same rating.
//
// `getRangeGroupById` returns the group's cards ordered by rangeOrder
// (falling back to startMs when rangeOrder is missing for migrated rows).

export interface RangeGroup {
  groupId: string;
  videoId: string | null;
  rangeStartMs: number | null;
  rangeEndMs: number | null;
  rangeClipUri: string | null;
  cards: LearningCard[];
}

/** Pull every card in a range group, sorted by rangeOrder asc. */
export async function getRangeGroupById(groupId: string): Promise<RangeGroup | null> {
  const db = await getDatabase();
  const rows: any[] = await db.getAllAsync(
    `SELECT id, type, source, content, translation, notes,
            video_context, practice_context, created_at
       FROM learning_cards
      WHERE json_extract(video_context, '$.rangeGroupId') = ?
      ORDER BY json_extract(video_context, '$.rangeOrder') ASC,
               json_extract(video_context, '$.startMs') ASC`,
    [groupId],
  );
  if (rows.length === 0) return null;
  const cards = rows.map((row) => mapRowToCard(row));
  const first = cards[0];
  const vc = first.videoContext;
  return {
    groupId,
    videoId: vc?.videoId ?? null,
    rangeStartMs: vc?.rangeStartMs ?? null,
    rangeEndMs: vc?.rangeEndMs ?? null,
    rangeClipUri: vc?.rangeClipUri ?? null,
    cards,
  };
}

/**
 * Mark every card in a range group reviewed with the same FSRS rating.
 *
 * Plan b implementation: each card's initial FSRS state is identical
 * (createEmptyCard on insert), so calling scheduleReview() in series
 * with the same rating produces identical due/state/reps. This keeps
 * the underlying fsrs_reviews table consistent with non-group cards.
 *
 * Rating is 1..4 matching scheduleReview().
 */
export async function scheduleRangeReview(
  groupId: string,
  rating: number,
): Promise<{ cardIds: string[] }> {
  const group = await getRangeGroupById(groupId);
  if (!group) return { cardIds: [] };
  const { scheduleReview } = await import('./fsrs');
  for (const card of group.cards) {
    await scheduleReview(card.id, rating);
  }
  return { cardIds: group.cards.map((c) => c.id) };
}

/**
 * Get all range groups that are due now (or have no FSRS state yet).
 * Returns one entry per unique rangeGroupId, plus all non-grouped
 * sentence cards as their own synthetic groups (groupId = card.id).
 * Used by the review list + due-count.
 */
export async function getDueRangeGroups(opts?: {
  videoId?: string;
  type?: 'word' | 'sentence';
  limit?: number;
}): Promise<Array<RangeGroup & { dueAt: number | null }>> {
  const db = await getDatabase();
  const limit = opts?.limit ?? 500;
  const now = Date.now();
  const type = opts?.type ?? 'sentence';
  const videoFilter = opts?.videoId;

  // Pull every sentence-type card (filtered by video if requested).
  const rows: any[] = await db.getAllAsync(
    `SELECT c.id, c.type, c.source, c.content, c.translation, c.notes,
            c.video_context, c.practice_context, c.created_at,
            r.due as fsrs_due
       FROM learning_cards c
       LEFT JOIN fsrs_reviews r ON r.card_id = c.id
      WHERE c.type = ?
        ${videoFilter ? 'AND json_extract(c.video_context, \'$.videoId\') = ?' : ''}
      ORDER BY c.created_at ASC`,
    videoFilter ? [type, videoFilter] : [type],
  );
  if (rows.length === 0) return [];

  const groups = new Map<string, { cards: LearningCard[]; due: number | null }>();
  for (const row of rows) {
    const card = mapRowToCard(row);
    const vc = card.videoContext;
    const gid = vc?.rangeGroupId ?? card.id; // synthetic group for singletons
    const dueRaw = row.fsrs_due as number | null | undefined;
    const due = dueRaw == null ? 0 : dueRaw;
    const existing = groups.get(gid);
    if (!existing) {
      groups.set(gid, { cards: [card], due });
    } else {
      existing.cards.push(card);
      // Group is due when the EARLIEST card in it is due (worst case).
      existing.due = Math.min(existing.due ?? due, due);
    }
  }

  const out: Array<RangeGroup & { dueAt: number | null }> = [];
  for (const [gid, { cards: cs, due }] of groups) {
    const dueMs = due ?? 0;
    if (dueMs > now) continue; // skip fully-future groups
    cs.sort((a, b) => {
      const ao = a.videoContext?.rangeOrder ?? 0;
      const bo = b.videoContext?.rangeOrder ?? 0;
      if (ao !== bo) return ao - bo;
      return (a.videoContext?.startMs ?? 0) - (b.videoContext?.startMs ?? 0);
    });
    const first = cs[0];
    const vc = first.videoContext;
    out.push({
      groupId: gid,
      videoId: vc?.videoId ?? null,
      rangeStartMs: vc?.rangeStartMs ?? vc?.startMs ?? null,
      rangeEndMs: vc?.rangeEndMs ?? vc?.endMs ?? null,
      rangeClipUri: vc?.rangeClipUri ?? null,
      cards: cs,
      dueAt: due || null,
    });
    if (out.length >= limit) break;
  }
  out.sort((a, b) => (a.dueAt ?? 0) - (b.dueAt ?? 0));
  return out;
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
