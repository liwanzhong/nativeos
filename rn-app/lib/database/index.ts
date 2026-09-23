/**
 * Database Module Entry Point
 * Native-only — no web fallback.
 */

let dbInitialized = false;

export async function ensureDatabaseInitialized(): Promise<void> {
  if (dbInitialized) return;
  const { initDatabase } = await import('./schema');
  await initDatabase();
  dbInitialized = true;
}

export async function getDatabase() {
  const { getDatabase: fn } = await import('./schema');
  return fn();
}

export async function createCard(card: any) {
  const { createCard: fn } = await import('./cards');
  return fn(card);
}

export async function getCardById(id: string) {
  const { getCardById: fn } = await import('./cards');
  return fn(id);
}

export async function findCardIdByWord(word: string) {
  const { findCardIdByWord: fn } = await import('./cards');
  return fn(word);
}

export async function getAllCards(limit?: number) {
  const { getAllCards: fn } = await import('./cards');
  return fn(limit);
}

export async function getCardsBySource(source: any) {
  const { getCardsBySource: fn } = await import('./cards');
  return fn(source);
}

export async function getCardCount() {
  const { getCardCount: fn } = await import('./cards');
  return fn();
}

export async function getFirstLearningAt(): Promise<number | null> {
  const { getFirstLearningAt: fn } = await import('./cards');
  return fn();
}

export async function findWordCardByVideo(videoId: string, normalized: string) {
  const { findWordCardByVideo: fn } = await import('./cards');
  return fn(videoId, normalized);
}

export async function findSentenceCardBySegment(videoId: string, segmentId: string) {
  const { findSentenceCardBySegment: fn } = await import('./cards');
  return fn(videoId, segmentId);
}

export async function findWordCardByTopic(topicId: string, normalized: string) {
  const { findWordCardByTopic: fn } = await import('./cards');
  return fn(topicId, normalized);
}

export async function findSentenceCardByTopic(topicId: string, content: string) {
  const { findSentenceCardByTopic: fn } = await import('./cards');
  return fn(topicId, content);
}

export async function deleteCard(id: string) {
  const { deleteCard: fn } = await import('./cards');
  return fn(id);
}

export async function getRangeGroupById(groupId: string) {
  const { getRangeGroupById: fn } = await import('./cards');
  return fn(groupId);
}

export async function scheduleRangeReview(groupId: string, rating: number) {
  const { scheduleRangeReview: fn } = await import('./cards');
  return fn(groupId, rating);
}

export async function getDueRangeGroups(opts?: {
  videoId?: string;
  type?: 'word' | 'sentence';
  limit?: number;
}) {
  const { getDueRangeGroups: fn } = await import('./cards');
  return fn(opts);
}

export async function updateCardNotes(id: string, notes: string) {
  const { updateCardNotes: fn } = await import('./cards');
  return fn(id, notes);
}

export async function initializeCardReview(cardId: string) {
  const { initializeCardReview: fn } = await import('./fsrs');
  return fn(cardId);
}

export async function getReview(cardId: string) {
  const { getReview: fn } = await import('./fsrs');
  return fn(cardId);
}

export async function scheduleReview(cardId: string, rating: number) {
  const { scheduleReview: fn } = await import('./fsrs');
  return fn(cardId, rating);
}

export async function getDueCards(limit?: number) {
  const { getDueCards: fn } = await import('./fsrs');
  return fn(limit ?? 20);
}

export async function getDueCardCount() {
  const { getDueCardCount: fn } = await import('./fsrs');
  return fn();
}

export async function getCardsByVideo(
  videoId: string,
  type?: 'word' | 'sentence',
  limit?: number,
) {
  const { getCardsByVideo: fn } = await import('./fsrs');
  return fn(videoId, type, limit ?? 500);
}

export async function getDueCardCountByVideo(
  videoId: string,
  type?: 'word' | 'sentence',
) {
  const { getDueCardCountByVideo: fn } = await import('./fsrs');
  return fn(videoId, type);
}

export async function getReviewStats() {
  const { getReviewStats: fn } = await import('./fsrs');
  return fn();
}
