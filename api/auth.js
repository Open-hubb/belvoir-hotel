/**
 * Sign in, sign out, and staff account management.
 *
 *   GET  /api/auth                          who am I
 *   POST /api/auth  {action:'login'}        email + password -> session cookie
 *   POST /api/auth  {action:'logout'}       revoke this session
 *   POST /api/auth  {action:'password'}     change my own password
 *   POST /api/auth  {action:'forgot'}       send a reset link
 *   POST /api/auth  {action:'claim'}        use a reset/invite link
 *   GET  /api/auth?action=users             list staff            (owner)
 *   POST /api/auth  {action:'invite'}       invite staff by email (owner)
 *   POST /api/auth  {action:'disable'}      disable/enable staff  (owner)
 *
 *   POST /api/auth  {action:'key'}          sign in with ADMIN_KEY
 *   POST /api/auth  {action:'setup'}        claim the very first account
 *
 * There is deliberately no public sign-up. This dashboard shows every guest's
 * name, email, phone and stay history, so accounts are created by someone who
 * is already signed in.
 *
 * The exception is the first one, which nobody can create from inside because
 * nobody can get in. 'setup' covers that: it works only while admin_users is
 * empty and only for an address on the hotel's own mail domain, then closes
 * permanently. scripts/create-admin.mjs still works for anyone who prefers a
 * terminal.
 */

const { neon } = require('@neondatabase/serverless');
const { limitShared } = require('./_ratelimit');
const A = require('./_auth');
const { sendAdminAccessEmail } = require('./_notify');

let _sql = null;
function db() {
  if (!_sql) _sql = neon(process.env.DATABASE_URL);
  return _sql;
}

const crypto = require('crypto');

const clean = (v, n) => String(v == null ? '' : v).trim().slice(0, n);

// The reserved account an access-key session attaches to. Shown in the Team
// list like any other, so key use is visible rather than invisible.
const KEY_ACCOUNT = 'access-key@local';

// Taken from the address the site already emails, so there is nothing extra to
// configure and the value is one the owner controls.
const SETUP_DOMAIN = (process.env.NOTIFY_EMAIL || 'info@belvoir-estates.com')
  .split(',')[0].trim().split('@').pop().toLowerCase();
const publicUser = (u) => ({ id: u.id, email: u.email, name: u.name, role: u.role });
const ACCESS_LINK_MINUTES = 30;
const emailLooksValid = (email) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);

function publicOrigin() {
  const fallback = 'https://www.belvoir-estates.com';
  const candidate = String(process.env.PUBLIC_ORIGIN || fallback).trim().replace(/\/+$/, '');
  try {
    const url = new URL(candidate);
    return url.protocol === 'https:' || url.hostname === 'localhost' ? url.origin : fallback;
  } catch {
    return fallback;
  }
}

// The secret is deliberately placed after #. Browser fragments do not reach
// the server in requests, nor appear in ordinary server access logs.
function accessLink(token) {
  return publicOrigin() + '/admin#access=' + encodeURIComponent(token);
}

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
        if (!A.canManageAdmins(me)) {
          return res.status(403).json({ error: 'Only owners can manage administrator access.' });
        }
        const rows = await sql`
          SELECT u.id, u.email, u.name, u.role, u.disabled, u.created_at, u.last_login_at,
            (
              SELECT expires_at FROM admin_access_tokens t
              WHERE t.user_id = u.id
                AND t.purpose = 'invite'
                AND t.expires_at > now()
              ORDER BY t.created_at DESC
              LIMIT 1
            ) AS invitation_expires_at
          FROM admin_users u
          ORDER BY u.created_at ASC`;
        return res.status(200).json({ users: rows, me: publicUser(me) });
      }

      const user = await A.sessionUser(sql, req);
      if (user) return res.status(200).json({ user: publicUser(user) });

      // With no accounts at all nobody could sign in, and the only way to make
      // the first one was a terminal command. The page needs to know so it can
      // offer to create it instead of asking for a password that cannot exist.
      // The reserved key account does not count as "somebody has an account":
      // keying in first should not take away the setup screen for a real one.
      const anyone = await sql`
        SELECT 1 FROM admin_users WHERE lower(email) <> ${KEY_ACCOUNT} LIMIT 1`;
      return res.status(401).json({
        error: 'Not signed in',
        needsSetup: anyone.length === 0,
        setupDomain: anyone.length === 0 ? SETUP_DOMAIN : undefined,
        keyLogin: Boolean(process.env.ADMIN_KEY),
      });
    }

    if (req.method !== 'POST') {
      res.setHeader('Allow', 'GET, POST');
      return res.status(405).json({ error: 'Method not allowed' });
    }

    const body = req.body || {};
    const action = String(body.action || '');

    // ── request a password reset ────────────────────────────────────────
    // This is intentionally public. Its response does not say whether an
    // address exists, is disabled, or is pending an invitation.
    if (action === 'forgot') {
      if (await limitShared(sql, req, res, 'forgot', 5, 15 * 60000)) return;

      const email = clean(body.email, 160).toLowerCase();
      const accepted = { ok: true, message: 'If that address has an active account, a secure link is on its way.' };
      if (!emailLooksValid(email)) return res.status(202).json(accepted);

      const rows = await sql`
        SELECT id, email, name, disabled
        FROM admin_users
        WHERE lower(email) = ${email}
        LIMIT 1`;
      if (!rows.length || rows[0].disabled) {
        await A.dummyVerify();
        return res.status(202).json(accepted);
      }

      const user = rows[0];
      const access = A.createAccessToken();
      const expiresAt = new Date(Date.now() + ACCESS_LINK_MINUTES * 60_000).toISOString();
      await sql`
        INSERT INTO admin_access_tokens (token_hash, user_id, purpose, expires_at)
        VALUES (${access.hash}, ${user.id}, 'reset', ${expiresAt})
        ON CONFLICT (user_id, purpose) DO UPDATE
        SET token_hash = EXCLUDED.token_hash,
            created_at = now(),
            expires_at = EXCLUDED.expires_at`;

      try {
        const sent = await sendAdminAccessEmail({
          to: user.email,
          name: user.name || user.email,
          kind: 'reset',
          url: accessLink(access.token),
        });
        // Do not leave a usable secret behind if mail delivery is unavailable.
        if (sent && sent.skipped) {
          await sql`DELETE FROM admin_access_tokens WHERE token_hash = ${access.hash}`;
          console.error('admin password-reset email was not sent: delivery is not configured');
        }
      } catch (error) {
        await sql`DELETE FROM admin_access_tokens WHERE token_hash = ${access.hash}`;
        console.error('admin password-reset email failed:', error.message);
      }

      return res.status(202).json(accepted);
    }

    // ── accept an invitation or reset a password ─────────────────────────
    if (action === 'claim') {
      if (await limitShared(sql, req, res, 'access-claim', 8, 15 * 60000)) return;

      const secret = clean(body.token, 180);
      const password = String(body.password || '');
      const problem = A.passwordProblem(password);
      if (!secret || problem) {
        return res.status(400).json({ error: problem || 'This link is invalid or has expired. Please request a new one.' });
      }

      // DELETE ... RETURNING makes the secret single-use even if two browser
      // requests arrive at the same moment.
      const claimed = await sql`
        DELETE FROM admin_access_tokens
        WHERE token_hash = ${A.hashAccessToken(secret)}
          AND expires_at > now()
        RETURNING user_id, purpose`;
      if (!claimed.length) {
        return res.status(400).json({ error: 'This link is invalid or has expired. Please request a new one.' });
      }

      const rows = await sql`
        UPDATE admin_users
        SET password_hash = ${await A.hashPassword(password)}
        WHERE id = ${claimed[0].user_id} AND disabled = false
        RETURNING id, email, name, role, disabled`;
      if (!rows.length) {
        return res.status(400).json({ error: 'This account is not available. Please contact an owner.' });
      }

      const user = rows[0];
      await sql`DELETE FROM admin_access_tokens WHERE user_id = ${user.id}`;
      await sql`DELETE FROM admin_sessions WHERE user_id = ${user.id}`;
      const { token, maxAge } = await A.createSession(sql, user.id, req.headers['user-agent']);
      await sql`UPDATE admin_users SET last_login_at = now() WHERE id = ${user.id}`;
      A.setSessionCookie(res, token, maxAge);
      return res.status(200).json({ ok: true, user: publicUser(user), purpose: claimed[0].purpose });
    }

    // ── claim the first account ──────────────────────────────────────────
    if (action === 'setup') {
      if (await limitShared(sql, req, res, 'setup', 6, 15 * 60000)) return;

      // Only ever available while the table is empty. Once an account exists
      // this is closed for good, and new staff are added from inside.
      const anyone = await sql`
        SELECT 1 FROM admin_users WHERE lower(email) <> ${KEY_ACCOUNT} LIMIT 1`;
      if (anyone.length) {
        return res.status(409).json({ error: 'An account already exists. Please sign in.' });
      }

      const email = clean(body.email, 160).toLowerCase();
      const name = clean(body.name, 120);
      const password = String(body.password || '');

      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return res.status(400).json({ error: 'That email address does not look right.' });
      }
      // /admin is unlisted, but it is still reachable by anyone who guesses the
      // URL. Tying the first claim to the hotel's own mail domain means a
      // stranger cannot take the account in the window before the owner does.
      if (!email.endsWith('@' + SETUP_DOMAIN)) {
        return res.status(403).json({ error: `The first account must use an @${SETUP_DOMAIN} address.` });
      }
      const problem = A.passwordProblem(password);
      if (problem) return res.status(400).json({ error: problem });

      let created;
      try {
        // The unique index settles a race between two simultaneous claims: the
        // second insert fails rather than creating a duplicate owner.
        created = await sql`
          INSERT INTO admin_users (email, password_hash, name, role)
          VALUES (${email}, ${await A.hashPassword(password)}, ${name || email}, 'owner')
          RETURNING id, email, name, role`;
      } catch (err) {
        if (err && err.code === '23505') {
          return res.status(409).json({ error: 'An account already exists. Please sign in.' });
        }
        throw err;
      }

      const { token, maxAge } = await A.createSession(sql, created[0].id, req.headers['user-agent']);
      await sql`UPDATE admin_users SET last_login_at = now() WHERE id = ${created[0].id}`;
      A.setSessionCookie(res, token, maxAge);
      console.log('admin: first account created for', email);
      return res.status(201).json({ ok: true, user: publicUser(created[0]) });
    }

    // ── sign in with the access key ──────────────────────────────────────
    // The key stays useful for getting straight in while working on the site.
    // It is exchanged for an ordinary session cookie rather than being held in
    // the page: the old scheme kept it in sessionStorage, which is exactly what
    // the stored-XSS was able to read. Used once, then never touched again.
    if (action === 'key') {
      if (await limitShared(sql, req, res, 'keylogin', 8, 15 * 60000)) return;

      const secret = process.env.ADMIN_KEY || '';
      const provided = String(body.key || '');
      if (!secret) return res.status(400).json({ error: 'No access key is configured.' });
      if (!provided) return res.status(400).json({ error: 'Enter the access key.' });

      const a = Buffer.from(provided);
      const b = Buffer.from(secret);
      if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
        return res.status(401).json({ error: 'That key was not accepted.' });
      }

      // Sessions hang off a real row, so the key gets a reserved account of its
      // own. Its password hash is deliberately unusable, so this account can
      // never be entered with a password — only with the key.
      let rows = await sql`
        SELECT id, email, name, role, disabled FROM admin_users
        WHERE lower(email) = ${KEY_ACCOUNT} LIMIT 1`;
      if (!rows.length) {
        // The unique index is on lower(email), so the conflict target has to be
        // the same expression or Postgres has nothing to match it against.
        rows = await sql`
          INSERT INTO admin_users (email, password_hash, name, role)
          VALUES (${KEY_ACCOUNT}, 'no-password-login', 'Access key', 'owner')
          ON CONFLICT (lower(email)) DO NOTHING
          RETURNING id, email, name, role, disabled`;
        if (!rows.length) {
          rows = await sql`
            SELECT id, email, name, role, disabled FROM admin_users
            WHERE lower(email) = ${KEY_ACCOUNT} LIMIT 1`;
        }
      }
      const user = rows[0];
      // Turning off the reserved account in the Team tab revokes key access,
      // which only works if we actually read the column.
      if (user.disabled) return res.status(403).json({ error: 'Key access has been disabled.' });

      const { token, maxAge } = await A.createSession(sql, user.id, req.headers['user-agent']);
      await sql`UPDATE admin_users SET last_login_at = now() WHERE id = ${user.id}`;
      A.setSessionCookie(res, token, maxAge);
      console.log('admin: signed in with the access key');
      return res.status(200).json({ ok: true, user: publicUser(user) });
    }

    // ── sign in ──────────────────────────────────────────────────────────
    if (action === 'login') {
      // Tight, because this is the one endpoint worth guessing at.
      if (await limitShared(sql, req, res, 'login', 8, 15 * 60000)) return;

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
      if (await limitShared(sql, req, res, 'pwchange', 10, 15 * 60000)) return;
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
      if (!A.canManageAdmins(me)) {
        return res.status(403).json({ error: 'Only owners can invite administrators.' });
      }
      if (await limitShared(sql, req, res, 'admin-invite', 10, 15 * 60000)) return;

      const email = clean(body.email, 160).toLowerCase();
      const name = clean(body.name, 120);
      const role = ['owner', 'manager'].includes(body.role) ? body.role : 'manager';

      if (!emailLooksValid(email)) {
        return res.status(400).json({ error: 'That email address does not look right.' });
      }

      const exists = await sql`SELECT 1 FROM admin_users WHERE lower(email) = ${email} LIMIT 1`;
      if (exists.length) return res.status(409).json({ error: 'That email already has an account.' });

      const rows = await sql`
        INSERT INTO admin_users (email, password_hash, name, role)
        VALUES (${email}, 'pending-invitation', ${name || email}, ${role})
        RETURNING id, email, name, role`;
      const user = rows[0];
      const access = A.createAccessToken();
      const expiresAt = new Date(Date.now() + ACCESS_LINK_MINUTES * 60_000).toISOString();
      await sql`
        INSERT INTO admin_access_tokens (token_hash, user_id, purpose, expires_at)
        VALUES (${access.hash}, ${user.id}, 'invite', ${expiresAt})`;

      try {
        const sent = await sendAdminAccessEmail({
          to: user.email,
          name: user.name || user.email,
          kind: 'invite',
          url: accessLink(access.token),
        });
        if (sent && sent.skipped) {
          await sql`DELETE FROM admin_users WHERE id = ${user.id}`;
          return res.status(503).json({ error: 'Email delivery is not configured. The invitation was not created.' });
        }
      } catch (error) {
        await sql`DELETE FROM admin_users WHERE id = ${user.id}`;
        console.error('admin invitation email failed:', error.message);
        return res.status(502).json({ error: 'The invitation email could not be sent. Please try again.' });
      }

      return res.status(201).json({ ok: true, user, expiresAt });
    }

    // ── disable or re-enable a staff account ─────────────────────────────
    if (action === 'disable') {
      if (!A.canManageAdmins(me)) {
        return res.status(403).json({ error: 'Only owners can change administrator access.' });
      }
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
