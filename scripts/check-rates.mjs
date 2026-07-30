// Rates live in two places: api/_rooms.js decides what a guest is charged, and
// index.html decides what they are shown. If those drift, the site quotes one
// price and takes another.
//
//   node scripts/check-rates.mjs
//
// Exits non-zero on a mismatch, so it can gate a deploy.

import { readFileSync } from 'fs';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { ROOMS } = require('../api/_rooms.js');
const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

function fail(msg) {
  console.error('  ' + msg);
  process.exitCode = 1;
}

// ROOM_PRICES = { comfort: 70, 'ground-floor': 80, ... }
const priceBlock = html.match(/const ROOM_PRICES = \{([^}]*)\}/);
if (!priceBlock) {
  console.error('Could not find ROOM_PRICES in index.html');
  process.exit(1);
}
const shown = {};
for (const m of priceBlock[1].matchAll(/'?([a-z-]+)'?\s*:\s*(\d+)/g)) {
  shown[m[1]] = Number(m[2]);
}

console.log('Comparing server rates with the page\n');

const serverKeys = Object.keys(ROOMS);
const shownKeys = Object.keys(shown);

for (const key of serverKeys) {
  if (!(key in shown)) { fail(`${key}: on the server but missing from the page`); continue; }
  if (shown[key] !== ROOMS[key].rate) {
    fail(`${key}: page shows $${shown[key]}, server charges $${ROOMS[key].rate}`);
  }
}
for (const key of shownKeys) {
  if (!(key in ROOMS)) fail(`${key}: on the page but the server will reject it as an unknown room`);
}

// The structured data quotes prices too
const ld = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
if (ld) {
  try {
    const data = JSON.parse(ld[1]);
    for (const offer of data.makesOffer || []) {
      const match = Object.values(ROOMS).find(r => r.name === offer.name);
      if (!match) fail(`structured data offers "${offer.name}", which is not a room`);
      else if (Number(offer.price) !== match.rate) {
        fail(`structured data: "${offer.name}" at $${offer.price}, server charges $${match.rate}`);
      }
    }
  } catch {
    fail('structured data is not valid JSON');
  }
}

if (process.exitCode) {
  console.error('\nRates are out of step. Fix before deploying.');
} else {
  console.log(`  all ${serverKeys.length} rooms agree across the server, the page and the structured data`);
}
