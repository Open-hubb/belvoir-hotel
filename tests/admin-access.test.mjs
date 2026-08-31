import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const require = createRequire(import.meta.url);
const auth = require('../api/_auth.js');
const notify = require('../api/_notify.js');
const adminHtml = readFileSync(new URL('../admin.html', import.meta.url), 'utf8');

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
