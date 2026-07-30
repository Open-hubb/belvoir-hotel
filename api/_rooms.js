// The server's source of truth for what a room is called and what it costs.
//
// Rates used to live only in index.html, which meant the browser told the
// server what to charge. A guest could declare a $170 apartment as $1 and the
// payment link would honour it. Everything money-related is now computed here
// from the room key and the dates, and anything the browser sends about price
// is ignored.
//
// Must stay in step with ROOM_PRICES / ROOM_NAMES in index.html, which is only
// used for display. The check in scripts/check-rates.mjs compares the two.

const ROOMS = {
  'comfort':         { name: 'Superior Double / Comfort Room', rate: 70 },
  'standard':        { name: 'Deluxe Standard Room',           rate: 80 },
  'ground-floor':    { name: 'Ground Floor One-Bedroom',       rate: 80 },
  'superior-deluxe': { name: 'Superior Deluxe Room',           rate: 90 },
  'superior-twin':   { name: 'Superior Deluxe Twin',           rate: 100 },
  'studio':          { name: 'Studio Penthouse',               rate: 130 },
  'one-bed':         { name: 'One-Bedroom Apartment',          rate: 125 },
  'two-bed':         { name: 'Two-Bedroom Apartment',          rate: 170 },
};

// Belvoir holds one of each room type, so any overlapping dates for the same
// key is a clash. Raise a number here if a second unit is ever added.
const UNITS_PER_ROOM = 1;

const DEPOSIT_RATE = 0.3;   // matches "30% non-refundable deposit" on the site
const MAX_NIGHTS = 365;
const MAX_ADVANCE_DAYS = 730;

function isRoom(key) {
  return Object.prototype.hasOwnProperty.call(ROOMS, key);
}

/** Midnight UTC for a YYYY-MM-DD string, or null if it is not a real date. */
function parseDay(value) {
  const s = String(value || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(s + 'T00:00:00Z');
  if (Number.isNaN(d.getTime())) return null;
  // Rejects things like 2026-02-31 that Date would otherwise roll forward
  if (d.toISOString().slice(0, 10) !== s) return null;
  return d;
}

function today() {
  const n = new Date();
  return new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate()));
}

/**
 * Validate the stay and price it. Returns { ok: false, error } for anything a
 * guest could reasonably hit, so the message can go straight to the wizard.
 */
function priceStay(roomKey, checkin, checkout, paymentOption) {
  if (!isRoom(roomKey)) return { ok: false, error: 'Please choose a room.' };

  const ci = parseDay(checkin);
  const co = parseDay(checkout);
  if (!ci || !co) return { ok: false, error: 'Please choose valid dates.' };

  const t = today();
  if (ci < t) return { ok: false, error: 'Check-in cannot be in the past.' };
  if (co <= ci) return { ok: false, error: 'Check-out must be after check-in.' };

  const nights = Math.round((co - ci) / 86400000);
  if (nights > MAX_NIGHTS) {
    return { ok: false, error: 'For stays over a year, please contact us directly.' };
  }
  const advance = Math.round((ci - t) / 86400000);
  if (advance > MAX_ADVANCE_DAYS) {
    return { ok: false, error: 'We cannot take bookings more than two years ahead.' };
  }

  const rate = ROOMS[roomKey].rate;
  const total = rate * nights;
  const deposit = Math.round(total * DEPOSIT_RATE);
  const amountDue = paymentOption === 'deposit' ? deposit : total;

  return {
    ok: true,
    roomKey,
    roomName: ROOMS[roomKey].name,
    checkin: ci.toISOString().slice(0, 10),
    checkout: co.toISOString().slice(0, 10),
    nights,
    rate,
    total,
    deposit,
    amountDue,
  };
}

module.exports = { ROOMS, UNITS_PER_ROOM, DEPOSIT_RATE, MAX_NIGHTS, isRoom, parseDay, today, priceStay };
