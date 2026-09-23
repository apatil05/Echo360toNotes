import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { Session } from '@supabase/supabase-js';
import { supabase } from '../lib/supabase';
import type { Profile } from './types';
import { AuthContext, type AuthState } from './authContext';

const PROFILE_COLUMNS = 'id, display_name, timezone, onboarding, default_notes_provider, default_notes_model';

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);
  const [profileError, setProfileError] = useState<string | null>(null);

  const loadProfile = useCallback(async (userId: string) => {
    const { data, error } = await supabase.from('profiles').select(PROFILE_COLUMNS).eq('id', userId).maybeSingle();
    if (error || !data) {
      setProfileError(error?.message ?? 'Your profile is missing.');
      return;
    }
    setProfileError(null);
    const row = data as Profile | null;
    // Notes are dated in the student's own timezone.
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (row && row.timezone === 'UTC' && tz && tz !== 'UTC') {
      await supabase.from('profiles').update({ timezone: tz }).eq('id', userId);
      row.timezone = tz;
    }
    setProfile(row);
  }, []);

  useEffect(() => {
    let active = true;
    supabase.auth.getSession().then(async ({ data }) => {
      if (!active) return;
      setSession(data.session);
      if (data.session) await loadProfile(data.session.user.id).catch((err) => setProfileError(String(err?.message ?? err)));
      if (active) setLoading(false);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((event, next) => {
      setSession(next);
      if (!next) setProfile(null);
      // Load the profile outside the callback (Supabase warns against awaiting in it).
      else if (event === 'SIGNED_IN' || event === 'USER_UPDATED') {
        setTimeout(() => loadProfile(next.user.id).catch((err) => setProfileError(String(err?.message ?? err))), 0);
      }
    });
    return () => {
      active = false;
      sub.subscription.unsubscribe();
    };
  }, [loadProfile]);

  const value = useMemo<AuthState>(() => ({
    session,
    profile,
    loading,
    profileError,
    refreshProfile: async () => {
      if (session) await loadProfile(session.user.id);
    },
    updateProfile: async (fields) => {
      if (!session) return;
      const { error } = await supabase.from('profiles').update(fields).eq('id', session.user.id);
      if (error) throw error;
      setProfile((p) => (p ? { ...p, ...fields } : p));
    },
    updateOnboarding: async (patch) => {
      if (!session || !profile) return;
      const onboarding = { ...profile.onboarding, ...patch };
      const { error } = await supabase.from('profiles').update({ onboarding }).eq('id', session.user.id);
      if (error) throw error;
      setProfile({ ...profile, onboarding });
    },
    signOut: async () => {
      await supabase.auth.signOut();
    },
  }), [session, profile, loading, profileError, loadProfile]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
