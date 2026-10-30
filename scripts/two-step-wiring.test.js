/**
 * Two-step sign-in (#222), the wiring.
 *
 * - Every place the server signs a session is one this file knows, and each
 *   password sign-in asks challengeFor() first. A new signToken() call fails
 *   here until it's looked at.
 * - Every screen that signs in with a password (the sign-in page, the
 *   Android app's first run, Settings > Server Connection, an invite) shows
 *   the second step, and the app's sign-in hands the challenge along.
 * - The Profile card is for accounts on a server, never "Use Locally".
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

test('the server signs sessions in known places only, each past the two-step check', () => {
  const files = ['../server/routes/auth.js', '../server/routes/oidc.js', '../server/routes/two-step.js'];
  const found = files.flatMap((f) => [...read(f).matchAll(/signToken\(/g)].map(() => f.split('/').pop()));
  // auth.js: finishSignIn, the first account, an own password change (a
  // session already), a reset link, an invite. oidc.js: single sign-on.
  assert.deepEqual(found, ['auth.js', 'auth.js', 'auth.js', 'auth.js', 'auth.js', 'oidc.js']);
  const auth = read('../server/routes/auth.js');
  const login = auth.slice(auth.indexOf("router.post('/login'"), auth.indexOf("router.post('/logout'"));
  assert.match(login, /const kind = challengeFor\(user\);\s*if \(kind\) return sendTwoStepChallenge\(res, user, kind\);\s*finishSignIn\(req, res, user\);/);
  const reset = auth.slice(auth.indexOf("router.post('/reset-password'"), auth.indexOf('// ── Admin: create invite'));
  assert.ok(reset.indexOf('challengeFor(user)') > 0 && reset.indexOf('challengeFor(user)') < reset.indexOf("res.cookie('nt_token'"), 'a reset link asks first');
  const invite = auth.slice(auth.indexOf("router.post('/accept-invite'"), auth.indexOf('// ── Validate a token'));
  assert.ok(invite.indexOf('challengeFor(user)') > 0 && invite.indexOf('challengeFor(user)') < invite.indexOf("res.cookie('nt_token'"), 'an invite asks first');
  // The second step signs in only through finishSignIn, after a right code.
  const routes = read('../server/routes/two-step.js');
  assert.equal([...routes.matchAll(/finishSignIn\(/g)].length, 2, 'verify, and setup during sign-in');
});

test('a pending token is never a session: its own key, and typed tokens refused', () => {
  const lib = read('../server/lib/two-step.js');
  assert.match(lib, /hkdfSync\('sha256', Buffer\.from\(JWT_SECRET, 'utf8'\), Buffer\.from\('traceapps\.two-step\.pending\.v1'\)/);
  assert.match(lib, /jwt\.sign\(\s*\{ typ: PENDING_TYP,[\s\S]*?_pendingKey,/);
  const mw = read('../server/middleware/auth.js');
  assert.match(mw, /payload\.typ == null \? payload : null/);
  assert.match(mw, /req\.user = _session\(jwt\.verify\(cookie, JWT_SECRET\)\)/);
  assert.match(mw, /return \{ user: _session\(jwt\.verify\(token, JWT_SECRET\)\) \}/);
});

test('every password sign-in screen shows the second step', () => {
  const signin = read('../src/lib/server-signin.js');
  assert.match(signin, /const twoStep = twoStepChallenge\(body\);\s*if \(twoStep\) err\.twoStep = twoStep;/);

  const login = read('../src/routes/Login.svelte');
  assert.match(login, /const ch = twoStepChallenge\(data\);\s*if \(ch\) \{ challenge = ch;/);
  assert.match(login, /\{#if challenge\}\s*<TwoStepChallenge \{challenge\}/);
  assert.match(login, /\/api\/auth\/two-step\/recover/, 'Locked Out? resets one account');

  const setup = read('../src/routes/NativeSetup.svelte');
  assert.match(setup, /if \(e\?\.twoStep\) \{ challenge = e\.twoStep; return; \}/);
  assert.match(setup, /<TwoStepChallenge \{challenge\} serverUrl=\{validatedUrl\}/);

  const sc = read('../src/routes/settings/ServerConnection.svelte');
  assert.match(sc, /if \(e\?\.twoStep\) \{ twoStepChallengeOpen = \{ \.\.\.e\.twoStep, url \}; return; \}/);
  assert.match(sc, /<TwoStepChallenge challenge=\{twoStepChallengeOpen\} serverUrl=\{twoStepChallengeOpen\.url\}/);

  const invite = read('../src/routes/AcceptInvite.svelte');
  assert.match(invite, /const ch = twoStepChallenge\(data\);\s*if \(ch\) \{ challenge = ch; return; \}/);

  const reset = read('../src/routes/ResetPassword.svelte');
  assert.match(reset, /if \(data\?\.password_changed\) \{ signInNext = true; return; \}/);
});

test('the Profile card is for server accounts only, and Settings search finds it', () => {
  const profile = read('../src/routes/Profile.svelte');
  assert.match(profile, /\{#if !_isLocal\}\s*<TwoStepSettings \/>/);
  const settings = read('../src/routes/Settings.svelte');
  assert.match(settings, /profile:\s*\[[^\]]*'two-step sign-in'[^\]]*'2fa'[^\]]*'authenticator'/);
  assert.match(settings, /users:\s*\[[^\]]*'require two-step'[^\]]*'reset two-step'/);
});

test('twoStepChallenge reads a server answer', async () => {
  // platform.js needs Capacitor; read the function on its own.
  const src = read('../src/lib/two-step.js');
  const fn = src.slice(src.indexOf('export function twoStepChallenge'), src.indexOf('function _headers'));
  const twoStepChallenge = new Function(`${fn.replace('export ', '')}; return twoStepChallenge;`)();
  assert.deepEqual(twoStepChallenge({ two_step: 'verify', pending_token: 'p' }), { kind: 'verify', pendingToken: 'p' });
  assert.deepEqual(twoStepChallenge({ two_step: 'setup', pending_token: 'p' }), { kind: 'setup', pendingToken: 'p' });
  assert.equal(twoStepChallenge({ two_step: 'other', pending_token: 'p' }), null);
  assert.equal(twoStepChallenge({ two_step: 'verify' }), null);
  assert.equal(twoStepChallenge({ user: {}, token: 't' }), null);
  assert.equal(twoStepChallenge(null), null);
});

// The files every Trace app shares for two-step sign-in. NutriTrace,
// LiftTrace, CookTrace and NoteTrace pin the same hashes: change all four
// copies together, then the hashes in every app. The first five are the
// same bytes everywhere; the rest differ only by the app's name.
test('the shared two-step files match the hashes every Trace app pins', () => {
  const sha = (text) => createHash('sha256').update(text).digest('hex');
  for (const [f, hash] of [
    ['../server/lib/totp.js', '7565c13ec8c6b2f8fb8aeb815a42f4c26886f59163631a1ec875c6d337cf93ba'],
    ['../server/routes/two-step.js', '55f96c12c455e7747ffe396bd8a65e091b2fac22d6e2bd074fbadfe458ff12b8'],
    ['../src/components/two-step/TwoStepChallenge.svelte', '8a8d46ed4962ec41542b4f3a76b212094c0deeb68f203ed40cfcf479f556e77e'],
    ['../src/components/two-step/TwoStepSetup.svelte', 'b25627738912cc29c02b80b94577ca854c9e8e90cf1e2089a2c95fe119e28af7'],
    ['../src/components/two-step/TwoStepSettings.svelte', '568d7431866b0e1eca3ecf49b503fe08b22550ae2ec8385ad0fcc12f458c2d69'],
  ]) assert.equal(sha(read(f)), hash, f);
  // The rest differ by name only in the other apps; NutriTrace is the reference.
  const asNutriTrace = (text) => text;
  for (const [f, hash] of [
    ['../server/lib/two-step.js', '0e6d38d1cabc9ac46af7ae5b7e9ecb034e17539c27f35542fca3cee65d43d168'],
    ['../server/lib/two-step-key.js', 'ccc31ba25a22f235b2bbbc58ae88e6abc12717a3f1ca1594a023d3c3c6f3071f'],
    // NutriTrace's copy before it read the server's .env had 4ce44b47...
    ['../server/scripts/reset-2fa.js', '24bb0ec5ba0af9431645a15f6bba785e4892963ca3517c25aa7ec8d778a890ae'],
    ['./reset-2fa.js', 'db824f7e9afecf5269a150271a2a13e0f667e4c3c1c9e0906854bf4108ea1665'],
    ['../src/components/two-step/RecoveryCodes.svelte', '70a0c80ee7e9552586f9154c0838933b276dedcf9c91b3223da1810df0325128'],
  ]) assert.equal(sha(asNutriTrace(read(f))), hash, f);
});
