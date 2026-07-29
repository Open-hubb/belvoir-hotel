const { neon } = require('@neondatabase/serverless');
const crypto = require('crypto');
const { notifyBooking } = require('./_notify');

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

// Must stay in step with ROOM_PRICES / ROOM_NAMES in index.html. A key missing
// here is rejected as "Unknown room", and because the wizard queues failed
// saves and lets the guest pay anyway, that loses the booking silently.
const ROOMS = {
  'comfort': 'Superior Double / Comfort Room',
  'standard': 'Deluxe Standard Room',
  'ground-floor': 'Ground Floor One-Bedroom',
  'superior-deluxe': 'Superior Deluxe Room',
  'superior-twin': 'Superior Deluxe Twin',
  'studio': 'Studio Penthouse',
  'one-bed': 'One-Bedroom Apartment',
  'two-bed': 'Two-Bedroom Apartment'
};

module.exports = async (req, res) => {
  try {
    const sql = db();

    if (req.method === 'POST') {
      const b = req.body || {};
      const stage = b.stage === 'started' ? 'started' : 'checkout';
      const clip = (v, n) => String(v == null ? '' : v).slice(0, n);

      // Always required: who is booking, which room, and when
      for (const f of ['room', 'checkin', 'checkout', 'nights', 'guests', 'name', 'email', 'phone', 'total']) {
        if (b[f] === undefined || b[f] === null || b[f] === '') {
          return res.status(400).json({ error: 'Missing field: ' + f });
        }
      }
      if (!ROOMS[b.room]) return res.status(400).json({ error: 'Unknown room' });
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(b.email))) {
        return res.status(400).json({ error: 'Invalid email' });
      }

      const nights = parseInt(b.nights, 10);
      const total = parseInt(b.total, 10);
      if (!(nights > 0 && nights < 400) || !(total > 0)) {
        return res.status(400).json({ error: 'Invalid amounts' });
      }

      // Payment details only exist once they reach checkout
      let payment = null;
      let amount = null;
      if (stage === 'checkout') {
        if (!['full', 'deposit'].includes(b.payment)) {
          return res.status(400).json({ error: 'Invalid payment option' });
        }
        amount = parseInt(b.amount, 10);
        if (!(amount > 0) || amount > total) {
          return res.status(400).json({ error: 'Invalid amounts' });
        }
        payment = b.payment;
      }

      const fields = {
        room_key: b.room,
        room_name: clip(b.roomName || ROOMS[b.room], 80),
        checkin: b.checkin,
        checkout: b.checkout,
        nights,
        guests: clip(b.guests, 10),
        guest_name: clip(b.name, 120),
        guest_email: clip(b.email, 160),
        guest_phone: clip(b.phone, 40),
        requests: clip(b.requests || '', 500),
      };

      // Completing a booking that was already captured at the details step
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
          RETURNING id`;
        if (updated.length) {
          try {
            await notifyBooking({ ...fields, payment_option: payment, amount_due: amount, total });
          } catch (err) {
            console.error('booking notification failed:', err.message);
          }
          return res.status(200).json({ ok: true, id: updated[0].id });
        }
        // Token did not match (expired or tampered) — fall through and insert fresh
      }

      const claim = stage === 'started' ? crypto.randomUUID() : null;
      const rows = await sql`
        INSERT INTO bookings
          (room_key, room_name, checkin, checkout, nights, guests, guest_name, guest_email,
           guest_phone, requests, payment_option, amount_due, total, stage, claim_token)
        VALUES
          (${fields.room_key}, ${fields.room_name}, ${fields.checkin}, ${fields.checkout},
           ${fields.nights}, ${fields.guests}, ${fields.guest_name}, ${fields.guest_email},
           ${fields.guest_phone}, ${fields.requests}, ${payment}, ${amount}, ${total},
           ${stage}, ${claim})
        RETURNING id`;

      // Only tell the team once the guest actually reaches checkout
      if (stage === 'checkout') {
        try {
          await notifyBooking({ ...fields, payment_option: payment, amount_due: amount, total });
        } catch (err) {
          console.error('booking notification failed:', err.message);
        }
      }

      return res.status(201).json({ ok: true, id: rows[0].id, claim });
    }

    if (req.method === 'GET') {
      if (!isAdmin(req)) return res.status(401).json({ error: 'Unauthorized' });
      const rows = await sql`SELECT id, created_at, room_key, room_name, checkin, checkout, nights, guests, guest_name, guest_email, guest_phone, requests, payment_option, amount_due, total, payment_status, notes, stage FROM bookings ORDER BY created_at DESC LIMIT 500`;
      return res.status(200).json({ bookings: rows });
    }

    if (req.method === 'PATCH') {
      if (!isAdmin(req)) return res.status(401).json({ error: 'Unauthorized' });
      const b = req.body || {};
      const id = parseInt(b.id, 10);
      if (!id) return res.status(400).json({ error: 'Missing id' });
      if (b.payment_status && !['paid', 'unpaid'].includes(b.payment_status)) {
        return res.status(400).json({ error: 'Invalid status' });
      }
      const rows = await sql`
        UPDATE bookings SET
          payment_status = COALESCE(${b.payment_status || null}, payment_status),
          notes = COALESCE(${b.notes !== undefined ? String(b.notes).slice(0, 500) : null}, notes)
        WHERE id = ${id}
        RETURNING id, payment_status, notes`;
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
