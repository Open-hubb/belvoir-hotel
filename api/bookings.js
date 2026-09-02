const { neon } = require('@neondatabase/serverless');
const { isAdminRequest } = require('./_auth');
const crypto = require('crypto');
const { notifyBooking } = require('./_notify');
const {
  acquireBookingHold,
  settleBookingInventory,
  reactivateBooking,
} = require('./_inventory');

let _sql = null;
function db() {
  if (!_sql) _sql = neon(process.env.DATABASE_URL);
  return _sql;
}


const { ROOMS, priceStay } = require('./_rooms');
const { limit } = require('./_ratelimit');

const ROOM_UNAVAILABLE = 'Sorry, that room has just become fully booked for those dates. Please choose another room or different dates.';

module.exports = async (req, res) => {
  try {
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

      // A legitimate details-step upgrade keeps its original claim token. The
      // row remains a non-consuming enquiry until the locked hold call below
      // succeeds, so a failed capacity decision never leaves a phantom hold.
      if (stage === 'checkout' && claimId && b.claim) {
        const updated = await sql`
          UPDATE bookings SET
            room_key = ${fields.room_key}, room_name = ${fields.room_name},
            checkin = ${fields.checkin}, checkout = ${fields.checkout},
            nights = ${fields.nights}, guests = ${fields.guests},
            guest_name = ${fields.guest_name}, guest_email = ${fields.guest_email},
            guest_phone = ${fields.guest_phone}, requests = ${fields.requests},
            payment_option = ${payment}, amount_due = ${amount}, total = ${total}
          WHERE id = ${claimId} AND claim_token = ${String(b.claim)} AND stage = 'started'
          RETURNING id, reference`;
        if (updated.length) {
          bookingId = updated[0].id;
          reference = updated[0].reference || null;
          // Echo only the token this request already proved it owns. Never
          // select another guest's claim back out of the database.
          claim = String(b.claim);
        }
        // Token did not match (expired or tampered) — fall through and insert fresh
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

      const hold = await acquireBookingHold(sql, bookingId, claim);
      if (!hold.acquired) {
        return res.status(409).json({
          error: ROOM_UNAVAILABLE,
          code: 'ROOM_UNAVAILABLE',
        });
      }

      const full = { ...fields, payment_option: payment, amount_due: amount, total, reference };
      // Email must never block a saved booking. The team hears about checkout;
      // the guest hears only once they pay.
      try { await notifyBooking(full); } catch (err) { console.error('team notification failed:', err.message); }

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
      if (b.payment_status && !['paid', 'unpaid'].includes(b.payment_status)) {
        return res.status(400).json({ error: 'Invalid status' });
      }
      if (b.status && !['active', 'cancelled'].includes(b.status)) {
        return res.status(400).json({ error: 'Invalid booking status' });
      }

      if (b.payment_status === 'paid') {
        await settleBookingInventory(sql, id);
      } else if (b.payment_status === 'unpaid') {
        await sql`
          UPDATE bookings SET payment_status = 'unpaid',
            inventory_status = 'unreserved', hold_expires_at = NULL
          WHERE id = ${id}`;
      }

      // Cancellation releases inventory immediately. A restore is a new
      // capacity decision, made under the same database room lock as holds.
      if (b.status === 'cancelled') {
        await sql`
          UPDATE bookings SET status = 'cancelled', cancelled_at = now(),
            inventory_status = 'unreserved', hold_expires_at = NULL
          WHERE id = ${id}`;
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
      return res.status(200).json({ ok: true, booking: rows[0] });
    }

    res.setHeader('Allow', 'GET, POST, PATCH');
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (e) {
    console.error('bookings api error:', e);
    return res.status(500).json({ error: 'Server error' });
  }
};
