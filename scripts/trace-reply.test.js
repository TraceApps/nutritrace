/**
 * Trace's replies aren't cut off at 4,096 tokens, and a reply that stops
 * short is said, never used (TraceApps/notetrace#23, the same in every
 * Trace app).
 *
 * The report: a reasoning model on the reporter's own server spent 4,096
 * tokens and stopped ("Max tokens"), and Trace said it returned nothing. A
 * stand-in endpoint answers as their server did, and as vLLM before 0.32
 * does when a request asks for more than its context has left, for the app
 * directly and through the server's own chat (Trace set by environment
 * variables).
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';

test('the app and the server use the same trace-reply.js', () => {
  assert.equal(readFileSync(new URL('../server/lib/trace-reply.js', import.meta.url), 'utf8'),
    readFileSync(new URL('../src/lib/trace-reply.js', import.meta.url), 'utf8'));
});

// The stand-in: an answer `need` tokens long, cut at the reply limit asked
// for. With `context` set, a request whose prompt and reply don't fit is
// refused as vLLM 0.18 to 0.31 does (`oldShape`: as vLLM before 0.11 did;
// `router`: as OpenRouter does). `modelMax`: a model that can't write more
// than that, as Anthropic and OpenAI refuse it. `promptTooLong`: a prompt
// too long on its own. `perMinute`: a per-minute token limit that counts the
// reply asked for, as Groq's free tier refuses it (413).
let need = 100, context = 0, oldShape = false, router = false, shape = 'text', modelMax = 0, promptTooLong = false, perMinute = 0;
const seen = [];
const promptTokens = (b) => Math.ceil(JSON.stringify(b.messages || b.contents || []).length / 4);
const openaiReply = (b) => {
  const max = b.max_tokens ?? b.max_completion_tokens ?? Infinity;
  const p = promptTokens(b);
  if (perMinute && p + max > perMinute) return [413, { error: { message: `Request too large for model \`llama-3.1-8b-instant\` in organization \`org_test\` service tier \`on_demand\` on tokens per minute (TPM): Limit ${perMinute}, Requested ${p + max}, please reduce your message size and try again.`, type: 'tokens', code: 'rate_limit_exceeded' } }];
  if (promptTooLong) return [400, { error: { message: "This model's maximum context length is 8192 tokens. However, your request has 9000 input tokens. Please reduce the length of the input messages.", type: 'BadRequestError', code: 400 } }];
  if (modelMax && max > modelMax) return [400, { error: { message: `max_tokens is too large: ${max}. This model supports at most ${modelMax} completion tokens, whereas you provided ${max}.`, type: 'invalid_request_error', param: 'max_tokens', code: 'invalid_value' } }];
  if (context && p + max > context) {
    if (router) return [400, { error: { message: `This endpoint's maximum context length is ${context} tokens. However, you requested about ${p + max} tokens (${p} of text input, ${max} in the output). Please reduce the length of either one.`, code: 400 } }];
    const message = `This model's maximum context length is ${context} tokens. However, you requested ${max} output tokens and your prompt contains ${p} input tokens, for a total of ${p + max} tokens. Please reduce the length of the input prompt or the number of requested output tokens.`;
    return [400, oldShape ? { object: 'error', message, type: 'BadRequestError', param: null, code: 400 } : { error: { message, type: 'BadRequestError', param: 'input_tokens', code: 400 } }];
  }
  const n = Math.min(max, need);
  const finish_reason = n < need ? 'length' : 'stop';
  if (shape === 'reasoning') return [200, { choices: [{ index: 0, finish_reason, message: { role: 'assistant', content: null, reasoning_content: 'Let me think about this note.' } }] }];
  if (shape === 'tool') return [200, { choices: [{ index: 0, finish_reason, message: { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'search_notes', arguments: '{"q":"tom' } }] } }] }];
  return [200, { choices: [{ index: 0, finish_reason, message: { role: 'assistant', content: `words:${n}` } }] }];
};
const endpoint = http.createServer((req, res) => {
  let raw = '';
  req.on('data', c => { raw += c; });
  req.on('end', () => {
    const body = JSON.parse(raw || '{}');
    seen.push({ path: req.url, body });
    let out;
    if (req.url.startsWith('/claude')) {
      const n = Math.min(body.max_tokens, need);
      out = modelMax && body.max_tokens > modelMax
        ? [400, { type: 'error', error: { type: 'invalid_request_error', message: `max_tokens: ${body.max_tokens} > ${modelMax}, which is the maximum allowed number of output tokens for claude-3-haiku-20240307` } }]
        : [200, { content: [{ type: 'text', text: `words:${n}` }], stop_reason: n < need ? 'max_tokens' : 'end_turn' }];
    } else if (req.url.startsWith('/gemini')) {
      out = [200, { candidates: [{ content: { parts: [{ text: 'words:some' }] }, finishReason: need > 8192 ? 'MAX_TOKENS' : 'STOP' }] }];
    } else out = openaiReply(body);
    res.writeHead(out[0], { 'Content-Type': 'application/json' }).end(JSON.stringify(out[1]));
  });
});
await new Promise(r => endpoint.listen(0, '127.0.0.1', r));
const ENDPOINT = `http://127.0.0.1:${endpoint.address().port}`;
const fresh = (o = {}) => { seen.length = 0; need = o.need ?? 100; context = o.context ?? 0; oldShape = !!o.oldShape; router = !!o.router; shape = o.shape ?? 'text'; modelMax = o.modelMax ?? 0; promptTooLong = !!o.promptTooLong; perMinute = o.perMinute ?? 0; };
const asked = () => seen.map(s => s.body.max_tokens ?? s.body.max_completion_tokens);

// The server's own chat, set to the stand-in.
let db = null, dir = null, server = null, base = null;
try {
  const req = createRequire(new URL('../server/package.json', import.meta.url));
  req('better-sqlite3');
  dir = mkdtempSync(join(tmpdir(), 'trace-reply-'));
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

// The app's own Trace. Requests to /api/... go to the test server; the
// providers' own addresses go to the stand-in.
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

const ask = (o = {}) => client.callAI({
  provider: 'oai-compat', baseUrl: ENDPOINT, model: 'qwen3-local', apiKey: '',
  messages: [{ role: 'user', content: 'Tidy up this note.' }], systemPrompt: 'You are Trace.', ...o,
});
const envLock = (provider, model = 'qwen3-local') => {
  const set = db.prepare('INSERT INTO app_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  for (const [k, v] of [['ai_enabled', 'true'], ['ai_provider', provider], ['ai_base_url', ENDPOINT], ['ai_model', model], ['ai_api_key', 'sk-test'], ['ai_env_locked', 'true']]) set.run(k, v);
};

test("own server: a reply longer than 4,096 tokens arrives whole (the report's cut-off)", async () => {
  fresh({ need: 6000 });
  assert.equal(await ask(), 'words:6000');
  assert.deepEqual(asked(), [16384]);
});

test('own server that refuses that many (vLLM before 0.32): asked again with 4,096, as before', async () => {
  fresh({ need: 1000, context: 8192 });
  assert.equal(await ask(), 'words:1000');
  assert.deepEqual(asked(), [16384, 4096]);
  fresh({ need: 1000, context: 8192, oldShape: true });
  assert.equal(await ask(), 'words:1000', "vLLM's older error shape too");
  fresh({ need: 1000, context: 8192, router: true });
  assert.equal(await ask(), 'words:1000', "OpenRouter's, which says the number asked for");
  fresh({ need: 1000, perMinute: 6000 });
  assert.equal(await ask(), 'words:1000', "a per-minute limit that counts the reply asked for (Groq's free tier)");
  assert.deepEqual(asked(), [16384, 4096]);
  // Too little room even for 4,096: refused again, and that refusal is said.
  fresh({ need: 1000, context: 10 });
  await assert.rejects(ask(), /maximum context length/);
  assert.deepEqual(asked(), [16384, 4096]);
  // A prompt too long on its own isn't about the reply: one request.
  fresh({ promptTooLong: true });
  await assert.rejects(ask(), /maximum context length/);
  assert.deepEqual(asked(), [16384]);
});

test('a reply cut off at its limit is said, not used', async () => {
  fresh({ need: 20000 });
  await assert.rejects(ask(), (e) => e.code === 'trace_stopped_length');
  fresh({ need: 20000, shape: 'reasoning' });
  await assert.rejects(ask(), (e) => e.code === 'trace_stopped_thinking', 'reasoning with no answer');
  fresh({ need: 10, shape: 'reasoning' });
  await assert.rejects(ask(), (e) => e.code === 'trace_stopped_thinking', 'reasoning with no answer, even when it stopped on its own');
});

test('a tool call cut off at its limit is never run', async () => {
  fresh({ need: 20000, shape: 'tool' });
  toolCalls.length = 0;
  await assert.rejects(ask({ tools: client.TOOLS }), (e) => e.code === 'trace_stopped_length');
  assert.deepEqual(toolCalls, []);
});

test('named providers: the longer limit too, an older model asked again as before, and a reply that stopped short said', async () => {
  const claude = { provider: 'claude', apiKey: 'sk-ant', model: 'claude-sonnet-4-5' };
  fresh({ need: 6000 });
  assert.equal(await ask(claude), 'words:6000');
  assert.deepEqual(asked(), [16384]);
  fresh({ need: 100, modelMax: 4096 });
  assert.equal(await ask({ ...claude, model: 'claude-3-haiku-20240307' }), 'words:100');
  assert.deepEqual(asked(), [16384, 4096], 'a model that writes at most 4,096');
  fresh({ need: 20000 });
  await assert.rejects(ask(claude), (e) => e.code === 'trace_stopped_length');
  const openai = { provider: 'openai', apiKey: 'sk', model: 'gpt-5.5', baseUrl: undefined };
  fresh({ need: 6000 });
  assert.equal(await ask(openai), 'words:6000', "a reasoning model's thinking and answer fit");
  assert.deepEqual(seen.map(x => x.body.max_completion_tokens), [16384]);
  fresh({ need: 100, modelMax: 4096 });
  assert.equal(await ask({ ...openai, model: 'gpt-4-turbo' }), 'words:100');
  assert.deepEqual(seen.map(x => x.body.max_completion_tokens), [16384, 4096]);
  fresh({ need: 9000 });
  await assert.rejects(ask({ provider: 'gemini', apiKey: 'g', model: 'gemini-3-flash' }), (e) => e.code === 'trace_stopped_length');
});

test("the server's own chat: the app's limits, and a reply that stopped short is said", async (t) => {
  if (!db) return t.skip('better-sqlite3 is not built for this Node');
  const proxy = () => client.callAIProxy({ messages: [{ role: 'user', content: 'Tidy up this note.' }], systemPrompt: 'You are Trace.' });
  envLock('oai-compat');
  fresh({ need: 6000 });
  assert.equal(await proxy(), 'words:6000');
  fresh({ need: 1000, context: 8192 });
  assert.equal(await proxy(), 'words:1000');
  assert.deepEqual(asked(), [16384, 4096]);
  fresh({ need: 20000 });
  await assert.rejects(proxy(), (e) => e.code === 'trace_stopped_length');
  envLock('claude', 'claude-sonnet-4-5');
  fresh({ need: 6000 });
  assert.equal(await proxy(), 'words:6000', 'Claude with the longer limit too');
  fresh({ need: 100, modelMax: 4096 });
  assert.equal(await proxy(), 'words:100');
  assert.deepEqual(asked(), [16384, 4096]);
  fresh({ need: 20000 });
  await assert.rejects(proxy(), (e) => e.code === 'trace_stopped_length');
});
