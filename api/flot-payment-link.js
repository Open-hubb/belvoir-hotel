// POST /api/flot-payment-link
// Body: { bookingId, claim, type }  ->  { orderId, attemptId, link, code, qrDataUrl, amount, currency }
//
// The amount is read from the booking row, never taken from the request, so a
// caller cannot choose what they pay. The claim token issued when the booking
// was created is required, so one guest cannot open payment links against
// another guest's booking.

const { neon } = require('@neondatabase/serverless');
const QRCode = require('qrcode');
const crypto = require('crypto');
const F = require('./_flot');
const { limit } = require('./_ratelimit');
const { acquireBookingHold } = require('./_inventory');
const { pausePaymentListener } = require('./_payment-listeners');

let _sql = null;
function db() {
  if (!_sql) _sql = neon(process.env.DATABASE_URL);
  return _sql;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (pausePaymentListener(res)) return;
  if (limit(req, res, 'paylink', 15, 60000)) return;

  const body = req.body || {};
  const bookingId = parseInt(body.bookingId, 10);
  const type = String(body.type || '');
  const claim = body.claim ? String(body.claim) : '';

  // The guest picks the currency, so the payment lands in the matching merchant
  // wallet. Resolved against what the method actually accepts, because the
  // browser can send anything: mobile money is Leones only, so a USD request
  // there is corrected here rather than reaching Flot.
  const currencyChoice = F.resolveCurrency(type, body.currency);

  if (!bookingId || !F.TYPES.includes(type)) {
    return res.status(400).json({ error: 'A booking id and a valid payment type are required.' });
  }

  try {
    const sql = db();
    const rows = await sql`
      SELECT id, amount_due, total, payment_status, claim_token, guest_name, guest_email
      FROM bookings WHERE id = ${bookingId} LIMIT 1`;

    const booking = rows[0] || null;
    if (!booking || !claim || booking.claim_token !== claim) {
      F.log('PAYMENT_LINK_DENIED', { bookingId, reason: 'claim token mismatch' });
      return res.status(403).json({ error: 'This booking cannot be paid from here.' });
    }

    if (booking.payment_status === 'paid') {
      return res.status(409).json({ error: 'This booking has already been paid.' });
    }

    // Validate the immutable server-side amount before extending inventory.
    // A malformed booking must not occupy a room for another 15 minutes.
    const usd = Number(booking.amount_due || booking.total || 0);
    if (!(usd > 0)) return res.status(400).json({ error: 'This booking has no amount due.' });

    // The provider must never receive a request unless this guest still owns
    // a live unit. This also refreshes the checkout window to 15 minutes.
    const hold = await acquireBookingHold(sql, booking.id, claim);
    if (!hold.acquired) {
      return res.status(409).json({
        error: 'Your room hold has expired. Please check availability again before paying.',
        code: 'HOLD_EXPIRED',
      });
    }

    const { amount, currency } = F.amountFor(usd, currencyChoice);
    const orderId = F.orderIdFor(bookingId);

    F.log('PAYMENT_LINK_REQUEST', { orderId, bookingId, type, amount, currency });

    let data;
    if (F.TEST_MODE) {
      data = F.mockPaymentLink(type, orderId);
      F.log('TEST_MODE', { note: 'mock payment link', orderId, data });
    } else {
      const payload = {
        merchantId: F.MERCHANT_ID,
        type,
        payload: { orderId, amount, currency },
      };
      // Sign the exact string that is sent, never a re-serialised copy
      const bodyString = JSON.stringify(payload);
      const signature = F.signBody(bodyString);

      const r = await fetch(`${F.API_BASE}/merchants/private/v1/payment-links`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Flot-Merchant-Signature': signature,
        },
        body: bodyString,
      });

      const json = await r.json().catch(() => ({}));
      F.log('PAYMENT_LINK_RESPONSE', { orderId, httpStatus: r.status, response: json });

      if (!r.ok) {
        const detail = json && json.errors ? json.errors : json;
        return res.status(502).json({
          error: 'The payment provider rejected this request.',
          detail,
        });
      }
      data = (json && json.data) || {};
    }

    // in-app and card return a link, momo returns a USSD code
    // The QR points at a short code on our own domain, not at Flot's URL.
    // Flot's carries a JWT in the path and runs to about 1,130 characters,
    // which is 113 QR modules; at any size that fits a phone that lands near
    // 2.4px a module, and a decoder failed to read it at every size we ship.
    // A short code is 29 modules and roughly 8px a module. /api/p redirects.
    //
    // The guest still gets Flot's real URL for the "open the payment page"
    // link, so the tap-through path does not depend on the redirect at all.
    let shortCode = null;
    let qrTarget = data.link || null;
    if (data.link) {
      shortCode = crypto.randomBytes(6).toString('base64url').replace(/[^A-Za-z0-9]/g, '').slice(0, 8);
      if (shortCode.length === 8) {
        const origin = process.env.PUBLIC_ORIGIN || 'https://www.belvoir-estates.com';
        qrTarget = `${origin}/p/${shortCode}`;
      } else {
        shortCode = null;   // fall back to encoding the long URL
      }
    }

    let qrDataUrl = null;
    if (qrTarget) {
      qrDataUrl = await QRCode.toDataURL(qrTarget, {
        errorCorrectionLevel: 'M',
        scale: 8,
        margin: 4,
        color: { dark: '#000000', light: '#FFFFFF' },
      }).catch(() => null);
    }

    // Record the attempt so polling and the webhook can both reconcile it
    await sql`
      INSERT INTO payments
        (booking_id, reference, payer_name, payer_email, amount, currency,
         status, provider_ref, matched, raw, short_code, pay_link)
      VALUES
        (${bookingId}, ${orderId}, ${booking.guest_name || null}, ${booking.guest_email || null},
         ${amount}, ${currency}, 'created', ${data.id || null}, true,
         ${JSON.stringify({ type, testMode: F.TEST_MODE, link: data.link || null, code: data.code || null })},
         ${shortCode}, ${data.link || null})
      ON CONFLICT (reference, provider_ref) WHERE provider_ref IS NOT NULL
      DO UPDATE SET
        booking_id = COALESCE(payments.booking_id, EXCLUDED.booking_id),
        payer_name = COALESCE(payments.payer_name, EXCLUDED.payer_name),
        payer_email = COALESCE(payments.payer_email, EXCLUDED.payer_email),
        amount = COALESCE(EXCLUDED.amount, payments.amount),
        currency = COALESCE(EXCLUDED.currency, payments.currency),
        status = CASE
          WHEN payments.status IN ('completed', 'failed') THEN payments.status
          ELSE EXCLUDED.status
        END,
        matched = COALESCE(payments.matched, false) OR EXCLUDED.matched,
        raw = CASE WHEN payments.status = 'completed' THEN payments.raw ELSE EXCLUDED.raw END,
        short_code = COALESCE(payments.short_code, EXCLUDED.short_code),
        pay_link = COALESCE(payments.pay_link, EXCLUDED.pay_link)`;

    return res.status(200).json({
      orderId,
      attemptId: data.id,
      link: data.link || null,
      code: data.code || null,
      qrDataUrl,
      amount,
      currency,
      testMode: F.TEST_MODE,
    });
  } catch (err) {
    F.log('PAYMENT_LINK_ERROR', { bookingId, message: String(err && err.message) });
    return res.status(500).json({ error: 'Could not start the payment. Please try again.' });
  }
};
