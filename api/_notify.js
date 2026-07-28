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

async function send({ subject, html, replyTo }) {
  const key = process.env.RESEND_API_KEY;
  if (!key || !TO.length) return { skipped: true };

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: FROM,
      to: TO,
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
      { href: 'https://belvoir-hotel.vercel.app/admin', label: 'Open dashboard' },
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

async function notifyBooking(b) {
  const deposit = b.payment_option === 'deposit';
  const rows =
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
      { href: 'https://belvoir-hotel.vercel.app/admin', label: 'Open dashboard' },
    ),
  });
}

module.exports = { notifyEnquiry, notifyBooking };
