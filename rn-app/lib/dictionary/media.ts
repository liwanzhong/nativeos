import { bundleDirectory } from 'expo-file-system/legacy';
import { Platform } from 'react-native';

const MEDIA_BASE = 'dictionary/media/';

/**
 * Resolves a dictionary audio_key to a playable URI.
 *
 * - If the key is an HTTP/HTTPS URL (e.g. Merriam-Webster CDN), return it directly.
 * - If the key is a local filename, resolve to the bundled asset path.
 * - On web: always returns null (not supported in V1).
 */
export function resolveAudioUri(audioKey: string | null | undefined): string | null {
  if (!audioKey) return null;
  if (Platform.OS === 'web') return null;
  // CDN URL — return as-is; expo-audio handles remote URLs
  if (audioKey.startsWith('http://') || audioKey.startsWith('https://')) {
    return audioKey;
  }
  // Local bundled file
  return `${bundleDirectory}${MEDIA_BASE}${audioKey}`;
}
