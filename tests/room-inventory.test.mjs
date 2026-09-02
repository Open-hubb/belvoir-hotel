import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { ROOMS, roomCapacity } = require('../api/_rooms.js');

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
  const migration = readFileSync(
    new URL('../scripts/migrate-availability.mjs', import.meta.url),
    'utf8',
  );
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
