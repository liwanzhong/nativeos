/**
 * Audio Persistence using Supabase Storage
 * Caches TTS audio files for offline access
 */

import { supabase } from './supabase';
import { Directory, File, Paths } from 'expo-file-system';
import { Platform } from 'react-native';

const AUDIO_BUCKET = 'tts-audio';
const getAudioDir = () => new Directory(Paths.document, 'audio');

/**
 * Initialize audio storage
 */
export async function initializeAudioStorage(): Promise<void> {
  const dir = getAudioDir();
  if (!dir.exists) {
    dir.create();
    console.log('✅ Audio storage directory created');
  }
}

/**
 * Generate storage key from text
 */
function generateStorageKey(text: string, emotion: string, register: string): string {
  const hash = simpleHash(text);
  return `${emotion}_${register}_${hash}.mp3`;
}

/**
 * Simple hash function for text
 */
function simpleHash(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return Math.abs(hash).toString(36);
}

/**
 * Check if audio exists in local storage
 */
export async function getLocalAudio(
  text: string,
  emotion: string,
  register: string
): Promise<string | null> {
  const key = generateStorageKey(text, emotion, register);
  const file = new File(getAudioDir(), key);
  if (file.exists) {
    console.log('TTS: Using local cached audio');
    return file.uri;
  }
  return null;
}

/**
 * Save audio to local storage
 */
export async function saveLocalAudio(
  text: string,
  emotion: string,
  register: string,
  audioUrl: string
): Promise<string> {
  const key = generateStorageKey(text, emotion, register);
  try {
    const saved = await File.downloadFileAsync(audioUrl, getAudioDir());
    const dest = new File(getAudioDir(), key);
    saved.move(dest);
    console.log('TTS: Audio saved locally:', dest.uri);
    return dest.uri;
  } catch (error) {
    console.error('Failed to save audio locally:', error);
    return audioUrl;
  }
}

/**
 * Upload audio to Supabase Storage
 */
export async function uploadAudioToStorage(
  text: string,
  emotion: string,
  register: string,
  audioBlob: Blob
): Promise<string | null> {
  const key = generateStorageKey(text, emotion, register);
  
  try {
    const { data, error } = await supabase.storage
      .from(AUDIO_BUCKET)
      .upload(key, audioBlob, {
        contentType: 'audio/mpeg',
        cacheControl: '31536000', // 1 year
        upsert: true,
      });
    
    if (error) {
      console.error('Failed to upload audio:', error);
      return null;
    }
    
    // Get public URL
    const { data: urlData } = supabase.storage
      .from(AUDIO_BUCKET)
      .getPublicUrl(key);
    
    console.log('TTS: Audio uploaded to storage');
    return urlData.publicUrl;
  } catch (error) {
    console.error('Audio upload error:', error);
    return null;
  }
}

/**
 * Get audio from Supabase Storage
 */
export async function getAudioFromStorage(
  text: string,
  emotion: string,
  register: string
): Promise<string | null> {
  const key = generateStorageKey(text, emotion, register);
  
  try {
    const { data } = supabase.storage
      .from(AUDIO_BUCKET)
      .getPublicUrl(key);
    
    // Check if file exists
    const response = await fetch(data.publicUrl, { method: 'HEAD' });
    if (response.ok) {
      console.log('TTS: Using Supabase cached audio');
      return data.publicUrl;
    }
    
    return null;
  } catch (error) {
    console.error('Failed to get audio from storage:', error);
    return null;
  }
}

/**
 * Clear old cached audio files (keep last 100)
 */
export async function clearOldAudioCache(): Promise<void> {
  try {
    const dir = getAudioDir();
    if (!dir.exists) return;
    const files = dir.list();
    if (files.length > 100) {
      const fileInfos = files
        .filter(f => f instanceof File)
        .map(f => f as File)
        .sort((a, b) => (a.modificationTime ?? 0) - (b.modificationTime ?? 0));
      const toDelete = fileInfos.slice(0, files.length - 100);
      for (const f of toDelete) f.delete();
      console.log(`✅ Cleared ${toDelete.length} old audio files`);
    }
  } catch (error) {
    console.error('Failed to clear audio cache:', error);
  }
}

/**
 * Get cache statistics
 */
export async function getAudioCacheStats(): Promise<{
  fileCount: number;
  totalSize: number;
}> {
  try {
    const dir = getAudioDir();
    if (!dir.exists) return { fileCount: 0, totalSize: 0 };
    const files = dir.list().filter(f => f instanceof File).map(f => f as File);
    const totalSize = files.reduce((sum, f) => sum + (f.size ?? 0), 0);
    return { fileCount: files.length, totalSize };
  } catch (error) {
    return { fileCount: 0, totalSize: 0 };
  }
}
