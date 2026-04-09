import { writable, derived } from 'svelte/store';
import { NtApi } from '../lib/api.js';
import { Nutrition } from '../lib/nutrition.js';
import { localDateStr } from '../lib/db.js';
import { resolveAssetUrl } from '../lib/platform.js';

function todayStr() {
  return localDateStr();
}

export const currentDate  = writable(todayStr());
export const currentEntry = writable(null);
export const diaryLoadError = writable(false);
export const diaryLoadErrorMsg = writable('');
// UI state — controlled from App.svelte topbar buttons, consumed in Diary.svelte
export const diaryShowNutritionSummary = writable(false);
export const diaryShowBodyStats        = writable(false);

export const diaryTotals = derived(currentEntry, $entry => {
  if (!$entry || !$entry.items) return {};
  return Nutrition.sum($entry.items.map(i => Nutrition.calculate(i)));
});

export const macroPercents = derived(diaryTotals, $t => {
  return Nutrition.macroPercents($t);
});

// Map API snake_case → app camelCase, resolve image URLs for native server mode
function _fromApi(entry) {
  if (!entry) return null;
  const items = (entry.items || []).map(i => i.imgUrl ? { ...i, imgUrl: resolveAssetUrl(i.imgUrl) } : i);
  return { ...entry, items, bodyStats: entry.body_stats || {}, body_stats: undefined };
}

// Map app camelCase → API snake_case
// Strip Capacitor file paths from imgUrl before sending to server
function _stripCachedPaths(items) {
  if (!items || !Array.isArray(items)) return items;
  return items.map(i => {
    if (!i.imgUrl) return i;
    // Capacitor cached path → strip back to original /uploads/ path
    if (i.imgUrl.includes('_capacitor_file_') || i.imgUrl.includes('/image_cache/')) {
      const filename = i.imgUrl.split('/').pop();
      // Only restore if filename looks like an uploaded image (has extension)
      if (filename && /\.\w{2,5}$/.test(filename)) {
        return { ...i, imgUrl: '/uploads/' + filename };
      }
      // Can't determine original URL — remove the broken cached path
      return { ...i, imgUrl: '' };
    }
    // Strip proxy URLs back to original (they get resolved at display time)
    if (i.imgUrl.includes('/api/proxy?url=')) {
      try {
        const proxyUrl = new URL(i.imgUrl);
        const original = proxyUrl.searchParams.get('url');
        if (original) return { ...i, imgUrl: original };
      } catch {}
    }
    return i;
  });
}

function _toApi(entry) {
  return {
    items:      _stripCachedPaths(entry.items || []),
    body_stats: entry.bodyStats  || entry.body_stats || {},
    water:      entry.water      || [],
  };
}

export async function loadEntry(dateStr) {
  currentDate.set(dateStr);
  let entry = null;
  let failed = false;
  try {
    const raw = await NtApi.getDiaryDate(dateStr);
    entry = _fromApi(raw);
  } catch(e) {
    console.error('[diary] loadEntry error:', e);
    diaryLoadErrorMsg.set(e?.message || String(e));
    failed = true;
  }
  let curDate = null;
  currentDate.subscribe(v => curDate = v)();
  if (curDate === dateStr) {
    diaryLoadError.set(failed);
    currentEntry.set(entry || { date: dateStr, items: [], bodyStats: {}, water: [] });
  }
  return entry || null;
}

async function _save(entry) {
  const saved = await NtApi.saveDiaryDate(entry.date, _toApi(entry));
  const result = _fromApi(saved);

  // Check goals after every save (only for today)
  const today = new Date().toLocaleDateString('sv-SE');
  if (entry.date === today && result.items?.length) {
    try {
      const { Nutrition } = await import('../lib/nutrition.js');
      const { checkGoals } = await import('../lib/notifications.js');
      const { DB } = await import('../lib/db.js');
      const goals = DB.getSetting('goals', {});
      const totals = Nutrition.sum(result.items.map(i => Nutrition.calculate(i)));
      const waterMl = (result.water || []).reduce((s, l) => s + (l.amount || 0), 0);
      // Add water goal from waterGoalMl setting (it's separate from the goals object)
      const waterGoal = DB.getSetting('waterGoalMl', 0);
      if (waterGoal > 0) goals.water_ml = { min: waterGoal };
      await checkGoals(goals, { ...totals, water_ml: waterMl });
    } catch (e) {
      console.debug('[diary] goal check failed:', e.message);
    }
  }

  return result;
}

export async function addDiaryItem(foodItem, meal, date) {
  let viewDate = null;
  currentDate.subscribe(v => viewDate = v)();
  const targetDate = date || viewDate || todayStr();

  let entry = null;
  if (targetDate === viewDate) {
    currentEntry.subscribe(v => entry = v)();
  }
  if (!entry || entry.date !== targetDate) {
    entry = _fromApi(await NtApi.getDiaryDate(targetDate));
  }
  if (!entry) entry = { date: targetDate, items: [], bodyStats: {}, water: [] };

  const item = { ...foodItem, meal: meal != null ? Number(meal) : 0, addedAt: new Date().toISOString() };
  const updated = { ...entry, items: [...(entry.items || []), item] };
  const saved = await _save(updated);

  currentDate.subscribe(v => viewDate = v)();
  if (targetDate === viewDate) currentEntry.set(saved);
}

export async function removeDiaryItem(index) {
  let entry = null;
  currentEntry.subscribe(v => entry = v)();
  if (!entry) return;
  const updated = { ...entry, items: entry.items.filter((_, i) => i !== index) };
  currentEntry.set(await _save(updated));
}

export async function updateDiaryItem(index, changes) {
  let entry = null;
  currentEntry.subscribe(v => entry = v)();
  if (!entry) return;
  const updated = { ...entry, items: entry.items.map((item, i) => i === index ? { ...item, ...changes } : item) };
  currentEntry.set(await _save(updated));
}

export async function saveBodyStats(stats) {
  let entry = null;
  currentEntry.subscribe(v => entry = v)();
  if (!entry) return;
  const updated = { ...entry, bodyStats: { ...entry.bodyStats, ...stats } };
  currentEntry.set(await _save(updated));
}

export function prevDay() {
  let d = null;
  currentDate.subscribe(v => d = v)();
  const dt = new Date(d + 'T12:00:00');
  dt.setDate(dt.getDate() - 1);
  loadEntry(localDateStr(dt));
}

export function nextDay() {
  let d = null;
  currentDate.subscribe(v => d = v)();
  const dt = new Date(d + 'T12:00:00');
  dt.setDate(dt.getDate() + 1);
  loadEntry(localDateStr(dt));
}
