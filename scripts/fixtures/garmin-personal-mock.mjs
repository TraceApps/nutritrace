/**
 * A stand-in for Garmin's Personal API (#279), for tests and the browser
 * pass. Paths, auth and response shapes follow Garmin's published Personal
 * API schemas (swagger-docs on developer.garmin.com):
 *
 *   POST /personalapitoken-service/personal-api/personal-api-key/token
 *        Authorization: ApiKey <key>  ->  200 raw JWT | 401 empty
 *   GET  /usersummary-service/v2/dailysummaries?startDate&endDate -> { data: [...] }
 *   GET  /sleep-service/sleep/dailySleepSummariesByDate?startDate&endDate -> [...]
 *   GET  /hrv-service/hrv/daily/{from}/{to} -> { hrvSummaries: [...] } | 204
 *   GET  /weight-service/weight/range/{from}/{to} -> { dailyWeightSummaries: [...] }
 *
 * Mode 'watch' answers every day with realistic numbers; mode 'empty' answers
 * like an account with no device (what the real API returned for one).
 *
 * Run alone: node scripts/fixtures/garmin-personal-mock.mjs <port> [mode] [validKey]
 */
import http from 'node:http';

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
export function makeJwt(expSec, extra = {}) {
  return [b64({ alg: 'RS256', typ: 'JWT', kid: 'mock' }),
    b64({ iss: 'https://diauth.garmin.com', scope: ['PERSONAL_API_WELLNESS_READ'], iat: Math.floor(Date.now() / 1000), exp: expSec, ...extra }),
    'c2lnbmF0dXJl'].join('.');
}

const shift = (d, n) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const days = (from, to) => { const out = []; for (let d = from; d <= to && out.length < 400; d = shift(d, 1)) out.push(d); return out; };
const seed = (d) => Number(d.replaceAll('-', '')) % 97;   // steady per-date variety

export function dailySummary(date) {
  const k = seed(date);
  return {
    uuid: '123e4567-e89b-12d3-a456-426655440000', userProfilePk: 987654321, calendarDate: date, source: 'garmin',
    includesWellnessData: true, includesActivityData: true,
    movement: {
      steps: { goal: 10000, value: 6000 + k * 61, distanceInMeters: (6000 + k * 61) * 0.78 },
      floorsAscended: { goal: 10, value: 4 + (k % 9), distanceInMeters: 15.24 },
      floorsDescended: { value: 3, distanceInMeters: 9.144 },
    },
    calories: { burnedResting: 1650, burnedActive: 420 + k * 3, burnedTotal: 2070 + k * 3, consumedGoal: 2000, consumedValue: 0, consumedRemaining: 2000 },
    heartRate: { minValue: 48, maxValue: 150 + (k % 20), restingValue: 52 + (k % 6), alertCount: 0 },
    intensityMinutes: { goal: 150, moderate: 20 + (k % 15), vigorous: 5 + (k % 10) },
    stress: { avgLevel: 25 + (k % 20), maxLevel: 90, qualifier: 'balanced', totalDurationInMillis: 57600000 },
    bodyBattery: { minValue: 15 + (k % 10), maxValue: 80 + (k % 15), chargedValue: 60, drainedValue: 55, latestValue: 40, endOfDayValue: 30, featureVersion: '2.0' },
    respiration: { avgValue: 15, maxValue: 20, minValue: 10, latestValue: 14, algorithmVersion: 100 },
    pulseOx: { avgValue: 95 + (k % 3), minValue: 90, latestValue: 96 },
  };
}

export function sleepSummary(date) {
  const k = seed(date);
  const prev = shift(date, -1);
  return {
    id: 1, userProfilePK: 987654321, calendarDate: date,
    sleepTimeSeconds: 25200 + k * 30, napTimeSeconds: 0, sleepWindowConfirmed: true, sleepWindowConfirmationType: 'enhanced_confirmed_final',
    sleepStartTimestampLocal: `${prev}T23:${String(10 + (k % 40)).padStart(2, '0')}:00.0`,
    sleepEndTimestampLocal: `${date}T06:${String(30 + (k % 25)).padStart(2, '0')}:00.0`,
    sleepStartTimestampGMT: `${prev}T22:10:00.0`, sleepEndTimestampGMT: `${date}T05:40:00.0`,
    deepSleepSeconds: 5400 + k * 10, lightSleepSeconds: 13200, remSleepSeconds: 6000, awakeSleepSeconds: 900, unmeasurableSleepSeconds: 0,
    deviceRemCapable: true, sleepFromDevice: true,
    averageSpO2Value: 95.4, lowestSpO2Value: 89, highestSpO2Value: 99,
    averageRespirationValue: 14.6, lowestRespirationValue: 11, highestRespirationValue: 18,
    awakeCount: 1, avgSleepStress: 18.5, avgHeartRate: 54.2,
    sleepScores: { overall: { value: 70 + (k % 25), qualifierKey: 'GOOD' }, totalDuration: { value: 80, qualifierKey: 'GOOD' } },
    dailyNapDTOS: [],
  };
}

export function hrvSummary(date) {
  const k = seed(date);
  return {
    calendarDate: date, weeklyAvg: 48, lastNightAvg: 40 + (k % 18), lastNight5MinHigh: 70,
    baseline: { lowUpper: 38, balancedLow: 42, balancedUpper: 58, markerValue: 0.5 },
    status: 'BALANCED', feedbackPhrase: 'HRV_BALANCED_1', createTimeStamp: `${date}T07:02:11.0`,
  };
}

export function weightEntry(date, i) {
  return {
    date: Date.parse(date + 'T07:15:00Z'), calendarDate: date,
    weight: 81.4 - i * 0.1, bmi: 24.6, bodyFat: 18.2, bodyWater: 58.4,
    boneMass: 3400, muscleMass: 38600, physiqueRating: 5, visceralFat: 7, metabolicAge: 31,
    timestampGMT: `${date}T06:15:00.000+0000`, weightDelta: -0.1,
  };
}

/**
 * Start the mock. Returns { url, state, close }. state is live:
 *   validKeys (Set), mode ('watch' | 'empty'), tokenTtlSec, rejectNextData (n
 *   401s to send on data calls), status429 (true to throttle data calls),
 *   requests (log of { method, path, auth }), tokensIssued.
 */
export function startMock({ port = 0, mode = 'watch', validKeys = [], tokenTtlSec = 86400, host = '127.0.0.1' } = {}) {
  const state = {
    mode, validKeys: new Set(validKeys), tokenTtlSec, rejectNextData: 0, status429: false,
    requests: [], tokensIssued: 0, liveTokens: new Set(), tokenFormat: 'raw',
  };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://mock');
    const auth = req.headers.authorization || '';
    state.requests.push({ method: req.method, path: url.pathname, query: url.search, auth });
    const send = (code, body, type = 'application/json') => {
      if (body == null) { res.writeHead(code); return res.end(); }
      res.writeHead(code, { 'content-type': type });
      res.end(typeof body === 'string' ? body : JSON.stringify(body));
    };

    if (url.pathname === '/personalapitoken-service/personal-api/personal-api-key/token') {
      if (req.method !== 'POST') return send(405, null);
      if (!auth.startsWith('ApiKey ')) return send(400, { error: 'Authentication missing', status: 400 });
      if (!state.validKeys.has(auth.slice(7))) return send(401, null);
      state.tokensIssued++;
      const jwt = makeJwt(Math.floor(Date.now() / 1000) + state.tokenTtlSec, { jti: 'tok' + state.tokensIssued });
      state.liveTokens.add(jwt);
      return send(200, state.tokenFormat === 'quoted' ? JSON.stringify(jwt) : jwt, state.tokenFormat === 'quoted' ? 'application/json' : 'text/plain');
    }

    if (!auth.startsWith('Bearer ') || !state.liveTokens.has(auth.slice(7))) return send(401, null);
    if (state.rejectNextData > 0) { state.rejectNextData--; return send(401, null); }
    if (state.status429) return send(429, null);
    const empty = state.mode === 'empty';

    let m;
    if (url.pathname === '/usersummary-service/v2/dailysummaries') {
      const list = empty ? [] : days(url.searchParams.get('startDate'), url.searchParams.get('endDate')).map(dailySummary);
      return send(200, { data: list });
    }
    if (url.pathname === '/sleep-service/sleep/dailySleepSummariesByDate') {
      const list = empty ? [] : days(url.searchParams.get('startDate'), url.searchParams.get('endDate')).map(sleepSummary);
      return send(200, list);
    }
    if ((m = url.pathname.match(/^\/hrv-service\/hrv\/daily\/(\d{4}-\d{2}-\d{2})\/(\d{4}-\d{2}-\d{2})$/))) {
      if (empty) return send(204, null);
      return send(200, { hrvSummaries: days(m[1], m[2]).map(hrvSummary), userProfilePk: 987654321 });
    }
    if ((m = url.pathname.match(/^\/weight-service\/weight\/range\/(\d{4}-\d{2}-\d{2})\/(\d{4}-\d{2}-\d{2})$/))) {
      // A weigh-in every other day, and today.
      const today = new Date().toISOString().slice(0, 10);
      const list = empty ? [] : days(m[1], m[2]).filter((d) => seed(d) % 2 === 0 || d === today).map((d, i) => ({
        summaryDate: d, numOfWeightEntries: 1, minWeight: 81.3, maxWeight: 81.5,
        latestWeight: weightEntry(d, i), allWeightMetrics: [weightEntry(d, i)],
      }));
      return send(200, { dailyWeightSummaries: list, totalAverage: {} });
    }
    if (url.pathname === '/userprofile-service/userprofile/settings') return send(200, {});
    return send(404, null);
  });
  return new Promise((resolve) => {
    server.listen(port, host, () => {
      resolve({ url: `http://${host}:${server.address().port}`, state, close: () => new Promise((r) => server.close(r)) });
    });
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [port = '4010', mode = 'watch', key = 'MOCKKEY_personal-api-demo.0000-1111'] = process.argv.slice(2);
  const m = await startMock({ port: Number(port), mode, validKeys: [key], host: '0.0.0.0' });
  console.log(`garmin mock (${mode}) on ${m.url}`);
}
