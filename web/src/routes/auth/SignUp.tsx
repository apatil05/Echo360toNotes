import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import { MailCheck } from 'lucide-react';
import { Button } from '../../components/Button';
import { Field } from '../../components/Field';
import { Message } from '../../components/Message';
import { supabase } from '../../lib/supabase';
import { AuthLayout } from './AuthLayout';
import { GoogleButton } from './GoogleButton';
import { friendlyAuthError } from './authErrors';

const MIN_PASSWORD = 8;

export function SignUp() {
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);
  const [emailError, setEmailError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [sentTo, setSentTo] = useState<string | null>(null);

  const passwordError = touched && password.length < MIN_PASSWORD
    ? (password ? `Use at least ${MIN_PASSWORD} characters.` : 'Choose a password.')
    : null;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setTouched(true);
    setEmailError(email.trim() ? null : 'Enter your email address.');
    if (!email.trim() || password.length < MIN_PASSWORD) return;
    setError(null);
    setLoading(true);
    const { data, error: signUpError } = await supabase.auth.signUp({
      email: email.trim(),
      password,
      options: {
        data: { full_name: name.trim() || undefined },
        emailRedirectTo: `${window.location.origin}/auth/callback?next=/welcome`,
      },
    });
    setLoading(false);
    if (signUpError) return setError(friendlyAuthError(signUpError));
    // With email confirmation on, there's no session until the link is clicked.
    if (data.session) navigate('/welcome', { replace: true });
    else setSentTo(email.trim());
  };

  if (sentTo) {
    return (
      <AuthLayout>
        <div className="auth-heading">
          <MailCheck size={32} strokeWidth={1.75} color="var(--accent)" aria-hidden="true" />
          <h1>Check your inbox</h1>
          <p>We sent a confirmation link to <strong>{sentTo}</strong>. Open it on this device to finish setting up.</p>
        </div>
        <p className="auth-switch">
          Wrong address? <button type="button" className="auth-linklike" onClick={() => setSentTo(null)}>Start again</button>
        </p>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout>
      <div className="auth-heading">
        <h1>Create your account</h1>
        <p>Your notes, keys and linked browsers live in your account.</p>
      </div>

      {error && <Message tone="bad">{error}</Message>}

      <GoogleButton next="/welcome" onError={setError} />
      <div className="auth-divider">or with email</div>

      <form className="auth-fields" onSubmit={submit} noValidate>
        <Field label="Name" autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} hint="Optional. Used to greet you." />
        <Field label="Email" type="email" autoComplete="email" required value={email} error={emailError} onChange={(e) => { setEmail(e.target.value); setEmailError(null); }} />
        <Field
          label="Password"
          revealable
          autoComplete="new-password"
          required
          minLength={MIN_PASSWORD}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          onBlur={() => setTouched(true)}
          hint={`At least ${MIN_PASSWORD} characters.`}
          error={passwordError}
        />
        <Button type="submit" variant="primary" size="lg" block loading={loading}>
          Create account
        </Button>
      </form>

      <p className="auth-switch">
        Already have an account? <Link to="/sign-in">Sign in</Link>
      </p>
    </AuthLayout>
  );
}
