import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
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
  assert.match(bookingsSource, /claim_token\s*=\s*\$\{String\(b\.claim\)\}\s+AND stage = 'started'/);
  assert.match(bookingsSource, /claim\s*=\s*String\(b\.claim\)/);
  assert.doesNotMatch(bookingsSource, /RETURNING id, reference, claim_token/);
  assert.match(bookingsSource, /'started',\s*\$\{claim\},\s*'unreserved',\s*NULL/);
});

test('failed checkout holds remain non-consuming enquiries and return a final conflict', () => {
  const holdCall = bookingsSource.indexOf('await acquireBookingHold');
  const insertAsStarted = bookingsSource.indexOf("'started', ${claim}, 'unreserved', NULL");
  const checkoutNotification = bookingsSource.indexOf('await notifyBooking', holdCall);

  assert.ok(insertAsStarted >= 0 && insertAsStarted < holdCall);
  assert.match(bookingsSource.slice(holdCall, checkoutNotification), /if \(!hold\.acquired\)[\s\S]*status\(409\)[\s\S]*ROOM_UNAVAILABLE/);
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
