/**
 * PR #308 (@librarian): with AI locked by environment variables, Settings
 * showed the provider and model saved in the browser, not the server's.
 * /api/app-config/env-locks now reports the provider and the model the
 * proxy sends (renamed and shut-down models mapped), and never the key or
 * base URL.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';

let db = null, dir = null, server = null, base = null;
try {
  const req = createRequire(new URL('../server/package.json', import.meta.url));
  req('better-sqlite3');
  dir = mkdtempSync(join(tmpdir(), 'ai-env-locked-'));
  process.env.DB_PATH = join(dir, 'test.db');
  db = (await import('../server/db.js')).default;
  const express = req('express');
  const { default: routes } = await import('../server/routes/app-config.js');
  const app = express();
  app.use(express.json());
  app.use((r, _res, next) => { r.user = { id: 0, role: 'admin' }; next(); });
  app.use('/api/app-config', routes);
  server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
} catch { /* better-sqlite3 not built for this Node: the cases skip */ }
test.after(() => { server?.close(); try { db?.close(); } catch {} if (dir) rmSync(dir, { recursive: true, force: true }); });

function config(cfg) {
  db.prepare("DELETE FROM app_config WHERE key LIKE 'ai_%'").run();
  const put = db.prepare('INSERT INTO app_config (key, value) VALUES (?, ?)');
  for (const [k, v] of Object.entries(cfg)) put.run(k, v);
}
const locks = async () => (await fetch(`${base}/api/app-config/env-locks`)).json();

test('locked: the server provider and model are reported, not secrets', async (t) => {
  if (!db) return t.skip('better-sqlite3 is not built for this Node');
  config({ ai_env_locked: 'true', ai_enabled: 'true', ai_provider: 'openai', ai_model: 'gpt-6-luna', ai_api_key: 'sk-secret', ai_base_url: 'http://10.0.0.5:11434' });
  const r = await locks();
  assert.equal(r.ai, true);
  assert.equal(r.ai_enabled, true);
  assert.equal(r.ai_provider, 'openai');
  assert.equal(r.ai_model, 'gpt-6-luna');
  const body = JSON.stringify(r);
  assert.ok(!body.includes('sk-secret') && !body.includes('10.0.0.5'), 'no key or base URL');
});

test('locked: the model shown is the one the proxy sends', async (t) => {
  if (!db) return t.skip('better-sqlite3 is not built for this Node');
  config({ ai_env_locked: 'true', ai_enabled: 'true', ai_provider: 'openai', ai_model: 'gpt-5.6' });
  assert.equal((await locks()).ai_model, 'gpt-5.6-sol');
  config({ ai_env_locked: 'true', ai_enabled: 'true', ai_provider: 'gemini', ai_model: 'gemini-2.0-flash' });
  assert.equal((await locks()).ai_model, 'gemini-3.8-flash');
  config({ ai_env_locked: 'true', ai_enabled: 'true' });
  const r = await locks();
  assert.equal(r.ai_provider, 'claude');
  assert.equal(r.ai_model, 'claude-haiku-5-5');
});

test('not locked: nothing about the server AI is reported', async (t) => {
  if (!db) return t.skip('better-sqlite3 is not built for this Node');
  config({ ai_enabled: 'true', ai_provider: 'openai', ai_model: 'gpt-6-luna' });
  const r = await locks();
  assert.equal(r.ai, false);
  assert.equal(r.ai_enabled, false);
  assert.equal(r.ai_provider, '');
  assert.equal(r.ai_model, '');
});

test('Settings shows the server values when locked, by name, and the saved ones for an older server', () => {
  const src = readFileSync(new URL('../src/components/settings/SettingsTrace.svelte', import.meta.url), 'utf8');
  assert.match(src, /\$: _lockedProvider = envLocks\.ai_provider \|\| aiProviderVal;/);
  assert.match(src, /\$: _lockedModelId = envLocks\.ai_model \|\| aiModelVal \|\| '';/);
  // Shown in the same small dropdown as unlocked, greyed out, so the rows keep their look.
  assert.match(src, /<select class="select sel-sm pick" style="width:auto" disabled>\s*<option>\{AI_PROVIDERS\.find\(p => p\.value === _lockedProvider\)\?\.label \|\| _lockedProvider \|\| ''\}<\/option>/);
  assert.match(src, /<select class="select sel-sm pick" style="width:auto" disabled>\s*<option>\{_lockedModel\}<\/option>/);
  // The label without the picker's hint: "GPT-6 Luna (fast, cheapest)" shows as "GPT-6 Luna".
  const m = src.match(/\$: _lockedModel = (.*);/)[1];
  assert.match(m, /\.label\.replace\(\/ \\\(\.\*\\\)\$\/, ''\) \|\| _lockedModelId$/);
  assert.equal('GPT-6 Luna (fast, cheapest)'.replace(/ \(.*\)$/, ''), 'GPT-6 Luna');
});
