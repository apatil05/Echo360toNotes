import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { useAuth } from '../../data/authContext';
import { AuthLayout } from './AuthLayout';
import { safeNext } from './safeNext';

/** Landing page for OAuth and email-confirmation redirects. */
export function AuthCallback() {
  const { session, loading } = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [timedOut, setTimedOut] = useState(false);
  const providerError = params.get('error_description');

  useEffect(() => {
    if (session) navigate(safeNext(params.get('next')), { replace: true });
  }, [session, navigate, params]);

  useEffect(() => {
    const t = setTimeout(() => setTimedOut(true), 8000);
    return () => clearTimeout(t);
  }, []);

  const failed = providerError || (!loading && timedOut && !session);

  return (
    <AuthLayout>
      <div className="auth-heading" aria-live="polite">
        <h1>{failed ? "Couldn't sign you in" : 'Signing you in…'}</h1>
        {failed && <p>{providerError ?? 'The sign-in link may have expired.'} Try again from the sign-in page.</p>}
      </div>
      {failed && <p className="auth-switch"><Link to="/sign-in">Back to sign in</Link></p>}
    </AuthLayout>
  );
}
