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
const migration = readFileSync(
  new URL('../scripts/migrate-availability.mjs', import.meta.url),
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
  assert.match(bookingsSource, /b\.payment_status === 'paid'[\s\S]*settleBookingInventory\(sql, id\)/);
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
