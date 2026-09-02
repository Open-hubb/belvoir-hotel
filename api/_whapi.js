/**
 * Optional WhatsApp alerts for the hotel team, delivered through Whapi.
 *
 * This module is deliberately server-only: the Whapi token and the admin
 * group chat identifier stay in environment variables and are never returned to the
 * browser. Alerts are best-effort, so a Whapi outage cannot undo a saved
 * booking or a settled payment.
 */

const WHAPI_TEXT_ENDPOINT = 'https://gate.whapi.cloud/messages/text';
const DEFAULT_ORIGIN = 'https://www.belvoir-estates.com';
const REQUEST_TIMEOUT_MS = 5_000;

function adminGroupId(value) {
  const groupId = String(value || '').trim();
  // Whapi addresses WhatsApp groups by their group chat ID, which ends in
  // @g.us. Accept numeric IDs with their optional legacy hyphen separator.
  return /^[0-9-]+@g\.us$/.test(groupId) ? groupId : '';
}

function money(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return 'Amount unavailable';
  return '$' + amount.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}

function day(value) {
  const text = String(value || '');
  // Booking dates are stored as date-only values. Keeping them date-only also
  // prevents a server timezone from changing the day shown in the alert.
  return /^\d{4}-\d{2}-\d{2}/.test(text) ? text.slice(0, 10) : 'Date unavailable';
}

function dashboardUrl(env) {
  const origin = String(env.PUBLIC_ORIGIN || DEFAULT_ORIGIN).replace(/\/+$/, '');
  return `${origin}/admin`;
}

/**
 * Builds the small, actionable alert sent to each administrator. Do not add
 * guest email, phone, message, requests, payment identifiers, or other
 * sensitive data. The guest name is included because the hotel has approved
 * it as useful context for its authenticated administrator WhatsApp alerts.
 */
function buildAdminMessage(event, record, env = process.env) {
  if (event === 'new-enquiry') {
    const enquiryKind = {
      short: 'Short-stay enquiry',
      extended: 'Extended-stay enquiry',
      long: 'Long-term enquiry',
      business: 'Business / corporate enquiry',
    }[record.stay_type] || 'Website enquiry';

    return [
      `*Belvoir · New enquiry*`,
      `Enquiry: #${record.id || 'new'}`,
      `Guest: ${record.name || 'Name unavailable'}`,
      `Interest: ${enquiryKind}`,
      `Source: ${record.source === 'long-stay' ? 'Long-stay form' : 'Contact form'}`,
      `Dashboard: ${dashboardUrl(env)}`,
    ].join('\n');
  }

  const booking = record;
  const reference = booking.reference || (booking.id ? `BLV-${String(booking.id).padStart(5, '0')}` : 'Unavailable');
  const nights = Number(booking.nights);
  const stay = `${day(booking.checkin)} to ${day(booking.checkout)}${
    Number.isFinite(nights) && nights > 0 ? ` (${nights} night${nights === 1 ? '' : 's'})` : ''
  }`;

  if (event === 'payment-conflict') {
    return [
      '*Belvoir · URGENT payment conflict*',
      `Reference: ${reference}`,
      `Guest: ${booking.guest_name || 'Name unavailable'}`,
      `Room: ${booking.room_name || 'Room unavailable'}`,
      `Stay: ${stay}`,
      'Payment received, but the room is no longer available for these dates.',
      'Action: Reassign the guest or arrange a refund immediately.',
      `Dashboard: ${dashboardUrl(env)}`,
    ].join('\n');
  }

  // Payments arrive through multiple channels, but api/_paid.js invokes this
  // branch only for the database caller that first marks the booking paid.
  if (event !== 'payment-received') {
    throw new Error(`Unsupported WhatsApp alert event: ${event}`);
  }

  const deposit = booking.payment_option === 'deposit';
  return [
    `*Belvoir · Payment received — booking confirmed*`,
    `Reference: ${reference}`,
    `Guest: ${booking.guest_name || 'Name unavailable'}`,
    `Room: ${booking.room_name || 'Room unavailable'}`,
    `Stay: ${stay}`,
    `Guests: ${booking.guests || 'Not specified'}`,
    `Payment type: ${deposit ? '30% deposit' : 'Paid in full'}`,
    `Payment received: ${money(booking.amount_due)}`,
    `Dashboard: ${dashboardUrl(env)}`,
  ].join('\n');
}

async function sendText(fetchImpl, token, to, body) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetchImpl(WHAPI_TEXT_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ to, body }),
      signal: controller.signal,
    });
    return { ok: Boolean(response && response.ok), status: response ? response.status : 0 };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Sends a best-effort WhatsApp alert for a new enquiry or a payment-confirmed
 * booking. The structured return value is for server logs/tests only; callers
 * must not expose it in public API responses.
 */
async function notifyAdmins(event, booking, {
  env = process.env,
  fetchImpl = globalThis.fetch,
  logger = console,
} = {}) {
  const token = String(env.WHAPI_TOKEN || '').trim();
  const groupId = adminGroupId(env.WHAPI_ADMIN_GROUP_ID);

  if (!token || !groupId || typeof fetchImpl !== 'function') {
    logger.warn('[whapi] admin alerts skipped: configure WHAPI_TOKEN and WHAPI_ADMIN_GROUP_ID.');
    return { sent: 0, failed: 0, skipped: true };
  }

  const body = buildAdminMessage(event, booking, env);
  let attempt;
  try {
    attempt = await sendText(fetchImpl, token, groupId, body);
  } catch {
    attempt = { ok: false, status: 0 };
  }

  if (!attempt.ok) {
    // Do not log group IDs, message bodies, tokens, or provider response text.
    logger.error('[whapi] admin alert delivery issue', {
      event,
      status: attempt.status,
    });
  }

  return { sent: attempt.ok ? 1 : 0, failed: attempt.ok ? 0 : 1, skipped: false };
}

module.exports = { adminGroupId, buildAdminMessage, notifyAdmins };
