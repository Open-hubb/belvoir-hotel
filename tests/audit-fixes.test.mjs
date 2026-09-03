import assert from 'node:assert/strict';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import test, { after, before } from 'node:test';
import puppeteer from 'puppeteer';

const port = 4568;
const baseUrl = `http://localhost:${port}`;
const ROOM_SLUGS = [
  'superior-double-comfort',
  'deluxe-standard',
  'superior-deluxe-king',
  'superior-deluxe-twin',
  'studio-penthouse',
  'ground-floor-one-bedroom',
  'one-bedroom-apartment',
  'two-bedroom-apartment',
];
let server;
let browser;
let page;

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function cssRgb(value) {
  const channels = String(value).match(/[\d.]+/g)?.slice(0, 3).map(Number);
  assert.equal(channels?.length, 3, `expected an rgb colour, received ${value}`);
  return channels;
}

function relativeLuminance(value) {
  const channels = cssRgb(value).map((channel) => {
    const normalized = channel / 255;
    return normalized <= 0.04045
      ? normalized / 12.92
      : ((normalized + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrastRatio(foreground, background) {
  const values = [relativeLuminance(foreground), relativeLuminance(background)]
    .sort((a, b) => b - a);
  return (values[0] + 0.05) / (values[1] + 0.05);
}

function compositeColour(foreground, background, opacity) {
  const front = cssRgb(foreground);
  const back = cssRgb(background);
  const channels = front.map((channel, index) => channel * opacity + back[index] * (1 - opacity));
  return `rgb(${channels.join(', ')})`;
}

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

test('room cards show intercepted live inventory and preserve selected dates in details links', { concurrency: false }, async () => {
  const inventoryPage = await browser.newPage();
  await inventoryPage.setViewport({ width: 375, height: 812 });
  await inventoryPage.setRequestInterception(true);
  inventoryPage.on('request', (request) => {
    const url = new URL(request.url());
    if (url.pathname === '/api/availability') {
      return request.respond({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          checkin: url.searchParams.get('checkin'),
          checkout: url.searchParams.get('checkout'),
          rooms: [
            { key: 'comfort', name: 'Superior Double / Comfort', capacity: 1, remaining: 0, available: false },
            { key: 'standard', name: 'Deluxe Standard', capacity: 2, remaining: 2, available: true },
            { key: 'superior-deluxe', name: 'Superior Deluxe King', capacity: 3, remaining: 1, available: true },
            { key: 'superior-twin', name: 'Superior Deluxe Twin', capacity: 1, remaining: 1, available: true },
          ],
        }),
      });
    }
    return request.continue();
  });

  try {
    await inventoryPage.goto(`${baseUrl}/`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await inventoryPage.waitForFunction(
      () => getComputedStyle(document.querySelector('#preloader')).display === 'none',
      { timeout: 8_000 },
    );
    await inventoryPage.evaluate(() => {
      const checkin = document.getElementById('heroCheckin');
      const checkout = document.getElementById('heroCheckout');
      checkin.value = '2027-09-10';
      checkout.value = '2027-09-13';
      checkin.dispatchEvent(new Event('change', { bubbles: true }));
      checkout.dispatchEvent(new Event('change', { bubbles: true }));
      document.getElementById('heroBookForm').requestSubmit();
    });
    await inventoryPage.click('.cat-card--rooms');
    await inventoryPage.waitForFunction(
      () => document.querySelector('[data-room-key="comfort"] .cat-room__availability')?.hidden === false,
      { timeout: 5_000 },
    );

    assert.equal(
      await inventoryPage.$eval('[data-room-key="superior-deluxe"] .cat-room__availability', (node) => node.textContent.trim()),
      'Only 1 room left',
    );
    assert.match(
      await inventoryPage.$eval('[data-room-key="comfort"] .cat-room__availability-text', (node) => node.textContent),
      /Fully booked · 10–13 Sep/,
    );
    assert.equal(
      await inventoryPage.$eval('[data-room-key="comfort"] .cat-room__book', (node) => node.disabled),
      true,
    );
    assert.equal(
      await inventoryPage.$eval('[data-room-key="comfort"] .cat-room__book', (node) => node.textContent.trim()),
      'Choose different dates',
    );

    const details = await inventoryPage.$eval(
      '[data-room-key="comfort"] .cat-room__ghost',
      (node) => new URL(node.href).search,
    );
    assert.match(details, /checkin=2027-09-10/);
    assert.match(details, /checkout=2027-09-13/);
  } finally {
    await inventoryPage.close();
  }
});

test('availability failures disable booking and offer a working retry', { concurrency: false }, async () => {
  const retryPage = await browser.newPage();
  let availabilityCalls = 0;
  await retryPage.setRequestInterception(true);
  retryPage.on('request', (request) => {
    const url = new URL(request.url());
    if (url.pathname === '/api/availability') {
      availabilityCalls += 1;
      if (availabilityCalls === 1) {
        return request.respond({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'Could not check availability.' }),
        });
      }
      return request.respond({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          checkin: '2027-09-10', checkout: '2027-09-13',
          rooms: [{ key: 'comfort', name: 'Superior Double / Comfort', capacity: 1, remaining: 1, available: true }],
        }),
      });
    }
    return request.continue();
  });

  try {
    await retryPage.goto(`${baseUrl}/`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await retryPage.waitForFunction(
      () => getComputedStyle(document.querySelector('#preloader')).display === 'none',
      { timeout: 8_000 },
    );
    await retryPage.evaluate(() => {
      heroSearch.checkin = '2027-09-10';
      heroSearch.checkout = '2027-09-13';
      openCategory('rooms');
    });
    await retryPage.waitForSelector('[data-room-key="comfort"] .cat-room__retry');
    assert.equal(
      await retryPage.$eval('[data-room-key="comfort"] .cat-room__book', (node) => node.disabled),
      true,
    );
    assert.match(
      await retryPage.$eval('[data-room-key="comfort"] .cat-room__availability-text', (node) => node.textContent),
      /could not check availability/i,
    );

    await retryPage.click('[data-room-key="comfort"] .cat-room__retry');
    await retryPage.waitForFunction(
      () => document.querySelector('[data-room-key="comfort"] .cat-room__availability-text')?.textContent.trim() === 'Only 1 room left',
      { timeout: 5_000 },
    );
    assert.equal(
      await retryPage.$eval('[data-room-key="comfort"] .cat-room__book', (node) => node.disabled),
      false,
    );
  } finally {
    await retryPage.close();
  }
});

test('malformed availability rows fail closed instead of enabling booking', { concurrency: false }, async () => {
  const malformedPage = await browser.newPage();
  await malformedPage.setRequestInterception(true);
  malformedPage.on('request', (request) => {
    const url = new URL(request.url());
    if (url.pathname === '/api/availability') {
      return request.respond({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          checkin: '2099-09-10', checkout: '2099-09-13',
          rooms: [
            { key: 'comfort', name: 'Superior Double / Comfort', capacity: 1, available: true },
            { key: 'standard', name: 'Deluxe Standard', capacity: 2, remaining: 'many', available: true },
            { key: 'superior-deluxe', name: 'Superior Deluxe King', capacity: 3, remaining: -1, available: false },
            { key: 'superior-twin', name: 'Superior Deluxe Twin', capacity: 1, remaining: 0.5, available: true },
            { key: 'studio', name: 'Studio Penthouse', capacity: 1, remaining: 2, available: true },
          ],
        }),
      });
    }
    return request.continue();
  });

  try {
    await malformedPage.goto(`${baseUrl}/`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await malformedPage.evaluate(() => {
      heroSearch.checkin = '2099-09-10';
      heroSearch.checkout = '2099-09-13';
      openCategory('rooms');
    });
    await malformedPage.waitForFunction(
      () => [...document.querySelectorAll('#catOverlayGrid .cat-room__availability-text')]
        .every((node) => node.textContent.trim() !== 'Checking availability…'),
      { timeout: 5_000 },
    );

    const roomStates = await malformedPage.$$eval(
      '#catOverlayGrid [data-room-key]',
      (cards) => cards.map((card) => ({
        key: card.dataset.roomKey,
        disabled: card.querySelector('.cat-room__book').disabled,
        retryVisible: card.querySelector('.cat-room__retry').hidden === false,
        status: card.querySelector('.cat-room__availability-text').textContent.trim(),
      })),
    );
    assert.deepEqual(roomStates, [
      { key: 'comfort', disabled: true, retryVisible: true, status: 'We could not check availability. Please try again.' },
      { key: 'standard', disabled: true, retryVisible: true, status: 'We could not check availability. Please try again.' },
      { key: 'superior-deluxe', disabled: true, retryVisible: true, status: 'We could not check availability. Please try again.' },
      { key: 'superior-twin', disabled: true, retryVisible: true, status: 'We could not check availability. Please try again.' },
    ]);

    await malformedPage.evaluate(() => {
      closeCategory();
      openCategory('studio');
    });
    await malformedPage.waitForFunction(
      () => {
        const status = document.querySelector('[data-room-key="studio"] .cat-room__availability-text');
        return status && status.textContent.trim() !== 'Checking availability…';
      },
      { timeout: 5_000 },
    );
    const studioState = await malformedPage.$eval('[data-room-key="studio"]', (card) => ({
      disabled: card.querySelector('.cat-room__book').disabled,
      retryVisible: card.querySelector('.cat-room__retry').hidden === false,
      status: card.querySelector('.cat-room__availability-text').textContent.trim(),
    }));
    assert.deepEqual(studioState, {
      disabled: true,
      retryVisible: true,
      status: 'We could not check availability. Please try again.',
    });
  } finally {
    await malformedPage.close();
  }
});

test('valid room-page query dates hydrate the matching booking wizard', { concurrency: false }, async () => {
  const hydrationPage = await browser.newPage();
  await hydrationPage.setViewport({ width: 768, height: 900 });
  await hydrationPage.goto(
    `${baseUrl}/?room=comfort&checkin=2027-09-10&checkout=2027-09-13`,
    { waitUntil: 'domcontentloaded', timeout: 30_000 },
  );
  await hydrationPage.waitForSelector('#bookWizard.active');
  const hydrated = await hydrationPage.evaluate(() => ({
    room: document.getElementById('bwRoomName').textContent.trim(),
    checkin: document.getElementById('bwCheckin').value,
    checkout: document.getElementById('bwCheckout').value,
  }));
  assert.deepEqual(hydrated, {
    room: 'Superior Double / Comfort',
    checkin: '2027-09-10',
    checkout: '2027-09-13',
  });
  await hydrationPage.close();
});

test('past room-page query dates are ignored', { concurrency: false }, async () => {
  const hydrationPage = await browser.newPage();
  await hydrationPage.goto(
    `${baseUrl}/?room=comfort&checkin=2020-09-10&checkout=2020-09-13`,
    { waitUntil: 'domcontentloaded', timeout: 30_000 },
  );
  const wizardOpen = await hydrationPage.$eval(
    '#bookWizard',
    (node) => node.classList.contains('active'),
  );
  assert.equal(wizardOpen, false);
  await hydrationPage.close();
});

test('unknown and prototype-named room query values are ignored without errors', { concurrency: false }, async () => {
  const results = [];
  for (const key of ['unknown-room', 'toString', 'constructor', '__proto__']) {
    const hydrationPage = await browser.newPage();
    const errors = [];
    hydrationPage.on('pageerror', (error) => errors.push(error.message));
    try {
      await hydrationPage.goto(
        `${baseUrl}/?room=${encodeURIComponent(key)}&checkin=2099-09-10&checkout=2099-09-13`,
        { waitUntil: 'domcontentloaded', timeout: 30_000 },
      );
      results.push({
        key,
        wizardOpen: await hydrationPage.$eval(
          '#bookWizard',
          (node) => node.classList.contains('active'),
        ),
        errors,
      });
    } finally {
      await hydrationPage.close();
    }
  }

  assert.deepEqual(results, [
    { key: 'unknown-room', wizardOpen: false, errors: [] },
    { key: 'toString', wizardOpen: false, errors: [] },
    { key: 'constructor', wizardOpen: false, errors: [] },
    { key: '__proto__', wizardOpen: false, errors: [] },
  ]);
});

test('checkout shows the hold deadline and preserves the booking after hold expiry', { concurrency: false }, async () => {
  await openBookingDates();
  const state = await page.evaluate(async () => {
    const holdExpiresAt = '2027-09-10T14:35:00.000Z';
    document.getElementById('bwCheckin').value = '2027-09-10';
    document.getElementById('bwCheckout').value = '2027-09-13';
    document.getElementById('bwName').value = 'Test Guest';
    document.getElementById('bwPhone').value = '+23277000000';
    document.getElementById('bwEmail').value = 'guest@example.com';
    bwState.payment = 'full';
    bwState.bookingId = 77;
    bwState.claim = 'claim-77';
    saveBooking = async () => ({
      id: 77, claim: 'claim-77', reference: 'BEL-77', holdExpiresAt,
    });
    await bwCheckout();
    const notice = document.getElementById('fcAmountSub').textContent;

    fcResult('hold-expired');
    document.getElementById('fcResultBtn').click();
    return {
      notice,
      wizardOpen: document.getElementById('bookWizard').classList.contains('active'),
      step: bwState.step,
      room: bwState.room,
      checkin: document.getElementById('bwCheckin').value,
      checkout: document.getElementById('bwCheckout').value,
      name: document.getElementById('bwName').value,
    };
  });

  assert.match(state.notice, /Your room is reserved for payment until \d{2}:\d{2}/);
  assert.equal(state.wizardOpen, true);
  assert.equal(state.step, 1);
  assert.equal(state.room, 'comfort');
  assert.equal(state.checkin, '2027-09-10');
  assert.equal(state.checkout, '2027-09-13');
  assert.equal(state.name, 'Test Guest');
});

test('payment-link hold expiry returns to the same guest and dates', { concurrency: false }, async () => {
  await openBookingDates();
  const state = await page.evaluate(async () => {
    document.getElementById('bwCheckin').value = '2027-09-10';
    document.getElementById('bwCheckout').value = '2027-09-13';
    document.getElementById('bwName').value = 'Expiry Guest';
    document.getElementById('bwPhone').value = '+23277111111';
    document.getElementById('bwEmail').value = 'expiry@example.com';
    document.getElementById('bwRequests').value = 'Late airport pickup';
    bwState.payment = 'full';
    openFlotCheckout(78, 'claim-78', 180, 'BEL-78', '2027-09-10T14:35:00.000Z');
    fcPick('card');
    const nativeFetch = window.fetch;
    window.fetch = async (input, options) => {
      if (String(input).includes('/api/flot-payment-link')) {
        return new Response(JSON.stringify({ code: 'HOLD_EXPIRED', error: 'Provider text' }), {
          status: 409,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return nativeFetch(input, options);
    };
    await fcStart();
    const result = {
      title: document.getElementById('fcResultTitle').textContent,
      text: document.getElementById('fcResultText').textContent,
      button: document.getElementById('fcResultBtn').textContent,
    };
    document.getElementById('fcResultBtn').click();
    return {
      ...result,
      wizardOpen: document.getElementById('bookWizard').classList.contains('active'),
      checkin: document.getElementById('bwCheckin').value,
      checkout: document.getElementById('bwCheckout').value,
      email: document.getElementById('bwEmail').value,
      requests: document.getElementById('bwRequests').value,
      bookingId: bwState.bookingId,
      claim: bwState.claim,
      paymentBookingId: fcState.bookingId,
      paymentClaim: fcState.claim,
    };
  });

  assert.equal(state.title, 'Reservation time expired');
  assert.equal(state.text, 'Your 15-minute reservation expired. Please recheck these dates before paying.');
  assert.equal(state.button, 'Recheck dates');
  assert.equal(state.wizardOpen, true);
  assert.equal(state.checkin, '2027-09-10');
  assert.equal(state.checkout, '2027-09-13');
  assert.equal(state.email, 'expiry@example.com');
  assert.equal(state.requests, 'Late airport pickup');
  assert.equal(state.bookingId, null);
  assert.equal(state.claim, null);
  assert.equal(state.paymentBookingId, null);
  assert.equal(state.paymentClaim, null);
});

test('checkout after hold expiry cannot reuse the expired booking identity', { concurrency: false }, async () => {
  await openBookingDates();
  const state = await page.evaluate(async () => {
    document.getElementById('bwCheckin').value = '2027-09-10';
    document.getElementById('bwCheckout').value = '2027-09-13';
    document.getElementById('bwGuests').value = '3';
    document.getElementById('bwName').value = 'Changed Stay Guest';
    document.getElementById('bwPhone').value = '+23277222222';
    document.getElementById('bwEmail').value = 'changed@example.com';
    document.getElementById('bwRequests').value = 'Quiet room, please';
    bwState.bookingId = 88;
    bwState.claim = 'expired-claim-88';
    bwState.payment = 'full';
    openFlotCheckout(88, 'expired-claim-88', 180, 'BEL-88', '2027-09-10T14:35:00.000Z');
    fcResult('hold-expired');
    document.getElementById('fcResultBtn').click();

    const restored = {
      room: bwState.room,
      checkin: document.getElementById('bwCheckin').value,
      checkout: document.getElementById('bwCheckout').value,
      guests: document.getElementById('bwGuests').value,
      name: document.getElementById('bwName').value,
      phone: document.getElementById('bwPhone').value,
      email: document.getElementById('bwEmail').value,
      requests: document.getElementById('bwRequests').value,
      bookingId: bwState.bookingId,
      claim: bwState.claim,
    };

    document.getElementById('bwCheckin').value = '2027-10-01';
    document.getElementById('bwCheckout').value = '2027-10-03';
    bwState.payment = 'full';
    let checkoutRecord = null;
    saveBooking = async (record) => {
      checkoutRecord = JSON.parse(JSON.stringify(record));
      return null;
    };
    await bwCheckout();
    return { restored, checkoutRecord };
  });

  assert.deepEqual(state.restored, {
    room: 'comfort',
    checkin: '2027-09-10',
    checkout: '2027-09-13',
    guests: '3',
    name: 'Changed Stay Guest',
    phone: '+23277222222',
    email: 'changed@example.com',
    requests: 'Quiet room, please',
    bookingId: null,
    claim: null,
  });
  assert.equal(state.checkoutRecord.id, null);
  assert.equal(state.checkoutRecord.claim, null);
  assert.equal(state.checkoutRecord.checkin, '2027-10-01');
  assert.equal(state.checkoutRecord.checkout, '2027-10-03');
});

test('payment polling sends the claim and stops on hold expiry', { concurrency: false }, async () => {
  await openBookingDates();
  const state = await page.evaluate(async () => {
    document.getElementById('bwCheckin').value = '2027-09-10';
    document.getElementById('bwCheckout').value = '2027-09-13';
    openFlotCheckout(79, 'claim-79', 180, 'BEL-79', '2027-09-10T14:35:00.000Z');
    fcState.orderId = 'order-79';
    fcState.attemptId = 'attempt-79';
    let statusUrl = '';
    window.fetch = async (input) => {
      statusUrl = String(input);
      return new Response(JSON.stringify({ code: 'HOLD_EXPIRED' }), {
        status: 409,
        headers: { 'Content-Type': 'application/json' },
      });
    };
    fcBeginPolling();
    await new Promise((resolve) => setTimeout(resolve, 50));
    return {
      statusUrl,
      timerStopped: fcState.timer === null,
      text: document.getElementById('fcResultText').textContent,
    };
  });

  assert.match(state.statusUrl, /claim=claim-79/);
  assert.equal(state.timerStopped, true);
  assert.equal(state.text, 'Your 15-minute reservation expired. Please recheck these dates before paying.');
});

test('payment polling never overlaps status requests in one session', { concurrency: false }, async () => {
  await openBookingDates();
  const state = await page.evaluate(async () => {
    openFlotCheckout(90, 'claim-90', 180, 'BEL-90', '2027-09-10T14:35:00.000Z');
    fcState.orderId = 'order-90';
    fcState.attemptId = 'attempt-90';

    const nativeSetInterval = window.setInterval;
    const nativeClearInterval = window.clearInterval;
    let scheduledTick = null;
    let fetchCalls = 0;
    let resolveStatus;
    const pendingStatus = new Promise((resolve) => { resolveStatus = resolve; });
    window.setInterval = (callback) => {
      scheduledTick = callback;
      return 4242;
    };
    window.clearInterval = () => {};
    window.fetch = async () => {
      fetchCalls += 1;
      return pendingStatus;
    };

    try {
      fcBeginPolling();
      await Promise.resolve();
      scheduledTick();
      scheduledTick();
      await Promise.resolve();
      const callsWhilePending = fetchCalls;

      resolveStatus(new Response(JSON.stringify({ status: 'pending', bookingFinal: false }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }));
      await new Promise((resolve) => setTimeout(resolve, 25));
      scheduledTick();
      await Promise.resolve();
      return { callsWhilePending, callsAfterCompletion: fetchCalls };
    } finally {
      fcStopPolling();
      window.setInterval = nativeSetInterval;
      window.clearInterval = nativeClearInterval;
    }
  });

  assert.deepEqual(state, { callsWhilePending: 1, callsAfterCompletion: 2 });
});

test('a hung payment status request still reaches the bounded polling timeout', { concurrency: false }, async () => {
  await openBookingDates();
  const state = await page.evaluate(async () => {
    openFlotCheckout(94, 'claim-94', 180, 'BEL-94', '2027-09-10T14:35:00.000Z');
    fcState.orderId = 'order-94';
    fcState.attemptId = 'attempt-94';

    const nativeNow = Date.now;
    const nativeSetInterval = window.setInterval;
    const nativeClearInterval = window.clearInterval;
    let now = 1_000;
    let scheduledTick = null;
    let statusSignal = null;
    let clearCount = 0;
    Date.now = () => now;
    window.setInterval = (callback) => {
      scheduledTick = callback;
      return 5151;
    };
    window.clearInterval = (timer) => {
      if (timer === 5151) clearCount += 1;
    };
    window.fetch = async (_input, options) => {
      statusSignal = options && options.signal;
      return new Promise(() => {});
    };

    try {
      fcBeginPolling();
      await Promise.resolve();
      now += FC_TIMEOUT_MS + 1;
      await scheduledTick();
      const afterTimeout = {
        requestAborted: Boolean(statusSignal && statusSignal.aborted),
        timerStopped: fcState.timer === null,
        visiblePanel: fcPanels.find((id) => document.getElementById(id).hidden === false),
        title: document.getElementById('fcResultTitle').textContent,
        focus: document.activeElement.id,
        clearCount,
      };

      document.getElementById('fcResultTitle').textContent = 'timeout-rendered-once';
      await scheduledTick();
      return {
        afterTimeout,
        afterStaleTick: {
          title: document.getElementById('fcResultTitle').textContent,
          focus: document.activeElement.id,
          clearCount,
        },
      };
    } finally {
      fcStopPolling();
      Date.now = nativeNow;
      window.setInterval = nativeSetInterval;
      window.clearInterval = nativeClearInterval;
    }
  });

  assert.deepEqual(state.afterTimeout, {
    requestAborted: true,
    timerStopped: true,
    visiblePanel: 'fcResult',
    title: 'Payment timed out',
    focus: 'fcResultBtn',
    clearCount: 1,
  });
  assert.deepEqual(state.afterStaleTick, {
    title: 'timeout-rendered-once',
    focus: 'fcResultBtn',
    clearCount: 1,
  });
});

test('a stale poll cannot overwrite hold-expiry recovery or a newer polling session', { concurrency: false }, async () => {
  await openBookingDates();
  const state = await page.evaluate(async () => {
    document.getElementById('bwCheckin').value = '2027-09-10';
    document.getElementById('bwCheckout').value = '2027-09-13';
    document.getElementById('bwGuests').value = '2';
    document.getElementById('bwName').value = 'Polling Guest';
    document.getElementById('bwPhone').value = '+23277333333';
    document.getElementById('bwEmail').value = 'polling@example.com';
    document.getElementById('bwRequests').value = 'Keep the dates visible';

    let call = 0;
    let oldJsonResolve;
    let oldSignal = null;
    let newSignal = null;
    const oldJson = new Promise((resolve) => { oldJsonResolve = resolve; });
    const newPending = new Promise(() => {});
    window.fetch = async (input, options) => {
      call += 1;
      if (call === 1) {
        oldSignal = options && options.signal;
        return { ok: true, status: 200, json: () => oldJson };
      }
      if (call === 2) {
        return new Response(JSON.stringify({ code: 'HOLD_EXPIRED' }), {
          status: 409,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      newSignal = options && options.signal;
      return newPending;
    };

    openFlotCheckout(91, 'old-claim-91', 180, 'BEL-91', '2027-09-10T14:35:00.000Z');
    fcState.orderId = 'old-order-91';
    fcState.attemptId = 'old-attempt-91';
    fcBeginPolling();
    await new Promise((resolve) => setTimeout(resolve, 0));

    openFlotCheckout(92, 'expiry-claim-92', 180, 'BEL-92', '2027-09-10T14:36:00.000Z');
    fcState.orderId = 'expiry-order-92';
    fcState.attemptId = 'expiry-attempt-92';
    fcBeginPolling();
    for (let attempt = 0; attempt < 20 && document.getElementById('fcResultTitle').textContent !== 'Reservation time expired'; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    document.getElementById('fcResultBtn').click();
    const recovered = {
      wizardOpen: document.getElementById('bookWizard').classList.contains('active'),
      focus: document.activeElement.id,
      checkin: document.getElementById('bwCheckin').value,
      checkout: document.getElementById('bwCheckout').value,
      email: document.getElementById('bwEmail').value,
      requests: document.getElementById('bwRequests').value,
      oldRequestAborted: Boolean(oldSignal && oldSignal.aborted),
    };

    document.getElementById('bwCheckin').value = '2027-10-01';
    document.getElementById('bwCheckout').value = '2027-10-03';
    closeBookWizard();
    openFlotCheckout(93, 'new-claim-93', 240, 'BEL-93', '2027-10-01T14:35:00.000Z');
    fcState.orderId = 'new-order-93';
    fcState.attemptId = 'new-attempt-93';
    fcBeginPolling();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const newTimer = fcState.timer;

    oldJsonResolve({
      status: 'completed', bookingFinal: true, receiptAvailable: true,
      amount: 180, currency: 'USD',
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await Promise.resolve();

    const afterStaleCompletion = {
      bookingId: fcState.bookingId,
      claim: fcState.claim,
      timerStillCurrent: newTimer !== null && fcState.timer === newTimer,
      newRequestActive: Boolean(newSignal && !newSignal.aborted),
      visiblePanel: fcPanels.find((id) => document.getElementById(id).hidden === false),
      resultTitle: document.getElementById('fcResultTitle').textContent,
      focus: document.activeElement.id,
      checkin: document.getElementById('bwCheckin').value,
      checkout: document.getElementById('bwCheckout').value,
    };
    fcStopPolling();
    return { recovered, afterStaleCompletion };
  });

  assert.deepEqual(state.recovered, {
    wizardOpen: true,
    focus: 'bwCheckin',
    checkin: '2027-09-10',
    checkout: '2027-09-13',
    email: 'polling@example.com',
    requests: 'Keep the dates visible',
    oldRequestAborted: true,
  });
  assert.deepEqual(state.afterStaleCompletion, {
    bookingId: 93,
    claim: 'new-claim-93',
    timerStillCurrent: true,
    newRequestActive: true,
    visiblePanel: 'fcPick',
    resultTitle: 'Reservation time expired',
    focus: 'fcClose',
    checkin: '2027-10-01',
    checkout: '2027-10-03',
  });
});

test('a stale payment-link response cannot attach its attempt to a newer checkout', { concurrency: false }, async () => {
  await openBookingDates();
  const state = await page.evaluate(async () => {
    let paymentLinkCalls = 0;
    let statusCalls = 0;
    let oldJsonResolve;
    let oldSignal = null;
    let newSignal = null;
    const oldJson = new Promise((resolve) => { oldJsonResolve = resolve; });

    window.fetch = async (input, options) => {
      const url = String(input);
      if (url.includes('/api/flot-status')) {
        statusCalls += 1;
        return new Promise(() => {});
      }
      if (url.includes('/api/flot-payment-link')) {
        paymentLinkCalls += 1;
        const body = JSON.parse(options.body);
        if (body.bookingId === 301 && paymentLinkCalls === 1) {
          oldSignal = options.signal;
          return { ok: true, status: 200, json: () => oldJson };
        }
        if (body.bookingId === 302) newSignal = options.signal;
        return new Promise(() => {});
      }
      throw new Error('Unexpected fetch: ' + url);
    };

    openFlotCheckout(301, 'claim-301', 180, 'BEL-301', '2027-09-10T14:35:00.000Z');
    fcPick('card');
    const oldStart = fcStart();
    await Promise.resolve();
    fcStart();
    await Promise.resolve();
    const callsAfterDuplicateStart = paymentLinkCalls;

    fcDismiss();
    openFlotCheckout(302, 'claim-302', 240, 'BEL-302', '2027-09-10T14:36:00.000Z');
    fcPick('card');
    fcStart();
    await Promise.resolve();
    document.getElementById('fcQrLink').href = 'https://example.test/new-checkout';

    oldJsonResolve({
      orderId: 'old-order-301',
      attemptId: 'old-attempt-301',
      amount: 180,
      currency: 'USD',
      link: 'https://pay.example.test/old-301',
    });
    await oldStart;
    await Promise.resolve();

    const snapshot = {
      callsAfterDuplicateStart,
      paymentLinkCalls,
      statusCalls,
      oldRequestAborted: Boolean(oldSignal && oldSignal.aborted),
      newRequestActive: Boolean(newSignal && !newSignal.aborted),
      bookingId: fcState.bookingId,
      claim: fcState.claim,
      orderId: fcState.orderId,
      attemptId: fcState.attemptId,
      qrLink: document.getElementById('fcQrLink').href,
      visiblePanel: fcPanels.find((id) => document.getElementById(id).hidden === false),
      focus: document.activeElement.id,
      payDisabled: document.getElementById('fcPay').disabled,
    };
    fcStopPolling();
    if (typeof fcStopStartingPayment === 'function') fcStopStartingPayment();
    return snapshot;
  });

  assert.deepEqual(state, {
    callsAfterDuplicateStart: 1,
    paymentLinkCalls: 2,
    statusCalls: 0,
    oldRequestAborted: true,
    newRequestActive: true,
    bookingId: 302,
    claim: 'claim-302',
    orderId: null,
    attemptId: null,
    qrLink: 'https://example.test/new-checkout',
    visiblePanel: 'fcLoading',
    focus: 'fcClose',
    payDisabled: true,
  });
});

test('a stale payment-link error cannot replace the newer checkout state', { concurrency: false }, async () => {
  await openBookingDates();
  const state = await page.evaluate(async () => {
    let rejectOld;
    let oldSignal = null;
    let newSignal = null;
    window.fetch = async (input, options) => {
      if (!String(input).includes('/api/flot-payment-link')) {
        throw new Error('Unexpected fetch: ' + String(input));
      }
      const body = JSON.parse(options.body);
      if (body.bookingId === 401) {
        oldSignal = options.signal;
        return new Promise((_resolve, reject) => { rejectOld = reject; });
      }
      newSignal = options.signal;
      return new Promise(() => {});
    };

    openFlotCheckout(401, 'claim-401', 180, 'BEL-401', '2027-09-10T14:35:00.000Z');
    fcPick('card');
    const oldStart = fcStart();
    await Promise.resolve();
    fcDismiss();

    openFlotCheckout(402, 'claim-402', 240, 'BEL-402', '2027-09-10T14:36:00.000Z');
    fcPick('card');
    fcStart();
    await Promise.resolve();
    document.getElementById('fcResultTitle').textContent = 'new-checkout-marker';
    rejectOld(new Error('Old checkout failed'));
    await oldStart;
    await Promise.resolve();

    const snapshot = {
      oldRequestAborted: Boolean(oldSignal && oldSignal.aborted),
      newRequestActive: Boolean(newSignal && !newSignal.aborted),
      bookingId: fcState.bookingId,
      claim: fcState.claim,
      orderId: fcState.orderId,
      attemptId: fcState.attemptId,
      visiblePanel: fcPanels.find((id) => document.getElementById(id).hidden === false),
      resultTitle: document.getElementById('fcResultTitle').textContent,
      focus: document.activeElement.id,
    };
    fcStopStartingPayment();
    return snapshot;
  });

  assert.deepEqual(state, {
    oldRequestAborted: true,
    newRequestActive: true,
    bookingId: 402,
    claim: 'claim-402',
    orderId: null,
    attemptId: null,
    visiblePanel: 'fcLoading',
    resultTitle: 'new-checkout-marker',
    focus: 'fcClose',
  });
});

test('the current payment-link response starts polling its matching checkout identity', { concurrency: false }, async () => {
  await openBookingDates();
  const state = await page.evaluate(async () => {
    let statusUrl = '';
    let statusSignal = null;
    window.fetch = async (input, options) => {
      const url = String(input);
      if (url.includes('/api/flot-payment-link')) {
        return new Response(JSON.stringify({
          orderId: 'order-501',
          attemptId: 'attempt-501',
          amount: 240,
          currency: 'USD',
          link: 'https://pay.example.test/current-501',
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      statusUrl = url;
      statusSignal = options && options.signal;
      return new Promise(() => {});
    };

    openFlotCheckout(501, 'claim-501', 240, 'BEL-501', '2027-09-10T14:36:00.000Z');
    fcPick('card');
    await fcStart();
    await Promise.resolve();
    const snapshot = {
      bookingId: fcState.bookingId,
      claim: fcState.claim,
      orderId: fcState.orderId,
      attemptId: fcState.attemptId,
      statusUrl,
      statusRequestActive: Boolean(statusSignal && !statusSignal.aborted),
      startFinished: fcStartingSession === null,
      visiblePanel: fcPanels.find((id) => document.getElementById(id).hidden === false),
      qrLink: document.getElementById('fcQrLink').href,
    };
    fcStopPolling();
    return snapshot;
  });

  assert.deepEqual(state, {
    bookingId: 501,
    claim: 'claim-501',
    orderId: 'order-501',
    attemptId: 'attempt-501',
    statusUrl: '/api/flot-status?orderId=order-501&attemptId=attempt-501&claim=claim-501',
    statusRequestActive: true,
    startFinished: true,
    visiblePanel: 'fcQr',
    qrLink: 'https://pay.example.test/current-501',
  });
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

test('every room detail page has a labelled availability form', { concurrency: false }, async () => {
  for (const slug of ROOM_SLUGS) {
    const response = await fetch(`${baseUrl}/rooms/${slug}`);
    assert.equal(response.ok, true, `${slug} should be available`);
    const html = await response.text();
    assert.match(html, /<main\b[^>]*\bdata-room-key="[^"]+"/);
    assert.match(html, /<main\b[^>]*\bdata-room-name="[^"]+"/);
    assert.match(html, /<main\b[^>]*\bdata-room-rate="\d+(?:\.\d+)?"/);
    assert.match(html, /<form\b[^>]*\bdata-room-availability/);
    assert.match(html, /<label\b[^>]*for="roomCheckin"/);
    assert.match(html, /<label\b[^>]*for="roomCheckout"/);
    assert.match(html, /id="roomAvailabilitySubmit"/);
    assert.match(html, /id="roomAvailabilityResult"[^>]*role="status"[^>]*aria-live="polite"/);
  }
});

test('room detail availability enables a date-preserving booking link', { concurrency: false }, async () => {
  const roomPage = await browser.newPage();
  const requests = [];
  await roomPage.setRequestInterception(true);
  roomPage.on('request', (request) => {
    const url = new URL(request.url());
    if (url.pathname === '/api/availability') {
      requests.push(url);
      return request.respond({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          checkin: url.searchParams.get('checkin'),
          checkout: url.searchParams.get('checkout'),
          nights: 2,
          rooms: [{
            key: 'comfort', name: 'Superior Double / Comfort', rate: 60,
            capacity: 1, remaining: 1, available: true, nights: 2, total: 120,
          }],
          anyAvailable: true,
        }),
      });
    }
    return request.continue();
  });

  try {
    await roomPage.goto(`${baseUrl}/rooms/superior-double-comfort`, { waitUntil: 'domcontentloaded' });
    await roomPage.evaluate(() => {
      document.getElementById('roomCheckin').value = '2027-09-10';
      document.getElementById('roomCheckout').value = '2027-09-12';
      document.querySelector('[data-room-availability]').requestSubmit();
    });
    await roomPage.waitForFunction(
      () => document.getElementById('roomAvailabilityResult').textContent.trim() === 'Only 1 room left',
    );

    assert.equal(requests.length, 1);
    assert.equal(requests[0].searchParams.get('room'), 'comfort');
    assert.equal(
      await roomPage.$eval('.rp__availability .rp__book', (node) => node.getAttribute('href')),
      '/?room=comfort&checkin=2027-09-10&checkout=2027-09-12#rooms',
    );
    assert.equal(
      await roomPage.$eval('.rp__availability .rp__book', (node) => node.hasAttribute('aria-disabled')),
      false,
    );
  } finally {
    await roomPage.close();
  }
});

test('fully booked room detail keeps its dates and returns focus to check-in', { concurrency: false }, async () => {
  const roomPage = await browser.newPage();
  await roomPage.setRequestInterception(true);
  roomPage.on('request', (request) => {
    const url = new URL(request.url());
    if (url.pathname === '/api/availability') {
      return request.respond({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          checkin: '2027-09-10', checkout: '2027-09-12', nights: 2,
          rooms: [{
            key: 'comfort', name: 'Superior Double / Comfort', rate: 60,
            capacity: 1, remaining: 0, available: false, nights: 2, total: 120,
          }],
          anyAvailable: false,
        }),
      });
    }
    return request.continue();
  });

  try {
    await roomPage.goto(`${baseUrl}/rooms/superior-double-comfort`, { waitUntil: 'domcontentloaded' });
    await roomPage.evaluate(() => {
      document.getElementById('roomCheckin').value = '2027-09-10';
      document.getElementById('roomCheckout').value = '2027-09-12';
      document.querySelector('[data-room-availability]').requestSubmit();
    });
    await roomPage.waitForFunction(
      () => document.getElementById('roomAvailabilityResult').textContent.includes('Fully booked'),
    );

    const before = roomPage.url();
    assert.equal(
      await roomPage.$eval('.rp__availability .rp__book', (node) => node.getAttribute('aria-disabled')),
      'true',
    );
    assert.equal(
      await roomPage.$eval('.rp__availability .rp__book', (node) => node.textContent.trim()),
      'Choose different dates',
    );
    await roomPage.click('.rp__availability .rp__book');
    assert.equal(roomPage.url(), before);
    assert.equal(
      await roomPage.evaluate(() => document.activeElement.id),
      'roomCheckin',
    );
    await roomPage.focus('.rp__availability .rp__book');
    await roomPage.keyboard.press('Space');
    assert.equal(
      await roomPage.evaluate(() => document.activeElement.id),
      'roomCheckin',
    );
  } finally {
    await roomPage.close();
  }
});

test('room detail rejects malformed inventory and fails closed with retry guidance', { concurrency: false }, async () => {
  const roomPage = await browser.newPage();
  await roomPage.setRequestInterception(true);
  roomPage.on('request', (request) => {
    const url = new URL(request.url());
    if (url.pathname === '/api/availability') {
      return request.respond({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          checkin: '2027-09-10', checkout: '2027-09-12', nights: 2,
          rooms: [{
            key: 'comfort', name: 'Wrong room', rate: 60,
            capacity: 1, remaining: 1, available: true, nights: 2, total: 120,
          }],
          anyAvailable: true,
        }),
      });
    }
    return request.continue();
  });

  try {
    await roomPage.goto(`${baseUrl}/rooms/superior-double-comfort`, { waitUntil: 'domcontentloaded' });
    await roomPage.evaluate(() => {
      document.getElementById('roomCheckin').value = '2027-09-10';
      document.getElementById('roomCheckout').value = '2027-09-12';
      document.querySelector('[data-room-availability]').requestSubmit();
    });
    await roomPage.waitForFunction(
      () => document.getElementById('roomAvailabilityResult').textContent.includes('could not check'),
    );
    assert.equal(
      await roomPage.$eval('.rp__availability .rp__book', (node) => node.getAttribute('aria-disabled')),
      'true',
    );
    assert.equal(
      await roomPage.$eval('#roomAvailabilitySubmit', (node) => node.textContent.trim()),
      'Try again',
    );
  } finally {
    await roomPage.close();
  }
});

test('room detail rejects malformed rates and totals instead of enabling booking', { concurrency: false }, async () => {
  const malformedRows = [
    { label: 'string rate', row: { rate: 'free', total: 120 } },
    { label: 'missing rate', row: { total: 120 } },
    { label: 'negative rate', row: { rate: -60, total: 120 } },
    { label: 'unexpected rate', row: { rate: 61, total: 122 } },
    { label: 'string total', row: { rate: 60, total: '120' } },
    { label: 'missing total', row: { rate: 60 } },
    { label: 'negative total', row: { rate: 60, total: -1 } },
    { label: 'mismatched total', row: { rate: 60, total: 60 } },
    { label: 'sub-cent total', row: { rate: 60, total: 120.001 } },
  ];

  for (const malformed of malformedRows) {
    const roomPage = await browser.newPage();
    await roomPage.setRequestInterception(true);
    roomPage.on('request', (request) => {
      const url = new URL(request.url());
      if (url.pathname === '/api/availability') {
        return request.respond({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            checkin: '2027-09-10', checkout: '2027-09-12', nights: 2,
            rooms: [{
              key: 'comfort', name: 'Superior Double / Comfort',
              capacity: 1, remaining: 1, available: true, nights: 2,
              ...malformed.row,
            }],
            anyAvailable: true,
          }),
        });
      }
      return request.continue();
    });

    try {
      await roomPage.goto(`${baseUrl}/rooms/superior-double-comfort`, { waitUntil: 'domcontentloaded' });
      await roomPage.evaluate(() => {
        document.getElementById('roomCheckin').value = '2027-09-10';
        document.getElementById('roomCheckout').value = '2027-09-12';
        document.querySelector('[data-room-availability]').requestSubmit();
      });
      await roomPage.waitForFunction(
        () => document.getElementById('roomAvailabilityResult').textContent.includes('could not check'),
        { timeout: 2_000 },
      );
      assert.equal(
        await roomPage.$eval('.rp__availability .rp__book', (node) => node.getAttribute('aria-disabled')),
        'true',
        malformed.label,
      );
    } finally {
      await roomPage.close();
    }
  }
});

test('room availability action text and focus indicators meet AA contrast in every state', { concurrency: false }, async () => {
  const roomPage = await browser.newPage();
  let fail = false;
  await roomPage.setRequestInterception(true);
  roomPage.on('request', (request) => {
    const url = new URL(request.url());
    if (url.pathname === '/api/availability') {
      if (fail) {
        return request.respond({ status: 503, contentType: 'application/json', body: '{"error":"Unavailable"}' });
      }
      return request.respond({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          checkin: url.searchParams.get('checkin'), checkout: url.searchParams.get('checkout'), nights: 2,
          rooms: [{ key: 'comfort', name: 'Superior Double / Comfort', rate: 60,
            capacity: 1, remaining: 1, available: true, nights: 2, total: 120 }],
          anyAvailable: true,
        }),
      });
    }
    return request.continue();
  });

  const colours = async (selector) => roomPage.$eval(selector, (node) => {
    const style = getComputedStyle(node);
    return { foreground: style.color, background: style.backgroundColor, outline: style.outlineColor };
  });
  const assertTextContrast = (state, label) => {
    assert.ok(
      contrastRatio(state.foreground, state.background) >= 4.5,
      `${label} text contrast should be at least 4.5:1: ${JSON.stringify(state)}`,
    );
  };

  try {
    await roomPage.goto(`${baseUrl}/rooms/superior-double-comfort`, { waitUntil: 'domcontentloaded' });
    const disabled = await colours('.rp__availability .rp__book');
    assertTextContrast(disabled, 'disabled booking action');

    assertTextContrast(await colours('#roomAvailabilitySubmit'), 'default availability action');
    await roomPage.hover('#roomAvailabilitySubmit');
    assertTextContrast(await colours('#roomAvailabilitySubmit'), 'hovered availability action');
    await roomPage.mouse.down();
    assertTextContrast(await colours('#roomAvailabilitySubmit'), 'active availability action');
    await roomPage.mouse.up();
    await roomPage.$eval('#roomAvailabilitySubmit', (node) => node.focus());
    const submitFocus = await colours('#roomAvailabilitySubmit');
    assertTextContrast(submitFocus, 'focused availability action');
    assert.ok(contrastRatio(submitFocus.outline, 'rgb(255, 255, 255)') >= 3, 'submit focus indicator');

    await roomPage.evaluate(() => {
      document.getElementById('roomCheckin').value = '2027-09-10';
      document.getElementById('roomCheckout').value = '2027-09-12';
      document.querySelector('[data-room-availability]').requestSubmit();
    });
    await roomPage.waitForFunction(
      () => document.getElementById('roomAvailabilityResult').textContent.trim() === 'Only 1 room left',
    );
    assertTextContrast(await colours('.rp__availability .rp__book'), 'default booking action');
    await roomPage.$eval('.rp__availability .rp__book', (node) => {
      node.addEventListener('click', (event) => event.preventDefault(), { once: true });
    });
    await roomPage.hover('.rp__availability .rp__book');
    assertTextContrast(await colours('.rp__availability .rp__book'), 'hovered booking action');
    await roomPage.mouse.down();
    assertTextContrast(await colours('.rp__availability .rp__book'), 'active booking action');
    await roomPage.mouse.up();
    await roomPage.$eval('.rp__availability .rp__book', (node) => node.focus());
    const bookFocus = await colours('.rp__availability .rp__book');
    assertTextContrast(bookFocus, 'focused booking action');
    assert.ok(contrastRatio(bookFocus.outline, 'rgb(255, 255, 255)') >= 3, 'booking focus indicator');

    fail = true;
    await roomPage.evaluate(() => {
      const checkin = document.getElementById('roomCheckin');
      checkin.value = '2027-10-10';
      checkin.dispatchEvent(new Event('input', { bubbles: true }));
      const checkout = document.getElementById('roomCheckout');
      checkout.value = '2027-10-12';
      checkout.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('[data-room-availability]').requestSubmit();
    });
    await roomPage.waitForFunction(() => document.getElementById('roomAvailabilitySubmit').textContent.trim() === 'Try again');
    await roomPage.hover('#roomAvailabilitySubmit');
    assertTextContrast(await colours('#roomAvailabilitySubmit'), 'hovered retry action');
  } finally {
    await roomPage.close();
  }
});

test('disabled checking action remains AA while the pointer stays over it', { concurrency: false }, async () => {
  const roomPage = await browser.newPage();
  await roomPage.setRequestInterception(true);
  roomPage.on('request', (request) => {
    const url = new URL(request.url());
    if (url.pathname === '/api/availability') return;
    return request.continue();
  });

  try {
    await roomPage.goto(`${baseUrl}/rooms/superior-double-comfort`, { waitUntil: 'domcontentloaded' });
    await roomPage.evaluate(() => {
      document.getElementById('roomCheckin').value = '2027-09-10';
      document.getElementById('roomCheckout').value = '2027-09-12';
    });
    await roomPage.hover('#roomAvailabilitySubmit');
    await roomPage.evaluate(() => document.querySelector('[data-room-availability]').requestSubmit());
    await roomPage.waitForFunction(() => {
      const action = document.getElementById('roomAvailabilitySubmit');
      return action.disabled && action.textContent.trim() === 'Checking…' && action.matches(':hover');
    });

    const checking = await roomPage.$eval('#roomAvailabilitySubmit', (node) => {
      const style = getComputedStyle(node);
      return {
        foreground: style.color,
        background: style.backgroundColor,
        opacity: Number(style.opacity),
        disabled: node.disabled,
        hovered: node.matches(':hover'),
      };
    });
    const cardBackground = 'rgb(255, 255, 255)';
    const effectiveForeground = compositeColour(checking.foreground, cardBackground, checking.opacity);
    const effectiveBackground = compositeColour(checking.background, cardBackground, checking.opacity);
    assert.equal(checking.disabled, true);
    assert.equal(checking.hovered, true);
    assert.ok(
      contrastRatio(effectiveForeground, effectiveBackground) >= 4.5,
      `disabled checking text contrast should be at least 4.5:1: ${JSON.stringify({
        ...checking, effectiveForeground, effectiveBackground,
      })}`,
    );
  } finally {
    await roomPage.close();
  }
});

test('room detail hydrates only valid future date queries and automatically checks them', { concurrency: false }, async () => {
  const roomPage = await browser.newPage();
  const requests = [];
  await roomPage.setRequestInterception(true);
  roomPage.on('request', (request) => {
    const url = new URL(request.url());
    if (url.pathname === '/api/availability') {
      requests.push(url.search);
      return request.respond({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          checkin: '2027-09-10', checkout: '2027-09-12', nights: 2,
          rooms: [{
            key: 'comfort', name: 'Superior Double / Comfort', rate: 60,
            capacity: 1, remaining: 1, available: true, nights: 2, total: 120,
          }],
          anyAvailable: true,
        }),
      });
    }
    return request.continue();
  });

  try {
    await roomPage.goto(
      `${baseUrl}/rooms/superior-double-comfort?checkin=2027-09-10&checkout=2027-09-12`,
      { waitUntil: 'domcontentloaded' },
    );
    await roomPage.waitForFunction(
      () => document.getElementById('roomAvailabilityResult').textContent.trim() === 'Only 1 room left',
    );
    assert.deepEqual(await roomPage.evaluate(() => ({
      checkin: document.getElementById('roomCheckin').value,
      checkout: document.getElementById('roomCheckout').value,
    })), { checkin: '2027-09-10', checkout: '2027-09-12' });
    assert.equal(requests.length, 1);

    await roomPage.goto(
      `${baseUrl}/rooms/superior-double-comfort?checkin=2027-09-12&checkout=2027-09-10`,
      { waitUntil: 'domcontentloaded' },
    );
    assert.deepEqual(await roomPage.evaluate(() => ({
      checkin: document.getElementById('roomCheckin').value,
      checkout: document.getElementById('roomCheckout').value,
    })), { checkin: '', checkout: '' });
    assert.equal(requests.length, 1);

    for (const query of [
      '?checkin=2020-09-10&checkout=2020-09-12',
      '?checkin=2027-02-31&checkout=2027-03-02',
    ]) {
      await roomPage.goto(`${baseUrl}/rooms/superior-double-comfort${query}`, {
        waitUntil: 'domcontentloaded',
      });
      assert.deepEqual(await roomPage.evaluate(() => ({
        checkin: document.getElementById('roomCheckin').value,
        checkout: document.getElementById('roomCheckout').value,
      })), { checkin: '', checkout: '' });
    }
    assert.equal(requests.length, 1);
  } finally {
    await roomPage.close();
  }
});

test('a stale room availability response cannot overwrite newer dates', { concurrency: false }, async () => {
  const roomPage = await browser.newPage();
  try {
    await roomPage.goto(`${baseUrl}/rooms/superior-double-comfort`, { waitUntil: 'domcontentloaded' });
    await roomPage.evaluate(() => {
      let call = 0;
      window.__roomFetchCalls = 0;
      window.fetch = (_input, options) => {
        call += 1;
        window.__roomFetchCalls += 1;
        const current = call;
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => resolve(new Response(JSON.stringify({
            checkin: current === 1 ? '2027-09-10' : '2027-10-10',
            checkout: current === 1 ? '2027-09-12' : '2027-10-12',
            nights: 2,
            rooms: [{
              key: 'comfort', name: 'Superior Double / Comfort', rate: 60,
              capacity: 1, remaining: current === 1 ? 0 : 1,
              available: current !== 1, nights: 2, total: 120,
            }],
            anyAvailable: current !== 1,
          }), { status: 200, headers: { 'Content-Type': 'application/json' } })), current === 1 ? 180 : 10);
          options.signal.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(new DOMException('Aborted', 'AbortError'));
          }, { once: true });
        });
      };

      const checkin = document.getElementById('roomCheckin');
      const checkout = document.getElementById('roomCheckout');
      checkin.value = '2027-09-10';
      checkout.value = '2027-09-12';
      document.querySelector('[data-room-availability]').requestSubmit();
      document.querySelector('[data-room-availability]').requestSubmit();
      checkin.value = '2027-10-10';
      checkout.value = '2027-10-12';
      checkin.dispatchEvent(new Event('input', { bubbles: true }));
      checkout.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('[data-room-availability]').requestSubmit();
    });

    await roomPage.waitForFunction(
      () => document.getElementById('roomAvailabilityResult').textContent.trim() === 'Only 1 room left',
    );
    await wait(220);
    assert.equal(
      await roomPage.$eval('#roomAvailabilityResult', (node) => node.textContent.trim()),
      'Only 1 room left',
    );
    assert.match(
      await roomPage.$eval('.rp__availability .rp__book', (node) => node.href),
      /checkin=2027-10-10&checkout=2027-10-12/,
    );
    assert.equal(await roomPage.evaluate(() => window.__roomFetchCalls), 2);
  } finally {
    await roomPage.close();
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
