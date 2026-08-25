/**
 * The single place a booking becomes paid.
 *
 * Three routes can hear that money arrived: Flot's webhook, the browser polling
 * flot-status, and the reconciliation cron. All three call this, so the rule
 * "a guest holding a confirmation email has paid" holds no matter which one
 * fired first.
 *
 * Exactly-once is enforced by the database, not by checking first and writing
 * second: the UPDATE only matches a row that is not already paid, so of any
 * number of concurrent callers exactly one gets a row back and therefore
 * exactly one sends the email. The losers get nothing and stay silent.
 */

const { confirmBooking, notifyPaid } = require('./_notify');
const { notifyAdmins } = require('./_whapi');

/**
 * @param sql        neon tagged-template client
 * @param bookingId  the booking to settle
 * @param providerRef Flot's attempt/request id, recorded in the notes
 * @param source     which route observed it, for the audit trail
 * @returns {Promise<{settled:boolean, alreadyPaid:boolean, booking:object|null}>}
 */
async function settleBooking(sql, bookingId, providerRef, source) {
  const id = parseInt(bookingId, 10);
  if (!id) return { settled: false, alreadyPaid: false, booking: null };

  const note = `Paid via Flot · ${providerRef} · ${source}`;

  // Whoever wins this UPDATE owns the notification. IS DISTINCT FROM also
  // covers a NULL payment_status, which a plain <> would silently skip.
  const rows = await sql`
    UPDATE bookings
    SET payment_status = 'paid',
        stage = 'checkout',
        notes = CASE WHEN COALESCE(notes, '') = ''
                     THEN ${note}
                     ELSE notes || ${' · ' + note} END
    WHERE id = ${id} AND payment_status IS DISTINCT FROM 'paid'
    RETURNING *`;

  if (!rows.length) {
    // Either the booking does not exist or someone else already settled it.
    const existing = await sql`SELECT * FROM bookings WHERE id = ${id} LIMIT 1`;
    return {
      settled: false,
      alreadyPaid: Boolean(existing.length),
      booking: existing[0] || null,
    };
  }

  const booking = { ...rows[0], paid_source: source };

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

  return { settled: true, alreadyPaid: false, booking };
}

module.exports = { settleBooking };
