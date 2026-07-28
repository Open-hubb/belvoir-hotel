/**
 * Payment webhook receiver (flotme).
 *
 * Give flot this URL, including the secret:
 *   https://belvoir-hotel.vercel.app/api/payment-webhook?key=<FLOT_WEBHOOK_SECRET>
 *
 * The secret may instead be sent as an `x-webhook-secret` header if flot
 * prefers that. Every call is logged to the `payments` table with its raw body,
 * whether or not it matches a booking, so nothing is ever silently dropped.
 */

const { neon } = require('@neondatabase/serverless');
const crypto = require('crypto');

let _sql = null;
function db() {
  if (!_sql) _sql = neon(process.env.DATABASE_URL);
  return _sql;
}

function secretOk(req) {
  const expected = process.env.FLOT_WEBHOOK_SECRET || '';
  if (!expected) return false;
  const url = new URL(req.url, 'http://localhost');
  const given =
    url.searchParams.get('key') ||
    req.headers['x-webhook-secret'] ||
    (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '');
  if (!given) return false;
  const a = Buffer.from(String(given));
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Providers all name things differently, so look under every plausible key. */
function pick(obj, names) {
  for (const n of names) {
    for (const key of Object.keys(obj || {})) {
      if (key.toLowerCase().replace(/[_-]/g, '') === n.toLowerCase().replace(/[_-]/g, '')) {
        const v = obj[key];
        if (v !== undefined && v !== null && v !== '') return v;
      }
    }
  }
  return undefined;
}

function flatten(obj, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 3) return {};
  let out = { ...obj };
  for (const v of Object.values(obj)) {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      out = { ...flatten(v, depth + 1), ...out };
    }
  }
  return out;
}

const SUCCESS = ['success', 'successful', 'paid', 'completed', 'complete', 'settled', 'approved', 'confirmed'];

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (!secretOk(req)) {
    console.warn('payment webhook rejected: bad or missing secret');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const sql = db();
  const body = req.body || {};
  const flat = flatten(body);

  const reference = String(pick(flat, ['ref', 'reference', 'merchantRef', 'orderId', 'metadata']) ?? '');
  const providerRef = String(pick(flat, ['id', 'transactionId', 'txRef', 'paymentId', 'chargeId']) ?? '');
  const payerEmail = String(pick(flat, ['email', 'customerEmail', 'payerEmail']) ?? '').toLowerCase();
  const payerName = String(pick(flat, ['name', 'customerName', 'payerName', 'fullName']) ?? '');
  const currency = String(pick(flat, ['currency', 'ccy']) ?? '');
  const rawStatus = String(pick(flat, ['status', 'paymentStatus', 'state', 'event', 'type']) ?? '');
  const amountRaw = pick(flat, ['amount', 'amountPaid', 'value', 'total']);
  const amount = amountRaw === undefined ? null : Number(String(amountRaw).replace(/[^0-9.]/g, '')) || null;

  const isSuccess = SUCCESS.some((s) => rawStatus.toLowerCase().includes(s));

  try {
    // Ignore a repeat of a transaction we have already settled
    if (providerRef) {
      const seen = await sql`
        SELECT id FROM payments WHERE provider_ref = ${providerRef} AND matched = true LIMIT 1`;
      if (seen.length) {
        return res.status(200).json({ ok: true, duplicate: true });
      }
    }

    // Find the booking: our own reference first, then the payer's email
    let booking = null;
    const refId = parseInt(String(reference).replace(/\D/g, ''), 10);
    if (refId) {
      const r = await sql`SELECT * FROM bookings WHERE id = ${refId} LIMIT 1`;
      if (r.length) booking = r[0];
    }
    if (!booking && payerEmail) {
      const r = await sql`
        SELECT * FROM bookings
        WHERE lower(guest_email) = ${payerEmail} AND payment_status <> 'paid'
        ORDER BY created_at DESC LIMIT 1`;
      if (r.length) booking = r[0];
    }

    if (booking && isSuccess) {
      await sql`
        UPDATE bookings
        SET payment_status = 'paid',
            stage = 'checkout',
            notes = CASE WHEN COALESCE(notes, '') = '' THEN ${'Paid via flot' + (providerRef ? ' · ' + providerRef : '')}
                         ELSE notes END
        WHERE id = ${booking.id}`;
    }

    await sql`
      INSERT INTO payments
        (booking_id, reference, payer_name, payer_email, amount, currency, status, provider_ref, matched, raw)
      VALUES
        (${booking ? booking.id : null}, ${reference}, ${payerName}, ${payerEmail},
         ${amount}, ${currency}, ${rawStatus}, ${providerRef},
         ${Boolean(booking && isSuccess)}, ${JSON.stringify(body)})`;

    if (!booking) {
      console.warn('payment webhook: no matching booking', { reference, payerEmail, amount });
    }

    // Always 200 so the provider does not retry forever on our account
    return res.status(200).json({
      ok: true,
      matched: Boolean(booking),
      bookingId: booking ? booking.id : null,
      markedPaid: Boolean(booking && isSuccess),
    });
  } catch (e) {
    console.error('payment webhook error:', e);
    return res.status(500).json({ error: 'Server error' });
  }
};
