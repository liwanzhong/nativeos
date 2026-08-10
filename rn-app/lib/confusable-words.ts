/**
 * Confusable Words Detection System
 * Implements Saussure's structuralism: binary opposition analysis
 * PRD requirement: Detect confusable words and force Scene 4 generation
 */

import { Platform } from 'react-native';

/**
 * Common confusable word pairs database
 * These pairs require binary opposition analysis (Scene 4)
 */
export const CONFUSABLE_PAIRS = [
  // Common confusions
  ['accept', 'except'],
  ['affect', 'effect'],
  ['advice', 'advise'],
  ['complement', 'compliment'],
  ['principal', 'principle'],
  ['stationary', 'stationery'],
  ['their', 'there'],
  ['your', 'you\'re'],
  ['its', 'it\'s'],
  ['lose', 'loose'],
  
  // Advanced confusions
  ['amend', 'modify'],
  ['imply', 'infer'],
  ['emigrate', 'immigrate'],
  ['continuous', 'continual'],
  ['farther', 'further'],
  ['fewer', 'less'],
  ['historic', 'historical'],
  ['uninterested', 'disinterested'],
  ['ensure', 'insure'],
  ['elicit', 'illicit'],
  
  // Technical confusions
  ['deprecate', 'depreciate'],
  ['compose', 'comprise'],
  ['flaunt', 'flout'],
  ['prescribe', 'proscribe'],
  ['tortuous', 'torturous'],
  
  // Verb confusions
  ['lay', 'lie'],
  ['raise', 'rise'],
  ['set', 'sit'],
  ['hanged', 'hung'],
  ['lend', 'borrow'],
  
  // Adjective confusions
  ['alternate', 'alternative'],
  ['classic', 'classical'],
  ['economic', 'economical'],
  ['literal', 'figurative'],
];

/**
 * Initialize confusable pairs table with data
 */
export async function seedConfusablePairs(): Promise<void> {
  if (Platform.OS === 'web') return;
  const { getDatabase } = await import('./database/schema');
  const db = await getDatabase();
  
  console.log('Seeding confusable pairs...');
  
  for (const [word1, word2] of CONFUSABLE_PAIRS) {
    try {
      await db.runAsync(
        'INSERT OR IGNORE INTO confusable_pairs (word1, word2) VALUES (?, ?)',
        [word1.toLowerCase(), word2.toLowerCase()]
      );
      await db.runAsync(
        'INSERT OR IGNORE INTO confusable_pairs (word1, word2) VALUES (?, ?)',
        [word2.toLowerCase(), word1.toLowerCase()]
      );
    } catch (error) {
      console.error(`Failed to insert pair ${word1}-${word2}:`, error);
    }
  }
  
  console.log(`✅ Seeded ${CONFUSABLE_PAIRS.length * 2} confusable pairs`);
}

/**
 * Check if a word has confusable counterparts
 * PRD: "利用本地 SQLite 的快速 IN 查询，瞬间判定用户是否学过该词的易混淆体"
 */
export async function getConfusableWords(word: string): Promise<string[]> {
  if (Platform.OS === 'web') {
    // On web: use static array lookup (no SQLite)
    const lw = word.toLowerCase();
    const results: string[] = [];
    for (const [w1, w2] of CONFUSABLE_PAIRS) {
      if (w1 === lw) results.push(w2);
      if (w2 === lw) results.push(w1);
    }
    return results;
  }
  const { getDatabase } = await import('./database/schema');
  const db = await getDatabase();
  const rows = await db.getAllAsync(
    'SELECT word2 FROM confusable_pairs WHERE word1 = ?',
    [word.toLowerCase()]
  ) as Array<{ word2: string }>;
  return rows.map((row: { word2: string }) => row.word2);
}

/**
 * Check if user has learned the confusable counterpart
 * Returns true if user should see Scene 4 (contrast card)
 */
export async function shouldTriggerContrastCard(
  word: string
): Promise<{ shouldTrigger: boolean; confusableWord?: string }> {
  const confusables = await getConfusableWords(word);
  
  if (confusables.length === 0) {
    return { shouldTrigger: false };
  }
  
  // On web: no SQLite card lookup, skip contrast trigger
  if (Platform.OS === 'web') {
    return { shouldTrigger: false };
  }
  
  // Check if user has learned any confusable counterpart
  const { searchCardsByWord } = await import('./database/cards');
  
  for (const confusable of confusables) {
    const cards = await searchCardsByWord(confusable);
    if (cards.length > 0) {
      return { shouldTrigger: true, confusableWord: confusable };
    }
  }
  
  return { shouldTrigger: false };
}

/**
 * Detect if input contains confusable words
 * Used by intent router to force Scene 4
 */
export async function detectConfusableInInput(input: string): Promise<{
  hasConfusable: boolean;
  word?: string;
  confusableWord?: string;
}> {
  const words = input.toLowerCase().split(/\s+/);
  
  for (const word of words) {
    const cleanWord = word.replace(/[^\w]/g, '');
    if (cleanWord.length < 3) continue;
    
    const result = await shouldTriggerContrastCard(cleanWord);
    if (result.shouldTrigger) {
      return {
        hasConfusable: true,
        word: cleanWord,
        confusableWord: result.confusableWord,
      };
    }
  }
  
  return { hasConfusable: false };
}

/**
 * Get all confusable pairs for a list of words
 * Used for batch checking
 */
export async function getConfusablePairsForWords(
  words: string[]
): Promise<Map<string, string[]>> {
  const result = new Map<string, string[]>();
  
  for (const word of words) {
    const confusables = await getConfusableWords(word);
    if (confusables.length > 0) {
      result.set(word, confusables);
    }
  }
  
  return result;
}
