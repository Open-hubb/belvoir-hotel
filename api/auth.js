/**
 * Sign in, sign out, and staff account management.
 *
 *   GET  /api/auth                          who am I
 *   POST /api/auth  {action:'login'}        email + password -> session cookie
 *   POST /api/auth  {action:'logout'}       revoke this session
 *   POST /api/auth  {action:'password'}     change my own password
 *   GET  /api/auth?action=users             list staff            (admin)
 *   POST /api/auth  {action:'invite'}       add a staff account   (admin)
 *   POST /api/auth  {action:'disable'}      disable/enable staff  (admin)
 *
 * There is deliberately no public sign-up. This dashboard shows every guest's
 * name, email, phone and stay history, so accounts are created by someone who
 * is already signed in. The first account comes from scripts/create-admin.mjs.
 */

const { neon } = require('@neondatabase/serverless');
const { limit } = require('./_ratelimit');
const A = require('./_auth');

let _sql = null;
function db() {
  if (!_sql) _sql = neon(process.env.DATABASE_URL);
  return _sql;
}

const clean = (v, n) => String(v == null ? '' : v).trim().slice(0, n);
const publicUser = (u) => ({ id: u.id, email: u.email, name: u.name, role: u.role });

function query(req) {
  if (req.query && Object.keys(req.query).length) return req.query;
  return Object.fromEntries(new URL(req.url, 'http://localhost').searchParams);
}

module.exports = async (req, res) => {
  const sql = db();

  try {
    // ── who am I ─────────────────────────────────────────────────────────
    if (req.method === 'GET') {
      const q = query(req);

      if (q.action === 'users') {
        const me = await A.isAdminRequest(sql, req);
        if (!me) return res.status(401).json({ error: 'Not signed in' });
        const rows = await sql`
          SELECT id, email, name, role, disabled, created_at, last_login_at
          FROM admin_users ORDER BY created_at ASC`;
        return res.status(200).json({ users: rows, me: publicUser(me) });
      }

      const user = await A.sessionUser(sql, req);
      if (!user) return res.status(401).json({ error: 'Not signed in' });
      return res.status(200).json({ user: publicUser(user) });
    }

    if (req.method !== 'POST') {
      res.setHeader('Allow', 'GET, POST');
      return res.status(405).json({ error: 'Method not allowed' });
    }

    const body = req.body || {};
    const action = String(body.action || '');

    // ── sign in ──────────────────────────────────────────────────────────
    if (action === 'login') {
      // Tight, because this is the one endpoint worth guessing at.
      if (limit(req, res, 'login', 8, 15 * 60000)) return;

      const email = clean(body.email, 160).toLowerCase();
      const password = String(body.password || '');
      if (!email || !password) {
        return res.status(400).json({ error: 'Enter your email and password.' });
      }

      const rows = await sql`
        SELECT id, email, name, role, password_hash, disabled
        FROM admin_users WHERE lower(email) = ${email} LIMIT 1`;

      // Same work and the same message whether or not the address exists, so
      // this cannot be used to discover who has an account.
      if (!rows.length) {
        await A.dummyVerify();
        return res.status(401).json({ error: 'Email or password not recognised.' });
      }
      const user = rows[0];
      const ok = await A.verifyPassword(password, user.password_hash);
      if (!ok || user.disabled) {
        return res.status(401).json({ error: 'Email or password not recognised.' });
      }

      const { token, maxAge } = await A.createSession(sql, user.id, req.headers['user-agent']);
      await sql`UPDATE admin_users SET last_login_at = now() WHERE id = ${user.id}`;
      A.setSessionCookie(res, token, maxAge);
      return res.status(200).json({ ok: true, user: publicUser(user) });
    }

    // ── sign out ─────────────────────────────────────────────────────────
    if (action === 'logout') {
      await A.destroySession(sql, A.readCookie(req, A.COOKIE));
      A.clearSessionCookie(res);
      return res.status(200).json({ ok: true });
    }

    // Everything past here needs to be signed in.
    const me = await A.isAdminRequest(sql, req);
    if (!me) return res.status(401).json({ error: 'Not signed in' });

    // ── change my own password ───────────────────────────────────────────
    if (action === 'password') {
      if (limit(req, res, 'pwchange', 10, 15 * 60000)) return;
      if (me.legacy) {
        return res.status(400).json({ error: 'Sign in with an email account to change a password.' });
      }
      const current = String(body.current || '');
      const next = String(body.next || '');

      const rows = await sql`SELECT password_hash FROM admin_users WHERE id = ${me.id} LIMIT 1`;
      if (!rows.length || !(await A.verifyPassword(current, rows[0].password_hash))) {
        return res.status(401).json({ error: 'Your current password is not right.' });
      }
      const problem = A.passwordProblem(next);
      if (problem) return res.status(400).json({ error: problem });

      await sql`UPDATE admin_users SET password_hash = ${await A.hashPassword(next)} WHERE id = ${me.id}`;
      // Changing a password should end every other session, which is the whole
      // point of changing it after a scare.
      const keep = A.readCookie(req, A.COOKIE);
      await sql`DELETE FROM admin_sessions WHERE user_id = ${me.id}`;
      const { token, maxAge } = await A.createSession(sql, me.id, req.headers['user-agent']);
      A.setSessionCookie(res, token, maxAge);
      void keep;
      return res.status(200).json({ ok: true, signedOutElsewhere: true });
    }

    // ── add a staff account ──────────────────────────────────────────────
    if (action === 'invite') {
      const email = clean(body.email, 160).toLowerCase();
      const name = clean(body.name, 120);
      const password = String(body.password || '');
      const role = ['owner', 'manager'].includes(body.role) ? body.role : 'manager';

      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return res.status(400).json({ error: 'That email address does not look right.' });
      }
      const problem = A.passwordProblem(password);
      if (problem) return res.status(400).json({ error: problem });

      const exists = await sql`SELECT 1 FROM admin_users WHERE lower(email) = ${email} LIMIT 1`;
      if (exists.length) return res.status(409).json({ error: 'That email already has an account.' });

      const rows = await sql`
        INSERT INTO admin_users (email, password_hash, name, role)
        VALUES (${email}, ${await A.hashPassword(password)}, ${name || email}, ${role})
        RETURNING id, email, name, role`;
      return res.status(201).json({ ok: true, user: rows[0] });
    }

    // ── disable or re-enable a staff account ─────────────────────────────
    if (action === 'disable') {
      const id = parseInt(body.id, 10);
      const disabled = body.disabled !== false;
      if (!id) return res.status(400).json({ error: 'Missing id' });
      if (id === me.id) return res.status(400).json({ error: 'You cannot disable your own account.' });

      // Never let the last working account be switched off.
      if (disabled) {
        const left = await sql`
          SELECT count(*)::int AS n FROM admin_users WHERE disabled = false AND id <> ${id}`;
        if (left[0].n === 0) {
          return res.status(400).json({ error: 'This is the only active account. Add another first.' });
        }
      }

      const rows = await sql`
        UPDATE admin_users SET disabled = ${disabled} WHERE id = ${id}
        RETURNING id, email, name, role, disabled`;
      if (!rows.length) return res.status(404).json({ error: 'No such account' });
      // A disabled account should lose its sessions there and then.
      if (disabled) await sql`DELETE FROM admin_sessions WHERE user_id = ${id}`;
      return res.status(200).json({ ok: true, user: rows[0] });
    }

    return res.status(400).json({ error: 'Unknown action' });
  } catch (e) {
    console.error('auth api error:', e);
    return res.status(500).json({ error: 'Server error' });
  }
};
