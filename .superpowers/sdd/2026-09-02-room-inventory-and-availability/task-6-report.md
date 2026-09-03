# Task 6 report — quantity maintenance blocks and settlement quarantine

## Outcome

Task 6 is implemented together with the two Task 5 cap rulings carried into this checkpoint. Quantity-based maintenance blocks now use the capacity-locked database writer, the admin UI exposes quantity and inventory state, and all Flot listeners now converge on a fail-closed quarantine check inside `belvoir_settle_booking`.

Checkpoint commit: `Add quantity room blocks and settlement quarantine` (this report is part of that commit; use `git log` for its immutable hash).

No migration, deployment, production-secret access, or production data access was performed. The pre-existing unstaged `package-lock.json` change was deliberately left untouched and is not part of the checkpoint.

## TDD evidence

Baseline before implementation:

```text
node --test tests/room-inventory.test.mjs tests/audit-fixes.test.mjs
# 79 passed, 0 failed
```

Recorded RED states:

```text
# Shared quarantine, route propagation, adapter, reconciliation, rollout, and SQL guard
node --test --test-name-pattern='legacy quarantine|duplicate webhook acknowledges|inventory adapter (normalizes hold|fails closed)|legacy payment reconciliation preserves|payment rollout contract|settlement atomically' tests/room-inventory.test.mjs
# 7 tests, 0 passed, 7 failed

# Task 6 block API/UI and booking-state behavior
node --test --test-name-pattern='block API|admin block form|admin booking cards|admin keeps local' tests/room-inventory.test.mjs tests/audit-fixes.test.mjs
# 7 tests, 1 pre-existing pass, 6 failed

# Applying the authoritative server result after Mark Paid
node --test --test-name-pattern='admin applies the server inventory outcome' tests/audit-fixes.test.mjs
# 1 failed

# Shared quarantine refusal through cron
node --test --test-name-pattern='cron reports a shared quarantine refusal' tests/room-inventory.test.mjs
# 1 failed

# 375px inventory-view containment found during visual QA
node --test --test-name-pattern='admin inventory views stay within' tests/audit-fixes.test.mjs
# 1 failed: viewport 375, document width 631

# Resolution-read serialization at the database boundary
node --test --test-name-pattern='settlement atomically' tests/room-inventory.test.mjs
# 1 failed before the reconciliation row read used FOR UPDATE
```

Each targeted test was then observed GREEN after its implementation. Final verification is recorded below.

## Cap-ruling protocol invariants

- `belvoir_settle_booking` is the shared authority for every `flot-payment:<payments.id>` settlement. It checks an existing immutable event first, then classifies the payment ID against the insert-once legacy high-water mark before any paid-state check, generation advance, inventory decision, booking update, event insert, or outbox insert.
- Every Flot identity at or below the cutover fails closed unless its matching payment/booking reconciliation row is explicitly `recover`. Missing, `pending`, and `ignore` dispositions return `resolution_required = true` with a typed resolution. A missing cutover returns `migration-required`, so deploying API code before the migration is also fail-closed.
- The reconciliation-row read is locked, serializing settlement eligibility with an operator's resolution update. Existing immutable event replay remains a non-mutating `already_processed` result.
- The JS inventory adapter preserves the typed result and independently fails closed if a Flot settlement reaches an older database return contract. The paid wrapper stops before audit-note writes and notification delivery for a blocked identity.
- Claim-authenticated polling returns HTTP 409 with `PAYMENT_RECONCILIATION_REQUIRED`; duplicate webhooks remain safely acknowledged with HTTP 200 but return `markedPaid: false`, `resolutionRequired: true`, and the same code; cron does not count the attempt as completed and reports `reconciliationRequired`. Pending/ignore/recover/replay behavior is covered through real route handlers with a stateful shared-invariant fixture.
- The cutover freezes the maximum payment ID once. Reconciliation scans linked provider attempts of every status at or below that ID, including attempts that were pending on the first pass. These identities are placed in reconciliation scope immediately and cannot auto-settle later.
- On the mandatory post-deploy rerun, a pre-cutover attempt completed by old code can receive an immutable event only from exact historical settlement evidence. Without that evidence it remains pending and fail-closed for explicit recover/ignore. Existing operator `recover` and `ignore` decisions are never rewritten. Rows above the frozen cutoff remain eligible for automatic interrupted-settlement recovery.
- The rollout contract is exported as machine-readable phases and the CLI prints the complete `unresolvedQuarantineIds` array. Required order:
  1. run the availability migration before API/cron deployment;
  2. deploy with payment polling, webhook delivery, and cron listeners disabled;
  3. immediately run `node --env-file=.env.local scripts/legacy-payment-reconciliation.mjs --post-deploy-before-listeners`;
  4. capture and review every `unresolvedQuarantineIds` value;
  5. only then enable payment listeners.

## Task 6 behavior

- `POST /api/blocks` converts and validates an integer `units` value from 1 through the selected room capacity, then calls `createRoomBlock`. Capacity refusal is HTTP 409 `INSUFFICIENT_CAPACITY` with the remaining-unit message. The former guest-data clash query is gone.
- `GET /api/blocks` preserves the block row fields and adds numeric `units`, `room_name`, and `capacity`. DELETE behavior is unchanged.
- The existing admin design now includes a visible, associated `blkUnits` numeric control. Room changes update its maximum and clamp the current value; submission sends a number; cards read “N of M rooms blocked.”
- Booking cards show a prominent `Payment conflict` state with `Reassign or refund`, live unpaid holds as `Held until HH:MM`, and expired/unreserved checkout attempts as `Left at payment`. Failed Restore/Mark Paid actions surface the safe API message without optimistic local mutation, while successful actions apply the full server booking result.
- Visual QA was performed in two localhost browser passes for both blocks and booking states at 375px, 768px, and 1440px. The first pass exposed the narrow tab-strip overflow; the second pass confirmed true-width 375px output and clean layouts at all three widths.

## Files

- `api/blocks.js`
- `admin.html`
- `tests/room-inventory.test.mjs`
- `tests/audit-fixes.test.mjs`
- `scripts/migrate-availability.mjs`
- `scripts/legacy-payment-reconciliation.mjs`
- `api/_inventory.js`
- `api/_paid.js`
- `api/flot-status.js`
- `api/payment-webhook.js`
- `api/cron-poll-payments.js`

## Verification and rollout concerns

```text
node --check <each changed JS/MJS file>
# all passed

# vm.Script compilation of the inline admin script
# 1 inline script compiled

node --test tests/audit-fixes.test.mjs tests/admin-access.test.mjs tests/room-inventory.test.mjs tests/whapi-notifications.test.mjs
# 104 passed, 0 failed

node --test tests/*.test.mjs
# 104 passed, 0 failed

git diff --check
# clean
```

Live PostgreSQL function compilation, real row-lock ordering, production reconciliation output, and provider delivery remain rollout checks because this task was explicitly prohibited from migrating or accessing production. The previously documented Whapi post-acceptance/process-loss duplicate boundary is unchanged.
