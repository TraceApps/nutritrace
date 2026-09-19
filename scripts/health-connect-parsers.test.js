/**
 * Tests for src/lib/health-connect-parsers.js. Guards against #206
 * regression: body-composition and BMR reads must NOT store 0 when the
 * plugin returns a Kotlin toString() string that the current object-path
 * lookup can't decode.
 *
 * Every parser has to satisfy two contracts:
 *   1. Parse both object and string shapes.
 *   2. Return null (not 0) when nothing usable is found, so callers can
 *      OMIT the wellness_data key. missing != zero.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseMassKg,
  parsePercent,
  parseBmrKcalPerDay,
  parseTemperatureC,
  parseRespiratoryRate,
  parseVo2Max,
  _internal,
} from '../src/lib/health-connect-parsers.js';

// ── parseMassKg ───────────────────────────────────────────────────────────

test('parseMassKg: object with mass.inKilograms', () => {
  assert.equal(parseMassKg({ mass: { inKilograms: 25.4 } }), 25.4);
});

test('parseMassKg: object with weight.inKilograms', () => {
  assert.equal(parseMassKg({ weight: { inKilograms: 79.3 } }), 79.3);
});

test('parseMassKg: object with a bare value', () => {
  assert.equal(parseMassKg({ value: 12.5 }), 12.5);
});

test('parseMassKg: Kotlin toString kilograms', () => {
  // The #206 shape. Prior code returned 0 because latest.mass?.inKilograms
  // was undefined on a string.
  assert.equal(parseMassKg('BoneMassRecord{mass=2.5 kilograms, time=...}'), 2.5);
});

test('parseMassKg: Kotlin toString grams converts to kg', () => {
  assert.equal(parseMassKg('mass=25400.0 grams'), 25.4);
});

test('parseMassKg: unitless mass= in string still parses', () => {
  assert.equal(parseMassKg('mass=2.5'), 2.5);
});

test('parseMassKg: null / undefined / bad shapes return null', () => {
  assert.equal(parseMassKg(null), null);
  assert.equal(parseMassKg(undefined), null);
  assert.equal(parseMassKg({}), null);
  assert.equal(parseMassKg({ mass: {} }), null);
  assert.equal(parseMassKg({ value: 0 }), null, '0 must be treated as no-data');
  assert.equal(parseMassKg({ value: -1 }), null);
  assert.equal(parseMassKg('nothing here'), null);
  assert.equal(parseMassKg(42), null);
});

// ── parsePercent ──────────────────────────────────────────────────────────

test('parsePercent: object with percentage.value', () => {
  assert.equal(parsePercent({ percentage: { value: 18.5 } }), 18.5);
});

test('parsePercent: Kotlin toString "percentage=18.5%"', () => {
  assert.equal(parsePercent('BodyFatRecord{percentage=18.5%, ...}'), 18.5);
});

test('parsePercent: 0 percent returns null so callers omit the key', () => {
  assert.equal(parsePercent({ percentage: { value: 0 } }), null);
  assert.equal(parsePercent('percentage=0%'), null);
});

test('parsePercent: bad input returns null', () => {
  assert.equal(parsePercent(null), null);
  assert.equal(parsePercent({}), null);
  assert.equal(parsePercent('nope'), null);
});

// ── parseBmrKcalPerDay ────────────────────────────────────────────────────

test('parseBmrKcalPerDay: object with inKilocaloriesPerDay', () => {
  assert.equal(parseBmrKcalPerDay({ basalMetabolicRate: { inKilocaloriesPerDay: 1650 } }), 1650);
});

test('parseBmrKcalPerDay: object with inWatts converts to kcal/day', () => {
  const r = parseBmrKcalPerDay({ basalMetabolicRate: { inWatts: 80 } });
  // 80 W * (86400 s/day / 4184 J/kcal) = 80 * 20.6501 = 1652.008... kcal/day.
  // Use approximate equality; the conversion constant is well-defined but
  // callers Math.round anyway.
  assert.ok(Math.abs(r - 80 * _internal.WATTS_TO_KCAL_PER_DAY) < 1e-6);
});

test('parseBmrKcalPerDay: Kotlin toString Watts converts', () => {
  // The #206 headliner. Prior code wrote wattage directly as kcal/day.
  const r = parseBmrKcalPerDay('BasalMetabolicRateRecord{basalMetabolicRate=80.0 Watts}');
  assert.ok(Math.abs(r - 80 * _internal.WATTS_TO_KCAL_PER_DAY) < 1e-6);
  // ~1650 kcal/day, which is a plausible adult BMR.
  assert.ok(r > 1600 && r < 1700, `expected ~1650, got ${r}`);
});

test('parseBmrKcalPerDay: Kotlin toString kilocaloriesPerDay keeps units', () => {
  assert.equal(
    parseBmrKcalPerDay('basalMetabolicRate=1650.0 kilocaloriesPerDay'),
    1650
  );
});

test('parseBmrKcalPerDay: bad input returns null', () => {
  assert.equal(parseBmrKcalPerDay(null), null);
  assert.equal(parseBmrKcalPerDay({}), null);
  assert.equal(parseBmrKcalPerDay('no rate here'), null);
  assert.equal(parseBmrKcalPerDay({ basalMetabolicRate: { inWatts: 0 } }), null);
});

// ── parseTemperatureC ─────────────────────────────────────────────────────

test('parseTemperatureC: object celsius', () => {
  assert.equal(parseTemperatureC({ temperature: { inCelsius: 36.5 } }), 36.5);
});

test('parseTemperatureC: object fahrenheit converts', () => {
  const r = parseTemperatureC({ temperature: { inFahrenheit: 98.6 } });
  assert.ok(Math.abs(r - 37) < 0.05);
});

test('parseTemperatureC: Kotlin string celsius', () => {
  assert.equal(parseTemperatureC('temperature=36.5 celsius'), 36.5);
});

test('parseTemperatureC: Kotlin string fahrenheit converts', () => {
  const r = parseTemperatureC('temperature=98.6 fahrenheit');
  assert.ok(Math.abs(r - 37) < 0.05);
});

test('parseTemperatureC: bad input returns null', () => {
  assert.equal(parseTemperatureC(null), null);
  assert.equal(parseTemperatureC({}), null);
  assert.equal(parseTemperatureC('nope'), null);
});

// ── parseRespiratoryRate ──────────────────────────────────────────────────

test('parseRespiratoryRate: object rate', () => {
  assert.equal(parseRespiratoryRate({ rate: 15.5 }), 15.5);
});

test('parseRespiratoryRate: object value fallback', () => {
  assert.equal(parseRespiratoryRate({ value: 15 }), 15);
});

test('parseRespiratoryRate: Kotlin string', () => {
  assert.equal(parseRespiratoryRate('RespiratoryRateRecord{rate=15.5}'), 15.5);
});

test('parseRespiratoryRate: 0 rate returns null', () => {
  assert.equal(parseRespiratoryRate({ rate: 0 }), null);
  assert.equal(parseRespiratoryRate('rate=0'), null);
});

test('parseRespiratoryRate: bad input returns null', () => {
  assert.equal(parseRespiratoryRate(null), null);
  assert.equal(parseRespiratoryRate({}), null);
  assert.equal(parseRespiratoryRate('nope'), null);
});

// ── parseVo2Max ───────────────────────────────────────────────────────────

test('parseVo2Max: object with vo2MillilitersPerMinuteKilogram', () => {
  assert.equal(parseVo2Max({ vo2MillilitersPerMinuteKilogram: 42.5 }), 42.5);
});

test('parseVo2Max: Kotlin string', () => {
  assert.equal(parseVo2Max('Vo2MaxRecord{vo2MillilitersPerMinuteKilogram=42.5}'), 42.5);
});

test('parseVo2Max: bad input returns null', () => {
  assert.equal(parseVo2Max(null), null);
  assert.equal(parseVo2Max({}), null);
  assert.equal(parseVo2Max('nope'), null);
});

// ── Alternate Kotlin toString shapes (defence in depth) ──────────────────

test('parseMassKg: Mass{value=1.5, unit=KILOGRAMS} data-class shape', () => {
  assert.equal(parseMassKg('BoneMassRecord{time=..., mass=Mass{value=2.4, unit=KILOGRAMS}}'), 2.4);
});

test('parseMassKg: Mass(inKilograms=1.5) parenthesized shape', () => {
  assert.equal(parseMassKg('LeanBodyMassRecord{mass=Mass(inKilograms=58.7), time=...}'), 58.7);
});

test('parseMassKg: mass=1.5kg no-space unit', () => {
  assert.equal(parseMassKg('mass=2.5kg'), 2.5);
});

test('parseMassKg: unit=GRAMS via data-class', () => {
  assert.equal(parseMassKg('mass=Mass{value=25400, unit=GRAMS}'), 25.4);
});

test('parseMassKg: unit=POUNDS converts to kg', () => {
  const r = parseMassKg('mass=Mass{value=100, unit=POUNDS}');
  assert.ok(Math.abs(r - 45.3592) < 0.001);
});

test('parseMassKg: unitless value rejects nonsense out-of-range', () => {
  // A stray large number (e.g. a timestamp fragment) should not be
  // accepted as a mass in kg.
  assert.equal(parseMassKg('mass=9999999999'), null);
});

test('parsePercent: Percentage{value=18.5} data-class shape', () => {
  assert.equal(parsePercent('BodyFatRecord{percentage=Percentage{value=18.5}}'), 18.5);
});

test('parseBmrKcalPerDay: Power{value=80, unit=WATTS} data-class shape', () => {
  const r = parseBmrKcalPerDay('BasalMetabolicRateRecord{basalMetabolicRate=Power{value=80, unit=WATTS}}');
  assert.ok(Math.abs(r - 80 * _internal.WATTS_TO_KCAL_PER_DAY) < 1e-6);
});

test('parseBmrKcalPerDay: inWatts= form', () => {
  const r = parseBmrKcalPerDay('basalMetabolicRate=Power(inWatts=80)');
  assert.ok(Math.abs(r - 80 * _internal.WATTS_TO_KCAL_PER_DAY) < 1e-6);
});

test('parseBmrKcalPerDay: Power{value=1650, unit=KILOCALORIES_PER_DAY}', () => {
  assert.equal(
    parseBmrKcalPerDay('basalMetabolicRate=Power{value=1650, unit=KILOCALORIES_PER_DAY}'),
    1650
  );
});

test('parseTemperatureC: Temperature{value=36.5, unit=CELSIUS} data-class shape', () => {
  assert.equal(
    parseTemperatureC('BodyTemperatureRecord{temperature=Temperature{value=36.5, unit=CELSIUS}}'),
    36.5
  );
});

test('parseTemperatureC: inCelsius= form', () => {
  assert.equal(parseTemperatureC('temperature=Temperature(inCelsius=36.5)'), 36.5);
});

test('parseTemperatureC: Fahrenheit data-class converts', () => {
  const r = parseTemperatureC('temperature=Temperature{value=98.6, unit=FAHRENHEIT}');
  assert.ok(Math.abs(r - 37) < 0.05);
});

// ── Anti-regression on #206 exact scenario ────────────────────────────────

test('#206: Kotlin toString body composition reads no longer become 0', () => {
  // Reporter's exact class of bug: the plugin ships Kotlin toString() and
  // the old code did `latest.mass?.inKilograms || latest.value || 0`,
  // which stored 0 for any real measurement. The new parsers return null
  // on the string form when the code was buggy, and the correct value now.
  const boneStr = 'BoneMassRecord{mass=2.4 kilograms, time=2026-09-07T09:00:00Z, ...}';
  const leanStr = 'LeanBodyMassRecord{mass=58.7 kilograms, time=..., ...}';
  const bmrStr  = 'BasalMetabolicRateRecord{basalMetabolicRate=80.0 Watts, ...}';

  assert.equal(parseMassKg(boneStr), 2.4);
  assert.equal(parseMassKg(leanStr), 58.7);
  const bmr = parseBmrKcalPerDay(bmrStr);
  assert.ok(bmr > 1600 && bmr < 1700, `BMR watts must convert to kcal/day, got ${bmr}`);
});
