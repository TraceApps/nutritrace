/**
 * A reply with no words and no tool call is never used as Trace's answer
 * (TraceApps/nutritrace#286, the same in every Trace app).
 *
 * The report: an OpenAI-compatible server answered 200 with empty content
 * and finish_reason "stop". Trace showed a blank answer, and saving it to
 * the history was refused (400) without a word. Now that one request is
 * sent once more, and a second empty reply is said as an error. A
 * stand-in endpoint answers the way theirs did, for the app directly and
 * through the server's own chat (Trace set by environment variables), in
 * OpenAI's, Claude's and Gemini's shapes.
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';
import { stoppedShort, stoppedShortError, resendIfEmpty } from '../src/lib/trace-reply.js';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

test('stoppedShort: no words and no tool call is empty, in every format', () => {
  const openai = (message, finish_reason = 'stop') => ({ choices: [{ index: 0, finish_reason, message: { role: 'assistant', ...message } }] });
  assert.equal(stoppedShort('openai', openai({ content: '' })), 'empty', "the report's reply");
  assert.equal(stoppedShort('openai', openai({ content: null })), 'empty');
  assert.equal(stoppedShort('openai', openai({ content: ' \n\t ' })), 'empty', 'only spaces');
  assert.equal(stoppedShort('openai', openai({ content: [{ type: 'text', text: ' ' }] })), 'empty', 'parts with no words');
  assert.equal(stoppedShort('openai', { choices: [] }), 'empty', 'no choice at all');
  assert.equal(stoppedShort('claude', { content: [], stop_reason: 'end_turn' }), 'empty');
  assert.equal(stoppedShort('claude', { content: [{ type: 'text', text: '  ' }], stop_reason: 'end_turn' }), 'empty');
  assert.equal(stoppedShort('gemini', { candidates: [{ content: { parts: [] }, finishReason: 'STOP' }] }), 'empty');
  assert.equal(stoppedShort('gemini', { candidates: [{ content: { parts: [{ text: '\n' }] }, finishReason: 'STOP' }] }), 'empty');
  assert.equal(stoppedShort('gemini', { candidates: [{ finishReason: 'STOP' }] }), 'empty', 'no content at all');
});

test('stoppedShort: a reply with words or a tool call is unchanged', () => {
  const openai = (message, finish_reason = 'stop') => ({ choices: [{ index: 0, finish_reason, message: { role: 'assistant', ...message } }] });
  const call = [{ id: 'c1', type: 'function', function: { name: 'lookup', arguments: '{}' } }];
  assert.equal(stoppedShort('openai', openai({ content: 'Logged.' })), null, 'text only');
  assert.equal(stoppedShort('openai', openai({ content: null, tool_calls: call }, 'tool_calls')), null, 'tool calls only');
  assert.equal(stoppedShort('openai', openai({ content: '', tool_calls: call }, 'tool_calls')), null, 'tool calls, empty content');
  assert.equal(stoppedShort('openai', openai({ content: [{ type: 'text', text: 'Logged.' }] })), null, 'parts with words');
  assert.equal(stoppedShort('openai', openai({ content: null, reasoning_content: 'Hmm.' })), 'thinking', 'reasoning only is still thinking');
  assert.equal(stoppedShort('openai', openai({ content: '', reasoning: 'Hmm.' })), 'thinking');
  assert.equal(stoppedShort('openai', openai({ content: '\n\n', reasoning_content: 'Hmm.' })), 'thinking', 'only spaces after the reasoning is thinking too');
  assert.equal(stoppedShort('openai', openai({ content: [], reasoning: 'Hmm.' })), 'thinking');
  assert.equal(stoppedShort('openai', openai({ content: '' }, 'length')), 'length', 'cut off with nothing yet is still length');
  assert.equal(stoppedShort('openai', openai({ content: 'Half' }, 'length')), 'length');
  assert.equal(stoppedShort('claude', { content: [{ type: 'text', text: 'Logged.' }], stop_reason: 'end_turn' }), null);
  assert.equal(stoppedShort('claude', { content: [{ type: 'tool_use', id: 't1', name: 'lookup', input: {} }], stop_reason: 'tool_use' }), null);
  assert.equal(stoppedShort('claude', { content: [], stop_reason: 'max_tokens' }), 'length');
  assert.equal(stoppedShort('gemini', { candidates: [{ content: { parts: [{ text: 'Logged.' }] }, finishReason: 'STOP' }] }), null);
  assert.equal(stoppedShort('gemini', { candidates: [{ content: { parts: [{ functionCall: { name: 'lookup', args: {} } }] }, finishReason: 'STOP' }] }), null);
  assert.equal(stoppedShort('gemini', { candidates: [{ content: { parts: [] }, finishReason: 'MAX_TOKENS' }] }), 'length');
});

test('resendIfEmpty: the same request once more, only once', async () => {
  const empty = { ok: true, status: 200, data: { choices: [{ finish_reason: 'stop', message: { content: '' } }] } };
  const text = { ok: true, status: 200, data: { choices: [{ finish_reason: 'stop', message: { content: 'Logged.' } }] } };
  const run = async (replies) => {
    const bodies = [];
    const out = await resendIfEmpty('openai', { model: 'm', messages: [1] }, async (b) => { bodies.push(b); return replies[Math.min(bodies.length - 1, replies.length - 1)]; });
    return { out, bodies };
  };
  let r = await run([text]);
  assert.equal(r.bodies.length, 1, 'an answer goes once');
  r = await run([empty, text]);
  assert.equal(r.bodies.length, 2);
  assert.deepEqual(r.bodies[1], r.bodies[0], 'the same request');
  assert.equal(r.out, text);
  r = await run([empty, empty, text]);
  assert.equal(r.bodies.length, 2, 'never a third time');
  assert.equal(stoppedShort('openai', r.out.data), 'empty');
  r = await run([empty, { ok: false, status: 500, data: { error: { message: 'down' } } }]);
  assert.equal(r.out, empty, "a second try that fails: the first reply, said as empty, and nothing else sent");
  r = await run([{ ok: false, status: 400, data: {} }]);
  assert.equal(r.bodies.length, 1, 'a refusal is not resent here');
  let n = 0;
  const thrown = await resendIfEmpty('openai', {}, async () => { if (n++) throw new SyntaxError('Unexpected token <'); return empty; });
  assert.equal(thrown, empty, 'a second try that throws (an HTML error page): the first reply, said as empty');
  n = 0;
  await assert.rejects(resendIfEmpty('openai', {}, async () => { if (n++) throw Object.assign(new Error('stopped'), { name: 'AbortError' }); return empty; }), { name: 'AbortError' }, 'a cancel stays a cancel');
});

test('the message, and the app says it in English', () => {
  const e = stoppedShortError('empty');
  assert.equal(e.code, 'trace_stopped_empty');
  assert.equal(e.message, 'The model sent back an empty answer. Anything Trace already did this turn is kept, so check before asking again.');
  assert.equal(JSON.parse(read('../src/i18n/en.json')).trace_reply.stopped_empty, e.message);
});

// The stand-in: answers in turn from `plan` (then `rest`): 'empty', 'blank',
// 'text' or 'tool', in the shape of whoever was asked.
let plan = [], rest = 'text';
const seen = [];
const reply = (url, kind) => {
  if (url.startsWith('/claude')) {
    if (kind === 'tool') return { content: [{ type: 'tool_use', id: `tu_${seen.length}`, name: 'lookup', input: {} }], stop_reason: 'tool_use' };
    const content = kind === 'text' ? [{ type: 'text', text: 'Logged your lunch.' }] : kind === 'blank' ? [{ type: 'text', text: ' \n' }] : [];
    return { content, stop_reason: 'end_turn' };
  }
  if (url.startsWith('/gemini')) {
    if (kind === 'tool') return { candidates: [{ content: { role: 'model', parts: [{ functionCall: { name: 'lookup', args: {} } }] }, finishReason: 'STOP' }] };
    const parts = kind === 'text' ? [{ text: 'Logged your lunch.' }] : kind === 'blank' ? [{ text: ' \n' }] : [];
    return { candidates: [{ content: { role: 'model', parts }, finishReason: 'STOP' }] };
  }
  if (kind === 'tool') return { choices: [{ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: [{ id: `call_${seen.length}`, type: 'function', function: { name: 'lookup', arguments: '{}' } }] } }] };
  const content = kind === 'text' ? 'Logged your lunch.' : kind === 'blank' ? ' \n' : '';
  return { choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content } }], usage: { completion_tokens: 1 } };
};
const endpoint = http.createServer((req, res) => {
  let raw = '';
  req.on('data', c => { raw += c; });
  req.on('end', () => {
    seen.push({ path: req.url, body: JSON.parse(raw || '{}') });
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(reply(req.url, plan.shift() ?? rest)));
  });
});
await new Promise(r => endpoint.listen(0, '127.0.0.1', r));
const ENDPOINT = `http://127.0.0.1:${endpoint.address().port}`;
const fresh = (p = [], r = 'text') => { seen.length = 0; plan = [...p]; rest = r; toolCalls.length = 0; };

// The server's own chat, set to the stand-in.
let db = null, dir = null, server = null, base = null;
try {
  const req = createRequire(new URL('../server/package.json', import.meta.url));
  req('better-sqlite3');
  dir = mkdtempSync(join(tmpdir(), 'trace-empty-'));
  process.env.DB_PATH = join(dir, 'test.db');
  db = (await import('../server/db.js')).default;
  const express = req('express');
  const { default: aiRoutes } = await import('../server/routes/ai.js');
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.use('/api/ai', aiRoutes);
  app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
} catch { /* better-sqlite3 not built for this Node: the server cases skip */ }
test.after(() => { server?.close(); endpoint.close(); try { db?.close(); } catch {} if (dir) rmSync(dir, { recursive: true, force: true }); });

globalThis.BroadcastChannel = undefined;
globalThis.localStorage ??= { getItem: () => null, setItem() {}, removeItem() {} };
const _fetch = globalThis.fetch;
globalThis.fetch = (url, opts) => {
  const u = String(url);
  if (u.startsWith('/')) return _fetch(`${base}${u}`, opts);
  if (u.startsWith('https://api.anthropic.com')) return _fetch(`${ENDPOINT}/claude`, opts);
  if (u.startsWith('https://generativelanguage.googleapis.com')) return _fetch(`${ENDPOINT}/gemini`, opts);
  if (u.startsWith('https://api.openai.com')) return _fetch(u.replace('https://api.openai.com', ENDPOINT), opts);
  return _fetch(url, opts);
};
const client = await import('../src/lib/aiChat.js');
const toolCalls = [];
client.setToolHandler(async (name, args) => { toolCalls.push({ name, args }); return { ok: true }; });
const TOOLS = [{ name: 'lookup', description: 'Look something up', parameters: { type: 'object', properties: {} } }];

const PROVIDERS = {
  'oai-compat': { provider: 'oai-compat', baseUrl: ENDPOINT, model: 'gemma4:31b', apiKey: '' },
  claude: { provider: 'claude', apiKey: 'sk-ant', model: 'claude-sonnet-4-5' },
  gemini: { provider: 'gemini', apiKey: 'g', model: 'gemini-3-flash' },
};
const ask = (p, o = {}) => client.callAI({ ...PROVIDERS[p], messages: [{ role: 'user', content: 'Log a turkey sandwich for lunch.' }], systemPrompt: 'You are Trace.', ...o });
const isEmpty = (e) => e.code === 'trace_stopped_empty';

for (const p of Object.keys(PROVIDERS)) {
  test(`${p}, from the app: an empty reply is asked for once more, and a second one is said`, async () => {
    fresh([], 'empty');
    await assert.rejects(ask(p), isEmpty, "the report's reply: an error, not a blank answer");
    assert.equal(seen.length, 2, 'sent once more, only once');
    assert.deepEqual(seen[1].body, seen[0].body, 'the same request');
    fresh([], 'blank');
    await assert.rejects(ask(p), isEmpty, 'only spaces');
    assert.equal(seen.length, 2);
    fresh(['empty'], 'text');
    assert.equal(await ask(p), 'Logged your lunch.', 'a second reply with words is the answer');
    assert.equal(seen.length, 2);
    fresh([], 'text');
    assert.equal(await ask(p), 'Logged your lunch.');
    assert.equal(seen.length, 1, 'an answer goes once');
  });

  test(`${p}, from the app: after a tool ran, only that request goes again, and the tool never runs twice`, async () => {
    fresh(['tool', 'empty'], 'text');
    assert.equal(await ask(p, { tools: TOOLS }), 'Logged your lunch.');
    assert.equal(toolCalls.length, 1);
    assert.equal(seen.length, 3);
    assert.deepEqual(seen[2].body, seen[1].body, 'the round after the tool, as it was');
    fresh(['tool'], 'empty');
    await assert.rejects(ask(p, { tools: TOOLS }), isEmpty);
    assert.equal(toolCalls.length, 1, 'the tool ran once');
    assert.equal(seen.length, 3);
  });

  test(`${p}, from the app: out of rounds, nothing at all is said as running out, as before`, async () => {
    fresh(Array(12).fill('tool'), 'empty');
    assert.match(await ask(p, { tools: TOOLS }), /more steps than one answer allows/);
    assert.equal(toolCalls.length, 12);
    assert.equal(seen.length, 14, 'the last request asked once more, only once');
  });
}

const envLock = (provider, model) => {
  const set = db.prepare('INSERT INTO app_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  for (const [k, v] of [['ai_enabled', 'true'], ['ai_provider', provider], ['ai_base_url', ENDPOINT], ['ai_model', model], ['ai_api_key', 'sk-test'], ['ai_env_locked', 'true']]) set.run(k, v);
};

test("the server's own chat: the same, once on the server and never again from the app", async (t) => {
  if (!db) return t.skip('better-sqlite3 is not built for this Node');
  const proxy = (o = {}) => client.callAIProxy({ messages: [{ role: 'user', content: 'Log a turkey sandwich for lunch.' }], systemPrompt: 'You are Trace.', ...o });
  for (const [p, model] of [['oai-compat', 'gemma4:31b'], ['claude', 'claude-sonnet-4-5'], ['gemini', 'gemini-3-flash']]) {
    envLock(p, model);
    fresh([], 'empty');
    await assert.rejects(proxy(), isEmpty, `${p}: said, with its code`);
    assert.equal(seen.length, 2, `${p}: two requests in all`);
    fresh(['empty'], 'text');
    assert.equal(await proxy(), 'Logged your lunch.', p);
    assert.equal(seen.length, 2);
    fresh(['tool', 'empty'], 'text');
    assert.equal(await proxy({ tools: TOOLS }), 'Logged your lunch.', p);
    assert.equal(toolCalls.length, 1, `${p}: the tool ran once`);
    assert.equal(seen.length, 3);
    fresh(Array(12).fill('tool'), 'empty');
    assert.match(await proxy({ tools: TOOLS }), /more steps than one answer allows/, `${p}: out of rounds, as before`);
    assert.equal(seen.length, 14);
  }
  // The server says it as it says a reply cut off: 422 and its code.
  envLock('oai-compat', 'gemma4:31b');
  fresh([], 'empty');
  const res = await _fetch(`${base}/api/ai/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ messages: [{ role: 'user', content: 'Hi' }], systemPrompt: 'You are Trace.' }) });
  assert.equal(res.status, 422);
  assert.equal((await res.json()).code, 'trace_stopped_empty');
});

test('Trace never shows or saves an empty answer', () => {
  const src = read('../src/components/ai/Trace.svelte');
  const guard = src.search(/if \(!String\(reply \?\? ''\)\.trim\(\)\) throw new Error\(\$_\('trace_reply\.stopped_empty'\)\);/);
  const shown = src.indexOf("{ role: 'assistant', content: reply");
  const saved = src.indexOf("NtApi.post('/api/ai/history', { role: 'assistant', content: reply })");
  assert.ok(guard > 0, 'the check is there');
  assert.ok(shown > guard && saved > guard, 'before the reply is shown or saved');
  assert.equal(src.slice(guard, shown).split('\n').length, 2, 'right before it');
});
