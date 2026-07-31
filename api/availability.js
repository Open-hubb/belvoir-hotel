// GET /api/availability?checkin=YYYY-MM-DD&checkout=YYYY-MM-DD[&room=key]
//
// Which rooms are free for a stay. Belvoir holds one of each type, so a room is
// free when no active checkout-stage booking and no maintenance block overlaps
// the requested dates.
//
// This is the friendly answer used to grey out rooms in the wizard. The hard
// guarantee is the exclusion constraint in Postgres, which is what actually
// stops two people booking the same room at the same moment.

const { neon } = require('@neondatabase/serverless');
const { ROOMS, priceStay } = require('./_rooms');
const { limit } = require('./_ratelimit');

let _sql = null;
function db() {
  if (!_sql) _sql = neon(process.env.DATABASE_URL);
  return _sql;
}

function query(req) {
  if (req.query && req.query.checkin) return req.query;
  const url = new URL(req.url, 'http://localhost');
  return Object.fromEntries(url.searchParams);
}

/** Rooms with a clash over the given dates. Shared with bookings.js. */
async function takenRooms(sql, checkin, checkout) {
  const booked = await sql`
    SELECT DISTINCT room_key FROM bookings
    WHERE status = 'active' AND stage = 'checkout'
      AND daterange(checkin, checkout, '[)') && daterange(${checkin}::date, ${checkout}::date, '[)')`;
  const blocked = await sql`
    SELECT DISTINCT room_key FROM room_blocks
    WHERE daterange(starts, ends, '[)') && daterange(${checkin}::date, ${checkout}::date, '[)')`;
  return new Set([...booked, ...blocked].map(r => r.room_key));
}

module.exports = async (req, res) => {
  if (limit(req, res, 'availability', 60, 60000)) return;
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const q = query(req);
  // Price a nominal stay to reuse the same date validation the booking uses
  const check = priceStay(Object.keys(ROOMS)[0], q.checkin, q.checkout, 'full');
  if (!check.ok) return res.status(400).json({ error: check.error });

  try {
    const sql = db();
    const taken = await takenRooms(sql, check.checkin, check.checkout);

    const rooms = Object.entries(ROOMS).map(([key, r]) => {
      const quote = priceStay(key, check.checkin, check.checkout, 'full');
      return {
        key,
        name: r.name,
        rate: r.rate,
        available: !taken.has(key),
        nights: quote.nights,
        total: quote.total,
      };
    });

    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({
      checkin: check.checkin,
      checkout: check.checkout,
      nights: check.nights,
      rooms,
      anyAvailable: rooms.some(r => r.available),
    });
  } catch (err) {
    console.error('availability failed:', err.message);
    return res.status(500).json({ error: 'Could not check availability.' });
  }
};

module.exports.takenRooms = takenRooms;
