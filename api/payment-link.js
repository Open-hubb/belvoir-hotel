/**
 * Create a Flot payment link for a booking.
 * Implements the Flot Merchant Integration Guide v2.0, section 03.
 *
 * Requires two secrets, both set as Vercel environment variables:
 *   FLOT_MERCHANT_ID  - issued by Flot Staff during onboarding
 *   FLOT_PRIVATE_KEY  - the RSA-4096 private key whose public half Flot holds
 *
 * Until FLOT_MERCHANT_ID exists this responds 503 and the site falls back to
 * the hosted checkout link, so bookings keep working during onboarding.
 */

const { neon } = require('@neondatabase/serverless');
const crypto = require('crypto');

const FLOT_BASE = process.env.FLOT_API_BASE || 'https://api.app.flotme.ai';
const CURRENCY = process.env.FLOT_CURRENCY || 'SLE';

let _sql = null;
function db() {
  if (!_sql) _sql = neon(process.env.DATABASE_URL);
  return _sql;
}

/**
 * X-Flot-Merchant-Signature: base64( RSA-4096-PSS( SHA-512( requestString ) ) )
 * requestString is the stringified JSON body when a body is present,
 * otherwise the canonical "{METHOD}\n{PATH}".
 */
function signRequest(requestString) {
  const privateKey = process.env.FLOT_PRIVATE_KEY;
  if (!privateKey) throw new Error('FLOT_PRIVATE_KEY is not configured');

  const signer = crypto.createSign('RSA-SHA512');
  signer.update(requestString);
  signer.end();

  return signer.sign(
    {
      key: privateKey,
      padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
      saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
    },
    'base64',
  );
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const merchantId = process.env.FLOT_MERCHANT_ID;
  if (!merchantId || !process.env.FLOT_PRIVATE_KEY) {
    // Onboarding not finished — caller falls back to the hosted link
    return res.status(503).json({ error: 'Flot merchant account not configured yet' });
  }

  const bookingId = parseInt((req.body || {}).bookingId, 10);
  const claim = String((req.body || {}).claim || '');
  if (!bookingId || !claim) {
    return res.status(400).json({ error: 'Missing bookingId or claim' });
  }

  try {
    const sql = db();

    // Only the browser holding this booking's claim token may create its link,
    // and the amount comes from our own record rather than the request.
    const rows = await sql`
      SELECT id, amount_due, guest_name, guest_email, room_name
      FROM bookings
      WHERE id = ${bookingId} AND claim_token = ${claim}
      LIMIT 1`;
    if (!rows.length) return res.status(403).json({ error: 'Booking not found for this claim' });

    const booking = rows[0];
    const amount = Number(booking.amount_due);
    if (!(amount > 0)) return res.status(400).json({ error: 'Booking has no amount to pay' });

    const orderId = `belvoir-${booking.id}`;
    const requestBody = {
      merchantId,
      type: process.env.FLOT_PAYMENT_TYPE || 'in-app',
      payload: {
        orderId,
        currency: CURRENCY,
        amount: String(amount),
      },
    };

    const signature = signRequest(JSON.stringify(requestBody));

    const flotRes = await fetch(`${FLOT_BASE}/merchants/private/v1/payment-links`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Flot-Merchant-Id': merchantId,
        'X-Flot-Merchant-Signature': signature,
      },
      body: JSON.stringify(requestBody),
    });

    const text = await flotRes.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text };
    }

    if (!flotRes.ok) {
      console.error('flot payment-link failed:', flotRes.status, text.slice(0, 400));
      return res.status(502).json({ error: 'Could not create payment link', status: flotRes.status });
    }

    // Field name varies by response shape; take the first URL-looking value
    const link =
      data.paymentLink || data.link || data.url || data.paymentUrl ||
      (data.data && (data.data.paymentLink || data.data.link || data.data.url));

    await sql`
      UPDATE bookings
      SET notes = CASE WHEN COALESCE(notes, '') = ''
                       THEN ${'Flot order ' + orderId}
                       ELSE notes END
      WHERE id = ${booking.id}`;

    return res.status(200).json({ ok: true, orderId, link: link || null, raw: link ? undefined : data });
  } catch (e) {
    console.error('payment-link error:', e);
    return res.status(500).json({ error: 'Server error' });
  }
};
