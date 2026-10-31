/**
 * The edit time of a link filled in (src/lib/relink-stamp.js): the time the
 * row already had, a millisecond on, in the same second and on the same
 * clock, so it never counts as a change made now.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { relinkStamp } from '../src/lib/relink-stamp.js';
import { instantMs, laterThan } from '../src/lib/field-sync.js';

test('a phone-made time stays on the phone\'s clock, a millisecond on', () => {
  assert.equal(relinkStamp('2026-10-31T10:00:00.250Z'), '2026-10-31T10:00:00.251Z');
});

test('a time on the server\'s clock stays on it, as +00:00', () => {
  assert.equal(relinkStamp('2026-10-31T10:00:00.250+00:00'), '2026-10-31T10:00:00.251+00:00');
});

test('the server\'s own time (what a pull brings) is sent as +00:00, never bare', () => {
  // Bare, the server reads it as the phone's and shifts it by the phone's clock error.
  assert.equal(relinkStamp('2026-10-31 10:00:07'), '2026-10-31T10:00:07.001+00:00');
  assert.equal(relinkStamp('2026-10-31 10:00:07', { offsetMs: 600000 }), '2026-10-31T10:00:07.001+00:00');
});

test('it never moves into the next second', () => {
  assert.equal(relinkStamp('2026-10-31T10:00:00.999Z'), '2026-10-31T10:00:00.998Z');
  assert.equal(relinkStamp('2026-10-31T10:00:00.999+00:00'), '2026-10-31T10:00:00.998+00:00');
});

test('it always differs from the time it had, and is in the same second, for any millisecond', () => {
  for (let ms = 0; ms < 1000; ms++) {
    for (const suffix of ['Z', '+00:00']) {
      const was = `2026-10-31T10:00:00.${String(ms).padStart(3, '0')}${suffix}`;
      const now = relinkStamp(was);
      assert.notEqual(now, was);
      assert.equal(Math.floor(instantMs(now) / 1000), Math.floor(instantMs(was) / 1000), was);
      assert.equal(laterThan(now, was), false);
      assert.equal(laterThan(was, now), false);
    }
  }
  // Again and again, always different from the time it had just before
  // (what a push in flight holds is compared with the row's time now).
  let was = '2026-10-31T10:00:00.990Z';
  for (let i = 0; i < 30; i++) { const now = relinkStamp(was); assert.notEqual(now, was); was = now; }
});

test('a time it can\'t read loses to everything', () => {
  for (const v of [null, undefined, '', 'yesterday']) assert.equal(relinkStamp(v), '1970-01-01T00:00:00.001Z');
});

test('a row the server made in the push is linked no earlier than that push', () => {
  const at = Date.parse('2026-10-31T10:00:05.000Z');
  // Its own time is from before the server had it.
  assert.equal(relinkStamp('2026-10-31T09:00:00.000Z', { notBefore: at }), '2026-10-31T10:00:05.001+00:00');
  assert.equal(relinkStamp('2026-10-31 09:00:00', { notBefore: at }), '2026-10-31T10:00:05.001+00:00');
  // A change made since is later: it keeps its own time.
  assert.equal(relinkStamp('2026-10-31T10:00:09.000Z', { notBefore: at }), '2026-10-31T10:00:09.001Z');
  // The phone's clock error is allowed for when comparing a phone-made time.
  assert.equal(relinkStamp('2026-10-31T09:50:08.000Z', { notBefore: at, offsetMs: 600000 }), '2026-10-31T09:50:08.001Z');
  assert.equal(relinkStamp('2026-10-31T09:50:08.000Z', { notBefore: at, offsetMs: 300000 }), '2026-10-31T10:00:05.001+00:00');
  // Nothing to go by: no floor.
  assert.equal(relinkStamp('2026-10-31T09:00:00.000Z', { notBefore: NaN }), '2026-10-31T09:00:00.001Z');
});
