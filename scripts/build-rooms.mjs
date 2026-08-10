// Generates one crawlable landing page per room.
//
//   node scripts/build-rooms.mjs
//
// The site was three URLs, so nothing could rank for a room type or a location.
// Room detail existed only inside a JavaScript modal with no address of its own.
//
// Nothing here is authored twice: prices come from api/_rooms.js (the same table
// the server charges from) and the copy, photos and features come from ACC_TYPES
// in index.html. Re-run after changing either and the pages follow. Because the
// price has one source, a page can never quote a figure the server will not honour.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { execFileSync } from 'child_process';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { ROOMS } = require('../api/_rooms.js');
const src = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

const SITE = 'https://www.belvoir-estates.com';

/** Lift a top-level object literal out of the page rather than duplicating it. */
function grab(name) {
  const start = src.indexOf('const ' + name + ' = {');
  if (start < 0) throw new Error(`${name} not found in index.html`);
  const open = src.indexOf('{', start);
  let depth = 0, i = open;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { i++; break; } }
  }
  return eval('(' + src.slice(open, i) + ')');
}

const ACC = grab('ACC_TYPES');
const CATEGORIES = grab('CATEGORIES');

// Which category each room sits in, for the breadcrumb and the sibling links.
const categoryOf = {};
for (const [cat, v] of Object.entries(CATEGORIES)) {
  for (const r of v.rooms) categoryOf[r.key] = cat;
}
const CAT_LABEL = { rooms: 'Rooms', studio: 'Studio Flats', apartments: 'Apartments' };

const SLUG = {
  'comfort': 'superior-double-comfort',
  'standard': 'deluxe-standard',
  'superior-deluxe': 'superior-deluxe-king',
  'superior-twin': 'superior-deluxe-twin',
  'studio': 'studio-penthouse',
  'ground-floor': 'ground-floor-one-bedroom',
  'one-bed': 'one-bedroom-apartment',
  'two-bed': 'two-bedroom-apartment',
};

/** Real pixel dimensions, so the browser reserves the right box and CLS stays flat.
    Hard-coding these was wrong: the photos are a mix of portrait and landscape. */
const dimsCache = new Map();
function dims(src) {
  if (dimsCache.has(src)) return dimsCache.get(src);
  let d = { w: 1080, h: 810 };
  try {
    const out = execFileSync('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', src], { encoding: 'utf8' });
    const w = out.match(/pixelWidth:\s*(\d+)/), h = out.match(/pixelHeight:\s*(\d+)/);
    if (w && h) d = { w: Number(w[1]), h: Number(h[1]) };
  } catch {}
  dimsCache.set(src, d);
  return d;
}

const esc = (v) => String(v ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** Meta descriptions must fit; cut on a word boundary rather than mid-word. */
function clip(text, max) {
  const t = String(text).replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  return t.slice(0, t.lastIndexOf(' ', max - 1)).replace(/[,.;:]$/, '') + '…';
}

function page(key) {
  const d = ACC[key];
  const rate = ROOMS[key].rate;
  const slug = SLUG[key];
  const url = `${SITE}/rooms/${slug}`;
  const cat = categoryOf[key];
  const hero = d.images[0];

  const title = clip(`${d.title} · Belvoir Hotel Freetown`, 60);
  const desc = clip(`${d.title} in Freetown from $${rate} per night. ${d.desc}`, 155);

  const siblings = CATEGORIES[cat].rooms
    .filter((r) => r.key !== key)
    .map((r) => `        <li><a href="/rooms/${SLUG[r.key]}">${esc(ACC[r.key].title)} <span>$${ROOMS[r.key].rate}</span></a></li>`)
    .join('\n');

  // HotelRoom is far richer than a bare Offer for travel surfaces: it carries the
  // bed, the occupancy and the amenities rather than only a price.
  const bedFeature = d.features.find((f) => /bed/i.test(f)) || '';
  const ld = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'HotelRoom',
        '@id': `${url}#room`,
        name: d.title,
        description: d.desc,
        url,
        image: d.images.map((i) => `${SITE}/${i.src}`),
        amenityFeature: d.features.map((f) => ({ '@type': 'LocationFeatureSpecification', name: f, value: true })),
        ...(bedFeature ? { bed: { '@type': 'BedDetails', typeOfBed: bedFeature } } : {}),
        containedInPlace: { '@type': 'Hotel', name: 'Belvoir Hotel & Residence', '@id': `${SITE}/#hotel` },
        offers: {
          '@type': 'Offer',
          price: String(rate),
          priceCurrency: 'USD',
          availability: 'https://schema.org/InStock',
          url,
          priceSpecification: {
            '@type': 'UnitPriceSpecification',
            price: String(rate),
            priceCurrency: 'USD',
            unitCode: 'DAY',
            unitText: 'per night',
          },
        },
      },
      {
        '@type': 'BreadcrumbList',
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: 'Home', item: `${SITE}/` },
          { '@type': 'ListItem', position: 2, name: CAT_LABEL[cat], item: `${SITE}/#rooms` },
          { '@type': 'ListItem', position: 3, name: d.title, item: url },
        ],
      },
    ],
  };

  const slides = d.images.map((img, i) => {
    const { w, h } = dims(img.src);
    return `          <li class="rp__slide${i === 0 ? ' is-current' : ''}" data-i="${i}"${i === 0 ? '' : ' aria-hidden="true"'}>
            <img src="/${esc(img.src)}" alt="${esc(img.alt)}" loading="${i === 0 ? 'eager' : 'lazy'}" ${i === 0 ? 'fetchpriority="high" ' : ''}width="${w}" height="${h}">
          </li>`;
  }).join('\n');

  const thumbs = d.images.map((img, i) => {
    const { w, h } = dims(img.src);
    return `        <li><button type="button" class="rp__thumb" data-i="${i}" aria-current="${i === 0 ? 'true' : 'false'}" aria-label="Show photograph ${i + 1} of ${d.images.length}">
          <img src="/${esc(img.src)}" alt="" loading="lazy" width="${w}" height="${h}">
        </button></li>`;
  }).join('\n');

  // One photograph at a time at full width, rather than one large tile and a
  // row of small ones. Without JavaScript the first slide stays visible and the
  // thumbnails are still real links to nothing — so the page degrades to what
  // it showed before rather than to an empty box.
  const gallery = `      <div class="rp__stage" data-carousel data-interval="5000">
        <ul class="rp__slides">
${slides}
        </ul>
        <button type="button" class="rp__arrow rp__arrow--prev" aria-label="Previous photograph">&#8249;</button>
        <button type="button" class="rp__arrow rp__arrow--next" aria-label="Next photograph">&#8250;</button>
        <p class="rp__counter" aria-live="polite">1 / ${d.images.length}</p>
      </div>
      <ul class="rp__thumbs">
${thumbs}
      </ul>`;

  const features = d.features.map((f) => `          <li>${esc(f)}</li>`).join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${esc(title)}</title>
  <meta name="description" content="${esc(desc)}">
  <link rel="canonical" href="${url}">
  <meta property="og:type" content="website">
  <meta property="og:site_name" content="Belvoir Hotel &amp; Residence">
  <meta property="og:title" content="${esc(title)}">
  <meta property="og:description" content="${esc(desc)}">
  <meta property="og:url" content="${url}">
  <meta property="og:image" content="${SITE}/${esc(hero.src)}">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${esc(title)}">
  <meta name="twitter:description" content="${esc(desc)}">
  <meta name="twitter:image" content="${SITE}/${esc(hero.src)}">
  <link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='6' fill='%230C1B33'/%3E%3Ctext x='16' y='22' text-anchor='middle' font-family='Georgia,serif' font-size='18' fill='%23B08D57'%3EB%3C/text%3E%3C/svg%3E">
  <link rel="apple-touch-icon" href="/images/apple-touch-icon.png">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Cinzel:wght@400;600&family=Josefin+Sans:wght@300;400;500;600&family=Cormorant+Garamond:ital,wght@1,400&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="/rooms.css">
  <script type="application/ld+json">
${JSON.stringify(ld, null, 2)}
  </script>
</head>
<body>
  <a href="#main" class="skip-link">Skip to content</a>

  <nav class="rp__nav">
    <div class="rp__nav-inner">
      <a href="/" class="rp__logo">Belvoir<span>.</span></a>
      <div class="rp__nav-links">
        <a href="/#rooms">All rooms</a>
        <a href="/#contact">Contact</a>
        <a href="/#rooms" class="rp__nav-cta">Book now</a>
      </div>
    </div>
  </nav>

  <main id="main">
    <nav class="rp__crumbs" aria-label="Breadcrumb">
      <ol>
        <li><a href="/">Home</a></li>
        <li><a href="/#rooms">${esc(CAT_LABEL[cat])}</a></li>
        <li aria-current="page">${esc(d.title)}</li>
      </ol>
    </nav>

    <header class="rp__head">
      <h1>${esc(d.title)}</h1>
      <p class="rp__price"><strong>$${rate}</strong> <span>per night</span></p>
      <p class="rp__lede">${esc(d.desc)}</p>
      <div class="rp__badges">
        <span>${d.breakfast === true ? 'Breakfast included' : 'Self-catering'}</span>
        <span>Check-in 2:00 PM</span>
        <span>Check-out 11:00 AM</span>
      </div>
      <a href="/#rooms" class="rp__book">Check availability</a>
    </header>

    <section class="rp__gallery" aria-roledescription="carousel" aria-label="Photographs of the ${esc(d.title)}">
${gallery}
    </section>

    <section class="rp__detail">
      <div>
        <h2>What this ${cat === 'rooms' ? 'room' : 'apartment'} includes</h2>
        <ul class="rp__features">
${features}
        </ul>
${d.note ? `        <p class="rp__note">${esc(d.note)}</p>\n` : ''}      </div>

      <aside class="rp__aside">
        <h2>Good to know</h2>
        <dl>
          <dt>Rate</dt><dd>$${rate} per night, quoted in US dollars</dd>
          <dt>Breakfast</dt><dd>${d.breakfast === true ? 'Included each morning' : 'Available on request'}</dd>
          <dt>Arrival</dt><dd>From 2:00 PM · front desk staffed 24 hours</dd>
          <dt>Departure</dt><dd>By 11:00 AM</dd>
          <dt>Where</dt><dd>Belvoir Avenue, 86 Wilkinson Road, Freetown</dd>
        </dl>
        <p class="rp__aside-cta">
          Book direct and avoid third-party commission.<br>
          <a href="/#rooms">Check availability</a> or call
          <a href="tel:+23277777063">+232 77 777 063</a>.
        </p>
      </aside>
    </section>

${siblings ? `    <section class="rp__siblings">
      <h2>Other ${esc(CAT_LABEL[cat].toLowerCase())}</h2>
      <ul>
${siblings}
      </ul>
    </section>
` : ''}
    <section class="rp__foot-cta">
      <h2>Stay at Belvoir</h2>
      <p>Air-conditioned en-suite rooms, studio flats and serviced apartments on one of
         Freetown's most sought-after addresses, minutes from Lumley and Aberdeen beaches.</p>
      <a href="/#rooms" class="rp__book">Check availability</a>
    </section>
  </main>

  <footer class="rp__footer">
    <p><strong>Belvoir Hotel &amp; Residence</strong><br>
       Belvoir Avenue, 86 Wilkinson Road, Freetown, Sierra Leone</p>
    <p><a href="tel:+23277777063">+232 77 777 063</a> ·
       <a href="mailto:info@belvoir-estates.com">info@belvoir-estates.com</a></p>
    <p><a href="/">Home</a> · <a href="/terms">Booking terms</a> · <a href="/privacy">Privacy</a></p>
  </footer>

  <script src="/rooms.js" defer></script>
</body>
</html>
`;
}

if (!existsSync('rooms')) mkdirSync('rooms');

const built = [];
for (const key of Object.keys(ACC)) {
  const slug = SLUG[key];
  if (!slug) throw new Error(`no slug defined for room "${key}"`);
  if (!ROOMS[key]) throw new Error(`"${key}" is in ACC_TYPES but not in api/_rooms.js`);
  writeFileSync(`rooms/${slug}.html`, page(key));
  built.push({ key, slug, rate: ROOMS[key].rate, title: ACC[key].title });
  console.log(`  rooms/${slug}.html`.padEnd(46) + `$${ROOMS[key].rate}`);
}

// Sitemap covers the homepage, the legal pages and every room.
const today = new Date().toISOString().slice(0, 10);
const urls = [
  { loc: `${SITE}/`, pri: '1.0', freq: 'weekly' },
  ...built.map((b) => ({ loc: `${SITE}/rooms/${b.slug}`, pri: '0.8', freq: 'monthly' })),
  { loc: `${SITE}/terms`, pri: '0.3', freq: 'yearly' },
  { loc: `${SITE}/privacy`, pri: '0.3', freq: 'yearly' },
];
writeFileSync('sitemap.xml',
  '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
  urls.map((u) => `  <url>\n    <loc>${u.loc}</loc>\n    <lastmod>${today}</lastmod>\n    <changefreq>${u.freq}</changefreq>\n    <priority>${u.pri}</priority>\n  </url>`).join('\n') +
  '\n</urlset>\n');

console.log(`\n  ${built.length} room pages built`);
console.log(`  sitemap.xml rewritten with ${urls.length} URLs`);
