import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const CUTOVER_KEY = 'settlement-events-v1';
const AMBIGUOUS_REASON = 'completed-unpaid-without-settlement-evidence';
const INCOMPLETE_REASON = 'pre-cutover-payment-not-completed';

// Operational tooling can consume this without scraping prose. The shared SQL
// guard remains fail-closed throughout, but payment listeners stay disabled
// until this exact sequence reaches its final phase.
export const PAYMENT_ROLLOUT_CONTRACT = Object.freeze({
  phases: Object.freeze([
    'migrate-before-api-deploy',
    'deploy-with-payment-listeners-disabled',
    'reconcile-immediately-after-deploy',
    'verify-unresolved-quarantine-ids',
    'enable-payment-listeners',
  ]),
  postDeployCommand:
    'node --env-file=.env.local scripts/legacy-payment-reconciliation.mjs --post-deploy-before-listeners',
  verificationField: 'unresolvedQuarantineIds',
});

export function hasExactPaidAuditMarker(notes, providerRef) {
  if (!providerRef || typeof notes !== 'string') return false;
  return notes.includes(`Paid via Flot · ${providerRef} · `);
}

function isReliablyAccounted(row) {
  return row.booking_payment_status === 'paid' ||
    hasExactPaidAuditMarker(row.booking_notes, row.provider_ref);
}

function historicalOutcome(row) {
  return row.booking_inventory_status === 'conflict'
    ? 'conflict'
    : 'reserved';
}

/**
 * Reconcile payment rows that pre-date the immutable settlement registry.
 *
 * The first invocation freezes a payment-id high-water mark. Reruns therefore
 * reconsider only the original legacy population; a genuinely interrupted
 * post-migration attempt remains eligible for normal cron recovery.
 */
export async function reconcileLegacyPaymentAttempts(sql, { logger = console } = {}) {
  const insertedCutover = await sql`
    INSERT INTO legacy_payment_reconciliation_cutovers
      (migration_key, legacy_max_payment_id)
    SELECT ${CUTOVER_KEY}, COALESCE(MAX(id), 0)
    FROM payments
    ON CONFLICT (migration_key) DO NOTHING
    RETURNING legacy_max_payment_id`;
  const cutoverRows = insertedCutover.length > 0
    ? insertedCutover
    : await sql`
      SELECT legacy_max_payment_id
      FROM legacy_payment_reconciliation_cutovers
      WHERE migration_key = ${CUTOVER_KEY}`;
  if (!cutoverRows[0]) throw new Error('Legacy payment reconciliation cutover is unavailable');
  const cutoffId = Number(cutoverRows[0].legacy_max_payment_id);

  const candidates = await sql`
    SELECT payment.id AS payment_id,
      payment.booking_id,
      payment.provider_ref,
      payment.status AS payment_status,
      payment.completed_at,
      payment.received_at,
      booking.payment_status AS booking_payment_status,
      booking.inventory_status AS booking_inventory_status,
      booking.notes AS booking_notes,
      booking.payment_generation,
      settlement_event.id AS settlement_event_id,
      reconciliation.resolution AS reconciliation_resolution
    FROM payments AS payment
    JOIN bookings AS booking ON booking.id = payment.booking_id
    LEFT JOIN booking_settlement_events AS settlement_event
      ON settlement_event.booking_id = payment.booking_id
     AND settlement_event.settlement_key = 'flot-payment:' || payment.id::text
    LEFT JOIN legacy_payment_reconciliation AS reconciliation
      ON reconciliation.payment_id = payment.id
    WHERE payment.id <= ${cutoffId}
      AND payment.provider_ref IS NOT NULL
    ORDER BY payment.id`;

  let registered = 0;
  let quarantined = 0;
  for (const candidate of candidates) {
    if (candidate.settlement_event_id != null) {
      continue;
    }
    // A recover/ignore choice belongs to the operator and is never replaced by
    // later note or status changes. System-owned pending rows may still become
    // exact historical evidence on the mandatory post-deploy rerun.
    if (candidate.reconciliation_resolution === 'recover' ||
        candidate.reconciliation_resolution === 'ignore') {
      continue;
    }
    if (candidate.payment_status === 'completed' && isReliablyAccounted(candidate)) {
      const minimumGeneration = Math.max(1, Number(candidate.payment_generation) || 0);
      const outcome = historicalOutcome(candidate);
      const settledAt = candidate.completed_at || candidate.received_at || null;
      const settlementKey = `flot-payment:${candidate.payment_id}`;
      const inserted = await sql`
        WITH generation AS (
          UPDATE bookings
          SET payment_generation = GREATEST(payment_generation, ${minimumGeneration})
          WHERE id = ${candidate.booking_id}
          RETURNING payment_generation
        )
        INSERT INTO booking_settlement_events
          (booking_id, settlement_key, payment_generation, outcome, settled_at)
        SELECT ${candidate.booking_id}, ${settlementKey}, generation.payment_generation,
          ${outcome}, COALESCE(${settledAt}::timestamptz, clock_timestamp())
        FROM generation
        ON CONFLICT (booking_id, settlement_key) DO NOTHING
        RETURNING id`;
      registered += inserted.length;
      continue;
    }

    const reason = candidate.payment_status === 'completed'
      ? AMBIGUOUS_REASON
      : INCOMPLETE_REASON;
    const inserted = await sql`
      INSERT INTO legacy_payment_reconciliation
        (payment_id, booking_id, reason)
      VALUES (${candidate.payment_id}, ${candidate.booking_id}, ${reason})
      ON CONFLICT (payment_id) DO NOTHING
      RETURNING payment_id`;
    quarantined += inserted.length;
  }

  const unresolved = await sql`
    SELECT reconciliation.payment_id, reconciliation.resolution
    FROM legacy_payment_reconciliation AS reconciliation
    LEFT JOIN booking_settlement_events AS settlement_event
      ON settlement_event.booking_id = reconciliation.booking_id
     AND settlement_event.settlement_key = 'flot-payment:' || reconciliation.payment_id::text
    WHERE settlement_event.id IS NULL
    ORDER BY reconciliation.payment_id`;
  const pendingIds = unresolved
    .filter((row) => row.resolution === 'pending')
    .map((row) => Number(row.payment_id));
  const previewIds = pendingIds.slice(0, 20);
  const remainder = pendingIds.length - previewIds.length;
  const idList = pendingIds.length > 0
    ? ` IDs: ${previewIds.join(', ')}${remainder > 0 ? ` (+${remainder} more)` : ''}`
    : '';
  logger.log(
    `[availability] ${pendingIds.length} legacy payment identit${pendingIds.length === 1 ? 'y' : 'ies'} ` +
      `awaiting reconciliation.${idList}`,
  );

  return {
    cutoffId,
    registered,
    quarantined,
    pendingIds,
    unresolvedQuarantineIds: pendingIds,
  };
}

const invokedUrl = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : null;
if (invokedUrl === import.meta.url) {
  if (!process.argv.includes('--post-deploy-before-listeners')) {
    throw new Error(
      'Use --post-deploy-before-listeners after API deployment and before enabling payment listeners.',
    );
  }
  const databaseUrl = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL_UNPOOLED or DATABASE_URL is required');
  const { neon } = await import('@neondatabase/serverless');
  const result = await reconcileLegacyPaymentAttempts(neon(databaseUrl));
  console.log(JSON.stringify({
    phase: 'post-deploy-before-listeners',
    cutoffId: result.cutoffId,
    unresolvedQuarantineIds: result.unresolvedQuarantineIds,
  }));
}
