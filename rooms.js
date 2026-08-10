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
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
