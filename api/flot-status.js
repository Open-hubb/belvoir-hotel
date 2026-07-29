// GET /api/flot-status?orderId=belvoir-19&attemptId=<flot payment attempt id>
//
// Polled by the payment modal. This is the path that does not depend on Flot's
// webhook configuration: when Flot reports the attempt completed, the booking
// is marked paid here. The webhook receiver stays in place as a second route to
// the same outcome, and both are idempotent.

const { neon } = require('@neondatabase/serverless');
const F = require('./_flot');

let _sql = null;
function db() {
  if (!_sql) _sql = neon(process.env.DATABASE_URL);
  return _sql;
}

function bookingIdFromOrderId(orderId) {
  const m = String(orderId || '').match(/(\d+)\s*$/);
  return m ? parseInt(m[1], 10) : null;
}

function query(req) {
  if (req.query && req.query.orderId) return req.query;
  const url = new URL(req.url, 'http://localhost');
  return Object.fromEntries(url.searchParams);
}

module.exports = async (req, res) => {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const q = query(req);
  const orderId = String(q.orderId || '');
  const attemptId = String(q.attemptId || '');
  if (!orderId || !attemptId) {
    return res.status(400).json({ error: 'orderId and attemptId are required.' });
  }

  const path = `/merchants/private/v1/external-orders/${encodeURIComponent(orderId)}/payment-attempts/${encodeURIComponent(attemptId)}`;

  try {
    let data;
    if (F.TEST_MODE) {
      data = F.mockStatus(orderId, attemptId);
      F.log('TEST_MODE', { note: 'mock status', orderId, attemptId, status: data.status });
    } else {
      F.log('STATUS_REQUEST', { orderId, attemptId });
      const signature = F.signCanonical('GET', path);
      const r = await fetch(`${F.API_BASE}${path}`, {
        method: 'GET',
        headers: {
          'X-Flot-Merchant-Signature': signature,
          'X-Flot-Merchant-Id': F.MERCHANT_ID,
        },
      });
      const json = await r.json().catch(() => ({}));
      F.log('STATUS_RESPONSE', { orderId, attemptId, httpStatus: r.status, response: json });
      if (!r.ok) {
        return res.status(502).json({ error: 'Could not check the payment status.' });
      }
      data = (json && json.data) || {};
    }

    const status = String(data.status || 'created');
    const sql = db();

    if (status === 'completed') {
      const bookingId = bookingIdFromOrderId(orderId);

      // Idempotent: only the first completion writes, so repeated polls and a
      // webhook arriving for the same attempt cannot double-apply.
      const already = await sql`
        SELECT id FROM payments
        WHERE reference = ${orderId} AND provider_ref = ${attemptId} AND status = 'completed'
        LIMIT 1`;

      if (!already.length) {
        await sql`
          UPDATE payments SET status = 'completed'
          WHERE reference = ${orderId} AND provider_ref = ${attemptId}`;

        if (bookingId) {
          await sql`
            UPDATE bookings
            SET payment_status = 'paid',
                stage = 'checkout',
                notes = CASE WHEN COALESCE(notes, '') = ''
                             THEN ${'Paid via Flot · ' + attemptId}
                             ELSE notes || ${' · Paid via Flot · ' + attemptId} END
            WHERE id = ${bookingId} AND payment_status IS DISTINCT FROM 'paid'`;
        }
        F.log('PAYMENT_COMPLETED', { orderId, attemptId, bookingId });
      }
    }

    // "failed" is a card error, so the order stays open and the guest can retry
    return res.status(200).json({
      status,
      amount: data.amount,
      currency: data.currency,
      attemptId,
      orderId,
      updatedAt: data.updatedAt,
      testMode: F.TEST_MODE,
    });
  } catch (err) {
    F.log('STATUS_ERROR', { orderId, attemptId, message: String(err && err.message) });
    return res.status(500).json({ error: 'Could not check the payment status.' });
  }
};
