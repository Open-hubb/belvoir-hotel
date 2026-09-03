// GET /api/flot-status?orderId=belvoir-19&attemptId=<id>&claim=<booking claim>
//
// Polled by the payment modal. This is the path that does not depend on Flot's
// webhook configuration: when Flot reports the attempt completed, the booking
// is marked paid here. The webhook receiver stays in place as a second route to
// the same outcome, and both are idempotent.

const { neon } = require('@neondatabase/serverless');
const F = require('./_flot');
const { limit } = require('./_ratelimit');
const paid = require('./_paid');
const { settleBooking } = paid;
const deliverPendingPaymentNotifications = paid.deliverPendingPaymentNotifications ||
  (async () => ({ claimed: 0, delivered: 0, pending: 0 }));
const { acquireBookingHold } = require('./_inventory');
const { pausePaymentListener } = require('./_payment-listeners');

let _sql = null;
function db() {
  if (!_sql) _sql = neon(process.env.DATABASE_URL);
  return _sql;
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

  if (pausePaymentListener(res)) return;
  if (limit(req, res, 'status', 90, 60000)) return;

  const q = query(req);
  const orderId = String(q.orderId || '');
  const attemptId = String(q.attemptId || '');
  const claim = String(q.claim || '');
  if (!orderId || !attemptId || !claim) {
    return res.status(400).json({ error: 'orderId, attemptId and claim are required.' });
  }

  const path = `/merchants/private/v1/external-orders/${encodeURIComponent(orderId)}/payment-attempts/${encodeURIComponent(attemptId)}`;

  try {
    const sql = db();
    // Authenticate against the exact payment attempt, not an id parsed from a
    // caller-controlled order string. A miss and a bad claim deliberately have
    // the same response so this route cannot be used to enumerate bookings.
    const matches = await sql`
      SELECT p.id AS payment_id, b.id AS booking_id, b.claim_token, b.payment_status,
        b.inventory_status, p.status AS attempt_status, p.amount, p.currency
      FROM payments p
      JOIN bookings b ON b.id = p.booking_id
      WHERE p.reference = ${orderId} AND p.provider_ref = ${attemptId}
      LIMIT 1`;
    const payment = matches[0] || null;
    if (!payment || payment.claim_token !== claim) {
      F.log('STATUS_DENIED', { orderId, attemptId, reason: 'claim token mismatch' });
      return res.status(403).json({ error: 'This payment cannot be checked from here.' });
    }

    let data;
    if (payment.attempt_status === 'completed') {
      data = {
        status: 'completed',
        amount: payment.amount,
        currency: payment.currency,
      };
    } else if (F.TEST_MODE) {
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
    let settlement = null;
    let finalBookingState = null;

    if (status === 'completed') {
      // Settle before closing the attempt row. If the database call fails, a
      // later poll can retry; if another listener won, settlement is a no-op.
      settlement = await settleBooking(
        sql,
        payment.booking_id,
        `flot-payment:${payment.payment_id}`,
        'browser',
        attemptId,
      );
      finalBookingState = settlement.booking || null;
      await sql`
        UPDATE payments SET status = 'completed', matched = true,
          provider_raw = CASE
            WHEN ${payment.attempt_status !== 'completed'} THEN ${JSON.stringify(data)}
            ELSE provider_raw
          END,
          completed_at = COALESCE(completed_at, clock_timestamp())
        WHERE reference = ${orderId} AND provider_ref = ${attemptId}`;
      F.log('PAYMENT_COMPLETED', {
        orderId,
        attemptId,
        bookingId: payment.booking_id,
        inventoryConflict: settlement.conflict === true,
      });
      if (settlement.resolutionRequired) {
        return res.status(409).json({
          code: 'PAYMENT_RECONCILIATION_REQUIRED',
          error: 'Your payment was recorded and needs staff review before the booking can be confirmed.',
          status,
          attemptStatus: status,
          bookingFinal: false,
          bookingSettled: false,
          settlementAlreadyProcessed: false,
          resolutionRequired: true,
          receiptAvailable: true,
          amount: data.amount ?? payment.amount,
          currency: data.currency ?? payment.currency,
          attemptId,
          orderId,
          updatedAt: data.updatedAt,
          testMode: F.TEST_MODE,
          inventoryConflict: false,
        });
      }
    } else if (status === 'created' || status === 'pending') {
      const hold = await acquireBookingHold(sql, payment.booking_id, claim);
      if (!hold.acquired) {
        // Another listener or another attempt may have paid the booking between
        // the provider lookup and this hold refresh. Re-read under that reality
        // instead of showing a false expiry or claiming this attempt completed.
        const bookings = await sql`
          SELECT payment_status, inventory_status
          FROM bookings WHERE id = ${payment.booking_id} LIMIT 1`;
        const current = bookings[0] || null;
        if (current && current.payment_status === 'paid') {
          await deliverPendingPaymentNotifications(sql, payment.booking_id);
          return res.status(200).json({
            status,
            attemptStatus: status,
            bookingFinal: true,
            bookingPaymentStatus: 'paid',
            bookingInventoryStatus: current.inventory_status || null,
            receiptAvailable: false,
            amount: null,
            currency: null,
            attemptId,
            orderId,
            updatedAt: data.updatedAt,
            testMode: F.TEST_MODE,
            inventoryConflict: current.inventory_status === 'conflict',
            bookingSettled: false,
            settlementAlreadyProcessed: false,
            resolutionRequired: false,
          });
        }
        return res.status(409).json({
          error: 'Your room hold has expired. Please check availability again before paying.',
          code: 'HOLD_EXPIRED',
        });
      }
      await sql`
        UPDATE payments SET status = ${status}, provider_raw = ${JSON.stringify(data)}
        WHERE reference = ${orderId} AND provider_ref = ${attemptId}`;
    } else if (status === 'failed') {
      await sql`
        UPDATE payments SET status = 'failed', provider_raw = ${JSON.stringify(data)}
        WHERE reference = ${orderId} AND provider_ref = ${attemptId}`;
      const bookings = await sql`
        SELECT payment_status, inventory_status
        FROM bookings WHERE id = ${payment.booking_id} LIMIT 1`;
      finalBookingState = bookings[0] || null;
      if (finalBookingState && finalBookingState.payment_status === 'paid') {
        await deliverPendingPaymentNotifications(sql, payment.booking_id);
      }
    }

    // "failed" is a card error, so the order stays open and the guest can retry
    const settledBooking = finalBookingState || (settlement && settlement.booking) || null;
    const bookingPaymentStatus = settledBooking
      ? settledBooking.payment_status
      : ((settlement && (settlement.settled || settlement.alreadyPaid))
        ? 'paid'
        : payment.payment_status);
    const bookingFinal = bookingPaymentStatus === 'paid';
    const bookingInventoryStatus = finalBookingState
      ? finalBookingState.inventory_status
      : (settlement && settlement.booking
        ? settlement.booking.inventory_status
        : payment.inventory_status);
    const historicalReset = Boolean(
      settlement && settlement.alreadyProcessed === true && !bookingFinal,
    );
    return res.status(200).json({
      status,
      attemptStatus: status,
      bookingFinal,
      bookingPaymentStatus,
      bookingInventoryStatus,
      bookingSettled: settlement ? settlement.settled === true : false,
      settlementAlreadyProcessed: settlement ? settlement.alreadyProcessed === true : false,
      resolutionRequired: settlement ? settlement.resolutionRequired === true : false,
      settlementOutcome: settlement ? settlement.settlementOutcome || null : null,
      receiptAvailable: status === 'completed',
      amount: data.amount ?? payment.amount,
      currency: data.currency ?? payment.currency,
      attemptId,
      orderId,
      updatedAt: data.updatedAt,
      testMode: F.TEST_MODE,
      inventoryConflict: historicalReset
        ? bookingInventoryStatus === 'conflict'
        : (settlement
          ? settlement.conflict === true
          : bookingInventoryStatus === 'conflict'),
    });
  } catch (err) {
    F.log('STATUS_ERROR', { orderId, attemptId, message: String(err && err.message) });
    return res.status(500).json({ error: 'Could not check the payment status.' });
  }
};
