/**
 * Profile edit screen — avatar + display name.
 *
 * Level and interests are NOT edited here; they live on the profile tab
 * ("我的" → 等级 & 兴趣设置 row) so the edit screen stays focused on
 * identity (photo + nickname).
 *
 * Save flow:
 *   1. Upload pending avatar to Supabase Storage (if any)
 *   2. Best-effort cloud sync to public.profiles (avatar_url + display_name)
 *   3. router.back() on success
 *
 * Cloud sync is best-effort: if it fails, the local avatar display
 * still reflects the pending image; next save will retry.
 */

import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, Text, TextInput, View, Image,
} from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { useRouter } from 'expo-router';
import { Check, ChevronLeft, Camera, X } from 'lucide-react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { borderRadius, colors, fontSize, fontWeight, spacing } from '../constants/theme';
import { supabase } from '../lib/supabase';
import { useAuth } from '../lib/auth';
import { uploadAvatar } from '../lib/storage';

export default function ProfileEditScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { user, profile, refreshProfile } = useAuth();

  const [displayName, setDisplayName] = useState('');
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);
  const [pendingAvatar, setPendingAvatar] = useState<{ uri: string; ext: string } | null>(null);
  const [uploadingAvatar, setUploadingAvatar] = useState(false);
  const [saving, setSaving] = useState(false);
  const [hydrated, setHydrated] = useState(false);

  // Hydrate from cloud profile (if logged in), else fall back to email local-part
  useEffect(() => {
    let cancelled = false;
    (async () => {
      // Best-effort: if user has a cloud profile, use its displayName + avatarUrl
      if (cancelled) return;
      if (profile) {
        setDisplayName(profile.displayName ?? user?.email?.split('@')[0] ?? '');
        setAvatarUrl(profile.avatarUrl ?? null);
      } else {
        setDisplayName(user?.email?.split('@')[0] ?? '');
        setAvatarUrl(null);
      }
      setHydrated(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [profile, user]);

  const handlePickAvatar = useCallback(async () => {
    if (!user) {
      Alert.alert('未登录', '登录后才能上传头像。');
      return;
    }
    try {
      const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (status !== 'granted') {
        Alert.alert('需要相册权限', '请在系统设置中允许 NativeOS 访问相册。');
        return;
      }
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'],
        allowsEditing: true,
        aspect: [1, 1],
        quality: 0.8,
        exif: false,
      });
      if (result.canceled || !result.assets?.[0]) return;
      const asset = result.assets[0];
      const ext = (() => {
        if (asset.mimeType) {
          if (asset.mimeType.includes('png')) return 'png';
          if (asset.mimeType.includes('webp')) return 'webp';
          if (asset.mimeType.includes('heic') || asset.mimeType.includes('heif')) return 'heic';
        }
        const m = asset.uri.match(/\.([a-zA-Z0-9]+)(?:\?|$)/);
        return m ? m[1].toLowerCase() : 'jpg';
      })();
      setPendingAvatar({ uri: asset.uri, ext });
    } catch (e) {
      const msg = e instanceof Error ? e.message : '选择图片失败';
      Alert.alert('选择失败', msg);
    }
  }, [user]);

  const handleClearPendingAvatar = useCallback(() => {
    setPendingAvatar(null);
  }, []);

  const handleSave = useCallback(async () => {
    if (!user && pendingAvatar) {
      Alert.alert('未登录', '登录后才能上传头像，请先登录。');
      return;
    }
    setSaving(true);
    setUploadingAvatar(!!pendingAvatar);
    try {
      // 1. Upload pending avatar to Supabase Storage (if any)
      let newAvatarUrl: string | null = avatarUrl;
      if (pendingAvatar && user) {
        const resp = await fetch(pendingAvatar.uri);
        const buf = await resp.arrayBuffer();
        const { publicUrl } = await uploadAvatar(user.id, buf, pendingAvatar.ext);
        newAvatarUrl = publicUrl;
      }

      // 2. Best-effort cloud sync (avatar + display name only)
      if (user) {
        const { error } = await supabase
          .from('profiles')
          .update({
            display_name: displayName.trim() || null,
            avatar_url: newAvatarUrl,
            updated_at: new Date().toISOString(),
          })
          .eq('id', user.id);
        if (error) {
          console.warn('[profile-edit] cloud sync failed', error.message);
          Alert.alert('云端同步失败', `${error.message}\n本地修改已保存。`);
        } else {
          setAvatarUrl(newAvatarUrl);
          setPendingAvatar(null);
          await refreshProfile();
        }
      } else {
        setAvatarUrl(newAvatarUrl);
        setPendingAvatar(null);
      }

      router.back();
    } catch (e) {
      const msg = e instanceof Error ? e.message : '保存失败';
      Alert.alert('保存失败', msg);
    } finally {
      setUploadingAvatar(false);
      setSaving(false);
    }
  }, [displayName, user, refreshProfile, router, avatarUrl, pendingAvatar]);

  return (
    <View style={styles.container}>
      {/* Top bar */}
      <View style={[styles.header, { paddingTop: insets.top + 6 }]}>
        <Pressable style={styles.backBtn} onPress={() => router.back()}>
          <ChevronLeft size={20} color={colors.text.primary} />
        </Pressable>
        <Text style={styles.headerTitle} numberOfLines={1}>编辑资料</Text>
        <Pressable
          style={[styles.saveBtn, (!hydrated || saving) && styles.saveBtnDisabled]}
          onPress={handleSave}
          disabled={!hydrated || saving}
        >
          {saving ? (
            <ActivityIndicator size="small" color={colors.text.primary} />
          ) : (
            <Check size={20} color={colors.text.primary} />
          )}
        </Pressable>
      </View>

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={[styles.scrollContent, { paddingBottom: insets.bottom + 32 }]}
        showsVerticalScrollIndicator={false}
      >
        {/* Avatar */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>头像</Text>
          <Text style={styles.sectionHint}>
            {user
              ? pendingAvatar
                ? '新头像已选，点右上角 ✓ 保存后生效'
                : '点击更换头像（最多 5MB）'
              : '登录后才能上传头像'}
          </Text>
          <View style={styles.avatarRow}>
            <View style={styles.avatarPreview}>
              {pendingAvatar ? (
                <Image source={{ uri: pendingAvatar.uri }} style={styles.avatarPreviewImage} />
              ) : avatarUrl ? (
                <Image source={{ uri: avatarUrl }} style={styles.avatarPreviewImage} />
              ) : (
                <Text style={styles.avatarPreviewText}>
                  {(displayName || user?.email || '?').slice(0, 1).toUpperCase()}
                </Text>
              )}
            </View>
            <View style={styles.avatarActions}>
              <Pressable
                style={styles.avatarBtn}
                onPress={handlePickAvatar}
                disabled={!user || uploadingAvatar}
              >
                <Camera size={18} color={colors.text.primary} />
                <Text style={styles.avatarBtnText}>
                  {pendingAvatar ? '重新选择' : avatarUrl ? '更换头像' : '上传头像'}
                </Text>
              </Pressable>
              {pendingAvatar ? (
                <Pressable
                  style={[styles.avatarBtn, styles.avatarBtnGhost]}
                  onPress={handleClearPendingAvatar}
                  disabled={uploadingAvatar}
                >
                  <X size={18} color={colors.text.tertiary} />
                  <Text style={[styles.avatarBtnText, styles.avatarBtnTextGhost]}>取消</Text>
                </Pressable>
              ) : null}
            </View>
          </View>
        </View>

        {/* Display name */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>昵称</Text>
          <Text style={styles.sectionHint}>
            {user ? `邮箱：${user.email}` : '当前未登录，仅保存到本地'}
          </Text>
          <TextInput
            style={styles.input}
            value={displayName}
            onChangeText={setDisplayName}
            placeholder="昵称"
            placeholderTextColor={colors.text.tertiary}
            maxLength={32}
          />
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },

  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.md,
    gap: spacing.sm,
  },
  backBtn: {
    width: 36, height: 36, borderRadius: borderRadius.full,
    backgroundColor: colors.surface,
    alignItems: 'center', justifyContent: 'center',
    borderWidth: 1, borderColor: colors.border.light,
  },
  headerTitle: {
    flex: 1,
    color: colors.text.primary,
    fontSize: fontSize.lg,
    fontWeight: fontWeight.bold,
  },
  saveBtn: {
    width: 36, height: 36, borderRadius: borderRadius.full,
    backgroundColor: colors.surface,
    alignItems: 'center', justifyContent: 'center',
    borderWidth: 1, borderColor: colors.border.light,
  },
  saveBtnDisabled: { opacity: 0.5 },

  scroll: { flex: 1 },
  scrollContent: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    gap: spacing.lg,
  },

  section: { gap: spacing.sm },
  sectionTitle: {
    fontSize: fontSize.base,
    fontWeight: fontWeight.bold,
    color: colors.text.primary,
  },
  sectionHint: {
    fontSize: fontSize.sm,
    color: colors.text.tertiary,
    lineHeight: 20,
  },

  input: {
    backgroundColor: colors.surface,
    borderRadius: borderRadius.lg,
    borderWidth: 1,
    borderColor: colors.border.light,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    fontSize: fontSize.base,
    color: colors.text.primary,
  },

  avatarRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.lg,
  },
  avatarPreview: {
    width: 80,
    height: 80,
    borderRadius: borderRadius.full,
    backgroundColor: colors.surfaceSecondary,
    borderWidth: 1,
    borderColor: colors.border.light,
    justifyContent: 'center',
    alignItems: 'center',
    overflow: 'hidden',
  },
  avatarPreviewImage: {
    width: '100%',
    height: '100%',
  },
  avatarPreviewText: {
    fontSize: 32,
    fontWeight: fontWeight.bold,
    color: colors.text.tertiary,
  },
  avatarActions: {
    flex: 1,
    gap: spacing.sm,
  },
  avatarBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.xs,
    paddingVertical: 10,
    borderRadius: borderRadius.lg,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border.light,
  },
  avatarBtnGhost: {
    backgroundColor: 'transparent',
  },
  avatarBtnText: {
    fontSize: fontSize.sm,
    fontWeight: fontWeight.semibold,
    color: colors.text.primary,
  },
  avatarBtnTextGhost: {
    color: colors.text.tertiary,
  },
});
