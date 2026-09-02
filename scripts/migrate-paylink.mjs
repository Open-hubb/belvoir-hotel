// A short, scannable stand-in for the Flot payment URL.
//
//   node scripts/migrate-paylink.mjs
//
// Flot's link carries a JWT in the path and runs to ~1,130 characters. Encoded
// as a QR that is 113 modules, which at any size that fits a phone screen comes
// out around 2.4px a module — below what a camera can read, as a decoder
// confirmed. Pointing the QR at a short code on our own domain instead drops it
// to 29 modules and roughly 8px a module.
//
// Idempotent: only adds a column and an index.

import { readFileSync } from 'fs';
import { neon } from '@neondatabase/serverless';
import { deduplicatePaymentAttempts } from './payment-attempt-dedupe.mjs';

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

await sql`ALTER TABLE payments ADD COLUMN IF NOT EXISTS short_code text`;
await sql`ALTER TABLE payments ADD COLUMN IF NOT EXISTS pay_link text`;
await sql`ALTER TABLE payments ADD COLUMN IF NOT EXISTS provider_raw text`;
await sql`ALTER TABLE payments ADD COLUMN IF NOT EXISTS completed_at timestamptz`;
console.log('  payment link and provider audit columns ready');

// Keep the row that carries the local payment link when historical webhook and
// link writes produced the same provider pair twice. Preserve a completed
// status and matched flag before enforcing provider-attempt identity.
await deduplicatePaymentAttempts(sql);

await sql`
  CREATE UNIQUE INDEX IF NOT EXISTS payments_provider_attempt_unique
  ON payments (reference, provider_ref)
  WHERE provider_ref IS NOT NULL`;
console.log('  provider payment attempts deduplicated and constrained');

// The code is the only thing standing between a stranger and someone's payment
// page, so it must be unique and is generated with 48 bits of randomness.
await sql`
  CREATE UNIQUE INDEX IF NOT EXISTS payments_short_code
  ON payments (short_code) WHERE short_code IS NOT NULL`;
console.log('  unique index on short_code ready');

const n = await sql`SELECT count(*)::int AS n FROM payments WHERE short_code IS NOT NULL`;
console.log(`\n  rows with a short code: ${n[0].n}`);
