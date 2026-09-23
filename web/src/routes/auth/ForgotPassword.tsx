import { useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { MailCheck } from 'lucide-react';
import { Button } from '../../components/Button';
import { Field } from '../../components/Field';
import { Message } from '../../components/Message';
import { supabase } from '../../lib/supabase';
import { AuthLayout } from './AuthLayout';
import { friendlyAuthError } from './authErrors';

export function ForgotPassword() {
  const [email, setEmail] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [emailError, setEmailError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!email.trim()) return setEmailError('Enter the email address you signed up with.');
    setError(null);
    setLoading(true);
    const { error: resetError } = await supabase.auth.resetPasswordForEmail(email.trim(), {
      redirectTo: `${window.location.origin}/reset-password`,
    });
    setLoading(false);
    if (resetError) setError(friendlyAuthError(resetError));
    else setSent(true);
  };

  return (
    <AuthLayout>
      {sent ? (
        <div className="auth-heading">
          <MailCheck size={32} strokeWidth={1.75} color="var(--accent)" aria-hidden="true" />
          <h1>Check your inbox</h1>
          <p>If an account exists for <strong>{email.trim()}</strong>, a reset link is on its way.</p>
        </div>
      ) : (
        <>
          <div className="auth-heading">
            <h1>Reset your password</h1>
            <p>We’ll email you a link to choose a new one.</p>
          </div>
          {error && <Message tone="bad">{error}</Message>}
          <form className="auth-fields" onSubmit={submit} noValidate>
            <Field label="Email" type="email" autoComplete="email" required value={email} error={emailError} onChange={(e) => { setEmail(e.target.value); setEmailError(null); }} />
            <Button type="submit" variant="primary" size="lg" block loading={loading}>
              Send reset link
            </Button>
          </form>
        </>
      )}
      <p className="auth-switch"><Link to="/sign-in">Back to sign in</Link></p>
    </AuthLayout>
  );
}
