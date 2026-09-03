/**
 * The single place a booking becomes paid and its durable notifications run.
 *
 * The database settlement function owns both the paid/inventory transition and
 * creation of deterministic outbox rows. Every listener can therefore retry
 * delivery without repeating channels that are already acknowledged.
 */

const crypto = require('crypto');
const { confirmBooking, notifyPaid } = require('./_notify');
const { notifyAdmins } = require('./_whapi');
const { settleBookingInventory } = require('./_inventory');
const F = require('./_flot');

const OUTBOX_LIMIT = 40;
const PROVIDER_TIMEOUT_MS = 5_000;
const LEASE_START_SAFETY_MS = 2_000;

function deliverySucceeded(channel, result) {
  if (!result || result.skipped === true) return false;
  if (channel.startsWith('whatsapp-')) {
    return result.failed === 0 && result.sent === 1;
  }
  return true;
}

async function deliverChannel(row, booking, { signal, timeoutMs } = {}) {
  if (row.channel === 'guest-email') {
    return confirmBooking(booking, { idempotencyKey: row.dedupe_key, signal });
  }
  if (row.channel === 'team-email') {
    return notifyPaid(booking, { idempotencyKey: row.dedupe_key, signal });
  }
  if (row.channel === 'whatsapp-payment') {
    return notifyAdmins('payment-received', booking, { signal, timeoutMs });
  }
  if (row.channel === 'whatsapp-conflict') {
    return notifyAdmins('payment-conflict', booking, { signal, timeoutMs });
  }
  throw new Error('unsupported payment notification channel');
}

/**
 * Claim pending outbox rows with a short lease and acknowledge each channel
 * separately. Resend receives the deterministic dedupe key. Whapi has no
 * provider-side idempotency key, so the lease prevents concurrent sends; a
 * process crash after Whapi accepts a message but before our acknowledgement
 * can still cause one duplicate on retry rather than permanently lose it.
 */
async function deliverPendingPaymentNotifications(sql, bookingId = null, suppliedBooking = null) {
  const id = bookingId == null ? null : parseInt(bookingId, 10);
  void suppliedBooking;
  let claimedCount = 0;
  let delivered = 0;
  let pending = 0;
  let cursor = 0;

  // Claim one row immediately before its network send. A slow sender cannot
  // consume the lease time of later WhatsApp rows in the bounded batch.
  for (let index = 0; index < OUTBOX_LIMIT; index += 1) {
    const leaseToken = crypto.randomUUID();
    const claimed = await sql`
      WITH claimable AS MATERIALIZED (
        SELECT n.id, n.booking_id
        FROM payment_notification_outbox n
        JOIN bookings b ON b.id = n.booking_id
        WHERE n.delivered_at IS NULL
          AND n.obsolete_at IS NULL
          AND n.available_at <= clock_timestamp()
          AND (n.lease_expires_at IS NULL OR n.lease_expires_at <= clock_timestamp())
          AND (${id}::bigint IS NULL OR n.booking_id = ${id})
          AND n.id > ${cursor}
          AND (
            b.notification_delivery_token IS NULL
            OR b.notification_delivery_expires_at IS NULL
            OR b.notification_delivery_expires_at <= clock_timestamp()
          )
          AND n.payment_generation = b.payment_generation
          AND (
            (n.outcome = 'reserved'
             AND b.status = 'active'
             AND b.payment_status = 'paid'
             AND b.inventory_status = 'reserved')
            OR
            (n.outcome = 'conflict'
             AND b.payment_status = 'paid'
             AND b.inventory_status = 'conflict')
          )
        ORDER BY n.id
        LIMIT 1
        FOR UPDATE OF n, b SKIP LOCKED
      ), obsolete AS (
        UPDATE payment_notification_outbox n
        SET obsolete_at = clock_timestamp(),
            obsolete_reason = 'booking-state-superseded',
            lease_token = NULL, lease_expires_at = NULL,
            updated_at = clock_timestamp()
        FROM bookings b
        WHERE b.id = n.booking_id
          AND n.delivered_at IS NULL
          AND n.obsolete_at IS NULL
          AND (${id}::bigint IS NULL OR n.booking_id = ${id})
          AND NOT (
            n.payment_generation = b.payment_generation
            AND (
              (n.outcome = 'reserved'
               AND b.status = 'active'
               AND b.payment_status = 'paid'
               AND b.inventory_status = 'reserved')
              OR
              (n.outcome = 'conflict'
               AND b.payment_status = 'paid'
               AND b.inventory_status = 'conflict')
            )
          )
        RETURNING n.id
      ), leased AS (
        UPDATE payment_notification_outbox AS notification
        SET lease_token = ${leaseToken},
          lease_expires_at = clock_timestamp() + interval '5 minutes',
          attempts = notification.attempts + 1,
          updated_at = clock_timestamp()
        FROM claimable
        WHERE notification.id = claimable.id
        RETURNING notification.id, notification.booking_id, notification.outcome,
          notification.payment_generation, notification.channel,
          notification.dedupe_key, notification.lease_expires_at
      ), booking_lease AS (
        UPDATE bookings AS booking
        SET notification_delivery_token = ${leaseToken},
            notification_delivery_expires_at = leased.lease_expires_at,
            notification_delivery_outbox_id = leased.id
        FROM leased
        WHERE booking.id = leased.booking_id
          AND (
            booking.notification_delivery_token IS NULL
            OR booking.notification_delivery_expires_at IS NULL
            OR booking.notification_delivery_expires_at <= clock_timestamp()
          )
        RETURNING booking.id
      )
      SELECT leased.id, leased.booking_id, leased.outcome,
        leased.payment_generation, leased.channel, leased.dedupe_key,
        leased.lease_expires_at
      FROM leased
      JOIN booking_lease ON booking_lease.id = leased.booking_id`;
    if (!claimed.length) break;

    const row = claimed[0];
    claimedCount += 1;
    cursor = Number(row.id);
    try {
      // Re-read the exact booking/outbox coordination tuple immediately before
      // the network boundary. A superseding state change, a reclaimed token,
      // or an expired lease must prevent a provider request from starting.
      const current = await sql`
        SELECT booking.*, notification.id AS notification_id,
          notification.channel, notification.dedupe_key,
          greatest(0, floor(extract(epoch FROM (
            least(notification.lease_expires_at, booking.notification_delivery_expires_at)
              - clock_timestamp()
          )) * 1000))::bigint AS lease_remaining_ms
        FROM payment_notification_outbox AS notification
        JOIN bookings AS booking ON booking.id = notification.booking_id
        WHERE notification.id = ${row.id}
          AND notification.lease_token = ${leaseToken}
          AND notification.lease_expires_at > clock_timestamp()
          AND notification.delivered_at IS NULL
          AND notification.obsolete_at IS NULL
          AND booking.notification_delivery_token = ${leaseToken}
          AND booking.notification_delivery_outbox_id = notification.id
          AND booking.notification_delivery_expires_at > clock_timestamp()
          AND notification.payment_generation = booking.payment_generation
          AND (
            (notification.outcome = 'reserved'
             AND booking.status = 'active'
             AND booking.payment_status = 'paid'
             AND booking.inventory_status = 'reserved')
            OR
            (notification.outcome = 'conflict'
             AND booking.payment_status = 'paid'
             AND booking.inventory_status = 'conflict')
          )
        LIMIT 1`;
      const booking = current[0] || null;
      const leaseRemainingMs = Number(booking && booking.lease_remaining_ms);
      if (!booking || !Number.isFinite(leaseRemainingMs) ||
          leaseRemainingMs <= PROVIDER_TIMEOUT_MS + LEASE_START_SAFETY_MS) {
        throw new Error('notification delivery lease is no longer current');
      }

      const timeoutMs = Math.min(
        PROVIDER_TIMEOUT_MS,
        leaseRemainingMs - LEASE_START_SAFETY_MS,
      );
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      let result;
      try {
        result = await deliverChannel(row, booking, {
          signal: controller.signal,
          timeoutMs,
        });
      } finally {
        clearTimeout(timeout);
      }
      if (!deliverySucceeded(row.channel, result)) {
        throw new Error('notification provider did not accept the message');
      }

      const acknowledged = await sql`
        WITH acknowledged AS (
          UPDATE payment_notification_outbox
          SET delivered_at = clock_timestamp(), lease_token = NULL,
              lease_expires_at = NULL, last_error = NULL,
              updated_at = clock_timestamp()
          WHERE id = ${row.id} AND lease_token = ${leaseToken}
          RETURNING id, booking_id
        ), cleared AS (
          UPDATE bookings AS booking
          SET notification_delivery_token = NULL,
              notification_delivery_expires_at = NULL,
              notification_delivery_outbox_id = NULL
          FROM acknowledged
          WHERE booking.id = acknowledged.booking_id
            AND booking.notification_delivery_token = ${leaseToken}
            AND booking.notification_delivery_outbox_id = acknowledged.id
          RETURNING booking.id
        )
        SELECT id FROM acknowledged`;
      if (acknowledged.length) delivered += 1;
      else pending += 1;
    } catch (err) {
      pending += 1;
      const failure = String(err && err.message ? err.message : 'notification delivery failed').slice(0, 300);
      await sql`
        WITH released AS (
          UPDATE payment_notification_outbox
          SET lease_token = NULL, lease_expires_at = NULL,
              available_at = clock_timestamp() + interval '1 minute',
              last_error = ${failure}, updated_at = clock_timestamp()
          WHERE id = ${row.id} AND lease_token = ${leaseToken}
          RETURNING id, booking_id
        ), cleared AS (
          UPDATE bookings AS booking
          SET notification_delivery_token = NULL,
              notification_delivery_expires_at = NULL,
              notification_delivery_outbox_id = NULL
          FROM released
          WHERE booking.id = released.booking_id
            AND booking.notification_delivery_token = ${leaseToken}
            AND booking.notification_delivery_outbox_id = released.id
          RETURNING booking.id
        )
        SELECT id FROM released`;
      F.log('PAYMENT_NOTIFICATION_RETRY', {
        bookingId: Number(row.booking_id),
        channel: row.channel,
      });
    }
  }

  return { claimed: claimedCount, delivered, pending };
}

/**
 * @returns {Promise<{settled:boolean, alreadyPaid:boolean, alreadyProcessed:boolean, conflict:boolean, booking:object|null}>}
 */
async function settleBooking(sql, bookingId, settlementKey, source, providerRef = null) {
  const id = parseInt(bookingId, 10);
  const key = String(settlementKey || '').trim();
  if (!id || !key) {
    return {
      settled: false,
      alreadyPaid: false,
      alreadyProcessed: false,
      conflict: false,
      booking: null,
    };
  }

  const outcome = await settleBookingInventory(sql, id, key);
  const conflict = outcome.inventoryStatus === 'conflict';
  const note = source === 'admin'
    ? 'Marked paid by an administrator'
    : `Paid via Flot · ${providerRef} · ${source}`;

  let rows = [];
  if (outcome.settled) {
    try {
      rows = await sql`
        UPDATE bookings
        SET notes = CASE WHEN COALESCE(notes, '') = ''
                         THEN ${note}
                         ELSE notes || ${' · ' + note} END
        WHERE id = ${id}
        RETURNING *`;
    } catch {
      // Settlement and outbox creation already committed atomically. A later
      // listener or cron can still deliver every pending channel.
      F.log('PAYMENT_NOTE_APPEND_FAILED', { bookingId: id, observedBy: source || null });
    }
  }
  if (!rows.length) rows = await sql`SELECT * FROM bookings WHERE id = ${id} LIMIT 1`;
  const booking = rows.length ? { ...rows[0], paid_source: source } : null;

  if (!booking) {
    F.log('PAYMENT_BOOKING_READ_FAILED', { bookingId: id, observedBy: source || null });
  } else if (outcome.settled && conflict) {
    F.log('PAYMENT_INVENTORY_CONFLICT', {
      bookingId: id,
      bookingReference: booking.reference || null,
      paymentReference: providerRef || null,
      roomKey: booking.room_key || null,
      checkin: booking.checkin || null,
      checkout: booking.checkout || null,
      observedBy: source || null,
      urgent: true,
    });
  }

  // Run even for an already-paid booking: the listener that owned settlement
  // may have stopped after committing or one channel may have failed.
  await deliverPendingPaymentNotifications(sql, id, booking);

  return {
    settled: outcome.settled,
    alreadyPaid: outcome.alreadyPaid,
    alreadyProcessed: outcome.alreadyProcessed,
    conflict,
    paymentGeneration: outcome.paymentGeneration,
    settlementOutcome: outcome.inventoryStatus,
    booking,
  };
}

module.exports = { settleBooking, deliverPendingPaymentNotifications };
