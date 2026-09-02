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

function deliverySucceeded(channel, result) {
  if (!result || result.skipped === true) return false;
  if (channel.startsWith('whatsapp-')) {
    return result.failed === 0 && result.sent === 1;
  }
  return true;
}

async function deliverChannel(row, booking) {
  if (row.channel === 'guest-email') {
    return confirmBooking(booking, { idempotencyKey: row.dedupe_key });
  }
  if (row.channel === 'team-email') {
    return notifyPaid(booking, { idempotencyKey: row.dedupe_key });
  }
  if (row.channel === 'whatsapp-payment') {
    return notifyAdmins('payment-received', booking);
  }
  if (row.channel === 'whatsapp-conflict') {
    return notifyAdmins('payment-conflict', booking);
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
  const leaseToken = crypto.randomUUID();
  const claimed = await sql`
    WITH claimable AS (
      SELECT id
      FROM payment_notification_outbox
      WHERE delivered_at IS NULL
        AND available_at <= clock_timestamp()
        AND (lease_expires_at IS NULL OR lease_expires_at <= clock_timestamp())
        AND (${id}::bigint IS NULL OR booking_id = ${id})
      ORDER BY created_at, id
      LIMIT ${OUTBOX_LIMIT}
      FOR UPDATE SKIP LOCKED
    )
    UPDATE payment_notification_outbox AS notification
    SET lease_token = ${leaseToken},
        lease_expires_at = clock_timestamp() + interval '5 minutes',
        attempts = notification.attempts + 1,
        updated_at = clock_timestamp()
    FROM claimable
    WHERE notification.id = claimable.id
    RETURNING notification.id, notification.booking_id, notification.outcome,
      notification.channel, notification.dedupe_key`;

  let delivered = 0;
  let pending = 0;
  const bookingCache = new Map();
  if (suppliedBooking && suppliedBooking.id != null) {
    bookingCache.set(Number(suppliedBooking.id), suppliedBooking);
  }

  for (const row of claimed) {
    let booking = bookingCache.get(Number(row.booking_id));
    try {
      if (!booking) {
        const rows = await sql`SELECT * FROM bookings WHERE id = ${row.booking_id} LIMIT 1`;
        booking = rows[0] || null;
        if (booking) bookingCache.set(Number(row.booking_id), booking);
      }
      if (!booking) throw new Error('booking unavailable for payment notification');

      const result = await deliverChannel(row, booking);
      if (!deliverySucceeded(row.channel, result)) {
        throw new Error('notification provider did not accept the message');
      }

      const acknowledged = await sql`
        UPDATE payment_notification_outbox
        SET delivered_at = clock_timestamp(), lease_token = NULL,
            lease_expires_at = NULL, last_error = NULL,
            updated_at = clock_timestamp()
        WHERE id = ${row.id} AND lease_token = ${leaseToken}
        RETURNING id`;
      if (acknowledged.length) delivered += 1;
      else pending += 1;
    } catch (err) {
      pending += 1;
      const failure = String(err && err.message ? err.message : 'notification delivery failed').slice(0, 300);
      await sql`
        UPDATE payment_notification_outbox
        SET lease_token = NULL, lease_expires_at = NULL,
            available_at = clock_timestamp() + interval '1 minute',
            last_error = ${failure}, updated_at = clock_timestamp()
        WHERE id = ${row.id} AND lease_token = ${leaseToken}`;
      F.log('PAYMENT_NOTIFICATION_RETRY', {
        bookingId: Number(row.booking_id),
        channel: row.channel,
      });
    }
  }

  return { claimed: claimed.length, delivered, pending };
}

/**
 * @returns {Promise<{settled:boolean, alreadyPaid:boolean, conflict:boolean, booking:object|null}>}
 */
async function settleBooking(sql, bookingId, providerRef, source) {
  const id = parseInt(bookingId, 10);
  if (!id) return { settled: false, alreadyPaid: false, conflict: false, booking: null };

  const outcome = await settleBookingInventory(sql, id);
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
    conflict,
    booking,
  };
}

module.exports = { settleBooking, deliverPendingPaymentNotifications };
