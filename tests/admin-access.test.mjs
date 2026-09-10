import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const require = createRequire(import.meta.url);
const Module = require('node:module');
const auth = require('../api/_auth.js');
const notify = require('../api/_notify.js');
const adminHtml = readFileSync(new URL('../admin.html', import.meta.url), 'utf8');

function loadCommonJsWithMocks(relativePath, mocks) {
  const targetPath = require.resolve(relativePath);
  const originalLoad = Module._load;
  Module._load = function mockedLoad(request, parent, isMain) {
    if (parent && parent.filename === targetPath && Object.hasOwn(mocks, request)) {
      return mocks[request];
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  delete require.cache[targetPath];
  try {
    return require(targetPath);
  } finally {
    Module._load = originalLoad;
    delete require.cache[targetPath];
  }
}

function responseRecorder() {
  return {
    statusCode: 200,
    body: null,
    headers: {},
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    setHeader(name, value) { this.headers[String(name).toLowerCase()] = String(value); },
  };
}

test('admin-access link secrets are random and stored only as hashes', () => {
  assert.equal(typeof auth.createAccessToken, 'function');

  const { token, hash } = auth.createAccessToken();
  assert.match(token, /^[A-Za-z0-9_-]{40,}$/);
  assert.equal(auth.hashAccessToken(token), hash);
  assert.notEqual(token, hash);
  assert.notEqual(auth.hashAccessToken(token + 'changed'), hash);
});

test('only owners may manage administrator accounts', () => {
  assert.equal(typeof auth.canManageAdmins, 'function');
  assert.equal(auth.canManageAdmins({ role: 'owner' }), true);
  assert.equal(auth.canManageAdmins({ role: 'manager' }), false);
});

test('admin-access emails direct recipients to one secure action', () => {
  assert.equal(typeof notify.buildAdminAccessEmail, 'function');

  const email = notify.buildAdminAccessEmail({
    kind: 'invite',
    name: 'Aminata',
    url: 'https://www.belvoir-estates.com/admin#access=secure-token',
  });

  assert.match(email.subject, /invited/i);
  assert.match(email.html, /Set your password/);
  assert.match(email.html, /secure-token/);
  assert.match(email.html, /expires/i);
});

test('the admin login includes recovery and owner invitations need no temporary password', () => {
  assert.match(adminHtml, /id="showForgot"/);
  assert.match(adminHtml, /Send invite/);
  assert.doesNotMatch(adminHtml, /id="tuPw"/);
});

test('owners can reissue an invitation for a still-pending account', async () => {
  const queries = [];
  const mail = [];
  let savedExpiry = null;
  const pendingUser = {
    id: 10,
    email: 'reception@example.com',
    name: 'Reception',
    role: 'manager',
    disabled: false,
    password_hash: 'pending-invitation',
  };
  const sql = async (strings, ...values) => {
    const text = strings.join(' ').replace(/\s+/g, ' ').trim();
    queries.push(text);
    if (text.includes('FROM admin_users') && text.includes('lower(email)')) return [pendingUser];
    if (text.includes('INSERT INTO admin_access_tokens')) {
      savedExpiry = values.at(-1);
      return [];
    }
    return [];
  };
  const route = loadCommonJsWithMocks('../api/auth.js', {
    '@neondatabase/serverless': { neon: () => sql },
    './_ratelimit': { limitShared: async () => false },
    './_auth': {
      ...auth,
      isAdminRequest: async () => ({ id: 1, role: 'owner' }),
    },
    './_notify': {
      sendAdminAccessEmail: async (message) => {
        mail.push(message);
        return { id: 'email_1' };
      },
    },
  });
  const req = {
    method: 'POST',
    headers: { 'user-agent': 'test' },
    body: {
      action: 'invite',
      email: pendingUser.email,
      name: pendingUser.name,
      role: pendingUser.role,
    },
  };
  const res = responseRecorder();

  await route(req, res);

  assert.equal(res.statusCode, 201);
  assert.equal(res.body.resent, true);
  assert.equal(mail.length, 1);
  assert.equal(mail[0].to, pendingUser.email);
  assert.equal(mail[0].expiresIn, '24 hours');
  assert.ok(new Date(savedExpiry).getTime() - Date.now() > 23 * 60 * 60 * 1000);
  assert.ok(queries.some((query) => query.includes('ON CONFLICT (user_id, purpose) DO UPDATE')));
  assert.ok(!queries.some((query) => query.includes('DELETE FROM admin_users')));
});
