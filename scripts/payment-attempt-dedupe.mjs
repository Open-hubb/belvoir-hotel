// Shared, executable policy for collapsing historical webhook/link races before
// the provider-pair unique index is installed.

function asTime(value) {
  const time = value == null ? Number.NEGATIVE_INFINITY : Date.parse(value);
  return Number.isFinite(time) ? time : Number.NEGATIVE_INFINITY;
}

function serialise(value) {
  if (value == null) return null;
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function canonicalRank(a, b) {
  const aLink = Boolean(a.short_code || a.pay_link);
  const bLink = Boolean(b.short_code || b.pay_link);
  if (aLink !== bLink) return aLink ? -1 : 1;
  const aBooking = a.booking_id != null;
  const bBooking = b.booking_id != null;
  if (aBooking !== bBooking) return aBooking ? -1 : 1;
  const aCompleted = a.status === 'completed';
  const bCompleted = b.status === 'completed';
  if (aCompleted !== bCompleted) return aCompleted ? -1 : 1;
  const timeDifference = asTime(b.received_at) - asTime(a.received_at);
  if (timeDifference) return timeDifference;
  return Number(b.id) - Number(a.id);
}

function completionRank(a, b) {
  const aTime = a.completed_at || a.received_at;
  const bTime = b.completed_at || b.received_at;
  const timeDifference = asTime(bTime) - asTime(aTime);
  return timeDifference || Number(b.id) - Number(a.id);
}

export function mergePaymentAttemptRows(rows) {
  if (!Array.isArray(rows) || !rows.length) return null;
  const ranked = [...rows].sort(canonicalRank);
  const canonical = ranked[0];
  const completed = rows.filter((row) => row.status === 'completed').sort(completionRank)[0] || null;

  return {
    id: canonical.id,
    reference: canonical.reference,
    providerRef: canonical.provider_ref,
    status: completed ? 'completed' : canonical.status,
    matched: rows.some((row) => row.matched === true),
    // Keep the canonical row's `raw` untouched (normally the link request),
    // while retaining the provider evidence in its dedicated audit column.
    providerRaw: serialise(completed ? (completed.provider_raw ?? completed.raw) : canonical.provider_raw),
    completedAt: completed ? (completed.completed_at || completed.received_at || null) : canonical.completed_at,
  };
}

export async function deduplicatePaymentAttempts(sql) {
  const rows = await sql`
    SELECT id, reference, provider_ref, booking_id, status, matched,
      raw::text AS raw, provider_raw, short_code, pay_link,
      completed_at, received_at
    FROM payments
    WHERE provider_ref IS NOT NULL
    ORDER BY reference, provider_ref, id`;

  const grouped = new Map();
  for (const row of rows) {
    const key = JSON.stringify([row.reference, row.provider_ref]);
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(row);
  }

  const plans = [...grouped.values()]
    .filter((group) => group.length > 1 || group.some((row) => row.status === 'completed'))
    .map(mergePaymentAttemptRows)
    .filter(Boolean);
  if (!plans.length) return { groups: 0, deleted: 0 };

  await sql.transaction((txn) => plans.flatMap((plan) => [
    txn`
      UPDATE payments
      SET status = ${plan.status}, matched = ${plan.matched},
          provider_raw = COALESCE(${plan.providerRaw}, provider_raw),
          completed_at = COALESCE(${plan.completedAt}, completed_at)
      WHERE id = ${plan.id}
      RETURNING id`,
    txn`
      DELETE FROM payments
      WHERE reference IS NOT DISTINCT FROM ${plan.reference}
        AND provider_ref = ${plan.providerRef}
        AND id <> ${plan.id}`,
  ]));

  return {
    groups: plans.length,
    deleted: [...grouped.values()].reduce((total, group) => total + Math.max(0, group.length - 1), 0),
  };
}
