// Admin accounts and sessions.
//
//   node scripts/migrate-auth.mjs
//
// Idempotent: safe to run repeatedly and safe to run against a live database,
// since it only adds tables.

import { readFileSync } from 'fs';
import { neon } from '@neondatabase/serverless';

for (const f of ['.env.local', '.env']) {
  try {
    for (const line of readFileSync(f, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z_]+)\s*=\s*"?([^"\n]+)"?\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
    }
  } catch {}
}

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set.');
  process.exit(1);
}

const sql = neon(process.env.DATABASE_URL);

await sql`
  CREATE TABLE IF NOT EXISTS admin_users (
    id            serial PRIMARY KEY,
    email         text NOT NULL,
    password_hash text NOT NULL,
    name          text NOT NULL DEFAULT '',
    role          text NOT NULL DEFAULT 'manager',
    disabled      boolean NOT NULL DEFAULT false,
    created_at    timestamptz NOT NULL DEFAULT now(),
    last_login_at timestamptz
  )`;
console.log('  admin_users ready');

// Email is the login, so it must be unique regardless of how it was typed.
await sql`
  CREATE UNIQUE INDEX IF NOT EXISTS admin_users_email_lower
  ON admin_users (lower(email))`;
console.log('  unique index on lower(email) ready');

// Only the SHA-256 of a session token is stored, so a copy of this table does
// not let anyone sign in. Deleting a row revokes the session immediately.
await sql`
  CREATE TABLE IF NOT EXISTS admin_sessions (
    token_hash text PRIMARY KEY,
    user_id    integer NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL,
    user_agent text
  )`;
console.log('  admin_sessions ready');

await sql`CREATE INDEX IF NOT EXISTS admin_sessions_user ON admin_sessions (user_id)`;
await sql`CREATE INDEX IF NOT EXISTS admin_sessions_expiry ON admin_sessions (expires_at)`;
console.log('  session indexes ready');

const users = await sql`SELECT count(*)::int AS n FROM admin_users`;
console.log(`\n  existing admin accounts: ${users[0].n}`);
if (users[0].n === 0) {
  console.log('  next: node scripts/create-admin.mjs');
}

// ── durable rate limiting ─────────────────────────────────────────────────
// The in-memory limiter is per function instance, so on serverless a burst
// spread across cold starts slips through. That is tolerable for booking spam
// and not tolerable for guessing a password, so the counter lives in Postgres
// where every instance shares it.
await sql`
  CREATE TABLE IF NOT EXISTS rate_limits (
    bucket       text PRIMARY KEY,
    hits         integer NOT NULL DEFAULT 0,
    window_start timestamptz NOT NULL DEFAULT now()
  )`;
await sql`CREATE INDEX IF NOT EXISTS rate_limits_window ON rate_limits (window_start)`;
console.log('  rate_limits ready');
