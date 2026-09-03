// Adds the schema and transactional functions for multi-unit room inventory.
//
// Run once against each environment during the controlled rollout:
//   node --env-file=.env.local scripts/migrate-availability.mjs
//
// Safe to re-run: schema changes are guarded, capacities are upserted, and
// functions are replaced in place.

import { neon } from '@neondatabase/serverless';
import { createRequire } from 'node:module';
import { deduplicatePaymentAttempts } from './payment-attempt-dedupe.mjs';

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

// A webhook may arrive before the payment-link request finishes recording its
// local row. Collapse any historical duplicate provider pairs before adding
// the constraint used by the two atomic upsert paths.
await step('payment attempt identity', async () => {
  await sql`ALTER TABLE payments ADD COLUMN IF NOT EXISTS short_code text`;
  await sql`ALTER TABLE payments ADD COLUMN IF NOT EXISTS pay_link text`;
  await sql`ALTER TABLE payments ADD COLUMN IF NOT EXISTS provider_raw text`;
  await sql`ALTER TABLE payments ADD COLUMN IF NOT EXISTS completed_at timestamptz`;
  await deduplicatePaymentAttempts(sql);
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS payments_provider_attempt_unique
    ON payments (reference, provider_ref)
    WHERE provider_ref IS NOT NULL`;
});

await step('durable payment notification outbox', async () => {
  await sql`
    ALTER TABLE bookings
    ADD COLUMN IF NOT EXISTS payment_generation integer NOT NULL DEFAULT 0`;
  await sql`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS notification_delivery_token text`;
  await sql`
    ALTER TABLE bookings
    ADD COLUMN IF NOT EXISTS notification_delivery_expires_at timestamptz`;
  await sql`
    ALTER TABLE bookings
    ADD COLUMN IF NOT EXISTS notification_delivery_outbox_id bigint`;
  await sql`
    ALTER TABLE bookings
    ALTER COLUMN payment_generation SET DEFAULT 0`;
  await sql`
    UPDATE bookings SET payment_generation = 0
    WHERE payment_generation IS NULL`;
  await sql`
    ALTER TABLE bookings
    ALTER COLUMN payment_generation SET NOT NULL`;
  await sql`
    ALTER TABLE bookings
    DROP CONSTRAINT IF EXISTS bookings_payment_generation_nonnegative`;
  await sql`
    ALTER TABLE bookings
    ADD CONSTRAINT bookings_payment_generation_nonnegative
    CHECK (payment_generation >= 0)`;
  await sql`
    CREATE TABLE IF NOT EXISTS payment_notification_outbox (
      id bigserial PRIMARY KEY,
      booking_id bigint NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
      payment_generation integer NOT NULL DEFAULT 0,
      outcome text NOT NULL CHECK (outcome IN ('reserved', 'conflict')),
      channel text NOT NULL CHECK (
        channel IN ('guest-email', 'team-email', 'whatsapp-payment', 'whatsapp-conflict')
      ),
      dedupe_key text NOT NULL UNIQUE,
      attempts integer NOT NULL DEFAULT 0,
      available_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      lease_token text,
      lease_expires_at timestamptz,
      delivered_at timestamptz,
      obsolete_at timestamptz,
      obsolete_reason text,
      last_error text,
      created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
    )`;
  await sql`
    ALTER TABLE payment_notification_outbox
    ADD COLUMN IF NOT EXISTS payment_generation integer`;
  await sql`ALTER TABLE payment_notification_outbox ADD COLUMN IF NOT EXISTS obsolete_at timestamptz`;
  await sql`ALTER TABLE payment_notification_outbox ADD COLUMN IF NOT EXISTS obsolete_reason text`;
  // Existing rows represent at least one historical payment generation. Keep
  // them as audit history while allowing a later unpaid -> paid transition to
  // advance the booking and create a fresh generation.
  await sql`
    UPDATE bookings AS booking
    SET payment_generation = 1
    WHERE booking.payment_generation = 0
      AND (
        booking.payment_status = 'paid'
        OR EXISTS (
          SELECT 1 FROM payment_notification_outbox notification
          WHERE notification.booking_id = booking.id
        )
      )`;
  await sql`
    UPDATE payment_notification_outbox AS notification
    SET payment_generation = booking.payment_generation
    FROM bookings AS booking
    WHERE notification.booking_id = booking.id
      AND (notification.payment_generation IS NULL OR notification.payment_generation = 0)`;
  await sql`
    ALTER TABLE payment_notification_outbox
    ALTER COLUMN payment_generation SET DEFAULT 0`;
  await sql`
    ALTER TABLE payment_notification_outbox
    ALTER COLUMN payment_generation SET NOT NULL`;
  await sql`
    ALTER TABLE payment_notification_outbox
    DROP CONSTRAINT IF EXISTS payment_notification_outbox_booking_id_outcome_channel_key`;
  await sql`
    ALTER TABLE payment_notification_outbox
    DROP CONSTRAINT IF EXISTS payment_notification_outbox_payment_generation_nonnegative`;
  await sql`
    ALTER TABLE payment_notification_outbox
    ADD CONSTRAINT payment_notification_outbox_payment_generation_nonnegative
    CHECK (payment_generation >= 0)`;
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS payment_notification_outbox_generation_channel
    ON payment_notification_outbox (booking_id, payment_generation, outcome, channel)`;
  await sql`
    CREATE INDEX IF NOT EXISTS payment_notification_outbox_claimable
    ON payment_notification_outbox (available_at, lease_expires_at, id)
    WHERE delivered_at IS NULL AND obsolete_at IS NULL`;
  await sql`
    CREATE TABLE IF NOT EXISTS booking_settlement_events (
      id bigserial PRIMARY KEY,
      booking_id bigint NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
      settlement_key text NOT NULL,
      payment_generation integer NOT NULL CHECK (payment_generation > 0),
      outcome text NOT NULL CHECK (outcome IN ('reserved', 'conflict')),
      settled_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      UNIQUE (booking_id, settlement_key)
    )`;
  await sql`
    CREATE INDEX IF NOT EXISTS booking_settlement_events_generation
    ON booking_settlement_events (booking_id, payment_generation)`;
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
    LANGUAGE sql VOLATILE AS $$
      WITH wall_clock AS MATERIALIZED (
        SELECT clock_timestamp() AS instant
      ), nights AS (
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
                OR (b.inventory_status = 'held'
                    AND b.hold_expires_at > wall_clock.instant)
              )
          ) + COALESCE((
            SELECT sum(rb.units)::integer
            FROM room_blocks rb
            WHERE rb.room_key = i.room_key
              AND rb.starts <= n.night AND rb.ends > n.night
          ), 0) AS used
        FROM room_inventory i CROSS JOIN nights n CROSS JOIN wall_clock
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
         OR v_booking.status <> 'active'
         OR v_booking.payment_status = 'paid'
         OR v_booking.inventory_status IN ('reserved', 'conflict')
         OR p_minutes IS DISTINCT FROM 15 THEN
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

      v_expires := clock_timestamp() + interval '15 minutes';
      UPDATE bookings SET stage = 'checkout', inventory_status = 'held',
        hold_expires_at = v_expires WHERE id = p_booking_id;
      RETURN QUERY SELECT true, v_expires, greatest(0, v_remaining - 1);
    END;
    $$`;
});

await step('booking settlement function', async () => {
  // The old one-argument function cannot coexist as an accidental call target.
  await sql`DROP FUNCTION IF EXISTS belvoir_settle_booking(bigint)`;
  await sql`
    CREATE OR REPLACE FUNCTION belvoir_settle_booking(
      p_booking_id bigint,
      p_settlement_key text
    )
    RETURNS TABLE(
      settled boolean,
      already_paid boolean,
      already_processed boolean,
      inventory_status text,
      payment_generation integer
    )
    LANGUAGE plpgsql VOLATILE AS $$
    DECLARE
      v_booking bookings%ROWTYPE;
      v_remaining integer;
      v_has_live_hold boolean;
      v_generation integer;
      v_existing_generation integer;
      v_existing_outcome text;
      v_outcome text;
    BEGIN
      SELECT * INTO v_booking FROM bookings WHERE id = p_booking_id FOR UPDATE;
      IF NOT FOUND OR NULLIF(btrim(p_settlement_key), '') IS NULL THEN
        RETURN QUERY SELECT false, false, false, NULL::text, NULL::integer;
        RETURN;
      END IF;

      -- The immutable event identity is checked while the booking row is
      -- locked. Webhook, browser poll, and cron retries of one provider attempt
      -- therefore converge even after an administrator resets the booking.
      SELECT event.payment_generation, event.outcome
      INTO v_existing_generation, v_existing_outcome
      FROM booking_settlement_events AS event
      WHERE event.booking_id = p_booking_id
        AND event.settlement_key = p_settlement_key;
      IF FOUND THEN
        RETURN QUERY SELECT false,
          v_booking.payment_status = 'paid', true,
          v_existing_outcome, v_existing_generation;
        RETURN;
      END IF;

      IF v_booking.payment_status = 'paid' THEN
        RETURN QUERY SELECT false, true, false,
          v_booking.inventory_status, v_booking.payment_generation;
        RETURN;
      END IF;

      PERFORM pg_advisory_xact_lock(hashtextextended(v_booking.room_key, 0));
      v_generation := COALESCE(v_booking.payment_generation, 0) + 1;

      -- A cancellation is final for inventory. Money can still arrive late,
      -- but it must become a conflict and can never resurrect or consume a
      -- unit, nor enqueue the ordinary confirmation emails.
      IF v_booking.status IS DISTINCT FROM 'active' THEN
        UPDATE bookings
        SET payment_status = 'paid', stage = 'checkout',
            inventory_status = 'conflict', hold_expires_at = NULL,
            payment_generation = v_generation
        WHERE id = p_booking_id;
        v_outcome := 'conflict';
        INSERT INTO booking_settlement_events
          (booking_id, settlement_key, payment_generation, outcome)
        VALUES (p_booking_id, p_settlement_key, v_generation, v_outcome);
        INSERT INTO payment_notification_outbox
          (booking_id, payment_generation, outcome, channel, dedupe_key)
        VALUES
          (p_booking_id, v_generation, 'conflict', 'whatsapp-conflict',
           'belvoir:booking:' || p_booking_id::text || ':payment:' ||
             v_generation::text || ':conflict:whatsapp-conflict')
        ON CONFLICT (booking_id, payment_generation, outcome, channel) DO NOTHING;
        RETURN QUERY SELECT true, false, false, v_outcome, v_generation;
        RETURN;
      END IF;

      SELECT a.remaining INTO v_remaining
      FROM belvoir_room_availability(
        v_booking.checkin, v_booking.checkout, v_booking.room_key, v_booking.id
      ) a;
      v_has_live_hold := v_booking.inventory_status = 'held'
        AND v_booking.hold_expires_at > clock_timestamp();

      IF v_has_live_hold OR COALESCE(v_remaining, 0) >= 1 THEN
        UPDATE bookings
        SET payment_status = 'paid', stage = 'checkout',
            inventory_status = 'reserved', hold_expires_at = NULL,
            payment_generation = v_generation
        WHERE id = p_booking_id;
        v_outcome := 'reserved';
        INSERT INTO booking_settlement_events
          (booking_id, settlement_key, payment_generation, outcome)
        VALUES (p_booking_id, p_settlement_key, v_generation, v_outcome);
        INSERT INTO payment_notification_outbox
          (booking_id, payment_generation, outcome, channel, dedupe_key)
        VALUES
          (p_booking_id, v_generation, 'reserved', 'guest-email',
           'belvoir:booking:' || p_booking_id::text || ':payment:' ||
             v_generation::text || ':reserved:guest-email'),
          (p_booking_id, v_generation, 'reserved', 'team-email',
           'belvoir:booking:' || p_booking_id::text || ':payment:' ||
             v_generation::text || ':reserved:team-email'),
          (p_booking_id, v_generation, 'reserved', 'whatsapp-payment',
           'belvoir:booking:' || p_booking_id::text || ':payment:' ||
             v_generation::text || ':reserved:whatsapp-payment')
        ON CONFLICT (booking_id, payment_generation, outcome, channel) DO NOTHING;
        RETURN QUERY SELECT true, false, false, v_outcome, v_generation;
      ELSE
        UPDATE bookings
        SET payment_status = 'paid', stage = 'checkout',
            inventory_status = 'conflict', hold_expires_at = NULL,
            payment_generation = v_generation
        WHERE id = p_booking_id;
        v_outcome := 'conflict';
        INSERT INTO booking_settlement_events
          (booking_id, settlement_key, payment_generation, outcome)
        VALUES (p_booking_id, p_settlement_key, v_generation, v_outcome);
        INSERT INTO payment_notification_outbox
          (booking_id, payment_generation, outcome, channel, dedupe_key)
        VALUES
          (p_booking_id, v_generation, 'conflict', 'whatsapp-conflict',
           'belvoir:booking:' || p_booking_id::text || ':payment:' ||
             v_generation::text || ':conflict:whatsapp-conflict')
        ON CONFLICT (booking_id, payment_generation, outcome, channel) DO NOTHING;
        RETURN QUERY SELECT true, false, false, v_outcome, v_generation;
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

// Process only legacy paid checkout rows that have never entered a live
// inventory state. Each candidate takes locks in the same booking-row then
// room-key order as runtime writes. A separate transaction per candidate keeps
// room locks from accumulating across the ordered backfill, while the shared
// availability calculation assigns overflow rows to the conflict state.
await step('backfill paid booking inventory', async () => {
  await sql`
    CREATE OR REPLACE FUNCTION belvoir_backfill_paid_booking(p_booking_id bigint)
    RETURNS void
    LANGUAGE plpgsql VOLATILE AS $$
    DECLARE
      v_booking bookings%ROWTYPE;
      v_remaining integer;
    BEGIN
      SELECT * INTO v_booking
      FROM bookings
      WHERE id = p_booking_id
      FOR UPDATE;

      IF NOT FOUND OR v_booking.status IS DISTINCT FROM 'active'
         OR v_booking.payment_status IS DISTINCT FROM 'paid'
         OR v_booking.stage IS DISTINCT FROM 'checkout'
         OR v_booking.inventory_status IS DISTINCT FROM 'unreserved' THEN
        RETURN;
      END IF;

      PERFORM pg_advisory_xact_lock(hashtextextended(v_booking.room_key, 0));
      SELECT a.remaining INTO v_remaining
      FROM belvoir_room_availability(
        v_booking.checkin, v_booking.checkout, v_booking.room_key, v_booking.id
      ) a;

      IF COALESCE(v_remaining, 0) >= 1 THEN
        UPDATE bookings
        SET inventory_status = 'reserved', hold_expires_at = NULL
        WHERE id = v_booking.id;
      ELSE
        UPDATE bookings
        SET inventory_status = 'conflict', hold_expires_at = NULL
        WHERE id = v_booking.id;
      END IF;
    END;
    $$`;

  try {
    const candidates = await sql`
      SELECT b.id
      FROM bookings b
      WHERE b.status = 'active'
        AND b.payment_status = 'paid'
        AND b.stage = 'checkout'
        AND b.inventory_status = 'unreserved'
      ORDER BY b.room_key, b.id`;
    for (const candidate of candidates) {
      await sql`SELECT belvoir_backfill_paid_booking(${candidate.id}::bigint)`;
    }
  } finally {
    await sql`DROP FUNCTION IF EXISTS belvoir_backfill_paid_booking(bigint)`;
  }
});

// A completed canonical payment row for an already-paid booking represents
// money that the existing system has accounted for. Register it after the
// inventory backfill so a later admin reset cannot make an old provider
// attempt look like a new payment. Completed rows whose booking is still
// unpaid are deliberately excluded: cron must be able to recover those.
await step('backfill settled payment attempt identities', async () => {
  await sql`
    INSERT INTO booking_settlement_events
      (booking_id, settlement_key, payment_generation, outcome, settled_at)
    SELECT payment.booking_id,
      'flot-payment:' || payment.id::text,
      booking.payment_generation,
      CASE
        WHEN booking.status IS DISTINCT FROM 'active'
          OR booking.inventory_status = 'conflict' THEN 'conflict'
        ELSE 'reserved'
      END,
      COALESCE(payment.completed_at, payment.received_at, clock_timestamp())
    FROM payments AS payment
    JOIN bookings AS booking ON booking.id = payment.booking_id
    WHERE payment.status = 'completed'
      AND booking.payment_status = 'paid'
      AND booking.payment_generation > 0
    ON CONFLICT (booking_id, settlement_key) DO NOTHING`;
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
