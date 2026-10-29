#!/usr/bin/env node
/**
 * Reset two-step sign-in for one account, on the server (#222):
 *
 *   docker exec -it nutritrace npm run reset-2fa -- <username>
 *
 * The last step of getting back in, for the owner, when no recovery code,
 * admin or RECOVERY_TOKEN can help. Turns two-step sign-in off for that one
 * account (its secret and recovery codes go), logs it, and emails the person
 * when the server sends email. Nothing else changes. With no username, it
 * lists the accounts that have two-step sign-in on.
 */
import { readFileSync } from 'node:fs';

const username = String(process.argv[2] || '').trim().toLowerCase();

// `docker exec` skips docker-entrypoint.sh, so secrets given as <NAME>_FILE
// (JWT_SECRET_FILE, TWO_STEP_KEY_FILE) are read here the same way.
for (const [k, v] of Object.entries(process.env)) {
  const m = k.match(/^([A-Za-z_][A-Za-z0-9_]*)_FILE$/);
  if (!m || !v || process.env[m[1]]) continue;
  try { process.env[m[1]] = readFileSync(v, 'utf8').replace(/[\r\n]+$/, ''); } catch { /* the server says so on its own start */ }
}

const { default: db } = await import('../db.js');
const { turnOff, isEnabled } = await import('../lib/two-step.js');

if (!username || username === '--help' || username === '-h') {
  const on = db.prepare('SELECT u.username FROM user_two_step t JOIN users u ON u.id = t.user_id WHERE t.enabled = 1 ORDER BY u.username').all();
  console.log('Reset two-step sign-in for one account:');
  console.log('  npm run reset-2fa -- <username>');
  console.log('');
  console.log(on.length ? `Accounts with two-step sign-in on: ${on.map((r) => r.username).join(', ')}` : 'No account has two-step sign-in on.');
  process.exit(username ? 0 : 1);
}

const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
if (!user) {
  console.error(`No account has the username "${username}".`);
  process.exit(1);
}
if (!isEnabled(user.id)) {
  turnOff(user, 'reset_by_command'); // a setup never finished goes too, quietly
  console.log(`Two-step sign-in is already off for ${user.username}.`);
  process.exit(0);
}
turnOff(user, 'reset_by_command');
console.log(`Two-step sign-in is off for ${user.username}. They can sign in with their password, then set it up again in Settings, Profile.`);
// Give a notice email a moment to leave.
setTimeout(() => process.exit(0), 1500);
