import { useState } from 'react';
import { Button } from '../../components/Button';
import { supabase } from '../../lib/supabase';
import { friendlyAuthError } from './authErrors';

export function GoogleButton({ next, onError }: { next?: string; onError: (message: string) => void }) {
  const [loading, setLoading] = useState(false);

  const signIn = async () => {
    setLoading(true);
    const redirectTo = new URL('/auth/callback', window.location.origin);
    if (next) redirectTo.searchParams.set('next', next);
    const { error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: redirectTo.toString() },
    });
    // On success the browser leaves the page.
    if (error) {
      setLoading(false);
      onError(friendlyAuthError(error));
    }
  };

  return (
    <Button size="lg" block loading={loading} onClick={signIn} icon={<GoogleG />}>
      Continue with Google
    </Button>
  );
}

function GoogleG() {
  return (
    <svg className="google-icon" viewBox="0 0 18 18" aria-hidden="true">
      <path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62Z" />
      <path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.8.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.33A9 9 0 0 0 9 18Z" />
      <path fill="#FBBC05" d="M3.97 10.72A5.41 5.41 0 0 1 3.68 9c0-.6.1-1.18.29-1.72V4.95H.96A9 9 0 0 0 0 9c0 1.45.35 2.83.96 4.05l3.01-2.33Z" />
      <path fill="#EA4335" d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.58A9 9 0 0 0 .96 4.95l3.01 2.33C4.68 5.16 6.66 3.58 9 3.58Z" />
    </svg>
  );
}
