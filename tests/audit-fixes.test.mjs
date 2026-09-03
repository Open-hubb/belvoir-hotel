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

test('admin block form labels, clamps, and submits room quantities', { concurrency: false }, async () => {
  await page.setViewport({ width: 768, height: 900 });
  await page.goto(`${baseUrl}/admin`, { waitUntil: 'domcontentloaded', timeout: 30_000 });

  const state = await page.evaluate(async () => {
    BLOCKS = [{
      id: 70,
      room_key: 'superior-deluxe',
      room_name: 'Superior Deluxe King',
      starts: '2027-11-10',
      ends: '2027-11-12',
      units: 2,
      capacity: 3,
      reason: 'Deep clean',
      created_at: '2027-10-01T10:00:00.000Z',
    }];
    VIEW = 'blocks';
    renderBlocks();

    const room = document.getElementById('blkRoom');
    const units = document.getElementById('blkUnits');
    const label = document.querySelector('label[for="blkUnits"]');
    const initial = {
      label: label && label.textContent.trim(),
      min: units && units.min,
      step: units && units.step,
      max: units && units.max,
      listText: document.getElementById('list').textContent,
    };

    units.value = '99';
    room.value = 'superior-deluxe';
    room.dispatchEvent(new Event('change', { bubbles: true }));
    const clamped = { max: units.max, value: units.value };

    document.getElementById('blkFrom').value = '2027-12-01';
    document.getElementById('blkTo').value = '2027-12-03';
    units.value = '2';
    let submitted = null;
    api = async (method, body, path) => {
      if (method === 'POST' && path === '/api/blocks') submitted = body;
      if (method === 'GET' && path === '/api/blocks') return { blocks: [] };
      return { ok: true };
    };
    await addBlock();

    return {
      initial,
      clamped,
      submittedUnits: submitted && submitted.units,
      submittedType: submitted && typeof submitted.units,
    };
  });

  assert.equal(state.initial.label, 'Rooms out of service');
  assert.equal(state.initial.min, '1');
  assert.equal(state.initial.step, '1');
  assert.equal(state.initial.max, '1');
  assert.match(state.initial.listText, /2 of 3 rooms blocked/);
  assert.deepEqual(state.clamped, { max: '3', value: '3' });
  assert.equal(state.submittedUnits, 2);
  assert.equal(state.submittedType, 'number');
});

test('admin inventory views stay within a 375px viewport', { concurrency: false }, async () => {
  await page.setViewport({ width: 375, height: 812 });
  await page.goto(`${baseUrl}/admin`, { waitUntil: 'domcontentloaded', timeout: 30_000 });

  const widths = await page.evaluate(() => {
    document.getElementById('loginView').style.display = 'none';
    document.getElementById('dashView').classList.add('active');
    ME = { role: 'owner' };
    BLOCKS = [];
    VIEW = 'blocks';
    renderBlocks();
    const blocks = { viewport: document.documentElement.clientWidth, page: document.documentElement.scrollWidth };

    BOOKINGS = [{
      id: 88, guest_name: 'Conflict Guest', guest_email: 'guest@example.com',
      guest_phone: '+232 77 000 000', room_name: 'Deluxe Standard',
      checkin: '2027-11-10', checkout: '2027-11-12', nights: 2, guests: '2',
      payment_option: 'full', amount_due: 140, total: 140, requests: '',
      created_at: '2027-10-01T10:00:00.000Z', status: 'active', stage: 'checkout',
      payment_status: 'paid', inventory_status: 'conflict', hold_expires_at: null,
    }];
    VIEW = 'bookings';
    FILTER = 'all';
    render();
    const bookings = { viewport: document.documentElement.clientWidth, page: document.documentElement.scrollWidth };
    return { blocks, bookings };
  });

  assert.ok(widths.blocks.page <= widths.blocks.viewport, JSON.stringify(widths.blocks));
  assert.ok(widths.bookings.page <= widths.bookings.viewport, JSON.stringify(widths.bookings));
});

test('admin booking cards distinguish conflicts, live holds, and abandoned checkout', { concurrency: false }, async () => {
  await page.setViewport({ width: 1440, height: 900 });
  await page.goto(`${baseUrl}/admin`, { waitUntil: 'domcontentloaded', timeout: 30_000 });

  const cards = await page.evaluate(() => {
    const base = {
      room_name: 'Deluxe Standard',
      checkin: '2027-11-10',
      checkout: '2027-11-12',
      nights: 2,
      guests: '2',
      guest_email: 'guest@example.com',
      guest_phone: '+232 77 000 000',
      payment_option: 'full',
      amount_due: 140,
      total: 140,
      requests: '',
      created_at: '2027-10-01T10:00:00.000Z',
      status: 'active',
      stage: 'checkout',
    };
    BOOKINGS = [
      { ...base, id: 81, guest_name: 'Conflict Guest', payment_status: 'paid', inventory_status: 'conflict', hold_expires_at: null },
      { ...base, id: 82, guest_name: 'Held Guest', payment_status: 'unpaid', inventory_status: 'held', hold_expires_at: '2099-10-01T14:35:00.000Z' },
      { ...base, id: 83, guest_name: 'Expired Guest', payment_status: 'unpaid', inventory_status: 'held', hold_expires_at: '2020-10-01T14:35:00.000Z' },
      { ...base, id: 84, guest_name: 'Unreserved Guest', payment_status: 'unpaid', inventory_status: 'unreserved', hold_expires_at: null },
    ];
    ME = { role: 'owner' };
    VIEW = 'bookings';
    FILTER = 'all';
    render();
    return Object.fromEntries(
      [...document.querySelectorAll('.card[data-id]')]
        .map((card) => [card.dataset.id, card.textContent.replace(/\s+/g, ' ').trim()]),
    );
  });

  assert.match(cards['81'], /Payment conflict/);
  assert.match(cards['81'], /Reassign or refund/);
  assert.match(cards['82'], /Held until \d{2}:\d{2}/);
  assert.doesNotMatch(cards['82'], /Left at payment/);
  assert.match(cards['83'], /Left at payment/);
  assert.match(cards['84'], /Left at payment/);
});

test('admin keeps local booking state unchanged when 409 actions return safe messages', { concurrency: false }, async () => {
  await page.goto(`${baseUrl}/admin`, { waitUntil: 'domcontentloaded', timeout: 30_000 });

  const state = await page.evaluate(async () => {
    const base = {
      room_name: 'Deluxe Standard', checkin: '2027-11-10', checkout: '2027-11-12',
      nights: 2, guests: '2', guest_email: 'guest@example.com', guest_phone: '+232 77 000 000',
      payment_option: 'full', amount_due: 140, total: 140, requests: '',
      created_at: '2027-10-01T10:00:00.000Z', stage: 'checkout', inventory_status: 'unreserved',
    };
    BOOKINGS = [
      { ...base, id: 85, guest_name: 'Mark Paid Guest', payment_status: 'unpaid', status: 'active' },
      { ...base, id: 86, guest_name: 'Restore Guest', payment_status: 'paid', status: 'cancelled' },
    ];
    ME = { role: 'owner' };
    VIEW = 'bookings';
    FILTER = 'all';
    render();
    const messages = [];
    window.alert = (message) => messages.push(message);
    api = async (_method, body) => {
      if (body.payment_status === 'paid') throw new Error('Only 0 rooms remain for those dates.');
      throw new Error('That booking cannot be restored because the room is full.');
    };

    await toggle(85, 'paid');
    await setBookingStatus(86, 'active');
    return {
      messages,
      paymentStatus: BOOKINGS.find((booking) => booking.id === 85).payment_status,
      bookingStatus: BOOKINGS.find((booking) => booking.id === 86).status,
    };
  });

  assert.deepEqual(state.messages, [
    'Only 0 rooms remain for those dates.',
    'That booking cannot be restored because the room is full.',
  ]);
  assert.equal(state.paymentStatus, 'unpaid');
  assert.equal(state.bookingStatus, 'cancelled');
});

test('admin applies the server inventory outcome after marking a booking paid', { concurrency: false }, async () => {
  await page.goto(`${baseUrl}/admin`, { waitUntil: 'domcontentloaded', timeout: 30_000 });

  const state = await page.evaluate(async () => {
    BOOKINGS = [{
      id: 87,
      guest_name: 'Late Payment Guest',
      guest_email: 'guest@example.com',
      guest_phone: '+232 77 000 000',
      room_name: 'Deluxe Standard',
      checkin: '2027-11-10',
      checkout: '2027-11-12',
      nights: 2,
      guests: '2',
      payment_option: 'full',
      amount_due: 140,
      total: 140,
      requests: '',
      created_at: '2027-10-01T10:00:00.000Z',
      stage: 'checkout',
      payment_status: 'unpaid',
      inventory_status: 'unreserved',
      hold_expires_at: null,
      status: 'active',
    }];
    ME = { role: 'owner' };
    VIEW = 'bookings';
    FILTER = 'all';
    render();
    api = async () => ({
      ok: true,
      booking: {
        id: 87,
        payment_status: 'paid',
        inventory_status: 'conflict',
        hold_expires_at: null,
        status: 'active',
      },
      inventoryConflict: true,
    });

    await toggle(87, 'paid');
    return {
      paymentStatus: BOOKINGS[0].payment_status,
      inventoryStatus: BOOKINGS[0].inventory_status,
      cardText: document.querySelector('.card[data-id="87"]').textContent.replace(/\s+/g, ' ').trim(),
    };
  });

  assert.equal(state.paymentStatus, 'paid');
  assert.equal(state.inventoryStatus, 'conflict');
  assert.match(state.cardText, /Payment conflict/);
  assert.match(state.cardText, /Reassign or refund/);
});
