/**
 * sleep-sessions.js: one night of sleep from Health Connect SleepSession
 * records (#236).
 *
 * Health Connect can hold several sessions for one night. Samsung Health
 * splits a night wherever you woke up (00:46-05:00 and 05:45-06:53 in the
 * report), and more than one app can write the same night. Both ingestion
 * paths used to keep only the last record the query returned and discard
 * the rest, and the foreground path never recognized a stage at all.
 *
 * This is the one definition of "last night" for Health Connect. The
 * foreground sync (health-connect.js) calls it on the plugin's records, and
 * the background worker runs a Kotlin port of it (SleepDerivation.kt). Both
 * are held to scripts/fixtures/sleep-sessions.json, so the two paths cannot
 * drift apart again without a test failing.
 *
 * The steps, in order:
 *
 *  1. Normalize. Drop sessions with no valid span. Stages are mapped to one
 *     vocabulary and clipped to their session.
 *  2. Resolve overlaps. Sessions that overlap are the same stretch of sleep
 *     recorded twice, usually by two apps. Keep one app: the one with stage
 *     data (a watch beats a bedtime schedule), then the one that covered
 *     more of the stretch, then the lower package name so the choice never
 *     depends on the order Health Connect returned them. All of the kept
 *     app's sessions there stay, the other app's go. Nothing is counted
 *     twice.
 *  3. Group into nights. Sessions separated by less than NIGHT_GAP_MS are
 *     one night. A night belongs to the day you woke up on, the local date
 *     of its last minute.
 *  4. Pick the night for the requested day. If that day has more than one
 *     (a night and an afternoon nap), the one with the most recorded sleep
 *     wins, which is the rule Google Health's path already applies to a
 *     single session.
 *  5. Measure. Duration is the union of the night's sessions: gaps between
 *     them are not sleep and overlaps are counted once. It stays a span,
 *     the same thing Health Connect and Samsung Health show, not stage-
 *     summed time asleep. Stage minutes come from the stage timeline with
 *     any overlap removed, and the Sleep Quality metrics come from the same
 *     walk Google Health uses (sleep-quality.js).
 *
 * Output uses the canonical Wellness metric ids, the ones the cards read.
 * When the night has stages, every stage and counter metric is written,
 * zeros included: a later sync can only overwrite what it writes, so a
 * value that went back to zero would otherwise stay stale forever.
 */
import { deriveSleepQuality } from './sleep-quality.js';

/** Sessions closer together than this are one night. */
export const NIGHT_GAP_MS = 3 * 60 * 60 * 1000;

const COUNTED = ['AWAKE', 'LIGHT', 'DEEP', 'REM'];

// AndroidX SleepSessionRecord.STAGE_TYPE_* values.
const BY_NUMBER = {
  0: 'UNKNOWN', 1: 'AWAKE', 2: 'SLEEPING', 3: 'OUT_OF_BED',
  4: 'LIGHT', 5: 'DEEP', 6: 'REM', 7: 'AWAKE',
};

/**
 * One stage vocabulary. The plugin sends "SLEEP_STAGE_DEEP"; AndroidX calls
 * it STAGE_TYPE_DEEP (5); other bridges use "deep". AWAKE_IN_BED counts as
 * awake, as the background worker always counted it. OUT_OF_BED, SLEEPING
 * (asleep, stage unknown) and UNKNOWN are kept but never counted toward a
 * stage, which is also what the worker did.
 */
export function normalizeStage(raw) {
  if (typeof raw === 'number') return BY_NUMBER[raw] || 'UNKNOWN';
  const s = String(raw ?? '').trim().toUpperCase()
    .replace(/^SLEEP_STAGE_/, '').replace(/^STAGE_TYPE_/, '');
  if (s === 'AWAKE_IN_BED') return 'AWAKE';
  if (['AWAKE', 'LIGHT', 'DEEP', 'REM', 'SLEEPING', 'OUT_OF_BED'].includes(s)) return s;
  return 'UNKNOWN';
}

/** YYYY-MM-DD of an instant in a time zone (device zone when omitted). */
export function localDate(ms, timeZone) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(ms));
}

function _normalize(records) {
  const out = [];
  for (const r of records || []) {
    const start = Date.parse(r?.startTime);
    const end   = Date.parse(r?.endTime);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
    const stages = [];
    for (const st of Array.isArray(r.stages) ? r.stages : []) {
      const s = Math.max(Date.parse(st?.startTime), start);
      const e = Math.min(Date.parse(st?.endTime), end);
      if (!Number.isFinite(s) || !Number.isFinite(e) || e <= s) continue;
      stages.push({ type: normalizeStage(st.stage), start: s, end: e });
    }
    out.push({
      id: String(r.metadata?.id ?? ''),
      origin: String(r.metadata?.dataOrigin ?? ''),
      start, end, stages,
    });
  }
  return out;
}

const _byTime = (a, b) => (a.start - b.start) || (a.end - b.end) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** Total length of the union of [start, end) intervals. */
function _coveredMs(intervals) {
  const sorted = [...intervals].sort(_byTime);
  let total = 0, curS = null, curE = null;
  for (const { start, end } of sorted) {
    if (curE == null || start > curE) {
      if (curE != null) total += curE - curS;
      curS = start; curE = end;
    } else if (end > curE) {
      curE = end;
    }
  }
  if (curE != null) total += curE - curS;
  return total;
}

/** Split sorted items into runs where each starts within `gap` of the run's end so far. */
function _runs(sorted, gap) {
  const runs = [];
  let run = null, runEnd = -Infinity;
  for (const s of sorted) {
    if (run && s.start - runEnd < gap) {
      run.push(s);
      if (s.end > runEnd) runEnd = s.end;
    } else {
      run = [s];
      runs.push(run);
      runEnd = s.end;
    }
  }
  return runs;
}

/** Within each stretch of overlapping sessions, keep one app's sessions. */
function _resolveOverlaps(sessions) {
  const kept = [];
  // Gap 0 means "starts before the previous one ended": a strict overlap.
  // Sessions that only touch end-to-start are separate, not duplicates.
  for (const group of _runs([...sessions].sort(_byTime), 0)) {
    const origins = [...new Set(group.map(s => s.origin))];
    if (origins.length === 1) { kept.push(...group); continue; }
    let best = null;
    for (const origin of origins) {
      const mine = group.filter(s => s.origin === origin);
      const score = {
        origin,
        covered: _coveredMs(mine),
        staged: mine.some(s => s.stages.length > 0) ? 1 : 0,
      };
      if (!best
          || score.staged > best.staged
          || (score.staged === best.staged && score.covered > best.covered)
          || (score.staged === best.staged && score.covered === best.covered && score.origin < best.origin)) {
        best = score;
      }
    }
    kept.push(...group.filter(s => s.origin === best.origin));
  }
  return kept.sort(_byTime);
}

/** Stage segments across a night in time order, each instant counted once. */
function _mergedStages(night) {
  const all = night.flatMap(s => s.stages).sort(_byTime);
  const out = [];
  let cursor = -Infinity;
  for (const seg of all) {
    const start = Math.max(seg.start, cursor);
    if (seg.end <= start) continue;
    out.push({ type: seg.type, start, end: seg.end });
    cursor = seg.end;
  }
  return out;
}

/**
 * The sleep metrics for `dateStr` (the day you woke up), from every
 * SleepSession record Health Connect returned. `records` are the plugin's
 * shape: { startTime, endTime, metadata: { id, dataOrigin }, stages: [
 * { startTime, endTime, stage } ] }. Returns {} when no night ends that day.
 */
export function deriveHealthConnectSleep(records, dateStr, timeZone) {
  const sessions = _resolveOverlaps(_normalize(records));

  let night = null, nightCovered = -1, nightEnd = -Infinity;
  for (const run of _runs(sessions, NIGHT_GAP_MS)) {
    const end = Math.max(...run.map(s => s.end));
    if (localDate(end, timeZone) !== dateStr) continue;
    const covered = _coveredMs(run);
    if (covered > nightCovered || (covered === nightCovered && end > nightEnd)) {
      night = run; nightCovered = covered; nightEnd = end;
    }
  }
  if (!night) return {};

  const metrics = { sleep_duration_min: Math.round(nightCovered / 60000) };

  const segs = _mergedStages(night).filter(s => COUNTED.includes(s.type));
  if (!segs.length) return metrics;

  const ms = { AWAKE: 0, LIGHT: 0, DEEP: 0, REM: 0 };
  for (const s of segs) ms[s.type] += s.end - s.start;
  metrics.sleep_deep_min  = Math.round(ms.DEEP  / 60000);
  metrics.sleep_light_min = Math.round(ms.LIGHT / 60000);
  metrics.sleep_rem_min   = Math.round(ms.REM   / 60000);
  metrics.sleep_wake_min  = Math.round(ms.AWAKE / 60000);

  const q = deriveSleepQuality(segs.map(s => ({
    type: s.type,
    startTime: new Date(s.start).toISOString(),
    endTime: new Date(s.end).toISOString(),
  })));
  metrics.sleep_restlessness_min  = q.restlessnessMin;
  metrics.sleep_interruptions_min = q.interruptionsMin;
  metrics.sleep_full_awakenings   = q.fullAwakenings;
  if (q.timeToSoundSleep != null) metrics.sleep_time_to_fall_asleep_min = q.timeToSoundSleep;
  if (q.soundSleepMin    != null) metrics.sleep_sound_sleep_min         = q.soundSleepMin;
  return metrics;
}
