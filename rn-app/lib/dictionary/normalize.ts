/**
 * Normalizes a raw token from subtitle text for dictionary lookup.
 * - Lowercases
 * - Strips leading/trailing punctuation and whitespace
 * - Collapses internal whitespace
 */
export function normalizeLookupToken(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/^[^a-z']+|[^a-z']+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}
