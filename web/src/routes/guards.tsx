import type { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router';
import { useAuth } from '../data/authContext';
import { Wordmark } from '../components/Wordmark';
import { Button } from '../components/Button';
import { Message } from '../components/Message';

function Loading() {
  return (
    <div className="boot" aria-busy="true" aria-label="Loading">
      <Wordmark compact />
    </div>
  );
}

/** Accounts are mandatory: nothing is visible signed out. */
export function RequireAuth({ children }: { children: ReactNode }) {
  const { session, profile, loading, profileError, refreshProfile, signOut } = useAuth();
  const location = useLocation();
  if (session && !profile && profileError) {
    return (
      <div className="boot">
        <div className="boot-error">
          <Message tone="bad" title="Couldn’t load your account">{profileError}</Message>
          <div className="step-actions">
            <Button variant="ghost" onClick={signOut}>Sign out</Button>
            <Button variant="primary" onClick={refreshProfile}>Try again</Button>
          </div>
        </div>
      </div>
    );
  }
  if (loading || (session && !profile)) return <Loading />;
  if (!session) {
    const next = location.pathname === '/' ? '' : `?next=${encodeURIComponent(location.pathname + location.search)}`;
    return <Navigate to={`/sign-in${next}`} replace />;
  }
  return children;
}

/** The setup wizard runs before the library appears. */
export function RequireOnboarded({ children }: { children: ReactNode }) {
  const { profile } = useAuth();
  if (!profile?.onboarding.completed_at) return <Navigate to="/welcome" replace />;
  return children;
}

/** Signed-in students skip the auth pages. */
export function RedirectIfSignedIn({ children }: { children: ReactNode }) {
  const { session, loading } = useAuth();
  if (loading) return <Loading />;
  if (session) return <Navigate to="/" replace />;
  return children;
}
