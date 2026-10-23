/**
 * Coaching in the app, without a browser:
 *
 * - Which Goals tabs show: none for anyone not in coaching, none on a server
 *   from before coaching, Coach for a client or a request, Clients for the
 *   Coach role and for an admin only once they coach someone.
 * - The fingerprint the app computes matches the server's format, so the
 *   settings refresh asks again only when something changed.
 * - Offline: a coach's list and client views are kept (browser and Android);
 *   where you stand is not kept there (stores/coaching.js keeps the newest
 *   answer itself, and a kept copy would be older than an Accept made since:
 *   found on the emulator), nor the name list or admin pairings.
 * - Every coaching screen string is in en.json, and Users search finds "coach".
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

function fnFrom(src, name) {
  const start = src.indexOf(`export function ${name}`);
  assert.ok(start >= 0, name);
  let depth = 0, i = src.indexOf('{', start);
  for (; i < src.length; i++) { if (src[i] === '{') depth++; else if (src[i] === '}' && --depth === 0) break; }
  return new Function(`${src.slice(start, i + 1).replace('export ', '')}; return ${name};`)();
}

const store = read('../src/stores/coaching.js');
const coachTab = fnFrom(store, 'showsCoachTab');
const clientsTab = fnFrom(store, 'showsClientsTab');
const signature = fnFrom(store, 'coachingSignature');
const none = { pending: 0, active: 0 };

test('Goals tabs: nothing for people not in coaching', () => {
  for (const role of ['user', 'admin']) {
    const s = { role, can_coach: role === 'admin', as_client: null, as_coach: none };
    assert.equal(coachTab(true, s), false, role);
    assert.equal(clientsTab(true, s), false, role);
  }
  // Single-user mode, Android local mode, an older server: no state or no support.
  assert.equal(clientsTab(true, null), false);
  assert.equal(coachTab(false, { role: 'user', as_client: null, requests: [{ id: 1 }], as_coach: none }), false);
  assert.equal(clientsTab(false, { role: 'coach', as_client: null, as_coach: none }), false);
});

test('Goals tabs: Coach for a client, Clients for coaches', () => {
  assert.equal(coachTab(true, { role: 'user', as_client: null, requests: [{ id: 3 }], as_coach: none }), true, 'a request to answer');
  assert.equal(coachTab(true, { role: 'user', as_client: { id: 3, status: 'active' }, as_coach: none }), true);
  assert.equal(clientsTab(true, { role: 'coach', as_client: null, as_coach: none }), true, 'a Coach with no clients yet');
  assert.equal(clientsTab(true, { role: 'admin', as_client: null, as_coach: { pending: 1, active: 0 } }), true);
  assert.equal(clientsTab(true, { role: 'admin', as_client: null, as_coach: { pending: 0, active: 2 } }), true);
  assert.equal(clientsTab(true, { role: 'admin', as_client: null, as_coach: { pending: 0, active: 0, recent: 1 } }), true, 'an answer from the last week');
  // A person can have a coach and be a coach.
  const both = { role: 'coach', as_client: { id: 9, status: 'active' }, as_coach: { pending: 0, active: 1 } };
  assert.equal(coachTab(true, both) && clientsTab(true, both), true);
});

test('the fingerprint has the server\'s shape', () => {
  assert.equal(signature({ role: 'user', as_client: null, requests: [], past: [], as_coach: none, unread: 0, awaiting: 0, latest_recommendation: 0 }), 'user;-;-;0.0;-;0;0;0');
  assert.equal(signature({ role: 'coach', as_client: { id: 12 }, requests: [{ id: 15 }, { id: 14 }], past: [{ id: 3 }], as_coach: { pending: 2, active: 3 }, unread: 4, awaiting: 3, latest_recommendation: 9 }), 'coach;12;15,14;2.3;3;4;3;9');
  // The real server's header is compared with this in coaching-server.test.js.
});

function keepList(src, re) {
  const body = src.match(re)?.[1];
  assert.ok(body, 'keep list found');
  return new Function(`return [${body}]`)();
}

const KEPT = ['/api/coaching/clients', '/api/coaching/clients?today=2026-10-13', '/api/coaching/clients/7/overview?today=2026-10-13', '/api/coaching/clients/7/diary/2026-10-12'];
const NOT_KEPT = ['/api/coaching/state', '/api/coaching/candidates', '/api/coaching/admin/pairings', '/api/coaching/clients/7/diary/bad', '/api/coaching/clients/7'];

test('offline in the browser: a coach\'s views are kept, where you stand is not', () => {
  const src = read('../src/lib/offline-api.js');
  const res = keepList(src, /const _KEEP_READS = \[([\s\S]*?)\n\];/);
  const kept = (p) => res.some((re) => re.test(p));
  for (const p of KEPT) assert.ok(kept(p), p);
  for (const p of NOT_KEPT) assert.ok(!kept(p), p);
  const readKey = new Function(`${src.match(/const _readKey = [^\n]+/)[0]}; return _readKey;`)();
  assert.equal(readKey('/api/coaching/clients?today=2026-10-13'), '/api/coaching/clients');
  assert.equal(readKey('/api/coaching/clients/7/overview?today=2026-10-13'), '/api/coaching/clients/7/overview');
  assert.equal(readKey('/api/wellness/fitbit/data?date=2026-10-13'), '/api/wellness/fitbit/data?date=2026-10-13', 'other reads keep their key');
  // A former client's copies go.
  assert.match(src, /async forgetCoachingReads\(activeClientIds = \[\]\)/);
  assert.match(read('../src/routes/Clients.svelte'), /NtApi\.forgetCoachingReads\(/);
});

test('offline on Android: the same list, and the server\'s message comes through', () => {
  const src = read('../src/lib/api-cached.js');
  const re = new Function(`return ${src.match(/const _COACH_KEEP = (\/[^\n]+\/);/)[1]}`)();
  for (const p of KEPT) assert.ok(re.test(p), p);
  for (const p of NOT_KEPT) assert.ok(!re.test(p), p);
  assert.match(src, /if \(_COACHING\.test\(path\)\) return _coachingGet\(path\);/);
  assert.match(src, /if \(_COACHING\.test\(path\)\) return _coachingFetch\('POST', path, body\);/);
  assert.match(src, /err\.offline = true;/);
  assert.match(src, /new Error\(data\.error \|\| `API error \$\{res\.status\}`\)/);
  // Local mode answers too, so a caller's .catch is never left with a stub.
  assert.match(read('../src/lib/api-native.js'), /async forgetCoachingReads\(\) \{ return 0; \}/);
});

test('the message queue: a server hiccup waits, a refusal is marked, a delete follows a message still sending', () => {
  const cm = read('../src/lib/coach-messages.js');
  // 5xx (a restart behind a proxy) or no answer: waits and goes later.
  assert.match(cm, /if \(e\?\.offline \|\| status >= 500 \|\| !status \|\|/);
  // Deleting a message still sending marks it, so its answer can't bring it back.
  assert.match(cm, /if \(m\.sync_status === 'failed'\) return s\.del\('coach_messages', \[uuid\]\);/);
  assert.match(read('../src/lib/db-native.js'), /if \(r\.sync_status === 'failed'\) \{/);
  // The cursor only counts while the device holds the conversation.
  assert.match(cm, /if \(since && \(!usable \|\| !\(await store\.list\(conv\.pairingId\)\)\.length\)\) since = null;/);
  // Nowhere to keep it: sent straight away, or the send fails visibly.
  assert.match(cm, /if \(!\(await store\.available\(\)\)\) \{/);
  // Sign-out clears the cursors with the rest.
  assert.match(store, /k\.startsWith\('nt:coach-cursor:'\)/);
});

test('the day\'s targets as the Diary resolves them (goal.achieved and the coach\'s view use it)', async () => {
  const { dayTargets } = await import('../src/lib/goal-resolver.js');
  const goals = {
    calories: { sharedGoal: false, days: [2300, 2000, 2000, 2100, 2000, 2000, 2400], max: 2400 },
    proteins: { sharedGoal: true, isPercent: true, max: 30, days: Array(7).fill(30) },
    carbohydrates: { sharedGoal: true, isMin: true, min: 180, days: Array(7).fill(180) },
  };
  // 2026-10-13 is a Tuesday: 2000 kcal; protein 30% = 150 g; fat unset.
  assert.deepEqual(dayTargets(goals, '2026-10-13'), { calories: 2000, proteins: 150, carbohydrates: 180, fat: null });
  assert.deepEqual(dayTargets(goals, '2026-10-17'), { calories: 2400, proteins: 180, carbohydrates: 180, fat: null }, 'Saturday');
  assert.deepEqual(dayTargets({ calories: 1800, fat: 60 }, '2026-10-13'), { calories: 1800, proteins: null, carbohydrates: null, fat: 60 }, 'plain numbers still read');
});

test('recommended targets: the comparison, the mode, a recommendation of a mode alone', async () => {
  const t = await import('../src/lib/coach-targets.js');
  const now = { calories: { sharedGoal: true, max: 2000, days: Array(7).fill(2000) }, proteins: { sharedGoal: true, isPercent: true, max: 30, days: Array(7).fill(30) } };
  const rec = { goals: { calories: { sharedGoal: true, max: 1800, days: Array(7).fill(1800) }, proteins: { sharedGoal: false, days: [140, 150, 150, 150, 150, 150, 160], max: 160 } } };
  const rows = t.comparisonRows(now, rec, 2); // a Tuesday
  assert.deepEqual(rows.map((r) => [r.key, r.current, r.proposed, r.diff]), [['calories', 2000, 1800, -200], ['proteins', 150, 150, 0]]);
  assert.equal(rows[1].currentPercent, 30, 'the percent shows beside its grams');
  assert.equal(rows[1].byWeekday, true);
  assert.deepEqual(rows[1].proposedDays, [140, 150, 150, 150, 150, 150, 160]);
  // Dynamic or Adaptive: "now" is today's effective goal (2150), and percent
  // macros follow it, as in the Diary.
  const eff = t.comparisonRows(now, rec, 2, { caloriesNow: 2150 });
  assert.deepEqual(eff.map((r) => [r.key, r.current, r.diff]), [['calories', 2150, -350], ['proteins', 161, -11]]);
  const card = read('../src/components/coaching/TargetsCard.svelte');
  assert.match(card, /coaching\.targets\.now_effective/);
  assert.match(card, /\$: effectiveMode = !coachView && rec\.status === 'pending' && \(\$calorieGoalMode === 'dynamic' \|\| \$calorieGoalMode === 'adaptive'\)/, 'fetched only for a pending card with Dynamic or Adaptive');
  assert.equal(t.acceptSwitchesToFixed('adaptive', rec), true);
  assert.equal(t.acceptSwitchesToFixed('fixed', rec), false);
  assert.equal(t.acceptSwitchesToFixed('adaptive', { mode: 'adaptive', goals: rec.goals }), false, 'a recommended mode is used as it is');
  const modeOnly = t.cleanTargetsPayload({ mode: 'adaptive' });
  assert.deepEqual(modeOnly.payload, { goals: {}, mode: 'adaptive' });
  assert.deepEqual(t.applyTargets(now, 'fixed', modeOnly.payload), { goals: now, mode: 'adaptive', modeChanged: true });
  assert.ok(t.cleanTargetsPayload({ goals: { calories: { max: 0 } } }).error, 'zero is not a target');
  for (const odd of [true, '0x10', [1500], 'abc']) assert.ok(t.cleanTargetsPayload({ goals: { calories: { max: odd } } }).error, `not a number: ${JSON.stringify(odd)}`);
  assert.equal(t.cleanTargetsPayload({ goals: { calories: { max: '1800' } } }).payload.goals.calories.max, 1800, 'a plain number in text is fine');
  assert.ok(t.cleanTargetsPayload({ goals: { proteins: { isPercent: true, max: 60 }, fat: { isPercent: true, max: 50 } } }).error, 'percents over 100 in total');
});

test('day plans: Expired from the date, Logged from the day\'s items, the client\'s own food first', async () => {
  const p = await import('../src/lib/coach-plans.js');
  const rec = { id: 7, kind: 'day_plan', status: 'pending', date: '2026-10-12' };
  assert.equal(p.shownStatus(rec, '2026-10-13'), 'expired');
  assert.equal(p.shownStatus(rec, '2026-10-12'), 'pending');
  assert.equal(p.shownStatus({ ...rec, status: 'accepted' }, '2026-10-13'), 'accepted', 'answered is never Expired');
  assert.equal(p.shownStatus({ ...rec, kind: 'targets' }, '2026-10-13'), 'pending');
  // Each item marks its plan and place: a meal is logged once all its items are.
  const plan = { id: 7, payload: { meals: [{ meal: 0, items: [{}, {}] }, { meal: 2, items: [{}] }] } };
  const items = [{ meal: 0, source: 'coach:plan:7:0.0' }, { meal: 3, source: 'coach:plan:7:2.0' }, { meal: 1, source: 'coach:plan:70:0.1' }, { meal: 0 }];
  assert.deepEqual([...p.loggedItems(items, 7)].sort(), ['0.0', '2.0']);
  assert.deepEqual([...p.loggedMeals(items, plan)], [2], 'moved to another meal, still the plan\'s; Breakfast has one item to go');
  assert.deepEqual([...p.loggedMeals([...items, { source: 'coach:plan:7:0.1' }], plan)].sort(), [0, 2]);
  // Android meals keep the phone's id in `id`: the server's is what counts.
  assert.equal(p.ingredientFoodId({ id: 3, server_id: 41 }), 41);
  assert.equal(p.ingredientFoodId({ id: 3, server_id: null }), null);
  assert.equal(p.ingredientFoodId({ id: 5, food_server_id: 52 }), 52);
  assert.equal(p.ingredientFoodId({ id: 9 }), 9);
  // On Android a food's own id is the phone's; the server's is server_id.
  const foods = [{ id: 3, server_id: 41, name: 'Oats' }, { id: 4, server_id: null, name: 'Granola', source_app: 'coach', source_external_id: 'food:9' }, { id: 5, server_id: 50, name: 'Shake', barcode: '4006381333931' }];
  assert.equal(p.findOwn({ source: { kind: 'client_food', id: 41 } }, { foods }).name, 'Oats');
  assert.equal(p.findOwn({ source: { kind: 'client_food', id: 3 } }, { foods }), null, 'never by the phone\'s own id');
  assert.equal(p.findOwn({ source: { kind: 'coach_food', id: 9 } }, { foods }).name, 'Granola');
  assert.equal(p.findOwn({ source: { kind: 'off' }, barcode: '4006381333931' }, { foods }).name, 'Shake');
  assert.equal(p.findOwn({ source: { kind: 'coach_food', id: 10 } }, { foods }), null);
  assert.deepEqual(p.foodFromPlanItem({ name: 'G', portion: 60, unit: 'g', nutrition: { calories: 270 }, barcode: null, source: { kind: 'coach_recipe', id: 4 } }),
    { name: 'G', brand: null, portion: 60, unit: 'g', nutrition: { calories: 270 }, barcode: null, source_app: 'coach', source_external_id: 'recipe:4' });
});

test('a client\'s own food deleted since a plan: copied once, then found again; today turns over at midnight while open', async (t) => {
  const p = await import('../src/lib/coach-plans.js');
  const item = { name: 'Oats', portion: 50, unit: 'g', nutrition: { calories: 190 }, barcode: null, source: { kind: 'client_food', id: 41 } };
  assert.equal(p.findOwn(item, { foods: [] }), null, 'deleted: not theirs any more');
  const copy = { id: 9, ...p.foodFromPlanItem(item) };
  assert.deepEqual([copy.source_app, copy.source_external_id], ['coach', 'own-food:41']);
  assert.equal(p.findOwn(item, { foods: [copy] }), copy, 'the copy made the first time');
  // The coaching views' today: a timer to the next midnight while used.
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: new Date(2026, 9, 13, 23, 59, 0) });
  const { today } = await import('../src/lib/coaching-view.js?midnight');
  const seen = [];
  const stop = today.subscribe(v => seen.push(v));
  t.mock.timers.tick(2 * 60 * 1000);
  stop();
  assert.deepEqual(seen, ['2026-10-13', '2026-10-14']);
});

test('coaching errors are said from en.json: every code the server and the shared rules give has its words', async () => {
  const en = JSON.parse(read('../src/i18n/en.json'));
  const errs = en.coaching.errors;
  const files = ['../server/routes/coaching.js', '../server/lib/coaching.js', '../server/lib/coaching-messages.js',
    '../server/lib/coaching-recommendations.js', '../src/lib/coach-targets.js', '../src/lib/coach-plans.js'];
  const codes = new Set();
  for (const f of files) {
    const src = read(f);
    for (const [, c] of src.matchAll(/code: '([a-z_]+)'/g)) codes.add(c);
    for (const [, c] of src.matchAll(/_bad\([^;]*?,\s*\d{3},\s*'([a-z_]+)'/g)) codes.add(c);
    for (const [, c] of src.matchAll(/'(rec_[a-z]+)'/g)) codes.add(c);
  }
  assert.ok(codes.size >= 50, `found ${codes.size}`);
  for (const c of codes) assert.equal(typeof errs[c], 'string', c);
  // No coaching error answer leaves without its code.
  for (const f of ['../server/routes/coaching.js', '../server/lib/coaching.js']) {
    for (const line of read(f).split('\n').filter(l => /json\(\{ error/.test(l))) assert.match(line, /code/, line.trim());
  }
  const { coachingErrorText } = await import('../src/lib/coaching-view.js');
  const t = (k, o) => { const v = k.split('.').reduce((x, p) => x?.[p], en); return typeof v === 'string' ? v.replace(/\{(\w+)(?:, number)?\}/g, (_, n) => o?.values?.[n] ?? '') : k; };
  assert.equal(coachingErrorText({ code: 'already_asked', params: { name: 'Jo' }, message: 'You already asked Jo.' }, t), 'You already asked Jo.');
  assert.equal(coachingErrorText({ code: 'plan_meal_too_many', params: { max: 30 } }, t), 'A meal can hold up to 30 items.');
  assert.equal(coachingErrorText({ code: 'something_new', message: 'Raw English' }, t), en.coaching.something_failed, 'an unknown code: the general words, never raw text');
  assert.equal(coachingErrorText({ message: 'Raw English' }, t), en.coaching.something_failed);
  assert.equal(coachingErrorText({ offline: true }, t), en.coaching.needs_connection);
  // The shared rules give their code too.
  const p = await import('../src/lib/coach-plans.js');
  assert.deepEqual([p.cleanPlanPayload({ meals: [] }).code], ['plan_empty']);
  assert.deepEqual(p.cleanPlanPayload({ meals: [{ meal: 0, items: [{ name: 'Oats', portion: -1, nutrition: {}, source: { kind: 'off' } }] }] }).params, { name: 'Oats' });
});

test('day plans add nothing for people not in coaching: the Diary card is only theirs, the Foods page changes only for a plan item', () => {
  const foods = read('../src/routes/Foods.svelte');
  assert.match(foods, /if \(editorState\.planLog\) \{/);
  assert.match(foods, /if \(_planSource\) item\.source = _planSource;/);
  assert.match(read('../src/stores/editorState.js'), /planLog: +null,/);
  // The card reads what Goals and the Diary already load: no request of its own.
  assert.doesNotMatch(read('../src/components/coaching/DiaryPlanCard.svelte'), /NtApi|fetch\(|loadCoachRecommendations/);
});

test('the editors: Share only when an admin has sharing on, Send to Client only for a coach with clients, neither for a shared item or with no server', () => {
  for (const f of ['../src/routes/FoodEditor.svelte', '../src/routes/MealEditor.svelte']) {
    const src = read(f).replace(/\r/g, '');
    assert.match(src, /\$: _canShare = \$sharingOn && \$userMgmtActive && !\(isNative && !getServerUrl\(\)\);/, f);
    assert.match(src, /\{#if (food|meal)\.id && !_readOnly && _canShare\}/, f);
  }
  const meal = read('../src/routes/MealEditor.svelte').replace(/\r/g, '');
  assert.match(meal, /\$: _canSend = \$clientsTab && \(Number\(\$coachingState\?\.as_coach\?\.active\) \|\| 0\) > 0 && !\(isNative && !getServerUrl\(\)\);/);
  assert.match(meal, /\{#if meal\.id && !_readOnly && _canSend\}/);
  // Saving never sends sharing: an older copy in the editor can't undo it.
  assert.match(read('../src/routes/FoodEditor.svelte'), /const \{ visibility: _v, _specific_users: _s, \.\.\.changes \} = item;[\s\S]*?NtApi\.updateFood\(food\.id, changes\)/);
  assert.match(read('../src/routes/MealEditor.svelte'), /if \(meal\.id\) \{ const \{ visibility: _v, _specific_users: _s, \.\.\.changes \} = item; await NtApi\.updateMeal\(meal\.id, changes\); \}/);
  // Whether sharing is on comes from what the Foods page and the meal editor
  // already ask: the food editor makes no request of its own for it.
  assert.doesNotMatch(read('../src/routes/FoodEditor.svelte'), /getSharingStatus/);
  // The share sheet goes to the server's per-item routes, by the server's id.
  const share = read('../src/lib/share-item.js');
  assert.match(share, /NtApi\.patch\(`\/api\/\$\{kind\}\/\$\{sid\}\/share`/);
  assert.match(share, /serverIdOf\(item\)/);
  assert.match(share, /row\.sync_status === 'pending'/, 'on Android, an item with changes not sent waits');
  assert.match(share, /isTempId\(sid\)/, 'in the browser, one made offline waits');
});

test('Goals and the Diary add nothing for people not in coaching', () => {
  const goalsPage = read('../src/routes/Goals.svelte');
  assert.match(goalsPage, /\$: if \(\$coachTab\) loadCoachRecommendations\(\{ refresh: true \}\)/);
  assert.match(goalsPage, /\$: _coachRec = \$coachTab \? goalsCardRecommendation\(\$coachRecommendations\) : null;/);
  assert.match(read('../src/routes/Diary.svelte'), /\{#if \$coachTab\}<DiaryCoachCard \/><DiaryPlanCard \/>\{\/if\}/);
  assert.match(store, /if \(!get\(coachingSupported\) \|\| !showsCoachTab\(true, s\)\) \{ coachRecommendations\.set\(\[\]\); return \[\]; \}/);
});

test('no request or timer for people not in coaching', () => {
  // The state comes with /me, the fingerprint with the settings refresh the
  // app already makes; the store asks again only when the fingerprint moved.
  assert.match(store, /if \(sig === coachingSignature\(get\(coachingState\)\)\) return;/);
  for (const f of ['../src/stores/coaching.js', '../src/routes/Coach.svelte', '../src/routes/Clients.svelte',
    '../src/components/coaching/CoachingTabs.svelte', '../src/components/coaching/ClientDetail.svelte']) {
    assert.doesNotMatch(read(f), /setInterval\(/, f);
  }
  // Goals only adds the tab strip, which renders nothing outside coaching.
  assert.match(read('../src/components/coaching/CoachingTabs.svelte'), /\{#if \$inCoaching \|\| force\}/);
  assert.match(read('../src/stores/settings.js'), /noteCoachingSignature\(res\.headers\.get\('X-NT-Coaching'\)\)/);
  assert.match(read('../server/index.js'), /Access-Control-Expose-Headers', 'X-Request-ID, X-NT-Coaching'/);
});

test('coaching strings live in en.json; Users search finds coaching', () => {
  const en = JSON.parse(read('../src/i18n/en.json'));
  const get = (k) => k.split('.').reduce((o, p) => o?.[p], en);
  const files = ['../src/routes/Coach.svelte', '../src/routes/Clients.svelte', '../src/components/coaching/CoachingTabs.svelte',
    '../src/components/coaching/ClientDetail.svelte', '../src/components/coaching/RequestSheet.svelte',
    '../src/components/coaching/CoachingNeedsServer.svelte', '../src/components/coaching/WeightTrend.svelte',
    '../src/lib/coaching-view.js', '../src/components/settings/SettingsUserManagement.svelte',
    '../src/components/coaching/PlanCard.svelte', '../src/components/coaching/PlanBuilder.svelte',
    '../src/components/coaching/PlanItemPicker.svelte', '../src/components/coaching/DiaryPlanCard.svelte',
    '../src/components/coaching/MealRecCard.svelte', '../src/components/coaching/SendToClientSheet.svelte',
    '../src/components/ui/ShareSheet.svelte'];
  for (const f of files) {
    for (const [, key] of read(f).matchAll(/\$?_\(\s*'([a-z_]+(?:\.[a-z0-9_]+)+)'/g)) assert.equal(typeof get(key), 'string', `${f}: ${key}`);
  }
  for (const st of ['pending', 'accepted', 'declined', 'expired', 'replaced', 'withdrawn']) assert.equal(typeof get(`coaching.plans.status_${st}`), 'string', st);
  for (const k of ['foods', 'meals', 'recipes']) assert.equal(typeof get(`coaching.plans.kind_${k}`), 'string', k);
  for (const k of ['draft_targets', 'draft_plan', 'draft_sub', 'open_targets', 'open_plan', 'discard', 'drafted', 'dismiss_draft']) assert.equal(typeof get(`coaching.trace.${k}`), 'string', k);
  for (const st of ['pending', 'accepted', 'declined', 'withdrawn', 'replaced']) {
    assert.equal(typeof get(`coaching.send.status_${st}`), 'string', st);
    if (st !== 'pending') assert.equal(typeof get(`coaching.send.client_status_${st}`), 'string', st);
  }
  assert.equal(get('coaching.client.request_body'), '{name} will see your diary, your targets, your weight and your foods, meals and recipes.');
  const kw = read('../src/routes/Settings.svelte').match(/users: +\[([^\]]+)\]/)[1];
  for (const w of ['coach', 'coaching', 'client', 'pairing']) assert.match(kw, new RegExp(`'${w}'`));
});
