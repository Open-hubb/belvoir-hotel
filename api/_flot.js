// Shared Flot helpers: config, RSA-PSS signing, logging and test-mode mocks.
// Used by flot-payment-link.js and flot-status.js.
//
// The private key never leaves the server and is never logged. On Vercel it is
// supplied inline as FLOT_PRIVATE_KEY (a file path would not survive a build);
// FLOT_PRIVATE_KEY_PATH is the local-dev fallback.

const crypto = require('crypto');
const fs = require('fs');

const API_BASE = process.env.FLOT_API_BASE || 'https://api.app.flotme.ai';
const MERCHANT_ID = process.env.FLOT_MERCHANT_ID || '';

// Test mode is the default whenever real credentials are absent, so a missing
// key can never be mistaken for a live integration.
const TEST_MODE =
  String(process.env.FLOT_TEST_MODE || '').toLowerCase() === 'true' ||
  !MERCHANT_ID ||
  !hasKey();

// Card settles in USD so the room rate is charged as quoted. Mobile Money and
// the Flot app settle in SLE, converted at FLOT_LE_RATE.
const CURRENCY = {
  card: process.env.FLOT_CURRENCY_CARD || 'USD',
  momo: process.env.FLOT_CURRENCY_MOMO || 'SLE',
  'in-app': process.env.FLOT_CURRENCY_INAPP || 'SLE',
};

const LE_RATE = Number(process.env.FLOT_LE_RATE || 24);

const TYPES = ['card', 'momo', 'in-app'];

function hasKey() {
  if (process.env.FLOT_PRIVATE_KEY) return true;
  const p = process.env.FLOT_PRIVATE_KEY_PATH;
  try {
    return !!p && fs.existsSync(p);
  } catch {
    return false;
  }
}

/**
 * PEM text survives a round trip through Vercel in several shapes: real
 * newlines, escaped "\n", and, when the source file had Windows line endings,
 * a literal "\r" left sitting inside the base64. Any of those break the
 * decoder, so every form is normalised back to plain LF here.
 */
function normalisePem(text) {
  return String(text || '')
    .replace(/\\r\\n/g, '\n')
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '')
    .replace(/\r/g, '')
    .trim();
}

function privateKey() {
  if (process.env.FLOT_PRIVATE_KEY) {
    return normalisePem(process.env.FLOT_PRIVATE_KEY);
  }
  return normalisePem(fs.readFileSync(process.env.FLOT_PRIVATE_KEY_PATH, 'utf8'));
}

function sign(input) {
  const signer = crypto.createSign('RSA-SHA512');
  signer.update(input);
  return signer.sign(
    {
      key: privateKey(),
      padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
      saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
    },
    'base64'
  );
}

/** Sign the exact JSON string that will be sent as the body. */
function signBody(bodyString) {
  return sign(bodyString);
}

/** Sign the canonical "METHOD\nPATH" string used for bodyless requests. */
function signCanonical(method, path) {
  return sign(`${method}\n${path}`);
}

const REDACT = /(-----BEGIN[\s\S]*?-----END[^-]*-----|"?(?:privateKey|password|pass|authorization|signature)"?\s*[:=]\s*"?[^",}\s]+)/gi;

function redact(value) {
  try {
    return JSON.parse(JSON.stringify(value), (k, v) => {
      if (/privatekey|password|signature|authorization/i.test(k)) return '[redacted]';
      return typeof v === 'string' ? v.replace(REDACT, '[redacted]') : v;
    });
  } catch {
    return '[unserialisable]';
  }
}

/**
 * Structured stdout logging. Vercel captures stdout per invocation, so this is
 * the log destination for every Flot event.
 */
function log(event, data) {
  const entry = {
    ts: new Date().toISOString(),
    source: 'flot',
    event,
    testMode: TEST_MODE,
    ...redact(data || {}),
  };
  console.log(JSON.stringify(entry));
}

/** Amount to charge for a booking in the currency the chosen method settles in. */
function amountFor(usd, type) {
  const currency = CURRENCY[type] || 'SLE';
  const value = currency === 'SLE' ? Number(usd) * LE_RATE : Number(usd);
  return { amount: value.toFixed(2), currency };
}

/** Order id the webhook and the dashboard both reconcile against. */
function orderIdFor(bookingId) {
  return `belvoir-${bookingId}`;
}

// ─── Test mode ───────────────────────────────────────────────────────────────
// Mocks match the real response shape so the whole flow is exercisable without
// credentials. A mock attempt reports "created" on the first two polls and
// "completed" after that, so the polling UI can be verified end to end.

const mockCreatedAt = new Map();

function mockPaymentLink(type, orderId) {
  const id = `test_${orderId}_${type}`;
  mockCreatedAt.set(id, Date.now());
  return {
    id,
    link: type === 'momo' ? null : `https://pay.flotme.ai/test/${encodeURIComponent(id)}`,
    code: type === 'momo' ? '*175*0000000#' : null,
  };
}

function mockStatus(orderId, attemptId) {
  const started = mockCreatedAt.get(attemptId);
  if (!started) mockCreatedAt.set(attemptId, Date.now());
  const elapsed = Date.now() - (started || Date.now());
  return {
    id: attemptId,
    externalId: orderId,
    amount: '0.00',
    currency: 'SLE',
    status: elapsed > 9000 ? 'completed' : 'created',
    createdAt: new Date(started || Date.now()).toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

module.exports = {
  API_BASE,
  MERCHANT_ID,
  TEST_MODE,
  CURRENCY,
  LE_RATE,
  TYPES,
  signBody,
  signCanonical,
  log,
  amountFor,
  orderIdFor,
  mockPaymentLink,
  mockStatus,
};
