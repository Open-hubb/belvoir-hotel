const { neon } = require('@neondatabase/serverless');
const crypto = require('crypto');
const { notifyBooking, confirmBooking } = require('./_notify');

let _sql = null;
function db() {
  if (!_sql) _sql = neon(process.env.DATABASE_URL);
  return _sql;
}

function isAdmin(req) {
  const key = process.env.ADMIN_KEY || '';
  const header = req.headers['authorization'] || '';
  const provided = header.startsWith('Bearer ') ? header.slice(7) : (req.headers['x-admin-key'] || '');
  if (!key || !provided) return false;
  const a = Buffer.from(String(provided));
  const b = Buffer.from(key);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const { ROOMS, priceStay } = require('./_rooms');
const { takenRooms } = require('./availability');
const { limit } = require('./_ratelimit');

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

      // Completing a booking that was already captured at the details step
      // A room only stops being available once someone reaches checkout, so a
      // browsing guest never blocks anyone. The exclusion constraint below is
      // what actually enforces this; the lookup is here to give a useful
      // message rather than a raw constraint error.
      if (stage === 'checkout') {
        const taken = await takenRooms(sql, fields.checkin, fields.checkout);
        if (taken.has(fields.room_key)) {
          const claimId = parseInt(b.id, 10);
          // Its own earlier row must not count as a clash with itself
          const selfHeld = claimId && (await sql`
            SELECT 1 FROM bookings
            WHERE id = ${claimId} AND room_key = ${fields.room_key}
              AND status = 'active' AND stage = 'checkout'`).length;
          if (!selfHeld) {
            return res.status(409).json({
              error: 'Sorry, that room has just been taken for those dates. Please choose another room or different dates.',
              code: 'ROOM_UNAVAILABLE',
            });
          }
        }
      }

      const claimId = parseInt(b.id, 10);
      if (stage === 'checkout' && claimId && b.claim) {
        const updated = await sql`
          UPDATE bookings SET
            room_key = ${fields.room_key}, room_name = ${fields.room_name},
            checkin = ${fields.checkin}, checkout = ${fields.checkout},
            nights = ${fields.nights}, guests = ${fields.guests},
            guest_name = ${fields.guest_name}, guest_email = ${fields.guest_email},
            guest_phone = ${fields.guest_phone}, requests = ${fields.requests},
            payment_option = ${payment}, amount_due = ${amount}, total = ${total},
            stage = 'checkout'
          WHERE id = ${claimId} AND claim_token = ${String(b.claim)} AND stage = 'started'
          RETURNING id, reference`;
        if (updated.length) {
          const ref = updated[0].reference || ('BLV-' + String(updated[0].id).padStart(5, '0'));
          const full = { ...fields, payment_option: payment, amount_due: amount, total, reference: ref };
          // Email must never block a saved booking, so each is caught separately
          try { await notifyBooking(full); } catch (err) { console.error('team notification failed:', err.message); }
          try { await confirmBooking(full); } catch (err) { console.error('guest confirmation failed:', err.message); }
          return res.status(200).json({ ok: true, id: updated[0].id, reference: ref });
        }
        // Token did not match (expired or tampered) — fall through and insert fresh
      }

      const claim = stage === 'started' ? crypto.randomUUID() : null;
      let rows;
      try {
        rows = await sql`
          INSERT INTO bookings
            (room_key, room_name, checkin, checkout, nights, guests, guest_name, guest_email,
             guest_phone, requests, payment_option, amount_due, total, stage, claim_token)
          VALUES
            (${fields.room_key}, ${fields.room_name}, ${fields.checkin}, ${fields.checkout},
             ${fields.nights}, ${fields.guests}, ${fields.guest_name}, ${fields.guest_email},
             ${fields.guest_phone}, ${fields.requests}, ${payment}, ${amount}, ${total},
             ${stage}, ${claim})
          RETURNING id`;
      } catch (err) {
        // 23P01 is the exclusion constraint. Two guests raced for the same room
        // and Postgres refused the second, which is exactly what should happen.
        if (err && err.code === '23P01') {
          return res.status(409).json({
            error: 'Sorry, that room has just been taken for those dates. Please choose another room or different dates.',
            code: 'ROOM_UNAVAILABLE',
          });
        }
        throw err;
      }

      // Short reference the guest can quote to the front desk
      const reference = 'BLV-' + String(rows[0].id).padStart(5, '0');
      await sql`UPDATE bookings SET reference = ${reference}
                WHERE id = ${rows[0].id} AND reference IS NULL`;

      // Only tell anyone once the guest actually reaches checkout
      if (stage === 'checkout') {
        const full = { ...fields, payment_option: payment, amount_due: amount, total, reference };
        try { await notifyBooking(full); } catch (err) { console.error('team notification failed:', err.message); }
        try { await confirmBooking(full); } catch (err) { console.error('guest confirmation failed:', err.message); }
      }

      return res.status(201).json({ ok: true, id: rows[0].id, claim, reference });
    }

    if (req.method === 'GET') {
      if (limit(req, res, 'admin', 30, 60000)) return;
      if (!isAdmin(req)) return res.status(401).json({ error: 'Unauthorized' });
      const rows = await sql`SELECT id, created_at, room_key, room_name, checkin, checkout, nights, guests, guest_name, guest_email, guest_phone, requests, payment_option, amount_due, total, payment_status, notes, stage, status, reference, cancelled_at FROM bookings ORDER BY created_at DESC LIMIT 500`;
      return res.status(200).json({ bookings: rows });
    }

    if (req.method === 'PATCH') {
      if (limit(req, res, 'admin', 30, 60000)) return;
      if (!isAdmin(req)) return res.status(401).json({ error: 'Unauthorized' });
      const b = req.body || {};
      const id = parseInt(b.id, 10);
      if (!id) return res.status(400).json({ error: 'Missing id' });
      if (b.payment_status && !['paid', 'unpaid'].includes(b.payment_status)) {
        return res.status(400).json({ error: 'Invalid status' });
      }
      if (b.status && !['active', 'cancelled'].includes(b.status)) {
        return res.status(400).json({ error: 'Invalid booking status' });
      }

      // Cancelling has to release the dates, which the exclusion constraint
      // keys off, so the room becomes bookable again immediately.
      const rows = await sql`
        UPDATE bookings SET
          payment_status = COALESCE(${b.payment_status || null}, payment_status),
          notes = COALESCE(${b.notes !== undefined ? String(b.notes).slice(0, 500) : null}, notes),
          status = COALESCE(${b.status || null}, status),
          cancelled_at = CASE
            WHEN ${b.status || null} = 'cancelled' THEN now()
            WHEN ${b.status || null} = 'active'    THEN NULL
            ELSE cancelled_at END
        WHERE id = ${id}
        RETURNING id, payment_status, notes, status, cancelled_at`;
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
