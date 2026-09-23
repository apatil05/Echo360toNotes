#!/bin/sh
# Runs a command with the local Supabase URL and keys from `supabase status`.
set -eu
cd "$(dirname "$0")/../.."
status=$(supabase status -o env) || { echo "Local Supabase isn't running. Start it with: supabase start" >&2; exit 1; }
value() { printf '%s\n' "$status" | sed -n "s/^$1=\"\{0,1\}\([^\"]*\)\"\{0,1\}$/\1/p"; }
SUPABASE_URL=$(value API_URL)
SUPABASE_SECRET_KEY=$(value SECRET_KEY)
SUPABASE_PUBLISHABLE_KEY=$(value PUBLISHABLE_KEY)
export SUPABASE_URL SUPABASE_SECRET_KEY SUPABASE_PUBLISHABLE_KEY
cd infra
exec "$@"
