# Flot checkout — setup and go-live

The site now takes payment in-page instead of redirecting to
`pay.flotme.ai/belvoirhotel`. This document is safe to commit: it contains no
secrets.

## Why this changed

Payments made through the old redirect never marked a booking paid. The
checkout page minted its own order ID and Flot posted its webhook to
`pay.flotme.ai/belvoirhotel/api/webhook`, not to this site, so nothing here
ever heard about the payment.

The site now mints the order ID itself as `belvoir-<bookingId>` and **polls**
Flot for the result. Polling is what makes this work regardless of where Flot
sends its webhook. The webhook receiver is still in place as a second route to
the same outcome, and both are idempotent.

## Files

```
api/_flot.js               config, RSA-PSS signing, logging, test-mode mocks
api/flot-payment-link.js   POST, creates a payment link for a booking
api/flot-status.js         GET,  polls Flot and marks the booking paid
api/payment-webhook.js     POST from Flot (unchanged, still supported)
```

The modal lives in `index.html` under "FLOT CHECKOUT", with the state machine in
the `fc*` functions.

## Test mode

**Test mode is on automatically whenever `FLOT_MERCHANT_ID` or the private key
is missing.** A missing key can never be mistaken for a live integration. In
test mode nothing is sent to Flot, the modal shows a red "Test mode" badge, and
a mock payment completes about ten seconds after the link is created.

To force it on with real credentials present, set `FLOT_TEST_MODE=true`.

## Going live

### 1. Environment variables

| Name | Value | Notes |
|---|---|---|
| `FLOT_MERCHANT_ID` | the merchant UUID | from Flot |
| `FLOT_PRIVATE_KEY` | full PEM text | **preferred on Vercel** |
| `FLOT_PRIVATE_KEY_PATH` | path to a `.pem` | local dev alternative |
| `FLOT_API_BASE` | `https://api.app.flotme.ai` | optional, this is the default |
| `FLOT_TEST_MODE` | `false` | or leave unset once credentials exist |
| `FLOT_CURRENCY_CARD` | `USD` | card is charged as quoted |
| `FLOT_CURRENCY_MOMO` | `SLE` | |
| `FLOT_CURRENCY_INAPP` | `SLE` | |
| `FLOT_LE_RATE` | `24` | USD to SLE, **update when the rate moves** |
| `FLOT_WEBHOOK_USER` / `FLOT_WEBHOOK_PASS` | already set | for the webhook receiver |

A file path will not survive a Vercel build, so put the key in
`FLOT_PRIVATE_KEY` as the full PEM including the BEGIN and END lines. Escaped
`\n` is handled.

Add them yourself so the key never passes through a chat or a commit:

```bash
vercel env add FLOT_MERCHANT_ID production
```

```bash
vercel env add FLOT_PRIVATE_KEY production
```

For local development, put the same names in `.env.local` (already gitignored).
`*.pem` is gitignored too.

### 2. The rate is a real setting

`FLOT_LE_RATE` decides what Mobile Money and Flot App guests are charged. At 24,
a $160 booking takes Le 3,840. If the true rate moves and this is not updated,
every SLE payment is wrong. Card is unaffected because it charges USD directly.

### 3. Tell Flot the webhook details

Optional but worth doing, since it gives a second path to reconciliation:

```
URL:      https://belvoir-hotel.vercel.app/api/payment-webhook
username: (FLOT_WEBHOOK_USER)
password: (FLOT_WEBHOOK_PASS)
```

Ask them to send to this URL **as well as** the existing
`pay.flotme.ai/belvoirhotel/api/webhook`, or to forward. Polling works without
this, so it is not a blocker.

## Checklist

```
[ ] private_key.pem is gitignored and NOT committed
[ ] .env.local is gitignored and NOT committed
[ ] FLOT_MERCHANT_ID set on Vercel (production, preview, development)
[ ] FLOT_PRIVATE_KEY set on Vercel as full PEM text
[ ] FLOT_LE_RATE matches today's rate
[ ] Test mode verified: all three methods render, mock payment completes
[ ] Live payment-link accepted by Flot (200, not 401/400 signature error)
[ ] Live status poll transitions the booking to paid in /admin
[ ] Webhook receipt tested, and a "failed" status leaves the booking unpaid
[ ] Logs visible in `vercel logs` with event names and no key material
[ ] QR renders and scans
[ ] USSD copy button works on a real phone
[ ] Receipt shows the amount actually charged, in the right currency
[ ] Retry after a failure reuses the same order ID
```

## Verifying the signature is accepted

The first live call is the one that proves the key is right. A signature problem
shows as a 401 or a 400 from Flot, and the response body is in the logs:

```bash
vercel logs --since 10m | grep PAYMENT_LINK_RESPONSE
```

## Logging

Every Flot event is written to stdout as one JSON line and captured by Vercel:

`PAYMENT_LINK_REQUEST` · `PAYMENT_LINK_RESPONSE` · `PAYMENT_LINK_DENIED` ·
`STATUS_REQUEST` · `STATUS_RESPONSE` · `PAYMENT_COMPLETED` · `TEST_MODE` ·
`*_ERROR`

Key material, passwords, signatures and authorization headers are redacted
before anything is written.

## Notes on behaviour

- **The amount is never taken from the browser.** It is read from the booking
  row, so a guest cannot choose what they pay.
- **A claim token is required.** The token issued when the booking was created
  must match, so one guest cannot open payment links against another's booking.
- **`failed` is not terminal.** Per Flot, a failed status is a card error. The
  booking stays open and the guest can retry, reusing the same order ID.
- **Polling stops after 10 minutes** and offers a retry.
- **Completion is idempotent**, so repeated polls and a webhook arriving for the
  same attempt cannot double-apply.
