/**
 * An open page and a sync that changes its rows (lib/sync-refresh.js).
 *
 * The Foods page, Diary, Statistics and Goals read the phone's database when
 * they open. A sync that took a food, recipe, activity, fast or diary day away
 * (or edited or added one) changed it under the page, which kept showing the
 * old rows until the app was reopened: sync.js ended every sync with
 * 'nt:sync-complete' saying only THAT something changed, and Foods did not
 * listen at all. The event now says which kinds of rows it touched, and each
 * page that shows them reloads.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { pullKinds, syncTouched, onSynced, SYNC_KINDS, touchedFields, takeUntouched, onComeBack } from '../src/lib/sync-refresh.js';

const src = f => readFileSync(new URL('../src/' + f, import.meta.url), 'utf8');

test('a pull announces every kind it brought, deleted rows included', () => {
  // Deleted rows come in the same lists as the rest (deleted_at set).
  assert.deepEqual(pullKinds({ foods: [{ id: 1, deleted_at: '2026-11-03 10:00:00' }] }), ['foods']);
  assert.deepEqual(pullKinds({ meals: [{ id: 1, is_recipe: 1, deleted_at: 'x' }] }), ['meals']);
  assert.deepEqual(pullKinds({ activity: [{ id: 1, deleted_at: 'x' }] }), ['activity']);
  assert.deepEqual(pullKinds({ fasts: [{ id: 1, deleted_at: 'x' }] }), ['fasts']);
  assert.deepEqual(pullKinds({ diary: [{ id: 1, date: '2026-11-03', deleted_at: 'x' }] }), ['diary']);
  // An item removed from a day travels as a tombstone.
  assert.deepEqual(pullKinds({ diary_tombstones: [{ date: '2026-11-03', kind: 'item', uuid: 'u' }] }), ['diary']);
  // Values and workouts the server removed outright.
  assert.deepEqual(pullKinds({ deletions: { workouts: [3], wellness: [] } }), ['workouts']);
  assert.deepEqual(pullKinds({ deletions: { workouts: [], wellness: [{ date: 'd', source: 's', metric_type: 'm' }] } }), ['wellness']);
  assert.deepEqual(pullKinds({ wellness: [{}], workouts: [{}], settings: [{}], chat_history: [{}] }), ['wellness', 'workouts', 'settings', 'chat']);
  assert.deepEqual(pullKinds({ foods: [{}], meals: [{}], diary: [{}], activity: [{}], fasts: [{}] }, 2), ['foods', 'meals', 'diary', 'activity', 'fasts', 'coaching']);
  for (const k of pullKinds({ foods: [{}], meals: [{}], diary: [{}], activity: [{}], fasts: [{}], wellness: [{}], workouts: [{}], settings: [{}], chat_history: [{}] }, 1)) assert.ok(SYNC_KINDS.includes(k), k);
});

test('a quiet pull announces nothing; an older server or a missing answer does not throw', () => {
  assert.deepEqual(pullKinds({ foods: [], meals: [], diary: [], diary_tombstones: [], activity: [], fasts: [], settings: [], wellness: [], workouts: [], chat_history: [], deletions: { workouts: [], wellness: [] } }), []);
  assert.deepEqual(pullKinds({}), []);
  assert.deepEqual(pullKinds(null), []);
  assert.deepEqual(pullKinds({ foods: null, deletions: null }), []);
});

test('a page hears of a sync that touched what it shows, and only that', () => {
  assert.equal(syncTouched({ changed: true, kinds: ['foods'] }, ['foods', 'meals']), true);
  assert.equal(syncTouched({ changed: true, kinds: ['meals'] }, ['foods', 'meals']), true);
  assert.equal(syncTouched({ changed: true, kinds: ['diary'] }, ['foods', 'meals']), false);
  assert.equal(syncTouched({ changed: true, kinds: [] }, ['foods', 'meals']), false, 'a push that changed nothing here');
  assert.equal(syncTouched({ changed: false, kinds: [] }, ['foods']), false);
  assert.equal(syncTouched({ changed: false }, ['foods']), false);
  // An event that does not say what it touched counts as touching everything.
  assert.equal(syncTouched({ changed: true }, ['foods']), true);
  assert.equal(syncTouched(undefined, ['foods']), true);
});

test('onSynced calls the page when a sync touched its kinds, until the page stops listening', () => {
  const et = new EventTarget();
  const had = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { value: et, configurable: true, writable: true });
  try {
    const sync = detail => et.dispatchEvent(new CustomEvent('nt:sync-complete', { detail }));
    const calls = [];
    const off = onSynced(['foods', 'meals'], d => calls.push(d));
    sync({ changed: true, kinds: ['foods'] });
    sync({ changed: true, kinds: ['diary'] });
    sync({ changed: false, kinds: [] });
    sync({ changed: true, kinds: ['activity', 'meals'] });
    assert.deepEqual(calls, [{ changed: true, kinds: ['foods'] }, { changed: true, kinds: ['activity', 'meals'] }]);
    off();
    sync({ changed: true, kinds: ['foods'] });
    assert.equal(calls.length, 2, 'a page that has gone is not called');
  } finally {
    if (had) Object.defineProperty(globalThis, 'window', had); else delete globalThis.window;
  }
  // No window (a server render, a test): nothing to listen to, and nothing to throw.
  assert.equal(typeof onSynced(['foods'], () => {}), 'function');
});

test('sync.js says what a sync touched; a push that brought nothing back says none', () => {
  const sync = src('lib/sync.js');
  assert.match(sync, /import \{ pullKinds \} from '\.\/sync-refresh\.js'/);
  // The pull records its kinds before it writes anything, so one that fails
  // partway still has its rows announced...
  assert.match(sync, /for \(const k of pullKinds\(data\)\) _touched\.add\(k\)/);
  assert.match(sync, /if \(coachChanged\) _touched\.add\('coaching'\)/);
  assert.match(sync, /if \(_touched\.size\) _announce\(true\);\n    \/\/ Notify on sync failure/, 'and a failed sync announces them');
  // ...and kinds left over make the next announcement a change.
  assert.match(sync, /changed: !!changed \|\| kinds\.length > 0, kinds/);
  // ...a row that beat a pushed edit comes back and is recorded too...
  assert.match(sync, /await dbApplyServerWinner\(table, r\.row\); _touched\.add\(name\)/);
  // ...and the end of a full sync sends them with the event.
  assert.match(sync, /_announce\(hadChanges\);/);
  assert.equal((sync.match(/'nt:sync-complete'/g) || []).length, 1, 'one place sends the event');
  // A scheduled push announces a winner only when no full sync will.
  assert.match(sync, /if \(!_syncing && _touched\.size\) _announce\(true\)/);
});

test('every page that lists rows a sync can change reloads them when it does', () => {
  // Foods: foods, meals and recipes (one read), yesterday's meals from the diary.
  const foods = src('routes/Foods.svelte');
  assert.match(foods, /onSynced\(\['foods', 'meals'\], \(\) => \{ load\(\{ quiet: true \}\); \}\)/);
  assert.match(foods, /onSynced\(\['diary'\], \(\) => \{ loadYesterdayMeals\(\)\.catch\(\(\) => \{\}\); \}\)/);
  assert.match(foods, /return \(\) => \{ offCatalog\(\); offDiary\(\); \};/, 'the listeners go with the page');
  // The newest read wins, and a quiet read that fails keeps the lists.
  assert.match(foods, /if \(seq !== _loadSeq\) return;/);
  assert.match(foods, /if \(seq === _loadSeq && \(!quiet \|\| !_loadedOnce\)\) loadError = true;/);
  assert.match(foods, /if \(seq === _loadSeq\) _initialLoading = false;/);
  // Diary: the day's activity and fast, and the week strip.
  const diary = src('routes/Diary.svelte');
  // Listened to from a plain onMount: the page's async one drops what it returns.
  assert.match(diary, /\n  onMount\(\(\) => \{\n    if \(!\(isNative && getServerUrl\(\)\)\) return;\n    const onSyncComplete/);
  assert.match(diary, /return \(\) => window\.removeEventListener\('nt:sync-complete', onSyncComplete\);/);
  assert.match(diary, /\$diaryShowActivity && syncTouched\(d, \['activity', 'wellness'\]\)\) loadActivity\(cur\)/);
  assert.match(diary, /\$fastingEnabled && syncTouched\(d, \['fasts'\]\)\) loadFasting\(\)/);
  assert.match(diary, /syncTouched\(d, \['diary', 'activity'\]\)\) _weekStripRefreshKey \+= 1/);
  // Statistics, its fasting card, Goals.
  assert.match(src('routes/Statistics.svelte'), /onSynced\(\['diary', 'wellness'\], \(\) => \{ if \(canvasEl\) loadData\(\); \}\)/);
  assert.match(src('components/diary/FastingInsights.svelte'), /onSynced\(\['fasts'\], \(\) => \{ loadFasting\(\); \}\)/);
  const goals = src('routes/Goals.svelte');
  assert.match(goals, /onSynced\(\['diary', 'wellness'\], \(d\) => \{\n    if \(syncTouched\(d, \['diary'\]\)\) loadDiaryData\(\);/);
  assert.match(goals, /await loadDiaryData\(\);/);
});

// The calorie goal worked out from diary days and wellness values (adaptive:
// recent intake and weights; dynamic: yesterday's burn) was read once, so a
// scale's weight or a day's food that a sync brought left it as it was.
test('the adaptive and dynamic calorie goals are read again after a sync that changed what they come from', () => {
  const diary = src('routes/Diary.svelte');
  assert.match(diary, /\$calorieGoalMode === 'adaptive' && syncTouched\(d, \['diary', 'wellness'\]\)\) _loadAdaptiveTdee\(\{ quiet: true \}\)/);
  assert.match(diary, /\$calorieGoalMode === 'dynamic' && cur && syncTouched\(d, \['wellness'\]\)\) \{ _dynamicGoalDate = null; _loadDynamicGoal\(cur, \{ quiet: true \}\); \}/);
  assert.match(diary, /catch \{ if \(!quiet\) _adaptiveTdee = null; \}/, 'a failed read after a sync keeps the goal shown');
  const goals = src('routes/Goals.svelte');
  assert.match(goals, /loadAdaptive\(\{ quiet: true \}\);\n    if \(syncTouched\(d, \['wellness'\]\)\) loadDynamicGoal\(\{ quiet: true \}\);/);
  assert.match(goals, /\.catch\(\(\) => \{ if \(!quiet\) _adaptive = null; _adaptiveLoaded = true; \}\)/);
});

test('an open editor takes a newer copy into the fields not changed in it', () => {
  const opened = { name: 'Oats', kcal: '380', items: [{ id: 1, q: 1 }], notes: '' };
  // Changed here: the name. Changed elsewhere: the calories, the items, a new field.
  const now = { ...opened, name: 'My Oats' };
  const fresh = { name: 'Rolled Oats', kcal: '390', items: [{ id: 1, q: 2 }], notes: '', brand: 'Mill' };
  assert.deepEqual(touchedFields(now, opened), ['name']);
  const took = takeUntouched(now, opened, fresh);
  assert.deepEqual(took.form, { name: 'My Oats', kcal: '390', items: [{ id: 1, q: 2 }], notes: '', brand: 'Mill' });
  assert.deepEqual(took.touched, ['name']);
  // What it counts as opened now: the fields taken in as they came, the
  // kept one as it opened, so it still counts as changed here.
  assert.deepEqual(took.opened, { name: 'Oats', kcal: '390', items: [{ id: 1, q: 2 }], notes: '', brand: 'Mill' });
  assert.deepEqual(touchedFields(took.form, took.opened), ['name']);
  // A copy: changing the form in place doesn't change what it opened with.
  took.form.items[0].q = 5;
  assert.equal(took.opened.items[0].q, 2);
  // A field changed back to what it opened with counts as not changed.
  assert.deepEqual(takeUntouched({ ...opened }, opened, fresh).form, fresh);
  // A field taken away elsewhere goes, unless it was changed here.
  assert.equal('notes' in takeUntouched(opened, opened, { name: 'Oats' }).form, true);
  assert.equal(takeUntouched(opened, opened, { name: 'Oats' }).form.notes, undefined);
  assert.equal(takeUntouched({ ...opened, notes: 'mine' }, opened, { name: 'Oats' }).form.notes, 'mine');
});

test('onComeBack reads again when the app is back in front, once, and only after it was away', () => {
  const win = new EventTarget(), doc = new EventTarget();
  doc.visibilityState = 'visible';
  const hadW = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const hadD = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'window', { value: win, configurable: true, writable: true });
  Object.defineProperty(globalThis, 'document', { value: doc, configurable: true, writable: true });
  try {
    let n = 0;
    const off = onComeBack(() => { n++; });
    win.dispatchEvent(new Event('focus'));
    assert.equal(n, 0, 'focused without having been away');
    // To the background and back: hidden, shown, then focused.
    doc.visibilityState = 'hidden'; doc.dispatchEvent(new Event('visibilitychange'));
    doc.visibilityState = 'visible'; doc.dispatchEvent(new Event('visibilitychange'));
    win.dispatchEvent(new Event('focus'));
    assert.equal(n, 1, 'once for one return');
    // Another window in front, and back.
    win.dispatchEvent(new Event('blur'));
    win.dispatchEvent(new Event('focus'));
    assert.equal(n, 2);
    off();
    win.dispatchEvent(new Event('blur'));
    win.dispatchEvent(new Event('focus'));
    assert.equal(n, 2, 'a page that has gone is not called');
  } finally {
    if (hadW) Object.defineProperty(globalThis, 'window', hadW); else delete globalThis.window;
    if (hadD) Object.defineProperty(globalThis, 'document', hadD); else delete globalThis.document;
  }
  assert.equal(typeof onComeBack(() => {}), 'function');
});

// An editor open when a sync changed its row kept the copy it opened with,
// and saving put that copy back over the change; one deleted elsewhere
// saved into the deleted row (or, in the diary, into whichever item had
// moved into its place).
test('open editors take in what a sync changed, and a row deleted elsewhere turns Save off', () => {
  const food = src('routes/FoodEditor.svelte');
  assert.match(food, /onSynced\(\['foods'\], \(\) => \{ _takeSynced\(\); \}\)/);
  assert.match(food, /const took = takeUntouched\(food, _opened, fresh\);/);
  assert.match(food, /if \(!row \|\| row\.deleted_at\) \{ _gone = true; return; \}/);
  assert.match(food, /async function save\(\) \{\r?\n    if \(_gone\) return;/);
  assert.match(food, /on:click=\{save\} disabled=\{saving \|\| _gone\}/);
  const meal = src('routes/MealEditor.svelte');
  assert.match(meal, /onSynced\(\['meals'\], \(\) => \{ _takeSynced\(\); \}\)/);
  assert.match(meal, /const took = takeUntouched\(_formNow\(\), _opened, fresh\);/);
  assert.match(meal, /if \(!row \|\| row\.deleted_at\) \{ _gone = true; return; \}/);
  assert.match(meal, /async function save\(\) \{\r?\n    if \(_gone\) return;/);
  assert.match(meal, /on:click=\{save\} disabled=\{saving \|\| _gone\}/);
  // The diary's edit sheet keeps to its item by uuid, never by its place.
  const diary = src('routes/Diary.svelte');
  assert.match(diary, /if \(cur\) loadEntry\(cur\)\.then\(_takeSyncedEditItem\)/);
  assert.match(diary, /const i = items\.findIndex\(it => it\?\.uuid === _editKey\.uuid\);\n      if \(i >= 0\) fresh = \{ \.\.\.items\[i\], _i: i \};/);
  assert.match(diary, /if \(!fresh\) \{ _editGone = true; return; \}/);
  assert.match(diary, /if \(!editItem \|\| _editGone\) return;/);
  assert.equal((diary.match(/on:click=\{saveEditItem\} disabled=\{_editGone\}/g) || []).length, 2);
  const act = src('components/diary/AddActivitySheet.svelte');
  assert.match(act, /onSynced\(\['activity'\], \(\) => \{ _takeSynced\(\); \}\)/);
  assert.match(act, /if \(!row\) \{ gone = true; return; \}/);
  assert.match(act, /disabled=\{saving \|\| gone\}/);
  const fast = src('components/diary/FastingWidget.svelte');
  assert.match(fast, /\$: if \(_editingStart\) _followActive\(_active\);/);
  assert.match(fast, /if \(!_active \|\| _active\.id !== _editFastId/, 'never saved into another fast');
  const goals = src('routes/Goals.svelte');
  assert.match(goals, /onSynced\(\['settings'\], \(\) => \{/);
  assert.match(goals, /if \(_goalHad && !g\) _goalGone = true;/);
  assert.match(goals, /if \(!editStat \|\| _goalGone\) return;/);
  // Every string a notice says is in English.
  const en = JSON.parse(src('i18n/en.json'));
  for (const v of [en.food_editor.gone, en.meal_editor.gone, en.meal_editor.gone_recipe, en.diary.edit_item.gone, en.diary.activity.gone, en.goals.gone, en.fasting.gone]) assert.ok(typeof v === 'string' && v.length > 10);
});

test('views read from the server only are read again on coming back, quietly', () => {
  assert.match(src('routes/Clients.svelte'), /onComeBack\(\(\) => \{ if \(loaded && !needsServer\) \{ loadList\(\{ quiet: true \}\); refreshCoaching\(\); \} \}\)/);
  assert.match(src('routes/Coach.svelte'), /onComeBack\(\(\) => \{\n    if \(!loaded \|\| needsServer\) return;\n    refreshCoaching\(\);/);
  const detail = src('components/coaching/ClientDetail.svelte');
  assert.match(detail, /onComeBack\(\(\) => \{\n    if \(!clientId\) return;\n    loadOverview\(\{ quiet: true \}\);/);
  assert.match(detail, /if \(!quiet\) \{ overview = null; overviewErr = ''; \}/, 'what is shown stays while it is read');
  const users = src('components/settings/SettingsUserManagement.svelte');
  assert.match(users, /onComeBack\(\(\) => \{\n    if \(!\$userMgmtActive \|\| umLoading/);
  // No timers: only coming back reads again.
  for (const f of ['routes/Clients.svelte', 'routes/Coach.svelte', 'components/coaching/ClientDetail.svelte']) assert.doesNotMatch(src(f), /setInterval/);
});
