/**
 * The single place a booking becomes paid.
 *
 * Three routes can hear that money arrived: Flot's webhook, the browser polling
 * flot-status, and the reconciliation cron. All three call this, so the rule
 * "a guest holding a confirmation email has paid" holds no matter which one
 * fired first.
 *
 * Exactly-once is enforced by the database inventory function, which locks the
 * booking and room type before deciding whether the payment reserves a room or
 * becomes an inventory conflict. Only its first successful transition owns
 * notifications; concurrent or repeated listeners stay silent.
 */

const { confirmBooking, notifyPaid } = require('./_notify');
const { notifyAdmins } = require('./_whapi');
const { settleBookingInventory } = require('./_inventory');
const F = require('./_flot');

/**
 * @param sql        neon tagged-template client
 * @param bookingId  the booking to settle
 * @param providerRef Flot's attempt/request id, recorded in the notes
 * @param source     which route observed it, for the audit trail
 * @returns {Promise<{settled:boolean, alreadyPaid:boolean, conflict:boolean, booking:object|null}>}
 */
async function settleBooking(sql, bookingId, providerRef, source) {
  const id = parseInt(bookingId, 10);
  if (!id) return { settled: false, alreadyPaid: false, conflict: false, booking: null };

  const outcome = await settleBookingInventory(sql, id);
  const conflict = outcome.inventoryStatus === 'conflict';

  if (!outcome.settled) {
    const existing = await sql`SELECT * FROM bookings WHERE id = ${id} LIMIT 1`;
    return {
      settled: false,
      alreadyPaid: outcome.alreadyPaid,
      conflict,
      booking: existing[0] || null,
    };
  }

  const note = source === 'admin'
    ? 'Marked paid by an administrator'
    : `Paid via Flot · ${providerRef} · ${source}`;
  let rows = [];
  try {
    rows = await sql`
      UPDATE bookings
      SET notes = CASE WHEN COALESCE(notes, '') = ''
                       THEN ${note}
                       ELSE notes || ${' · ' + note} END
      WHERE id = ${id}
      RETURNING *`;
  } catch {
    // The payment transition already succeeded. A secondary audit-note write
    // must not prevent the customer/team notifications owned by this caller.
    F.log('PAYMENT_NOTE_APPEND_FAILED', { bookingId: id, observedBy: source || null });
  }
  if (!rows.length) rows = await sql`SELECT * FROM bookings WHERE id = ${id} LIMIT 1`;
  const booking = rows.length ? { ...rows[0], paid_source: source } : null;
  if (!booking) {
    F.log('PAYMENT_BOOKING_READ_FAILED', { bookingId: id, observedBy: source || null });
    return { settled: true, alreadyPaid: false, conflict, booking: null };
  }

  if (conflict) {
    F.log('PAYMENT_INVENTORY_CONFLICT', {
      bookingId: id,
      bookingReference: booking.reference || null,
      paymentReference: providerRef || null,
      roomKey: booking.room_key || null,
      checkin: booking.checkin || null,
      checkout: booking.checkout || null,
      observedBy: source || null,
      urgent: true,
    });
    try {
      await notifyAdmins('payment-conflict', booking);
    } catch (err) {
      console.error('WhatsApp payment conflict alert failed:', bookingId, err.message);
    }
    return { settled: true, alreadyPaid: false, conflict: true, booking };
  }

  // Email must never undo a settled payment, so each is caught on its own and
  // the booking stays paid regardless.
  try {
    await confirmBooking(booking);
  } catch (err) {
    console.error('guest payment confirmation failed:', bookingId, err.message);
  }
  try {
    await notifyPaid(booking);
  } catch (err) {
    console.error('team payment notification failed:', bookingId, err.message);
  }
  try {
    await notifyAdmins('payment-received', booking);
  } catch (err) {
    console.error('WhatsApp payment alert failed:', bookingId, err.message);
  }

  return { settled: true, alreadyPaid: false, conflict: false, booking };
}

module.exports = { settleBooking };
