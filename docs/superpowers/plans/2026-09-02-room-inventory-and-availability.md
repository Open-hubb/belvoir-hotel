# Room Inventory and Date-Based Availability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enforce Belvoir's real multi-unit room inventory, expose date-based availability throughout the guest experience, support quantity-based maintenance blocks, and rename the Sea Coach service card to Airport Transfer.

**Architecture:** PostgreSQL is the concurrency authority. A shared SQL availability function calculates the minimum remaining inventory night-by-night, while room-key advisory locks serialize every operation that can consume the last unit. Thin Node adapters expose those functions to the existing Vercel APIs; generated room pages and the single-page booking flow consume one backward-compatible availability response.

**Tech Stack:** Static HTML/CSS/JavaScript, Node.js CommonJS Vercel functions, Neon Serverless Postgres via `@neondatabase/serverless`, Node's built-in test runner, Puppeteer, Vercel CLI.

**Spec:** `docs/superpowers/specs/2026-09-02-room-inventory-and-availability-design.md`

## Global Constraints

- Confirmed capacities are: comfort 1, standard 2, ground-floor 2, superior-deluxe 3, superior-twin 1, studio 1, one-bed 3, two-bed 2.
- Date ranges are half-open `[checkin, checkout)` and availability is the minimum remaining count across every night.
- A started enquiry never consumes inventory; a payment hold lasts exactly 15 minutes; active partial/full paid bookings consume one unit until checkout.
- Every capacity-consuming write uses the same PostgreSQL advisory lock derived from `room_key`.
- WhatsApp notifications remain limited to enquiries and partial/full payments; temporary holds do not send WhatsApp messages.
- New UI uses the existing Belvoir navy, gold, cream, Cormorant-style display type, and Josefin-style body type.
- Accessibility remains WCAG 2.2 AA with 44px touch targets, visible focus, labels, and non-colour status text.
- Do not alter or commit unrelated untracked files: `.agents/`, `.claude/`, `AGENTS.md`, `skills-lock.json`, or the WhatsApp image folder.
- Use `DATABASE_URL_UNPOOLED` for migrations and `DATABASE_URL` for runtime serverless functions.

---

### Task 1: Make the room catalogue expose confirmed capacities

**Files:**
- Modify: `api/_rooms.js:11-29`
- Modify: `scripts/check-rates.mjs`
- Create: `tests/room-inventory.test.mjs`

**Interfaces:**
- Produces: `ROOMS[key].capacity: number` for all eight room keys.
- Produces: `roomCapacity(roomKey): number`, returning zero for an unknown key.
- Removes: scalar `UNITS_PER_ROOM`; no caller may assume every room type has one unit.

- [ ] **Step 1: Write the failing catalogue test**

```js
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
```

- [ ] **Step 2: Run the new test and verify it fails**

Run: `node --test tests/room-inventory.test.mjs`

Expected: FAIL because `capacity` and `roomCapacity` do not exist.

- [ ] **Step 3: Add capacities to the server-owned catalogue**

```js
const ROOMS = {
  comfort:          { name: 'Superior Double / Comfort', rate: 60,  capacity: 1 },
  standard:         { name: 'Deluxe Standard',           rate: 70,  capacity: 2 },
  'ground-floor':   { name: 'Ground Floor One-Bedroom',  rate: 100, capacity: 2 },
  'superior-deluxe':{ name: 'Superior Deluxe King',      rate: 80,  capacity: 3 },
  'superior-twin':  { name: 'Superior Deluxe Twin',      rate: 90,  capacity: 1 },
  studio:           { name: 'Studio Penthouse',          rate: 100, capacity: 1 },
  'one-bed':        { name: 'One-Bedroom Apartment',     rate: 110, capacity: 3 },
  'two-bed':        { name: 'Two-Bedroom Apartment',     rate: 150, capacity: 2 },
};

function roomCapacity(key) {
  return Number((ROOMS[key] || {}).capacity || 0);
}

module.exports = {
  ROOMS,
  roomCapacity,
  DEPOSIT_RATE,
  MAX_NIGHTS,
  isRoom,
  parseDay,
  today,
  priceStay,
};
```

Delete `UNITS_PER_ROOM` and update the rate consistency check so every browser room key must also have a positive integer server capacity.

- [ ] **Step 4: Run the focused and rate tests**

Run: `node --test tests/room-inventory.test.mjs && node scripts/check-rates.mjs`

Expected: both commands PASS and report all eight room types.

- [ ] **Step 5: Commit the catalogue checkpoint**

```bash
git add api/_rooms.js scripts/check-rates.mjs tests/room-inventory.test.mjs
git commit -m "Add confirmed room capacities"
```

---

### Task 2: Replace one-unit constraints with transactional inventory functions

**Files:**
- Modify: `scripts/migrate-availability.mjs`
- Modify: `tests/room-inventory.test.mjs`

**Interfaces:**
- Produces table: `room_inventory(room_key text primary key, capacity integer)`.
- Produces columns: `bookings.hold_expires_at timestamptz`, `bookings.inventory_status text`; `room_blocks.units integer`.
- Produces SQL functions:
  - `belvoir_room_availability(date, date, text, bigint) -> (room_key, capacity, remaining)`
  - `belvoir_acquire_booking_hold(bigint, text, integer) -> (acquired, hold_expires_at, remaining)`
  - `belvoir_settle_booking(bigint) -> (settled, already_paid, inventory_status)`
  - `belvoir_create_room_block(text, date, date, integer, text) -> (created, block_id, remaining)`
  - `belvoir_reactivate_booking(bigint) -> (reactivated, inventory_status)`

- [ ] **Step 1: Add failing migration-contract assertions**

Append to `tests/room-inventory.test.mjs`:

```js
import { readFileSync } from 'node:fs';

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
```

- [ ] **Step 2: Run the migration-contract test and verify it fails**

Run: `node --test tests/room-inventory.test.mjs`

Expected: FAIL at the first missing multi-unit migration marker.

- [ ] **Step 3: Add the additive columns, capacity seed, and remove old constraints**

Use the direct migration URL when available:

```js
const databaseUrl = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL_UNPOOLED or DATABASE_URL is required');
const sql = neon(databaseUrl);
```

Add rerunnable steps with these exact invariants:

```sql
CREATE TABLE IF NOT EXISTS room_inventory (
  room_key text PRIMARY KEY,
  capacity integer NOT NULL CHECK (capacity > 0)
);

ALTER TABLE bookings ADD COLUMN IF NOT EXISTS hold_expires_at timestamptz;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS inventory_status text NOT NULL DEFAULT 'unreserved';
ALTER TABLE room_blocks ADD COLUMN IF NOT EXISTS units integer NOT NULL DEFAULT 1;

ALTER TABLE bookings DROP CONSTRAINT IF EXISTS bookings_inventory_status_valid;
ALTER TABLE bookings ADD CONSTRAINT bookings_inventory_status_valid
  CHECK (inventory_status IN ('unreserved', 'held', 'reserved', 'conflict'));
ALTER TABLE room_blocks DROP CONSTRAINT IF EXISTS room_blocks_units_positive;
ALTER TABLE room_blocks ADD CONSTRAINT room_blocks_units_positive CHECK (units > 0);

ALTER TABLE bookings DROP CONSTRAINT IF EXISTS bookings_no_overlap;
ALTER TABLE room_blocks DROP CONSTRAINT IF EXISTS room_blocks_no_overlap;

UPDATE bookings
SET inventory_status = 'reserved'
WHERE status = 'active'
  AND payment_status = 'paid'
  AND inventory_status = 'unreserved';
```

Seed `room_inventory` from `ROOMS` using parameterized tagged queries and `ON CONFLICT (room_key) DO UPDATE SET capacity = EXCLUDED.capacity`.

- [ ] **Step 4: Create the shared night-by-night availability function**

The function must use this query shape so every API shares one definition of occupancy:

```sql
CREATE OR REPLACE FUNCTION belvoir_room_availability(
  p_checkin date,
  p_checkout date,
  p_room_key text DEFAULT NULL,
  p_exclude_booking_id bigint DEFAULT NULL
)
RETURNS TABLE(room_key text, capacity integer, remaining integer)
LANGUAGE sql STABLE AS $$
  WITH nights AS (
    SELECT day::date AS night
    FROM generate_series(p_checkin, p_checkout - 1, interval '1 day') AS day
  ), nightly AS (
    SELECT i.room_key, i.capacity, n.night,
      (
        SELECT count(*)::integer
        FROM bookings b
        WHERE b.room_key = i.room_key
          AND b.id IS DISTINCT FROM p_exclude_booking_id
          AND b.status = 'active'
          AND b.checkin <= n.night AND b.checkout > n.night
          AND (
            b.inventory_status = 'reserved'
            OR (b.inventory_status = 'held' AND b.hold_expires_at > now())
          )
      ) + COALESCE((
        SELECT sum(rb.units)::integer
        FROM room_blocks rb
        WHERE rb.room_key = i.room_key
          AND rb.starts <= n.night AND rb.ends > n.night
      ), 0) AS used
    FROM room_inventory i CROSS JOIN nights n
    WHERE p_room_key IS NULL OR i.room_key = p_room_key
  )
  SELECT nightly.room_key, nightly.capacity,
    greatest(0, min(nightly.capacity - nightly.used))::integer AS remaining
  FROM nightly
  GROUP BY nightly.room_key, nightly.capacity
  ORDER BY nightly.room_key;
$$;
```

- [ ] **Step 5: Add the locked booking-hold and settlement functions**

`belvoir_acquire_booking_hold` must:

```sql
SELECT * INTO v_booking FROM bookings WHERE id = p_booking_id FOR UPDATE;
IF NOT FOUND OR v_booking.claim_token IS DISTINCT FROM p_claim_token
   OR v_booking.status <> 'active' THEN
  RETURN QUERY SELECT false, NULL::timestamptz, 0;
  RETURN;
END IF;
PERFORM pg_advisory_xact_lock(hashtextextended(v_booking.room_key, 0));
SELECT a.remaining INTO v_remaining
FROM belvoir_room_availability(
  v_booking.checkin, v_booking.checkout, v_booking.room_key, v_booking.id
) a;
IF COALESCE(v_remaining, 0) < 1 THEN
  RETURN QUERY SELECT false, NULL::timestamptz, 0;
  RETURN;
END IF;
v_expires := now() + make_interval(mins => greatest(1, least(p_minutes, 15)));
UPDATE bookings SET stage = 'checkout', inventory_status = 'held',
  hold_expires_at = v_expires WHERE id = p_booking_id;
RETURN QUERY SELECT true, v_expires, greatest(0, v_remaining - 1);
```

`belvoir_settle_booking` must lock the booking and room key, return `already_paid = true` without rewriting an already-paid row, and otherwise call `belvoir_room_availability(..., v_booking.id)`. It sets both `payment_status = 'paid'` and `inventory_status = 'reserved'` when an unexpired self-hold exists or remaining is at least one; otherwise it sets `payment_status = 'paid'`, `inventory_status = 'conflict'`, and clears the hold.

- [ ] **Step 6: Add locked block creation and booking reactivation functions**

`belvoir_create_room_block` validates the room, dates, and units, locks the room key, checks shared availability for every night, inserts only when `remaining >= p_units`, and returns the post-insert remaining count.

`belvoir_reactivate_booking` locks the room key. A paid booking is reactivated only when one unit remains and is restored as `reserved`; an unpaid booking is restored as `stage = 'started'`, `inventory_status = 'unreserved'`, and `hold_expires_at = NULL`.

- [ ] **Step 7: Replace indexes with inventory-aware indexes**

```sql
DROP INDEX IF EXISTS bookings_room_dates;
CREATE INDEX IF NOT EXISTS bookings_inventory_dates
  ON bookings (room_key, checkin, checkout, hold_expires_at)
  WHERE status = 'active' AND inventory_status IN ('held', 'reserved');
CREATE INDEX IF NOT EXISTS room_blocks_inventory_dates
  ON room_blocks (room_key, starts, ends);
```

- [ ] **Step 8: Run static tests without touching a database**

Run: `node --test tests/room-inventory.test.mjs`

Expected: PASS. Do not run the migration until Task 9's controlled rollout.

- [ ] **Step 9: Commit the migration code**

```bash
git add scripts/migrate-availability.mjs tests/room-inventory.test.mjs
git commit -m "Add transactional room inventory schema"
```

---

### Task 3: Add a focused inventory adapter and return counts from availability

**Files:**
- Create: `api/_inventory.js`
- Modify: `api/availability.js`
- Modify: `tests/room-inventory.test.mjs`

**Interfaces:**
- Produces: `availabilityForStay(sql, checkin, checkout, roomKey = null): Promise<Map<string, {capacity:number, remaining:number}>>`.
- Produces: `acquireBookingHold(sql, bookingId, claim): Promise<{acquired:boolean, holdExpiresAt:string|null, remaining:number}>`.
- Produces: `settleBookingInventory(sql, bookingId): Promise<{settled:boolean, alreadyPaid:boolean, inventoryStatus:'reserved'|'conflict'|null}>`.
- Produces: `createRoomBlock(sql, roomKey, starts, ends, units, reason): Promise<{created:boolean, blockId:number|null, remaining:number}>`.
- Produces: `reactivateBooking(sql, bookingId): Promise<{reactivated:boolean, inventoryStatus:'reserved'|'unreserved'|null}>`.
- Consumes: the five SQL functions created in Task 2.

- [ ] **Step 1: Write failing adapter normalization tests**

```js
const inventory = require('../api/_inventory.js');

test('inventory adapter normalizes Neon numeric and date values', async () => {
  const sql = async () => [
    { room_key: 'standard', capacity: '2', remaining: '1' },
    { room_key: 'comfort', capacity: 1, remaining: 0 },
  ];
  const result = await inventory.availabilityForStay(sql, '2026-10-10', '2026-10-12');
  assert.deepEqual(result.get('standard'), { capacity: 2, remaining: 1 });
  assert.deepEqual(result.get('comfort'), { capacity: 1, remaining: 0 });
});
```

- [ ] **Step 2: Run the adapter test and verify it fails**

Run: `node --test tests/room-inventory.test.mjs`

Expected: FAIL because `api/_inventory.js` does not exist.

- [ ] **Step 3: Implement thin, typed-by-contract wrappers**

```js
const HOLD_MINUTES = 15;

async function availabilityForStay(sql, checkin, checkout, roomKey = null) {
  const rows = await sql`
    SELECT * FROM belvoir_room_availability(
      ${checkin}::date, ${checkout}::date, ${roomKey}, ${null}::bigint
    )`;
  return new Map(rows.map((row) => [row.room_key, {
    capacity: Number(row.capacity),
    remaining: Math.max(0, Number(row.remaining)),
  }]));
}

async function acquireBookingHold(sql, bookingId, claim) {
  const rows = await sql`
    SELECT * FROM belvoir_acquire_booking_hold(
      ${bookingId}::bigint, ${claim}, ${HOLD_MINUTES}::integer
    )`;
  const row = rows[0] || {};
  return {
    acquired: row.acquired === true,
    holdExpiresAt: row.hold_expires_at || null,
    remaining: Math.max(0, Number(row.remaining || 0)),
  };
}
```

Add these wrappers with the same strict normalization:

```js
async function settleBookingInventory(sql, bookingId) {
  const rows = await sql`SELECT * FROM belvoir_settle_booking(${bookingId}::bigint)`;
  const row = rows[0] || {};
  return {
    settled: row.settled === true,
    alreadyPaid: row.already_paid === true,
    inventoryStatus: row.inventory_status || null,
  };
}

async function createRoomBlock(sql, roomKey, starts, ends, units, reason) {
  const rows = await sql`
    SELECT * FROM belvoir_create_room_block(
      ${roomKey}, ${starts}::date, ${ends}::date, ${units}::integer, ${reason}
    )`;
  const row = rows[0] || {};
  return {
    created: row.created === true,
    blockId: row.block_id == null ? null : Number(row.block_id),
    remaining: Math.max(0, Number(row.remaining || 0)),
  };
}

async function reactivateBooking(sql, bookingId) {
  const rows = await sql`SELECT * FROM belvoir_reactivate_booking(${bookingId}::bigint)`;
  const row = rows[0] || {};
  return {
    reactivated: row.reactivated === true,
    inventoryStatus: row.inventory_status || null,
  };
}

module.exports = {
  HOLD_MINUTES,
  availabilityForStay,
  acquireBookingHold,
  settleBookingInventory,
  createRoomBlock,
  reactivateBooking,
};
```

- [ ] **Step 4: Replace `takenRooms` with count-based availability**

In `api/availability.js`, call `availabilityForStay` and preserve old fields while adding counts:

```js
const inventory = await availabilityForStay(sql, check.checkin, check.checkout, q.room || null);
const rooms = Object.entries(ROOMS)
  .filter(([key]) => !q.room || key === q.room)
  .map(([key, room]) => {
    const quote = priceStay(key, check.checkin, check.checkout, 'full');
    const live = inventory.get(key) || { capacity: room.capacity, remaining: 0 };
    return {
      key,
      name: room.name,
      rate: room.rate,
      capacity: live.capacity,
      remaining: live.remaining,
      available: live.remaining > 0,
      nights: quote.nights,
      total: quote.total,
    };
  });
```

An inventory query failure remains HTTP 500 and must never default to available.

- [ ] **Step 5: Add response-shape assertions**

Assert that source and helper contracts include `capacity`, `remaining`, `available: live.remaining > 0`, `Cache-Control: no-store`, and optional room filtering. Keep the old `available`, `nights`, and `total` keys.

- [ ] **Step 6: Run the focused tests**

Run: `node --test tests/room-inventory.test.mjs`

Expected: PASS.

- [ ] **Step 7: Commit the availability checkpoint**

```bash
git add api/_inventory.js api/availability.js tests/room-inventory.test.mjs
git commit -m "Return date-based room availability counts"
```

---

### Task 4: Acquire and release 15-minute holds in the booking API

**Files:**
- Modify: `api/bookings.js`
- Modify: `tests/room-inventory.test.mjs`

**Interfaces:**
- Consumes: `acquireBookingHold`, `settleBookingInventory`, and `reactivateBooking` from `api/_inventory.js`.
- Produces checkout response: `{ok, id, reference, claim, holdExpiresAt, remaining}`.
- Produces HTTP 409 `{code:'ROOM_UNAVAILABLE', error}` when a hold cannot be acquired.

- [ ] **Step 1: Add failing booking lifecycle contract tests**

Read `api/bookings.js` in the test and assert the updated route:

```js
test('booking checkout uses a temporary database hold', () => {
  const source = readFileSync(new URL('../api/bookings.js', import.meta.url), 'utf8');
  assert.match(source, /acquireBookingHold/);
  assert.match(source, /holdExpiresAt/);
  assert.match(source, /ROOM_UNAVAILABLE/);
  assert.doesNotMatch(source, /takenRooms/);
});
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run: `node --test tests/room-inventory.test.mjs`

Expected: FAIL because `bookings.js` still calls `takenRooms`.

- [ ] **Step 3: Make every guest booking own a claim token**

Generate `crypto.randomUUID()` for new started and direct-checkout rows. Keep the existing claim on a legitimate started-row upgrade. Return the claim only to the request that created it; never expose it in admin GET results.

- [ ] **Step 4: Save checkout data before acquiring inventory**

For a claimed started booking, update room, dates, guest fields, payment option, amount due, and total while it remains non-blocking. For a direct checkout request, insert it as `stage = 'started'`, `inventory_status = 'unreserved'`, with the new claim. Then call:

```js
const hold = await acquireBookingHold(sql, bookingId, claim);
if (!hold.acquired) {
  return res.status(409).json({
    error: 'Sorry, that room has just become fully booked for those dates. Please choose another room or different dates.',
    code: 'ROOM_UNAVAILABLE',
  });
}
```

Do not queue or retry a 409 in the browser. A failed hold leaves the row as a useful `started` enquiry without consuming inventory.

- [ ] **Step 5: Route admin payment and status changes through locked functions**

- Marking paid calls `settleBookingInventory` instead of directly changing `payment_status`; Task 5 then routes the same result through the shared notification-aware settlement function.
- Marking unpaid sets `payment_status = 'unpaid'`, `inventory_status = 'unreserved'`, and `hold_expires_at = NULL`.
- Cancelling sets `status = 'cancelled'` and clears any hold.
- Restoring calls `reactivateBooking`; return 409 when capacity has filled.

- [ ] **Step 6: Return hold metadata and expose inventory state only to admins**

Checkout POST responses include `holdExpiresAt` and `remaining`. Admin GET adds `hold_expires_at` and `inventory_status` to the selected columns. Public responses never include another guest's inventory state or personal details.

- [ ] **Step 7: Run booking and full API tests**

Run: `node --test tests/room-inventory.test.mjs tests/whapi-notifications.test.mjs tests/admin-access.test.mjs`

Expected: PASS.

- [ ] **Step 8: Commit the hold lifecycle checkpoint**

```bash
git add api/bookings.js tests/room-inventory.test.mjs
git commit -m "Enforce temporary room holds at checkout"
```

---

### Task 5: Refresh holds during payment and handle late-payment conflicts

**Files:**
- Modify: `api/flot-payment-link.js`
- Modify: `api/flot-status.js`
- Modify: `api/_paid.js`
- Modify: `api/_whapi.js`
- Modify: `api/payment-webhook.js`
- Modify: `api/cron-poll-payments.js`
- Modify: `tests/whapi-notifications.test.mjs`
- Modify: `tests/room-inventory.test.mjs`

**Interfaces:**
- Consumes: `acquireBookingHold` and `settleBookingInventory`.
- `GET /api/flot-status` additionally requires the private booking claim in the `X-Booking-Claim` request header and refreshes only the matching booking.
- `settleBooking` returns `{settled, alreadyPaid, conflict, booking}`.
- Produces WhatsApp event: `payment-conflict`, reserved for money received without inventory.

- [ ] **Step 1: Write failing notification and payment-contract tests**

```js
test('payment conflict WhatsApp alert is urgent and actionable', () => {
  const body = buildAdminMessage('payment-conflict', {
    id: 42,
    reference: 'BLV-00042',
    guest_name: 'Test Guest',
    room_name: 'Studio Penthouse',
    checkin: '2026-10-10',
    checkout: '2026-10-12',
    nights: 2,
    guests: '2',
    payment_option: 'deposit',
    amount_due: 60,
  });
  assert.match(body, /URGENT/);
  assert.match(body, /payment received/i);
  assert.match(body, /room is no longer available/i);
  assert.match(body, /BLV-00042/);
});
```

Add these source-contract assertions:

```js
test('payment routes refresh and settle inventory through shared helpers', () => {
  const link = readFileSync(new URL('../api/flot-payment-link.js', import.meta.url), 'utf8');
  const status = readFileSync(new URL('../api/flot-status.js', import.meta.url), 'utf8');
  const paid = readFileSync(new URL('../api/_paid.js', import.meta.url), 'utf8');
  assert.match(link, /acquireBookingHold/);
  assert.match(link, /HOLD_EXPIRED/);
  assert.match(status, /q\.claim/);
  assert.match(status, /acquireBookingHold/);
  assert.match(paid, /settleBookingInventory/);
});
```

- [ ] **Step 2: Run the payment tests and verify they fail**

Run: `node --test tests/whapi-notifications.test.mjs tests/room-inventory.test.mjs`

Expected: FAIL on the unsupported conflict event and missing hold refresh.

- [ ] **Step 3: Refresh the hold before creating a Flot payment link**

Select the booking's claim token and status, validate the request claim, call `acquireBookingHold`, and return HTTP 409 with `code = 'HOLD_EXPIRED'` when it cannot be refreshed. Only call Flot after a valid hold exists.

- [ ] **Step 4: Authenticate payment polling and refresh active attempts**

Send the private booking claim in the `X-Booking-Claim` header from `index.html` and validate it in `api/flot-status.js` against the booking connected to `orderId`. Never serialize the claim into the URL. For provider states `created` or `pending`, call `acquireBookingHold`. Return 409 with `code = 'HOLD_EXPIRED'` if capacity has been lost. Failed attempts are not refreshed.

- [ ] **Step 5: Make settlement atomically decide reserved versus conflict**

Replace the direct UPDATE in `_paid.js` with `settleBookingInventory`. Append the provider/source note after the database function returns. When the result is `reserved`, send the existing guest confirmation, team email, and `payment-received` WhatsApp alert exactly once. When it is `conflict`, withhold normal guest confirmation, write an urgent structured server log, and send the `payment-conflict` WhatsApp alert.

- [ ] **Step 6: Propagate settlement outcomes through all three payment listeners**

Browser polling, webhook, and cron continue calling the single `_paid.js` function. Their API/log result includes `inventoryConflict: true` when applicable. Do not change provider idempotency keys or create duplicate payment rows.

In `payment-webhook.js`, treat only an existing `status = 'completed'` attempt as a completed duplicate. A `created` or `pending` row inserted by payment-link creation must be updated to completed and settled, not returned early as a duplicate.

- [ ] **Step 7: Add the conflict WhatsApp template**

```js
if (event === 'payment-conflict') {
  return [
    '*Belvoir · URGENT payment conflict*',
    `Reference: ${reference}`,
    `Guest: ${booking.guest_name || 'Name unavailable'}`,
    `Room: ${booking.room_name || 'Room unavailable'}`,
    `Stay: ${stay}`,
    'Payment received, but the room is no longer available for these dates.',
    'Action: Reassign the guest or arrange a refund immediately.',
    `Dashboard: ${dashboardUrl(env)}`,
  ].join('\n');
}
```

Do not include guest email, phone, payment token, group ID, or provider secrets.

- [ ] **Step 8: Run payment and notification tests**

Run: `node --test tests/whapi-notifications.test.mjs tests/room-inventory.test.mjs`

Expected: PASS, including existing notification privacy assertions.

- [ ] **Step 9: Commit the payment lifecycle checkpoint**

```bash
git add api/flot-payment-link.js api/flot-status.js api/_paid.js api/_whapi.js api/payment-webhook.js api/cron-poll-payments.js index.html tests/whapi-notifications.test.mjs tests/room-inventory.test.mjs
git commit -m "Keep payment attempts tied to live room inventory"
```

---

### Task 6: Support quantity-based maintenance blocks and inventory status in admin

**Files:**
- Modify: `api/blocks.js`
- Modify: `admin.html`
- Modify: `tests/room-inventory.test.mjs`
- Modify: `tests/audit-fixes.test.mjs`

**Interfaces:**
- Consumes: `createRoomBlock` wrapper and `ROOMS[key].capacity`.
- POST body becomes `{room, starts, ends, units, reason}`.
- GET block entries include `units`, `capacity`, and existing room fields.

- [ ] **Step 1: Add failing admin block UI and API contract tests**

```js
test('admin block form includes accessible quantity control', async () => {
  const response = await fetch(`${baseUrl}/admin`);
  const html = await response.text();
  assert.match(html, /id="blkUnits"/);
  assert.match(html, /for="blkUnits">Rooms out of service/);
  assert.match(html, /units:\s*Number\(/);
  assert.match(html, /of .* rooms blocked/);
});
```

Add the exact API source assertions:

```js
test('block API validates quantities and uses the locked database function', () => {
  const source = readFileSync(new URL('../api/blocks.js', import.meta.url), 'utf8');
  assert.match(source, /Number\.isInteger\(units\)/);
  assert.match(source, /roomCapacity/);
  assert.match(source, /createRoomBlock/);
  assert.match(source, /INSUFFICIENT_CAPACITY/);
  assert.doesNotMatch(source, /SELECT id, reference, guest_name FROM bookings/);
});
```

- [ ] **Step 2: Run the tests and verify they fail**

Run: `node --test tests/room-inventory.test.mjs tests/audit-fixes.test.mjs`

Expected: FAIL because the quantity field and locked block helper are missing.

- [ ] **Step 3: Replace the block API's single-room clash logic**

Validate `units` with `Number.isInteger`, require `1 <= units <= roomCapacity(room)`, and call `createRoomBlock`. When the function refuses, return HTTP 409 and:

```js
{
  code: 'INSUFFICIENT_CAPACITY',
  error: `Only ${remaining} room${remaining === 1 ? '' : 's'} can be blocked for that date range.`,
  remaining,
}
```

GET maps each row to `room_name` and `capacity`; DELETE remains unchanged.

- [ ] **Step 4: Add the quantity field and capacity-aware block list**

Change `BLOCK_ROOMS` entries to `[key, name, capacity]`. Render:

```html
<div class="blk__field">
  <label for="blkUnits">Rooms out of service</label>
  <input type="number" id="blkUnits" min="1" step="1" value="1">
</div>
```

On room change, update `blkUnits.max` to the selected capacity and keep its value within range. Submit `units: Number(...)`. Display `2 of 3 rooms blocked` on each block card.

- [ ] **Step 5: Surface holds and paid inventory conflicts on booking cards**

- `inventory_status = 'conflict'`: prominent red `Payment conflict` pill and action copy `Reassign or refund`.
- Unpaid live hold: `Held until 14:35`.
- Expired/unreserved checkout: retain `Left at payment` wording.
- A failed Restore or Mark Paid 409 displays the API message instead of changing local state.

- [ ] **Step 6: Run admin tests**

Run: `node --test tests/audit-fixes.test.mjs tests/admin-access.test.mjs tests/room-inventory.test.mjs`

Expected: PASS.

- [ ] **Step 7: Commit the admin checkpoint**

```bash
git add api/blocks.js admin.html tests/audit-fixes.test.mjs tests/room-inventory.test.mjs
git commit -m "Add quantity-based room maintenance blocks"
```

---

### Task 7: Show live availability on room cards and preserve dates through booking

**Files:**
- Modify: `index.html:4608-4827`
- Modify: `index.html:5684-5707`
- Modify: `index.html:7577-8420`
- Modify: `tests/audit-fixes.test.mjs`

**Interfaces:**
- Produces browser helper: `fetchAvailability(checkin, checkout, roomKey?)`.
- Produces browser helper: `availabilityLabel(room, checkin, checkout)` returning `3 rooms available`, `Only 1 room left`, or `Fully booked · 10–13 Sep`.
- Category room cards get `data-room-key`, `.cat-room__availability`, and an accessible disabled booking state.
- Homepage query hydration accepts `room`, `checkin`, and `checkout` from generated room-page links and opens the matching booking wizard with those dates prefilled.

- [ ] **Step 1: Add failing browser tests with an intercepted availability response**

Use Puppeteer request interception for `/api/availability` and return one available and one full room. Assert:

```js
assert.equal(await page.$eval('[data-room-key="superior-deluxe"] .cat-room__availability', n => n.textContent.trim()), 'Only 1 room left');
assert.match(await page.$eval('[data-room-key="comfort"] .cat-room__availability', n => n.textContent), /Fully booked/);
assert.equal(await page.$eval('[data-room-key="comfort"] .cat-room__book', n => n.disabled), true);
assert.equal(await page.$eval('[data-room-key="comfort"] .cat-room__book', n => n.textContent.trim()), 'Choose different dates');
```

Also test that `Full Details` carries `checkin` and `checkout` query parameters.

- [ ] **Step 2: Run the browser tests and verify they fail**

Run: `node --test tests/audit-fixes.test.mjs`

Expected: FAIL because cards have no live status elements.

- [ ] **Step 3: Add card status markup and styles**

Give each room article `data-room-key`. Add a hidden, polite status element above actions. Use text plus a small icon; gold for remaining inventory and a muted navy/cream treatment for fully booked. Add `.cat-room--full` without reducing text contrast below 4.5:1. A disabled button remains at least 44px tall and visibly disabled.

- [ ] **Step 4: Centralize frontend availability fetching and labels**

```js
async function fetchAvailability(checkin, checkout, roomKey) {
  const params = new URLSearchParams({ checkin, checkout });
  if (roomKey) params.set('room', roomKey);
  const response = await fetch('/api/availability?' + params.toString(), { cache: 'no-store' });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'Could not check availability.');
  return data;
}
```

The UI must show a retryable failure message and must not treat a failed request as proof of availability.

- [ ] **Step 5: Connect hero dates and category cards**

Store valid hero/wizard dates in one in-memory selection object. After a hero search or when opening a category with known dates, call the endpoint once and update every matching card. Before dates are known, leave availability status hidden. Append dates to detail URLs with `URLSearchParams`.

On homepage load, parse `room`, `checkin`, and `checkout`. When the room key exists and the dates are valid, open that room's booking wizard and prefill `#bwCheckin` and `#bwCheckout`. Ignore unknown keys or invalid date pairs without throwing.

- [ ] **Step 6: Update the booking wizard for counts and 15-minute hold metadata**

Replace `bwRoomIsFree` with the shared fetcher. Use `room.remaining` in messages. Immediately before payment, handle 409 by retaining guest details, returning to dates, and announcing the room became full. On successful checkout, store `saved.holdExpiresAt` and show `Your room is reserved for payment until HH:MM` in the payment modal.

Include the private booking claim in the `X-Booking-Claim` header of every `/api/flot-status` poll, and keep it out of the URL. If polling returns `HOLD_EXPIRED`, stop polling and show `Your 15-minute reservation expired. Please recheck these dates before paying.`

If `/api/flot-payment-link` itself returns `HOLD_EXPIRED`, show the same message and make the result button reopen the booking wizard at the date step with the guest's room, dates, and contact details preserved.

- [ ] **Step 7: Change the service card to Airport Transfer**

Replace only this card's text:

```html
<div class="amenity-card__title">Airport Transfer</div>
<p>Seamless arrival from Lungi Airport, with Sea Coach transfer assistance and private pickup to Belvoir.</p>
```

Keep the existing icon, layout, and spacing.

- [ ] **Step 8: Run browser and SEO tests**

Run: `node --test tests/audit-fixes.test.mjs && npm run seo:check`

Expected: PASS with no regression to room links or crawlable content.

- [ ] **Step 9: Commit the public booking checkpoint**

```bash
git add index.html tests/audit-fixes.test.mjs
git commit -m "Show live room inventory during booking"
```

---

### Task 8: Add date availability controls to every generated room page

**Files:**
- Modify: `scripts/build-rooms.mjs:225-289`
- Modify: `rooms.css:85-111,223-279`
- Modify: `rooms.js`
- Regenerate: `rooms/*.html`
- Modify: `tests/audit-fixes.test.mjs`

**Interfaces:**
- Generated `<main>` exposes `data-room-key` and `data-room-name`.
- Produces form controls: `#roomCheckin`, `#roomCheckout`, `#roomAvailabilitySubmit`.
- Produces result region: `#roomAvailabilityResult[role=status][aria-live=polite]`.
- Available booking URL: `/?room=<key>&checkin=<date>&checkout=<date>#rooms`.

- [ ] **Step 1: Add failing generated-page and browser tests**

```js
test('every room detail page has a labelled availability form', async () => {
  for (const slug of ROOM_SLUGS) {
    const html = await (await fetch(`${baseUrl}/rooms/${slug}`)).text();
    assert.match(html, /for="roomCheckin"/);
    assert.match(html, /for="roomCheckout"/);
    assert.match(html, /id="roomAvailabilityResult"[^>]*aria-live="polite"/);
    assert.match(html, /data-room-key=/);
  }
});
```

Add one intercepted browser case for available inventory and one for fully booked inventory:

```js
await page.setRequestInterception(true);
page.on('request', (request) => {
  if (request.url().includes('/api/availability')) {
    request.respond({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ rooms: [{
        key: 'comfort', name: 'Superior Double / Comfort', capacity: 1,
        remaining: 0, available: false, nights: 2, total: 120,
      }] }),
    });
  } else request.continue();
});
```

Submit valid dates, assert the result contains `Fully booked`, assert the booking link is disabled, activate `Choose different dates`, and assert `document.activeElement.id === 'roomCheckin'`. Repeat with `remaining: 1` and assert the booking URL preserves room, check-in, and check-out.

- [ ] **Step 2: Run tests and verify they fail**

Run: `node --test tests/audit-fixes.test.mjs`

Expected: FAIL because generated room pages have no date checker.

- [ ] **Step 3: Generate the compact availability form once for all rooms**

Insert the form beneath the room badges and replace static `/#rooms` booking links with a single `.rp__book` controlled by `rooms.js`. Include visible labels, valid minimum dates, a submit button, and the live result region. Keep content in the generated HTML so SEO metadata and headings are unchanged.

- [ ] **Step 4: Implement query hydration and availability states in `rooms.js`**

On load, read `checkin` and `checkout` from `URLSearchParams`, validate date order, populate the form, and check automatically when both are valid. Fetch only the current room with `room=<key>`. Render the same three labels as the home page.

For available inventory, set the booking URL with room and dates. For zero inventory, set `aria-disabled="true"`, prevent navigation, label it `Choose different dates`, and focus check-in when activated. On network failure, show `We could not check availability. Please try again.` and do not enable booking.

- [ ] **Step 5: Add responsive, accessible styles**

Use the existing variables in `rooms.css`. The form is one column at 375px, two date fields plus action at 768/1440, has 44px inputs/buttons, visible `:focus-visible`, and status borders/icons that do not depend on colour alone. Add reduced-motion rules for new transitions.

- [ ] **Step 6: Regenerate all room pages**

Run: `node scripts/build-rooms.mjs`

Expected: eight room HTML files regenerated from one source with unchanged unique metadata and structured data.

- [ ] **Step 7: Run room-page and SEO tests**

Run: `node --test tests/audit-fixes.test.mjs && npm run seo:check`

Expected: PASS for all sitemap room URLs.

- [ ] **Step 8: Commit the room-detail checkpoint**

```bash
git add scripts/build-rooms.mjs rooms.css rooms.js rooms/*.html tests/audit-fixes.test.mjs
git commit -m "Add availability checks to room detail pages"
```

---

### Task 9: Validate the migration and transactional behavior against Neon

**Files:**
- Create: `scripts/smoke-inventory.mjs`
- Create: `scripts/deploy-reviewed-vercel.mjs`
- Modify: `package.json`
- Modify: `HANDOFF.md`

**Interfaces:**
- Produces command: `npm run inventory:smoke`.
- Produces dry-by-default command: `node scripts/deploy-reviewed-vercel.mjs --repo=<root> --sha=<full-reviewed-sha>`; only explicit `--prod` may invoke Vercel.
- Consumes: `DATABASE_URL_UNPOOLED` for schema inspection and `DATABASE_URL` for runtime-like concurrency calls.
- Smoke rows use a unique `__inventory_smoke_<timestamp>` room key and are removed in `finally`.

- [ ] **Step 1: Write the database smoke script with guaranteed cleanup**

The script must:

1. Verify the five SQL functions and three new columns exist.
2. Insert a unique temporary `room_inventory` row with capacity one and two temporary started bookings for the same future dates.
3. Run two `belvoir_acquire_booking_hold` calls concurrently through separate `neon(DATABASE_URL)` clients.
4. Assert exactly one returns `acquired = true` and the other false.
5. Assert shared availability returns zero remaining while the hold is live.
6. Test a quantity-one maintenance block on a different temporary date range.
7. Delete temporary payments, bookings, blocks, and inventory rows in `finally`, even after an assertion failure.

Use generated claim tokens and references; never use a real room key, guest, payment, or WhatsApp notification path.

- [ ] **Step 2: Add the package command and rollout note**

```json
"inventory:smoke": "node --env-file=.env.local scripts/smoke-inventory.mjs"
```

Document that the schema migration runs with the direct URL, the smoke test uses temporary non-public keys, and cleanup is verified by a final count query.

- [ ] **Step 3: Deploy the guarded build with every payment listener explicitly disabled**

After the `codex/room-inventory` HEAD has completed task review, run exactly in this order. The root checkout is only the verified integration and Vercel project-link source; never deploy its directory or `.worktrees/room-inventory`, because either may contain ignored or untracked local files. The deployment helper requires a schema-valid regular root `.vercel/project.json`, creates a temporary detached worktree at the full reviewed SHA, and copies only that project-link file into it. It derives the upload manifest from the immutable Git tree, verifies every regular file's raw blob hash and Git executable mode, rejects symlinks, special files, sensitive names, path escapes, and excessive file/total size, then repeats the complete verification immediately before provider launch. SIGINT/SIGTERM prevents any later launch; if Vercel is already running, every signal is forwarded to its helper-owned process group and a still-running provider is force-stopped after a five-second grace. Only then does the helper remove the exact temporary worktree registration and owned directory.

```bash
set -euo pipefail
BELVOIR_ROOT='/Users/pabai/Documents/Model sites/Belvoir Hotel'
REVIEWED_WORKTREE="$BELVOIR_ROOT/.worktrees/room-inventory"
test "$(git -C "$REVIEWED_WORKTREE" branch --show-current)" = "codex/room-inventory"
REVIEWED_HEAD="$(git -C "$REVIEWED_WORKTREE" rev-parse HEAD)"
test -n "$REVIEWED_HEAD"
npx vercel --cwd "$BELVOIR_ROOT" env add PAYMENT_LISTENERS_ENABLED production --value "false" --force --yes
test -z "$(git -C "$BELVOIR_ROOT" status --porcelain --untracked-files=no)"
git -C "$BELVOIR_ROOT" switch main
git -C "$BELVOIR_ROOT" merge --ff-only codex/room-inventory
ROOT_MAIN="$(git -C "$BELVOIR_ROOT" rev-parse refs/heads/main)"
test "$ROOT_MAIN" = "$REVIEWED_HEAD"
test "$(git -C "$BELVOIR_ROOT" rev-parse HEAD)" = "$REVIEWED_HEAD"
git -C "$BELVOIR_ROOT" push origin refs/heads/main:refs/heads/main
REMOTE_MAIN="$(git -C "$BELVOIR_ROOT" ls-remote --exit-code origin refs/heads/main | awk '{print $1}')"
test "$REMOTE_MAIN" = "$REVIEWED_HEAD"
test -z "$(git -C "$BELVOIR_ROOT" status --porcelain --untracked-files=no)"
node "$BELVOIR_ROOT/scripts/deploy-reviewed-vercel.mjs" --repo="$BELVOIR_ROOT" --sha="$REVIEWED_HEAD" --prod
node "$BELVOIR_ROOT/scripts/verify-payment-listeners.mjs" --expect=paused --base-url=https://www.belvoir-estates.com
```

Expected: `merge --ff-only` aborts rather than rewriting history if root `main` cannot advance directly to the reviewed branch. Both local `main` and `origin/main` must equal the captured reviewed SHA, and root must have no uncommitted tracked content. The helper must report that the detached checkout SHA equals the reviewed SHA, prove its upload bytes and modes match the Git objects, invoke Vercel only from that isolated checkout, and clean it afterward; root-only ignored, untracked, `.env`, credential, key/certificate, and `node_modules` files are never deployment inputs. The verifier checks payment-link creation, payment status, webhook, and cron; every endpoint must return retryable HTTP 503 `PAYMENT_LISTENERS_PAUSED`. Stop if any SHA, metadata, blob/mode, size, cleanup, or endpoint assertion fails; do not run the migration.

- [ ] **Step 4: Run the migration and freeze the payment cutoff while listeners are paused**

Run:

```bash
PAYMENT_LISTENERS_ENABLED=false node --env-file=.env.local scripts/migrate-availability.mjs --listeners-paused-verified
```

Expected: the script accepts only the explicit disabled state plus the verification acknowledgement, every labeled step prints `ok`, all eight capacities are upserted, and no existing paid booking is converted away from `reserved`.

- [ ] **Step 5: Prove the guarded deployment remains paused, then run the concurrency smoke test**

Run:

```bash
node scripts/verify-payment-listeners.mjs --expect=paused --base-url=https://www.belvoir-estates.com
npm run inventory:smoke
```

Expected: all booking/inventory mutations and all four payment endpoints remain paused. The smoke test passes with one winning hold, one rejected hold, correct remaining counts, a valid quantity block, and `0 temporary rows remain`.

- [ ] **Step 6: Re-run the migration to prove idempotency**

Run:

```bash
PAYMENT_LISTENERS_ENABLED=false node --env-file=.env.local scripts/migrate-availability.mjs --listeners-paused-verified
```

Expected: PASS a second time with unchanged capacities and no duplicate constraints, indexes, cutover rows, or functions.

- [ ] **Step 7: Reconcile the frozen population and resolve every quarantine ID**

Run while the production deployment is still verified paused:

```bash
PAYMENT_LISTENERS_ENABLED=false node --env-file=.env.local scripts/legacy-payment-reconciliation.mjs --post-deploy-before-listeners
```

The command prints the complete `unresolvedQuarantineIds` array and exits nonzero while any ID remains. Inspect each listed payment using payment-ledger and exact settlement-note evidence, then explicitly choose one disposition in Neon SQL:

```sql
SELECT belvoir_resolve_legacy_payment(<payment_id>, 'recover');
-- or
SELECT belvoir_resolve_legacy_payment(<payment_id>, 'ignore');
```

Rerun the reconciliation command until it exits zero with `"unresolvedQuarantineIds":[]` and `"safeToEnableListeners":true`. Do not enable payment listeners before that machine-checked result.

- [ ] **Step 8: Run the full automated suite**

Run: `npm test && npm run seo:check`

Expected: all Node/Puppeteer tests and all sitemap SEO checks PASS.

- [ ] **Step 9: Commit the operational checkpoint**

```bash
git add scripts/smoke-inventory.mjs scripts/deploy-reviewed-vercel.mjs package.json
git commit -m "Add room inventory production smoke test"
```

---

### Task 10: Complete two-pass responsive, accessibility, and production verification

**Files:**
- Use without modification: `serve.mjs`, `screenshot.mjs`
- Store temporary evidence only in gitignored: `temporary screenshots/`
- Verify: all files changed in Tasks 1-9

**Interfaces:**
- Produces no new application interface.
- Produces a clean reviewed commit set and a production deployment.

- [ ] **Step 1: Start or confirm the Belvoir localhost server**

Run: `node serve.mjs`

Expected: Belvoir serves at the port printed by the process (currently `http://localhost:4567`). If already running, inspect it instead of starting a duplicate.

- [ ] **Step 2: Run screenshot pass one at all required widths**

Use Puppeteer to capture 375px, 768px, and 1440px states for:

- home room category with available inventory;
- home room category with fully booked inventory;
- booking wizard payment-hold notice;
- all eight generated room pages with the availability form;
- one fully booked room-detail state;
- admin quantity-block form and payment-conflict pill.

Intercept `/api/availability` only for deterministic UI screenshots. Save images under `temporary screenshots/` and inspect every PNG with the image viewer.

- [ ] **Step 3: Record and fix every visible pass-one mismatch**

Compare spacing, type size/line height, colours, alignment, wrapping, 44px controls, disabled-state clarity, and card/date overflow. Apply fixes only to `index.html`, `admin.html`, `rooms.css`, `rooms.js`, or the room generator. Whenever the generator changes, rerun `node scripts/build-rooms.mjs`, then rerun the focused browser and SEO tests.

- [ ] **Step 4: Run screenshot pass two at 375px, 768px, and 1440px**

Repeat every pass-one state after fixes. Inspect every PNG again and continue until there are no visible regressions.

- [ ] **Step 5: Perform functional and accessibility QA**

Verify with keyboard only:

- category dialogs and booking wizard retain focus;
- live status is announced without moving focus;
- fully booked actions cannot open checkout;
- `Choose different dates` focuses check-in;
- payment hold expiry is understandable;
- admin quantity is labelled and constrained;
- Escape and Back controls still work.

Check the browser console and network panel: zero uncaught errors and no failed requests in the tested success states.

- [ ] **Step 6: Run final automated gates and inspect the diff**

Run: `npm test && npm run seo:check && git diff --check && git status --short`

Expected: all tests pass, SEO passes for every sitemap URL, no whitespace errors, and only the known unrelated untracked files remain.

- [ ] **Step 7: Run a focused security review**

Confirm claim tokens are required for payment hold refresh, no token or guest contact detail appears in availability responses or logs, all SQL values are parameterized, advisory locks cover all capacity-consuming writes, and conflict notifications contain no payment credentials.

- [ ] **Step 8: Reconfirm reconciliation, then explicitly enable and deploy payment listeners**

First commit and complete review of every Task 10 correction intended for this deployment on `codex/room-inventory`; stop if any intended correction is still uncommitted. Publish the exact reviewed SHA while the production listener flag remains false, redeploy that SHA in its paused state, and only then reconcile and enable:

```bash
set -euo pipefail
BELVOIR_ROOT='/Users/pabai/Documents/Model sites/Belvoir Hotel'
REVIEWED_WORKTREE="$BELVOIR_ROOT/.worktrees/room-inventory"
test "$(git -C "$REVIEWED_WORKTREE" branch --show-current)" = "codex/room-inventory"
REVIEWED_HEAD="$(git -C "$REVIEWED_WORKTREE" rev-parse HEAD)"
test -n "$REVIEWED_HEAD"
test -z "$(git -C "$BELVOIR_ROOT" status --porcelain --untracked-files=no)"
git -C "$BELVOIR_ROOT" switch main
git -C "$BELVOIR_ROOT" merge --ff-only codex/room-inventory
ROOT_MAIN="$(git -C "$BELVOIR_ROOT" rev-parse refs/heads/main)"
test "$ROOT_MAIN" = "$REVIEWED_HEAD"
test "$(git -C "$BELVOIR_ROOT" rev-parse HEAD)" = "$REVIEWED_HEAD"
git -C "$BELVOIR_ROOT" push origin refs/heads/main:refs/heads/main
REMOTE_MAIN="$(git -C "$BELVOIR_ROOT" ls-remote --exit-code origin refs/heads/main | awk '{print $1}')"
test "$REMOTE_MAIN" = "$REVIEWED_HEAD"
test -z "$(git -C "$BELVOIR_ROOT" status --porcelain --untracked-files=no)"
node "$BELVOIR_ROOT/scripts/deploy-reviewed-vercel.mjs" --repo="$BELVOIR_ROOT" --sha="$REVIEWED_HEAD" --prod
node "$BELVOIR_ROOT/scripts/verify-payment-listeners.mjs" --expect=paused --base-url=https://www.belvoir-estates.com
(cd "$BELVOIR_ROOT" && PAYMENT_LISTENERS_ENABLED=false node --env-file=.env.local scripts/legacy-payment-reconciliation.mjs --post-deploy-before-listeners)
test "$(git -C "$BELVOIR_ROOT" rev-parse HEAD)" = "$REVIEWED_HEAD"
REMOTE_MAIN="$(git -C "$BELVOIR_ROOT" ls-remote --exit-code origin refs/heads/main | awk '{print $1}')"
test "$REMOTE_MAIN" = "$REVIEWED_HEAD"
test -z "$(git -C "$BELVOIR_ROOT" status --porcelain --untracked-files=no)"
npx vercel --cwd "$BELVOIR_ROOT" env add PAYMENT_LISTENERS_ENABLED production --value "true" --force --yes
node "$BELVOIR_ROOT/scripts/deploy-reviewed-vercel.mjs" --repo="$BELVOIR_ROOT" --sha="$REVIEWED_HEAD" --prod
node "$BELVOIR_ROOT/scripts/verify-payment-listeners.mjs" --expect=active --base-url=https://www.belvoir-estates.com
```

Expected: the root fast-forward, exact-SHA checks, explicit refspec push, and isolated paused redeployment all succeed before reconciliation. The paused verifier confirms all booking/inventory mutations and all four payment endpoints remain stopped, and reconciliation exits zero with no unresolved IDs. Root HEAD and `origin/main` must still equal the reviewed SHA before the flag is set to exact `true`; the helper then creates a new isolated checkout of that same SHA for the active deployment and cleans it afterward. The final verifier must observe active validation/authentication responses from all booking/inventory mutations and all four payment endpoints; any HTTP 503 `PAYMENT_LISTENERS_PAUSED` result fails the rollout.

- [ ] **Step 9: Run production read-only and temporary-row checks**

Verify:

- `/api/availability` returns capacity and remaining for known future dates;
- all eight room detail pages load and preserve date parameters;
- the Airport Transfer card contains the approved copy;
- `/admin` remains authenticated and noindexed;
- `npm run inventory:smoke` still cleans every temporary row;
- no test sends WhatsApp or starts a real Flot payment.

- [ ] **Step 10: Commit any QA-only corrections and report handoff**

If visual QA required code corrections:

```bash
set -euo pipefail
BELVOIR_ROOT='/Users/pabai/Documents/Model sites/Belvoir Hotel'
REVIEWED_WORKTREE="$BELVOIR_ROOT/.worktrees/room-inventory"
git -C "$REVIEWED_WORKTREE" add index.html admin.html rooms.css rooms.js scripts/build-rooms.mjs rooms/*.html tests/*.test.mjs
git -C "$REVIEWED_WORKTREE" commit -m "Polish room availability states"
# Stop here until this new codex/room-inventory HEAD has completed review.
test "$(git -C "$REVIEWED_WORKTREE" branch --show-current)" = "codex/room-inventory"
REVIEWED_HEAD="$(git -C "$REVIEWED_WORKTREE" rev-parse HEAD)"
test -n "$REVIEWED_HEAD"
test -z "$(git -C "$BELVOIR_ROOT" status --porcelain --untracked-files=no)"
git -C "$BELVOIR_ROOT" switch main
git -C "$BELVOIR_ROOT" merge --ff-only codex/room-inventory
ROOT_MAIN="$(git -C "$BELVOIR_ROOT" rev-parse refs/heads/main)"
test "$ROOT_MAIN" = "$REVIEWED_HEAD"
test "$(git -C "$BELVOIR_ROOT" rev-parse HEAD)" = "$REVIEWED_HEAD"
git -C "$BELVOIR_ROOT" push origin refs/heads/main:refs/heads/main
REMOTE_MAIN="$(git -C "$BELVOIR_ROOT" ls-remote --exit-code origin refs/heads/main | awk '{print $1}')"
test "$REMOTE_MAIN" = "$REVIEWED_HEAD"
test -z "$(git -C "$BELVOIR_ROOT" status --porcelain --untracked-files=no)"
node "$BELVOIR_ROOT/scripts/deploy-reviewed-vercel.mjs" --repo="$BELVOIR_ROOT" --sha="$REVIEWED_HEAD" --prod
node "$BELVOIR_ROOT/scripts/verify-payment-listeners.mjs" --expect=active --base-url=https://www.belvoir-estates.com
```

Expected: the later QA commit is review-approved before integration, root `main` can only fast-forward to it, and local and remote `main` both equal that reviewed SHA. The final deployment again comes from a temporary detached checkout whose verified blob hashes and executable modes are exactly the reviewed commit plus `.vercel/project.json`, never from either persistent checkout. Any unexpected/sensitive/special entry, oversized upload, or cleanup failure aborts the provider launch. A signal before launch prevents it; a signal during Vercel execution produces bounded non-success, stops only the owned provider process group, and completes exact worktree cleanup. Report the final commit, deployment URL, migration/smoke results, automated test counts, responsive widths, accessibility checks, and any remaining placeholders. The expected placeholder list is empty.
