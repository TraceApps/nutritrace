import assert from 'node:assert/strict';
import test from 'node:test';
import { getOpenAIChatParams as getClientParams } from '../src/lib/openai-chat-params.js';
import { getOpenAIChatParams as getServerParams } from '../server/lib/openai-chat-params.js';

const implementations = [
  ['client', getClientParams],
  ['server', getServerParams],
];

for (const [name, getParams] of implementations) {
  test(`${name}: GPT-5.6 tools use current OpenAI parameters`, () => {
    assert.deepEqual(
      getParams({
        baseUrl: 'https://api.openai.com',
        model: 'gpt-5.6-luna',
        hasTools: true,
      }),
      {
        stream: false,
        max_completion_tokens: 4096,
        reasoning_effort: 'none',
      },
    );
  });

  test(`${name}: GPT-5.6 without tools does not override reasoning`, () => {
    assert.deepEqual(
      getParams({
        baseUrl: 'https://api.openai.com/',
        model: 'gpt-5.6-luna',
        hasTools: false,
      }),
      { stream: false, max_completion_tokens: 4096 },
    );
  });

  test(`${name}: other official OpenAI models use max_completion_tokens`, () => {
    assert.deepEqual(
      getParams({
        baseUrl: 'https://api.openai.com',
        model: 'gpt-4o-mini',
        hasTools: true,
        maxTokens: 1024,
      }),
      { stream: false, max_completion_tokens: 1024 },
    );
  });

  test(`${name}: compatible providers retain max_tokens`, () => {
    assert.deepEqual(
      getParams({
        baseUrl: 'http://ollama:11434',
        model: 'gpt-5.6-luna',
        hasTools: true,
      }),
      { stream: false, max_tokens: 4096 },
    );
  });
}

test('client and server copies are identical', async () => {
  const { readFileSync } = await import('node:fs');
  const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
  assert.equal(read('../src/lib/openai-chat-params.js'), read('../server/lib/openai-chat-params.js'));
});

test('GPT-6 Luna, like GPT-5.6, gets reasoning "none" when tools are sent', () => {
  for (const get of [getClientParams, getServerParams]) {
    assert.equal(get({ baseUrl: 'https://api.openai.com', model: 'gpt-6-luna', hasTools: true }).reasoning_effort, 'none');
    assert.equal(get({ baseUrl: 'https://api.openai.com', model: 'gpt-5.6-sol', hasTools: true }).reasoning_effort, 'none');
    assert.equal(get({ baseUrl: 'https://api.openai.com', model: 'gpt-6-luna', hasTools: false }).reasoning_effort, undefined);
  }
});
