/**
 * Admin authentication: password hashing, sessions, and the guard every
 * admin endpoint calls.
 *
 * Two things are deliberate here.
 *
 * Passwords are hashed with scrypt, which ships with Node. bcrypt and argon2
 * are native modules and would have to build on every deploy; scrypt is
 * memory-hard and needs no dependency.
 *
 * The session token lives in an httpOnly cookie, so page JavaScript cannot
 * read it. The previous scheme kept the admin key in sessionStorage, which is
 * exactly what the stored-XSS in the dashboard was able to steal. Only the
 * SHA-256 of the token is stored, so a dump of admin_sessions grants nobody
 * a session, and deleting a row revokes access immediately.
 */

const crypto = require('crypto');

const COOKIE = 'belvoir_admin';
const SESSION_DAYS = 14;

// ── passwords ──────────────────────────────────────────────────────────────
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 };

function scrypt(password, salt) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p }, (err, dk) =>
      err ? reject(err) : resolve(dk));
  });
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const dk = await scrypt(password, salt);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${dk.toString('base64')}`;
}

async function verifyPassword(password, stored) {
  try {
    const [scheme, N, r, p, saltB64, hashB64] = String(stored || '').split('$');
    if (scheme !== 'scrypt') return false;
    const salt = Buffer.from(saltB64, 'base64');
    const expected = Buffer.from(hashB64, 'base64');
    const dk = await new Promise((resolve, reject) => {
      crypto.scrypt(password, salt, expected.length,
        { N: Number(N), r: Number(r), p: Number(p) }, (e, k) => e ? reject(e) : resolve(k));
    });
    return dk.length === expected.length && crypto.timingSafeEqual(dk, expected);
  } catch {
    return false;
  }
}

/**
 * Burn roughly the same time as a real verification when the email does not
 * exist, so response timing does not reveal which addresses are registered.
 */
async function dummyVerify() {
  await scrypt('no-such-user', Buffer.alloc(16)).catch(() => {});
}

// ── password rules ─────────────────────────────────────────────────────────
/** Long beats complex: length is what actually resists guessing. */
function passwordProblem(pw) {
  const s = String(pw || '');
  if (s.length < 10) return 'Use at least 10 characters.';
  if (s.length > 200) return 'That password is too long.';
  if (!/[a-zA-Z]/.test(s) || !/[0-9]/.test(s)) return 'Include at least one letter and one number.';
  if (/^(password|belvoir|12345)/i.test(s)) return 'Please choose something less guessable.';
  return null;
}

// ── cookies ────────────────────────────────────────────────────────────────
function readCookie(req, name) {
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i === -1) continue;
    if (part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return '';
}

function setSessionCookie(res, token, maxAgeSeconds) {
  // Secure is omitted on plain-HTTP localhost only, so dev still works.
  const secure = process.env.NODE_ENV === 'production' || process.env.VERCEL ? '; Secure' : '';
  res.setHeader('Set-Cookie',
    `${COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSeconds}${secure}`);
}

function clearSessionCookie(res) {
  const secure = process.env.NODE_ENV === 'production' || process.env.VERCEL ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure}`);
}

// ── sessions ───────────────────────────────────────────────────────────────
const sha256 = (v) => crypto.createHash('sha256').update(String(v)).digest('hex');

/**
 * A password-reset or invitation secret. As with sessions, only its SHA-256
 * digest goes to Postgres. The recipient receives the raw value once, in an
 * email link whose fragment is not sent to the server in ordinary requests.
 */
function hashAccessToken(token) {
  return sha256(token);
}

function createAccessToken() {
  const token = crypto.randomBytes(32).toString('base64url');
  return { token, hash: hashAccessToken(token) };
}

function canManageAdmins(user) {
  return Boolean(user && user.role === 'owner');
}

async function createSession(sql, userId, userAgent) {
  const token = crypto.randomBytes(32).toString('base64url');
  const expires = new Date(Date.now() + SESSION_DAYS * 86400_000);
  await sql`
    INSERT INTO admin_sessions (token_hash, user_id, expires_at, user_agent)
    VALUES (${sha256(token)}, ${userId}, ${expires.toISOString()}, ${String(userAgent || '').slice(0, 200)})`;
  return { token, maxAge: SESSION_DAYS * 86400 };
}

async function destroySession(sql, token) {
  if (!token) return;
  await sql`DELETE FROM admin_sessions WHERE token_hash = ${sha256(token)}`;
}

/** The signed-in user for this request, or null. Expired rows are cleaned up. */
async function sessionUser(sql, req) {
  const token = readCookie(req, COOKIE);
  if (!token) return null;
  const rows = await sql`
    SELECT u.id, u.email, u.name, u.role, u.disabled
    FROM admin_sessions s
    JOIN admin_users u ON u.id = s.user_id
    WHERE s.token_hash = ${sha256(token)} AND s.expires_at > now()
    LIMIT 1`;
  if (!rows.length || rows[0].disabled) return null;
  return rows[0];
}

// ── the guard ──────────────────────────────────────────────────────────────
/**
 * True when the caller may use an admin endpoint.
 *
 * A session cookie is the normal route. ADMIN_KEY is still accepted so that
 * anything scripted against the API keeps working; it can be retired by
 * removing the variable once nothing depends on it.
 */
async function isAdminRequest(sql, req) {
  const user = await sessionUser(sql, req);
  if (user) return user;

  const key = process.env.ADMIN_KEY || '';
  const header = req.headers['authorization'] || '';
  const provided = header.startsWith('Bearer ') ? header.slice(7) : (req.headers['x-admin-key'] || '');
  if (!key || !provided) return null;
  const a = Buffer.from(String(provided));
  const b = Buffer.from(key);
  if (a.length === b.length && crypto.timingSafeEqual(a, b)) {
    return { id: 0, email: 'legacy-key', name: 'Access key', role: 'owner', legacy: true };
  }
  return null;
}

module.exports = {
  COOKIE,
  SESSION_DAYS,
  hashPassword,
  verifyPassword,
  dummyVerify,
  passwordProblem,
  hashAccessToken,
  createAccessToken,
  canManageAdmins,
  readCookie,
  setSessionCookie,
  clearSessionCookie,
  createSession,
  destroySession,
  sessionUser,
  isAdminRequest,
};
