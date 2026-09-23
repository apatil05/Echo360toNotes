/** Supabase Auth messages rewritten as problem + recovery. */
export function friendlyAuthError(err: unknown): string {
  const msg = (err as { message?: string })?.message ?? String(err);
  if (/invalid login credentials/i.test(msg)) return "That email and password don't match. Check both, or reset your password.";
  if (/already registered|already been registered/i.test(msg)) return 'An account with this email already exists. Sign in instead.';
  if (/email not confirmed/i.test(msg)) return 'Confirm your email first. The link is in your inbox.';
  if (/provider is not enabled|unsupported provider/i.test(msg)) return "Google sign-in isn't switched on yet. Use your email for now.";
  if (/rate limit|too many/i.test(msg)) return 'Too many attempts. Wait a minute, then try again.';
  if (/password should be|weak password/i.test(msg)) return 'Choose a longer password: at least 8 characters.';
  if (/same.*password|different from the old/i.test(msg)) return 'Choose a password you haven’t used for this account before.';
  if (/failed to fetch|network/i.test(msg)) return "Couldn't reach the server. Check your connection and try again.";
  return msg;
}
