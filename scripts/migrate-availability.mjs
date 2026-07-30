// Adds everything needed to stop double bookings.
//
// Run once against each environment:
//   node --env-file=.env.local scripts/migrate-availability.mjs
//
// Safe to re-run: every statement is guarded.

import { neon } from '@neondatabase/serverless';

const sql = neon(process.env.DATABASE_URL);
const step = async (label, fn) => {
  try {
    await fn();
    console.log('  ok   ' + label);
  } catch (e) {
    console.log('  FAIL ' + label + '  ->  ' + e.message.split('\n')[0]);
    throw e;
  }
};

console.log('Availability migration\n');

// A booking that is cancelled must stop holding its dates, so the lifecycle
// needs to be separate from whether it has been paid.
await step('bookings.status column', async () => {
  await sql`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active'`;
});

await step('bookings.cancelled_at column', async () => {
  await sql`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS cancelled_at timestamptz`;
});

// A short human reference a guest can quote. Generated from the id so it is
// stable and needs no extra state.
await step('bookings.reference column', async () => {
  await sql`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS reference text`;
  await sql`UPDATE bookings SET reference = 'BLV-' || LPAD(id::text, 5, '0') WHERE reference IS NULL`;
});

// Rooms taken out of service for maintenance also have to block availability.
await step('room_blocks table', async () => {
  await sql`
    CREATE TABLE IF NOT EXISTS room_blocks (
      id serial PRIMARY KEY,
      room_key text NOT NULL,
      starts date NOT NULL,
      ends date NOT NULL,
      reason text,
      created_at timestamptz NOT NULL DEFAULT now(),
      CHECK (ends > starts)
    )`;
});

// btree_gist lets an exclusion constraint mix equality on room_key with
// overlap on a date range.
await step('btree_gist extension', async () => {
  await sql`CREATE EXTENSION IF NOT EXISTS btree_gist`;
});

// Report anything that would violate the constraint before we add it.
await step('check existing rows for overlaps', async () => {
  const clashes = await sql`
    SELECT a.id AS a_id, b.id AS b_id, a.room_key, a.checkin, a.checkout
    FROM bookings a JOIN bookings b
      ON a.room_key = b.room_key AND a.id < b.id
     AND daterange(a.checkin, a.checkout, '[)') && daterange(b.checkin, b.checkout, '[)')
    WHERE a.status = 'active' AND b.status = 'active'
      AND a.stage = 'checkout' AND b.stage = 'checkout'`;
  if (clashes.length) {
    console.log('\n  Existing overlapping bookings must be resolved first:');
    clashes.forEach(c => console.log(`    #${c.a_id} clashes with #${c.b_id} on ${c.room_key} (${c.checkin} to ${c.checkout})`));
    throw new Error(clashes.length + ' existing overlap(s)');
  }
});

// The real guarantee. Two requests racing for the same room and dates cannot
// both commit, because Postgres refuses the second regardless of timing.
// Half-open '[)' means one guest checking out on the day another checks in
// is not a clash.
await step('exclusion constraint on bookings', async () => {
  const exists = await sql`
    SELECT 1 FROM pg_constraint WHERE conname = 'bookings_no_overlap'`;
  if (exists.length) return;
  await sql`
    ALTER TABLE bookings ADD CONSTRAINT bookings_no_overlap
    EXCLUDE USING gist (
      room_key WITH =,
      daterange(checkin, checkout, '[)') WITH &&
    ) WHERE (status = 'active' AND stage = 'checkout')`;
});

await step('exclusion constraint on room_blocks', async () => {
  const exists = await sql`
    SELECT 1 FROM pg_constraint WHERE conname = 'room_blocks_no_overlap'`;
  if (exists.length) return;
  await sql`
    ALTER TABLE room_blocks ADD CONSTRAINT room_blocks_no_overlap
    EXCLUDE USING gist (
      room_key WITH =,
      daterange(starts, ends, '[)') WITH &&
    )`;
});

await step('index for availability lookups', async () => {
  await sql`CREATE INDEX IF NOT EXISTS bookings_room_dates
            ON bookings (room_key, checkin, checkout)
            WHERE status = 'active' AND stage = 'checkout'`;
});

console.log('\nDone.');
