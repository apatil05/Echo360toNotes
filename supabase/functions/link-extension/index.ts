// POST /functions/v1/link-extension
//
// The signed-in web app asks for a one-time sign-in token for its own user and
// hands it to the Chrome extension (which only accepts messages from the app's
// origin). The extension redeems it with verifyOtp and gets its own session,
// so the app and extension never share a refresh token.

import { createClient } from 'npm:@supabase/supabase-js@2';

const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const allowedOrigins = (Deno.env.get('APP_ORIGINS') ?? 'http://localhost:5173')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

const admin = createClient(supabaseUrl, serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

function corsHeaders(origin: string | null): HeadersInit {
  const allowed = origin && allowedOrigins.includes(origin) ? origin : allowedOrigins[0];
  return {
    'access-control-allow-origin': allowed,
    'access-control-allow-headers': 'authorization, x-client-info, apikey, content-type',
    'access-control-allow-methods': 'POST, OPTIONS',
    vary: 'Origin',
  };
}

function json(status: number, body: unknown, origin: string | null) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(origin), 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

Deno.serve(async (req) => {
  const origin = req.headers.get('origin');
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders(origin) });
  if (req.method !== 'POST') return json(405, { error: 'Use POST.' }, origin);
  if (origin && !allowedOrigins.includes(origin)) return json(403, { error: 'Origin not allowed.' }, origin);

  const token = /^Bearer\s+(.+)$/i.exec(req.headers.get('authorization') ?? '')?.[1];
  if (!token) return json(401, { error: 'Sign in first.' }, origin);

  const { data: userData, error: userError } = await admin.auth.getUser(token);
  const user = userData?.user;
  if (userError || !user) return json(401, { error: 'Your session has expired. Sign in again.' }, origin);
  if (!user.email) return json(400, { error: 'This account has no email address to link with.' }, origin);

  const { data, error } = await admin.auth.admin.generateLink({ type: 'magiclink', email: user.email });
  if (error || !data?.properties?.hashed_token) {
    console.error(JSON.stringify({ message: 'generateLink failed', error: error?.message }));
    return json(500, { error: "Couldn't create a link code. Try again." }, origin);
  }

  return json(200, { tokenHash: data.properties.hashed_token, email: user.email }, origin);
});
