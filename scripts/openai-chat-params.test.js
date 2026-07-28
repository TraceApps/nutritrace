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
      { max_completion_tokens: 4096 },
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
      { max_completion_tokens: 1024 },
    );
  });

  test(`${name}: compatible providers retain max_tokens`, () => {
    assert.deepEqual(
      getParams({
        baseUrl: 'http://ollama:11434',
        model: 'gpt-5.6-luna',
        hasTools: true,
      }),
      { max_tokens: 4096 },
    );
  });
}
