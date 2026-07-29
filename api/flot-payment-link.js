// POST /api/flot-payment-link
// Body: { bookingId, claim, type }  ->  { orderId, attemptId, link, code, qrDataUrl, amount, currency }
//
// The amount is read from the booking row, never taken from the request, so a
// caller cannot choose what they pay. The claim token issued when the booking
// was created is required, so one guest cannot open payment links against
// another guest's booking.

const { neon } = require('@neondatabase/serverless');
const QRCode = require('qrcode');
const F = require('./_flot');

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

    if (!rows.length) return res.status(404).json({ error: 'Booking not found.' });
    const booking = rows[0];

    if (booking.claim_token && booking.claim_token !== claim) {
      F.log('PAYMENT_LINK_DENIED', { bookingId, reason: 'claim token mismatch' });
      return res.status(403).json({ error: 'This booking cannot be paid from here.' });
    }

    if (booking.payment_status === 'paid') {
      return res.status(409).json({ error: 'This booking has already been paid.' });
    }

    const usd = Number(booking.amount_due || booking.total || 0);
    if (!(usd > 0)) return res.status(400).json({ error: 'This booking has no amount due.' });

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
    let qrDataUrl = null;
    if (data.link) {
      qrDataUrl = await QRCode.toDataURL(data.link, {
        width: 320,
        margin: 1,
        color: { dark: '#0C1B33', light: '#FFFDF8' },
      }).catch(() => null);
    }

    // Record the attempt so polling and the webhook can both reconcile it
    await sql`
      INSERT INTO payments
        (booking_id, reference, payer_name, payer_email, amount, currency,
         status, provider_ref, matched, raw)
      VALUES
        (${bookingId}, ${orderId}, ${booking.guest_name || null}, ${booking.guest_email || null},
         ${amount}, ${currency}, 'created', ${data.id || null}, true,
         ${JSON.stringify({ type, testMode: F.TEST_MODE, link: data.link || null, code: data.code || null })})`;

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
