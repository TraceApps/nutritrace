/**
 * The AI model picker and the IDs the app sends, in the browser/app
 * (src/lib/aiChat.js) and in the server's proxy (server/routes/ai.js).
 *
 * The lists were checked against the vendors' model and deprecation pages on
 * 2026-10-09. These tests keep the two copies identical, keep shut-down and
 * renamed IDs working for anyone who saved them, and keep the picker to
 * models a new user can actually use.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';

const client = await import('../src/lib/aiChat.js');

let server = null, dir = null;
try {
  createRequire(new URL('../server/package.json', import.meta.url))('better-sqlite3');
  dir = mkdtempSync(join(tmpdir(), 'nt-ai-models-'));
  process.env.DB_PATH = join(dir, 'test.db');
  server = (await import('../server/routes/ai.js'))._models;
} catch { /* better-sqlite3 not built for this Node: the server half skips */ }
test.after(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

const ids = provider => client.AI_MODELS[provider].map(m => m.value).filter(v => v !== '__custom__');

test('the picker lists the current models, with the cheapest and the most capable marked', () => {
  assert.deepEqual(ids('claude'), ['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5', 'claude-fable-5-1',
    'claude-sonnet-5', 'claude-opus-5', 'claude-fable-5', 'claude-opus-4-8']);
  assert.deepEqual(ids('openai'), ['gpt-6-luna', 'gpt-5.6-terra', 'gpt-5.6-sol', 'gpt-5.6-luna', 'gpt-4o-mini', 'gpt-4o']);
  // Trace needs tool calls over Chat Completions, which GPT-6.1 Sol and GPT-6 Astra don't do.
  assert.ok(!ids('openai').includes('gpt-6.1-sol') && !ids('openai').includes('gpt-6-astra'));
  assert.deepEqual(ids('gemini'), ['gemini-3.1-flash-lite', 'gemini-3.5-flash-lite', 'gemini-3.8-flash',
    'gemini-3.1-pro-preview', 'gemini-3.6-flash']);
  for (const p of ['claude', 'openai', 'gemini']) {
    const labels = client.AI_MODELS[p].map(m => m.label);
    assert.equal(labels.filter(l => /cheapest/.test(l)).length, 1, `${p}: one cheapest`);
    assert.equal(labels.filter(l => /most capable/.test(l)).length, 1, `${p}: one most capable`);
    assert.equal(client.AI_MODELS[p].at(-1).value, '__custom__');
  }
  // Gemini 2.5 is open to existing users only, gemini-3.1-pro never existed,
  // and gpt-5.6 is an alias the picker now names.
  assert.ok(!ids('gemini').some(v => v.startsWith('gemini-2.5')));
  assert.ok(!ids('gemini').includes('gemini-3.1-pro'));
  assert.ok(!ids('openai').includes('gpt-5.6'));
});

test('defaults: Claude Haiku 5.5 when none is chosen; a chosen model is kept', () => {
  assert.deepEqual(client.AI_DEFAULT_MODELS, { claude: 'claude-haiku-5-5', openai: 'gpt-5.6-luna', gemini: 'gemini-3.8-flash' });
  for (const p of ['claude', 'openai', 'gemini']) assert.ok(ids(p).includes(client.AI_DEFAULT_MODELS[p]), `${p} default is in the picker`);
  // Settings shows a saved model that isn't listed as a custom one, so it keeps working.
  const trace = readFileSync(new URL('../src/components/settings/SettingsTrace.svelte', import.meta.url), 'utf8');
  assert.match(trace, /if \(saved && !isPreset && aiProviderVal !== 'oai-compat'\) \{\s*aiModelSelectVal = '__custom__';\s*aiCustomModelVal = saved;/);
});

test('saved models: renamed ones go out under the new name, shut-down Gemini ones as the default, 2.5 as saved', () => {
  const g = client.geminiModelFor;
  assert.equal(g('gemini-3.1-pro'), 'gemini-3.1-pro-preview');
  assert.equal(g('gemini-3-pro-preview'), 'gemini-3.1-pro-preview');
  for (const dead of ['gemini-2.0-flash-001', 'gemini-2.0-flash-lite-001', 'gemini-3.1-flash-lite-preview',
    'gemini-2.5-pro-preview-03-25', 'gemini-2.5-pro-preview-05-06', 'gemini-2.5-pro-preview-06-05',
    'gemini-2.5-flash-preview-09-25', 'gemini-2.5-flash-lite-preview-09-2025', 'gemini-1.5-pro']) {
    assert.equal(g(dead), 'gemini-3.8-flash', dead);
  }
  for (const kept of ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-3.6-flash']) assert.equal(g(kept), kept);
  assert.equal(g(''), 'gemini-3.8-flash');
  assert.equal(client.renamedModel('gpt-5.6'), 'gpt-5.6-sol');
  assert.equal(client.renamedModel('claude-opus-5'), 'claude-opus-5');
  // OpenAI-compatible endpoints name their own models: never renamed there.
  const src = readFileSync(new URL('../src/lib/aiChat.js', import.meta.url), 'utf8');
  assert.match(src, /case 'openai':\s+return _callOpenAIWithTools\(apiKey, renamedModel\(model\)/);
  assert.match(src, /case 'oai-compat': \{[\s\S]*?_callOpenAIWithTools\(apiKey \|\| 'no-key', model,/);
});

test("the server's proxy uses the same defaults, renames and shut-down list", (t) => {
  if (!server) { t.skip('better-sqlite3 is not built for this Node'); return; }
  assert.deepEqual(server.AI_DEFAULT_MODELS, client.AI_DEFAULT_MODELS);
  assert.deepEqual(server.AI_MODEL_RENAMES, client.AI_MODEL_RENAMES);
  assert.deepEqual([...server.GEMINI_RETIRED].sort(), [...client.GEMINI_RETIRED].sort());
  for (const m of ['gemini-3.1-pro', 'gemini-2.0-flash-001', 'gemini-2.5-flash', '']) assert.equal(server.geminiModelFor(m), client.geminiModelFor(m));
  const src = readFileSync(new URL('../server/routes/ai.js', import.meta.url), 'utf8');
  assert.match(src, /case 'openai':\s+result = await _callOpenAI\(apiKey, renamedModel\(model\)/);
  assert.match(src, /case 'oai-compat': result = await _callOpenAI\(apiKey \|\| 'no-key', model,/);
});

test('Settings search finds the AI section by the new model names', () => {
  const settings = readFileSync(new URL('../src/routes/Settings.svelte', import.meta.url), 'utf8');
  const ai = settings.match(/^\s*ai:\s*\[([^\]]*)\]/m)[1];
  for (const kw of ['fable', 'luna', 'sol', 'terra', 'flash']) assert.match(ai, new RegExp(`'${kw}'`), kw);
});
