// A small fixed-window limiter.
//
// Vercel keeps a warm function instance alive across requests, so an in-memory
// counter throttles a sustained attack from one address effectively. It is not
// a distributed limiter: a burst spread across cold starts can slip through.
// For a property this size that is the right trade, and it is a great deal
// better than the nothing that was here before. If the site ever needs a hard
// guarantee, move the counter to Postgres or Upstash and keep this interface.

const buckets = new Map();
const MAX_TRACKED = 5000;

function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (fwd) return String(fwd).split(',')[0].trim();
  return req.headers['x-real-ip'] || (req.socket && req.socket.remoteAddress) || 'unknown';
}

function sweep(now) {
  for (const [key, b] of buckets) {
    if (b.resetAt <= now) buckets.delete(key);
  }
  // Never let the map grow without bound if traffic is heavy and varied
  if (buckets.size > MAX_TRACKED) buckets.clear();
}

/**
 * Returns { allowed, remaining, retryAfter }.
 * Call once per request, before doing any real work.
 */
function take(req, name, limit, windowMs) {
  const now = Date.now();
  if (buckets.size > 200) sweep(now);

  const key = name + ':' + clientIp(req);
  let b = buckets.get(key);
  if (!b || b.resetAt <= now) {
    b = { count: 0, resetAt: now + windowMs };
    buckets.set(key, b);
  }
  b.count++;

  const allowed = b.count <= limit;
  return {
    allowed,
    remaining: Math.max(0, limit - b.count),
    retryAfter: Math.ceil((b.resetAt - now) / 1000),
  };
}

/**
 * Guard a handler. Sends 429 and returns true when the caller should stop.
 *
 *   if (limit(req, res, 'bookings', 10, 60_000)) return;
 */
function limit(req, res, name, max, windowMs) {
  const r = take(req, name, max, windowMs);
  res.setHeader('X-RateLimit-Limit', String(max));
  res.setHeader('X-RateLimit-Remaining', String(r.remaining));
  if (!r.allowed) {
    res.setHeader('Retry-After', String(r.retryAfter));
    res.status(429).json({
      error: 'Too many requests. Please wait a moment and try again.',
      retryAfter: r.retryAfter,
    });
    return true;
  }
  return false;
}

module.exports = { limit, take, clientIp };

/**
 * The same fixed window, but counted in Postgres so every function instance
 * shares it.
 *
 * The in-memory limiter above is per instance. On serverless that is fine for
 * holding back booking spam, and not fine for guessing a password: an attacker
 * who spreads attempts across cold starts gets a fresh allowance each time.
 * Sign-in is rare enough that a round-trip costs nothing, so those endpoints
 * count here instead.
 *
 * The upsert is a single statement, so two simultaneous attempts cannot both
 * read the same count and both decide they are under the limit.
 *
 *   if (await limitShared(sql, req, res, 'login', 8, 15 * 60000)) return;
 */
async function limitShared(sql, req, res, name, max, windowMs) {
  const bucket = `${name}:${clientIp(req)}`;
  const seconds = Math.ceil(windowMs / 1000);

  let row;
  try {
    const rows = await sql`
      INSERT INTO rate_limits (bucket, hits, window_start)
      VALUES (${bucket}, 1, now())
      ON CONFLICT (bucket) DO UPDATE SET
        hits = CASE
          WHEN rate_limits.window_start < now() - (${seconds} || ' seconds')::interval
          THEN 1 ELSE rate_limits.hits + 1 END,
        window_start = CASE
          WHEN rate_limits.window_start < now() - (${seconds} || ' seconds')::interval
          THEN now() ELSE rate_limits.window_start END
      RETURNING hits, window_start`;
    row = rows[0];
  } catch (err) {
    // A limiter that fails closed would lock everyone out of the dashboard the
    // moment the database hiccups. Fall back to the in-memory counter, which is
    // weaker but still a limit, and say so in the log.
    console.error('shared rate limit unavailable, using in-memory:', err.message);
    return limit(req, res, name, max, windowMs);
  }

  if (row.hits > max) {
    const resetAt = new Date(row.window_start).getTime() + windowMs;
    const retryAfter = Math.max(1, Math.ceil((resetAt - Date.now()) / 1000));
    res.setHeader('Retry-After', String(retryAfter));
    res.setHeader('X-RateLimit-Limit', String(max));
    res.setHeader('X-RateLimit-Remaining', '0');
    res.status(429).json({ error: 'Too many attempts. Please wait and try again.' });
    return true;
  }

  res.setHeader('X-RateLimit-Limit', String(max));
  res.setHeader('X-RateLimit-Remaining', String(Math.max(0, max - row.hits)));
  return false;
}

/** Old windows are dead weight; the cron sweeps them while it runs. */
async function sweepRateLimits(sql) {
  const gone = await sql`
    DELETE FROM rate_limits WHERE window_start < now() - interval '24 hours' RETURNING bucket`;
  return gone.length;
}

module.exports.limitShared = limitShared;
module.exports.sweepRateLimits = sweepRateLimits;
