/**
 * Email notifications via Resend.
 *
 * Fully optional: if RESEND_API_KEY is not set the helpers no-op, so bookings
 * and enquiries always save to the database regardless of email being wired up.
 */

const TO = (process.env.NOTIFY_EMAIL || 'info@belvoir-estates.com')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

// Until a domain is verified in Resend, their shared sender is the only one allowed.
const FROM = process.env.NOTIFY_FROM || 'Belvoir Website <onboarding@resend.dev>';

const NAVY = '#0C1B33';
const GOLD = '#B08D57';
const CREAM = '#F8F4EC';

function esc(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function row(label, value) {
  if (!value) return '';
  return `<tr>
    <td style="padding:8px 16px 8px 0;color:#6B7280;font:500 11px/1.4 Helvetica,Arial,sans-serif;letter-spacing:1.6px;text-transform:uppercase;white-space:nowrap;vertical-align:top">${esc(label)}</td>
    <td style="padding:8px 0;color:${NAVY};font:400 15px/1.5 Helvetica,Arial,sans-serif">${esc(value)}</td>
  </tr>`;
}

function shell(kicker, heading, rowsHtml, note, cta) {
  return `<body style="margin:0;background:${CREAM};padding:32px 16px">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;margin:0 auto;background:#FFFDF8;border-radius:16px;overflow:hidden;box-shadow:0 2px 8px rgba(12,27,51,.06)">
    <tr><td style="background:${NAVY};padding:22px 28px">
      <div style="color:${GOLD};font:500 10px/1 Helvetica,Arial,sans-serif;letter-spacing:3px;text-transform:uppercase">${esc(kicker)}</div>
      <div style="color:#fff;font:400 22px/1.3 Georgia,serif;margin-top:6px">${esc(heading)}</div>
    </td></tr>
    <tr><td style="padding:24px 28px">
      <table role="presentation" cellpadding="0" cellspacing="0" width="100%">${rowsHtml}</table>
      ${note ? `<div style="margin-top:18px;padding:14px 16px;background:${CREAM};border-radius:10px;color:${NAVY};font:400 14px/1.6 Helvetica,Arial,sans-serif;white-space:pre-wrap">${esc(note)}</div>` : ''}
      ${cta ? `<div style="margin-top:22px"><a href="${esc(cta.href)}" style="display:inline-block;background:${NAVY};color:#FFFDF8;text-decoration:none;border-radius:999px;padding:12px 26px;font:500 11px/1 Helvetica,Arial,sans-serif;letter-spacing:2px;text-transform:uppercase">${esc(cta.label)}</a></div>` : ''}
    </td></tr>
    <tr><td style="padding:0 28px 24px;color:#9AA0A6;font:400 12px/1.5 Helvetica,Arial,sans-serif">
      Sent automatically by the Belvoir website.
    </td></tr>
  </table>
</body>`;
}

async function send({ subject, html, replyTo, to, idempotencyKey }) {
  const key = process.env.RESEND_API_KEY;
  const recipients = to ? [].concat(to).filter(Boolean) : TO;
  if (!key || !recipients.length) return { skipped: true };

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      ...(idempotencyKey ? { 'Idempotency-Key': String(idempotencyKey).slice(0, 256) } : {}),
    },
    body: JSON.stringify({
      from: FROM,
      to: recipients,
      subject,
      html,
      ...(replyTo ? { reply_to: replyTo } : {}),
    }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Resend ${res.status}: ${detail.slice(0, 300)}`);
  }
  return res.json();
}

const STAY = {
  short: 'Short stay (1–7 nights)',
  extended: 'Extended stay (1–3 months)',
  long: 'Long term (yearly)',
  business: 'Business / corporate',
};

async function notifyEnquiry(e) {
  const isLong = e.stay_type === 'long' || e.source === 'long-stay';
  const rows =
    row('Name', e.name) +
    row('Email', e.email) +
    row('Phone', e.phone) +
    row('Interest', STAY[e.stay_type] || 'General enquiry') +
    row('Came from', e.source === 'long-stay' ? 'Long stay banner' : 'Contact form');

  return send({
    subject: `${isLong ? 'Long stay enquiry' : 'New enquiry'} from ${e.name}`,
    replyTo: e.email,
    html: shell(
      'New enquiry',
      isLong ? 'Long stay enquiry' : 'Website enquiry',
      rows,
      e.message,
      { href: 'https://www.belvoir-estates.com/admin', label: 'Open dashboard' },
    ),
  });
}

const money = (n) => '$' + Number(n || 0).toLocaleString();
const day = (d) => {
  try {
    return new Date(d).toLocaleDateString('en-GB', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    });
  } catch {
    return String(d);
  }
};

/**
 * The guest's confirmation, sent only once their money has actually arrived.
 *
 * This is deliberately the one and only email a guest ever receives, so its
 * presence in their inbox means the payment succeeded. It must therefore never
 * be sent from the booking flow, only from a path that has seen Flot report the
 * payment completed. See api/_paid.js, which is the single caller.
 */
async function confirmBooking(b, { idempotencyKey } = {}) {
  if (!b.guest_email) return { skipped: true };
  const deposit = b.payment_option === 'deposit';
  const balance = Number(b.total) - Number(b.amount_due);

  const rows =
    row('Reference', b.reference) +
    row('Room', b.room_name) +
    row('Check-in', `${day(b.checkin)} from 2:00 PM`) +
    row('Check-out', `${day(b.checkout)} by 11:00 AM`) +
    row('Nights', b.nights) +
    row('Guests', b.guests) +
    row('Payment received', `${money(b.amount_due)}${deposit ? ' (30% deposit)' : ' (paid in full)'}`) +
    (deposit && balance > 0 ? row('Due at check-in', money(balance)) : '') +
    row('Stay total', money(b.total));

  return send({
    idempotencyKey,
    to: b.guest_email,
    subject: `Payment received · your Belvoir booking is confirmed ${b.reference || ''}`.trim(),
    replyTo: TO[0],
    html: shell(
      'Payment received',
      `We look forward to welcoming you`,
      rows,
      (b.requests ? `Your requests: ${b.requests}\n\n` : '') +
        'This email is your receipt. Your room is now held for the dates above. ' +
        'Belvoir Avenue, 86 Wilkinson Road, Freetown. The front desk is staffed 24 hours, ' +
        'so a late arrival is no problem, just let us know. ' +
        'To change or cancel, reply to this email or call +232 77 777 063 quoting your reference. ' +
        'Cancel more than 48 hours before check-in for a full refund of anything paid in full; ' +
        'deposits are non-refundable.',
      { href: 'https://www.belvoir-estates.com/terms', label: 'Booking terms' },
    ),
  });
}

/** Tells the hotel the money landed, as distinct from a booking being started. */
async function notifyPaid(b, { idempotencyKey } = {}) {
  const deposit = b.payment_option === 'deposit';
  const rows =
    row('Reference', b.reference) +
    row('Guest', b.guest_name) +
    row('Email', b.guest_email) +
    row('Phone', b.guest_phone) +
    row('Room', b.room_name) +
    row('Check-in', day(b.checkin)) +
    row('Check-out', day(b.checkout)) +
    row('Nights', b.nights) +
    row('Guests', b.guests) +
    row('Paid', `${money(b.amount_due)}${deposit ? ' (30% deposit)' : ' (in full)'}`) +
    (deposit ? row('Due at check-in', money(Number(b.total) - Number(b.amount_due))) : '') +
    row('Stay total', money(b.total)) +
    row('Confirmed via', b.paid_source || 'Flot');

  return send({
    idempotencyKey,
    subject: `PAID: ${b.room_name} for ${b.guest_name} · ${b.reference || ''}`.trim(),
    replyTo: b.guest_email,
    html: shell(
      'Payment received',
      `${b.room_name}`,
      rows,
      b.requests ? `Special requests: ${b.requests}` : '',
      { href: 'https://www.belvoir-estates.com/admin', label: 'Open dashboard' },
    ),
  });
}

async function notifyBooking(b) {
  const deposit = b.payment_option === 'deposit';
  const rows =
    row('Reference', b.reference) +
    row('Guest', b.guest_name) +
    row('Email', b.guest_email) +
    row('Phone', b.guest_phone) +
    row('Room', b.room_name) +
    row('Check-in', day(b.checkin)) +
    row('Check-out', day(b.checkout)) +
    row('Nights', b.nights) +
    row('Guests', b.guests) +
    row('Paying now', `${money(b.amount_due)}${deposit ? ' (30% deposit)' : ' (in full)'}`) +
    row('Stay total', money(b.total)) +
    (deposit ? row('Due at check-in', money(Number(b.total) - Number(b.amount_due))) : '');

  return send({
    subject: `New booking: ${b.room_name} for ${b.guest_name}`,
    replyTo: b.guest_email,
    html: shell(
      'New booking',
      `${b.room_name}`,
      rows,
      b.requests ? `Special requests: ${b.requests}` : '',
      { href: 'https://www.belvoir-estates.com/admin', label: 'Open dashboard' },
    ),
  });
}

/**
 * Content for a reset or invitation email. Kept separate from delivery so it
 * can be checked without credentials and so no raw access token is logged.
 */
function buildAdminAccessEmail({ kind, name, url }) {
  const invite = kind === 'invite';
  const action = invite ? 'Set your password' : 'Reset password';
  const note = invite
    ? 'An owner has invited you to the Belvoir bookings dashboard. Set your own password to activate access.'
    : 'Use the secure link below to choose a new password for your Belvoir bookings dashboard account.';

  return {
    subject: invite
      ? 'You’re invited to Belvoir Bookings Admin'
      : 'Reset your Belvoir Bookings Admin password',
    html: shell(
      invite ? 'Dashboard invitation' : 'Password reset',
      invite ? 'You have been invited' : 'Reset your password',
      row(invite ? 'Invited administrator' : 'Account', name),
      note + '\n\nThis link expires in 30 minutes and can be used only once. If you did not expect this email, you can safely ignore it.',
      { href: url, label: action },
    ),
  };
}

async function sendAdminAccessEmail({ to, name, kind, url }) {
  return send({ to, ...buildAdminAccessEmail({ kind, name, url }) });
}

module.exports = {
  notifyEnquiry,
  notifyBooking,
  notifyPaid,
  confirmBooking,
  buildAdminAccessEmail,
  sendAdminAccessEmail,
};
