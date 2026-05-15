/**
 * fasting.js — Intermittent-fasting state for the Diary widget + Stats card.
 *
 * State surface:
 *   activeFast    Svelte store — { id, start_at, end_at: null, goal_hours }
 *                  or null when no fast is in progress.
 *   fastHistory   Svelte store — array of completed fasts, newest first.
 *   elapsedMs     Svelte store — live-updating tick (ms) while a fast is
 *                  active. Driven by a setInterval that starts/stops based
 *                  on whether activeFast is null.
 *
 * The server is the source of truth. We just cache it client-side so the
 * widget renders without a round-trip on every Diary navigation, and so the
 * timer can keep ticking from the server-issued start_at across app sessions.
 */

import { writable, get } from 'svelte/store';
import { NtApi } from '../lib/api.js';
import { showSuccess, showError } from './toast.js';

export const activeFast = writable(null);
export const fastHistory = writable([]);
export const elapsedMs = writable(0);

let _tickInterval = null;
function _startTicking() {
  if (_tickInterval) return;
  _tickInterval = setInterval(() => {
    const f = get(activeFast);
    if (!f) { _stopTicking(); return; }
    elapsedMs.set(Date.now() - new Date(f.start_at).getTime());
  }, 1000);
  // Set immediately so the widget doesn't blank for a second on mount
  const f = get(activeFast);
  if (f) elapsedMs.set(Date.now() - new Date(f.start_at).getTime());
}
function _stopTicking() {
  if (!_tickInterval) return;
  clearInterval(_tickInterval);
  _tickInterval = null;
  elapsedMs.set(0);
}

/** Load active fast + recent history. Called on Diary mount + after each
 *  start/end so the widget reflects current state without a manual refresh. */
export async function loadFasting() {
  try {
    const [active, history] = await Promise.all([
      NtApi.get('/api/fasts/active').catch(() => null),
      NtApi.get('/api/fasts?limit=60').catch(() => []),
    ]);
    activeFast.set(active && active.id ? active : null);
    fastHistory.set(Array.isArray(history) ? history : []);
    if (get(activeFast)) _startTicking();
    else _stopTicking();
  } catch { /* swallow — leave stores at their previous value */ }
}

/** Start a new fast. goal_hours optional; falls back to server default. */
export async function startFast(goal_hours) {
  try {
    const r = await NtApi.post('/api/fasts/start', { goal_hours });
    activeFast.set(r);
    _startTicking();
    showSuccess(`Fasting started · goal ${goal_hours || 16}h`);
    return r;
  } catch (e) {
    showError(e?.message || 'Could not start fast');
    return null;
  }
}

/** End the currently-active fast. */
export async function endFast() {
  const f = get(activeFast);
  if (!f) return null;
  try {
    const r = await NtApi.post(`/api/fasts/${f.id}/end`, {});
    activeFast.set(null);
    _stopTicking();
    // Prepend the now-completed fast to history
    fastHistory.update(list => [r, ...list]);
    const hours = ((new Date(r.end_at).getTime() - new Date(r.start_at).getTime()) / 3600000).toFixed(1);
    showSuccess(`Fast ended · ${hours}h logged`);
    return r;
  } catch (e) {
    showError(e?.message || 'Could not end fast');
    return null;
  }
}

/** Soft-delete a fast from history. */
export async function deleteFast(id) {
  try {
    await NtApi.del(`/api/fasts/${id}`);
    fastHistory.update(list => list.filter(f => f.id !== id));
    showSuccess('Fast removed');
  } catch (e) {
    showError(e?.message || 'Could not remove fast');
  }
}

/**
 * Check the recurring schedule and auto-start a fast if it's due.
 * Called on Diary mount + visibility-change. Server scheduler also checks
 * this independently — the active-fast 409 deconflicts.
 *
 * Schedule fires once per scheduled day:
 *   - schedule enabled
 *   - today's weekday is in scheduleDays
 *   - now is past scheduleTime (HH:MM in user's local TZ)
 *   - schedule hasn't already fired today (per fastingScheduleLastFired)
 *   - no fast is currently active
 */
export async function checkScheduleAndStart() {
  try {
    const { get } = await import('svelte/store');
    const settings = await import('./settings.js');
    if (!get(settings.fastingEnabled) || !get(settings.fastingScheduleEnabled)) return;
    const today = new Date();
    const todayStr = today.toISOString().slice(0, 10);
    if (get(settings.fastingScheduleLastFired) === todayStr) return;
    const days = get(settings.fastingScheduleDays) || [];
    if (!days.includes(today.getDay())) return;
    const time = String(get(settings.fastingScheduleTime) || '20:00');
    const [hh, mm] = time.split(':').map(n => parseInt(n) || 0);
    const scheduledAt = new Date(today);
    scheduledAt.setHours(hh, mm, 0, 0);
    if (today.getTime() < scheduledAt.getTime()) return; // not yet time
    // Don't auto-start a fast for a scheduled time many hours in the past
    // (e.g. user opens the app at 11pm with a 6am schedule — too late to
    // backdate, just skip today). Cap at 4 hours late.
    if (today.getTime() - scheduledAt.getTime() > 4 * 3600 * 1000) {
      settings.fastingScheduleLastFired.set(todayStr); // remember we passed
      return;
    }
    const active = get(activeFast);
    if (active) return; // already fasting
    const goal = Number(get(settings.fastingScheduleGoal)) || 16;
    const result = await startFast(goal);
    if (result) {
      settings.fastingScheduleLastFired.set(todayStr);
    }
  } catch {}
}

/** Stats helpers for the Stats card. Pure functions over the history array. */
export function fastingStats(history, currentActive = null) {
  // Combine completed + active (treat active as in-progress)
  const completed = history.filter(f => f.end_at);
  if (!completed.length && !currentActive) {
    return { count: 0, avg_hours: 0, longest_hours: 0, current_streak: 0, longest_streak: 0 };
  }

  const durations = completed.map(f =>
    (new Date(f.end_at).getTime() - new Date(f.start_at).getTime()) / 3600000
  );
  const avg = durations.length ? durations.reduce((a, b) => a + b, 0) / durations.length : 0;
  const longest = durations.length ? Math.max(...durations) : 0;

  // Streaks: consecutive days (going back from today) where a fast ended that
  // met its goal. Active fast counts toward today if it has already met goal.
  const goalsByDay = new Map(); // YYYY-MM-DD -> hit_goal: boolean
  for (const f of completed) {
    const day = f.end_at.slice(0, 10);
    const hours = (new Date(f.end_at).getTime() - new Date(f.start_at).getTime()) / 3600000;
    const hit = hours >= (f.goal_hours || 16);
    // If multiple fasts on same day, OR the hits (any hit counts)
    goalsByDay.set(day, (goalsByDay.get(day) || false) || hit);
  }
  if (currentActive) {
    const today = new Date().toISOString().slice(0, 10);
    const hours = (Date.now() - new Date(currentActive.start_at).getTime()) / 3600000;
    if (hours >= (currentActive.goal_hours || 16)) goalsByDay.set(today, true);
  }

  // Current streak — walk back from today
  let current_streak = 0;
  const d = new Date();
  for (;;) {
    const key = d.toISOString().slice(0, 10);
    if (goalsByDay.get(key)) {
      current_streak++;
      d.setUTCDate(d.getUTCDate() - 1);
    } else {
      break;
    }
  }

  // Longest streak — single pass over sorted days
  const days = [...goalsByDay.keys()].sort();
  let longest_streak = 0;
  let run = 0;
  let prev = null;
  for (const day of days) {
    if (!goalsByDay.get(day)) { run = 0; prev = day; continue; }
    if (prev) {
      const gap = (new Date(day) - new Date(prev)) / 86400000;
      run = gap === 1 ? run + 1 : 1;
    } else {
      run = 1;
    }
    if (run > longest_streak) longest_streak = run;
    prev = day;
  }

  return {
    count: completed.length,
    avg_hours: +avg.toFixed(1),
    longest_hours: +longest.toFixed(1),
    current_streak,
    longest_streak,
  };
}
