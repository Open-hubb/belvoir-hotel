# WhatsApp admin alerts (Whapi)

The website can alert the hotel team on WhatsApp for these two events only:

- A payment is confirmed by the existing Flot payment flow.
- A non-spam website enquiry is saved.

There is no WhatsApp alert when a guest merely reaches checkout: a room is only actionable once partial or full payment is confirmed. Payment alerts contain the guest name, booking reference, room type, check-in and check-out dates, payment type, amount, guest count, and the `/admin` dashboard link. Enquiry alerts contain the guest name, enquiry identifier and form type, then direct staff to the dashboard. Alerts exclude guest email, phone number, enquiry text, special requests, and payment-provider identifiers.

## Configure in Vercel

Create a private WhatsApp group for authorised hotel staff (for example, **Belvoir Admin Alerts**) and add the WhatsApp number paired to your Whapi channel. Copy that group's Whapi chat ID, which ends in `@g.us`; it is not a phone number.

Add these **server-side** environment variables to the Production environment (and Preview too, if you want alerts from preview deployments):

```text
WHAPI_TOKEN=your_whapi_channel_token
WHAPI_ADMIN_GROUP_ID=120363012345678901@g.us
PUBLIC_ORIGIN=https://www.belvoir-estates.com
```

`WHAPI_ADMIN_GROUP_ID` must be the full group chat ID from Whapi, ending in `@g.us`. Do not enter individual phone numbers in this variable. Keep the group private and limit its members to staff who should receive booking information.

The token must only be stored in Vercel/server environment variables. Do not add it to `index.html`, JavaScript sent to visitors, source control, or a WhatsApp message.

## Verify safely

After deployment, submit a genuine website enquiry, then complete one real booking payment. The private admin group should receive one alert for the enquiry and one for the confirmed payment. Repeated payment callbacks do not re-send the paid alert because the booking is marked paid only once in the database.

If either variable is missing, booking and payment processing continue normally and WhatsApp delivery is skipped.
