// Small adapter around the database inventory functions.
//
// Keep SQL and Neon-specific row names here so callers can work with the
// typed-by-contract values returned by the availability and booking flows.

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

async function settleBookingInventory(sql, bookingId, settlementKey) {
  const rows = await sql`
    SELECT * FROM belvoir_settle_booking(
      ${bookingId}::bigint, ${settlementKey}::text
    )`;
  const row = rows[0] || {};
  return {
    settled: row.settled === true,
    alreadyPaid: row.already_paid === true,
    alreadyProcessed: row.already_processed === true,
    inventoryStatus: row.inventory_status || null,
    paymentGeneration: row.payment_generation == null
      ? null
      : Number(row.payment_generation),
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
