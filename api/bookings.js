const { neon } = require('@neondatabase/serverless');
const crypto = require('crypto');

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

const ROOMS = {
  'standard': 'Deluxe Standard Room',
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
      const required = ['room', 'checkin', 'checkout', 'nights', 'guests', 'name', 'email', 'phone', 'payment', 'amount', 'total'];
      for (const f of required) {
        if (b[f] === undefined || b[f] === null || b[f] === '') {
          return res.status(400).json({ error: 'Missing field: ' + f });
        }
      }
      if (!ROOMS[b.room]) return res.status(400).json({ error: 'Unknown room' });
      if (!['full', 'deposit'].includes(b.payment)) return res.status(400).json({ error: 'Invalid payment option' });
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(b.email))) return res.status(400).json({ error: 'Invalid email' });
      const nights = parseInt(b.nights, 10);
      const amount = parseInt(b.amount, 10);
      const total = parseInt(b.total, 10);
      if (!(nights > 0 && nights < 400) || !(amount > 0) || !(total > 0) || amount > total) {
        return res.status(400).json({ error: 'Invalid amounts' });
      }
      const clip = (v, n) => String(v).slice(0, n);
      const rows = await sql`
        INSERT INTO bookings
          (room_key, room_name, checkin, checkout, nights, guests, guest_name, guest_email, guest_phone, requests, payment_option, amount_due, total)
        VALUES
          (${b.room}, ${clip(b.roomName || ROOMS[b.room], 80)}, ${b.checkin}, ${b.checkout}, ${nights},
           ${clip(b.guests, 10)}, ${clip(b.name, 120)}, ${clip(b.email, 160)}, ${clip(b.phone, 40)},
           ${clip(b.requests || '', 500)}, ${b.payment}, ${amount}, ${total})
        RETURNING id`;
      return res.status(201).json({ ok: true, id: rows[0].id });
    }

    if (req.method === 'GET') {
      if (!isAdmin(req)) return res.status(401).json({ error: 'Unauthorized' });
      const rows = await sql`SELECT * FROM bookings ORDER BY created_at DESC LIMIT 500`;
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
