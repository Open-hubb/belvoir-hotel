# Room Inventory and Date-Based Availability Design

**Date:** 2026-09-02

**Status:** Approved for implementation

**Scope:** Public room discovery, booking checkout, payment holds, admin maintenance blocks, and the Airport Transfer service card

## Objective

Replace the current one-room-per-type assumption with Belvoir's real inventory. Guests must see how many rooms remain for their selected stay, be clearly warned when a room type is fully booked, and be unable to start payment when no unit remains. Paid bookings and admin maintenance blocks must reduce availability. An unpaid payment attempt may hold one unit for 15 minutes so two guests cannot pay for the last unit at the same time.

## Confirmed Inventory

| Room key | Public name | Units |
| --- | --- | ---: |
| `comfort` | Superior Double / Comfort | 1 |
| `standard` | Deluxe Standard | 2 |
| `ground-floor` | Ground Floor One-Bedroom | 2 |
| `superior-deluxe` | Superior Deluxe King | 3 |
| `superior-twin` | Superior Deluxe Twin | 1 |
| `studio` | Studio Penthouse | 1 |
| `one-bed` | One-Bedroom Apartment | 3 |
| `two-bed` | Two-Bedroom Apartment | 2 |

The earlier phrase “one bedroom apartments penthouse” was clarified to mean the existing Studio Penthouse, so no ninth room type will be created.

## Availability Rules

Dates use half-open ranges: a booking occupies each night from check-in up to, but not including, check-out. A guest checking out on the same day another guest checks in does not create a clash.

For every night in the requested stay, occupied inventory is:

1. Active bookings with `payment_status = 'paid'`.
2. Active checkout bookings whose `hold_expires_at` is still in the future.
3. The sum of active maintenance-block units for the room type on that night.

The number shown as remaining is the smallest remaining count across all nights in the requested stay:

`remaining = capacity - maximum nightly occupied units`

This night-by-night calculation is required. Counting every booking that merely overlaps the requested range would incorrectly mark some back-to-back bookings as using multiple units at the same time.

Rows at the initial `started` stage do not hold inventory. Cancelled bookings, unpaid bookings with expired or missing holds, and deleted maintenance blocks do not reduce availability.

## Data Model and Migration

### Room inventory

Add a `room_inventory` table with one row per room key and a positive `capacity`. The migration seeds and updates the eight confirmed capacities above. The application room catalogue continues to hold names and rates and also exposes the expected capacity for validation; the database table is the transactional source used when acquiring inventory.

### Booking holds

Add `bookings.hold_expires_at timestamptz`. Existing unpaid checkout rows receive no automatic hold and therefore stop blocking inventory after migration. Existing paid bookings continue to occupy a unit until checkout.

Add `bookings.inventory_status text NOT NULL DEFAULT 'unreserved'`, constrained to `unreserved`, `held`, `reserved`, or `conflict`:

- `unreserved`: an enquiry or unpaid booking without a valid hold;
- `held`: an unpaid checkout booking that consumes inventory only while `hold_expires_at > now()`;
- `reserved`: a partial/full paid booking that consumes inventory through check-out;
- `conflict`: money was received after the hold was lost and staff action is required; this row does not consume another unit.

The migration marks existing paid, active bookings as `reserved`. Other existing rows remain `unreserved` unless a new hold is acquired through the updated API.

The current `bookings_no_overlap` exclusion constraint must be removed because it enforces a capacity of exactly one. Capacity will instead be enforced by a database function that runs under a room-specific PostgreSQL advisory transaction lock.

### Maintenance blocks

Add `room_blocks.units integer NOT NULL DEFAULT 1` with a positive-value constraint. Remove `room_blocks_no_overlap`, because multiple partial blocks may legitimately overlap while their combined units remain within capacity.

The admin API validates that `units` is between 1 and the room type's capacity. A database-locked operation checks every affected night and refuses a block if bookings, holds, and existing blocks would exceed capacity.

### Indexes

Replace the current single-unit-oriented booking index with a partial `bookings_inventory_dates` index over room key, check-in, check-out, and hold expiry for active rows whose inventory status is held or reserved. Add `room_blocks_inventory_dates` over room key, start date, and end date. These support the nightly occupancy queries without changing their correctness.

## Concurrency and Overselling Prevention

All operations that consume the last available unit must execute in PostgreSQL under the same advisory lock derived from the room key. The locked operation checks nightly occupancy and performs the update or insert only when every requested night has capacity.

This applies to:

- upgrading a `started` booking to checkout and acquiring a hold;
- creating a checkout booking directly;
- refreshing a guest's valid payment hold;
- settling a payment after rechecking inventory;
- an admin manually marking an unpaid booking as paid;
- creating an admin maintenance block;
- reactivating a cancelled booking.

The browser's availability check is informative. The database-locked write is the final guarantee, so two simultaneous requests cannot both claim the last unit.

## Booking and Payment Lifecycle

1. The guest chooses a room and dates. The public availability endpoint returns live capacity information.
2. Saving contact details at `stage = 'started'` records the enquiry but does not hold a room.
3. Moving to payment atomically acquires one unit for 15 minutes and writes `hold_expires_at`.
4. Creating a payment link refreshes the hold to 15 minutes from that request.
5. Valid payment-status polling by the guest refreshes the hold while the payment attempt remains active. Refreshes cannot alter the room or dates.
6. Partial or full payment atomically changes `payment_status` to paid and `inventory_status` to reserved. A reserved booking occupies one unit through check-out and no longer depends on hold expiry.
7. Failed, cancelled, or abandoned payment attempts release inventory when their hold expires. Explicit booking cancellation releases it immediately.

If payment arrives after a hold expired, settlement rechecks capacity under the same room lock. When capacity remains, the payment is confirmed normally. If capacity has since filled, the system records `payment_status = 'paid'` and `inventory_status = 'conflict'`, does not send a normal booking confirmation, and sends an urgent admin alert for reassignment or refund. This exceptional state must be visible in the admin dashboard and must not silently oversell the room type.

Existing WhatsApp policy remains unchanged: admins receive WhatsApp messages for enquiries and confirmed partial/full payments, not for ordinary temporary holds.

## API Contract

### `GET /api/availability`

Inputs remain `checkin`, `checkout`, and optional `room`.

Each returned room includes:

```json
{
  "key": "superior-deluxe",
  "name": "Superior Deluxe King",
  "rate": 80,
  "capacity": 3,
  "remaining": 1,
  "available": true,
  "nights": 3,
  "total": 240
}
```

`available` is true when `remaining > 0`. The response continues to use `Cache-Control: no-store`.

### `POST /api/bookings`

`stage = 'started'` remains non-blocking. `stage = 'checkout'` acquires or refreshes the booking's 15-minute hold. When the room is full, return HTTP 409 with `code = 'ROOM_UNAVAILABLE'` and a guest-safe message. A successful checkout response includes `holdExpiresAt` so the payment interface can show the reservation window.

### Payment endpoints

Payment-link creation and valid in-progress polling refresh the hold. Payment settlement uses the locked settlement path and returns a distinct conflict result when money arrived after inventory was lost.

### `POST /api/blocks`

Accept `units` in addition to room, start date, end date, and reason. Reject invalid quantities and any block that would exceed nightly capacity. GET responses include both block units and room capacity for the admin display.

## Public Interface

### Room cards

Once check-in and check-out are known, each room card displays one of:

- `3 rooms available` when more than one remains;
- `Only 1 room left` when one remains;
- `Fully booked · 10–13 Sep` when none remain.

The exact dates come from the guest's current selection. A fully booked card stays viewable for room information, but its booking action is disabled and labelled `Choose different dates`. The state is announced accessibly and is not conveyed by colour alone.

Before dates are selected, cards continue to show their normal content without claiming live availability.

### Room detail pages

Every generated room page receives a compact check-in/check-out availability form. It accepts dates passed from the home page and allows them to be changed. The page shows remaining inventory using the same wording as the room cards.

When fully booked, a clear notice states that the room type is unavailable for the selected date range. The booking control is disabled and a `Choose different dates` action focuses the date fields. When inventory is available, the booking action returns to the main booking flow with the room and dates preselected.

### Booking flow

The wizard rechecks availability after dates or room selection and immediately before acquiring the payment hold. If the last unit was taken between those steps, it keeps the guest's entered details, explains what changed, and returns them to room selection. The payment step shows a concise 15-minute reservation notice and an expiry time.

### Visual direction

The new states extend the existing Belvoir design instead of introducing a new visual language:

- navy for headings and controls;
- gold for availability accents and “only one left” emphasis;
- cream/white surfaces and existing borders;
- a muted navy/cream sold-out treatment with both iconography and text;
- existing Cormorant-style display typography and Josefin-style body typography;
- at least 44px touch targets, visible keyboard focus, WCAG 2.2 AA contrast, and polite live-region announcements for asynchronous availability results.

## Admin Interface

The maintenance-block form gains a `Rooms out of service` number/select field, constrained to the chosen room type's capacity. The list displays entries such as `2 of 3 rooms blocked`. If the selected dates already contain bookings or other blocks, the API allows only the quantity that fits and explains conflicts without exposing guest details in the public interface.

The booking list surfaces hold expiry for unpaid checkout attempts and a prominent paid-inventory-conflict status for the exceptional late-payment case.

## Airport Transfer Card

Replace the service card title and description with:

**Title:** Airport Transfer

**Description:** Seamless arrival from Lungi Airport, with Sea Coach transfer assistance and private pickup to Belvoir.

The existing icon, card structure, spacing, and visual styling remain unchanged.

## Error Handling

- Database or availability failures show a retryable message and never assume the room is available.
- Expired holds redirect the guest to recheck the same room and dates; contact details remain populated locally where possible.
- A 409 race response is handled as a normal availability change, not a generic server error.
- Admin block conflicts state the maximum quantity currently possible for the range.
- Payment conflicts are logged with booking reference, payment reference, room key, and dates; admins are alerted, while guest confirmation is withheld until staff resolution.

## Verification and Acceptance Criteria

Automated tests must cover:

- all eight capacities;
- half-open check-in/check-out boundaries;
- night-by-night remaining counts across non-overlapping and overlapping stays;
- paid, held, expired, cancelled, and started booking states;
- overlapping maintenance blocks with quantities;
- hold acquisition, refresh, expiry, and simultaneous last-unit requests;
- normal and late payment settlement;
- admin block validation;
- compatibility of the existing API fields;
- the Airport Transfer copy.

Browser QA must cover room cards, all generated room-detail pages, the booking wizard, and the admin block flow at 375px, 768px, and 1440px. Run at least two screenshot review passes, inspect every PNG, test keyboard operation and live announcements, confirm no console errors or failed requests, and run the project's full test and SEO checks before deployment.

## Rollout

1. Deploy the additive schema and database functions.
2. Verify seeded capacities and existing paid bookings.
3. Deploy API changes.
4. Deploy regenerated room pages and public/admin interface changes.
5. Run a production availability check and a temporary hold test without completing a real payment.
6. Monitor booking, payment, and WhatsApp logs for conflict or notification errors.

The migration is designed to be safe to rerun. Rollback of application code must not restore the single-unit exclusion constraints while multi-unit bookings exist.
