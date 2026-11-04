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
import { pullKinds, syncTouched, onSynced, SYNC_KINDS } from '../src/lib/sync-refresh.js';

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
  assert.match(goals, /onSynced\(\['diary'\], \(\) => \{ loadDiaryData\(\); \}\)/);
  assert.match(goals, /await loadDiaryData\(\);/);
});
