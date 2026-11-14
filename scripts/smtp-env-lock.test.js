/**
 * The SMTP lock follows the environment on every start.
 *
 * seedSmtpFromEnv set smtp_env_locked whenever an SMTP_* variable was set
 * and never cleared it, so once the variables were removed Settings > Email
 * stayed read-only and saving a field there answered 403 for good.
 * seedAiFromEnv already clears its lock the same way. Only a non-empty
 * SMTP_HOST locks, and an empty variable never overwrites a saved value,
 * the rule LiftTrace's server already had.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const VARS = ['SMTP_HOST', 'SMTP_PORT', 'SMTP_SECURE', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM'];
for (const v of VARS) delete process.env[v];

// server/db.js opens DB_PATH when imported: a scratch database.
let email = null, db = null, dir = null;
try {
  createRequire(new URL('../server/package.json', import.meta.url))('better-sqlite3');
  dir = mkdtempSync(join(tmpdir(), 'nt-smtp-env-lock-'));
  process.env.DB_PATH = join(dir, 'test.db');
  db = (await import('../server/db.js')).default;
  email = await import('../server/email.js');
} catch { /* better-sqlite3 not built for this Node: these tests skip */ }
test.after(() => { try { db?.close(); } catch {} if (dir) rmSync(dir, { recursive: true, force: true }); });

const value = (key) => db.prepare('SELECT value FROM app_config WHERE key = ?').get(key)?.value;

test('SMTP_* variables lock the email settings', { skip: !email }, () => {
  process.env.SMTP_HOST = 'smtp.example.com';
  process.env.SMTP_FROM = 'nutritrace@example.com';
  email.seedSmtpFromEnv();
  assert.equal(email.isSmtpEnvLocked(), true);
  assert.equal(value('smtp_host'), 'smtp.example.com');
});

test('removing them unlocks the settings and keeps the values to edit', { skip: !email }, () => {
  for (const v of VARS) delete process.env[v];
  email.seedSmtpFromEnv();
  assert.equal(email.isSmtpEnvLocked(), false);
  assert.equal(value('smtp_env_locked'), undefined);
  assert.equal(value('smtp_host'), 'smtp.example.com');
  assert.equal(value('smtp_from'), 'nutritrace@example.com');
});

test('a lock restored from a backup is cleared when no variables are set', { skip: !email }, () => {
  db.prepare("INSERT INTO app_config (key, value) VALUES ('smtp_env_locked', 'true') ON CONFLICT(key) DO UPDATE SET value = excluded.value").run();
  email.seedSmtpFromEnv();
  assert.equal(email.isSmtpEnvLocked(), false);
});

test('an empty SMTP_HOST, or SMTP_PORT alone, does not lock or blank the saved values', { skip: !email }, () => {
  process.env.SMTP_HOST = '';
  process.env.SMTP_PORT = '587';
  email.seedSmtpFromEnv();
  assert.equal(email.isSmtpEnvLocked(), false);
  assert.equal(value('smtp_host'), 'smtp.example.com');
  assert.equal(value('smtp_port'), '587');
  for (const v of VARS) delete process.env[v];
});
