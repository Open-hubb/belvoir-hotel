const { neon } = require('@neondatabase/serverless');
const { isAdminRequest } = require('./_auth');
const crypto = require('crypto');
const { notifyBooking } = require('./_notify');
const { settleBooking } = require('./_paid');
const {
  HOLD_MINUTES,
  acquireBookingHold,
  reactivateBooking,
} = require('./_inventory');
const { pausePaymentListener } = require('./_payment-listeners');

let _sql = null;
function db() {
  if (!_sql) _sql = neon(process.env.DATABASE_URL);
  return _sql;
}


const { ROOMS, priceStay } = require('./_rooms');
const { limit } = require('./_ratelimit');

const ROOM_UNAVAILABLE = 'Sorry, that room has just become fully booked for those dates. Please choose another room or different dates.';
const NOTIFICATION_IN_FLIGHT = 'A booking confirmation is currently being delivered. Please retry this change shortly.';

function normalizedHold(row) {
  return {
    acquired: row && row.acquired === true,
    holdExpiresAt: (row && row.hold_expires_at) || null,
    remaining: Math.max(0, Number((row && row.remaining) || 0)),
  };
}

function unavailable(res) {
  return res.status(409).json({
    error: ROOM_UNAVAILABLE,
    code: 'ROOM_UNAVAILABLE',
  });
}

function rejectNotificationInFlight(res, rows) {
  if (!rows.length || rows[0].notification_in_flight !== true) return false;
  res.status(409).json({
    error: NOTIFICATION_IN_FLIGHT,
    code: 'NOTIFICATION_IN_FLIGHT',
  });
  return true;
}

module.exports = async (req, res) => {
  try {
    // The inventory rollout changes how existing paid rows consume capacity.
    // Stop every inventory-changing booking write while listeners are paused
    // so neither a new hold nor an admin transition can race the paid-row
    // backfill and displace a confirmed reservation.
    if ((req.method === 'POST' || req.method === 'PATCH') && pausePaymentListener(res)) return;
    const sql = db();

    if (req.method === 'POST') {
      // A real guest books once or twice. This stops scripted spam.
      if (limit(req, res, 'book', 12, 60000)) return;
      const b = req.body || {};
      const stage = b.stage === 'started' ? 'started' : 'checkout';
      const clip = (v, n) => String(v == null ? '' : v).slice(0, n);

      // Always required: who is booking, which room, and when. Note that
      // nights, total and amount are deliberately NOT read from the request.
      for (const f of ['room', 'checkin', 'checkout', 'guests', 'name', 'email', 'phone']) {
        if (b[f] === undefined || b[f] === null || b[f] === '') {
          return res.status(400).json({ error: 'Missing field: ' + f });
        }
      }
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(b.email))) {
        return res.status(400).json({ error: 'Invalid email' });
      }

      let payment = null;
      if (stage === 'checkout') {
        if (!['full', 'deposit'].includes(b.payment)) {
          return res.status(400).json({ error: 'Invalid payment option' });
        }
        payment = b.payment;
      }

      // The room key and the two dates are the only price inputs. Nights and
      // money are derived here, so the browser cannot choose what it pays.
      const quote = priceStay(b.room, b.checkin, b.checkout, payment);
      if (!quote.ok) return res.status(400).json({ error: quote.error });

      const nights = quote.nights;
      const total = quote.total;
      const amount = stage === 'checkout' ? quote.amountDue : null;

      const fields = {
        room_key: quote.roomKey,
        // The name comes from the server's table, not from the request, so it
        // cannot be relabelled to something the guest did not book
        room_name: ROOMS[quote.roomKey].name,
        checkin: quote.checkin,
        checkout: quote.checkout,
        nights,
        guests: clip(b.guests, 10),
        guest_name: clip(b.name, 120),
        guest_email: clip(b.email, 160),
        guest_phone: clip(b.phone, 40),
        requests: clip(b.requests || '', 500),
      };

      const claimId = parseInt(b.id, 10);
      let bookingId = null;
      let reference = null;
      let claim = null;
      let created = false;
      let heldBooking = null;
      let hold = null;
      let notifyNewCheckout = false;

      // Serialize a legitimate details-step upgrade across its field write and
      // the database-locked hold decision. The first transaction that changes
      // started -> checkout owns the notification. Later valid retries skip the
      // field write, refresh this same booking's hold, and stay silent.
      if (stage === 'checkout' && claimId && b.claim) {
        const suppliedClaim = String(b.claim);
        const [updated, holdRows, matched] = await sql.transaction((txn) => [
          txn`
            UPDATE bookings SET
              room_key = ${fields.room_key}, room_name = ${fields.room_name},
              checkin = ${fields.checkin}, checkout = ${fields.checkout},
              nights = ${fields.nights}, guests = ${fields.guests},
              guest_name = ${fields.guest_name}, guest_email = ${fields.guest_email},
              guest_phone = ${fields.guest_phone}, requests = ${fields.requests},
              payment_option = ${payment}, amount_due = ${amount}, total = ${total}
            WHERE id = ${claimId} AND claim_token = ${suppliedClaim}
              AND stage = 'started' AND status = 'active'
            RETURNING id`,
          txn`
            SELECT * FROM belvoir_acquire_booking_hold(
              ${claimId}::bigint, ${suppliedClaim}, ${HOLD_MINUTES}::integer
            )`,
          txn`
            SELECT id, reference, room_key, room_name, checkin, checkout, nights,
              guests, guest_name, guest_email, guest_phone, requests,
              payment_option, amount_due, total, stage, status,
              hold_expires_at, inventory_status
            FROM bookings
            WHERE id = ${claimId} AND claim_token = ${suppliedClaim}
            LIMIT 1`,
        ]);

        // A match proves this request owns the existing row. A failed hold is a
        // final capacity answer; it must never fall through to a duplicate.
        if (matched.length) {
          heldBooking = matched[0];
          bookingId = heldBooking.id;
          reference = heldBooking.reference || null;
          // Echo only the token this request already proved it owns. Never
          // select another guest's claim back out of the database.
          claim = suppliedClaim;
          hold = normalizedHold(holdRows[0]);
          notifyNewCheckout = updated.length > 0 && hold.acquired;
          if (!hold.acquired) return unavailable(res);
        }
        // A missing/tampered token is non-authoritative. It cannot read or alter
        // the named booking and falls through to create an independent row.
      }

      // Both a saved enquiry and a direct checkout start non-consuming and own
      // a fresh claim. The token is returned only through this guest write path.
      if (!bookingId) {
        claim = crypto.randomUUID();
        const rows = await sql`
          INSERT INTO bookings
            (room_key, room_name, checkin, checkout, nights, guests, guest_name, guest_email,
             guest_phone, requests, payment_option, amount_due, total, stage, claim_token,
             inventory_status, hold_expires_at)
          VALUES
            (${fields.room_key}, ${fields.room_name}, ${fields.checkin}, ${fields.checkout},
             ${fields.nights}, ${fields.guests}, ${fields.guest_name}, ${fields.guest_email},
             ${fields.guest_phone}, ${fields.requests}, ${payment}, ${amount}, ${total},
             'started', ${claim}, 'unreserved', NULL)
          RETURNING id`;
        bookingId = rows[0].id;
        created = true;
      }

      // Short reference the guest can quote to the front desk
      if (!reference) {
        reference = 'BLV-' + String(bookingId).padStart(5, '0');
        await sql`UPDATE bookings SET reference = ${reference}
                  WHERE id = ${bookingId} AND reference IS NULL`;
      }

      if (stage === 'started') {
        return res.status(201).json({ ok: true, id: bookingId, claim, reference });
      }

      if (!hold) {
        hold = await acquireBookingHold(sql, bookingId, claim);
        if (!hold.acquired) return unavailable(res);
        notifyNewCheckout = true;
        const rows = await sql`
          SELECT id, reference, room_key, room_name, checkin, checkout, nights,
            guests, guest_name, guest_email, guest_phone, requests,
            payment_option, amount_due, total, stage, status,
            hold_expires_at, inventory_status
          FROM bookings
          WHERE id = ${bookingId} AND claim_token = ${claim}
          LIMIT 1`;
        if (!rows.length) throw new Error('Held booking could not be read back');
        heldBooking = rows[0];
      }

      if (notifyNewCheckout) {
        // Build the notification from the row read after the hold decision, not
        // request-local fields that may have lost a concurrent transition.
        heldBooking.reference = reference;
        try { await notifyBooking(heldBooking); } catch (err) { console.error('team notification failed:', err.message); }
      }

      return res.status(created ? 201 : 200).json({
        ok: true,
        id: bookingId,
        reference,
        claim,
        holdExpiresAt: hold.holdExpiresAt,
        remaining: hold.remaining,
      });
    }

    if (req.method === 'GET') {
      if (limit(req, res, 'admin', 30, 60000)) return;
      if (!(await isAdminRequest(sql, req))) return res.status(401).json({ error: 'Unauthorized' });
      const rows = await sql`SELECT id, created_at, room_key, room_name, checkin, checkout, nights, guests, guest_name, guest_email, guest_phone, requests, payment_option, amount_due, total, payment_status, notes, stage, status, reference, cancelled_at, hold_expires_at, inventory_status FROM bookings ORDER BY created_at DESC LIMIT 500`;
      return res.status(200).json({ bookings: rows });
    }

    if (req.method === 'PATCH') {
      if (limit(req, res, 'admin', 30, 60000)) return;
      if (!(await isAdminRequest(sql, req))) return res.status(401).json({ error: 'Unauthorized' });
      const b = req.body || {};
      const id = parseInt(b.id, 10);
      if (!id) return res.status(400).json({ error: 'Missing id' });
      if (b.payment_status && b.status) {
        return res.status(400).json({
          error: 'Update payment and booking status as separate actions.',
        });
      }
      if (b.payment_status && !['paid', 'unpaid'].includes(b.payment_status)) {
        return res.status(400).json({ error: 'Invalid status' });
      }
      if (b.status && !['active', 'cancelled'].includes(b.status)) {
        return res.status(400).json({ error: 'Invalid booking status' });
      }

      let paymentSettlement = null;
      if (b.payment_status === 'paid') {
        paymentSettlement = await settleBooking(
          sql,
          id,
          `admin-payment:${crypto.randomUUID()}`,
          'admin',
          'manual',
        );
      } else if (b.payment_status === 'unpaid') {
        const mutation = await sql`
          WITH target AS MATERIALIZED (
            SELECT booking.id, booking.notification_delivery_token,
              booking.notification_delivery_expires_at,
              booking.notification_delivery_outbox_id
            FROM bookings AS booking
            WHERE booking.id = ${id}
            FOR UPDATE
          ), changed AS (
            UPDATE bookings AS booking SET payment_status = 'unpaid',
              inventory_status = 'unreserved', hold_expires_at = NULL,
              notification_delivery_token = NULL,
              notification_delivery_expires_at = NULL,
              notification_delivery_outbox_id = NULL
            FROM target
            WHERE booking.id = target.id
              AND NOT (
                target.notification_delivery_token IS NOT NULL
                AND target.notification_delivery_expires_at > clock_timestamp()
              )
            RETURNING booking.id
          ), obsolete AS (
            UPDATE payment_notification_outbox AS notification
            SET obsolete_at = clock_timestamp(),
                obsolete_reason = 'booking-marked-unpaid',
                lease_token = NULL, lease_expires_at = NULL,
                updated_at = clock_timestamp()
            FROM changed
            WHERE notification.booking_id = changed.id
              AND notification.outcome = 'reserved'
              AND notification.delivered_at IS NULL
              AND notification.obsolete_at IS NULL
            RETURNING notification.id
          )
          SELECT target.id,
            (target.notification_delivery_token IS NOT NULL
              AND target.notification_delivery_expires_at > clock_timestamp())
              AS notification_in_flight,
            EXISTS (SELECT 1 FROM changed) AS changed
          FROM target`;
        if (rejectNotificationInFlight(res, mutation)) return;
      }

      // Cancellation releases inventory immediately. A restore is a new
      // capacity decision, made under the same database room lock as holds.
      if (b.status === 'cancelled') {
        const mutation = await sql`
          WITH target AS MATERIALIZED (
            SELECT booking.id, booking.notification_delivery_token,
              booking.notification_delivery_expires_at,
              booking.notification_delivery_outbox_id
            FROM bookings AS booking
            WHERE booking.id = ${id}
            FOR UPDATE
          ), changed AS (
            UPDATE bookings AS booking SET status = 'cancelled', cancelled_at = now(),
              inventory_status = 'unreserved', hold_expires_at = NULL,
              notification_delivery_token = NULL,
              notification_delivery_expires_at = NULL,
              notification_delivery_outbox_id = NULL
            FROM target
            WHERE booking.id = target.id
              AND NOT (
                target.notification_delivery_token IS NOT NULL
                AND target.notification_delivery_expires_at > clock_timestamp()
              )
            RETURNING booking.id
          ), obsolete AS (
            UPDATE payment_notification_outbox AS notification
            SET obsolete_at = clock_timestamp(),
                obsolete_reason = 'booking-cancelled',
                lease_token = NULL, lease_expires_at = NULL,
                updated_at = clock_timestamp()
            FROM changed
            WHERE notification.booking_id = changed.id
              AND notification.outcome = 'reserved'
              AND notification.delivered_at IS NULL
              AND notification.obsolete_at IS NULL
            RETURNING notification.id
          )
          SELECT target.id,
            (target.notification_delivery_token IS NOT NULL
              AND target.notification_delivery_expires_at > clock_timestamp())
              AS notification_in_flight,
            EXISTS (SELECT 1 FROM changed) AS changed
          FROM target`;
        if (rejectNotificationInFlight(res, mutation)) return;
      } else if (b.status === 'active') {
        const restored = await reactivateBooking(sql, id);
        if (!restored.reactivated) {
          const current = await sql`SELECT id, status FROM bookings WHERE id = ${id} LIMIT 1`;
          if (!current.length) return res.status(404).json({ error: 'Not found' });
          if (current[0].status === 'cancelled') {
            return res.status(409).json({
              error: ROOM_UNAVAILABLE,
              code: 'ROOM_UNAVAILABLE',
            });
          }
        }
      }

      if (b.notes !== undefined) {
        await sql`UPDATE bookings SET notes = ${String(b.notes).slice(0, 500)} WHERE id = ${id}`;
      }

      const rows = await sql`
        SELECT id, payment_status, notes, status, cancelled_at,
          hold_expires_at, inventory_status
        FROM bookings WHERE id = ${id} LIMIT 1`;
      if (!rows.length) return res.status(404).json({ error: 'Not found' });
      return res.status(200).json({
        ok: true,
        booking: rows[0],
        inventoryConflict: paymentSettlement ? paymentSettlement.conflict === true : false,
      });
    }

    res.setHeader('Allow', 'GET, POST, PATCH');
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (e) {
    console.error('bookings api error:', e);
    return res.status(500).json({ error: 'Server error' });
  }
};
