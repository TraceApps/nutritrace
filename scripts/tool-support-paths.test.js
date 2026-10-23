/**
 * Trace still answers when the model can't use tools (TraceApps/nutritrace#259).
 *
 * An OpenAI-compatible gateway refused every request carrying `tools` for a
 * model without tool support, and the chat failed with a 500. Both paths
 * that send tools are run here against a stand-in endpoint that refuses
 * tools exactly as the report shows: the server's proxy (Trace set by
 * environment variables), the app through that proxy, and the app's direct
 * call (a personal setup).
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';
import { NO_TOOLS_NOTE } from '../src/lib/tool-support.js';

// The stand-in endpoint: `answer(body)` decides each reply; `seen` keeps the requests.
const upstream = { error_type: 'TOOL_USE_NOT_SUPPORTED', id: '2d1b4ad3-1622-4732-92b7-096410d39b1a', message: 'invalid request: tool use is not supported by the provided model: command-a-vision-07-2025' };
const REFUSAL = [400, { error: { message: `[400]: ${JSON.stringify(upstream)}` } }];
const reply = (message) => [200, { choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', ...message } }] }];
const toolless = (b) => (b.tools ? REFUSAL : reply({ content: 'Answer without tools.' }));
let answer = toolless;
const seen = [];
const endpoint = http.createServer((req, res) => {
  let raw = '';
  req.on('data', c => { raw += c; });
  req.on('end', () => {
    const body = JSON.parse(raw || '{}');
    seen.push(body);
    const [status, data] = answer(body);
    res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(data));
  });
});
await new Promise(r => endpoint.listen(0, '127.0.0.1', r));
const ENDPOINT = `http://127.0.0.1:${endpoint.address().port}`;
const fresh = (fn) => { seen.length = 0; answer = fn; };
const toldNoTools = (body) => body.messages[0].role === 'system' && body.messages[0].content.endsWith(`\n\n${NO_TOOLS_NOTE}`);

// The server's proxy, env-locked to the endpoint.
let db = null, dir = null, server = null, base = null;
try {
  const req = createRequire(new URL('../server/package.json', import.meta.url));
  req('better-sqlite3');
  dir = mkdtempSync(join(tmpdir(), 'tool-support-'));
  process.env.DB_PATH = join(dir, 'test.db');
  db = (await import('../server/db.js')).default;
  const express = req('express');
  const { default: aiRoutes } = await import('../server/routes/ai.js');
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.use('/api/ai', aiRoutes);
  // as the server answers an error: { error: message }, status 500
  app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
} catch { /* better-sqlite3 not built for this Node: the server cases skip */ }
test.after(() => { server?.close(); endpoint.close(); try { db?.close(); } catch {} if (dir) rmSync(dir, { recursive: true, force: true }); });

// The app's own AI calls, imported before any test is registered, as a
// browser at the server's address would load them.
globalThis.window ??= { __NT_CONFIG__: { basePath: base || '' }, location: { origin: base || '' } };
globalThis.localStorage ??= { getItem: () => null, setItem() {}, removeItem() {} };
const client = await import('../src/lib/aiChat.js');

const envLock = (model) => {
  const set = db.prepare('INSERT INTO app_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  for (const [k, v] of [['ai_enabled', 'true'], ['ai_provider', 'oai-compat'], ['ai_base_url', ENDPOINT], ['ai_model', model], ['ai_api_key', 'sk-test'], ['ai_env_locked', 'true']]) set.run(k, v);
};
const TOOLS = [{ name: 'get_diary', description: 'Get the diary', parameters: { type: 'object', properties: { date: { type: 'string' } } } }];
const chat = async (extra = {}) => {
  const r = await fetch(`${base}/api/ai/chat`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'How much protein today?' }], systemPrompt: 'You are Trace.', tools: TOOLS, ...extra }),
  });
  return { status: r.status, body: await r.json() };
};

test('server: a model that refuses tools answers without them, and the app is told', async (t) => {
  if (!db) return t.skip('better-sqlite3 is not built for this Node');
  envLock('command-a-vision-07-2025');
  fresh(toolless);
  const r = await chat();
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body, { text: 'Answer without tools.', toolsUnsupported: true });
  assert.equal(seen.length, 2);
  assert.ok(seen[0].tools && !seen[1].tools && !('tool_choice' in seen[1]));
  assert.ok(!toldNoTools(seen[0]) && toldNoTools(seen[1]), 'the retry tells the model no tools are available');

  // The next message skips the doomed first attempt.
  fresh(toolless);
  const again = await chat();
  assert.deepEqual(again.body, { text: 'Answer without tools.', toolsUnsupported: true });
  assert.equal(seen.length, 1);
  assert.ok(!seen[0].tools && toldNoTools(seen[0]));
});

test("server: a combo model (the reporter's setup) is asked again without tools each time, and the app is told it was routed", async (t) => {
  if (!db) return t.skip('better-sqlite3 is not built for this Node');
  envLock('my-20-model-combo');
  for (let i = 0; i < 2; i++) {
    fresh(toolless);
    const r = await chat();
    assert.deepEqual(r.body, { text: 'Answer without tools.', toolsUnsupported: true, toolsRouted: true });
    assert.equal(seen.length, 2, 'tools are offered again: the next pick may take them');
    assert.ok(seen[0].tools && !seen[1].tools && toldNoTools(seen[1]));
  }
});

test('server: an unrelated 400 still fails, after one request', async (t) => {
  if (!db) return t.skip('better-sqlite3 is not built for this Node');
  envLock('model-with-a-small-context');
  fresh(() => [400, { error: { message: "This model's maximum context length is 8192 tokens.", code: 'context_length_exceeded' } }]);
  const r = await chat();
  assert.equal(r.status, 500);
  assert.match(r.body.error, /maximum context length/);
  assert.equal(seen.length, 1);
});

test('server: a model that takes tools still gets them', async (t) => {
  if (!db) return t.skip('better-sqlite3 is not built for this Node');
  envLock('model-with-tools');
  fresh((b) => (b.tools ? reply({ content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_diary', arguments: '{"date":"2026-10-10"}' } }] }) : REFUSAL));
  const r = await chat();
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.toolCalls, [{ id: 'call_1', name: 'get_diary', args: { date: '2026-10-10' } }]);
  assert.equal(r.body.toolsUnsupported, undefined);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].tools[0].function.name, 'get_diary');
  assert.equal(seen[0].messages[0].content, 'You are Trace.');
});

test('server: a chat without tools (Smart Log) is sent once, as before', async (t) => {
  if (!db) return t.skip('better-sqlite3 is not built for this Node');
  envLock('command-a-vision-07-2025');
  fresh(toolless);
  const r = await chat({ tools: [] });
  assert.deepEqual(r.body, { text: 'Answer without tools.' });
  assert.equal(seen.length, 1);
  assert.ok(!('tools' in seen[0]));
  assert.equal(seen[0].messages[0].content, 'You are Trace.');
});

test('server: a tool round already in the conversation is sent as text to a tool-less model', async (t) => {
  if (!db) return t.skip('better-sqlite3 is not built for this Node');
  envLock('per-request-gateway');
  fresh(toolless);
  const r = await chat({ messages: [
    { role: 'user', content: 'What did I eat?' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_diary', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'call_1', name: 'get_diary', content: '{"items":["oats"]}' },
  ] });
  assert.equal(r.status, 200);
  const retry = seen[1].messages;
  assert.ok(retry.every(m => m.role !== 'tool' && !m.tool_calls));
  assert.equal(retry[retry.length - 1].content, '[Result of get_diary: {"items":["oats"]}]');
});

test('app through the server: the answer arrives and Trace is told, routed or not', async (t) => {
  if (!db) return t.skip('better-sqlite3 is not built for this Node');
  const viaServer = (onToolsUnsupported) => client.callAIProxy({
    messages: [{ role: 'user', content: 'How much protein today?' }], systemPrompt: 'You are Trace.', tools: TOOLS, onToolsUnsupported,
  });
  envLock('command-a-vision-07-2025');
  fresh(toolless);
  const told = [];
  assert.equal(await viaServer((info) => told.push(info)), 'Answer without tools.');
  envLock('my-20-model-combo');
  fresh(toolless);
  assert.equal(await viaServer((info) => told.push(info)), 'Answer without tools.');
  assert.deepEqual(told, [{ routed: false }, { routed: true }]);
});

// The app's direct call (a personal OpenAI-compatible setup).
client.setToolHandler(async (name) => ({ ok: true, name }));
const direct = (model, onToolsUnsupported) => client.callAI({
  provider: 'oai-compat', baseUrl: ENDPOINT, model, apiKey: '',
  messages: [{ role: 'user', content: 'How much protein today?' }], systemPrompt: 'You are Trace.',
  tools: client.TOOLS, onToolsUnsupported,
});

test('app: a model that refuses tools answers without them, and Trace is told', async () => {
  fresh(toolless);
  const told = [];
  assert.equal(await direct('command-a-vision-07-2025', (i) => told.push(i)), 'Answer without tools.');
  assert.deepEqual(told, [{ routed: false }]);
  assert.equal(seen.length, 2);
  assert.ok(seen[0].tools && !seen[1].tools && toldNoTools(seen[1]));

  fresh(toolless);
  assert.equal(await direct('command-a-vision-07-2025', (i) => told.push(i)), 'Answer without tools.');
  assert.equal(told.length, 2);
  assert.equal(seen.length, 1, 'the next message skips the doomed first attempt');
});

test('app: a combo model is asked again without tools, not remembered, and Trace is told it was routed', async () => {
  const told = [];
  for (let i = 0; i < 2; i++) {
    fresh(toolless);
    assert.equal(await direct('my-20-model-combo', (x) => told.push(x)), 'Answer without tools.');
    assert.equal(seen.length, 2);
  }
  assert.deepEqual(told, [{ routed: true }, { routed: true }]);
});

test('app: an unrelated 400 still fails, after one request', async () => {
  fresh(() => [400, { error: { message: 'Invalid API key format' } }]);
  await assert.rejects(direct('another-model'), /Invalid API key format/);
  assert.equal(seen.length, 1);
});

test('app: a model that takes tools still uses them', async () => {
  fresh((b) => (b.messages.some(m => m.role === 'tool')
    ? reply({ content: 'You had oats.' })
    : reply({ content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_diary', arguments: '{}' } }] })));
  let told = 0;
  assert.equal(await direct('model-with-tools', () => told++), 'You had oats.');
  assert.equal(told, 0);
  assert.equal(seen.length, 2);
  assert.ok(seen.every(b => b.tools?.length && !toldNoTools(b)));
});

test('app: a gateway that turns tool-less mid-answer gets the tool round as text', async () => {
  fresh((b) => {
    if (seen.length === 1) return reply({ content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_diary', arguments: '{}' } }] });
    return toolless(b);
  });
  let told = 0;
  assert.equal(await direct('per-request-gateway', () => told++), 'Answer without tools.');
  assert.equal(told, 1);
  assert.equal(seen.length, 3);
  assert.ok(seen[2].messages.every(m => m.role !== 'tool' && !m.tool_calls));
});

test('Trace adds the note once per conversation, in words for each setup, and never sends it', () => {
  const trace = readFileSync(new URL('../src/components/ai/Trace.svelte', import.meta.url), 'utf8');
  assert.match(trace, /callAIProxy\(\{[^}]*onToolsUnsupported \}\)/);
  assert.match(trace, /callAI\(\{[^}]*onToolsUnsupported \}\)/);
  assert.match(trace, /toolsNote = routed \? 'trace\.tools_unsupported_routed'\s*: aiEnvLocked \? 'trace\.tools_unsupported_server' : 'trace\.tools_unsupported';/);
  assert.match(trace, /messages = \[\.\.\.messages, \{ role: 'assistant', content: reply, time: fmtTime\(\) \}\];\s*if \(toolsNote\) messages = toolsNotice\.add\(messages, \$_\(toolsNote\)\);/);
  assert.match(trace, /messages = \[\];\s*toolsNotice\.reset\(\);/, 'a cleared chat is a new conversation');
  assert.match(trace, /const apiMessages {2}= forModel\(messages\)/, 'the note is never sent to a model');
  assert.match(trace, /\{#if msg\.role === 'note'\}\s*<div class="ai-note" role="status">/);
  const en = JSON.parse(readFileSync(new URL('../src/i18n/en.json', import.meta.url), 'utf8'));
  assert.match(en.trace.tools_unsupported, /Settings/);
  assert.match(en.trace.tools_unsupported_server, /admin/);
  assert.match(en.trace.tools_unsupported_routed, /nothing was logged or looked up/);
});
