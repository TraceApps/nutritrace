import { writable, derived } from 'svelte/store';
import { NtApi } from '../lib/api.js';
import { currentDate } from './diary.js';
import { manualActivityPolicy } from './settings.js';

// List of activity_log rows for the current diary date.
export const dayActivity = writable([]);

// Summary returned by /api/activity/sum/:date — { manual, wearable, effective, policy }.
export const activitySummary = writable({ manual: 0, wearable: 0, effective: 0, policy: 'wearable_wins' });

// Derived: today's manual sum (kcal). Convenient for the Diary header.
export const manualKcal = derived(dayActivity, $rows =>
  ($rows || []).reduce((s, r) => s + (Number(r.kcal) || 0), 0)
);

let _loadVer = 0;

export async function loadActivity(dateStr) {
  const myVer = ++_loadVer;
  let policy = 'wearable_wins';
  manualActivityPolicy.subscribe(v => policy = v || 'wearable_wins')();
  try {
    const [rows, summary] = await Promise.all([
      NtApi.getActivity(dateStr),
      NtApi.getActivitySum(dateStr, policy),
    ]);
    if (myVer !== _loadVer) return;
    dayActivity.set(Array.isArray(rows) ? rows : []);
    activitySummary.set(summary || { manual: 0, wearable: 0, effective: 0, policy });
  } catch (e) {
    if (myVer !== _loadVer) return;
    dayActivity.set([]);
    activitySummary.set({ manual: 0, wearable: 0, effective: 0, policy });
  }
}

export async function addActivity({ date, name, kcal, duration_min, distance, source }) {
  const targetDate = date || _currentDate();
  await NtApi.createActivity({
    date: targetDate,
    name: String(name || '').trim(),
    kcal: Math.max(0, Math.round(Number(kcal) || 0)),
    duration_min: duration_min != null ? Math.max(0, Math.round(Number(duration_min))) : null,
    distance: distance != null ? String(distance).trim() || null : null,
    source: source || 'manual_form',
  });
  if (targetDate === _currentDate()) await loadActivity(targetDate);
}

export async function updateActivity(id, changes) {
  await NtApi.updateActivity(id, changes);
  await loadActivity(_currentDate());
}

export async function deleteActivity(id) {
  await NtApi.deleteActivity(id);
  await loadActivity(_currentDate());
}

function _currentDate() {
  let d = null;
  currentDate.subscribe(v => d = v)();
  return d;
}
