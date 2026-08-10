/**
 * User Profile Management
 * Stores user's profession, interests, and learning preferences
 * Used for personalized "context creation" (Type 1 input handling)
 *
 * Storage: a single row in the generic `app_config` (key='user_profile',
 * value_json = JSON of the full UserProfile). This avoids needing a
 * dedicated migration for a table that previously existed before the
 * v3 schema overhaul.
 */

import { CEFRLevel } from '../types';
import { Platform } from 'react-native';
import { ensureDatabaseInitialized } from './database';

const STORAGE_KEY = 'user_profile';

export interface UserProfile {
  id: number;
  level: CEFRLevel;
  profession?: string;
  interests: string[];
  onboardingCompleted: boolean;
  createdAt: number;
  updatedAt: number;
}

interface UserProfileRow {
  id: number;
  level: CEFRLevel;
  profession: string | null;
  interests: string;          // JSON-encoded array
  onboarding_completed: number;
  created_at: number;
  updated_at: number;
}

/**
 * Read the persisted user_profile row from app_config (or null if none).
 */
async function readRow(): Promise<UserProfileRow | null> {
  await ensureDatabaseInitialized();
  const { getDatabase } = await import('./database/schema');
  const db = await getDatabase();
  const row = await db.getFirstAsync(
    'SELECT value_json FROM app_config WHERE key = ?',
    [STORAGE_KEY]
  ) as { value_json: string } | null;
  if (!row) return null;
  try {
    return JSON.parse(row.value_json) as UserProfileRow;
  } catch {
    return null;
  }
}

async function writeRow(row: UserProfileRow): Promise<void> {
  const { getDatabase } = await import('./database/schema');
  const db = await getDatabase();
  const now = Date.now();
  // UPSERT into app_config
  await db.runAsync(
    `INSERT INTO app_config (key, value_json, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
    [STORAGE_KEY, JSON.stringify(row), now]
  );
}

/**
 * Get user profile
 */
export async function getUserProfile(): Promise<UserProfile | null> {
  if (Platform.OS === 'web') return null;
  const row = await readRow();
  if (!row) return null;
  return {
    id: row.id,
    level: row.level,
    profession: row.profession ?? undefined,
    interests: row.interests ? JSON.parse(row.interests) : [],
    onboardingCompleted: row.onboarding_completed === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Create or update user profile
 */
export async function updateUserProfile(profile: Partial<UserProfile>): Promise<void> {
  if (Platform.OS === 'web') return;
  const now = Date.now();
  const existing = await readRow();

  const next: UserProfileRow = existing ?? {
    id: 1,
    level: (profile.level || 'B1') as CEFRLevel,
    profession: profile.profession ?? null,
    interests: JSON.stringify(profile.interests || []),
    onboarding_completed: profile.onboardingCompleted ? 1 : 0,
    created_at: now,
    updated_at: now,
  };

  if (profile.level !== undefined) next.level = profile.level as CEFRLevel;
  if (profile.profession !== undefined) {
    next.profession = profile.profession ?? null;
  }
  if (profile.interests !== undefined) {
    next.interests = JSON.stringify(profile.interests);
  }
  if (profile.onboardingCompleted !== undefined) {
    next.onboarding_completed = profile.onboardingCompleted ? 1 : 0;
  }
  next.updated_at = now;

  await writeRow(next);
}

/**
 * Get user's context for personalized generation
 * Used by Type 1 input handler to "create context"
 */
export async function getUserContext(): Promise<{
  level: CEFRLevel;
  profession: string;
  interests: string[];
  knownWords: string[];
}> {
  if (Platform.OS === 'web') {
    try {
      const AsyncStorage = (await import('@react-native-async-storage/async-storage')).default;
      const [levelRaw, wordsRaw, profRaw, interestsRaw] = await Promise.all([
        AsyncStorage.getItem('user_level'),
        AsyncStorage.getItem('known_words'),
        AsyncStorage.getItem('user_profession'),
        AsyncStorage.getItem('user_interests'),
      ]);
      return {
        level: (levelRaw as CEFRLevel) || 'B1',
        profession: profRaw || 'general',
        interests: interestsRaw ? JSON.parse(interestsRaw) : ['technology', 'daily life'],
        knownWords: wordsRaw ? JSON.parse(wordsRaw) : [],
      };
    } catch {
      return { level: 'B1', profession: 'general', interests: ['technology', 'daily life'], knownWords: [] };
    }
  }

  const profile = await getUserProfile();

  if (!profile) {
    return { level: 'B1', profession: 'general', interests: ['technology', 'daily life'], knownWords: [] };
  }

  return {
    level: profile.level,
    profession: profile.profession || 'general',
    interests: profile.interests.length > 0 ? profile.interests : ['technology', 'daily life'],
    knownWords: [],
  };
}
