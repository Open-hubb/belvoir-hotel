import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const Module = require('node:module');
const { ROOMS, roomCapacity } = require('../api/_rooms.js');
const inventory = require('../api/_inventory.js');
const availabilitySource = readFileSync(
  new URL('../api/availability.js', import.meta.url),
  'utf8',
);
const bookingsSource = readFileSync(
  new URL('../api/bookings.js', import.meta.url),
  'utf8',
);
const paidSource = readFileSync(
  new URL('../api/_paid.js', import.meta.url),
  'utf8',
);
const indexSource = readFileSync(
  new URL('../index.html', import.meta.url),
  'utf8',
);
const migration = readFileSync(
  new URL('../scripts/migrate-availability.mjs', import.meta.url),
  'utf8',
);
const paylinkMigration = readFileSync(
  new URL('../scripts/migrate-paylink.mjs', import.meta.url),
  'utf8',
);

function migrationBlock(marker) {
  const start = migration.indexOf(marker);
  assert.notEqual(start, -1, `missing migration block: ${marker}`);
  const end = migration.indexOf('\n});', start);
  assert.notEqual(end, -1, `unterminated migration block: ${marker}`);
  return migration.slice(start, end);
}

function taggedSql(rowsByCall) {
  const calls = [];
  const sql = async (strings, ...values) => {
    calls.push({ strings: [...strings], values });
    const rows = rowsByCall[calls.length - 1];
    if (rows instanceof Error) throw rows;
    return rows || [];
  };
  sql.calls = calls;
  return sql;
}

function responseRecorder() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    setHeader() {},
  };
}

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

async function withFetch(fetchImpl, run) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  try {
    return await run();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

function paymentLinkHarness({ booking = null, holdAcquired = true } = {}) {
  const events = [];
  const attempts = [];
  const queries = [];
  const sql = async (strings, ...values) => {
    const text = strings.join(' ');
    queries.push({ text, values });
    if (/SELECT id, amount_due/.test(text) && /FROM bookings/.test(text)) {
      return booking ? [{ ...booking }] : [];
    }
    if (/INSERT INTO payments/.test(text)) {
      attempts.push(values);
      events.push('attempt-recorded');
      return [];
    }
    throw new Error(`Unexpected payment-link query: ${text}`);
  };
  const acquireBookingHold = async (_sql, bookingId, claim) => {
    events.push('hold');
    assert.equal(bookingId, booking.id);
    assert.equal(claim, booking.claim_token);
    return {
      acquired: holdAcquired,
      holdExpiresAt: holdAcquired ? '2027-10-10T12:15:00.000Z' : null,
      remaining: holdAcquired ? 1 : 0,
    };
  };
  const route = loadCommonJsWithMocks('../api/flot-payment-link.js', {
    '@neondatabase/serverless': { neon: () => sql },
    qrcode: { toDataURL: async () => 'data:image/png;base64,qr' },
    './_flot': {
      API_BASE: 'https://payments.example',
      MERCHANT_ID: 'merchant',
      TEST_MODE: false,
      TYPES: ['card', 'momo', 'in-app'],
      resolveCurrency: () => 'USD',
      amountFor: (usd) => ({ amount: Number(usd).toFixed(2), currency: 'USD' }),
      orderIdFor: (id) => `belvoir-${id}`,
      signBody: () => 'signature',
      log() {},
    },
    './_ratelimit': { limit: () => false },
    './_inventory': { acquireBookingHold },
  });
  return { route, events, attempts, queries };
}

function paymentStatusHarness({
  providerStatus = 'pending',
  holdAcquired = true,
  settlement = { settled: true, alreadyPaid: false, conflict: false, booking: { id: 91 } },
  payment = {},
  currentBooking = null,
} = {}) {
  const events = [];
  const updates = [];
  const paymentRow = {
    booking_id: 91,
    claim_token: 'status-claim',
    payment_status: 'unpaid',
    inventory_status: 'held',
    attempt_status: 'created',
    amount: '140.00',
    currency: 'USD',
    ...payment,
  };
  const sql = async (strings, ...values) => {
    const text = strings.join(' ');
    if (/JOIN bookings/.test(text)) return paymentRow ? [{ ...paymentRow }] : [];
    if (/SELECT payment_status, inventory_status/.test(text) && /FROM bookings/.test(text)) {
      return currentBooking ? [{ ...currentBooking }] : [];
    }
    if (/SELECT id FROM payments/.test(text)) return [];
    if (/UPDATE payments\s+SET status/.test(text)) {
      updates.push({ text, values });
      return [];
    }
    throw new Error(`Unexpected payment-status query: ${text}`);
  };
  const holds = [];
  const settlements = [];
  const route = loadCommonJsWithMocks('../api/flot-status.js', {
    '@neondatabase/serverless': { neon: () => sql },
    './_flot': {
      API_BASE: 'https://payments.example',
      MERCHANT_ID: 'merchant',
      TEST_MODE: false,
      signCanonical: () => 'signature',
      log() {},
    },
    './_ratelimit': { limit: () => false },
    './_inventory': {
      acquireBookingHold: async (_sql, bookingId, claim) => {
        holds.push({ bookingId, claim });
        events.push('hold');
        return { acquired: holdAcquired, holdExpiresAt: null, remaining: holdAcquired ? 1 : 0 };
      },
    },
    './_paid': {
      settleBooking: async (_sql, bookingId, providerRef, source) => {
        settlements.push({ bookingId, providerRef, source });
        return settlement;
      },
    },
  });
  const request = (claim = 'status-claim') => ({
    method: 'GET',
    query: { orderId: 'belvoir-91', attemptId: 'attempt-91', claim },
    url: '/api/flot-status',
  });
  const providerFetch = async () => {
    events.push('provider');
    return {
      ok: true,
      status: 200,
      json: async () => ({
        data: {
          status: providerStatus,
          amount: '140.00',
          currency: 'USD',
          updatedAt: '2027-10-10T12:01:00.000Z',
        },
      }),
    };
  };
  return { route, request, providerFetch, events, holds, settlements, updates };
}

function durablePaidHarness({
  outcome = 'reserved',
  failClaimOnce = false,
  failTeamOnce = false,
  failWhatsappOnce = false,
  bookingStatus = 'active',
  noteError = false,
} = {}) {
  const booking = {
    id: 91,
    reference: 'BLV-00091',
    room_key: 'standard',
    room_name: 'Deluxe Standard',
    checkin: '2027-10-10',
    checkout: '2027-10-12',
    nights: 2,
    guests: '2',
    guest_name: 'Guest Name',
    guest_email: 'guest@example.com',
    guest_phone: '+232 77 000 091',
    requests: 'Private request',
    payment_option: 'full',
    amount_due: 140,
    total: 140,
    payment_status: 'unpaid',
    inventory_status: 'held',
    status: bookingStatus,
  };
  const outbox = [];
  const calls = { guest: [], team: [], whatsapp: [], logs: [] };
  let claimFailureRemaining = failClaimOnce ? 1 : 0;
  let teamFailureRemaining = failTeamOnce ? 1 : 0;
  let whatsappFailureRemaining = failWhatsappOnce ? 1 : 0;

  function seedOutbox() {
    const channels = outcome === 'conflict'
      ? ['whatsapp-conflict']
      : ['guest-email', 'team-email', 'whatsapp-payment'];
    for (const channel of channels) {
      outbox.push({
        id: outbox.length + 1,
        booking_id: booking.id,
        outcome,
        channel,
        dedupe_key: `belvoir:booking:${booking.id}:${outcome}:${channel}`,
        delivered: false,
        leased: false,
      });
    }
  }

  const sql = async (strings, ...values) => {
    const text = strings.join(' ');
    if (/UPDATE bookings/.test(text) && /notes = CASE/.test(text)) {
      if (noteError) throw new Error('note write unavailable');
      return [{ ...booking }];
    }
    if (/SELECT \* FROM bookings/.test(text)) return [{ ...booking }];
    if (/WITH claimable/.test(text) && /payment_notification_outbox/.test(text)) {
      if (claimFailureRemaining > 0) {
        claimFailureRemaining -= 1;
        throw new Error('outbox temporarily unavailable');
      }
      const claimed = outbox.filter((row) => !row.delivered && !row.leased);
      claimed.forEach((row) => { row.leased = true; });
      return claimed.map((row) => ({ ...row }));
    }
    if (/SET delivered_at = clock_timestamp\(\)/.test(text)) {
      const id = Number(values.find((value) => Number(value) > 0 && Number(value) < 100));
      const row = outbox.find((item) => item.id === id);
      if (row) { row.delivered = true; row.leased = false; }
      return row ? [{ id: row.id }] : [];
    }
    if (/SET lease_token = NULL/.test(text)) {
      const id = Number(values.find((value) => Number(value) > 0 && Number(value) < 100));
      const row = outbox.find((item) => item.id === id);
      if (row) row.leased = false;
      return [];
    }
    throw new Error(`Unexpected durable settlement query: ${text}`);
  };

  const settleBooking = loadCommonJsWithMocks('../api/_paid.js', {
    './_inventory': {
      settleBookingInventory: async () => {
        if (booking.payment_status === 'paid') {
          return { settled: false, alreadyPaid: true, inventoryStatus: booking.inventory_status };
        }
        booking.payment_status = 'paid';
        booking.inventory_status = outcome;
        seedOutbox();
        return { settled: true, alreadyPaid: false, inventoryStatus: outcome };
      },
    },
    './_notify': {
      confirmBooking: async (_booking, options) => {
        calls.guest.push(options);
        return { id: 'guest-message' };
      },
      notifyPaid: async (_booking, options) => {
        calls.team.push(options);
        if (teamFailureRemaining > 0) {
          teamFailureRemaining -= 1;
          throw new Error('team email unavailable');
        }
        return { id: 'team-message' };
      },
    },
    './_whapi': {
      notifyAdmins: async (event) => {
        calls.whatsapp.push(event);
        if (whatsappFailureRemaining > 0) {
          whatsappFailureRemaining -= 1;
          return { sent: 0, failed: 1, skipped: false };
        }
        return { sent: 1, failed: 0, skipped: false };
      },
    },
    './_flot': {
      log: (event, data) => { calls.logs.push({ event, data }); },
    },
  }).settleBooking;

  return { booking, outbox, calls, settleBooking, sql };
}

function checkoutBody(overrides = {}) {
  return {
    stage: 'checkout',
    room: 'standard',
    checkin: '2027-10-10',
    checkout: '2027-10-12',
    guests: '2',
    name: 'First Guest',
    email: 'first@example.com',
    phone: '+232 77 000 001',
    requests: '',
    payment: 'full',
    ...overrides,
  };
}

function bookingRouteHarness(initialBookings = [], options = {}) {
  const bookings = initialBookings.map((booking) => ({
    status: 'active',
    payment_status: 'unpaid',
    inventory_status: 'unreserved',
    hold_expires_at: null,
    ...booking,
  }));
  const notifications = [];
  const queries = [];
  let nextId = Math.max(100, ...bookings.map((booking) => Number(booking.id))) + 1;
  let transactionTail = Promise.resolve();
  let updateArrivals = 0;
  let releaseConcurrentUpdates;
  const concurrentUpdates = new Promise((resolve) => { releaseConcurrentUpdates = resolve; });

  const applyGuestFields = (row, values) => Object.assign(row, {
    room_key: values[0], room_name: values[1], checkin: values[2], checkout: values[3],
    nights: values[4], guests: values[5], guest_name: values[6], guest_email: values[7],
    guest_phone: values[8], requests: values[9], payment_option: values[10],
    amount_due: values[11], total: values[12],
  });

  const hold = (bookingId, claim) => {
    const row = bookings.find((booking) => Number(booking.id) === Number(bookingId));
    if (!row || row.claim_token !== claim || row.status !== 'active' ||
        row.payment_status === 'paid' || ['reserved', 'conflict'].includes(row.inventory_status) ||
        options.holdConflict) {
      return { acquired: false, holdExpiresAt: null, remaining: 0 };
    }
    row.stage = 'checkout';
    row.inventory_status = 'held';
    row.hold_expires_at = '2027-10-10T12:15:00.000Z';
    return { acquired: true, holdExpiresAt: row.hold_expires_at, remaining: 1 };
  };

  async function execute(strings, values, inTransaction = false) {
    const text = strings.join(' ');
    queries.push({ text, values: [...values], inTransaction });

    if (/UPDATE bookings SET\s+room_key/.test(text)) {
      const id = values[13];
      const claim = values[14];
      const row = bookings.find((booking) => Number(booking.id) === Number(id));
      const eligible = Boolean(row && row.claim_token === claim && row.stage === 'started' && row.status === 'active');
      if (!eligible) return [];

      if (options.overlapStartedUpdates && !inTransaction) {
        updateArrivals += 1;
        if (updateArrivals === 2) releaseConcurrentUpdates();
        await concurrentUpdates;
      }

      applyGuestFields(row, values);
      return [{ id: row.id, reference: row.reference || null }];
    }

    if (/INSERT INTO bookings/.test(text)) {
      const row = {
        id: nextId++,
        room_key: values[0], room_name: values[1], checkin: values[2], checkout: values[3],
        nights: values[4], guests: values[5], guest_name: values[6], guest_email: values[7],
        guest_phone: values[8], requests: values[9], payment_option: values[10],
        amount_due: values[11], total: values[12], stage: 'started', claim_token: values[13],
        status: 'active', payment_status: 'unpaid', inventory_status: 'unreserved', hold_expires_at: null,
      };
      bookings.push(row);
      return [{ id: row.id }];
    }

    if (/UPDATE bookings SET reference/.test(text)) {
      const row = bookings.find((booking) => Number(booking.id) === Number(values[1]));
      if (row && !row.reference) row.reference = values[0];
      return [];
    }

    if (/belvoir_acquire_booking_hold/.test(text)) {
      const result = hold(values[0], values[1]);
      return [{
        acquired: result.acquired,
        hold_expires_at: result.holdExpiresAt,
        remaining: result.remaining,
      }];
    }

    if (/FROM bookings/.test(text) && /claim_token/.test(text)) {
      const row = bookings.find((booking) => Number(booking.id) === Number(values[0]) && booking.claim_token === values[1]);
      return row ? [{ ...row }] : [];
    }

    throw new Error(`Unexpected booking test query: ${text}`);
  }

  const sql = async (strings, ...values) => execute(strings, values, false);
  sql.transaction = async (buildQueries) => {
    let release;
    const previous = transactionTail;
    transactionTail = new Promise((resolve) => { release = resolve; });
    await previous;
    try {
      const tx = (strings, ...values) => ({ strings, values });
      const statements = buildQueries(tx);
      const results = [];
      for (const statement of statements) {
        results.push(await execute(statement.strings, statement.values, true));
      }
      return results;
    } finally {
      release();
    }
  };

  const bookingsPath = require.resolve('../api/bookings.js');
  const originalLoad = Module._load;
  Module._load = function mockedLoad(request, parent, isMain) {
    if (parent && parent.filename === bookingsPath) {
      if (request === '@neondatabase/serverless') return { neon: () => sql };
      if (request === './_auth') return { isAdminRequest: async () => true };
      if (request === './_notify') return { notifyBooking: async (booking) => notifications.push({ ...booking }) };
      if (request === './_ratelimit') return { limit: () => false };
      if (request === './_inventory') {
        return {
          HOLD_MINUTES: 15,
          acquireBookingHold: async (_sql, id, claim) => hold(id, claim),
          settleBookingInventory: async () => ({ settled: true }),
          reactivateBooking: async () => ({ reactivated: true }),
        };
      }
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  delete require.cache[bookingsPath];
  let route;
  try {
    route = require(bookingsPath);
  } finally {
    Module._load = originalLoad;
    delete require.cache[bookingsPath];
  }

  async function post(body) {
    const res = responseRecorder();
    await route({ method: 'POST', body }, res);
    return res;
  }

  return { bookings, notifications, post, queries };
}

test('payment-link claim rejection does not reveal whether a booking exists', async () => {
  const privateBooking = {
    id: 91,
    amount_due: 140,
    total: 140,
    payment_status: 'unpaid',
    claim_token: 'private-claim',
    guest_name: 'Private Guest',
    guest_email: 'private@example.com',
  };
  const existing = paymentLinkHarness({ booking: privateBooking });
  const missing = paymentLinkHarness({ booking: null });
  let providerCalls = 0;
  const fetchImpl = async () => {
    providerCalls += 1;
    return { ok: true, status: 200, json: async () => ({ data: {} }) };
  };

  const existingRes = responseRecorder();
  const missingRes = responseRecorder();
  await withFetch(fetchImpl, async () => {
    await existing.route({ method: 'POST', body: { bookingId: 91, claim: 'wrong', type: 'card' } }, existingRes);
    await missing.route({ method: 'POST', body: { bookingId: 404, claim: 'wrong', type: 'card' } }, missingRes);
  });

  assert.equal(existingRes.statusCode, 403);
  assert.equal(missingRes.statusCode, existingRes.statusCode);
  assert.deepEqual(missingRes.body, existingRes.body);
  assert.equal(providerCalls, 0);
  assert.deepEqual(existing.events, []);
  assert.deepEqual(missing.events, []);
});

test('payment-link refreshes the matching hold before calling the provider', async () => {
  const booking = {
    id: 91,
    amount_due: 140,
    total: 140,
    payment_status: 'unpaid',
    claim_token: 'private-claim',
    guest_name: 'Guest Name',
    guest_email: 'guest@example.com',
  };
  const harness = paymentLinkHarness({ booking });
  const res = responseRecorder();

  await withFetch(async () => {
    harness.events.push('provider');
    return {
      ok: true,
      status: 200,
      json: async () => ({ data: { id: 'attempt-91', code: '*123#' } }),
    };
  }, () => harness.route({
    method: 'POST',
    body: { bookingId: 91, claim: 'private-claim', type: 'momo' },
  }, res));

  assert.equal(res.statusCode, 200);
  assert.deepEqual(harness.events.slice(0, 2), ['hold', 'provider']);
  assert.equal(harness.attempts.length, 1);
});

test('payment-link returns HOLD_EXPIRED without contacting the provider when capacity is lost', async () => {
  const harness = paymentLinkHarness({
    booking: {
      id: 91,
      amount_due: 140,
      total: 140,
      payment_status: 'unpaid',
      claim_token: 'private-claim',
      guest_name: 'Guest Name',
      guest_email: 'guest@example.com',
    },
    holdAcquired: false,
  });
  const res = responseRecorder();
  let providerCalls = 0;

  await withFetch(async () => {
    providerCalls += 1;
    return { ok: true, status: 200, json: async () => ({ data: {} }) };
  }, () => harness.route({
    method: 'POST',
    body: { bookingId: 91, claim: 'private-claim', type: 'card' },
  }, res));

  assert.equal(res.statusCode, 409);
  assert.equal(res.body.code, 'HOLD_EXPIRED');
  assert.equal(providerCalls, 0);
  assert.deepEqual(harness.events, ['hold']);
  assert.equal(harness.attempts.length, 0);
});

test('payment-link rejects a non-payable stored amount before extending its hold', async () => {
  const harness = paymentLinkHarness({
    booking: {
      id: 91,
      amount_due: 0,
      total: 0,
      payment_status: 'unpaid',
      claim_token: 'private-claim',
      guest_name: 'Guest Name',
      guest_email: 'guest@example.com',
    },
  });
  const res = responseRecorder();

  await withFetch(async () => {
    throw new Error('provider must not be called');
  }, () => harness.route({
    method: 'POST',
    body: { bookingId: 91, claim: 'private-claim', type: 'card' },
  }, res));

  assert.equal(res.statusCode, 400);
  assert.deepEqual(harness.events, []);
  assert.equal(harness.attempts.length, 0);
});

test('payment-link records provider attempts with an atomic provider-pair upsert', async () => {
  const harness = paymentLinkHarness({
    booking: {
      id: 91,
      amount_due: 140,
      total: 140,
      payment_status: 'unpaid',
      claim_token: 'private-claim',
      guest_name: 'Guest Name',
      guest_email: 'guest@example.com',
    },
  });
  const res = responseRecorder();

  await withFetch(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ data: { id: 'attempt-91', code: '*123#' } }),
  }), () => harness.route({
    method: 'POST',
    body: { bookingId: 91, claim: 'private-claim', type: 'momo' },
  }, res));

  assert.equal(res.statusCode, 200);
  const write = harness.queries.find((query) => /INSERT INTO payments/.test(query.text));
  assert.ok(write);
  assert.match(write.text, /ON CONFLICT \(reference, provider_ref\)/);
  assert.match(write.text, /WHERE provider_ref IS NOT NULL/);
  assert.match(write.text, /DO UPDATE/);
});

test('payment-status rejects an invalid claim before exposing or querying provider state', async () => {
  const harness = paymentStatusHarness();
  const res = responseRecorder();

  await withFetch(harness.providerFetch, () => harness.route(harness.request('wrong-claim'), res));

  assert.equal(res.statusCode, 403);
  assert.deepEqual(res.body, { error: 'This payment cannot be checked from here.' });
  assert.deepEqual(harness.events, []);
  assert.deepEqual(harness.holds, []);
});

test('pending payment polling refreshes only the claim-bound booking hold', async () => {
  const harness = paymentStatusHarness({ providerStatus: 'pending' });
  const res = responseRecorder();

  await withFetch(harness.providerFetch, () => harness.route(harness.request(), res));

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.status, 'pending');
  assert.deepEqual(harness.holds, [{ bookingId: 91, claim: 'status-claim' }]);
  assert.deepEqual(harness.events, ['provider', 'hold']);
});

test('failed payment polling closes the attempt without refreshing a hold', async () => {
  const harness = paymentStatusHarness({ providerStatus: 'failed' });
  const res = responseRecorder();

  await withFetch(harness.providerFetch, () => harness.route(harness.request(), res));

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.status, 'failed');
  assert.deepEqual(harness.holds, []);
  assert.equal(harness.updates.length, 1);
});

test('failed attempt polling keeps its identity while reporting an already-paid booking final', async () => {
  const harness = paymentStatusHarness({
    providerStatus: 'failed',
    payment: { payment_status: 'paid', inventory_status: 'reserved', attempt_status: 'pending' },
    currentBooking: { payment_status: 'paid', inventory_status: 'reserved' },
    settlement: {
      settled: false,
      alreadyPaid: true,
      conflict: false,
      booking: { id: 91, payment_status: 'paid', inventory_status: 'reserved' },
    },
  });
  const res = responseRecorder();

  await withFetch(harness.providerFetch, () => harness.route(harness.request(), res));

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.status, 'failed');
  assert.equal(res.body.attemptStatus, 'failed');
  assert.equal(res.body.bookingFinal, true);
  assert.equal(res.body.receiptAvailable, false);
  assert.equal(res.body.attemptId, 'attempt-91');
  assert.deepEqual(harness.holds, []);
  assert.deepEqual(harness.settlements, [{
    bookingId: 91,
    providerRef: 'attempt-91',
    source: 'browser',
  }]);
  assert.equal(harness.updates.some((update) => /status = 'completed'/.test(update.text)), false);
});

test('pending payment polling returns HOLD_EXPIRED when its hold cannot be reacquired', async () => {
  const harness = paymentStatusHarness({ providerStatus: 'created', holdAcquired: false });
  const res = responseRecorder();

  await withFetch(harness.providerFetch, () => harness.route(harness.request(), res));

  assert.equal(res.statusCode, 409);
  assert.equal(res.body.code, 'HOLD_EXPIRED');
  assert.equal(harness.settlements.length, 0);
});

test('completed payment polling propagates an inventory conflict to the browser', async () => {
  const harness = paymentStatusHarness({
    providerStatus: 'completed',
    settlement: {
      settled: true,
      alreadyPaid: false,
      conflict: true,
      booking: { id: 91, inventory_status: 'conflict' },
    },
  });
  const res = responseRecorder();

  await withFetch(harness.providerFetch, () => harness.route(harness.request(), res));

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.status, 'completed');
  assert.equal(res.body.inventoryConflict, true);
  assert.deepEqual(harness.settlements, [{
    bookingId: 91,
    providerRef: 'attempt-91',
    source: 'browser',
  }]);
});

test('polling keeps attempt identity when another attempt already paid the booking', async () => {
  const harness = paymentStatusHarness({
    providerStatus: 'pending',
    payment: { payment_status: 'paid', inventory_status: 'conflict', attempt_status: 'pending' },
    holdAcquired: false,
    currentBooking: { payment_status: 'paid', inventory_status: 'conflict' },
    settlement: {
      settled: false,
      alreadyPaid: true,
      conflict: true,
      booking: { id: 91, inventory_status: 'conflict' },
    },
  });
  const res = responseRecorder();

  await withFetch(harness.providerFetch, () => harness.route(harness.request(), res));

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.status, 'pending');
  assert.equal(res.body.attemptStatus, 'pending');
  assert.equal(res.body.bookingFinal, true);
  assert.equal(res.body.receiptAvailable, false);
  assert.equal(res.body.inventoryConflict, true);
  assert.equal(res.body.attemptId, 'attempt-91');
  assert.deepEqual(harness.events, ['provider', 'hold']);
  assert.deepEqual(harness.holds, [{ bookingId: 91, claim: 'status-claim' }]);
  assert.equal(harness.updates.some((update) => /status = 'completed'/.test(update.text)), false);
});

test('polling re-reads booking state after settlement wins the hold-refresh race', async () => {
  const harness = paymentStatusHarness({
    providerStatus: 'pending',
    holdAcquired: false,
    currentBooking: { payment_status: 'paid', inventory_status: 'reserved' },
    settlement: {
      settled: false,
      alreadyPaid: true,
      conflict: false,
      booking: { id: 91, inventory_status: 'reserved' },
    },
  });
  const res = responseRecorder();

  await withFetch(harness.providerFetch, () => harness.route(harness.request(), res));

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.status, 'pending');
  assert.equal(res.body.attemptStatus, 'pending');
  assert.equal(res.body.bookingFinal, true);
  assert.equal(res.body.receiptAvailable, false);
  assert.equal(res.body.inventoryConflict, false);
  assert.equal(res.body.attemptId, 'attempt-91');
  assert.deepEqual(harness.settlements, [{
    bookingId: 91,
    providerRef: 'attempt-91',
    source: 'browser',
  }]);
  assert.equal(harness.updates.some((update) => /status = 'completed'/.test(update.text)), false);
});

test('reserved settlement sends each success notification exactly once', async () => {
  const harness = durablePaidHarness();
  const result = await harness.settleBooking(harness.sql, 91, 'attempt-91', 'browser');

  assert.equal(result.settled, true);
  assert.equal(result.alreadyPaid, false);
  assert.equal(result.conflict, false);
  assert.equal(result.booking.inventory_status, 'reserved');
  assert.equal(harness.calls.guest.length, 1);
  assert.equal(harness.calls.team.length, 1);
  assert.deepEqual(harness.calls.whatsapp, ['payment-received']);
  assert.equal(harness.outbox.every((row) => row.delivered), true);
});

test('conflict settlement withholds confirmation and sends only the urgent conflict alert', async () => {
  const harness = durablePaidHarness({ outcome: 'conflict' });
  const result = await harness.settleBooking(harness.sql, 91, 'attempt-91', 'webhook');

  assert.equal(result.settled, true);
  assert.equal(result.conflict, true);
  assert.equal(harness.calls.guest.length, 0);
  assert.equal(harness.calls.team.length, 0);
  assert.deepEqual(harness.calls.whatsapp, ['payment-conflict']);
  const urgent = harness.calls.logs.find((entry) => entry && entry.event === 'PAYMENT_INVENTORY_CONFLICT');
  assert.ok(urgent);
  assert.equal(urgent.data.bookingReference, 'BLV-00091');
  assert.equal(urgent.data.roomKey, 'standard');
  assert.equal(JSON.stringify(urgent.data).includes('guest@example.com'), false);
});

test('already-paid settlement is idempotent and sends no duplicate notifications', async () => {
  const harness = durablePaidHarness();
  await harness.settleBooking(harness.sql, 91, 'attempt-91', 'browser');
  const result = await harness.settleBooking(harness.sql, 91, 'attempt-91', 'reconciled');

  assert.equal(result.settled, false);
  assert.equal(result.alreadyPaid, true);
  assert.equal(result.conflict, false);
  assert.equal(harness.calls.guest.length, 1);
  assert.equal(harness.calls.team.length, 1);
  assert.deepEqual(harness.calls.whatsapp, ['payment-received']);
});

test('an audit-note write failure cannot suppress first-settlement notifications', async () => {
  const harness = durablePaidHarness({ noteError: true });
  const result = await harness.settleBooking(harness.sql, 91, 'attempt-91', 'browser');

  assert.equal(result.settled, true);
  assert.equal(result.conflict, false);
  assert.equal(harness.calls.guest.length, 1);
  assert.equal(harness.calls.team.length, 1);
  assert.deepEqual(harness.calls.whatsapp, ['payment-received']);
});

test('durable outbox retries a failed channel without resending delivered channels', async () => {
  const harness = durablePaidHarness({ failTeamOnce: true });

  const first = await harness.settleBooking(harness.sql, 91, 'attempt-91', 'webhook');
  assert.equal(first.settled, true);
  assert.deepEqual(
    harness.outbox.filter((row) => row.delivered).map((row) => row.channel).sort(),
    ['guest-email', 'whatsapp-payment'],
  );

  const second = await harness.settleBooking(harness.sql, 91, 'attempt-91', 'reconciled');
  assert.equal(second.alreadyPaid, true);
  assert.equal(harness.outbox.every((row) => row.delivered), true);
  assert.equal(harness.calls.guest.length, 1);
  assert.equal(harness.calls.team.length, 2);
  assert.deepEqual(harness.calls.whatsapp, ['payment-received']);
  assert.equal(harness.calls.guest[0].idempotencyKey, 'belvoir:booking:91:reserved:guest-email');
  assert.equal(harness.calls.team[1].idempotencyKey, 'belvoir:booking:91:reserved:team-email');
});

test('outbox survives failure after settlement and a later listener drains it', async () => {
  const harness = durablePaidHarness({ failClaimOnce: true });

  await assert.rejects(
    harness.settleBooking(harness.sql, 91, 'attempt-91', 'webhook'),
    /outbox temporarily unavailable/,
  );
  assert.equal(harness.booking.payment_status, 'paid');
  assert.equal(harness.outbox.filter((row) => row.delivered).length, 0);

  const retry = await harness.settleBooking(harness.sql, 91, 'attempt-91', 'reconciled');
  assert.equal(retry.alreadyPaid, true);
  assert.equal(harness.outbox.every((row) => row.delivered), true);
  assert.equal(harness.calls.guest.length, 1);
  assert.equal(harness.calls.team.length, 1);
  assert.deepEqual(harness.calls.whatsapp, ['payment-received']);
});

test('cancelled late payment queues and retries only the durable conflict alert', async () => {
  const harness = durablePaidHarness({
    outcome: 'conflict',
    bookingStatus: 'cancelled',
    failWhatsappOnce: true,
  });

  const first = await harness.settleBooking(harness.sql, 91, 'attempt-91', 'webhook');
  assert.equal(first.conflict, true);
  assert.equal(harness.outbox[0].delivered, false);
  assert.equal(harness.calls.guest.length, 0);
  assert.equal(harness.calls.team.length, 0);
  assert.deepEqual(harness.calls.whatsapp, ['payment-conflict']);

  const retry = await harness.settleBooking(harness.sql, 91, 'attempt-91', 'reconciled');
  assert.equal(retry.alreadyPaid, true);
  assert.equal(retry.conflict, true);
  assert.equal(harness.outbox[0].delivered, true);
  assert.equal(harness.calls.guest.length, 0);
  assert.equal(harness.calls.team.length, 0);
  assert.deepEqual(harness.calls.whatsapp, ['payment-conflict', 'payment-conflict']);
});

test('pending webhook attempts are atomically completed and settled instead of treated as duplicates', async () => {
  const queries = [];
  const settlements = [];
  const booking = {
    id: 91,
    guest_name: 'Guest Name',
    guest_email: 'guest@example.com',
    amount_due: 140,
  };
  const sql = async (strings, ...values) => {
    const text = strings.join(' ');
    queries.push({ text, values });
    if (/SELECT \* FROM bookings/.test(text)) return [{ ...booking }];
    if (/SELECT id, status FROM payments/.test(text)) return [{ id: 501, status: 'pending' }];
    if (/UPDATE payments\s+SET status/.test(text)) return [];
    if (/INSERT INTO payments/.test(text)) return [{ id: 501, status: 'completed' }];
    throw new Error(`Unexpected webhook query: ${text}`);
  };
  const route = loadCommonJsWithMocks('../api/payment-webhook.js', {
    '@neondatabase/serverless': { neon: () => sql },
    './_ratelimit': { limit: () => false },
    './_paid': {
      settleBooking: async (_sql, bookingId, providerRef, source) => {
        settlements.push({ bookingId, providerRef, source });
        return { settled: true, alreadyPaid: false, conflict: true, booking };
      },
    },
  });
  const oldUser = process.env.FLOT_WEBHOOK_USER;
  const oldPass = process.env.FLOT_WEBHOOK_PASS;
  process.env.FLOT_WEBHOOK_USER = 'webhook-user';
  process.env.FLOT_WEBHOOK_PASS = 'webhook-pass';
  const res = responseRecorder();
  try {
    await route({
      method: 'POST',
      headers: {
        authorization: `Basic ${Buffer.from('webhook-user:webhook-pass').toString('base64')}`,
      },
      body: { orderId: 'belvoir-91', flotRequestId: 'attempt-91', status: 'completed' },
    }, res);
  } finally {
    if (oldUser === undefined) delete process.env.FLOT_WEBHOOK_USER; else process.env.FLOT_WEBHOOK_USER = oldUser;
    if (oldPass === undefined) delete process.env.FLOT_WEBHOOK_PASS; else process.env.FLOT_WEBHOOK_PASS = oldPass;
  }

  assert.equal(res.statusCode, 200);
  assert.notEqual(res.body.duplicate, true);
  assert.equal(res.body.markedPaid, true);
  assert.equal(res.body.inventoryConflict, true);
  assert.deepEqual(settlements, [{ bookingId: 91, providerRef: 'attempt-91', source: 'webhook' }]);
  const write = queries.find((query) => /INSERT INTO payments/.test(query.text));
  assert.ok(write);
  assert.match(write.text, /ON CONFLICT \(reference, provider_ref\)/);
  assert.match(write.text, /DO UPDATE/);
  assert.equal(queries.some((query) => /SELECT id, status FROM payments/.test(query.text)), false);
});

test('concurrent same-pair webhooks leave one payment ledger row', async () => {
  const ledger = [];
  let lookupArrivals = 0;
  let releaseLookups;
  const bothLookups = new Promise((resolve) => { releaseLookups = resolve; });
  const sql = async (strings, ...values) => {
    const text = strings.join(' ');
    if (/SELECT \* FROM bookings/.test(text)) {
      return [{ id: 91, guest_name: 'Guest', guest_email: 'guest@example.com', amount_due: 140 }];
    }
    if (/SELECT id, status FROM payments/.test(text)) {
      lookupArrivals += 1;
      if (lookupArrivals === 2) releaseLookups();
      await bothLookups;
      return [];
    }
    if (/INSERT INTO payments/.test(text)) {
      const atomic = /ON CONFLICT \(reference, provider_ref\)/.test(text);
      if (atomic) {
        if (!ledger.length) ledger.push({ reference: 'belvoir-91', providerRef: 'attempt-91' });
      } else {
        ledger.push({ reference: 'belvoir-91', providerRef: 'attempt-91' });
      }
      return [{ id: 501, status: 'completed' }];
    }
    if (/UPDATE payments/.test(text)) return [];
    throw new Error(`Unexpected concurrent webhook query: ${text}`);
  };
  const route = loadCommonJsWithMocks('../api/payment-webhook.js', {
    '@neondatabase/serverless': { neon: () => sql },
    './_ratelimit': { limit: () => false },
    './_paid': {
      settleBooking: async () => ({ settled: false, alreadyPaid: true, conflict: false, booking: { id: 91 } }),
    },
  });
  const oldUser = process.env.FLOT_WEBHOOK_USER;
  const oldPass = process.env.FLOT_WEBHOOK_PASS;
  process.env.FLOT_WEBHOOK_USER = 'webhook-user';
  process.env.FLOT_WEBHOOK_PASS = 'webhook-pass';
  const request = () => ({
    method: 'POST',
    headers: {
      authorization: `Basic ${Buffer.from('webhook-user:webhook-pass').toString('base64')}`,
    },
    body: { orderId: 'belvoir-91', flotRequestId: 'attempt-91', status: 'completed' },
  });
  try {
    await Promise.all([
      route(request(), responseRecorder()),
      route(request(), responseRecorder()),
    ]);
  } finally {
    if (oldUser === undefined) delete process.env.FLOT_WEBHOOK_USER; else process.env.FLOT_WEBHOOK_USER = oldUser;
    if (oldPass === undefined) delete process.env.FLOT_WEBHOOK_PASS; else process.env.FLOT_WEBHOOK_PASS = oldPass;
  }

  assert.equal(ledger.length, 1);
});

test('webhook-before-link recording reconciles one provider attempt without downgrading completion', async () => {
  const ledger = [];
  const booking = {
    id: 91,
    amount_due: 140,
    total: 140,
    payment_status: 'unpaid',
    claim_token: 'private-claim',
    guest_name: 'Guest Name',
    guest_email: 'guest@example.com',
  };
  const sql = async (strings, ...values) => {
    const text = strings.join(' ');
    if (/SELECT id, amount_due/.test(text) && /FROM bookings/.test(text)) return [{ ...booking }];
    if (/SELECT \* FROM bookings/.test(text)) return [{ ...booking }];
    if (/SELECT id, status FROM payments/.test(text)) {
      return ledger.length ? [{ id: 501, status: ledger[0].status }] : [];
    }
    if (/INSERT INTO payments/.test(text)) {
      const atomic = /ON CONFLICT \(reference, provider_ref\)/.test(text);
      const incomingStatus = values.includes('completed') ? 'completed' : 'created';
      if (atomic && ledger.length) {
        if (ledger[0].status !== 'completed') ledger[0].status = incomingStatus;
      } else {
        ledger.push({ reference: 'belvoir-91', providerRef: 'attempt-91', status: incomingStatus });
      }
      return [{ id: 501, status: ledger[0].status }];
    }
    if (/UPDATE payments/.test(text)) {
      if (ledger.length) ledger[0].status = values.includes('completed') ? 'completed' : ledger[0].status;
      return [];
    }
    throw new Error(`Unexpected webhook-before-link query: ${text}`);
  };
  const webhookRoute = loadCommonJsWithMocks('../api/payment-webhook.js', {
    '@neondatabase/serverless': { neon: () => sql },
    './_ratelimit': { limit: () => false },
    './_paid': {
      settleBooking: async () => ({ settled: true, alreadyPaid: false, conflict: false, booking }),
    },
  });
  const paymentLinkRoute = loadCommonJsWithMocks('../api/flot-payment-link.js', {
    '@neondatabase/serverless': { neon: () => sql },
    qrcode: { toDataURL: async () => null },
    './_flot': {
      API_BASE: 'https://payments.example',
      MERCHANT_ID: 'merchant',
      TEST_MODE: false,
      TYPES: ['card', 'momo', 'in-app'],
      resolveCurrency: () => 'USD',
      amountFor: (usd) => ({ amount: Number(usd).toFixed(2), currency: 'USD' }),
      orderIdFor: (id) => `belvoir-${id}`,
      signBody: () => 'signature',
      log() {},
    },
    './_ratelimit': { limit: () => false },
    './_inventory': {
      acquireBookingHold: async () => ({ acquired: true, holdExpiresAt: null, remaining: 1 }),
    },
  });
  const oldUser = process.env.FLOT_WEBHOOK_USER;
  const oldPass = process.env.FLOT_WEBHOOK_PASS;
  process.env.FLOT_WEBHOOK_USER = 'webhook-user';
  process.env.FLOT_WEBHOOK_PASS = 'webhook-pass';
  try {
    await webhookRoute({
      method: 'POST',
      headers: {
        authorization: `Basic ${Buffer.from('webhook-user:webhook-pass').toString('base64')}`,
      },
      body: { orderId: 'belvoir-91', flotRequestId: 'attempt-91', status: 'completed' },
    }, responseRecorder());
    await withFetch(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ data: { id: 'attempt-91', code: '*123#' } }),
    }), () => paymentLinkRoute({
      method: 'POST',
      body: { bookingId: 91, claim: 'private-claim', type: 'momo' },
    }, responseRecorder()));
  } finally {
    if (oldUser === undefined) delete process.env.FLOT_WEBHOOK_USER; else process.env.FLOT_WEBHOOK_USER = oldUser;
    if (oldPass === undefined) delete process.env.FLOT_WEBHOOK_PASS; else process.env.FLOT_WEBHOOK_PASS = oldPass;
  }

  assert.equal(ledger.length, 1);
  assert.equal(ledger[0].status, 'completed');
});

test('cron reports completed payments that settled into inventory conflict', async () => {
  const sql = async (strings, ...values) => {
    const text = strings.join(' ');
    if (/SELECT p\.id/.test(text) && /FROM payments p/.test(text)) {
      return [{ id: 501, reference: 'belvoir-91', provider_ref: 'attempt-91', booking_id: 91 }];
    }
    if (/UPDATE payments SET status = 'completed'/.test(text)) return [];
    if (/UPDATE payments SET status = 'expired'/.test(text)) return [];
    throw new Error(`Unexpected cron query: ${text}`);
  };
  const route = loadCommonJsWithMocks('../api/cron-poll-payments.js', {
    '@neondatabase/serverless': { neon: () => sql },
    './_flot': {
      API_BASE: 'https://payments.example',
      MERCHANT_ID: 'merchant',
      TEST_MODE: false,
      signCanonical: () => 'signature',
      log() {},
    },
    './_paid': {
      settleBooking: async () => ({
        settled: true,
        alreadyPaid: false,
        conflict: true,
        booking: { id: 91, inventory_status: 'conflict' },
      }),
    },
    './_ratelimit': { sweepRateLimits: async () => 0 },
  });
  const oldSecret = process.env.CRON_SECRET;
  process.env.CRON_SECRET = 'cron-secret';
  const res = responseRecorder();
  try {
    await withFetch(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ data: { status: 'completed' } }),
    }), () => route({
      method: 'GET',
      headers: { authorization: 'Bearer cron-secret' },
    }, res));
  } finally {
    if (oldSecret === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = oldSecret;
  }

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.completed, 1);
  assert.equal(res.body.inventoryConflict, true);
  assert.equal(res.body.inventoryConflicts, 1);
});

test('cron settles a recorded completed attempt whose booking transition was interrupted', async () => {
  const settlements = [];
  const sql = async (strings) => {
    const text = strings.join(' ');
    if (/SELECT p\.id/.test(text) && /FROM payments p/.test(text)) {
      return [{
        id: 501,
        reference: 'belvoir-91',
        provider_ref: 'attempt-91',
        booking_id: 91,
        status: 'completed',
      }];
    }
    if (/UPDATE payments SET status = 'completed'/.test(text)) return [];
    if (/UPDATE payments SET status = 'expired'/.test(text)) return [];
    throw new Error(`Unexpected interrupted-settlement cron query: ${text}`);
  };
  const route = loadCommonJsWithMocks('../api/cron-poll-payments.js', {
    '@neondatabase/serverless': { neon: () => sql },
    './_flot': {
      TEST_MODE: false,
      log() {},
    },
    './_paid': {
      settleBooking: async (_sql, bookingId, providerRef, source) => {
        settlements.push({ bookingId, providerRef, source });
        return { settled: true, alreadyPaid: false, conflict: false, booking: { id: 91 } };
      },
      deliverPendingPaymentNotifications: async () => ({ claimed: 0, delivered: 0, pending: 0 }),
    },
    './_ratelimit': { sweepRateLimits: async () => 0 },
  });
  const oldSecret = process.env.CRON_SECRET;
  process.env.CRON_SECRET = 'cron-secret';
  const res = responseRecorder();
  try {
    await withFetch(async () => {
      throw new Error('completed ledger rows must not be queried from the provider again');
    }, () => route({ method: 'GET', headers: { authorization: 'Bearer cron-secret' } }, res));
  } finally {
    if (oldSecret === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = oldSecret;
  }

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.completed, 1);
  assert.deepEqual(settlements, [{
    bookingId: 91,
    providerRef: 'attempt-91',
    source: 'reconciled',
  }]);
});

test('cron drains pending payment notification work even with no open provider attempts', async () => {
  const sql = async (strings) => {
    const text = strings.join(' ');
    if (/SELECT p\.id/.test(text) && /FROM payments p/.test(text)) return [];
    if (/UPDATE payments SET status = 'expired'/.test(text)) return [];
    throw new Error(`Unexpected outbox-only cron query: ${text}`);
  };
  let drainCalls = 0;
  const route = loadCommonJsWithMocks('../api/cron-poll-payments.js', {
    '@neondatabase/serverless': { neon: () => sql },
    './_flot': {
      TEST_MODE: false,
      log() {},
    },
    './_paid': {
      settleBooking: async () => ({ settled: false, alreadyPaid: true, conflict: false, booking: null }),
      deliverPendingPaymentNotifications: async (_sql, bookingId) => {
        drainCalls += 1;
        assert.equal(bookingId, null);
        return { claimed: 2, delivered: 2, pending: 0 };
      },
    },
    './_ratelimit': { sweepRateLimits: async () => 0 },
  });
  const oldSecret = process.env.CRON_SECRET;
  process.env.CRON_SECRET = 'cron-secret';
  const res = responseRecorder();
  try {
    await route({ method: 'GET', headers: { authorization: 'Bearer cron-secret' } }, res);
  } finally {
    if (oldSecret === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = oldSecret;
  }

  assert.equal(res.statusCode, 200);
  assert.equal(drainCalls, 1);
  assert.deepEqual(res.body.notifications, { claimed: 2, delivered: 2, pending: 0 });
});

test('admin manual-paid uses the shared notification-aware settlement path', async () => {
  const settlements = [];
  const booking = {
    id: 91,
    payment_status: 'paid',
    notes: null,
    status: 'active',
    cancelled_at: null,
    hold_expires_at: null,
    inventory_status: 'conflict',
  };
  const sql = async (strings, ...values) => {
    const text = strings.join(' ');
    if (/SELECT id, payment_status/.test(text)) return [{ ...booking }];
    throw new Error(`Unexpected manual-paid query: ${text}`);
  };
  const route = loadCommonJsWithMocks('../api/bookings.js', {
    '@neondatabase/serverless': { neon: () => sql },
    './_auth': { isAdminRequest: async () => true },
    './_notify': { notifyBooking: async () => {} },
    './_ratelimit': { limit: () => false },
    './_inventory': {
      HOLD_MINUTES: 15,
      acquireBookingHold: async () => ({ acquired: true }),
      reactivateBooking: async () => ({ reactivated: true }),
    },
    './_paid': {
      settleBooking: async (_sql, bookingId, providerRef, source) => {
        settlements.push({ bookingId, providerRef, source });
        return { settled: true, alreadyPaid: false, conflict: true, booking };
      },
    },
  });
  const res = responseRecorder();
  await route({ method: 'PATCH', body: { id: 91, payment_status: 'paid' } }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.inventoryConflict, true);
  assert.deepEqual(settlements, [{ bookingId: 91, providerRef: 'manual', source: 'admin' }]);
});

test('admin cannot mark a booking paid and cancelled in one ambiguous mutation', async () => {
  let settlementCalls = 0;
  const route = loadCommonJsWithMocks('../api/bookings.js', {
    '@neondatabase/serverless': { neon: () => async () => [] },
    './_auth': { isAdminRequest: async () => true },
    './_notify': { notifyBooking: async () => {} },
    './_ratelimit': { limit: () => false },
    './_inventory': {
      HOLD_MINUTES: 15,
      acquireBookingHold: async () => ({ acquired: true }),
      reactivateBooking: async () => ({ reactivated: true }),
    },
    './_paid': {
      settleBooking: async () => {
        settlementCalls += 1;
        return { settled: true, alreadyPaid: false, conflict: false, booking: { id: 91 } };
      },
    },
  });
  const res = responseRecorder();

  await route({
    method: 'PATCH',
    body: { id: 91, payment_status: 'paid', status: 'cancelled' },
  }, res);

  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /separate actions/i);
  assert.equal(settlementCalls, 0);
});

test('checkout status polling includes the private booking claim and handles hold expiry', () => {
  const polling = indexSource.slice(indexSource.indexOf('function fcBeginPolling'), indexSource.indexOf('function fcResult'));
  assert.match(polling, /[&?]claim=['"]?\s*\+\s*encodeURIComponent\(fcState\.claim\)/);
  assert.match(polling, /HOLD_EXPIRED/);
  assert.match(polling, /inventoryConflict/);
});

test('inventory adapter normalizes Neon numeric and date values', async () => {
  const sql = taggedSql([[
    { room_key: 'standard', capacity: '2', remaining: '1' },
    { room_key: 'comfort', capacity: 1, remaining: 0 },
  ]]);
  const result = await inventory.availabilityForStay(sql, '2026-10-10', '2026-10-12');
  assert.deepEqual(result.get('standard'), { capacity: 2, remaining: 1 });
  assert.deepEqual(result.get('comfort'), { capacity: 1, remaining: 0 });
  assert.match(sql.calls[0].strings.join(' '), /belvoir_room_availability/);
  assert.deepEqual(sql.calls[0].values, ['2026-10-10', '2026-10-12', null, null]);
});

test('inventory adapter normalizes hold, settlement, block, and reactivation contracts', async () => {
  const sql = taggedSql([
    [{ acquired: true, hold_expires_at: '2026-10-10T12:15:00.000Z', remaining: '-2' }],
    [{ settled: true, already_paid: false, inventory_status: 'reserved' }],
    [{ created: true, block_id: '42', remaining: '0' }],
    [{ reactivated: true, inventory_status: 'unreserved' }],
  ]);

  assert.deepEqual(
    await inventory.acquireBookingHold(sql, '7', 'claim-token'),
    { acquired: true, holdExpiresAt: '2026-10-10T12:15:00.000Z', remaining: 0 },
  );
  assert.deepEqual(await inventory.settleBookingInventory(sql, '7'), {
    settled: true, alreadyPaid: false, inventoryStatus: 'reserved',
  });
  assert.deepEqual(await inventory.createRoomBlock(sql, 'standard', '2026-10-10', '2026-10-12', '1', 'repair'), {
    created: true, blockId: 42, remaining: 0,
  });
  assert.deepEqual(await inventory.reactivateBooking(sql, '7'), {
    reactivated: true, inventoryStatus: 'unreserved',
  });
  assert.match(sql.calls[0].strings.join(' '), /belvoir_acquire_booking_hold/);
  assert.deepEqual(sql.calls[0].values, ['7', 'claim-token', 15]);
});

test('inventory adapter uses strict safe defaults for missing SQL rows', async () => {
  const sql = taggedSql([[], [], [], []]);
  assert.deepEqual(await inventory.acquireBookingHold(sql, 1, 'x'), {
    acquired: false, holdExpiresAt: null, remaining: 0,
  });
  assert.deepEqual(await inventory.settleBookingInventory(sql, 1), {
    settled: false, alreadyPaid: false, inventoryStatus: null,
  });
  assert.deepEqual(await inventory.createRoomBlock(sql, 'standard', '2026-10-10', '2026-10-12', 1, 'x'), {
    created: false, blockId: null, remaining: 0,
  });
  assert.deepEqual(await inventory.reactivateBooking(sql, 1), {
    reactivated: false, inventoryStatus: null,
  });
});

test('availability response source exposes count fields, filtering, and no-store caching', () => {
  assert.match(availabilitySource, /availabilityForStay/);
  assert.match(availabilitySource, /capacity/);
  assert.match(availabilitySource, /remaining/);
  assert.match(availabilitySource, /available:\s*live\.remaining\s*>\s*0/);
  assert.match(availabilitySource, /!q\.room\s*\|\|\s*key\s*===\s*q\.room/);
  assert.match(availabilitySource, /Cache-Control['"],\s*['"]no-store/);
  for (const legacy of ['available', 'nights', 'total']) assert.match(availabilitySource, new RegExp(`\\b${legacy}\\b`));
});

test('booking checkout uses a temporary database hold', () => {
  assert.match(bookingsSource, /acquireBookingHold/);
  assert.match(bookingsSource, /holdExpiresAt/);
  assert.match(bookingsSource, /ROOM_UNAVAILABLE/);
  assert.doesNotMatch(bookingsSource, /takenRooms/);
});

test('booking claims are created server-side and started upgrades preserve ownership', () => {
  assert.match(bookingsSource, /claim\s*=\s*crypto\.randomUUID\(\)/);
  assert.match(bookingsSource, /claim_token\s*=\s*\$\{suppliedClaim\}[\s\S]*AND stage = 'started'/);
  assert.match(bookingsSource, /claim\s*=\s*suppliedClaim/);
  assert.doesNotMatch(bookingsSource, /RETURNING id, reference, claim_token/);
  assert.match(bookingsSource, /'started',\s*\$\{claim\},\s*'unreserved',\s*NULL/);
});

test('failed checkout holds remain non-consuming enquiries and return a final conflict', () => {
  const holdCall = bookingsSource.indexOf('await acquireBookingHold');
  const insertAsStarted = bookingsSource.indexOf("'started', ${claim}, 'unreserved', NULL");
  const checkoutNotification = bookingsSource.indexOf('await notifyBooking', holdCall);

  assert.ok(insertAsStarted >= 0 && insertAsStarted < holdCall);
  assert.match(bookingsSource.slice(holdCall, checkoutNotification), /if \(!hold\.acquired\) return unavailable\(res\)/);
  assert.match(bookingsSource, /function unavailable\(res\)[\s\S]*status\(409\)[\s\S]*ROOM_UNAVAILABLE/);
  assert.match(bookingsSource, /claim,\s*holdExpiresAt:\s*hold\.holdExpiresAt,\s*remaining:\s*hold\.remaining/);
});

test('admin booking mutations use capacity-safe inventory transitions', () => {
  assert.match(bookingsSource, /b\.payment_status === 'paid'[\s\S]*settleBooking\(sql, id, 'manual', 'admin'\)/);
  assert.match(bookingsSource, /payment_status = 'unpaid'[\s\S]*inventory_status = 'unreserved', hold_expires_at = NULL/);
  assert.match(bookingsSource, /status = 'cancelled', cancelled_at = now\(\)[\s\S]*inventory_status = 'unreserved', hold_expires_at = NULL/);
  assert.match(bookingsSource, /b\.status === 'active'[\s\S]*reactivateBooking\(sql, id\)[\s\S]*status\(409\)/);
});

test('inventory state is exposed to admins without exposing claim tokens', () => {
  const adminGet = bookingsSource.slice(
    bookingsSource.indexOf("if (req.method === 'GET')"),
    bookingsSource.indexOf("if (req.method === 'PATCH')"),
  );
  assert.match(adminGet, /hold_expires_at/);
  assert.match(adminGet, /inventory_status/);
  assert.doesNotMatch(adminGet, /claim_token/);
});

test('an already-held checkout retry refreshes the same booking without duplicate insert or notification', async () => {
  const harness = bookingRouteHarness([{
    id: 55,
    reference: 'BLV-00055',
    claim_token: 'held-claim',
    stage: 'checkout',
    inventory_status: 'held',
    room_key: 'standard',
    room_name: ROOMS.standard.name,
    checkin: '2027-10-10',
    checkout: '2027-10-12',
    nights: 2,
    guests: '2',
    guest_name: 'Original Guest',
    guest_email: 'original@example.com',
    guest_phone: '+232 77 000 009',
    requests: 'Original request',
    payment_option: 'full',
    amount_due: 140,
    total: 140,
  }]);

  const res = await harness.post(checkoutBody({
    id: 55,
    claim: 'held-claim',
    room: 'comfort',
    checkin: '2027-11-01',
    checkout: '2027-11-04',
    name: 'Tampered Retry',
  }));

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.id, 55);
  assert.equal(res.body.claim, 'held-claim');
  assert.equal(res.body.holdExpiresAt, '2027-10-10T12:15:00.000Z');
  assert.equal(harness.bookings.length, 1);
  assert.equal(harness.notifications.length, 0);
  assert.equal(harness.bookings[0].room_key, 'standard');
  assert.equal(harness.bookings[0].checkin, '2027-10-10');
  assert.equal(harness.bookings[0].checkout, '2027-10-12');
  assert.equal(harness.bookings[0].guest_name, 'Original Guest');
  const refresh = harness.queries.find((query) => /belvoir_acquire_booking_hold/.test(query.text));
  assert.deepEqual(refresh.values, [55, 'held-claim', 15]);
});

test('concurrent same-claim upgrades serialize checkout ownership and notify from the held row once', async () => {
  const harness = bookingRouteHarness([{
    id: 61,
    reference: 'BLV-00061',
    claim_token: 'shared-claim',
    stage: 'started',
    room_key: 'standard',
    room_name: ROOMS.standard.name,
    checkin: '2027-10-10',
    checkout: '2027-10-12',
    nights: 2,
    guests: '2',
    guest_name: 'Captured Guest',
    guest_email: 'captured@example.com',
    guest_phone: '+232 77 000 010',
    requests: '',
  }], { overlapStartedUpdates: true });

  const first = checkoutBody({ id: 61, claim: 'shared-claim', name: 'First Winner' });
  const second = checkoutBody({
    id: 61,
    claim: 'shared-claim',
    room: 'comfort',
    checkin: '2027-11-01',
    checkout: '2027-11-04',
    name: 'Second Loser',
    email: 'second@example.com',
  });
  const [firstRes, secondRes] = await Promise.all([harness.post(first), harness.post(second)]);

  assert.equal(firstRes.statusCode, 200);
  assert.equal(secondRes.statusCode, 200);
  assert.equal(firstRes.body.id, 61);
  assert.equal(secondRes.body.id, 61);
  assert.equal(harness.bookings.length, 1);
  assert.equal(harness.notifications.length, 1);
  assert.equal(harness.notifications[0].room_key, harness.bookings[0].room_key);
  assert.equal(harness.notifications[0].checkin, harness.bookings[0].checkin);
  assert.equal(harness.notifications[0].guest_name, harness.bookings[0].guest_name);
});

test('checkout hold conflict leaves a started enquiry and sends no notification', async () => {
  const harness = bookingRouteHarness([], { holdConflict: true });
  const res = await harness.post(checkoutBody());

  assert.equal(res.statusCode, 409);
  assert.equal(res.body.code, 'ROOM_UNAVAILABLE');
  assert.equal(harness.bookings.length, 1);
  assert.equal(harness.bookings[0].stage, 'started');
  assert.equal(harness.bookings[0].inventory_status, 'unreserved');
  assert.equal(harness.notifications.length, 0);
});

test('an invalid existing claim cannot mutate or expose that booking', async () => {
  const harness = bookingRouteHarness([{
    id: 72,
    reference: 'BLV-00072',
    claim_token: 'private-claim',
    stage: 'checkout',
    inventory_status: 'held',
    room_key: 'standard',
    guest_name: 'Private Guest',
  }]);
  const res = await harness.post(checkoutBody({ id: 72, claim: 'wrong-claim' }));

  assert.equal(res.statusCode, 201);
  assert.notEqual(res.body.id, 72);
  assert.notEqual(res.body.claim, 'private-claim');
  assert.equal(harness.bookings[0].guest_name, 'Private Guest');
  assert.equal(harness.bookings[0].claim_token, 'private-claim');
  assert.equal(harness.bookings.length, 2);
});

test('room catalogue exposes Belvoir confirmed capacities', () => {
  assert.deepEqual(
    Object.fromEntries(Object.entries(ROOMS).map(([key, room]) => [key, room.capacity])),
    {
      comfort: 1,
      standard: 2,
      'ground-floor': 2,
      'superior-deluxe': 3,
      'superior-twin': 1,
      studio: 1,
      'one-bed': 3,
      'two-bed': 2,
    },
  );
  assert.equal(roomCapacity('superior-deluxe'), 3);
  assert.equal(roomCapacity('unknown'), 0);
});

test('availability migration defines multi-unit inventory and locked writes', () => {
  for (const required of [
    'CREATE TABLE IF NOT EXISTS room_inventory',
    'hold_expires_at',
    'inventory_status',
    'room_blocks ADD COLUMN IF NOT EXISTS units',
    'DROP CONSTRAINT IF EXISTS bookings_no_overlap',
    'DROP CONSTRAINT IF EXISTS room_blocks_no_overlap',
    'belvoir_room_availability',
    'belvoir_acquire_booking_hold',
    'belvoir_settle_booking',
    'belvoir_create_room_block',
    'belvoir_reactivate_booking',
    'pg_advisory_xact_lock',
    'generate_series',
  ]) assert.match(migration, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('settlement atomically conflicts cancelled payments and seeds the matching outbox work', () => {
  const settlement = migrationBlock('CREATE OR REPLACE FUNCTION belvoir_settle_booking');
  const cancelledGuard = settlement.indexOf("v_booking.status IS DISTINCT FROM 'active'");
  const availabilityRead = settlement.indexOf('belvoir_room_availability');

  assert.ok(cancelledGuard >= 0 && cancelledGuard < availabilityRead);
  assert.match(
    settlement.slice(cancelledGuard, availabilityRead),
    /payment_status = 'paid'[\s\S]*inventory_status = 'conflict'[\s\S]*hold_expires_at = NULL/,
  );
  assert.match(settlement, /INSERT INTO payment_notification_outbox/);
  assert.match(settlement, /'guest-email'/);
  assert.match(settlement, /'team-email'/);
  assert.match(settlement, /'whatsapp-payment'/);
  assert.match(settlement, /'whatsapp-conflict'/);
  assert.match(settlement, /ON CONFLICT \(booking_id, outcome, channel\) DO NOTHING/);
});

test('notification outbox has deterministic uniqueness and concurrency-safe leases', () => {
  assert.match(migration, /CREATE TABLE IF NOT EXISTS payment_notification_outbox/);
  assert.match(migration, /UNIQUE \(booking_id, outcome, channel\)/);
  assert.match(migration, /dedupe_key text NOT NULL UNIQUE/);
  assert.match(paidSource, /WITH claimable AS/);
  assert.match(paidSource, /FOR UPDATE SKIP LOCKED/);
  assert.match(paidSource, /lease_expires_at/);
  assert.match(paidSource, /SET delivered_at = clock_timestamp\(\)/);
  assert.match(paidSource, /SET lease_token = NULL/);
});

test('payment migrations safely deduplicate and uniquely constrain provider attempts', () => {
  for (const source of [migration, paylinkMigration]) {
    assert.match(source, /row_number\(\) OVER[\s\S]*PARTITION BY reference, provider_ref/);
    assert.match(source, /DELETE FROM payments/);
    assert.match(source, /CREATE UNIQUE INDEX IF NOT EXISTS payments_provider_attempt_unique/);
    assert.match(source, /ON payments \(reference, provider_ref\)/);
    assert.match(source, /WHERE provider_ref IS NOT NULL/);
  }
});

test('hold acquisition cannot demote paid or consuming booking states', () => {
  const hold = migrationBlock('CREATE OR REPLACE FUNCTION belvoir_acquire_booking_hold');
  const guard = hold.slice(0, hold.indexOf('END IF;'));

  assert.match(guard, /v_booking\.payment_status = 'paid'/);
  assert.match(guard, /v_booking\.inventory_status IN \('reserved', 'conflict'\)/);
  assert.match(guard, /p_minutes IS DISTINCT FROM 15/);
  assert.ok(hold.indexOf("v_booking.payment_status = 'paid'") < hold.indexOf('UPDATE bookings'));
});

test('locked inventory decisions use wall-clock time and an exact 15-minute hold', () => {
  const availability = migrationBlock('CREATE OR REPLACE FUNCTION belvoir_room_availability');
  const hold = migrationBlock('CREATE OR REPLACE FUNCTION belvoir_acquire_booking_hold');
  const settlement = migrationBlock('CREATE OR REPLACE FUNCTION belvoir_settle_booking');

  assert.match(availability, /LANGUAGE sql VOLATILE/);
  assert.match(availability, /SELECT clock_timestamp\(\) AS instant/);
  assert.match(availability, /b\.hold_expires_at > wall_clock\.instant/);
  assert.match(hold, /v_expires := clock_timestamp\(\) \+ interval '15 minutes'/);
  assert.match(settlement, /v_booking\.hold_expires_at > clock_timestamp\(\)/);
  assert.doesNotMatch(availability + hold + settlement, /\bnow\(\)|make_interval/);
});

test('legacy paid backfill serializes capacity checks and excludes started rows', () => {
  const backfill = migrationBlock("await step('backfill paid booking inventory'");
  const bookingLock = backfill.indexOf('FOR UPDATE');
  const roomLock = backfill.indexOf('pg_advisory_xact_lock');
  const capacityCheck = backfill.indexOf('belvoir_room_availability');

  assert.match(backfill, /b\.stage = 'checkout'/);
  assert.match(backfill, /ORDER BY b\.room_key, b\.id/);
  assert.match(backfill, /v_booking\.payment_status IS DISTINCT FROM 'paid'/);
  assert.match(backfill, /v_booking\.stage IS DISTINCT FROM 'checkout'/);
  assert.match(backfill, /for \(const candidate of candidates\)/);
  assert.match(backfill, /SELECT belvoir_backfill_paid_booking\(/);
  assert.doesNotMatch(backfill, /\bDO \$\$/);
  assert.ok(bookingLock >= 0 && bookingLock < roomLock);
  assert.ok(roomLock < capacityCheck);
  assert.match(backfill, /SET inventory_status = 'reserved'/);
  assert.match(backfill, /SET inventory_status = 'conflict'/);
});
