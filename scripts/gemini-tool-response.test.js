/**
 * Trace works with Gemini when a tool answers with a list
 * (TraceApps/lifttrace#147). The same test file in every Trace app.
 *
 * The report: asking Trace for a training plan with a Gemini key ended in
 * "Invalid JSON payload received. Unknown name "response" at
 * 'contents[4].parts[2].function_response': Proto field is not repeating,
 * cannot start list." Gemini's FunctionResponse.response is "the function
 * response in JSON object format" (a protobuf Struct,
 * ai.google.dev/api/generate-content#FunctionResponse), and Trace sent a
 * tool's list as it was. These run the real loop (src/lib/aiChat.js)
 * against a stand-in for Gemini that refuses what Gemini refuses.
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';
import { geminiToolResponse } from '../src/lib/gemini-tool-response.js';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

test('the copies of gemini-tool-response.js are identical', () => {
  if (existsSync(new URL('../server/lib/gemini-tool-response.js', import.meta.url))) {
    assert.equal(read('../server/lib/gemini-tool-response.js'), read('../src/lib/gemini-tool-response.js'));
  }
});

test('anything but an object goes in one, under "result"; an object goes as it is', () => {
  for (const value of [[], [{ id: 1, name: 'Bench Press' }], 'text', '', 0, 42, true, false, null]) {
    assert.deepEqual(geminiToolResponse(value), { result: value }, JSON.stringify(value));
  }
  assert.deepEqual(geminiToolResponse(undefined), { result: null });
  const object = { count: 1, workouts: [{ id: 1 }] };
  assert.equal(geminiToolResponse(object), object);
  const error = { error: 'Workout 9 not found' };
  assert.equal(geminiToolResponse(error), error, 'a failed tool keeps its "error" key, as the API reference suggests');
  assert.deepEqual(JSON.parse(JSON.stringify(geminiToolResponse(new Date(0)))), { result: '1970-01-01T00:00:00.000Z' });
});

// ── A stand-in for Gemini ───────────────────────────────────────────────
// Refuses a functionResponse.response that isn't a JSON object, with the
// error the reporter got for a list (the words for a plain value or null
// are this stand-in's own). The first round asks for one tool,
// the second for three at once (as for a training plan), then it answers.
function refusal(contents) {
  for (const [c, content] of (contents || []).entries()) {
    for (const [p, part] of (content.parts || []).entries()) {
      if (!part.functionResponse) continue;
      const r = part.functionResponse.response;
      const at = `contents[${c}].parts[${p}].function_response`;
      if (Array.isArray(r)) return `Invalid JSON payload received. Unknown name "response" at '${at}': Proto field is not repeating, cannot start list.`;
      if (r === undefined || r === null) return `${at}.response is required.`;
      if (typeof r !== 'object') return `Invalid value at '${at}.response' (type.googleapis.com/google.protobuf.Struct), ${JSON.stringify(r)}`;
    }
  }
  return null;
}
const seen = [];
const endpoint = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    const b = JSON.parse(raw || '{}');
    seen.push(b);
    const wrong = refusal(b.contents);
    if (wrong) return res.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: { code: 400, message: wrong, status: 'INVALID_ARGUMENT' } }));
    const rounds = (b.contents || []).filter((c) => c.parts?.some((p) => p.functionResponse)).length;
    const calls = [['get_one'], ['get_one', 'get_two', 'get_list']][rounds];
    const parts = calls ? calls.map((name) => ({ functionCall: { name, args: {} } })) : [{ text: `answer after ${rounds}` }];
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ candidates: [{ content: { role: 'model', parts }, finishReason: 'STOP' }] }));
  });
});
await new Promise((r) => endpoint.listen(0, '127.0.0.1', r));
test.after(() => endpoint.close());
const ENDPOINT = `http://127.0.0.1:${endpoint.address().port}`;
const _fetch = globalThis.fetch;
globalThis.fetch = (url, opts) => (String(url).startsWith('https://generativelanguage.googleapis.com/') ? _fetch(`${ENDPOINT}/gemini`, opts) : _fetch(url, opts));
globalThis.localStorage ??= { getItem: () => null, setItem() {}, removeItem() {} };

const client = await import('../src/lib/aiChat.js');
let answers = {};
const handler = async (name) => answers[name];
// LiftTrace runs tools through onToolCall; the other apps through setToolHandler.
if (client.setToolHandler) client.setToolHandler(handler);
const TOOLS = ['get_one', 'get_two', 'get_list'].map((name) => ({ name, description: name, parameters: { type: 'object', properties: {} } }));
const ask = () => client.callAI({
  provider: 'gemini', apiKey: 'k', messages: [{ role: 'user', content: 'Make me a training plan.' }],
  systemPrompt: 'You are Trace.', tools: TOOLS, ...(client.setToolHandler ? {} : { onToolCall: handler }),
});

test('a tool that answers with a list: Gemini gets it in an object, and Trace answers', async () => {
  answers = { get_one: { active: false }, get_two: { id: 3, name: 'Push Pull Legs' }, get_list: [{ id: 1, name: 'Bench Press' }, { id: 2, name: 'Squat' }] };
  seen.length = 0;
  assert.equal(await ask(), 'answer after 2');
  const last = seen.at(-1).contents;
  assert.equal(last.length, 5, 'the question, two rounds of calls and their answers');
  const parts = last[4].parts.map((p) => p.functionResponse);
  assert.deepEqual(parts.map((p) => p.name), ['get_one', 'get_two', 'get_list']);
  assert.deepEqual(parts[2].response, { result: answers.get_list }, 'the list, whole, under "result"');
  assert.deepEqual(parts[0].response, { active: false }, 'an object goes as it is');
  assert.deepEqual(parts[1].response, answers.get_two);
});

test('every kind of answer a tool can give reaches Gemini as an object', async () => {
  for (const value of [[], 'done', 7, true, null, undefined, { error: 'Not found' }]) {
    answers = { get_one: { ok: true }, get_two: { ok: true }, get_list: value };
    seen.length = 0;
    assert.equal(await ask(), 'answer after 2', JSON.stringify(value));
    assert.equal(refusal(seen.at(-1).contents), null);
  }
});
