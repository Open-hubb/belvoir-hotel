import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { adminGroupId, buildAdminMessage, notifyAdmins } = require('../api/_whapi.js');

const booking = {
  id: 75,
  reference: 'BLV-00075',
  room_name: 'Superior Deluxe King',
  checkin: '2026-08-21',
  checkout: '2026-08-22',
  nights: 1,
  guests: 2,
  amount_due: 80,
  payment_option: 'full',
  guest_name: 'Guest Name',
  guest_email: 'guest@example.com',
  guest_phone: '+232 77 777 063',
  requests: 'Private transfer',
};

const silentLogger = { warn() {}, error() {} };

test('Whapi accepts a group chat ID and rejects individual phone numbers', () => {
  assert.equal(adminGroupId('120363012345678901@g.us'), '120363012345678901@g.us');
  assert.equal(adminGroupId('1234567890-123456789@g.us'), '1234567890-123456789@g.us');
  assert.equal(adminGroupId('23277777063'), '');
  assert.equal(adminGroupId('admin-alerts@g.us'), '');
});

test('WhatsApp payment alert includes the approved booking summary only', () => {
  const message = buildAdminMessage('payment-received', booking, {
    PUBLIC_ORIGIN: 'https://hotel.example/',
  });

  assert.match(message, /Payment received — booking confirmed/);
  assert.match(message, /BLV-00075/);
  assert.match(message, /Guest: Guest Name/);
  assert.match(message, /Superior Deluxe King/);
  assert.match(message, /2026-08-21 to 2026-08-22/);
  assert.match(message, /Payment type: Paid in full/);
  assert.match(message, /https:\/\/hotel\.example\/admin/);
  assert.doesNotMatch(message, /guest@example\.com|777 063|Private transfer/);
});

test('WhatsApp enquiry alert identifies the guest without relaying contact details', () => {
  const message = buildAdminMessage('new-enquiry', {
    id: 42,
    stay_type: 'long',
    source: 'long-stay',
    name: 'Guest Name',
    email: 'guest@example.com',
    phone: '+232 77 777 063',
    message: 'I would like to book for six months.',
  }, { PUBLIC_ORIGIN: 'https://hotel.example' });

  assert.match(message, /New enquiry/);
  assert.match(message, /Enquiry: #42/);
  assert.match(message, /Guest: Guest Name/);
  assert.match(message, /Long-term enquiry/);
  assert.match(message, /Long-stay form/);
  assert.doesNotMatch(message, /guest@example\.com|777 063|six months/);
});

test('Whapi sends one group alert with server-only bearer credentials when configured', async () => {
  const calls = [];
  const result = await notifyAdmins('payment-received', booking, {
    env: {
      WHAPI_TOKEN: 'test-token',
      WHAPI_ADMIN_GROUP_ID: '120363012345678901@g.us',
      PUBLIC_ORIGIN: 'https://hotel.example',
    },
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return { ok: true, status: 200 };
    },
    logger: silentLogger,
  });

  assert.deepEqual(result, { sent: 1, failed: 0, skipped: false });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://gate.whapi.cloud/messages/text');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer test-token');
  assert.equal(calls[0].options.headers['Content-Type'], 'application/json');
  assert.equal(JSON.parse(calls[0].options.body).to, '120363012345678901@g.us');
  assert.match(JSON.parse(calls[0].options.body).body, /Payment received/);
});

test('Whapi is a safe no-op until its token and admin group are configured', async () => {
  let fetchCalls = 0;
  const result = await notifyAdmins('new-enquiry', { id: 42 }, {
    env: {},
    fetchImpl: async () => {
      fetchCalls += 1;
      return { ok: true, status: 200 };
    },
    logger: silentLogger,
  });

  assert.deepEqual(result, { sent: 0, failed: 0, skipped: true });
  assert.equal(fetchCalls, 0);
});
