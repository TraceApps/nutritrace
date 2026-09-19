/**
 * Static-analysis tests for the general public REST API wiring
 * (/api/v1/diary, /api/v1/goals, /api/v1/meals).
 *
 * These do not exercise real HTTP requests; they guard against
 * accidental unwiring of the route mounts, the feature flags, or a
 * route calling something other than the shared xCore function during
 * future refactors. Pure text/regex checks over the source files, no
 * db.js import, so this runs without a compiled better-sqlite3 native
 * binding. Real verification requires a running dev server with
 * PUBLIC_API_ENABLED=1 and a curl/http client against it.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const indexJs   = readFileSync(new URL('../server/routes/api/v1/index.js', import.meta.url), 'utf8');
const diaryJs   = readFileSync(new URL('../server/routes/api/v1/diary.js', import.meta.url), 'utf8');
const goalsJs   = readFileSync(new URL('../server/routes/api/v1/goals.js', import.meta.url), 'utf8');
const mealsJs   = readFileSync(new URL('../server/routes/api/v1/meals.js', import.meta.url), 'utf8');
const apiTokensJs = readFileSync(new URL('../server/lib/api-tokens.js', import.meta.url), 'utf8');

test('diary/goals/meals sub-routers are mounted under /api/v1/index.js', () => {
  assert.match(indexJs, /import diaryRouter from '\.\/diary\.js'/);
  assert.match(indexJs, /import goalsRouter from '\.\/goals\.js'/);
  assert.match(indexJs, /import mealsRouter from '\.\/meals\.js'/);
  assert.match(indexJs, /router\.use\('\/diary',\s*diaryRouter\)/);
  assert.match(indexJs, /router\.use\('\/goals',\s*goalsRouter\)/);
  assert.match(indexJs, /router\.use\('\/meals',\s*mealsRouter\)/);
});

test('each new sub-router is feature-flagged on PUBLIC_API_ENABLED', () => {
  for (const [name, src] of [['diary.js', diaryJs], ['goals.js', goalsJs], ['meals.js', mealsJs]]) {
    assert.match(src, /PUBLIC_API_ENABLED/, `${name} should check PUBLIC_API_ENABLED`);
  }
});

test('existing federation sub-routers (foods, workouts, activity, body-measurements) are untouched by the new flag', () => {
  for (const file of ['foods.js', 'workouts.js', 'activity.js', 'body-measurements.js']) {
    const src = readFileSync(new URL(`../server/routes/api/v1/${file}`, import.meta.url), 'utf8');
    assert.doesNotMatch(src, /PUBLIC_API_ENABLED/, `${file} should not gain the new base flag`);
  }
});

test('diary.js write routes require PUBLIC_API_WRITE_ENABLED independent of the base flag', () => {
  assert.match(diaryJs, /PUBLIC_API_WRITE_ENABLED/);
  assert.match(diaryJs, /requireWriteEnabled/);
});

test('every read route reuses mcp:read, every write route reuses mcp:write, no new api:* scope', () => {
  for (const src of [diaryJs, goalsJs, mealsJs]) {
    const getRoutes = [...src.matchAll(/router\.get\(('[^']+'|"[^"]+")\s*,\s*([^,]+),/g)];
    for (const [, path, middleware] of getRoutes) {
      assert.match(middleware, /requireScope\('mcp:read'\)/, `${path} should require mcp:read`);
    }
  }
  const writeRoutes = [...diaryJs.matchAll(/router\.(post|put)\(('[^']+'|"[^"]+")[\s\S]{0,160}?requireScope\('mcp:write'\)/g)];
  assert.ok(writeRoutes.length >= 4, 'expected at least 4 write routes in diary.js gated on mcp:write');
  assert.doesNotMatch(diaryJs + goalsJs + mealsJs, /'api:read'|'api:write'|"api:read"|"api:write"/);
});

test('no DELETE route exists yet (destroy parity deliberately deferred)', () => {
  for (const src of [diaryJs, goalsJs, mealsJs]) {
    assert.doesNotMatch(src, /router\.delete\(/);
  }
});

test('each route calls a shared xCore function rather than a fresh db.prepare', () => {
  for (const [name, src] of [['diary.js', diaryJs], ['goals.js', goalsJs], ['meals.js', mealsJs]]) {
    assert.doesNotMatch(src, /db\.prepare/, `${name} should not query the DB directly, only via xCore imports`);
  }
  for (const coreFn of ['listDiaryCore', 'dailyTotalsCore', 'logFoodCore', 'logWaterCore', 'logMealCore', 'logBodyStatCore']) {
    assert.match(diaryJs, new RegExp(coreFn), `diary.js should import and call ${coreFn}`);
  }
  assert.match(goalsJs, /getGoalsCore/);
  for (const coreFn of ['searchMealsCore', 'recentMealsCore', 'getMealDetailsCore']) {
    assert.match(mealsJs, new RegExp(coreFn), `meals.js should import and call ${coreFn}`);
  }
});

test('SCOPE_DESCRIPTIONS mentions the /api/v1 routes alongside MCP for mcp:read and mcp:write', () => {
  const desc = apiTokensJs.match(/SCOPE_DESCRIPTIONS = \{([\s\S]*?)\n\};/)[1];
  assert.match(desc, /\/api\/v1/);
});
