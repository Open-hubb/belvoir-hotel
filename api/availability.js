// GET /api/availability?checkin=YYYY-MM-DD&checkout=YYYY-MM-DD[&room=key]
//
// Which rooms have capacity for a stay. Availability is evaluated by the
// database inventory function across active bookings and maintenance blocks.
//
// This is the friendly answer used to grey out rooms in the wizard. The hard
// guarantee is the exclusion constraint in Postgres, which is what actually
// stops two people booking the same room at the same moment.

const { neon } = require('@neondatabase/serverless');
const { ROOMS, priceStay } = require('./_rooms');
const { availabilityForStay } = require('./_inventory');
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

/**
 * Legacy compatibility helper shared with bookings.js.
 *
 * New callers should use availabilityForStay directly so they can account for
 * multi-unit room capacity. A room is taken for the legacy Set when no units
 * remain for the requested stay.
 */
async function takenRooms(sql, checkin, checkout) {
  const inventory = await availabilityForStay(sql, checkin, checkout);
  return new Set([...inventory.entries()]
    .filter(([, room]) => room.remaining <= 0)
    .map(([roomKey]) => roomKey));
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
    const inventory = await availabilityForStay(
      sql,
      check.checkin,
      check.checkout,
      q.room || null,
    );

    const rooms = Object.entries(ROOMS)
      .filter(([key]) => !q.room || key === q.room)
      .map(([key, r]) => {
        const quote = priceStay(key, check.checkin, check.checkout, 'full');
        const live = inventory.get(key) || { capacity: r.capacity, remaining: 0 };
        return {
          key,
          name: r.name,
          rate: r.rate,
          capacity: live.capacity,
          remaining: live.remaining,
          available: live.remaining > 0,
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
