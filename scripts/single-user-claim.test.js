/**
 * Guards the single-user -> multi-user data handover (docs issue #2).
 *
 * In single-user mode there is no users row, so every write lands under a
 * sentinel owner (NULL for FK-bearing tables, 0 for the wearable-token
 * tables that deliberately carry no FK). Enabling user management creates
 * the first account, and routes/auth.js must re-point ALL of that data at
 * it. Miss a table and the data is silently invisible to the new admin.
 *
 * Rather than assert a frozen list, this derives the set of tables that can
 * hold anonymous rows straight from db.js. Add a new user-scoped table and
 * forget to claim it, and this test fails.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const dbJs   = readFileSync(new URL('../server/db.js', import.meta.url), 'utf8');
const authJs = readFileSync(new URL('../server/routes/auth.js', import.meta.url), 'utf8');
const oidcJs = readFileSync(new URL('../server/routes/oidc.js', import.meta.url), 'utf8');
const claimJs = readFileSync(new URL('../server/lib/claim-anonymous-data.js', import.meta.url), 'utf8');
const indexJs = readFileSync(new URL('../server/index.js', import.meta.url), 'utf8');

/** Tables whose user_id column is nullable, i.e. can hold anonymous rows. */
function nullableUserIdTables(src) {
  const out = [];
  const re = /CREATE TABLE IF NOT EXISTS (\w+)\s*\(([\s\S]*?)\n\s*\);/g;
  let m;
  while ((m = re.exec(src))) {
    const [, name, body] = m;
    const col = body.split('\n').find(l => /^\s*user_id\b/.test(l));
    if (col && !/NOT NULL/.test(col)) out.push(name);
  }
  return out;
}

/** Contents of a `const NAME = [ ... ]` string-array literal in auth.js. */
function claimList(name) {
  const m = claimJs.match(new RegExp(`const ${name} = \\[([\\s\\S]*?)\\]`));
  assert.ok(m, `${name} not found in lib/claim-anonymous-data.js`);
  return [...m[1].matchAll(/'([^']+)'/g)].map(x => x[1]);
}

// Justified exclusions. Anything not here MUST be claimed.
const EXCLUDED = {
  oauth_state: 'short-lived OIDC CSRF state, not user data',
};

test('every table that can hold anonymous rows is claimed on first registration', () => {
  const claimed = new Set([...claimList('CLAIM_NULL'), ...claimList('CLAIM_ZERO'), ...claimList('CLAIM_BOTH')]);
  const missing = nullableUserIdTables(dbJs).filter(t => !claimed.has(t) && !EXCLUDED[t]);
  assert.deepEqual(missing, [],
    `these tables can hold single-user-mode rows but are never claimed: ${missing.join(', ')}`);
});

test('the wearable-token tables are claimed from the 0 sentinel, not NULL', () => {
  // routes/fitbit.js et al. use `userMgmtActive() ? req.user.id : 0`.
  for (const t of ['fitbit_tokens', 'google_health_tokens', 'withings_tokens', 'garmin_tokens']) {
    assert.ok(claimList('CLAIM_ZERO').includes(t), `${t} must be claimed from user_id = 0`);
  }
});

test('wellness_data and workouts are claimed from BOTH sentinels', () => {
  // The pollers write 0 while /api/sync writes NULL, so both land in the
  // same table and both have to be picked up.
  for (const t of ['wellness_data', 'workouts']) {
    assert.ok(claimList('CLAIM_BOTH').includes(t), `${t} receives both sentinels`);
  }
});

test('the both-sentinel claim tolerates UNIQUE collisions instead of aborting registration', () => {
  // wellness_data is UNIQUE(user_id,date,source,metric_type) and workouts is
  // UNIQUE(user_id,source,source_id); a NULL row and a 0 row for the same
  // metric collide once they land on the same owner. OR REPLACE resolves it.
  const body = claimJs.match(/for \(const t of CLAIM_BOTH\) \{([\s\S]*?)\n  \}/)[1];
  assert.match(body, /UPDATE OR REPLACE \$\{t\} SET user_id = \? WHERE user_id IS NULL/);
  assert.match(body, /UPDATE OR REPLACE \$\{t\} SET user_id = \? WHERE user_id = 0/);
});

test('the claim runs in a single transaction', () => {
  assert.match(claimJs, /export const claimAnonymousData = db\.transaction\(/);
});

test('the claim only fires for the first account', () => {
  assert.match(authJs, /if \(isFirst\) \{\s*\n\s*claimAnonymousData\(user\.id\);/);
});

test('BOTH first-account paths claim: password registration and OIDC bootstrap', () => {
  // There are two ways to become the first account. routes/oidc.js used to
  // carry its own shorter copy of the claim list, so an OIDC-first instance
  // silently kept the original bug after the password path was fixed.
  for (const [name, src] of [['routes/auth.js', authJs], ['routes/oidc.js', oidcJs]]) {
    assert.match(src, /import \{[^}]*\bclaimAnonymousData\b[^}]*\} from '\.\.\/lib\/claim-anonymous-data\.js'/,
      `${name} must import the shared claim helper`);
  }
  assert.match(oidcJs, /claimAnonymousData\(result\.user\.id\)/);
  // and neither route may hand-roll its own UPDATE ... user_id IS NULL again
  for (const [name, src] of [['routes/auth.js', authJs], ['routes/oidc.js', oidcJs]]) {
    assert.doesNotMatch(src, /UPDATE \w+\s+SET user_id = \? WHERE user_id IS NULL/,
      `${name} should call claimAnonymousData(), not re-implement the claim`);
  }
});

test('claiming clears the single_user_mode flag', () => {
  // /status reports single_user_mode straight from app_config; leaving it set
  // after an account exists makes the instance describe itself wrongly.
  assert.match(claimJs, /DELETE FROM app_config WHERE key = 'single_user_mode'/);
});

test('startup runs the one-time repair for instances that upgraded past the bug', () => {
  // The claim only fires while the first account is created, so an instance
  // that already enabled user management on an older build needs adopting.
  assert.match(indexJs, /repairOrphanedData/);
  assert.match(claimJs, /export function repairOrphanedData/);
});

test('the repair refuses to guess when ownership is ambiguous', () => {
  // Zero accounts is ordinary single-user mode and must be left alone; two or
  // more means the rows cannot be attributed without asking a human.
  const body = claimJs.match(/export function repairOrphanedData\(\) \{([\s\S]*?)\n\}/)[1];
  assert.match(body, /users\.length === 0/);
  assert.match(body, /users\.length > 1/);
  assert.match(body, /ambiguous/);
});

test('every account-removal path clears rows the FK cascade cannot reach', () => {
  // Self-delete, admin delete, disable and lockout-recovery all remove
  // accounts. Tables with no FK to users(id) survive that, so each path has to
  // clean up explicitly or a deleted user's rows (wearable history, live OAuth
  // refresh tokens) stay in the database.
  for (const h of ["router.delete('/me'", "router.delete('/users/:id'"]) {
    const i = authJs.indexOf(h);
    assert.ok(i > -1, `${h} handler not found`);
    const body = authJs.slice(i, i + 2000);
    assert.match(body, /purgeUserRows\(/, `${h} must purge non-cascading tables`);
  }
});

test('disable and lockout-recovery purge non-cascading tables', () => {
  for (const h of ["router.delete('/management'", "router.post('/recover'"]) {
    const i = authJs.indexOf(h);
    assert.ok(i > -1, `${h} handler not found`);
    assert.match(authJs.slice(i, i + 2000), /purgeUnreferencedUserData\(\)/,
      `${h} must purge tables the cascade misses`);
  }
});

test('the purge spares genuinely anonymous rows', () => {
  // Disabling returns the instance to single-user mode, so NULL/0-owned rows
  // must stay readable. Only rows owned by a real account are removed.
  assert.match(claimJs, /DELETE FROM \$\{t\} WHERE user_id IS NOT NULL AND user_id != 0/);
});

test('no user-scoped table without an FK is left out of the cleanup', () => {
  // Tables that carry an FK to users(id) are cleaned by ON DELETE CASCADE.
  // Every other user-scoped table has to be removed explicitly or a deleted
  // account's rows survive. Derived from db.js, so a new table cannot slip in.
  const noFk = [];
  const re = /CREATE TABLE IF NOT EXISTS (\w+)\s*\(([\s\S]*?)\n\s*\);/g;
  let m;
  while ((m = re.exec(dbJs))) {
    const [, name, body] = m;
    const col = body.split('\n').find(l => /^\s*user_id\b/.test(l));
    if (col && !/REFERENCES users/.test(col)) noFk.push(name);
  }
  const listed = new Set([...(claimJs.match(/NO_CASCADE_TABLES = \[([\s\S]*?)\]/)?.[1] || '')
    .matchAll(/'(\w+)'/g)].map(x => x[1]));
  const explicit = new Set([...`${authJs}${claimJs}`.matchAll(/DELETE FROM (\w+) WHERE user_id = \?/g)].map(x => x[1]));
  const missing = noFk.filter(t => !listed.has(t) && !explicit.has(t));
  assert.deepEqual(missing, [],
    `no FK and never explicitly deleted, so a removed account's rows survive: ${missing.join(', ')}`);
});
