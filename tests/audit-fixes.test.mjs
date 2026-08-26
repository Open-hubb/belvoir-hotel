import assert from 'node:assert/strict';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import test, { after, before } from 'node:test';
import puppeteer from 'puppeteer';

const port = 4568;
const baseUrl = `http://localhost:${port}`;
let server;
let browser;
let page;

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function openHome() {
  await page.setViewport({ width: 375, height: 812 });
  await page.goto(`${baseUrl}/`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.waitForFunction(
    () => getComputedStyle(document.querySelector('#preloader')).display === 'none',
    { timeout: 8_000 },
  );
}

async function openBookingDates() {
  await openHome();
  await page.click('.cat-card--rooms');
  await page.waitForSelector('#catOverlay.active');
  await page.click('.cat-room__book');
  await page.waitForSelector('#bookWizard.active');
}

before(async () => {
  server = spawn('node', ['serve.mjs'], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(port) },
    stdio: 'ignore',
  });
  await once(server, 'spawn');

  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/`);
      if (response.ok) break;
    } catch {
      await wait(100);
    }
  }

  browser = await puppeteer.launch({ headless: true });
  page = await browser.newPage();
});

after(async () => {
  await browser?.close();
  server?.kill();
});

test('first visit exposes the booking page within 1.8 seconds', { concurrency: false }, async () => {
  await page.setViewport({ width: 375, height: 812 });
  await page.goto(`${baseUrl}/`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await wait(1_800);

  const state = await page.evaluate(() => {
    const splash = document.querySelector('#preloader');
    const reserve = document.querySelector('.hbook__submit');
    const reserveRect = reserve.getBoundingClientRect();
    return {
      splashVisible: getComputedStyle(splash).display !== 'none',
      reserveVisible:
        reserveRect.top >= 0 &&
        reserveRect.bottom <= window.innerHeight &&
        Number(getComputedStyle(reserve).opacity) > 0.9,
    };
  });

  assert.equal(state.splashVisible, false);
  assert.equal(state.reserveVisible, true);
});

test('mobile menu retains keyboard focus and closes with Escape', { concurrency: false }, async () => {
  await openHome();
  await page.click('#navToggle');

  for (let step = 0; step < 8; step += 1) await page.keyboard.press('Tab');
  const focusIsInMenu = await page.evaluate(
    () => Boolean(document.activeElement.closest('#mobileMenu')),
  );
  assert.equal(focusIsInMenu, true);

  await page.keyboard.press('Escape');
  const expanded = await page.$eval('#navToggle', (node) => node.getAttribute('aria-expanded'));
  assert.equal(expanded, 'false');
});

test('room category dialog does not leak focus to the background', { concurrency: false }, async () => {
  await openHome();
  await page.click('.cat-card--rooms');
  await page.waitForSelector('#catOverlay.active');
  await page.keyboard.down('Shift');
  await page.keyboard.press('Tab');
  await page.keyboard.up('Shift');

  const focusIsInDialog = await page.evaluate(
    () => Boolean(document.activeElement.closest('#catOverlay')),
  );
  assert.equal(focusIsInDialog, true);
});

test('booking dialog does not leak focus to the background', { concurrency: false }, async () => {
  await openBookingDates();
  await page.keyboard.down('Shift');
  await page.keyboard.press('Tab');
  await page.keyboard.up('Shift');

  const focusIsInDialog = await page.evaluate(
    () => Boolean(document.activeElement.closest('#bookWizard')),
  );
  assert.equal(focusIsInDialog, true);
});

test('missing dates focus the invalid field and keep the error visible', { concurrency: false }, async () => {
  await openBookingDates();
  await page.click('#bwNextBtn');

  const state = await page.evaluate(() => {
    const error = document.querySelector('#bwError');
    const panel = document.querySelector('.bw__panel');
    const errorRect = error.getBoundingClientRect();
    const panelRect = panel.getBoundingClientRect();
    return {
      errorVisible: error.classList.contains('visible'),
      errorIsWithinPanel: errorRect.top >= panelRect.top && errorRect.bottom <= panelRect.bottom,
      activeElement: document.activeElement.id,
    };
  });

  assert.equal(state.errorVisible, true);
  assert.equal(state.errorIsWithinPanel, true);
  assert.equal(state.activeElement, 'bwCheckin');
});

test('AI-facing rate summary matches the bookable room rates', { concurrency: false }, async () => {
  const response = await fetch(`${baseUrl}/llms.txt`);
  const text = await response.text();

  assert.match(
    text,
    /Rates: rooms from \$60\/night, studio flats from \$100, apartments from \$100 to \$150/,
  );
});

test('room detail pages expose the requested amenities', { concurrency: false }, async () => {
  const entries = await Promise.all(
    [
      ['superior-double-comfort', 'Mini fridge'],
      ['superior-deluxe-king', 'Mini fridge'],
      ['two-bedroom-apartment', 'Sea view'],
      ['two-bedroom-apartment', 'Private balcony'],
      ['studio-penthouse', 'Walk-in closet'],
      ['one-bedroom-apartment', 'Sea view'],
      ['one-bedroom-apartment', 'Private balcony'],
    ].map(async ([slug, amenity]) => {
      const response = await fetch(`${baseUrl}/rooms/${slug}`);
      assert.equal(response.ok, true, `${slug} should be available`);
      return { slug, amenity, body: await response.text() };
    }),
  );

  for (const { slug, amenity, body } of entries) {
    assert.match(body, new RegExp(`<li>${amenity}</li>`), `${slug} should list ${amenity}`);
  }
});

test('room detail page has an accessible back control with a room-list fallback', { concurrency: false }, async () => {
  await page.setViewport({ width: 1440, height: 900 });
  await page.goto(`${baseUrl}/rooms/superior-double-comfort`, {
    waitUntil: 'domcontentloaded',
    referer: `${baseUrl}/`,
  });

  const back = await page.$('[data-room-back]');
  assert.ok(back, 'room pages should provide a visible back control');
  assert.equal(
    await back.evaluate((node) => node.getAttribute('href')),
    '/#rooms',
    'direct visits should have a safe rooms-list destination',
  );
  assert.equal(
    await back.evaluate((node) => node.getAttribute('aria-label')),
    'Back to the previous page',
  );

  const navigation = page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 10_000 });
  await back.click();
  await navigation;
  assert.equal(new URL(page.url()).pathname, '/');
});
