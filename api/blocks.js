// Admin-only. Take a room out of service for a date range.
//
//   GET    /api/blocks                     list, newest first
//   POST   /api/blocks  { room, starts, ends, reason }
//   DELETE /api/blocks?id=1
//
// Availability treats a block exactly like a booking, so a room under
// maintenance cannot be sold.

const { neon } = require('@neondatabase/serverless');
const { limit } = require('./_ratelimit');
const crypto = require('crypto');
const { ROOMS, isRoom, parseDay, today } = require('./_rooms');

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

function query(req) {
  if (req.query && Object.keys(req.query).length) return req.query;
  const url = new URL(req.url, 'http://localhost');
  return Object.fromEntries(url.searchParams);
}

module.exports = async (req, res) => {
  if (limit(req, res, 'admin', 30, 60000)) return;
  if (!isAdmin(req)) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const sql = db();

    if (req.method === 'GET') {
      const rows = await sql`SELECT * FROM room_blocks ORDER BY starts DESC LIMIT 200`;
      return res.status(200).json({
        blocks: rows.map(r => ({ ...r, room_name: (ROOMS[r.room_key] || {}).name || r.room_key })),
      });
    }

    if (req.method === 'POST') {
      const b = req.body || {};
      if (!isRoom(b.room)) return res.status(400).json({ error: 'Please choose a room.' });

      const s = parseDay(b.starts);
      const e = parseDay(b.ends);
      if (!s || !e) return res.status(400).json({ error: 'Please choose valid dates.' });
      if (e <= s) return res.status(400).json({ error: 'The end date must be after the start date.' });
      if (s < today()) return res.status(400).json({ error: 'A block cannot start in the past.' });

      const starts = s.toISOString().slice(0, 10);
      const ends = e.toISOString().slice(0, 10);

      // Refuse to block dates a guest already holds, rather than silently
      // creating a conflict the room cannot honour.
      const clash = await sql`
        SELECT id, reference, guest_name FROM bookings
        WHERE room_key = ${b.room} AND status = 'active' AND stage = 'checkout'
          AND daterange(checkin, checkout, '[)') && daterange(${starts}::date, ${ends}::date, '[)')
        LIMIT 1`;
      if (clash.length) {
        return res.status(409).json({
          error: `That range clashes with booking ${clash[0].reference || '#' + clash[0].id} for ${clash[0].guest_name}. Cancel it first if the room really is out of service.`,
        });
      }

      try {
        const rows = await sql`
          INSERT INTO room_blocks (room_key, starts, ends, reason)
          VALUES (${b.room}, ${starts}, ${ends}, ${String(b.reason || '').slice(0, 200)})
          RETURNING *`;
        return res.status(201).json({ ok: true, block: rows[0] });
      } catch (err) {
        if (err && err.code === '23P01') {
          return res.status(409).json({ error: 'That room is already blocked over part of those dates.' });
        }
        throw err;
      }
    }

    if (req.method === 'DELETE') {
      const id = parseInt(query(req).id, 10);
      if (!id) return res.status(400).json({ error: 'Missing id' });
      const rows = await sql`DELETE FROM room_blocks WHERE id = ${id} RETURNING id`;
      if (!rows.length) return res.status(404).json({ error: 'Not found' });
      return res.status(200).json({ ok: true });
    }

    res.setHeader('Allow', 'GET, POST, DELETE');
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (e) {
    console.error('blocks api error:', e);
    return res.status(500).json({ error: 'Server error' });
  }
};
