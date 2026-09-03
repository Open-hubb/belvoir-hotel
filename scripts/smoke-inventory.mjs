// Production smoke test for Belvoir's transactional room inventory.
//
// This script never calls a payment provider or a notification path. It uses
// one generated, non-public room key, two generated booking claims, and future
// dates. Every temporary row is removed in dependency order in `finally`.

import { neon } from '@neondatabase/serverless';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const EXPECTED_FUNCTIONS = Object.freeze([
  'belvoir_room_availability(date,date,text,bigint)',
  'belvoir_acquire_booking_hold(bigint,text,integer)',
  'belvoir_settle_booking(bigint,text)',
  'belvoir_create_room_block(text,date,date,integer,text)',
  'belvoir_reactivate_booking(bigint)',
]);

const EXPECTED_COLUMNS = Object.freeze([
  { table: 'bookings', column: 'hold_expires_at', type: 'timestamp with time zone' },
  { table: 'bookings', column: 'inventory_status', type: 'text' },
  { table: 'room_blocks', column: 'units', type: 'integer' },
]);

const SAFE_ROOM_KEY = /^__inventory_smoke_[a-z0-9_]{8,72}$/;
const SAFE_CLAIM = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE_REFERENCE = /^BLV-SMOKE-[0-9A-F]{32}$/;
const HOLD_MINUTES = 15;

function fail(message) {
  throw new Error(message);
}

function asPositiveInteger(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) fail(`${label} was not a positive integer`);
  return number;
}

function asNonnegativeInteger(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) fail(`${label} was not a non-negative integer`);
  return number;
}

function isoDay(date) {
  return date.toISOString().slice(0, 10);
}

function addUtcDays(date, days) {
  const result = new Date(Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate() + days,
  ));
  if (Number.isNaN(result.getTime())) fail('Could not generate future smoke-test dates');
  return result;
}

function makeIdentifiers() {
  const suffix = randomUUID().replaceAll('-', '').toLowerCase();
  return {
    roomKey: `__inventory_smoke_${Date.now().toString(36)}_${suffix.slice(0, 12)}`,
    claims: [randomUUID(), randomUUID()],
    references: [
      `BLV-SMOKE-${randomUUID().replaceAll('-', '').toUpperCase()}`,
      `BLV-SMOKE-${randomUUID().replaceAll('-', '').toUpperCase()}`,
    ],
  };
}

function validateIdentifiers(identifiers) {
  if (!identifiers || typeof identifiers !== 'object' ||
      !SAFE_ROOM_KEY.test(String(identifiers.roomKey || ''))) {
    fail('Refusing unsafe temporary room key; it must use the __inventory_smoke_ namespace');
  }
  if (!Array.isArray(identifiers.claims) || identifiers.claims.length !== 2 ||
      identifiers.claims.some((claim) => !SAFE_CLAIM.test(String(claim)))) {
    fail('Refusing unsafe temporary booking claims');
  }
  if (!Array.isArray(identifiers.references) || identifiers.references.length !== 2 ||
      identifiers.references.some((reference) => !SAFE_REFERENCE.test(String(reference)))) {
    fail('Refusing unsafe temporary booking references');
  }
  if (new Set(identifiers.claims).size !== 2 || new Set(identifiers.references).size !== 2) {
    fail('Temporary booking claims and references must be unique');
  }
  return {
    roomKey: String(identifiers.roomKey),
    claims: identifiers.claims.map(String),
    references: identifiers.references.map(String),
  };
}

function validateClients({ inspectionSql, runtimeSqlA, runtimeSqlB }) {
  if (typeof inspectionSql !== 'function') fail('A direct inspection SQL client is required');
  if (typeof runtimeSqlA !== 'function' || typeof runtimeSqlB !== 'function') {
    fail('Two runtime SQL clients are required');
  }
  if (runtimeSqlA === runtimeSqlB) fail('Runtime hold calls require two separate SQL clients');
}

function safeMessage(error, sensitiveValues) {
  let message = error instanceof Error ? error.message : String(error || 'Unknown failure');
  message = message.replace(/postgres(?:ql)?:\/\/[^\s"']+/gi, '[database-url-redacted]');
  for (const value of sensitiveValues) {
    if (value) message = message.split(String(value)).join('[redacted]');
  }
  return message.replace(/\s+/g, ' ').trim().slice(0, 500) || 'Unknown failure';
}

export class InventorySmokeError extends Error {
  constructor({ primaryError, cleanupErrors, temporaryRowsRemaining, sensitiveValues }) {
    super('Inventory smoke test failed; inspect the safe report for details');
    this.name = 'InventorySmokeError';
    this.report = Object.freeze({
      ok: false,
      primaryError: primaryError ? safeMessage(primaryError, sensitiveValues) : null,
      cleanupErrors: cleanupErrors.map(({ step, error }) =>
        `${step}: ${safeMessage(error, sensitiveValues)}`),
      temporaryRowsRemaining,
    });
  }
}

async function verifySchema(sql) {
  for (const signature of EXPECTED_FUNCTIONS) {
    const rows = await sql`
      SELECT to_regprocedure(${signature})::text AS resolved_signature`;
    if (!rows[0]?.resolved_signature) fail(`Required inventory function is missing: ${signature}`);
  }

  for (const expected of EXPECTED_COLUMNS) {
    const rows = await sql`
      SELECT data_type
      FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name = ${expected.table}
        AND column_name = ${expected.column}`;
    if (rows.length !== 1 || rows[0].data_type !== expected.type) {
      fail(`Required inventory column is missing or has the wrong type: ${expected.table}.${expected.column}`);
    }
  }
}

async function insertFixtures(sql, identifiers, dates) {
  const inventoryRows = await sql`
    INSERT INTO room_inventory (room_key, capacity)
    VALUES (${identifiers.roomKey}, ${1})
    RETURNING room_key`;
  if (inventoryRows.length !== 1 || inventoryRows[0].room_key !== identifiers.roomKey) {
    fail('Could not create isolated smoke-test inventory');
  }

  const rows = await sql`
    INSERT INTO bookings (
      room_key, room_name, checkin, checkout, nights, guests,
      guest_name, guest_email, guest_phone, requests,
      payment_option, amount_due, total, stage, claim_token, reference,
      payment_status, status, inventory_status, hold_expires_at
    )
    VALUES
      (${identifiers.roomKey}, ${'Inventory Smoke Fixture'}, ${dates.holdCheckin},
       ${dates.holdCheckout}, ${2}, ${'1'}, ${'Inventory Smoke Guest A'},
       ${'inventory-smoke-a@example.invalid'}, ${'0000000000'}, ${''},
       ${'full'}, ${1}, ${1}, ${'started'}, ${identifiers.claims[0]},
       ${identifiers.references[0]}, ${'unpaid'}, ${'active'}, ${'unreserved'}, ${null}),
      (${identifiers.roomKey}, ${'Inventory Smoke Fixture'}, ${dates.holdCheckin},
       ${dates.holdCheckout}, ${2}, ${'1'}, ${'Inventory Smoke Guest B'},
       ${'inventory-smoke-b@example.invalid'}, ${'0000000000'}, ${''},
       ${'full'}, ${1}, ${1}, ${'started'}, ${identifiers.claims[1]},
       ${identifiers.references[1]}, ${'unpaid'}, ${'active'}, ${'unreserved'}, ${null})
    RETURNING id, claim_token`;

  if (rows.length !== 2) fail('Could not create both isolated smoke-test bookings');
  const idsByClaim = new Map(rows.map((row) => [String(row.claim_token),
    asPositiveInteger(row.id, 'Temporary booking id')]));
  const bookingIds = identifiers.claims.map((claim) => idsByClaim.get(claim));
  if (bookingIds.some((id) => !id)) fail('Smoke-test booking claims did not match inserted rows');
  return bookingIds;
}

async function acquireConcurrentHolds(runtimeSqlA, runtimeSqlB, bookingIds, claims) {
  const [leftRows, rightRows] = await Promise.all([
    runtimeSqlA`
      SELECT * FROM belvoir_acquire_booking_hold(
        ${bookingIds[0]}::bigint, ${claims[0]}::text, ${HOLD_MINUTES}::integer
      )`,
    runtimeSqlB`
      SELECT * FROM belvoir_acquire_booking_hold(
        ${bookingIds[1]}::bigint, ${claims[1]}::text, ${HOLD_MINUTES}::integer
      )`,
  ]);
  if (leftRows.length !== 1 || rightRows.length !== 1) {
    fail('Concurrent hold calls returned an unexpected row count');
  }
  const results = [leftRows[0], rightRows[0]];
  const winners = results.filter((row) => row.acquired === true);
  if (winners.length !== 1 || results.some((row) => typeof row.acquired !== 'boolean')) {
    fail(`Expected exactly one winning hold, received ${winners.length}`);
  }
  return winners.length;
}

async function assertAvailability(sql, checkin, checkout, roomKey, label) {
  const rows = await sql`
    SELECT * FROM belvoir_room_availability(
      ${checkin}::date, ${checkout}::date, ${roomKey}::text, ${null}::bigint
    )`;
  if (rows.length !== 1 || rows[0].room_key !== roomKey ||
      asPositiveInteger(rows[0].capacity, `${label} capacity`) !== 1 ||
      asNonnegativeInteger(rows[0].remaining, `${label} remaining`) !== 0) {
    fail(`${label} did not reduce remaining inventory to zero`);
  }
  return 0;
}

async function createQuantityBlock(sql, identifiers, dates) {
  const rows = await sql`
    SELECT * FROM belvoir_create_room_block(
      ${identifiers.roomKey}::text, ${dates.blockStarts}::date,
      ${dates.blockEnds}::date, ${1}::integer, ${'Inventory smoke maintenance block'}::text
    )`;
  if (rows.length !== 1 || rows[0].created !== true ||
      asPositiveInteger(rows[0].block_id, 'Temporary room block id') <= 0 ||
      asNonnegativeInteger(rows[0].remaining, 'Quantity block remaining') !== 0) {
    fail('Quantity-one maintenance block was not created transactionally');
  }
}

async function cleanupFixtures(sql, roomKey, bookingIds) {
  const errors = [];
  const attempt = async (step, operation) => {
    try {
      await operation();
    } catch (error) {
      errors.push({ step, error });
    }
  };

  await attempt('payments', () => bookingIds.length === 2
    ? sql`
        DELETE FROM payments
        WHERE booking_id = ${bookingIds[0]}::bigint
           OR booking_id = ${bookingIds[1]}::bigint`
    : sql`
        DELETE FROM payments
        WHERE booking_id IN (
          SELECT id FROM bookings WHERE room_key = ${roomKey}::text
        )`);
  await attempt('bookings', () => sql`
    DELETE FROM bookings WHERE room_key = ${roomKey}::text`);
  await attempt('blocks', () => sql`
    DELETE FROM room_blocks WHERE room_key = ${roomKey}::text`);
  await attempt('inventory', () => sql`
    DELETE FROM room_inventory WHERE room_key = ${roomKey}::text`);

  let temporaryRowsRemaining = null;
  try {
    const countRows = bookingIds.length === 2
      ? await sql`
          SELECT (
            (SELECT count(*) FROM payments
             WHERE booking_id = ${bookingIds[0]}::bigint
                OR booking_id = ${bookingIds[1]}::bigint) +
            (SELECT count(*) FROM bookings WHERE room_key = ${roomKey}::text) +
            (SELECT count(*) FROM room_blocks WHERE room_key = ${roomKey}::text) +
            (SELECT count(*) FROM room_inventory WHERE room_key = ${roomKey}::text)
          )::bigint AS temporary_rows_remaining`
      : await sql`
          SELECT (
            (SELECT count(*) FROM bookings WHERE room_key = ${roomKey}::text) +
            (SELECT count(*) FROM room_blocks WHERE room_key = ${roomKey}::text) +
            (SELECT count(*) FROM room_inventory WHERE room_key = ${roomKey}::text)
          )::bigint AS temporary_rows_remaining`;
    if (countRows.length !== 1) fail('Cleanup verification returned an unexpected row count');
    temporaryRowsRemaining = asNonnegativeInteger(
      countRows[0].temporary_rows_remaining,
      'Temporary cleanup count',
    );
    if (temporaryRowsRemaining !== 0) {
      errors.push({
        step: 'verification',
        error: new Error(`${temporaryRowsRemaining} temporary rows remain`),
      });
    }
  } catch (error) {
    errors.push({ step: 'verification', error });
  }

  return { errors, temporaryRowsRemaining };
}

export async function runInventorySmoke({
  inspectionSql,
  runtimeSqlA,
  runtimeSqlB,
  identifiers: suppliedIdentifiers = makeIdentifiers(),
  now = () => new Date(),
  logger = console,
} = {}) {
  validateClients({ inspectionSql, runtimeSqlA, runtimeSqlB });
  // Validate before the first SQL call so a public room key can never become a
  // cleanup or mutation target, even through programmatic use of this module.
  const identifiers = validateIdentifiers(suppliedIdentifiers);
  const current = now();
  if (!(current instanceof Date) || Number.isNaN(current.getTime())) fail('A valid clock is required');
  const dates = {
    holdCheckin: isoDay(addUtcDays(current, 60)),
    holdCheckout: isoDay(addUtcDays(current, 62)),
    blockStarts: isoDay(addUtcDays(current, 90)),
    blockEnds: isoDay(addUtcDays(current, 92)),
  };
  const sensitiveValues = [
    identifiers.roomKey,
    ...identifiers.claims,
    ...identifiers.references,
    'Inventory Smoke Guest A',
    'Inventory Smoke Guest B',
    'inventory-smoke-a@example.invalid',
    'inventory-smoke-b@example.invalid',
  ];

  let primaryError = null;
  let bookingIds = [];
  let result = null;
  let cleanup = { errors: [], temporaryRowsRemaining: null };
  try {
    await verifySchema(inspectionSql);
    logger.log('  ok   verified 5 inventory functions and 3 columns');

    bookingIds = await insertFixtures(inspectionSql, identifiers, dates);
    const winningHolds = await acquireConcurrentHolds(
      runtimeSqlA,
      runtimeSqlB,
      bookingIds,
      identifiers.claims,
    );
    logger.log('  ok   one of two concurrent holds acquired the only room');

    const liveHoldRemaining = await assertAvailability(
      inspectionSql,
      dates.holdCheckin,
      dates.holdCheckout,
      identifiers.roomKey,
      'Live hold',
    );
    logger.log('  ok   live hold leaves zero rooms available');

    await createQuantityBlock(inspectionSql, identifiers, dates);
    await assertAvailability(
      inspectionSql,
      dates.blockStarts,
      dates.blockEnds,
      identifiers.roomKey,
      'Quantity block',
    );
    logger.log('  ok   quantity-one maintenance block leaves zero rooms available');

    result = {
      ok: true,
      functionsVerified: EXPECTED_FUNCTIONS.length,
      columnsVerified: EXPECTED_COLUMNS.length,
      winningHolds,
      liveHoldRemaining,
      quantityBlockCreated: true,
      temporaryRowsRemaining: null,
    };
  } catch (error) {
    primaryError = error;
  } finally {
    cleanup = await cleanupFixtures(inspectionSql, identifiers.roomKey, bookingIds);
  }

  if (primaryError || cleanup.errors.length || cleanup.temporaryRowsRemaining !== 0) {
    throw new InventorySmokeError({
      primaryError,
      cleanupErrors: cleanup.errors,
      temporaryRowsRemaining: cleanup.temporaryRowsRemaining,
      sensitiveValues,
    });
  }

  result.temporaryRowsRemaining = 0;
  logger.log('  ok   0 temporary rows remain');
  return result;
}

function requireDatabaseEnvironment(environment) {
  const missing = [];
  if (!String(environment.DATABASE_URL_UNPOOLED || '').trim()) missing.push('DATABASE_URL_UNPOOLED');
  if (!String(environment.DATABASE_URL || '').trim()) missing.push('DATABASE_URL');
  if (missing.length) {
    fail(`${missing.join(' and ')} ${missing.length === 1 ? 'is' : 'are'} required for the inventory smoke test`);
  }
  return {
    inspectionUrl: environment.DATABASE_URL_UNPOOLED,
    runtimeUrl: environment.DATABASE_URL,
  };
}

async function main() {
  const urls = requireDatabaseEnvironment(process.env);
  const result = await runInventorySmoke({
    inspectionSql: neon(urls.inspectionUrl),
    // Two independently-created runtime clients are intentional: their hold
    // calls must overlap so PostgreSQL's shared advisory lock is exercised.
    runtimeSqlA: neon(urls.runtimeUrl),
    runtimeSqlB: neon(urls.runtimeUrl),
  });
  console.log(JSON.stringify(result));
}

const invokedUrl = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (invokedUrl === import.meta.url) {
  try {
    await main();
  } catch (error) {
    const report = error instanceof InventorySmokeError
      ? error.report
      : { ok: false, error: safeMessage(error, []) };
    console.error(JSON.stringify(report));
    process.exitCode = 1;
  }
}
