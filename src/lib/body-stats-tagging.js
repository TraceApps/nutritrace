/**
 * Days saved before weight and measurements carried their unit (1.0 release
 * candidates up to rc.17) get the units this app shows them in, once a
 * start, after the account's settings are in (server/lib/body-stats-tag.js).
 * Nothing on screen changes; from then on a unit change can't reinterpret
 * them, and the readers that took an untagged number as kg (adaptive TDEE,
 * coaching, the email digest, Add Activity) read it right.
 */
import { get } from 'svelte/store';
import { weightUnit, lengthUnit } from '../stores/settings.js';
import { NtApi } from './api.js';
import { DB } from './db.js';

const _done = new Set();

/** The units the Diary shows untagged values in (Diary.svelte). */
export function shownUnits() {
  return { weight: get(weightUnit) || 'kg', length: get(lengthUnit) || 'in' };
}

/**
 * The units untagged days were typed in: the person's own choice, else the
 * defaults of the time (lb, in). Not today's default, which may follow the
 * device's region or the server's (nutritrace#326) and would read a day
 * typed in pounds as kilograms.
 */
export function typedUnits() {
  return { weight: DB.getSetting('weightUnit', null) || 'lb', length: DB.getSetting('lengthUnit', null) || 'in' };
}

/**
 * `chosenOnly`: send only units saved on this device. With no accounts a
 * server keeps no settings, so each browser and phone has its own; one
 * that never chose shows the default (lb, in), which may not be what the
 * person's other device shows. Signed in, the account's settings are the
 * same everywhere, so the units shown are the account's.
 */
export async function tagBodyStatUnits({ chosenOnly = false } = {}) {
  let { weight, length } = typedUnits();
  if (chosenOnly) {
    if (DB.getSetting('weightUnit', null) == null) weight = undefined;
    if (DB.getSetting('lengthUnit', null) == null) length = undefined;
    if (!weight && !length) return;
  }
  let who = '';
  try { who = localStorage.getItem('wl:userId') || ''; } catch { /* none */ }
  const key = `${who}:${weight}:${length}`;
  // Once a start: an older server or no connection waits for the next one.
  if (_done.has(key)) return;
  _done.add(key);
  try { await NtApi.tagBodyStatUnits(weight, length); } catch { /* next start */ }
}
