import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { Button } from '../../components/Button';
import { Field } from '../../components/Field';
import { Message } from '../../components/Message';
import { supabase } from '../../lib/supabase';
import { AuthLayout } from './AuthLayout';
import { GoogleButton } from './GoogleButton';
import { friendlyAuthError } from './authErrors';
import { safeNext } from './safeNext';

export function SignIn() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const next = safeNext(params.get('next'));
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<{ email?: string; password?: string }>({});
  const [loading, setLoading] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const missing = {
      email: email.trim() ? undefined : 'Enter your email address.',
      password: password ? undefined : 'Enter your password.',
    };
    setFieldErrors(missing);
    if (missing.email || missing.password) return;
    setError(null);
    setLoading(true);
    const { error: signInError } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
    setLoading(false);
    if (signInError) setError(friendlyAuthError(signInError));
    else navigate(next, { replace: true });
  };

  return (
    <AuthLayout>
      <div className="auth-heading">
        <h1>Welcome back</h1>
        <p>Sign in to your lecture library.</p>
      </div>

      {error && <Message tone="bad">{error}</Message>}

      <GoogleButton next={next} onError={setError} />
      <div className="auth-divider">or with email</div>

      <form className="auth-fields" onSubmit={submit} noValidate>
        <Field label="Email" type="email" autoComplete="email" required value={email} error={fieldErrors.email} onChange={(e) => { setEmail(e.target.value); setFieldErrors((f) => ({ ...f, email: undefined })); }} />
        <Field label="Password" revealable autoComplete="current-password" required value={password} error={fieldErrors.password} onChange={(e) => { setPassword(e.target.value); setFieldErrors((f) => ({ ...f, password: undefined })); }} />
        <div className="auth-row">
          <span />
          <Link to="/forgot-password">Forgot password?</Link>
        </div>
        <Button type="submit" variant="primary" size="lg" block loading={loading}>
          Sign in
        </Button>
      </form>

      <p className="auth-switch">
        New here? <Link to={`/sign-up${next !== '/' ? `?next=${encodeURIComponent(next)}` : ''}`}>Create an account</Link>
      </p>
    </AuthLayout>
  );
}
