import { createContext, useContext } from 'react';
import type { Session } from '@supabase/supabase-js';
import type { Onboarding, Profile } from './types';

export interface AuthState {
  session: Session | null;
  profile: Profile | null;
  /** True until the first session (and profile, when signed in) has loaded. */
  loading: boolean;
  /** Set when the profile couldn't be loaded for a signed-in student. */
  profileError: string | null;
  refreshProfile: () => Promise<void>;
  updateProfile: (fields: Partial<Pick<Profile, 'display_name' | 'timezone' | 'default_notes_provider' | 'default_notes_model'>>) => Promise<void>;
  updateOnboarding: (patch: Partial<Onboarding>) => Promise<void>;
  signOut: () => Promise<void>;
}

export const AuthContext = createContext<AuthState | null>(null);

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}
