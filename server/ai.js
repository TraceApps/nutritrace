import db from './db.js';

/** Seed AI config from env vars at startup — env vars take priority over UI */
export function seedAiFromEnv() {
  const map = {
    AI_ENABLED:  'ai_enabled',
    AI_PROVIDER: 'ai_provider',
    AI_API_KEY:  'ai_api_key',
    AI_MODEL:    'ai_model',
  };
  const upsert = db.prepare(
    'INSERT INTO app_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  );
  const del = db.prepare('DELETE FROM app_config WHERE key = ?');
  let locked = false;
  for (const [envKey, dbKey] of Object.entries(map)) {
    if (process.env[envKey] != null) {
      upsert.run(dbKey, process.env[envKey]);
      locked = true;
    }
  }
  if (locked) {
    upsert.run('ai_env_locked', 'true');
  } else {
    // No AI_* env vars set on this run. Clear any prior lock so the UI
    // unlocks after the operator removes the env vars from compose and
    // restarts. Without this, the lock persists forever (issue #36).
    del.run('ai_env_locked');
  }
}

export function getAiConfig() {
  const rows = db.prepare("SELECT key, value FROM app_config WHERE key LIKE 'ai_%'").all();
  const cfg = {};
  for (const { key, value } of rows) cfg[key] = value;
  return cfg;
}

export function isAiEnvLocked() {
  const row = db.prepare('SELECT value FROM app_config WHERE key = ?').get('ai_env_locked');
  return row?.value === 'true';
}
