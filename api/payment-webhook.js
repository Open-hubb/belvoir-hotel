/**
 * Flot outgoing webhook receiver.
 * Implements the Flot Merchant Integration Guide v2.0, section 04.
 *
 * Give Flot Staff this URL plus the Basic auth credentials:
 *   https://www.belvoir-estates.com/api/payment-webhook
 *
 * Payload:
 *   { "orderId": "order-123", "flotRequestId": "123456", "status": "completed" }
 *
 * Notes from the spec that shape this handler:
 *  - Flot sends each notification ONCE and never retries, so we acknowledge
 *    with 2xx as early as possible and keep the work small.
 *  - Repeated orderId + flotRequestId pairs must be handled idempotently.
 *  - status "failed" means the guest hit a card error and may retry, so the
 *    booking stays pending rather than being marked failed.
 */

const { neon } = require('@neondatabase/serverless');
const crypto = require('crypto');
const { limit } = require('./_ratelimit');
const { settleBooking } = require('./_paid');

let _sql = null;
function db() {
  if (!_sql) _sql = neon(process.env.DATABASE_URL);
  return _sql;
}

function timingEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/** Basic authorization, as required by the guide. */
function authOk(req) {
  const user = process.env.FLOT_WEBHOOK_USER || '';
  const pass = process.env.FLOT_WEBHOOK_PASS || '';
  if (!user || !pass) return false;

  const header = req.headers['authorization'] || '';
  if (!/^Basic\s+/i.test(header)) return false;

  let decoded;
  try {
    decoded = Buffer.from(header.replace(/^Basic\s+/i, ''), 'base64').toString('utf8');
  } catch {
    return false;
  }
  const idx = decoded.indexOf(':');
  if (idx === -1) return false;

  return timingEqual(decoded.slice(0, idx), user) && timingEqual(decoded.slice(idx + 1), pass);
}

/** Our orderId is "belvoir-<bookingId>"; tolerate a bare id too. */
function bookingIdFromOrderId(orderId) {
  const m = String(orderId || '').match(/(\d+)\s*$/);
  return m ? parseInt(m[1], 10) : null;
}

module.exports = async (req, res) => {
  if (limit(req, res, 'webhook', 60, 60000)) return;
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!authOk(req)) {
    res.setHeader('WWW-Authenticate', 'Basic realm="belvoir-webhook"');
    console.warn('flot webhook rejected: bad or missing Basic auth');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const body = req.body || {};
  const orderId = String(body.orderId ?? '');
  const flotRequestId = String(body.flotRequestId ?? '');
  const status = String(body.status ?? '').toLowerCase();

  if (!orderId || !flotRequestId || !status) {
    return res.status(400).json({ error: 'Expected orderId, flotRequestId and status' });
  }

  try {
    const sql = db();

    const bookingId = bookingIdFromOrderId(orderId);
    let booking = null;
    if (bookingId) {
      const rows = await sql`SELECT * FROM bookings WHERE id = ${bookingId} LIMIT 1`;
      if (rows.length) booking = rows[0];
    }

    // A payment-link row normally already exists in created/pending state. Only
    // a completed row proves this exact attempt was already reconciled.
    const seen = await sql`
      SELECT id, status FROM payments
      WHERE reference = ${orderId} AND provider_ref = ${flotRequestId}
      LIMIT 1`;
    if (seen.length && seen[0].status === 'completed') {
      return res.status(200).json({
        ok: true,
        duplicate: true,
        inventoryConflict: booking ? booking.inventory_status === 'conflict' : false,
      });
    }

    const completed = status === 'completed';
    let settlement = null;

    // "failed" means the guest can still retry, so leave the booking pending
    if (booking && completed) {
      // Settles the booking and, if the webhook is the first route to see the
      // payment, sends the guest their receipt.
      settlement = await settleBooking(sql, booking.id, flotRequestId, 'webhook');
    }

    if (seen.length) {
      await sql`
        UPDATE payments
        SET status = ${status}, matched = ${Boolean(booking && completed)},
            raw = ${JSON.stringify(body)}
        WHERE id = ${seen[0].id}`;
    } else {
      await sql`
        INSERT INTO payments
          (booking_id, reference, payer_name, payer_email, amount, currency,
           status, provider_ref, matched, raw)
        VALUES
          (${booking ? booking.id : null}, ${orderId},
           ${booking ? booking.guest_name : ''}, ${booking ? booking.guest_email : ''},
           ${booking ? booking.amount_due : null}, ${'SLE'},
           ${status}, ${flotRequestId},
           ${Boolean(booking && completed)}, ${JSON.stringify(body)})`;
    }

    if (!booking) {
      console.warn('flot webhook: no booking matched orderId', orderId);
    } else if (!completed) {
      console.warn('flot webhook: payment failed for booking', booking.id, '- left pending');
    }

    return res.status(200).json({
      ok: true,
      matched: Boolean(booking),
      bookingId: booking ? booking.id : null,
      markedPaid: Boolean(booking && completed),
      inventoryConflict: settlement ? settlement.conflict === true : false,
    });
  } catch (e) {
    console.error('flot webhook error:', e);
    return res.status(500).json({ error: 'Server error' });
  }
};
