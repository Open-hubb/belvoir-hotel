'use strict';

/**
 * Scores an enquiry for how much it looks like it came from a bot.
 *
 * Three layers, in order of how much they can be trusted:
 *
 *   1. The honeypot. A field the form hides from people. Anything that fills
 *      it is reading the HTML, not the page. Close to zero false positives.
 *   2. The clock. Nobody types a name, an email and a message in under three
 *      seconds. Also close to zero false positives.
 *   3. The text itself. The weakest of the three, so it only ever adds to a
 *      score — it never decides alone.
 *
 * Nothing here rejects anything. It returns a verdict and the caller files the
 * enquiry as spam instead of dropping it, because a real guest wrongly scored
 * would otherwise vanish with no trace.
 */

const VOWELS = /[aeiouAEIOU]/;

/** Longest run of consecutive consonants. "Nsombo" is 2; random strings run 6+. */
function longestConsonantRun(s) {
  let run = 0, best = 0;
  for (const ch of s) {
    if (/[a-zA-Z]/.test(ch) && !VOWELS.test(ch)) { run++; if (run > best) best = run; }
    else run = 0;
  }
  return best;
}

function vowelRatio(s) {
  const letters = s.replace(/[^a-zA-Z]/g, '');
  if (!letters.length) return 1;               // no letters at all — not our signal
  return (letters.match(/[aeiouAEIOU]/g) || []).length / letters.length;
}

/** aBcDeF style flipping. Real words change case once, at the start. */
function caseFlips(s) {
  let flips = 0;
  for (let i = 1; i < s.length; i++) {
    const a = s[i - 1], b = s[i];
    if (/[a-zA-Z]/.test(a) && /[a-zA-Z]/.test(b) &&
        (a === a.toUpperCase()) !== (b === b.toUpperCase())) flips++;
  }
  return flips;
}

/**
 * Does this single unbroken token read like keyboard mash?
 *
 * Deliberately requires length before it will judge anything. Short strings
 * carry too little signal, and West African names are consonant-dense enough
 * that a low threshold would start flagging real guests.
 */
function looksRandom(token, minLen) {
  if (!token || token.length < minLen || /\s/.test(token)) return 0;
  let score = 0;
  if (vowelRatio(token) < 0.28) score += 2;
  if (longestConsonantRun(token) >= 5) score += 2;
  if (caseFlips(token) >= 4) score += 2;
  return score;
}

/**
 * Gmail ignores dots, so one mailbox yields unlimited unique-looking
 * addresses. Real people do not write their own address as x.y.z.q.1.2@.
 */
function dottedAlias(email) {
  const local = String(email).split('@')[0] || '';
  const parts = local.split('.');
  if (parts.length < 4) return 0;
  const avg = parts.reduce((n, p) => n + p.length, 0) / parts.length;
  return avg < 3.5 ? 2 : 1;
}

/**
 * @returns {{spam: boolean, score: number, reasons: string[]}}
 */
function scoreEnquiry({ name = '', email = '', phone = '', message = '', honeypot = '', renderedAt = null }) {
  const reasons = [];
  let score = 0;

  // 1. Honeypot — decisive on its own.
  if (String(honeypot).trim()) {
    return { spam: true, score: 100, reasons: ['filled the hidden field'] };
  }

  // 2. Clock. Missing is not suspicious (a cached page, a resubmit); only an
  //    implausibly fast one is.
  //    Split, because the two ends mean different things. Under a second and a
  //    half nobody has typed a message — the browser can autofill a name and an
  //    email, but never the message, so that end is decisive. Between there and
  //    three seconds is merely fast, so it only contributes.
  if (renderedAt) {
    const elapsed = Date.now() - Number(renderedAt);
    if (elapsed >= 0 && elapsed < 1500) {
      score += 6;
      reasons.push(`submitted in ${(elapsed / 1000).toFixed(1)}s`);
    } else if (elapsed >= 0 && elapsed < 3000) {
      score += 3;
      reasons.push(`submitted in ${(elapsed / 1000).toFixed(1)}s`);
    }
  }

  // 3. The text.
  const nameScore = looksRandom(name.trim(), 12);
  if (nameScore) { score += nameScore; reasons.push('name reads as random characters'); }

  const msg = message.trim();
  if (msg.length >= 10 && !/\s/.test(msg)) {
    score += 2;
    reasons.push('message is a single unbroken string');
    const msgScore = looksRandom(msg, 10);
    if (msgScore) { score += msgScore; reasons.push('message reads as random characters'); }
  }

  const aliasScore = dottedAlias(email);
  if (aliasScore) { score += aliasScore; reasons.push('address uses dot-alias padding'); }

  // A bare national number with no country code, alongside anything else.
  if (/^\d{9,12}$/.test(phone.trim()) && score > 0) {
    score += 1;
    reasons.push('phone has no country code');
  }

  return { spam: score >= 6, score, reasons };
}

module.exports = { scoreEnquiry, looksRandom, vowelRatio, longestConsonantRun, caseFlips };
