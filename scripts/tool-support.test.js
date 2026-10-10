// A model that can't use tools still answers (TraceApps/nutritrace#259).
// The same test file in every Trace app that has src/lib/tool-support.js.
import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, readFileSync } from 'node:fs';
import {
  isToolsUnsupported, toolsRefusal, isOtherModel, createToolSupportMemory, withoutToolHistory, withoutTools,
  sendWithToolFallback, TOOLLESS_TTL_MS, NO_TOOLS_NOTE, createToolsNotice, forModel, TOOLS_NOTE,
} from '../src/lib/tool-support.js';

test('the copies of tool-support.js are identical', () => {
  const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
  if (existsSync(new URL('../server/lib/tool-support.js', import.meta.url))) {
    assert.equal(read('../server/lib/tool-support.js'), read('../src/lib/tool-support.js'));
  }
});

// The refusal in the report, as the reporter's gateway wraps it, and as the
// upstream sends it.
const upstream = { error_type: 'TOOL_USE_NOT_SUPPORTED', id: '2d1b4ad3-1622-4732-92b7-096410d39b1a', message: 'invalid request: tool use is not supported by the provided model: command-a-vision-07-2025' };
const reported = { error: { message: `[400]: ${JSON.stringify(upstream)}` } };

test('refusals that say the model cannot use tools are recognized, with the model they name', () => {
  const cases = [
    [400, reported, 'command-a-vision-07-2025'],
    [400, upstream, 'command-a-vision-07-2025'],
    // The reporter's HTTP status is not known: the certain ones count on any 5xx.
    [500, reported, 'command-a-vision-07-2025'],
    [502, upstream, 'command-a-vision-07-2025'],
    // Ollama 0.40.2, /v1/chat/completions, gemma3:270m (a running server)
    [400, { error: { message: 'registry.ollama.ai/library/gemma3:270m does not support tools', type: 'invalid_request_error', param: null, code: null } }, 'registry.ollama.ai/library/gemma3:270m'],
    [500, { error: 'registry.ollama.ai/library/gemma3:latest does not support tools' }, 'registry.ollama.ai/library/gemma3:latest'],
    // OpenAI
    [400, { error: { message: "Unsupported parameter: 'tools' is not supported with this model.", type: 'invalid_request_error', param: 'tools', code: 'unsupported_parameter' } }, null],
    [400, { error: { message: 'Bad request', type: 'invalid_request_error', param: 'tools', code: 'unsupported_parameter' } }, null],
    [404, { error: { message: 'tools is not supported in this model', type: 'invalid_request_error' } }, null],
    // Azure OpenAI
    [400, { error: { message: 'Unrecognized request argument supplied: tools', type: 'invalid_request_error', code: null } }, null],
    // LiteLLM UnsupportedParamsError
    [400, { error: { message: "litellm.UnsupportedParamsError: ollama does not support parameters: ['tools'], for model=gemma3:1b. To drop these, set `litellm.drop_params=True`", type: null, param: null, code: '400' } }, 'gemma3:1b'],
    // vLLM without --enable-auto-tool-choice
    [400, { error: { message: '"auto" tool choice requires --enable-auto-tool-choice and --tool-call-parser to be set', type: 'BadRequestError', param: null, code: 400 } }, null],
    // A strict server forbidding the field: pydantic as JSON (FastAPI) and as text (vLLM)
    [422, { detail: [{ type: 'extra_forbidden', loc: ['body', 'tools'], msg: 'Extra inputs are not permitted', input: [{ type: 'function' }] }] }, null],
    [400, { error: { message: "[{'type': 'extra_forbidden', 'loc': ('body', 'tools'), 'msg': 'Extra inputs are not permitted', 'input': [{'type': 'function'}]}]", type: 'BadRequestError', code: 400 } }, null],
    // llama.cpp without --jinja (a 500)
    [500, { error: { code: 500, message: 'tools param requires --jinja flag', type: 'server_error' } }, null],
    // OpenRouter (a 404)
    [404, { error: { message: 'No endpoints found that support tool use. To learn more about provider routing, visit: https://openrouter.ai/docs/provider-routing', code: 404 } }, null],
    // Mistral, DeepSeek, others
    [400, { message: 'Function calling is not enabled for this model', type: 'invalid_request_error' }, null],
    [400, { error: { message: 'deepseek-reasoner does not support Function Calling' } }, 'deepseek-reasoner'],
    [422, { detail: 'Tool calling is not supported for this model' }, null],
    [400, { error: { message: 'Tool messages are not supported' } }, null],
    [400, { error: { message: 'Functions are not supported by this model' } }, null],
    [400, 'model does not support tools', null],
  ];
  for (const [status, body, model] of cases) {
    assert.equal(isToolsUnsupported(status, body), true, JSON.stringify(body));
    assert.deepEqual(toolsRefusal(status, body), { model }, JSON.stringify(body));
  }
});

test('unrelated refusals are not mistaken for it', () => {
  const cases = [
    // The original #259 refusal: `name` on tool messages
    [400, { error: { param: 'messages', type: 'invalid_request_error', message: 'Upstream request failed: [unsupported_parameter] messages[17]: "name" is not supported by this endpoint' } }],
    [400, { error: { message: "This model's maximum context length is 8192 tokens.", type: 'invalid_request_error', param: 'messages', code: 'context_length_exceeded' } }],
    [400, { error: { message: "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.", param: 'max_tokens', code: 'unsupported_parameter' } }],
    [400, { error: { message: "Invalid schema for function 'get_diary': 'date' is not valid", param: 'tools[0].function.parameters', code: 'invalid_function_parameters' } }],
    [400, { error: { message: 'Image input is not supported by this model' } }],
    [400, { error: { message: 'Unrecognized request argument supplied: logprobs' } }],
    [422, { detail: [{ type: 'extra_forbidden', loc: ['body', 'foo'], msg: 'Extra inputs are not permitted', input: 'tools' }] }],
    [422, { detail: [{ type: 'missing', loc: ['body', 'tools', 0, 'function'], msg: 'Field required' }] }],
    // A validation error that echoes what was sent: the user's own words never count.
    [400, { error: { message: "1 validation error for ChatCompletionRequest\nmessages.1.content\n  Input should be a valid string [type=string_type, input_value='Why does this model does not support tools?', input_type=list]", type: 'BadRequestError', code: 400 } }],
    [400, { error: { message: "[{'type': 'string_type', 'loc': ('body', 'messages', 1, 'content'), 'msg': 'Input should be a valid string', 'input': 'tool use is not supported by the provided model: x'}]", type: 'BadRequestError', code: 400 } }],
    [422, { detail: [{ type: 'string_type', loc: ['body', 'messages', 1, 'content'], msg: 'Input should be a valid string', input: 'TOOL_USE_NOT_SUPPORTED does not support tools' }] }],
    // Explained by a message: the rest of the body is not searched.
    [400, { error: { message: 'Bad request' }, request: { echo: 'tool use is not supported' } }],
    [401, { error: { message: 'tool use is not supported by the provided model' } }],
    [429, { error: { message: 'Rate limit reached; tools do not support bursts' } }],
    // A 5xx counts only for the certain wordings.
    [500, { error: { message: "Unsupported parameter: 'tools' is not supported with this model." } }],
    [503, { error: { message: 'Function calling is not enabled for this model' } }],
    [500, { error: { message: 'Internal server error' } }],
    [400, {}],
    [400, null],
  ];
  for (const [status, body] of cases) assert.equal(isToolsUnsupported(status, body), false, JSON.stringify(body));
});

test('a refusal naming another model than the one asked for is a routed one', () => {
  assert.equal(isOtherModel('command-a-vision-07-2025', 'my-combo'), true, "the reporter's AI_MODEL is a combo of many models");
  assert.equal(isOtherModel('command-a-vision-07-2025', 'command-a-vision-07-2025'), false);
  assert.equal(isOtherModel('registry.ollama.ai/library/gemma3:latest', 'gemma3'), false, "Ollama's full name for the same model");
  assert.equal(isOtherModel('registry.ollama.ai/library/gemma3:270m', 'gemma3:270m'), false);
  assert.equal(isOtherModel(null, 'my-combo'), false, 'no model named');
});

test('a tool-less model is remembered per base URL and model, and the memory expires', () => {
  let t = 1_000;
  const memory = createToolSupportMemory({ now: () => t });
  memory.remember('http://gw:4000/', 'command-a-vision');
  assert.equal(memory.isToolless('http://gw:4000', 'command-a-vision'), true, 'a trailing slash is the same endpoint');
  assert.equal(memory.isToolless('http://gw:4000', 'gpt-4o'), false, 'another model on the same endpoint');
  assert.equal(memory.isToolless('http://other:4000', 'command-a-vision'), false, 'the same model on another endpoint');
  t += TOOLLESS_TTL_MS - 1;
  assert.equal(memory.isToolless('http://gw:4000', 'command-a-vision'), true);
  t += 1;
  assert.equal(memory.isToolless('http://gw:4000', 'command-a-vision'), false, 'expired');
  assert.equal(memory.size, 0, 'an expired entry is dropped');
  assert.ok(TOOLLESS_TTL_MS <= 10 * 60_000, 'the memory stays short');
});

test('the memory is bounded, dropping the oldest', () => {
  const memory = createToolSupportMemory({ max: 3 });
  for (const m of ['a', 'b', 'c', 'd']) memory.remember('http://gw', m);
  assert.equal(memory.size, 3);
  assert.equal(memory.isToolless('http://gw', 'a'), false);
  assert.equal(memory.isToolless('http://gw', 'd'), true);
});

const toolRound = () => [
  { role: 'system', content: 'You are Trace. ALWAYS use tools.' },
  { role: 'user', content: 'What did I eat?' },
  { role: 'assistant', content: null, tool_calls: [
    { id: 'call_1', type: 'function', function: { name: 'get_diary', arguments: '{"date":"2026-10-10"}' } },
    { id: 'call_2', type: 'function', function: { name: 'get_goals', arguments: '{}' } },
  ] },
  { role: 'tool', tool_call_id: 'call_1', content: '{"items":["oats"]}' },
  { role: 'tool', tool_call_id: 'call_2', name: 'get_goals', content: '{"kcal":2000}' },
];

test('earlier tool rounds become plain text for a model sent no tools', () => {
  const out = withoutToolHistory(toolRound());
  assert.deepEqual(out, [
    { role: 'system', content: 'You are Trace. ALWAYS use tools.' },
    { role: 'user', content: 'What did I eat?' },
    { role: 'assistant', content: '[Called get_diary with {"date":"2026-10-10"}]\n[Called get_goals with {}]' },
    { role: 'user', content: '[Result of get_diary: {"items":["oats"]}]\n[Result of get_goals: {"kcal":2000}]' },
  ]);
  assert.ok(out.every(m => m.role !== 'tool' && !m.tool_calls), 'no tool messages or tool calls left');
  const plain = [{ role: 'user', content: 'hi' }];
  assert.equal(withoutToolHistory(plain), plain, 'a conversation without tool rounds is left as it is');
});

test('a body without tools drops tools and tool history, keeps the rest, and tells the model', () => {
  const body = { model: 'm', stream: false, max_tokens: 4096, messages: toolRound(), tools: [{ type: 'function', function: { name: 'get_diary' } }], tool_choice: 'auto' };
  const out = withoutTools(body);
  assert.deepEqual(Object.keys(out).sort(), ['max_tokens', 'messages', 'model', 'stream']);
  assert.equal(out.messages.length, 4);
  assert.equal(out.messages[0].content, `You are Trace. ALWAYS use tools.\n\n${NO_TOOLS_NOTE}`, 'the system prompt says no tools are available');
  assert.match(NO_TOOLS_NOTE, /don't say you logged, saved, changed or looked anything up/);
  assert.ok(body.tools && body.messages.length === 5 && body.messages[0].content === 'You are Trace. ALWAYS use tools.', 'the original body is left as it was');
  // No system message: one is added. A multipart one gets a text part.
  assert.deepEqual(withoutTools({ messages: [{ role: 'user', content: 'hi' }], tools: [{}] }).messages[0], { role: 'system', content: NO_TOOLS_NOTE });
  const parts = withoutTools({ messages: [{ role: 'system', content: [{ type: 'text', text: 'x' }] }], tools: [{}] }).messages[0].content;
  assert.deepEqual(parts, [{ type: 'text', text: 'x' }, { type: 'text', text: NO_TOOLS_NOTE }]);
});

const ok = (content, extra = {}) => ({ ok: true, status: 200, data: { choices: [{ message: { role: 'assistant', content, ...extra } }] } });
const sender = (answer) => {
  const sent = [];
  const send = async (b) => { sent.push(b); return answer(b, sent.length); };
  return { sent, send };
};
const toolBody = (model = 'command-a-vision-07-2025') => ({ model, messages: [{ role: 'system', content: 'You are Trace.' }, { role: 'user', content: 'hi' }], tools: [{ type: 'function', function: { name: 'get_diary' } }] });
const opts = (memory, model = 'command-a-vision-07-2025') => ({ memory, baseUrl: 'http://gw', model });

test('a model that refuses tools is asked once more without them, then remembered', async () => {
  const memory = createToolSupportMemory();
  const { sent, send } = sender((b) => (b.tools ? { ok: false, status: 400, data: reported } : ok('answer')));
  const r = await sendWithToolFallback(toolBody(), send, opts(memory));
  assert.equal(r.ok, true);
  assert.equal(r.toolsDropped, true);
  assert.equal(r.toolsRouted, false);
  assert.equal(sent.length, 2);
  assert.ok(sent[0].tools && !sent[1].tools);
  assert.match(sent[1].messages[0].content, /No tools are available for this request/);
  // The next message skips the doomed first attempt.
  const again = await sendWithToolFallback(toolBody(), send, opts(memory));
  assert.equal(again.toolsDropped, true);
  assert.equal(sent.length, 3);
  assert.ok(!sent[2].tools);
  assert.match(sent[2].messages[0].content, /No tools are available for this request/);
});

test("a combo model is asked again without tools, but not remembered: its next pick may take tools", async () => {
  const memory = createToolSupportMemory();
  const { sent, send } = sender((b) => (b.tools ? { ok: false, status: 400, data: reported } : ok('answer')));
  const r = await sendWithToolFallback(toolBody('my-combo'), send, opts(memory, 'my-combo'));
  assert.equal(r.ok, true);
  assert.equal(r.toolsDropped, true);
  assert.equal(r.toolsRouted, true);
  assert.equal(memory.size, 0);
  const again = await sendWithToolFallback(toolBody('my-combo'), send, opts(memory, 'my-combo'));
  assert.equal(again.toolsDropped, true);
  assert.equal(sent.length, 4);
  assert.ok(sent[2].tools, 'the next message offers tools again');
});

test('a model is remembered only when the request without tools succeeds', async () => {
  const memory = createToolSupportMemory();
  const { sent, send } = sender((b) => (b.tools ? { ok: false, status: 400, data: reported } : { ok: false, status: 503, data: { error: { message: 'overloaded' } } }));
  const r = await sendWithToolFallback(toolBody(), send, opts(memory));
  assert.equal(r.ok, false);
  assert.equal(r.status, 503);
  assert.equal(sent.length, 2);
  assert.equal(memory.size, 0);
});

test('an unrelated 400 is not retried', async () => {
  const memory = createToolSupportMemory();
  const refusal = { error: { message: "This model's maximum context length is 8192 tokens.", code: 'context_length_exceeded' } };
  const { sent, send } = sender(() => ({ ok: false, status: 400, data: refusal }));
  const r = await sendWithToolFallback(toolBody(), send, opts(memory));
  assert.equal(r.ok, false);
  assert.equal(r.status, 400);
  assert.equal(r.data, refusal);
  assert.equal(r.toolsDropped, false);
  assert.equal(sent.length, 1);
  assert.equal(memory.size, 0);
});

test('a model that takes tools still gets them, in one request', async () => {
  const memory = createToolSupportMemory();
  const { sent, send } = sender(() => ok(null, { tool_calls: [{ id: 'c1', type: 'function', function: { name: 'get_diary', arguments: '{}' } }] }));
  const r = await sendWithToolFallback(toolBody(), send, opts(memory));
  assert.equal(r.toolsDropped, false);
  assert.equal(sent.length, 1);
  assert.ok(sent[0].tools);
  assert.equal(sent[0].messages[0].content, 'You are Trace.', 'the system prompt is left as it was');
  assert.equal(r.data.choices[0].message.tool_calls[0].function.name, 'get_diary');
});

test('a request without tools is sent as it is, and a refusal of it is not retried', async () => {
  const memory = createToolSupportMemory();
  memory.remember('http://gw', 'command-a-vision-07-2025');
  const { sent, send } = sender(() => ({ ok: false, status: 400, data: reported }));
  const body = { model: 'command-a-vision-07-2025', messages: [{ role: 'user', content: 'hi' }] };
  const r = await sendWithToolFallback(body, send, opts(memory));
  assert.equal(r.toolsDropped, false);
  assert.equal(sent.length, 1);
  assert.equal(sent[0], body);
});

test('once the memory expires, tools are offered again', async () => {
  let t = 0;
  const memory = createToolSupportMemory({ now: () => t });
  memory.remember('http://gw', 'command-a-vision-07-2025');
  t += TOOLLESS_TTL_MS;
  const { sent, send } = sender(() => ok('answer'));
  const r = await sendWithToolFallback(toolBody(), send, opts(memory));
  assert.equal(r.toolsDropped, false);
  assert.ok(sent[0].tools);
});

test('the note in the conversation shows once per conversation, and never reaches a model', () => {
  const notice = createToolsNotice();
  let messages = [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }];
  messages = notice.add(messages, "This model can't use tools.");
  assert.deepEqual(messages[2], { role: 'note', note: TOOLS_NOTE, content: "This model can't use tools." });
  messages = notice.add([...messages, { role: 'user', content: 'again' }, { role: 'assistant', content: 'ok' }], 'second');
  assert.equal(messages.filter(m => m.role === 'note').length, 1, 'once');
  assert.deepEqual(forModel(messages).map(m => m.role), ['user', 'assistant', 'user', 'assistant']);
  // Cleared: a new conversation says it again.
  notice.reset();
  assert.equal(notice.add([], 'again').length, 1);
  // A conversation that already has the note (another copy of the panel) doesn't get a second.
  const other = createToolsNotice();
  assert.equal(other.add(messages, 'x'), messages);
});
