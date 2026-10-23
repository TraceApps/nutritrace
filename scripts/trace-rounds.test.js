/**
 * Trace can take the steps a big question needs (TraceApps/notetrace#34).
 *
 * The report was NoteTrace's ("go through all my notes" ended in "Too many
 * tool call rounds"); NutriTrace had the same loop: 5 rounds of tool calls
 * (8 with the coaching tools), then that error and nothing else. A month of
 * diary days, every saved meal, a coach going through a client's week: each
 * takes more. Now one answer can take 12 rounds, and when they run out (or
 * the tool answers get too big) a last request with the tools off answers
 * from what was found and says what's left, instead of an error. That holds
 * for the app's own calls and through the server (Trace set by environment
 * variables), for every provider.
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

// ── A stand-in provider ─────────────────────────────────────────────────
// It asks for a tool until its request turns the tools off (or until
// `stopAfter` rounds), then answers. `rejectChoice`: an OpenAI-compatible
// server that refuses tool_choice; `ignoreChoice`: one that ignores it and
// asks for a tool anyway, with no text.
let stopAfter = Infinity, rejectChoice = false, rejectStatus = 400, ignoreChoice = false, perRound = 1, argPad = '';
const seen = [];
const toolRounds = (b, path) => (path.startsWith('/claude')
  ? (b.messages || []).filter((m) => Array.isArray(m.content) && m.content.some((c) => c.type === 'tool_result')).length
  : path.startsWith('/gemini')
    ? (b.contents || []).filter((c) => c.parts?.some((p) => p.functionResponse)).length
    : (b.messages || []).filter((m) => m.role === 'tool').length);
const endpoint = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    const b = JSON.parse(raw || '{}');
    seen.push({ path: req.url, body: b });
    // Gemini takes only a JSON object as a tool's answer (TraceApps/lifttrace#147).
    const notObject = (r) => r === null || typeof r !== 'object' || Array.isArray(r);
    if (req.url.startsWith('/gemini') && (b.contents || []).some((c) => c.parts?.some((p) => p.functionResponse && notObject(p.functionResponse.response)))) {
      return res.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: { code: 400, message: 'functionResponse.response must be a JSON object.', status: 'INVALID_ARGUMENT' } }));
    }
    const n = toolRounds(b, req.url);
    let out;
    if (req.url.startsWith('/claude')) {
      out = b.tool_choice?.type === 'none' || n >= stopAfter
        ? { content: [{ type: 'text', text: `answer after ${n}` }], stop_reason: 'end_turn' }
        : { content: Array.from({ length: perRound }, (_, k) => ({ type: 'tool_use', id: `t${n}_${k}`, name: 'get_diary', input: { date: '2026-10-01', ...(argPad ? { pad: argPad } : {}) } })), stop_reason: 'tool_use' };
    } else if (req.url.startsWith('/gemini')) {
      out = b.toolConfig?.functionCallingConfig?.mode === 'NONE' || n >= stopAfter
        ? { candidates: [{ content: { parts: [{ text: `answer after ${n}` }] }, finishReason: 'STOP' }] }
        : { candidates: [{ content: { parts: Array.from({ length: perRound }, () => ({ functionCall: { name: 'get_diary', args: { date: '2026-10-01', ...(argPad ? { pad: argPad } : {}) } } })) }, finishReason: 'STOP' }] };
    } else {
      if (rejectChoice && b.tool_choice) return res.writeHead(rejectStatus, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: { message: "Unsupported value: 'tool_choice' none" } }));
      const answer = (b.tool_choice === 'none' && !ignoreChoice) || n >= stopAfter;
      out = { choices: [{ index: 0, finish_reason: answer ? 'stop' : 'tool_calls', message: answer
        ? { role: 'assistant', content: `answer after ${n}` }
        : { role: 'assistant', content: null, tool_calls: Array.from({ length: perRound }, (_, k) => ({ id: `c${n}_${k}`, type: 'function', function: { name: 'get_diary', arguments: JSON.stringify({ date: '2026-10-01', ...(argPad ? { pad: argPad } : {}) }) } })) } }] };
    }
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(out));
  });
});
await new Promise((r) => endpoint.listen(0, '127.0.0.1', r));
const ENDPOINT = `http://127.0.0.1:${endpoint.address().port}`;
const _fetch = globalThis.fetch;
globalThis.fetch = (url, opts) => {
  const u = String(url);
  if (u.startsWith('https://api.anthropic.com')) return _fetch(`${ENDPOINT}/claude`, opts);
  if (u.startsWith('https://generativelanguage.googleapis.com')) return _fetch(`${ENDPOINT}/gemini`, opts);
  return _fetch(url, opts);
};

// The server, for Trace set by environment variables.
let db = null, dir = null, server = null, base = null, person = 1;
try {
  const req = createRequire(new URL('../server/package.json', import.meta.url));
  req('better-sqlite3');
  dir = mkdtempSync(join(tmpdir(), 'trace-rounds-'));
  process.env.DB_PATH = join(dir, 'test.db');
  db = (await import('../server/db.js')).default;
  const express = req('express');
  const { default: aiRoutes } = await import('../server/routes/ai.js');
  const app = express();
  app.use(express.json({ limit: '12mb' }));
  // Each test is its own person, so the per-person limit counts one test at a time.
  app.use((r, _res, next) => { r.user = { id: person }; next(); });
  app.use('/api/ai', aiRoutes);
  app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
} catch { /* better-sqlite3 not built for this Node: the server cases skip */ }
test.after(() => { server?.close(); endpoint.close(); try { db?.close(); } catch {} if (dir) rmSync(dir, { recursive: true, force: true }); });

globalThis.window ??= { __NT_CONFIG__: { basePath: base || '' }, location: { origin: base || '' } };
globalThis.localStorage ??= { getItem: () => null, setItem() {}, removeItem() {} };
const client = await import('../src/lib/aiChat.js');
let calls = 0, toolResult = { ok: true };
client.setToolHandler(async () => { calls++; return toolResult; });
const TOOLS = [client.TOOLS.find((t) => t.name === 'get_diary')];
const COACH = { name: 'get_client_summary', description: 'A client', parameters: { type: 'object', properties: {} } };
const fresh = (o = {}) => {
  if (!o.samePerson) person++;
  seen.length = 0; calls = 0; stopAfter = o.stopAfter ?? Infinity; rejectChoice = !!o.rejectChoice;
  rejectStatus = o.rejectStatus ?? 400; ignoreChoice = !!o.ignoreChoice; toolResult = o.toolResult ?? { ok: true }; perRound = o.perRound ?? 1; argPad = o.argPad ?? '';
};
const QUESTION = [{ role: 'user', content: 'Go through every day last month and find the days I had pizza.' }];
const ask = (provider, o = {}) => client.callAI({
  provider, apiKey: 'k', model: provider === 'oai-compat' ? 'local' : undefined, baseUrl: provider === 'oai-compat' ? ENDPOINT : undefined,
  messages: o.messages || QUESTION, systemPrompt: 'You are Trace.', tools: o.tools || TOOLS,
});
const envLock = (provider) => {
  const set = db.prepare('INSERT INTO app_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  for (const [k, v] of [['ai_enabled', 'true'], ['ai_provider', provider], ['ai_base_url', provider === 'oai-compat' ? ENDPOINT : ''], ['ai_model', provider === 'oai-compat' ? 'local' : ''], ['ai_api_key', 'sk-test'], ['ai_env_locked', 'true']]) set.run(k, v);
};
const askProxy = (o = {}) => client.callAIProxy({ messages: o.messages || QUESTION, systemPrompt: 'You are Trace.', tools: o.tools || TOOLS });
const DIRECT = ['oai-compat', 'claude', 'gemini'];
const systemOf = (s) => (s.path.startsWith('/claude') ? s.body.system : s.path.startsWith('/gemini') ? s.body.systemInstruction.parts[0].text : s.body.messages[0].content);
const toolsOff = (s) => (s.path.startsWith('/claude') ? s.body.tool_choice?.type === 'none' : s.path.startsWith('/gemini') ? s.body.toolConfig?.functionCallingConfig?.mode === 'NONE' : s.body.tool_choice === 'none');

test('12 rounds of tool calls: a question that needs 8 finishes, coaching or not', async () => {
  assert.equal(client.TOOL_ROUNDS, 12);
  for (const provider of DIRECT) {
    for (const tools of [TOOLS, [...TOOLS, COACH]]) {
      fresh({ stopAfter: 8 });
      assert.equal(await ask(provider, { tools }), 'answer after 8', provider);
      assert.equal(calls, 8);
    }
  }
  assert.doesNotMatch(read('../src/lib/aiChat.js'), /Too many tool call rounds|_maxRounds/);
});

test('out of rounds, a last request with the tools off answers from what was found', async () => {
  for (const provider of DIRECT) {
    fresh();
    assert.equal(await ask(provider), 'answer after 12', provider);
    assert.equal(calls, 12, `${provider}: 12 rounds of tools`);
    assert.equal(seen.length, 13);
    const last = seen[12], before = seen[11];
    assert.ok(systemOf(last).startsWith('You are Trace.') && systemOf(last).endsWith(client.OUT_OF_ROUNDS), `${provider}: told to answer in the system prompt`);
    assert.equal(systemOf(before), 'You are Trace.', 'only the last request is');
    assert.ok(toolsOff(last) && !toolsOff(before), provider);
    // The tools stay declared (the history has tool calls in it).
    assert.ok(last.body.tools?.length, provider);
    // The conversation itself isn't changed: the last message is the tool results.
    if (provider === 'oai-compat') assert.equal(last.body.messages.at(-1).role, 'tool');
    if (provider === 'claude') assert.equal(last.body.messages.at(-1).content[0].type, 'tool_result');
    if (provider === 'gemini') assert.ok(last.body.contents.at(-1).parts[0].functionResponse);
  }
});

test('a server that refuses tool_choice is asked once more without it, only for a refusal; one that ignores it still gets an answer said', async () => {
  fresh({ rejectChoice: true, stopAfter: 99 });
  const r = await ask('oai-compat');
  assert.equal(seen.length, 14);
  assert.equal(seen[12].body.tool_choice, 'none');
  assert.equal(seen[13].body.tool_choice, undefined);
  assert.ok(seen[13].body.messages[0].content.endsWith(client.OUT_OF_ROUNDS));
  // That server then asked for a tool again with no text: Trace says why there's no answer.
  assert.match(r, /more steps than one answer allows/);
  fresh({ rejectChoice: true, rejectStatus: 422, stopAfter: 99 });
  await ask('oai-compat');
  assert.equal(seen.length, 14);
  fresh({ rejectChoice: true, rejectStatus: 503, stopAfter: 99 });
  await assert.rejects(ask('oai-compat'), /Unsupported value/);
  assert.equal(seen.length, 13, 'any other failure is the error it always was');
  fresh({ ignoreChoice: true });
  assert.match(await ask('oai-compat'), /more steps than one answer allows/);
  assert.equal(calls, 12, 'and runs no 13th round of tools');
  const en = JSON.parse(read('../src/i18n/en.json'));
  assert.match(en.trace_reply.out_of_rounds, /more steps than one answer allows/);
});

test('when the tool answers get too big, Trace wraps up early the same way; a photo does not count', async () => {
  assert.equal(client.HISTORY_MAX_BYTES, 300000);
  for (const provider of DIRECT) {
    // Each tool answer is 200 kB: after two, the next request is the last.
    fresh({ toolResult: { days: [{ notes: 'x'.repeat(200000) }] } });
    assert.equal(await ask(provider), 'answer after 2', provider);
    assert.deepEqual([calls, seen.length], [2, 3], provider);
    assert.ok(toolsOff(seen[2]) && !toolsOff(seen[1]), provider);
    // A 2 MB photo with the question: every round the answer needs.
    fresh({ stopAfter: 4 });
    const photo = { base64: 'A'.repeat(2_000_000), mimeType: 'image/jpeg' };
    const withPhoto = provider === 'claude'
      ? [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: photo.base64 } }, { type: 'text', text: 'Log this.' }] }]
      : provider === 'gemini'
        ? [{ role: 'user', content: 'Log this.', _image: photo }]
        : [{ role: 'user', content: [{ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${photo.base64}` } }, { type: 'text', text: 'Log this.' }] }];
    assert.equal(await ask(provider, { messages: withPhoto }), 'answer after 4', provider);
    assert.ok(Buffer.byteLength(JSON.stringify(seen[0].body)) > 2_000_000, `${provider}: the photo went with the question`);
  }
  // Japanese counts by its bytes, not its characters.
  fresh({ toolResult: { notes: 'あ'.repeat(70000) } });
  await ask('claude');
  assert.equal(calls, 2, '70,000 characters of Japanese are 210 kB');
});

test('many tool calls at once can\'t pass the size limit by much: the rest of that round isn\'t run', async (t) => {
  const big = { days: [{ notes: 'x'.repeat(300000) }] };
  const check = (label) => {
    assert.equal(calls, 1, `${label}: one ran, three didn't`);
    const body = JSON.stringify(seen.at(-1).body);
    assert.equal(body.split(client.TOOL_SKIPPED).length - 1, 3, `${label}: each call left unrun still has its answer`);
    assert.ok(toolsOff(seen.at(-1)), `${label}: the next request is the last`);
    assert.ok(Buffer.byteLength(body) < 1_000_000, `${label}: under the server's 1 MB`);
  };
  for (const provider of DIRECT) {
    fresh({ perRound: 4, toolResult: big });
    await ask(provider);
    assert.equal(seen.length, 2, provider);
    check(provider);
  }
  // What the model itself sent doesn't use up a round's room: only the
  // answers do, so calls it already paid for still run.
  for (const provider of DIRECT) {
    fresh({ perRound: 4, argPad: 'w'.repeat(100000), stopAfter: 1 });
    await ask(provider);
    assert.equal(calls, 4, `${provider}: every call ran`);
    assert.ok(!JSON.stringify(seen.at(-1).body).includes(client.TOOL_SKIPPED), provider);
  }
  if (!db) return t.skip('better-sqlite3 is not built for this Node: the server half');
  envLock('oai-compat');
  fresh({ perRound: 4, toolResult: big });
  assert.match(await askProxy(), /^answer after \d+$/);
  check('through the server');
});

// ── Through the server ──────────────────────────────────────────────────
for (const provider of DIRECT) {
  test(`through the server (${provider}): 12 rounds, then the server answers with the tools off`, async (t) => {
    if (!db) return t.skip('better-sqlite3 is not built for this Node');
    envLock(provider);
    fresh({ stopAfter: 8 });
    assert.equal(await askProxy({ tools: [...TOOLS, COACH] }), 'answer after 8');
    fresh();
    assert.equal(await askProxy(), 'answer after 12');
    assert.equal(calls, 12);
    assert.equal(seen.length, 13);
    assert.ok(toolsOff(seen[12]) && !toolsOff(seen[11]), 'the server turned the tools off');
    assert.ok(systemOf(seen[12]).endsWith(client.OUT_OF_ROUNDS) && systemOf(seen[11]) === 'You are Trace.');
    assert.ok(seen[12].body.tools?.length);
  });
}

test('through the server: a model that ignores the tools being off still gets an answer said, and a refusal is asked again', async (t) => {
  if (!db) return t.skip('better-sqlite3 is not built for this Node');
  envLock('oai-compat');
  fresh({ ignoreChoice: true });
  assert.match(await askProxy(), /more steps than one answer allows/);
  assert.equal(calls, 12);
  fresh({ rejectChoice: true, stopAfter: 99 });
  await askProxy();
  assert.equal(seen.length, 14);
  assert.equal(seen[13].body.tool_choice, undefined);
});

test('through the server: a long answer stays under what the server takes in one request', async (t) => {
  if (!db) return t.skip('better-sqlite3 is not built for this Node');
  envLock('oai-compat');
  // Several tools a round with the 20 messages of history Trace sends: the
  // server takes 60 messages, so Trace wraps up before it would pass that,
  // and a model asking for more at once than fits gets the ones that do
  // (13 a round passed 60 on the fourth request; 40 at once on the first).
  const history = Array.from({ length: 19 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `turn ${i}` }));
  history.push(QUESTION[0]);
  for (const per of [3, 13, 40]) {
    fresh({ perRound: per });
    const r = await client.callAIProxy({ messages: history, systemPrompt: 'You are Trace.', tools: TOOLS });
    assert.match(r, /^answer after \d+$/, `${per} a round`);
    for (const s of seen) assert.ok(s.body.messages.length - 1 <= 60, `${per} a round: a request with ${s.body.messages.length - 1} messages`);
    assert.ok(toolsOff(seen.at(-1)), `${per} a round: it ended on the tools-off request`);
    // Calls left out for room are named in that last request, so the model doesn't say they ran.
    const said = systemOf(seen.at(-1));
    if (per === 3) assert.ok(!said.includes(client.TOOLS_DROPPED), 'nothing left out');
    else assert.match(said, new RegExp(`${client.TOOLS_DROPPED.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} get_diary(, get_diary)*\\.$`), `${per} a round`);
    // Every tool call the next request carries has its answer.
    for (const s of seen) {
      const asked = s.body.messages.flatMap((m) => m.tool_calls || []).map((c) => c.id);
      const answered = s.body.messages.filter((m) => m.role === 'tool').map((m) => m.tool_call_id);
      assert.deepEqual(answered, asked, `${per} a round`);
    }
  }
});

test('through the server: three long answers in a minute go through', async (t) => {
  if (!db) return t.skip('better-sqlite3 is not built for this Node');
  envLock('oai-compat');
  // 13 requests an answer; the old limit of 30 a minute refused the third.
  fresh();
  for (let i = 0; i < 3; i++) {
    fresh({ samePerson: true });
    assert.equal(await askProxy(), 'answer after 12', `answer ${i + 1}`);
  }
});

test('a tool that answers with a list reaches Gemini in an object, in the app and through the server (TraceApps/lifttrace#147)', async (t) => {
  const list = [{ date: '2026-10-01', name: 'Run', calories: 300 }];
  const answers = () => seen.at(-1).body.contents.flatMap((c) => c.parts.filter((p) => p.functionResponse)).map((p) => p.functionResponse.response);
  fresh({ perRound: 3, stopAfter: 1, toolResult: list });
  assert.equal(await ask('gemini'), 'answer after 1');
  assert.deepEqual(answers(), [{ result: list }, { result: list }, { result: list }]);
  if (!db) return t.skip('better-sqlite3 is not built for this Node: the server half');
  envLock('gemini');
  fresh({ perRound: 3, stopAfter: 1, toolResult: list });
  assert.equal(await askProxy(), 'answer after 1', 'server gemini');
  assert.deepEqual(answers(), [{ result: list }, { result: list }, { result: list }]);
  // An object, a failed tool's { error } too, goes as it is.
  fresh({ perRound: 2, stopAfter: 1, toolResult: { error: 'No diary for that day' } });
  assert.equal(await askProxy(), 'answer after 1');
  assert.deepEqual(answers(), [{ error: 'No diary for that day' }, { error: 'No diary for that day' }]);
});
