import assert from 'node:assert/strict';
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
