// Adds the schema and transactional functions for multi-unit room inventory.
//
// Run once against each environment during the controlled rollout:
//   node --env-file=.env.local scripts/migrate-availability.mjs
//
// Safe to re-run: schema changes are guarded, capacities are upserted, and
// functions are replaced in place.

import { neon } from '@neondatabase/serverless';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { ROOMS } = require('../api/_rooms.js');

const databaseUrl = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL_UNPOOLED or DATABASE_URL is required');
const sql = neon(databaseUrl);

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

// Keep the lifecycle columns from the original availability migration for
// databases that have not run it yet.
await step('bookings.status column', async () => {
  await sql`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active'`;
});

await step('bookings.cancelled_at column', async () => {
  await sql`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS cancelled_at timestamptz`;
});

await step('bookings.reference column', async () => {
  await sql`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS reference text`;
  await sql`UPDATE bookings SET reference = 'BLV-' || LPAD(id::text, 5, '0') WHERE reference IS NULL`;
});

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

await step('multi-unit inventory schema', async () => {
  await sql`
    CREATE TABLE IF NOT EXISTS room_inventory (
      room_key text PRIMARY KEY,
      capacity integer NOT NULL CHECK (capacity > 0)
    )`;
  await sql`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS hold_expires_at timestamptz`;
  await sql`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS inventory_status text NOT NULL DEFAULT 'unreserved'`;
  await sql`ALTER TABLE room_blocks ADD COLUMN IF NOT EXISTS units integer NOT NULL DEFAULT 1`;
});

await step('inventory constraints', async () => {
  await sql`ALTER TABLE bookings DROP CONSTRAINT IF EXISTS bookings_inventory_status_valid`;
  await sql`
    ALTER TABLE bookings ADD CONSTRAINT bookings_inventory_status_valid
    CHECK (inventory_status IN ('unreserved', 'held', 'reserved', 'conflict'))`;
  await sql`ALTER TABLE room_blocks DROP CONSTRAINT IF EXISTS room_blocks_units_positive`;
  await sql`
    ALTER TABLE room_blocks ADD CONSTRAINT room_blocks_units_positive
    CHECK (units > 0)`;
});

// Exclusion constraints model a capacity of one and must not survive the
// migration to quantity-based inventory.
await step('remove one-unit overlap constraints', async () => {
  await sql`ALTER TABLE bookings DROP CONSTRAINT IF EXISTS bookings_no_overlap`;
  await sql`ALTER TABLE room_blocks DROP CONSTRAINT IF EXISTS room_blocks_no_overlap`;
});

await step('seed room capacities', async () => {
  for (const [roomKey, room] of Object.entries(ROOMS)) {
    if (!Number.isInteger(room.capacity) || room.capacity <= 0) {
      throw new Error(`Invalid capacity for room ${roomKey}`);
    }
    await sql`
      INSERT INTO room_inventory (room_key, capacity)
      VALUES (${roomKey}, ${room.capacity})
      ON CONFLICT (room_key) DO UPDATE SET capacity = EXCLUDED.capacity`;
  }
});

// Reruns intentionally touch only the legacy state. A current hold, conflict,
// or reservation must never be rewritten by the migration.
await step('backfill paid booking inventory', async () => {
  await sql`
    UPDATE bookings
    SET inventory_status = 'reserved'
    WHERE status = 'active'
      AND payment_status = 'paid'
      AND inventory_status = 'unreserved'`;
});

// Availability is evaluated per occupied night. Half-open dates allow a new
// guest to check in on the date the previous guest checks out.
await step('shared room availability function', async () => {
  await sql`
    CREATE OR REPLACE FUNCTION belvoir_room_availability(
      p_checkin date,
      p_checkout date,
      p_room_key text DEFAULT NULL,
      p_exclude_booking_id bigint DEFAULT NULL
    )
    RETURNS TABLE(room_key text, capacity integer, remaining integer)
    LANGUAGE sql STABLE AS $$
      WITH nights AS (
        SELECT day::date AS night
        FROM generate_series(p_checkin, p_checkout - 1, interval '1 day') AS day
      ), nightly AS (
        SELECT i.room_key, i.capacity, n.night,
          (
            SELECT count(*)::integer
            FROM bookings b
            WHERE b.room_key = i.room_key
              AND b.id IS DISTINCT FROM p_exclude_booking_id
              AND b.status = 'active'
              AND b.checkin <= n.night AND b.checkout > n.night
              AND (
                b.inventory_status = 'reserved'
                OR (b.inventory_status = 'held' AND b.hold_expires_at > now())
              )
          ) + COALESCE((
            SELECT sum(rb.units)::integer
            FROM room_blocks rb
            WHERE rb.room_key = i.room_key
              AND rb.starts <= n.night AND rb.ends > n.night
          ), 0) AS used
        FROM room_inventory i CROSS JOIN nights n
        WHERE p_room_key IS NULL OR i.room_key = p_room_key
      )
      SELECT nightly.room_key, nightly.capacity,
        greatest(0, min(nightly.capacity - nightly.used))::integer AS remaining
      FROM nightly
      GROUP BY nightly.room_key, nightly.capacity
      ORDER BY nightly.room_key;
    $$`;
});

await step('booking hold function', async () => {
  await sql`
    CREATE OR REPLACE FUNCTION belvoir_acquire_booking_hold(
      p_booking_id bigint,
      p_claim_token text,
      p_minutes integer
    )
    RETURNS TABLE(acquired boolean, hold_expires_at timestamptz, remaining integer)
    LANGUAGE plpgsql VOLATILE AS $$
    DECLARE
      v_booking bookings%ROWTYPE;
      v_remaining integer;
      v_expires timestamptz;
    BEGIN
      SELECT * INTO v_booking FROM bookings WHERE id = p_booking_id FOR UPDATE;
      IF NOT FOUND OR v_booking.claim_token IS DISTINCT FROM p_claim_token
         OR v_booking.status <> 'active' THEN
        RETURN QUERY SELECT false, NULL::timestamptz, 0;
        RETURN;
      END IF;

      PERFORM pg_advisory_xact_lock(hashtextextended(v_booking.room_key, 0));
      SELECT a.remaining INTO v_remaining
      FROM belvoir_room_availability(
        v_booking.checkin, v_booking.checkout, v_booking.room_key, v_booking.id
      ) a;

      IF COALESCE(v_remaining, 0) < 1 THEN
        RETURN QUERY SELECT false, NULL::timestamptz, 0;
        RETURN;
      END IF;

      v_expires := now() + make_interval(mins => greatest(1, least(p_minutes, 15)));
      UPDATE bookings SET stage = 'checkout', inventory_status = 'held',
        hold_expires_at = v_expires WHERE id = p_booking_id;
      RETURN QUERY SELECT true, v_expires, greatest(0, v_remaining - 1);
    END;
    $$`;
});

await step('booking settlement function', async () => {
  await sql`
    CREATE OR REPLACE FUNCTION belvoir_settle_booking(p_booking_id bigint)
    RETURNS TABLE(settled boolean, already_paid boolean, inventory_status text)
    LANGUAGE plpgsql VOLATILE AS $$
    DECLARE
      v_booking bookings%ROWTYPE;
      v_remaining integer;
      v_has_live_hold boolean;
    BEGIN
      SELECT * INTO v_booking FROM bookings WHERE id = p_booking_id FOR UPDATE;
      IF NOT FOUND THEN
        RETURN QUERY SELECT false, false, NULL::text;
        RETURN;
      END IF;

      PERFORM pg_advisory_xact_lock(hashtextextended(v_booking.room_key, 0));

      IF v_booking.payment_status = 'paid' THEN
        RETURN QUERY SELECT false, true, v_booking.inventory_status;
        RETURN;
      END IF;

      SELECT a.remaining INTO v_remaining
      FROM belvoir_room_availability(
        v_booking.checkin, v_booking.checkout, v_booking.room_key, v_booking.id
      ) a;
      v_has_live_hold := v_booking.inventory_status = 'held'
        AND v_booking.hold_expires_at > now();

      IF v_has_live_hold OR COALESCE(v_remaining, 0) >= 1 THEN
        UPDATE bookings
        SET payment_status = 'paid', stage = 'checkout',
            inventory_status = 'reserved', hold_expires_at = NULL
        WHERE id = p_booking_id;
        RETURN QUERY SELECT true, false, 'reserved'::text;
      ELSE
        UPDATE bookings
        SET payment_status = 'paid', stage = 'checkout',
            inventory_status = 'conflict', hold_expires_at = NULL
        WHERE id = p_booking_id;
        RETURN QUERY SELECT true, false, 'conflict'::text;
      END IF;
    END;
    $$`;
});

await step('room block creation function', async () => {
  await sql`
    CREATE OR REPLACE FUNCTION belvoir_create_room_block(
      p_room_key text,
      p_starts date,
      p_ends date,
      p_units integer,
      p_reason text
    )
    RETURNS TABLE(created boolean, block_id bigint, remaining integer)
    LANGUAGE plpgsql VOLATILE AS $$
    DECLARE
      v_capacity integer;
      v_remaining integer;
      v_block_id bigint;
    BEGIN
      IF p_room_key IS NULL OR p_starts IS NULL OR p_ends IS NULL
         OR p_ends <= p_starts OR p_units IS NULL OR p_units <= 0 THEN
        RETURN QUERY SELECT false, NULL::bigint, 0;
        RETURN;
      END IF;

      PERFORM pg_advisory_xact_lock(hashtextextended(p_room_key, 0));
      SELECT i.capacity INTO v_capacity
      FROM room_inventory i
      WHERE i.room_key = p_room_key;
      IF NOT FOUND OR p_units > v_capacity THEN
        RETURN QUERY SELECT false, NULL::bigint, 0;
        RETURN;
      END IF;

      SELECT a.remaining INTO v_remaining
      FROM belvoir_room_availability(p_starts, p_ends, p_room_key, NULL) a;
      IF COALESCE(v_remaining, 0) < p_units THEN
        RETURN QUERY SELECT false, NULL::bigint, greatest(0, COALESCE(v_remaining, 0));
        RETURN;
      END IF;

      INSERT INTO room_blocks (room_key, starts, ends, units, reason)
      VALUES (p_room_key, p_starts, p_ends, p_units, p_reason)
      RETURNING id INTO v_block_id;
      RETURN QUERY SELECT true, v_block_id, greatest(0, v_remaining - p_units);
    END;
    $$`;
});

await step('booking reactivation function', async () => {
  await sql`
    CREATE OR REPLACE FUNCTION belvoir_reactivate_booking(p_booking_id bigint)
    RETURNS TABLE(reactivated boolean, inventory_status text)
    LANGUAGE plpgsql VOLATILE AS $$
    DECLARE
      v_booking bookings%ROWTYPE;
      v_remaining integer;
    BEGIN
      SELECT * INTO v_booking FROM bookings WHERE id = p_booking_id FOR UPDATE;
      IF NOT FOUND OR v_booking.status <> 'cancelled' THEN
        RETURN QUERY SELECT false,
          CASE WHEN FOUND THEN v_booking.inventory_status ELSE NULL::text END;
        RETURN;
      END IF;

      PERFORM pg_advisory_xact_lock(hashtextextended(v_booking.room_key, 0));

      IF v_booking.payment_status = 'paid' THEN
        SELECT a.remaining INTO v_remaining
        FROM belvoir_room_availability(
          v_booking.checkin, v_booking.checkout, v_booking.room_key, v_booking.id
        ) a;
        IF COALESCE(v_remaining, 0) < 1 THEN
          RETURN QUERY SELECT false, v_booking.inventory_status;
          RETURN;
        END IF;

        UPDATE bookings
        SET status = 'active', cancelled_at = NULL,
            inventory_status = 'reserved', hold_expires_at = NULL
        WHERE id = p_booking_id;
        RETURN QUERY SELECT true, 'reserved'::text;
      ELSE
        UPDATE bookings
        SET status = 'active', cancelled_at = NULL, stage = 'started',
            inventory_status = 'unreserved', hold_expires_at = NULL
        WHERE id = p_booking_id;
        RETURN QUERY SELECT true, 'unreserved'::text;
      END IF;
    END;
    $$`;
});

await step('inventory indexes', async () => {
  await sql`DROP INDEX IF EXISTS bookings_room_dates`;
  await sql`
    CREATE INDEX IF NOT EXISTS bookings_inventory_dates
    ON bookings (room_key, checkin, checkout, hold_expires_at)
    WHERE status = 'active' AND inventory_status IN ('held', 'reserved')`;
  await sql`
    CREATE INDEX IF NOT EXISTS room_blocks_inventory_dates
    ON room_blocks (room_key, starts, ends)`;
});

console.log('\nDone.');
