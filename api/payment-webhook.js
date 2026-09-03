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

    const completed = status === 'completed';
    let settlement = null;

    // One statement handles link-before-webhook, webhook-before-link, retries,
    // and concurrent deliveries. The partial unique index identifies a real
    // provider attempt; an already-completed row cannot be downgraded.
    const recorded = await sql`
      INSERT INTO payments
        (booking_id, reference, payer_name, payer_email, amount, currency,
         status, provider_ref, matched, raw, provider_raw, completed_at)
      VALUES
        (${booking ? booking.id : null}, ${orderId},
         ${booking ? booking.guest_name : ''}, ${booking ? booking.guest_email : ''},
         ${booking ? booking.amount_due : null}, ${'SLE'},
         ${status}, ${flotRequestId},
         ${Boolean(booking && completed)}, ${JSON.stringify(body)}, ${JSON.stringify(body)},
         CASE WHEN ${completed} THEN clock_timestamp() ELSE NULL END)
      ON CONFLICT (reference, provider_ref) WHERE provider_ref IS NOT NULL
      DO UPDATE SET
        booking_id = COALESCE(payments.booking_id, EXCLUDED.booking_id),
        payer_name = COALESCE(payments.payer_name, EXCLUDED.payer_name),
        payer_email = COALESCE(payments.payer_email, EXCLUDED.payer_email),
        amount = COALESCE(payments.amount, EXCLUDED.amount),
        currency = COALESCE(payments.currency, EXCLUDED.currency),
        status = EXCLUDED.status,
        matched = COALESCE(payments.matched, false) OR EXCLUDED.matched,
        raw = EXCLUDED.raw,
        provider_raw = EXCLUDED.provider_raw,
        completed_at = CASE
          WHEN EXCLUDED.status = 'completed'
            THEN COALESCE(payments.completed_at, EXCLUDED.completed_at)
          ELSE payments.completed_at
        END
      WHERE payments.status IS DISTINCT FROM 'completed'
      RETURNING id, status, booking_id`;
    const duplicate = recorded.length === 0;
    const attempt = recorded[0] || (await sql`
      SELECT id, status, booking_id
      FROM payments
      WHERE reference = ${orderId} AND provider_ref = ${flotRequestId}
      LIMIT 1`)[0] || null;

    // "failed" means the guest can still retry, so leave the booking pending.
    // Completed duplicates still enter the shared path to drain any durable
    // notification work left by an earlier process failure.
    if (booking && completed && attempt) {
      settlement = await settleBooking(
        sql,
        booking.id,
        `flot-payment:${attempt.id}`,
        'webhook',
        flotRequestId,
      );
    }

    if (!booking) {
      console.warn('flot webhook: no booking matched orderId', orderId);
    } else if (!completed) {
      console.warn('flot webhook: payment failed for booking', booking.id, '- left pending');
    }

    return res.status(200).json({
      ok: true,
      duplicate,
      matched: Boolean(booking),
      bookingId: booking ? booking.id : null,
      paymentReceived: completed,
      markedPaid: Boolean(
        settlement && (
          settlement.settled || settlement.alreadyPaid ||
          (settlement.booking && settlement.booking.payment_status === 'paid')
        )
      ),
      settlementAlreadyProcessed: settlement ? settlement.alreadyProcessed === true : false,
      inventoryConflict: settlement ? settlement.conflict === true : false,
    });
  } catch (e) {
    console.error('flot webhook error:', e);
    return res.status(500).json({ error: 'Server error' });
  }
};
