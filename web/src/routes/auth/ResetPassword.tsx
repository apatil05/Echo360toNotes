import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import { Button } from '../../components/Button';
import { Field } from '../../components/Field';
import { Message } from '../../components/Message';
import { useAuth } from '../../data/authContext';
import { supabase } from '../../lib/supabase';
import { AuthLayout } from './AuthLayout';
import { friendlyAuthError } from './authErrors';

export function ResetPassword() {
  const { session, loading: authLoading } = useAuth();
  const navigate = useNavigate();
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (password.length < 8) return setError('Use at least 8 characters.');
    setError(null);
    setLoading(true);
    const { error: updateError } = await supabase.auth.updateUser({ password });
    setLoading(false);
    if (updateError) setError(friendlyAuthError(updateError));
    else navigate('/', { replace: true });
  };

  if (!authLoading && !session) {
    return (
      <AuthLayout>
        <div className="auth-heading">
          <h1>This link has expired</h1>
          <p>Reset links work once and for a limited time. Ask for a new one.</p>
        </div>
        <p className="auth-switch"><Link to="/forgot-password">Send a new reset link</Link></p>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout>
      <div className="auth-heading">
        <h1>Choose a new password</h1>
        <p>You’ll stay signed in on this device.</p>
      </div>
      {error && <Message tone="bad">{error}</Message>}
      <form className="auth-fields" onSubmit={submit} noValidate>
        <Field label="New password" revealable autoComplete="new-password" minLength={8} required value={password} onChange={(e) => setPassword(e.target.value)} hint="At least 8 characters." />
        <Button type="submit" variant="primary" size="lg" block loading={loading || authLoading}>
          Save password
        </Button>
      </form>
    </AuthLayout>
  );
}
