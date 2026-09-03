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
