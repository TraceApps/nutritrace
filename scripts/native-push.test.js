/**
 * The Android app's own pushes (src/lib/notifications.js sendPush) carry
 * their message.
 *
 * Capacitor's Android HTTP sends no body at all when a request has no
 * Content-Type (CapacitorHttpUrlConnection.setRequestBody), and the ntfy
 * push had none: ntfy got the title with an empty message and showed
 * "triggered". Runs the app's own module as the phone does, through
 * scripts/fixtures/native-sync, whose CapacitorHttp sends a body by the same
 * rule, and records what would reach each service.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

await import('./fixtures/native-sync/register.mjs');
const sent = [];
globalThis.fetch = async (url, init = {}) => {
  sent.push({ url: String(url), method: init.method, headers: Object.fromEntries(Object.entries(init.headers || {}).map(([k, v]) => [k.toLowerCase(), v])), body: init.body });
  return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
};
const { settingPrefix } = await import('../src/lib/setting-key.js');
const { sendPush } = await import('../src/lib/notifications.js');

const set = (k, v) => localStorage.setItem(settingPrefix() + k, JSON.stringify(v));
const TITLE = '🎯 Protein Goal Reached', MESSAGE = 'You hit 150 g of protein today.';

test('ntfy: the message goes as the body, with the title, priority and token', async () => {
  sent.length = 0;
  set('ntfyUrl', 'https://ntfy.example/'); set('ntfyTopic', 'meals'); set('ntfyToken', 'tk_1');
  await sendPush('ntfy', TITLE, MESSAGE, 4);
  assert.equal(sent.length, 1);
  const [r] = sent;
  assert.equal(r.url, 'https://ntfy.example/meals');
  assert.equal(r.method, 'POST');
  assert.equal(r.body, MESSAGE, 'the message reaches ntfy');
  assert.match(r.headers['content-type'], /^text\/plain/);
  assert.equal(r.headers.title, TITLE);
  assert.equal(r.headers.priority, '4');
  assert.equal(r.headers.authorization, 'Bearer tk_1');
});

test('Gotify and Apprise: their JSON goes as before', async () => {
  sent.length = 0;
  set('gotifyUrl', 'https://gotify.example'); set('gotifyToken', 'g1');
  set('appriseUrl', 'https://apprise.example'); set('appriseTag', 'food');
  await sendPush('gotify', TITLE, MESSAGE, 5);
  await sendPush('apprise', TITLE, MESSAGE, 5);
  assert.deepEqual(sent.map(r => [r.url, r.headers['content-type'], JSON.parse(r.body)]), [
    ['https://gotify.example/message?token=g1', 'application/json', { title: TITLE, message: MESSAGE, priority: 5 }],
    ['https://apprise.example/notify', 'application/json', { title: TITLE, body: MESSAGE, type: 'info', tag: 'food' }],
  ]);
});
