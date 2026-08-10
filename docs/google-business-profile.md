# Google Business Profile — setup pack

Everything needed to create the listing, with values taken from the live site so
the two match. Google cross-references the profile against the website; where
they disagree, it trusts neither.

## How this relates to Search Console

They are different things and neither replaces the other.

| | Search Console | Business Profile |
|---|---|---|
| What it is | A diagnostic tool for a website | A listing — the business itself in Google's index |
| You give it | A verified domain | A verified physical location |
| It controls | Nothing; it reports | What shows in Maps, the local pack, and the hotel panel |
| Surface | Organic blue links | Google Maps, "hotels near me", the right-hand panel |
| Ranking inputs | Content, links, technical health | Proximity, relevance, prominence, reviews |

Search Console tells you how the site is doing. It does not affect rank. The
Business Profile is the opposite: it is not a reporting tool, it is a live
entity that decides whether the hotel appears in Maps at all.

They meet in one place — consistency. The name, address and phone on the site
must match the profile exactly, the profile links to the site, and the
structured data already on the site helps Google tie them to one business. That
work is done: the address, coordinates and `Hotel` schema are in place.

Verify the site in Search Console too, but as a separate task. Neither
unlocks the other.

## Before creating anything: check whether it already exists

The property is listed on Booking.com twice and on Hotels.com. Google routinely
creates unverified hotel entities from those feeds, so a listing very likely
already exists. Creating a second one produces a duplicate, and duplicates are
harder to resolve than an unclaimed listing is to claim.

1. Search Google Maps for `Belvoir Hotel Freetown` and for `86 Wilkinson Road Freetown`.
2. If a listing appears, use **Claim this business** — do not create a new one.
3. Only create from scratch if nothing is there.

While checking, note any duplicates. Two Booking.com listings under different
names suggests the property may already be split across more than one entity:

- "Belvoir Hotel & Furnished Residence"
- "Belvoir Estate and Serviced Apart-Hotel & Residence"

If both exist in Maps, claim the stronger one and request a merge for the other.

## Field values

Take these verbatim so the profile and the site agree.

| Field | Value |
|---|---|
| Business name | *decide — see Open questions* |
| Primary category | Hotel |
| Additional categories | Serviced accommodation; Extended stay hotel; Apartment complex |
| Street address | Belvoir Avenue, 86 Wilkinson Road |
| City | Freetown |
| Country | Sierra Leone |
| Map pin | 8.476571, -13.27347 |
| Primary phone | +232 77 777 063 |
| Additional phone | +232 76 122 000 |
| Website | https://www.belvoir-estates.com/ |
| Hours | Open 24 hours, 7 days (24-hour front desk) |
| Check-in / check-out | 14:00 / 11:00 |
| Price range | $70–$170 per night |
| Rooms | 8 |

### Description

Google allows 750 characters. This is impartial, avoids the promotional
phrasing Google rejects, and stays consistent with the site:

> Belvoir Hotel & Residence offers fully furnished hotel rooms, studio flats and
> one- and two-bedroom serviced apartments on Belvoir Avenue, off Wilkinson
> Road in Freetown. Every unit is air-conditioned and en-suite, with free WiFi,
> a private balcony and individual metering. Apartments include full kitchens.
> Rooms include breakfast; studios and apartments can arrange it on request.
> The front desk is staffed 24 hours and private parking is on site. Lumley and
> Aberdeen beaches are about seven minutes away, the Lungi Airport water taxi
> five minutes, and the city centre fifteen. Gyms, restaurants, supermarkets and
> sports clubs are within walking distance. Nightly, monthly and annual rates
> are available.

### Amenities to tick

Confirmed by the site: free WiFi, free parking, air conditioning, restaurant,
24-hour front desk, laundry service, balcony, kitchen (apartments), en-suite
bathrooms, family rooms.

Do **not** tick until confirmed: airport shuttle (on request only — see below),
mini mart (see below), conference room (not built yet).

Never tick an amenity that is not currently available. It is the most common
cause of one-star reviews for hotels and it puts the listing at risk.

### Photos

Google weighs photo count and recency. Upload at minimum:

- Exterior showing the building and signage — used to confirm the location
- Reception / lobby
- One photo per room type (eight types)
- Bathroom, balcony view, kitchen
- Logo (square) and a cover photo (landscape)

Source folders: `images/sorted images/`, `images/2 bedroom/`.
Note: the penthouse currently has only one usable photo, and there are no
usable two-bedroom bedroom shots.

## Verification

New hotel listings in most regions now require **video verification**, not a
postcard. Record one continuous take, under two minutes, no cuts:

1. Start at the street showing the road and any signage
2. Walk to and through the main entrance
3. Show the reception desk
4. Show something only a manager could — back office, booking system, keys
5. Show one guest area (a room corridor or the restaurant)

Do it in daylight, and do not stop recording between steps. A cut is the usual
reason a first attempt fails. Rejections can be appealed, but each round costs
days.

## After it is live

1. Set the booking link to belvoir-estates.com so direct bookings are not lost
   to the OTA links Google shows by default.
2. Ask recent guests for reviews. Review count and recency are among the
   strongest local ranking factors, and the current Booking.com average of 6.1
   is the main reputational gap.
3. Reply to every review, including negative ones. Replies are public and
   visible to anyone comparing hotels.
4. Keep hours accurate around holidays.

## Open questions

Two things need a decision before entering data, because both are awkward to
change afterwards — a name change on a hotel profile can trigger re-verification.

1. **The official business name.** The site uses two: "Belvoir Hotel &
   Residence" (title, most copy) and "Belvoir Hotel & Furnished Apartment
   Residence" (structured data). Booking.com uses two more. The profile must
   use the real-world name as it appears on the building signage; anything
   longer reads as keyword stuffing and can get the listing suspended. Once
   decided, the site should be made consistent with it.

2. **The mini mart.** The site still shows a Mini Mart amenity card and lists
   "On-site mini mart" in the structured data, and there is a banner section
   with photos. But removal was requested earlier. If it exists, keep it and it
   can go on the profile; if not, the card, the schema entry and the banner all
   need removing.
