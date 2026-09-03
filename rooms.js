/* Room gallery.
 *
 * Shows one photograph at full width and moves on every five seconds, with
 * arrows and thumbnails to move by hand.
 *
 * On stopping: WCAG asks that anything moving on its own can be stopped. There
 * is deliberately no play/pause button — one was tried on the reviews and taken
 * off again — so the arrows and thumbnails do that job instead. Touching any of
 * them stops the rotation for good, on the reasoning that someone steering has
 * stopped wanting it to steer itself. It also pauses while hovered or focused,
 * and never starts at all when the reader has asked for reduced motion.
 */
(function () {
  'use strict';

  var reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function setup(stage) {
    var slides = Array.prototype.slice.call(stage.querySelectorAll('.rp__slide'));
    if (slides.length < 2) {
      // A single photograph is not a carousel. Drop the furniture.
      var only = stage.parentNode.querySelector('.rp__thumbs');
      if (only) only.remove();
      Array.prototype.forEach.call(stage.querySelectorAll('.rp__arrow, .rp__counter'), function (n) { n.remove(); });
      stage.removeAttribute('data-carousel');
      return;
    }

    var thumbs = Array.prototype.slice.call(
      stage.parentNode.querySelectorAll('.rp__thumb'));
    var counter = stage.querySelector('.rp__counter');
    var prev = stage.querySelector('.rp__arrow--prev');
    var next = stage.querySelector('.rp__arrow--next');
    var wait = Number(stage.getAttribute('data-interval')) || 5000;

    var at = 0;
    var timer = null;
    var surrendered = reduced;   // true once it should never move on its own again

    // While it rotates by itself, announcing every change would talk over the
    // reader. Once they are steering, the change is the answer to something
    // they did, so it should be announced.
    if (counter) counter.setAttribute('aria-live', 'off');

    function show(i) {
      at = (i + slides.length) % slides.length;
      slides.forEach(function (s, n) {
        var on = n === at;
        s.classList.toggle('is-current', on);
        if (on) s.removeAttribute('aria-hidden');
        else s.setAttribute('aria-hidden', 'true');
      });
      thumbs.forEach(function (t, n) {
        t.setAttribute('aria-current', n === at ? 'true' : 'false');
      });
      if (counter) counter.textContent = (at + 1) + ' / ' + slides.length;
    }

    function start() {
      if (surrendered || timer) return;
      timer = window.setInterval(function () { show(at + 1); }, wait);
    }

    function stop() {
      if (timer) { window.clearInterval(timer); timer = null; }
    }

    /** A deliberate move by the reader: stop rotating, and start announcing. */
    function takeOver(i) {
      surrendered = true;
      stop();
      if (counter) counter.setAttribute('aria-live', 'polite');
      show(i);
    }

    prev.addEventListener('click', function () { takeOver(at - 1); });
    next.addEventListener('click', function () { takeOver(at + 1); });
    thumbs.forEach(function (t) {
      t.addEventListener('click', function () { takeOver(Number(t.getAttribute('data-i'))); });
    });

    // Arrow keys, once something inside the gallery has focus.
    stage.parentNode.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowLeft') { e.preventDefault(); takeOver(at - 1); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); takeOver(at + 1); }
    });

    // Hold still while being looked at or tabbed through.
    ['mouseenter', 'focusin'].forEach(function (ev) {
      stage.parentNode.addEventListener(ev, stop);
    });
    ['mouseleave', 'focusout'].forEach(function (ev) {
      stage.parentNode.addEventListener(ev, start);
    });

    // No point advancing a gallery nobody is looking at.
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) stop(); else start();
    });

    show(0);
    start();
  }

  function init() {
    Array.prototype.forEach.call(document.querySelectorAll('[data-carousel]'), setup);
    setupBackLink();
    setupAvailability();
  }

  function setupBackLink() {
    var back = document.querySelector('[data-room-back]');
    if (!back || !document.referrer) return;

    try {
      if (new URL(document.referrer).origin !== window.location.origin) return;
    } catch (error) {
      return;
    }

    back.addEventListener('click', function (event) {
      event.preventDefault();
      window.history.back();
    });
  }

  var ROOM_NAMES = Object.freeze({
    comfort: 'Superior Double / Comfort',
    standard: 'Deluxe Standard',
    'ground-floor': 'Ground Floor One-Bedroom',
    'superior-deluxe': 'Superior Deluxe King',
    'superior-twin': 'Superior Deluxe Twin',
    studio: 'Studio Penthouse',
    'one-bed': 'One-Bedroom Apartment',
    'two-bed': 'Two-Bedroom Apartment'
  });

  function owns(object, key) {
    return Object.prototype.hasOwnProperty.call(object, key);
  }

  function todayIso() {
    var now = new Date();
    var year = String(now.getFullYear()).padStart(4, '0');
    var month = String(now.getMonth() + 1).padStart(2, '0');
    var day = String(now.getDate()).padStart(2, '0');
    return year + '-' + month + '-' + day;
  }

  function parseIsoDay(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return null;
    var day = new Date(value + 'T00:00:00Z');
    if (!Number.isFinite(day.getTime()) || day.toISOString().slice(0, 10) !== value) return null;
    return day;
  }

  function validStay(checkin, checkout, minimum) {
    var start = parseIsoDay(checkin);
    var end = parseIsoDay(checkout);
    return Boolean(start && end && checkin >= minimum && checkout > checkin);
  }

  function nextDay(value) {
    var date = parseIsoDay(value);
    if (!date) return todayIso();
    date.setUTCDate(date.getUTCDate() + 1);
    return date.toISOString().slice(0, 10);
  }

  function dateLabel(checkin, checkout) {
    var start = parseIsoDay(checkin);
    var end = parseIsoDay(checkout);
    var options = { day: 'numeric', month: 'short', timeZone: 'UTC' };
    var startMonth = start.toLocaleDateString('en-GB', { month: 'short', timeZone: 'UTC' });
    var endMonth = end.toLocaleDateString('en-GB', { month: 'short', timeZone: 'UTC' });
    if (startMonth === endMonth && start.getUTCFullYear() === end.getUTCFullYear()) {
      return start.getUTCDate() + '–' + end.getUTCDate() + ' ' + endMonth;
    }
    return start.toLocaleDateString('en-GB', options) + '–' + end.toLocaleDateString('en-GB', options);
  }

  function moneyCents(value) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
    var scaled = value * 100;
    var rounded = Math.round(scaled);
    return Math.abs(scaled - rounded) <= 0.000001 ? rounded : null;
  }

  function strictRoomPayload(data, roomKey, roomName, expectedRate, checkin, checkout) {
    if (!data || typeof data !== 'object' || Array.isArray(data) || !Array.isArray(data.rooms) || data.rooms.length !== 1) {
      return null;
    }
    if (owns(data, 'checkin') && data.checkin !== checkin) return null;
    if (owns(data, 'checkout') && data.checkout !== checkout) return null;

    var room = data.rooms[0];
    if (!room || typeof room !== 'object' || Array.isArray(room)) return null;
    if (room.key !== roomKey || room.name !== roomName) return null;
    if (!Number.isInteger(room.capacity) || room.capacity < 1) return null;
    if (!Number.isInteger(room.remaining) || room.remaining < 0 || room.remaining > room.capacity) return null;
    if (typeof room.available !== 'boolean' || room.available !== (room.remaining > 0)) return null;

    var nights = Math.round((parseIsoDay(checkout) - parseIsoDay(checkin)) / 86400000);
    if (!Number.isInteger(room.nights) || room.nights !== nights) return null;
    var expectedRateCents = moneyCents(expectedRate);
    var rateCents = moneyCents(room.rate);
    var totalCents = moneyCents(room.total);
    if (expectedRateCents === null || expectedRateCents <= 0 || rateCents !== expectedRateCents) return null;
    if (totalCents === null || totalCents !== expectedRateCents * nights) return null;
    if (owns(data, 'nights') && data.nights !== nights) return null;
    if (owns(data, 'anyAvailable') && data.anyAvailable !== room.available) return null;
    return room;
  }

  function setupAvailability() {
    var main = document.querySelector('main[data-room-key][data-room-name]');
    var form = document.querySelector('[data-room-availability]');
    if (!main || !form) return;

    var roomKey = main.getAttribute('data-room-key');
    var roomName = main.getAttribute('data-room-name');
    var expectedRate = Number(main.getAttribute('data-room-rate'));
    if (!owns(ROOM_NAMES, roomKey) || ROOM_NAMES[roomKey] !== roomName || moneyCents(expectedRate) === null) return;

    var checkin = document.getElementById('roomCheckin');
    var checkout = document.getElementById('roomCheckout');
    var submit = document.getElementById('roomAvailabilitySubmit');
    var result = document.getElementById('roomAvailabilityResult');
    var book = document.querySelector('.rp__availability .rp__book');
    if (!checkin || !checkout || !submit || !result || !book) return;

    var minimum = todayIso();
    var request = { generation: 0, controller: null, signature: '', pending: false };
    checkin.min = minimum;
    checkout.min = minimum;

    function setBookDisabled(label) {
      book.removeAttribute('href');
      book.setAttribute('aria-disabled', 'true');
      book.textContent = label;
    }

    function setResult(message, state) {
      result.hidden = !message;
      result.textContent = message;
      if (state) result.setAttribute('data-state', state);
      else result.removeAttribute('data-state');
    }

    function resetForDates() {
      if (request.controller) request.controller.abort();
      request.generation += 1;
      request.controller = null;
      request.signature = '';
      request.pending = false;
      submit.disabled = false;
      submit.textContent = 'Check availability';
      result.removeAttribute('aria-busy');
      result.removeAttribute('aria-label');
      setResult('', '');
      setBookDisabled('Choose dates to book');
    }

    function updateDateRules() {
      checkout.min = parseIsoDay(checkin.value) ? nextDay(checkin.value) : minimum;
      checkin.setCustomValidity(checkin.value && checkin.value < minimum ? 'Check-in cannot be in the past.' : '');
      checkout.setCustomValidity(
        checkin.value && checkout.value && checkout.value <= checkin.value
          ? 'Check-out must be after check-in.'
          : ''
      );
    }

    function focusDates(event) {
      if (book.getAttribute('aria-disabled') !== 'true') return;
      event.preventDefault();
      checkin.focus();
    }

    book.addEventListener('click', focusDates);
    book.addEventListener('keydown', function (event) {
      if (event.key === 'Enter' || event.key === ' ') focusDates(event);
    });

    [checkin, checkout].forEach(function (field) {
      field.addEventListener('input', function () {
        updateDateRules();
        resetForDates();
      });
    });

    async function checkAvailability() {
      updateDateRules();
      if (!validStay(checkin.value, checkout.value, minimum)) {
        if (!checkin.value || checkin.value < minimum || !parseIsoDay(checkin.value)) checkin.focus();
        else checkout.focus();
        form.reportValidity();
        setBookDisabled('Choose dates to book');
        return;
      }

      var chosenCheckin = checkin.value;
      var chosenCheckout = checkout.value;
      var signature = chosenCheckin + '|' + chosenCheckout;
      if (request.pending && request.signature === signature) return;
      if (request.controller) request.controller.abort();

      var controller = new AbortController();
      var generation = request.generation + 1;
      request.generation = generation;
      request.controller = controller;
      request.signature = signature;
      request.pending = true;
      submit.disabled = true;
      submit.textContent = 'Checking…';
      result.setAttribute('aria-busy', 'true');
      result.removeAttribute('aria-label');
      setResult('Checking availability…', 'checking');
      setBookDisabled('Checking dates…');

      try {
        var params = new URLSearchParams({
          checkin: chosenCheckin,
          checkout: chosenCheckout,
          room: roomKey
        });
        var response = await fetch('/api/availability?' + params.toString(), {
          cache: 'no-store',
          headers: { Accept: 'application/json' },
          signal: controller.signal
        });
        var data = await response.json().catch(function () { return null; });
        if (request.generation !== generation || controller.signal.aborted) return;
        if (!response.ok) throw new Error('Availability request failed.');

        var room = strictRoomPayload(data, roomKey, roomName, expectedRate, chosenCheckin, chosenCheckout);
        if (!room) throw new Error('Invalid availability response.');

        if (room.remaining === 0) {
          var unavailableDates = dateLabel(chosenCheckin, chosenCheckout);
          setResult('Fully booked · ' + unavailableDates, 'full');
          result.setAttribute('aria-label', roomName + ' is unavailable for ' + unavailableDates + '.');
          setBookDisabled('Choose different dates');
        } else {
          var label = room.remaining === 1 ? 'Only 1 room left' : room.remaining + ' rooms available';
          setResult(label, 'available');
          result.removeAttribute('aria-label');
          var bookingParams = new URLSearchParams({
            room: roomKey,
            checkin: chosenCheckin,
            checkout: chosenCheckout
          });
          book.setAttribute('href', '/?' + bookingParams.toString() + '#rooms');
          book.removeAttribute('aria-disabled');
          book.textContent = 'Book this room';
        }
      } catch (error) {
        if (request.generation !== generation || error.name === 'AbortError') return;
        setResult('We could not check availability. Please try again.', 'error');
        result.removeAttribute('aria-label');
        setBookDisabled('Check unavailable');
        submit.textContent = 'Try again';
      } finally {
        if (request.generation === generation) {
          request.pending = false;
          request.controller = null;
          submit.disabled = false;
          result.removeAttribute('aria-busy');
          if (submit.textContent === 'Checking…') submit.textContent = 'Check availability';
        }
      }
    }

    form.addEventListener('submit', function (event) {
      event.preventDefault();
      checkAvailability();
    });

    var query = new URLSearchParams(window.location.search);
    var hydratedCheckin = query.get('checkin') || '';
    var hydratedCheckout = query.get('checkout') || '';
    if (validStay(hydratedCheckin, hydratedCheckout, minimum)) {
      checkin.value = hydratedCheckin;
      checkout.value = hydratedCheckout;
      updateDateRules();
      checkAvailability();
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
