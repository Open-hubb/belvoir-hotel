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
