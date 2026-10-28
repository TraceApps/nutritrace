/**
 * request-deadline.js, the same file in all four Trace apps: a server that
 * answers again stops counting as quiet whatever it answered, a quiet spell
 * that a server slower than the quiet reads is caught in still ends, heavy
 * reads get longer, a request given no deadline (a change that is sent)
 * waits as long as it takes, and a change sent before a quiet spell keeps
 * the next ones from going around it.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  READ_MS, HEAVY_READ_MS, QUIET_READ_MS, QUIET_FOR_MS,
  noteQuiet, noteAnswered, isQuiet, readDeadlineFor, fetchWithDeadline, queueUnsent,
} from '../src/lib/request-deadline.js';

const wait = (ms) => new Promise(r => setTimeout(r, ms));
/** A send that answers after `ms`, or gives up when its signal does. */
const answersAfter = (ms) => (url, init) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => resolve({ ok: true, status: 200 }), ms);
  init.signal?.addEventListener('abort', () => { clearTimeout(timer); reject(init.signal.reason); }, { once: true });
});

test('reads by kind: slow ones wait as long as they take, heavy ones longer, all short while quiet', () => {
  noteAnswered();
  assert.equal(readDeadlineFor('read'), READ_MS);
  assert.equal(readDeadlineFor('heavy'), HEAVY_READ_MS);
  assert.equal(readDeadlineFor('slow'), null);
  assert.ok(HEAVY_READ_MS > READ_MS);
  const now = 5_000_000;
  noteQuiet(now);
  assert.equal(readDeadlineFor('read', now + 1), QUIET_READ_MS);
  assert.equal(readDeadlineFor('heavy', now + 1), QUIET_READ_MS);
  assert.equal(readDeadlineFor('slow', now + 1), null);
  noteAnswered();
});

test('a quiet spell ends even when every quiet read runs out', () => {
  // A server answering reads in two seconds, missed once: each quiet read
  // (1.5 s) runs out too. Those don't start the spell again, so the next
  // read after it gets the full deadline and finds the server.
  noteAnswered();
  const start = 10_000_000;
  noteQuiet(start);
  for (let t = start + QUIET_READ_MS; t < start + QUIET_FOR_MS; t += QUIET_READ_MS) noteQuiet(t);
  assert.equal(isQuiet(start + QUIET_FOR_MS - 1), true);
  assert.equal(isQuiet(start + QUIET_FOR_MS), false, 'the spell ends on time');
  assert.equal(readDeadlineFor('read', start + QUIET_FOR_MS), READ_MS);
  noteAnswered();
});

test('any answer from the server ends the quiet spell, a read included', async () => {
  noteQuiet();
  assert.equal(isQuiet(), true);
  const res = await fetchWithDeadline(answersAfter(5), '/api/notes', {}, 1000);
  assert.equal(res.status, 200);
  assert.equal(isQuiet(), false);
  // An error status is the server answering too.
  noteQuiet();
  await fetchWithDeadline(async () => ({ ok: false, status: 500 }), '/api/notes', {}, 1000);
  assert.equal(isQuiet(), false);
});

test('a request that runs out of time makes the server quiet and reads as no connection', async () => {
  noteAnswered();
  await assert.rejects(fetchWithDeadline(answersAfter(500), '/api/notes', {}, 20), (err) => err.offline === true && err.name === 'TimeoutError');
  assert.equal(isQuiet(), true);
  noteAnswered();
});

test('a request given no deadline waits as long as it takes', async () => {
  // A change that is sent: the offline layers give it none, so a slow
  // server's answer is waited for, and nothing counts as quiet.
  noteAnswered();
  const res = await fetchWithDeadline(answersAfter(150), '/api/notes', { method: 'POST', body: '{"title":"a"}' }, null);
  assert.equal(res.status, 200);
  assert.equal(isQuiet(), false);
  await wait(0);
});

test('a caller\'s signal loses the deadline\'s listener once the answer starts', async () => {
  const own = new AbortController();
  let added = 0, removed = 0;
  const add = own.signal.addEventListener.bind(own.signal), remove = own.signal.removeEventListener.bind(own.signal);
  own.signal.addEventListener = (...a) => { added++; return add(...a); };
  own.signal.removeEventListener = (...a) => { removed++; return remove(...a); };
  for (let i = 0; i < 3; i++) await fetchWithDeadline(answersAfter(1), '/api/notes', { signal: own.signal }, 1000);
  assert.equal(added, 3);
  assert.equal(removed, 3, 'each request takes its listener away');
  // Still the caller's to stop while a request waits.
  const waiting = fetchWithDeadline(answersAfter(500), '/api/notes', { signal: own.signal }, 1000);
  own.abort();
  await assert.rejects(waiting, (err) => err.name === 'AbortError' && !err.offline);
  noteAnswered();
});

test('a change still on its way keeps the next ones from going around it while quiet', async () => {
  noteAnswered();
  let fail;
  const first = fetchWithDeadline(() => new Promise((_, reject) => { fail = reject; }), '/api/diary/2026-10-27', { method: 'put' }, null);
  noteQuiet();
  assert.equal(isQuiet(), true);
  assert.equal(queueUnsent(), false, 'sent too, so the older one fails first and is queued first');
  // A read on its way doesn't count.
  const read = fetchWithDeadline(() => new Promise(() => {}), '/api/notes', {}, null);
  fail(new TypeError('Failed to fetch'));
  await assert.rejects(first, (err) => err.name === 'TypeError');
  assert.equal(queueUnsent(), true, 'nothing sent is waiting: the outbox, unsent');
  void read;
  noteAnswered();
  assert.equal(queueUnsent(), false);
});
