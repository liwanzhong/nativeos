/**
 * Web-specific database implementation using IndexedDB
 * Fallback for when SQLite is not available on web
 */

export async function initDatabase() {
  console.warn('Web platform: Using mock database. SQLite features limited.');
  return null as any;
}

export async function getDatabase() {
  return null as any;
}

export async function resetDatabase(): Promise<void> {
  console.warn('Web platform: Database reset not implemented');
}
