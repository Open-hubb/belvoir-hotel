// Short link to a payment page.
//
//   GET /p/<code>  ->  302 to the Flot payment URL
//
// Flot's URL carries a JWT in the path and runs to ~1,130 characters. As a QR
// that is 113 modules, which at any size that fits on a phone works out around
// 2.4px a module — a decoder failed to read it at every display size we ship.
// A code on our own domain is 29 modules and about 8px a module instead.
//
// The code is the only thing between a stranger and someone's part-filled
// payment page, so it is 48 bits of randomness, single-purpose, and expires
// with the payment attempt it belongs to.

const { neon } = require('@neondatabase/serverless');
const { limit } = require('./_ratelimit');

let _sql = null;
function db() {
  if (!_sql) _sql = neon(process.env.DATABASE_URL);
  return _sql;
}

// Same window the cron uses when it expires an unpaid attempt. A link that
// outlived the payment it points at would only produce a confusing error on
// Flot's side.
const VALID_HOURS = 24;

/** Anything not in the alphabet we generate cannot be a real code. */
const CODE = /^[A-Za-z0-9]{8,16}$/;

module.exports = async (req, res) => {
  if (limit(req, res, 'paylink', 30, 60000)) return;

  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).send('Method not allowed');
  }

  const qs = (req.query && Object.keys(req.query).length)
    ? req.query
    : Object.fromEntries(new URL(req.url, 'http://localhost').searchParams);
  const code = String(qs.c || qs.code || '').trim();

  // res.redirect is a Vercel helper the local dev server does not provide, and
  // an error page is a poor way to find that out. writeHead works in both.
  const go = (to) => {
    res.statusCode = 302;
    res.setHeader('Location', to);
    res.end();
  };

  // Never say whether a code was malformed, unknown or merely expired — the
  // difference is only useful to somebody guessing.
  const dead = () => go('/?pay=expired');

  if (!CODE.test(code)) return dead();

  try {
    const rows = await db()`
      SELECT pay_link, received_at
      FROM payments
      WHERE short_code = ${code}
        AND pay_link IS NOT NULL
        AND received_at > now() - (${VALID_HOURS} || ' hours')::interval
      LIMIT 1`;

    if (!rows.length) return dead();

    // Not cached anywhere: the destination is single-use in spirit and short
    // lived, and a cached redirect would outlive the attempt.
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    res.setHeader('Referrer-Policy', 'no-referrer');
    return go(rows[0].pay_link);
  } catch (err) {
    console.error('pay link lookup failed:', err.message);
    return dead();
  }
};
