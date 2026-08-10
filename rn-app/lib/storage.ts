/**
 * Supabase Storage helpers for user-uploaded assets.
 *
 * Currently:
 *   - avatars bucket: <auth.uid()>/<filename> (public read, owner write)
 *
 * Image upload flow (called from profile-edit):
 *   1. Pick image via expo-image-picker → get local URI
 *   2. Read bytes (fetch + arrayBuffer) → ArrayBuffer
 *   3. uploadAvatar(buffer, ext) → returns { publicUrl, path }
 *   4. profiles.avatar_url = publicUrl
 */

import { supabase } from './supabase';

const AVATAR_BUCKET = 'avatars';
const MAX_AVATAR_BYTES = 5 * 1024 * 1024; // 5 MB

export interface UploadResult {
  publicUrl: string;
  path: string;
}

function inferContentType(ext: string): string {
  const e = ext.toLowerCase().replace(/^\./, '');
  if (e === 'png') return 'image/png';
  if (e === 'webp') return 'image/webp';
  if (e === 'heic' || e === 'heif') return 'image/heic';
  return 'image/jpeg';
}

/**
 * Upload an avatar to the user's own folder in the `avatars` bucket.
 * Overwrites any existing file at the same path (uses upsert).
 */
export async function uploadAvatar(
  userId: string,
  bytes: ArrayBuffer,
  ext: string
): Promise<UploadResult> {
  if (bytes.byteLength > MAX_AVATAR_BYTES) {
    throw new Error(`头像文件超过 ${MAX_AVATAR_BYTES / 1024 / 1024}MB 限制`);
  }
  const contentType = inferContentType(ext);
  // Use a fixed filename per user so re-uploads overwrite cleanly and
  // we never accumulate stale files in the bucket.
  const path = `${userId}/avatar.${ext.replace(/^\./, '') || 'jpg'}`;

  const { error } = await supabase.storage
    .from(AVATAR_BUCKET)
    .upload(path, bytes, {
      contentType,
      upsert: true,
      cacheControl: '3600',
    });
  if (error) throw error;

  const { data } = supabase.storage.from(AVATAR_BUCKET).getPublicUrl(path);
  return { publicUrl: data.publicUrl, path };
}

/**
 * Delete the user's current avatar (best-effort — ignores 404).
 */
export async function deleteAvatar(path: string): Promise<void> {
  if (!path) return;
  const { error } = await supabase.storage.from(AVATAR_BUCKET).remove([path]);
  // 404s are fine — file already gone
  if (error && !/not found/i.test(error.message)) {
    throw error;
  }
}
