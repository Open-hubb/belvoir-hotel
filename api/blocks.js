// Admin-only. Take a room out of service for a date range.
//
//   GET    /api/blocks                     list, newest first
//   POST   /api/blocks  { room, starts, ends, units, reason }
//   DELETE /api/blocks?id=1
//
// Availability treats a block exactly like a booking, so a room under
// maintenance cannot be sold.

const { neon } = require('@neondatabase/serverless');
const { isAdminRequest } = require('./_auth');
const { limit } = require('./_ratelimit');
const { ROOMS, isRoom, parseDay, today, roomCapacity } = require('./_rooms');
const { createRoomBlock } = require('./_inventory');

let _sql = null;
function db() {
  if (!_sql) _sql = neon(process.env.DATABASE_URL);
  return _sql;
}


function query(req) {
  if (req.query && Object.keys(req.query).length) return req.query;
  const url = new URL(req.url, 'http://localhost');
  return Object.fromEntries(url.searchParams);
}

module.exports = async (req, res) => {
  if (limit(req, res, 'admin', 30, 60000)) return;
  if (!(await isAdminRequest(db(), req))) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const sql = db();

    if (req.method === 'GET') {
      const rows = await sql`SELECT * FROM room_blocks ORDER BY starts DESC LIMIT 200`;
      return res.status(200).json({
        blocks: rows.map(r => ({
          ...r,
          units: Number(r.units || 1),
          room_name: (ROOMS[r.room_key] || {}).name || r.room_key,
          capacity: roomCapacity(r.room_key),
        })),
      });
    }

    if (req.method === 'POST') {
      const b = req.body || {};
      if (!isRoom(b.room)) return res.status(400).json({ error: 'Please choose a room.' });
      const capacity = roomCapacity(b.room);
      const units = Number(b.units);
      if (!Number.isInteger(units) || units < 1 || units > capacity) {
        return res.status(400).json({
          error: `Rooms out of service must be a whole number from 1 to ${capacity}.`,
        });
      }

      const s = parseDay(b.starts);
      const e = parseDay(b.ends);
      if (!s || !e) return res.status(400).json({ error: 'Please choose valid dates.' });
      if (e <= s) return res.status(400).json({ error: 'The end date must be after the start date.' });
      if (s < today()) return res.status(400).json({ error: 'A block cannot start in the past.' });

      const starts = s.toISOString().slice(0, 10);
      const ends = e.toISOString().slice(0, 10);
      const reason = String(b.reason || '').slice(0, 200);

      const created = await createRoomBlock(sql, b.room, starts, ends, units, reason);
      if (!created.created) {
        const remaining = created.remaining;
        return res.status(409).json({
          code: 'INSUFFICIENT_CAPACITY',
          error: `Only ${remaining} room${remaining === 1 ? '' : 's'} can be blocked for that date range.`,
          remaining,
        });
      }

      const rows = await sql`SELECT * FROM room_blocks WHERE id = ${created.blockId} LIMIT 1`;
      const block = rows[0] || {
        id: created.blockId,
        room_key: b.room,
        starts,
        ends,
        units,
        reason,
      };
      return res.status(201).json({ ok: true, block, remaining: created.remaining });
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
