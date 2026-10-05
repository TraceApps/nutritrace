// Tool results reach each provider in the shape it accepts (TraceApps/nutritrace#259).
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { toolMessagesForOpenAI, toolNameFor, rememberToolCalls } from '../server/lib/tool-messages.js';

const round = () => [
  { role: 'user', content: 'What did I eat?' },
  { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_diary', arguments: '{}' } }] },
  { role: 'tool', tool_call_id: 'call_1', name: 'get_diary', content: '{"items":["oats"]}' },
];

test('OpenAI-compatible endpoints get tool messages without name', () => {
  const out = toolMessagesForOpenAI(round());
  assert.deepEqual(out[2], { role: 'tool', tool_call_id: 'call_1', content: '{"items":["oats"]}' });
  assert.deepEqual(out.slice(0, 2), round().slice(0, 2), 'other messages untouched');
});

test('the messages the app sent are left as they were', () => {
  const msgs = round();
  toolMessagesForOpenAI(msgs);
  assert.equal(msgs[2].name, 'get_diary');
});

test("Gemini gets the tool's name, from the message or from the call it answers", () => {
  const names = new Map();
  rememberToolCalls(round()[1], names);
  assert.equal(toolNameFor(round()[2], names), 'get_diary');
  assert.equal(toolNameFor({ role: 'tool', tool_call_id: 'call_1', content: '{}' }, names), 'get_diary');
  assert.equal(toolNameFor({ role: 'tool', tool_call_id: 'call_9', content: '{}' }, names), '');
});

test('the server sends tool results through these helpers', () => {
  const ai = readFileSync(new URL('../server/routes/ai.js', import.meta.url), 'utf8');
  assert.match(ai, /\.\.\.toolMessagesForOpenAI\(messages\)\]/);
  assert.match(ai, /name: toolNameFor\(m, toolCallNames\)/);
  assert.match(ai, /if \(m\.role === 'assistant'\) rememberToolCalls\(m, toolCallNames\);/);
});

test("Gemini's tool calls and the ids the app answers share one timestamp", () => {
  const ai = readFileSync(new URL('../server/routes/ai.js', import.meta.url), 'utf8');
  assert.doesNotMatch(ai, /gem_\$\{Date\.now\(\)\}/);
  assert.equal((ai.match(/id: +`gem_\$\{minted\}_\$\{i\}`/g) || []).length, 2);
});
