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
  Object.freeze({
    name: 'belvoir_room_availability',
    identityTypes: 'date,date,text,bigint',
    outputContract: 'room_key:text:t,capacity:integer:t,remaining:integer:t',
  }),
  Object.freeze({
    name: 'belvoir_acquire_booking_hold',
    identityTypes: 'bigint,text,integer',
    outputContract: 'acquired:boolean:t,hold_expires_at:timestamp with time zone:t,remaining:integer:t',
  }),
  Object.freeze({
    name: 'belvoir_settle_booking',
    identityTypes: 'bigint,text',
    outputContract: 'settled:boolean:t,already_paid:boolean:t,already_processed:boolean:t,resolution_required:boolean:t,legacy_resolution:text:t,inventory_status:text:t,payment_generation:integer:t',
  }),
  Object.freeze({
    name: 'belvoir_create_room_block',
    identityTypes: 'text,date,date,integer,text',
    outputContract: 'created:boolean:t,block_id:bigint:t,remaining:integer:t',
  }),
  Object.freeze({
    name: 'belvoir_reactivate_booking',
    identityTypes: 'bigint',
    outputContract: 'reactivated:boolean:t,inventory_status:text:t',
  }),
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
const HOLD_WINDOW_TOLERANCE_MS = 60_000;
const DATABASE_OPERATION_TIMEOUT_MS = 20_000;

const SIGNAL_EXIT_CODES = Object.freeze({ SIGINT: 130, SIGTERM: 143 });

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
    const safePrimary = primaryError ? safeMessage(primaryError, sensitiveValues) : null;
    super(`Inventory smoke test failed${safePrimary ? `: ${safePrimary}` : ''}`);
    this.name = 'InventorySmokeError';
    this.report = Object.freeze({
      ok: false,
      primaryError: safePrimary,
      cleanupErrors: cleanupErrors.map(({ step, error }) =>
        `${step}: ${safeMessage(error, sensitiveValues)}`),
      temporaryRowsRemaining,
    });
  }
}

export class InventorySmokeInterruptedError extends Error {
  constructor(signal) {
    super(`Inventory smoke test interrupted by ${signal}`);
    this.name = 'InventorySmokeInterruptedError';
    this.signal = signal;
    this.exitCode = SIGNAL_EXIT_CODES[signal] || 1;
  }
}

export function installInventorySmokeSignalHandlers({
  processTarget = process,
  logger = console,
} = {}) {
  let requestedSignal = null;
  let signalCount = 0;
  let cleanupStarted = false;
  let emergencyCleanup = null;
  let emergencyCleanupPromise = null;
  let emergencyCleanupError = null;

  const request = (signal) => {
    signalCount += 1;
    if (!requestedSignal) {
      requestedSignal = signal;
      logger.error?.(`${signal} received; stopping after the current bounded database operation`);
      return;
    }

    logger.error?.(`${signal} received again; starting precise best-effort fixture cleanup`);
    if (!cleanupStarted && emergencyCleanup && !emergencyCleanupPromise) {
      emergencyCleanupPromise = Promise.resolve()
        .then(emergencyCleanup)
        .catch((error) => {
          emergencyCleanupError = error;
        });
    }
  };
  const onSigint = () => request('SIGINT');
  const onSigterm = () => request('SIGTERM');
  processTarget.on('SIGINT', onSigint);
  processTarget.on('SIGTERM', onSigterm);

  return {
    get requested() {
      return requestedSignal !== null;
    },
    get signal() {
      return requestedSignal;
    },
    get exitCode() {
      return requestedSignal ? SIGNAL_EXIT_CODES[requestedSignal] : 1;
    },
    throwIfRequested() {
      if (requestedSignal) throw new InventorySmokeInterruptedError(requestedSignal);
    },
    registerEmergencyCleanup(operation) {
      emergencyCleanup = operation;
    },
    beginCleanup() {
      cleanupStarted = true;
    },
    async waitForEmergencyCleanup() {
      if (emergencyCleanupPromise) await emergencyCleanupPromise;
      if (emergencyCleanupError) throw emergencyCleanupError;
      return null;
    },
    remove() {
      processTarget.off('SIGINT', onSigint);
      processTarget.off('SIGTERM', onSigterm);
    },
  };
}

async function checkedOperation(interrupt, operation) {
  interrupt?.throwIfRequested();
  const result = await operation();
  interrupt?.throwIfRequested();
  return result;
}

function timestampMillis(value, label) {
  if (!(typeof value === 'string' || value instanceof Date)) {
    fail(`${label} was not a timestamp`);
  }
  const milliseconds = value instanceof Date ? value.getTime() : Date.parse(value);
  if (!Number.isFinite(milliseconds)) fail(`${label} was not a valid timestamp`);
  return milliseconds;
}

function readClock(clock, label) {
  const value = clock();
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) fail(`${label} was not a valid clock value`);
  return value;
}

async function verifySchema(sql, interrupt) {
  for (const expected of EXPECTED_FUNCTIONS) {
    const rows = await checkedOperation(interrupt, () => sql`
      SELECT
        namespace.nspname AS schema_name,
        proc.proname AS function_name,
        proc.prokind AS function_kind,
        (
          SELECT string_agg(
            pg_catalog.format_type(argument.type_oid, NULL), ','
            ORDER BY argument.ordinality
          )
          FROM unnest(proc.proargtypes::oid[])
            WITH ORDINALITY AS argument(type_oid, ordinality)
        ) AS identity_types,
        proc.proretset AS returns_set,
        pg_catalog.format_type(result_type.oid, NULL) AS return_type,
        (
          SELECT string_agg(
            proc.proargnames[arg_position] || ':' ||
            pg_catalog.format_type(proc.proallargtypes[arg_position], NULL) || ':' ||
            proc.proargmodes[arg_position]::text,
            ',' ORDER BY arg_position
          )
          FROM generate_subscripts(proc.proallargtypes, 1) AS positions(arg_position)
          WHERE proc.proargmodes[arg_position] IN ('o', 'b', 't')
        ) AS output_contract
      FROM pg_catalog.pg_proc AS proc
      JOIN pg_catalog.pg_namespace AS namespace
        ON namespace.oid = proc.pronamespace
      JOIN pg_catalog.pg_type AS result_type
        ON result_type.oid = proc.prorettype
      WHERE namespace.nspname = 'public'
        AND proc.proname = ${expected.name}
      ORDER BY proc.oid`);

    const row = rows[0];
    if (rows.length !== 1 || row?.schema_name !== 'public' ||
        row?.function_name !== expected.name || row?.function_kind !== 'f' ||
        row?.identity_types !== expected.identityTypes || row?.returns_set !== true ||
        row?.return_type !== 'record' || row?.output_contract !== expected.outputContract) {
      fail(`Inventory function contract mismatch: public.${expected.name}`);
    }
  }

  for (const expected of EXPECTED_COLUMNS) {
    const rows = await checkedOperation(interrupt, () => sql`
      SELECT data_type
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = ${expected.table}
        AND column_name = ${expected.column}`);
    if (rows.length !== 1 || rows[0].data_type !== expected.type) {
      fail(`Required inventory column is missing or has the wrong type: ${expected.table}.${expected.column}`);
    }
  }
}

async function insertFixtures(sql, identifiers, dates, interrupt) {
  const inventoryRows = await checkedOperation(interrupt, () => sql`
    INSERT INTO room_inventory (room_key, capacity)
    VALUES (${identifiers.roomKey}, ${1})
    RETURNING room_key`);
  if (inventoryRows.length !== 1 || inventoryRows[0].room_key !== identifiers.roomKey) {
    fail('Could not create isolated smoke-test inventory');
  }

  const rows = await checkedOperation(interrupt, () => sql`
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
    RETURNING id, claim_token`);

  if (rows.length !== 2) fail('Could not create both isolated smoke-test bookings');
  const idsByClaim = new Map(rows.map((row) => [String(row.claim_token),
    asPositiveInteger(row.id, 'Temporary booking id')]));
  const bookingIds = identifiers.claims.map((claim) => idsByClaim.get(claim));
  if (bookingIds.some((id) => !id)) fail('Smoke-test booking claims did not match inserted rows');
  return bookingIds;
}

async function acquireConcurrentHolds(
  runtimeSqlA,
  runtimeSqlB,
  bookingIds,
  claims,
  clock,
  interrupt,
) {
  const startedAt = readClock(clock, 'Hold start clock');
  const [leftRows, rightRows] = await checkedOperation(interrupt, () => Promise.all([
    runtimeSqlA`
      SELECT * FROM belvoir_acquire_booking_hold(
        ${bookingIds[0]}::bigint, ${claims[0]}::text, ${HOLD_MINUTES}::integer
      )`,
    runtimeSqlB`
      SELECT * FROM belvoir_acquire_booking_hold(
        ${bookingIds[1]}::bigint, ${claims[1]}::text, ${HOLD_MINUTES}::integer
      )`,
  ]));
  const finishedAt = readClock(clock, 'Hold finish clock');
  if (leftRows.length !== 1 || rightRows.length !== 1) {
    fail('Concurrent hold calls returned an unexpected row count');
  }
  const results = [leftRows[0], rightRows[0]];
  if (results.some((row) => !row || typeof row.acquired !== 'boolean' ||
      !Number.isInteger(row.remaining) || row.remaining !== 0)) {
    fail('Concurrent hold result contract was invalid');
  }
  const winnerIndex = results.findIndex((row) => row.acquired === true);
  const loserIndex = results.findIndex((row) => row.acquired === false);
  if (winnerIndex < 0 || loserIndex < 0 || winnerIndex === loserIndex ||
      results.filter((row) => row.acquired === true).length !== 1 ||
      results.filter((row) => row.acquired === false).length !== 1) {
    fail('Expected exactly one winning hold and one rejected hold');
  }

  const winner = results[winnerIndex];
  const loser = results[loserIndex];
  if (loser.hold_expires_at !== null) fail('Rejected hold returned an expiry');
  const winnerExpiryMs = timestampMillis(winner.hold_expires_at, 'Winning hold expiry');
  const earliestExpiry = startedAt.getTime() + HOLD_MINUTES * 60_000 - HOLD_WINDOW_TOLERANCE_MS;
  const latestExpiry = finishedAt.getTime() + HOLD_MINUTES * 60_000 + HOLD_WINDOW_TOLERANCE_MS;
  if (winnerExpiryMs < earliestExpiry || winnerExpiryMs > latestExpiry) {
    fail('Winning hold expiry was outside the expected fifteen-minute window');
  }
  return { winningHolds: 1, winnerIndex, loserIndex, winnerExpiryMs };
}

async function assertPersistedHoldState(
  sql,
  bookingIds,
  identifiers,
  dates,
  holdOutcome,
  interrupt,
) {
  const rows = await checkedOperation(interrupt, () => sql`
    SELECT id, claim_token, reference, checkin::text, checkout::text,
      stage, inventory_status, hold_expires_at,
      hold_expires_at > clock_timestamp() AS hold_is_live
    FROM bookings
    WHERE room_key = ${identifiers.roomKey}::text
      AND (id = ${bookingIds[0]}::bigint OR id = ${bookingIds[1]}::bigint)
    ORDER BY id`);
  if (rows.length !== 2) fail('Persisted hold state did not contain both smoke bookings');

  const rowsById = new Map(rows.map((row) => [asPositiveInteger(row.id, 'Persisted booking id'), row]));
  for (let index = 0; index < bookingIds.length; index += 1) {
    const row = rowsById.get(bookingIds[index]);
    if (!row || row.claim_token !== identifiers.claims[index] ||
        row.reference !== identifiers.references[index] ||
        row.checkin !== dates.holdCheckin || row.checkout !== dates.holdCheckout) {
      fail('Persisted hold booking identity or dates did not match the smoke fixture');
    }
  }

  const winner = rowsById.get(bookingIds[holdOutcome.winnerIndex]);
  const loser = rowsById.get(bookingIds[holdOutcome.loserIndex]);
  if (winner.stage !== 'checkout' || winner.inventory_status !== 'held' ||
      winner.hold_is_live !== true ||
      timestampMillis(winner.hold_expires_at, 'Persisted winning hold expiry') !==
        holdOutcome.winnerExpiryMs) {
    fail('Persisted winning hold state was invalid');
  }
  if (loser.stage !== 'started' || loser.inventory_status !== 'unreserved' ||
      loser.hold_expires_at !== null || loser.hold_is_live !== null) {
    fail('Persisted rejected hold state was invalid');
  }
}

async function assertAvailability(sql, checkin, checkout, roomKey, label, interrupt) {
  const rows = await checkedOperation(interrupt, () => sql`
    SELECT * FROM belvoir_room_availability(
      ${checkin}::date, ${checkout}::date, ${roomKey}::text, ${null}::bigint
    )`);
  if (rows.length !== 1 || rows[0].room_key !== roomKey ||
      asPositiveInteger(rows[0].capacity, `${label} capacity`) !== 1 ||
      asNonnegativeInteger(rows[0].remaining, `${label} remaining`) !== 0) {
    fail(`${label} did not reduce remaining inventory to zero`);
  }
  return 0;
}

async function createQuantityBlock(sql, identifiers, dates, interrupt) {
  const rows = await checkedOperation(interrupt, () => sql`
    SELECT * FROM belvoir_create_room_block(
      ${identifiers.roomKey}::text, ${dates.blockStarts}::date,
      ${dates.blockEnds}::date, ${1}::integer, ${'Inventory smoke maintenance block'}::text
    )`);
  if (rows.length !== 1 || rows[0].created !== true ||
      asPositiveInteger(rows[0].block_id, 'Temporary room block id') <= 0 ||
      asNonnegativeInteger(rows[0].remaining, 'Quantity block remaining') !== 0) {
    fail('Quantity-one maintenance block was not created transactionally');
  }
}

function compileParameterizedQuery(strings) {
  let text = strings[0];
  for (let index = 1; index < strings.length; index += 1) {
    text += `$${index}${strings[index]}`;
  }
  return text;
}

export function createBoundedNeonClient(
  databaseUrl,
  { timeoutMs = DATABASE_OPERATION_TIMEOUT_MS, neonFactory = neon } = {},
) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) fail('Database timeout must be positive');
  const query = neonFactory(databaseUrl);
  return async (strings, ...values) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await query.query(compileParameterizedQuery(strings), values, {
        fetchOptions: { signal: controller.signal },
      });
    } catch (error) {
      if (controller.signal.aborted) {
        const timeoutError = new Error('Bounded database operation timed out');
        timeoutError.code = 'INVENTORY_SMOKE_QUERY_TIMEOUT';
        throw timeoutError;
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  };
}

function isRetryableCleanupError(error) {
  return error?.code === 'INVENTORY_SMOKE_QUERY_TIMEOUT';
}

async function cleanupFixtures(sql, roomKey, bookingIds) {
  const errors = [];
  const attempt = async (step, operation) => {
    for (let attemptNumber = 1; attemptNumber <= 2; attemptNumber += 1) {
      try {
        await operation();
        return;
      } catch (error) {
        if (attemptNumber === 2 || !isRetryableCleanupError(error)) {
          errors.push({ step, error });
          return;
        }
      }
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
  for (let verificationAttempt = 1; verificationAttempt <= 2; verificationAttempt += 1) {
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
      break;
    } catch (error) {
      if (verificationAttempt === 2 || !isRetryableCleanupError(error)) {
        errors.push({ step: 'verification', error });
        break;
      }
    }
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
  interrupt = null,
} = {}) {
  validateClients({ inspectionSql, runtimeSqlA, runtimeSqlB });
  // Validate before the first SQL call so a public room key can never become a
  // cleanup or mutation target, even through programmatic use of this module.
  const identifiers = validateIdentifiers(suppliedIdentifiers);
  const current = readClock(now, 'Smoke-test clock');
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
  interrupt?.registerEmergencyCleanup(() =>
    cleanupFixtures(inspectionSql, identifiers.roomKey, bookingIds));
  try {
    await verifySchema(inspectionSql, interrupt);
    logger.log('  ok   verified 5 inventory functions and 3 columns');

    bookingIds = await insertFixtures(inspectionSql, identifiers, dates, interrupt);
    const holdOutcome = await acquireConcurrentHolds(
      runtimeSqlA,
      runtimeSqlB,
      bookingIds,
      identifiers.claims,
      now,
      interrupt,
    );
    logger.log('  ok   one of two concurrent holds acquired the only room');

    await assertPersistedHoldState(
      inspectionSql,
      bookingIds,
      identifiers,
      dates,
      holdOutcome,
      interrupt,
    );
    logger.log('  ok   persisted winner and loser states match the hold result');

    const liveHoldRemaining = await assertAvailability(
      inspectionSql,
      dates.holdCheckin,
      dates.holdCheckout,
      identifiers.roomKey,
      'Live hold',
      interrupt,
    );
    logger.log('  ok   live hold leaves zero rooms available');

    await createQuantityBlock(inspectionSql, identifiers, dates, interrupt);
    await assertAvailability(
      inspectionSql,
      dates.blockStarts,
      dates.blockEnds,
      identifiers.roomKey,
      'Quantity block',
      interrupt,
    );
    logger.log('  ok   quantity-one maintenance block leaves zero rooms available');

    result = {
      ok: true,
      functionsVerified: EXPECTED_FUNCTIONS.length,
      columnsVerified: EXPECTED_COLUMNS.length,
      winningHolds: holdOutcome.winningHolds,
      liveHoldRemaining,
      quantityBlockCreated: true,
      temporaryRowsRemaining: null,
    };
  } catch (error) {
    primaryError = error;
  } finally {
    interrupt?.beginCleanup();
    let emergencyCleanupError = null;
    try {
      await interrupt?.waitForEmergencyCleanup();
    } catch (error) {
      emergencyCleanupError = error;
    }
    cleanup = await cleanupFixtures(inspectionSql, identifiers.roomKey, bookingIds);
    if (emergencyCleanupError) {
      cleanup.errors.unshift({ step: 'emergency-cleanup', error: emergencyCleanupError });
    }
  }

  if (!primaryError && interrupt?.requested) {
    primaryError = new InventorySmokeInterruptedError(interrupt.signal);
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

export async function runInventorySmokeCli({
  environment = process.env,
  processTarget = process,
  clientFactory = (url) => createBoundedNeonClient(url),
  logger = console,
  now = () => new Date(),
} = {}) {
  let urls;
  try {
    urls = requireDatabaseEnvironment(environment);
  } catch (error) {
    logger.error(JSON.stringify({ ok: false, error: safeMessage(error, []) }));
    return 1;
  }

  // Handlers are intentionally installed only after environment validation,
  // but before clients are used or the first fixture mutation can begin.
  const interrupt = installInventorySmokeSignalHandlers({ processTarget, logger });
  try {
    const result = await runInventorySmoke({
      inspectionSql: clientFactory(urls.inspectionUrl, 'inspection'),
      // Two independently-created runtime clients are intentional: their hold
      // calls must overlap so PostgreSQL's shared advisory lock is exercised.
      runtimeSqlA: clientFactory(urls.runtimeUrl, 'runtime-a'),
      runtimeSqlB: clientFactory(urls.runtimeUrl, 'runtime-b'),
      now,
      logger,
      interrupt,
    });
    logger.log(JSON.stringify(result));
    return 0;
  } catch (error) {
    const report = error instanceof InventorySmokeError
      ? error.report
      : { ok: false, error: safeMessage(error, []) };
    logger.error(JSON.stringify(report));
    return interrupt.requested ? interrupt.exitCode : 1;
  } finally {
    interrupt.remove();
  }
}

const invokedUrl = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (invokedUrl === import.meta.url) {
  process.exitCode = await runInventorySmokeCli();
}
