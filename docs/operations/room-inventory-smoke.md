# Room inventory smoke test operations

Run `npm run inventory:smoke` from the reviewed repository root only after the
migration and deployment have passed their review gates. The package command
loads that root checkout's `.env.local`. The script creates isolated rows whose
room key begins with `__inventory_smoke_`; it never uses a public room key or
invokes payment or notification providers.

Each database operation runs in a transaction with a transaction-local
PostgreSQL `statement_timeout`. The HTTP client deadline is longer. If the
transport outcome is uncertain, the script waits beyond the server deadline
before it performs the final exact-key cleanup and count.

## Interrupts and abrupt termination

`SIGINT` or `SIGTERM` stops new checks, waits for the current bounded operation,
then runs precise cleanup. A second signal requests an additional best-effort
cleanup, but the process still waits for the definitive cleanup and count.

`SIGKILL`, host failure, or power loss cannot run JavaScript cleanup. If one of
those occurs, **stop the rollout** and keep payment/notification processing
paused until an operator has checked the database:

1. Find candidate keys only in the reserved `__inventory_smoke_` namespace.
2. Verify the temporary room key and its linked bookings/references against the
   failed run. Never use a public room key as a cleanup target.
3. In one reviewed transaction, delete rows for that verified temporary room key
   only, in dependency order: `payments`, `bookings`, `room_blocks`, then
   `room_inventory`.
4. Query all four tables again for the same exact key and require a zero count
   before resuming the rollout.

Do not run a broad `DELETE`, a prefix-based delete, or cleanup with an
unverified key. Escalate for database review if the exact temporary key cannot
be established safely.

## Payment-status claim cutover

The reviewed release moves the booking claim out of `/api/flot-status` URLs and
into the `X-Booking-Claim` header. The previously deployed page does not send
that header, so treat this as a strict client/server cutover:

1. Set `PAYMENT_LISTENERS_ENABLED=false` before deploying the reviewed build.
2. Deploy the reviewed build and verify all booking/inventory mutations plus
   all payment listeners return the paused response before running migrations
   or reconciliation.
3. Keep listeners paused for at least the 10-minute browser polling lifetime.
   A payment started by an older, already-open page can then drain or time out
   without the new API accepting an unauthenticated legacy status request.
4. Reconcile every payment attempt created before or during the pause. Do not
   enable listeners while any completed or ambiguous attempt is unresolved.
5. Run the inventory smoke test and the paused inventory/listener verification
   again.
6. Enable listeners, redeploy the same reviewed commit, and verify header-only
   polling plus all active listener responses.

An old page used after the cutover may be asked to reload before starting a new
payment. This fails before money is requested; do not add a query-string or
unauthenticated fallback to hide that stale-client condition.
