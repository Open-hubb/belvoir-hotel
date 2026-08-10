/**
 * Payment reconciliation, run on a schedule by Vercel Cron.
 *
 * The payment modal polls Flot from the guest's browser, which works right up
 * until the guest closes the tab. Money moves, nobody tells us, and the booking
 * sits unpaid while the room stays held. This asks Flot about every attempt
 * that is still open and settles it, so the outcome no longer depends on the
 * guest keeping a tab alive.
 *
 * It is deliberately the same idempotent write as api/flot-status.js and the
 * webhook receiver: whichever arrives first wins, the others no-op.
 *
 *   GET /api/cron-poll-payments        (Authorization: Bearer $CRON_SECRET)
 */

const { neon } = require('@neondatabase/serverless');
const crypto = require('crypto');
const F = require('./_flot');
const { settleBooking } = require('./_paid');
const { sweepRateLimits } = require('./_ratelimit');

let _sql = null;
function db() {
  if (!_sql) _sql = neon(process.env.DATABASE_URL);
  return _sql;
}

// How long an attempt stays worth asking about. Past this it is almost
// certainly abandoned, and polling it forever costs a request every run.
const STALE_AFTER_HOURS = 24;
// Ceiling per run so one invocation cannot hang on a long queue.
const BATCH = 40;

function authorised(req) {
  const secret = process.env.CRON_SECRET || '';
  // Refuse rather than run open to the world if the secret was never set.
  if (!secret) return false;

  const header = req.headers['authorization'] || '';
  const provided = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!provided) return false;

  const a = Buffer.from(provided);
  const b = Buffer.from(secret);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Ask Flot where a single attempt stands. */
async function fetchStatus(orderId, attemptId) {
  const path = `/merchants/private/v1/external-orders/${encodeURIComponent(orderId)}/payment-attempts/${encodeURIComponent(attemptId)}`;
  const r = await fetch(`${F.API_BASE}${path}`, {
    method: 'GET',
    headers: {
      'X-Flot-Merchant-Signature': F.signCanonical('GET', path),
      'X-Flot-Merchant-Id': F.MERCHANT_ID,
    },
  });
  const json = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`flot ${r.status}`);
  return String(((json && json.data) || {}).status || 'created');
}

module.exports = async (req, res) => {
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!authorised(req)) {
    F.log('CRON_DENIED', { reason: process.env.CRON_SECRET ? 'bad token' : 'CRON_SECRET not set' });
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // In test mode Flot is mocked, and a mock that reports "completed" would mark
  // real bookings paid for free. Never reconcile against a mock.
  if (F.TEST_MODE) {
    F.log('CRON_SKIPPED', { reason: 'test mode' });
    return res.status(200).json({ ok: true, skipped: 'test mode', checked: 0 });
  }

  const started = Date.now();
  try {
    const sql = db();

    const open = await sql`
      SELECT p.id, p.reference, p.provider_ref, p.booking_id
      FROM payments p
      WHERE p.status IN ('created', 'pending')
        AND p.provider_ref IS NOT NULL
        AND p.received_at > now() - (${STALE_AFTER_HOURS} || ' hours')::interval
      ORDER BY p.received_at ASC
      LIMIT ${BATCH}`;

    let completed = 0, failed = 0, unchanged = 0, errored = 0;

    for (const p of open) {
      let status;
      try {
        status = await fetchStatus(p.reference, p.provider_ref);
      } catch (err) {
        // A provider blip must not abort the batch; it gets picked up next run.
        errored++;
        F.log('CRON_LOOKUP_FAILED', { orderId: p.reference, message: String(err && err.message) });
        continue;
      }

      if (status === 'completed') {
        await sql`UPDATE payments SET status = 'completed' WHERE id = ${p.id}`;
        if (p.booking_id) {
          // Settles the booking and, if the guest closed the tab before the
          // browser could poll, this is what finally sends their receipt.
          await settleBooking(sql, p.booking_id, p.provider_ref, 'reconciled');
        }
        completed++;
        F.log('CRON_PAYMENT_COMPLETED', { orderId: p.reference, bookingId: p.booking_id });
      } else if (status === 'failed') {
        // The guest can still retry, so only the attempt is closed off.
        await sql`UPDATE payments SET status = 'failed' WHERE id = ${p.id}`;
        failed++;
      } else {
        unchanged++;
      }
    }

    // Stop asking about attempts nobody ever finished.
    const expired = await sql`
      UPDATE payments SET status = 'expired'
      WHERE status IN ('created', 'pending')
        AND received_at <= now() - (${STALE_AFTER_HOURS} || ' hours')::interval
      RETURNING id`;

    // Piggyback the housekeeping rather than adding a second schedule.
    let sweptLimits = 0;
    try { sweptLimits = await sweepRateLimits(sql); } catch (e) {}

    const result = {
      ok: true,
      checked: open.length,
      sweptLimits,
      completed,
      failed,
      unchanged,
      errored,
      expired: expired.length,
      ms: Date.now() - started,
    };
    F.log('CRON_RUN', result);
    return res.status(200).json(result);
  } catch (err) {
    F.log('CRON_ERROR', { message: String(err && err.message) });
    return res.status(500).json({ error: 'Reconciliation failed' });
  }
};
