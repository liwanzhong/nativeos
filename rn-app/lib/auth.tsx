/**
 * Auth context — single source of truth for the signed-in user and
 * the cloud-side profile row. Used by the profile tab, login screen,
 * profile-edit screen, and any other UI that needs to react to auth
 * state.
 *
 * Lifecycle:
 *   - on mount, restore any persisted session from AsyncStorage
 *     (Supabase client already does this with persistSession: true)
 *   - on auth state change, update user
 *   - when user is set, fetch / refresh the profiles row
 *
 * The Supabase client has `persistSession: true` + `storage: AsyncStorage`
 * so the session survives app restarts.
 */

import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { Session, User } from '@supabase/supabase-js';
import { supabase } from './supabase';

export interface CloudProfile {
  id: string;
  email: string;
  displayName: string | null;
  level: string;
  interests: string[];
  profession: string | null;
  cardCount: number;
  avatarUrl: string | null;
  createdAt: string;
  updatedAt: string;
}

interface AuthContextValue {
  user: User | null;
  profile: CloudProfile | null;
  loading: boolean;
  /** True when the Supabase URL/key are configured. When false, signIn/up are no-ops. */
  isAuthAvailable: boolean;
  signOut: () => Promise<void>;
  refreshProfile: () => Promise<void>;
  /** Persists the cloud profile back to the local user_profile SQLite row. */
  pullProfileToLocal: (profile: CloudProfile) => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

function rowToProfile(row: Record<string, unknown>): CloudProfile {
  return {
    id: row.id as string,
    email: row.email as string,
    displayName: (row.display_name as string | null) ?? null,
    level: (row.level as string) ?? 'B1',
    interests: Array.isArray(row.interests) ? (row.interests as string[]) : [],
    profession: (row.profession as string | null) ?? null,
    cardCount: typeof row.card_count === 'number' ? (row.card_count as number) : 0,
    avatarUrl: (row.avatar_url as string | null) ?? null,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const isAuthAvailable = useMemo(() => {
    // The supabase stub returned from lib/supabase.ts when env vars are missing
    // has empty auth, so signInWithOtp would throw. Detect by trying to read
    // the current session and see if it has a real auth object.
    return typeof (supabase as any).auth?.getSession === 'function';
  }, []);

  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<CloudProfile | null>(null);
  const [loading, setLoading] = useState(true);

  const user = session?.user ?? null;

  // Load profile from public.profiles
  const fetchProfile = useCallback(async (uid: string) => {
    if (!isAuthAvailable) return null;
    const { data, error } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', uid)
      .maybeSingle();
    if (error) {
      console.warn('[auth] fetch profile failed', error.message);
      return null;
    }
    if (!data) return null;
    return rowToProfile(data as Record<string, unknown>);
  }, [isAuthAvailable]);

  const refreshProfile = useCallback(async () => {
    if (!user) {
      setProfile(null);
      return;
    }
    const next = await fetchProfile(user.id);
    setProfile(next);
  }, [user, fetchProfile]);

  // Pull cloud profile into local SQLite (overwrites the local user_profile row)
  const pullProfileToLocal = useCallback(async (cloud: CloudProfile) => {
    const { updateUserProfile } = await import('./user-profile');
    await updateUserProfile({
      level: cloud.level as any,
      interests: cloud.interests,
      profession: cloud.profession ?? undefined,
    });
  }, []);

  // Initial session restore
  useEffect(() => {
    if (!isAuthAvailable) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    (async () => {
      const { data, error } = await supabase.auth.getSession();
      if (cancelled) return;
      if (error) console.warn('[auth] getSession failed', error.message);
      setSession(data?.session ?? null);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [isAuthAvailable]);

  // Listen for auth state changes
  useEffect(() => {
    if (!isAuthAvailable) return;
    const { data: sub } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession);
    });
    return () => {
      sub.subscription.unsubscribe();
    };
  }, [isAuthAvailable]);

  // Fetch profile whenever the user changes
  useEffect(() => {
    if (!user) {
      setProfile(null);
      return;
    }
    (async () => {
      const next = await fetchProfile(user.id);
      setProfile(next);
      // On login, mirror the cloud profile into the local user_profile row
      // so the rest of the app picks up the synced values.
      if (next) {
        try {
          await pullProfileToLocal(next);
        } catch (err) {
          console.warn('[auth] pullProfileToLocal failed', err);
        }
      }
      // Pull latest quota config + Pro state from Supabase, and merge
      // today's usage counter with the server-side snapshot so a
      // reinstall doesn't reset the global count.
      try {
        const { refreshQuotaConfigFromSupabase, mergeQuotaSnapshotOnLogin } = await import('./quota');
        await refreshQuotaConfigFromSupabase();
        await mergeQuotaSnapshotOnLogin();
      } catch (err) {
        console.warn('[auth] quota sync on login failed', err);
      }
    })();
  }, [user, fetchProfile, pullProfileToLocal]);

  const signOut = useCallback(async () => {
    if (!isAuthAvailable) return;
    await supabase.auth.signOut();
  }, [isAuthAvailable]);

  const value: AuthContextValue = {
    user,
    profile,
    loading,
    isAuthAvailable,
    signOut,
    refreshProfile,
    pullProfileToLocal,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error('useAuth must be used inside <AuthProvider>');
  }
  return ctx;
}
