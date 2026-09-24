/**
 * sleep-quality.js: the Sleep Quality sub-metrics, derived from a night's
 * stage segments.
 *
 * This walk was written for Google Health (server/lib/google-health.js) and
 * calibrated against the Fitbit app night by night. It lives here so every
 * source derives these numbers the same way: Google Health on the server,
 * and Health Connect on the phone (src/lib/sleep-sessions.js). A second copy
 * with its own rules is how Health Connect came to store different numbers
 * under different names (#236).
 *
 * The Android background worker carries a Kotlin port
 * (android/.../SleepDerivation.kt). Both are held to the same fixtures in
 * scripts/fixtures/sleep-sessions.json, so a change here that is not made
 * there fails a test.
 *
 * Input: segments shaped { type, startTime, endTime }, type one of AWAKE,
 * LIGHT, DEEP, REM (anything else is ignored), times as anything `new Date`
 * parses. Order matters: pass them in time order.
 *
 * No dependencies, so the server and the browser can both import it.
 */

// Sleep Quality sub-metrics (Fitbit Public Preview Sleep Score redesign).
// Derived by walking the segment-level `stages[]` array. GH's summary
// fields do not carry these directly (verified via raw dumps on
// 2026-05-06 and 2026-05-07).
//
// GH puts segment timestamps at the TOP level of each stage object as
// `startTime` / `endTime` strings (RFC3339), NOT nested under `interval`.
//
//   - Time to Sound Sleep (min): from first asleep stage to first DEEP.
//     Validated exact on 2026-05-07 (11 min, matched Fitbit app).
//
//   - Interruptions (min) + Full Awakenings (count): mid-night AWAKE
//     events >= 5 min, EXCLUDING the FIRST AWAKE block (settling in)
//     AND the LAST AWAKE block (morning wake-up event). Both gates are
//     conditional on the block being >= 5 min; a brief 3-min AWAKE at
//     either end stays counted (matches Fitbit's behavior on 2026-05-06,
//     where the only AWAKE was 3.5 min and Fitbit credited it as
//     restlessness, not as a "settling-in" period).
//
//   - Restlessness (min): sum of AWAKE segment durations < 5 min, with
//     the same first/last gates. APPROXIMATION ONLY: Fitbit's app
//     value comes from raw actigraphy / movement data that GH does not
//     expose in the sleep dataPoint (verified 2026-05-07: Fitbit shows
//     10 min restlessness, but no AWAKE segment in the GH response is
//     under 5 min, so the segment-level derivation has no signal).
//
//   - Sound Sleep (min): DEEP + REM + brief LIGHT segments (<5 min).
//     Calibration on 3 ground-truth days (May 7/8/9) shows DEEP+REM
//     alone is consistently 5–8 min below Fitbit on long nights but
//     ~30 min off on short nights, while adding short-LIGHT
//     interludes brings May 8/9 within 5 min and May 7 within 23 min.
//     Mean abs error ~10 min vs longest-contiguous-block which
//     consistently overshot by ~2x. Brief LIGHT < 5 min appears to
//     count as "sound" because it represents micro-arousals between
//     stable sleep blocks, not real waking.
//
// First pass: find the index of the AWAKE >= 5 min that's the actual
// morning wake-up event (so the main walk can skip it instead of
// counting it as an interruption). The wake-up event is the LAST big
// AWAKE block that's at or near the end of the sleep period, i.e.
// followed by negligible (< 5 min) sleep. Mid-night AWAKE blocks have
// substantial sleep after them and are real interruptions, not wake-ups.
//
// 2026-05-10 caught a regression: stages ended with
//   ... AWAKE:8m LIGHT:15m REM:1.5m LIGHT:33.5m
// The AWAKE:8m is mid-night (50 min of sleep follows) but the previous
// logic treated it as the wake-up because it was the last AWAKE >= 5min.
// Fitbit correctly counted it as an interruption (8m / 1 moment).
export function deriveSleepQuality(segments) {
  const stageSegs = Array.isArray(segments) ? segments : [];
  const FULL_AWAKE_MIN = 5;
  let lastAwakeBigIdx = -1;
  for (let i = stageSegs.length - 1; i >= 0; i--) {
    const seg = stageSegs[i];
    if (seg.type !== 'AWAKE' || !seg.startTime || !seg.endTime) continue;
    const dm = (new Date(seg.endTime) - new Date(seg.startTime)) / 60000;
    if (!Number.isFinite(dm) || dm < FULL_AWAKE_MIN) continue;
    // Sum sleep stages immediately following this AWAKE up to the next
    // AWAKE (or end of array). If < 5 min, this is the wake-up event.
    let postSleepMin = 0;
    for (let j = i + 1; j < stageSegs.length; j++) {
      const s2 = stageSegs[j];
      if (s2.type === 'AWAKE') break;
      if (!s2.startTime || !s2.endTime) continue;
      const dm2 = (new Date(s2.endTime) - new Date(s2.startTime)) / 60000;
      if (Number.isFinite(dm2)) postSleepMin += dm2;
    }
    if (postSleepMin < FULL_AWAKE_MIN) {
      lastAwakeBigIdx = i;
      break;
    }
    // Otherwise keep scanning earlier; there may be a later "true" wake-up
    // farther back, or no wake-up event at all (every big AWAKE counts).
  }

  const BRIEF_LIGHT_MAX = 5; // LIGHT segments < 5 min count toward Sound Sleep
  const TTSS_SETTLING_CAP = 10; // initial AWAKE up to N min counts toward TTSS
  let interruptionsMin = 0;
  let fullAwakenings   = 0;
  let restlessnessMin  = 0;
  let firstAsleepStart = null;
  let firstDeepStart   = null;
  let soundSleepRaw    = 0;
  let firstAwakeSeen   = false;
  for (let i = 0; i < stageSegs.length; i++) {
    const seg = stageSegs[i];
    const s = seg.startTime;
    const e = seg.endTime;
    if (!s || !e) continue;
    const durMin = (new Date(e) - new Date(s)) / 60000;
    if (!Number.isFinite(durMin)) continue;
    if (seg.type === 'AWAKE') {
      // First AWAKE >= 5 min: settling-in period. Fitbit's app measures TTSS
      // from when the wearable detected the start of the sleep session
      // (including a short initial settling-in AWAKE) to the first DEEP
      // block, BUT only for reasonably short initial AWAKE. For long initial
      // AWAKE (Jun 30 2026: 15m), Fitbit apparently assumes the user was
      // awake before going to bed and starts TTSS from the first sleep stage
      // instead. Calibration data: 3.5m/5m/5.5m/7m AWAKE all include-in-ttss,
      // 15m does not; the threshold sits somewhere between. TTSS_SETTLING_CAP
      // set at 10 min conservatively; revisit if a 10-15m point lands.
      if (!firstAwakeSeen) {
        firstAwakeSeen = true;
        if (durMin >= FULL_AWAKE_MIN) {
          if (durMin <= TTSS_SETTLING_CAP && firstAsleepStart == null) {
            firstAsleepStart = new Date(s).getTime();
          }
          continue;
        }
      }
      // Last AWAKE >= 5 min: morning wake-up event, exclude.
      if (i === lastAwakeBigIdx) continue;
      if (durMin >= FULL_AWAKE_MIN) {
        interruptionsMin += Math.round(durMin);
        fullAwakenings++;
      } else {
        // Floor so 3.5 → 3, matching Fitbit display.
        restlessnessMin += Math.floor(durMin);
      }
    } else if (seg.type === 'DEEP' || seg.type === 'REM') {
      soundSleepRaw += durMin;
      if (firstAsleepStart == null) firstAsleepStart = new Date(s).getTime();
      if (seg.type === 'DEEP' && firstDeepStart == null) firstDeepStart = new Date(s).getTime();
    } else if (seg.type === 'LIGHT') {
      if (firstAsleepStart == null) firstAsleepStart = new Date(s).getTime();
      // Brief LIGHT < 5 min counts as part of "sound" sleep: a micro-arousal
      // between stable blocks rather than a meaningful waking event.
      if (durMin < BRIEF_LIGHT_MAX) soundSleepRaw += durMin;
    }
  }
  const timeToSoundSleep = (firstAsleepStart != null && firstDeepStart != null && firstDeepStart > firstAsleepStart)
    ? Math.round((firstDeepStart - firstAsleepStart) / 60000)
    : null;
  const soundSleepMin = soundSleepRaw > 0 ? Math.round(soundSleepRaw) : null;
  return { restlessnessMin, interruptionsMin, fullAwakenings, timeToSoundSleep, soundSleepMin };
}
