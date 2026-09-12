/**
 * Static-analysis tests for outgoing webhooks wiring.
 *
 * These do not exercise real deliveries; they guard against accidental
 * unwiring of the route mount, the feature flags, or an event call site
 * being removed during future refactors. Pure text/regex checks over
 * the source files, no db.js import, so this runs without a compiled
 * better-sqlite3 native binding. Real delivery verification (signature,
 * retry, SSRF guard against a live target) requires a running dev
 * server with WEBHOOKS_ENABLED=1 and a test receiver.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const indexJs    = readFileSync(new URL('../server/index.js', import.meta.url), 'utf8');
const routeJs    = readFileSync(new URL('../server/routes/webhooks.js', import.meta.url), 'utf8');
const libJs      = readFileSync(new URL('../server/lib/webhooks.js', import.meta.url), 'utf8');
const deliveryJs = readFileSync(new URL('../server/lib/webhook-delivery.js', import.meta.url), 'utf8');
const diaryJs    = readFileSync(new URL('../server/routes/diary.js', import.meta.url), 'utf8');
const dbJs       = readFileSync(new URL('../server/db.js', import.meta.url), 'utf8');

test('webhooks route is mounted at /api/admin/webhooks on the main router', () => {
  assert.match(indexJs, /import webhooksRoutes[\s\S]*from '\.\/routes\/webhooks\.js'/);
  assert.match(indexJs, /router\.use\('\/api\/admin\/webhooks',\s*webhooksRoutes\)/);
});

test('webhooks CRUD route requires session auth (requireAuth, requireAdmin), not bearer', () => {
  assert.match(routeJs, /requireAuth,\s*requireAdmin/);
  assert.doesNotMatch(routeJs, /bearerAuth/);
});

test('webhooks table exists with an encrypted secret column, not a hash', () => {
  assert.match(dbJs, /CREATE TABLE IF NOT EXISTS webhooks/);
  assert.match(dbJs, /secret_encrypted/);
});

test('webhook delivery is gated on WEBHOOKS_ENABLED, off by default', () => {
  assert.match(libJs, /WEBHOOKS_ENABLED/);
});

test('webhook target URLs are validated through the shared SSRF guard, at creation and before delivery', () => {
  assert.match(libJs, /import \{ assertSafeUrl \} from '\.\/ssrf-guard\.js'/);
  const occurrences = [...libJs.matchAll(/assertSafeUrl\(/g)];
  assert.ok(occurrences.length >= 3, 'expected assertSafeUrl called at create, update, and delivery time');
});

test('assertSafeUrl is re-checked inside the retry loop, not just once before it (regression check)', () => {
  // A prior version called assertSafeUrl once before the `for` loop
  // started, so only the FIRST attempt was actually re-validated;
  // retries 2 and 3 (up to ~2.5s later) reused the already-decided
  // envelope/signature without checking DNS again. The call must be
  // textually inside the loop body, immediately before sendWebhookRequest.
  const loopMatch = libJs.match(/for \(let attempt = 0;[\s\S]*?\n {2}\}\n\}/);
  assert.ok(loopMatch, 'expected to find the retry for-loop in webhooks.js');
  assert.match(loopMatch[0], /assertSafeUrl\(/, 'assertSafeUrl should be called inside the retry loop body');
  const assertIdx = loopMatch[0].indexOf('assertSafeUrl(');
  const sendIdx = loopMatch[0].indexOf('sendWebhookRequest(');
  assert.ok(assertIdx >= 0 && sendIdx >= 0 && assertIdx < sendIdx, 'assertSafeUrl should run immediately before sendWebhookRequest on each attempt');
});

test('the four known events are all registered with descriptions', () => {
  for (const event of ['meal.logged', 'water.logged', 'body_stat.logged', 'goal.achieved']) {
    assert.match(libJs, new RegExp(`'${event.replace('.', '\\.')}'`));
  }
});

test('delivery is signed with HMAC-SHA256 and carries event/delivery-id headers', () => {
  // Lives in webhook-delivery.js, the pure module split out specifically
  // so this logic (and scripts/webhook-delivery.test.js's real HTTP
  // behavioral tests against it) don't need a compiled better-sqlite3
  // binding the way the rest of webhooks.js does.
  assert.match(deliveryJs, /createHmac\('sha256'/);
  assert.match(deliveryJs, /X-NutriTrace-Signature/);
  assert.match(deliveryJs, /X-NutriTrace-Event/);
  assert.match(deliveryJs, /X-NutriTrace-Delivery/);
  assert.match(libJs, /import \{ signEnvelope, sendWebhookRequest \} from '\.\/webhook-delivery\.js'/);
});

test('delivery retries up to 3 attempts and never throws out of dispatchWebhookEvent', () => {
  assert.match(libJs, /MAX_ATTEMPTS\s*=\s*3/);
  assert.match(libJs, /export function dispatchWebhookEvent/);
});

test('a test-delivery endpoint exists so a webhook can be verified without waiting for a real event', () => {
  assert.match(routeJs, /router\.post\('\/:id\/test'/);
  assert.match(libJs, /export async function sendTestWebhook/);
});

test('diary.js dispatches meal.logged, water.logged, and body_stat.logged directly, and goal.achieved via the shared helper', () => {
  assert.match(diaryJs, /import \{ dispatchWebhookEvent \} from '\.\.\/lib\/webhooks\.js'/);
  assert.match(diaryJs, /dispatchWebhookEvent\(u, 'meal\.logged'/);
  assert.match(diaryJs, /dispatchWebhookEvent\(u, 'water\.logged'/);
  assert.match(diaryJs, /dispatchWebhookEvent\(u, 'body_stat\.logged'/);
  // goal.achieved itself is dispatched from inside checkNutritionGoalCrossing/
  // checkWaterGoalCrossing (server/lib/goal-webhook.js), not inline here.
  assert.match(diaryJs, /import \{ checkNutritionGoalCrossing, checkWaterGoalCrossing \} from '\.\.\/lib\/goal-webhook\.js'/);
  assert.match(diaryJs, /checkNutritionGoalCrossing\(/);
  assert.match(diaryJs, /checkWaterGoalCrossing\(/);
});

test('diary.js dispatch/goal-check calls are each guarded by a never-block-the-save catch', () => {
  const guardCatchCount = (diaryJs.match(/catch \(e\) \{ \/\* never let a webhook failure block the save \*\/ \}/g) || []).length;
  assert.equal(guardCatchCount, 4, 'expected exactly 4 never-block-the-save catch blocks in diary.js (one per event)');
  const dispatchCount = (diaryJs.match(/dispatchWebhookEvent\(/g) || []).length;
  assert.ok(dispatchCount >= 3, 'expected at least 3 direct dispatchWebhookEvent call sites in diary.js (meal/water/body_stat)');
});

test('goal-webhook.js rounds before/after totals the same way dailyTotalsCore does, so a value at a rounding boundary does not refire on every save', () => {
  const goalWebhookJs = readFileSync(new URL('../server/lib/goal-webhook.js', import.meta.url), 'utf8');
  assert.match(goalWebhookJs, /_round1\(before/);
  assert.match(goalWebhookJs, /_round1\(after/);
});

test('the MCP/REST write cores (log-food, log-water, log-meal, log-body-stat) also dispatch webhooks, not just the UI diary.js save path', () => {
  const logFoodJs = readFileSync(new URL('../server/lib/mcp/tools/log-food.js', import.meta.url), 'utf8');
  const logWaterJs = readFileSync(new URL('../server/lib/mcp/tools/log-water.js', import.meta.url), 'utf8');
  const logMealJs = readFileSync(new URL('../server/lib/mcp/tools/log-meal.js', import.meta.url), 'utf8');
  const logBodyStatJs = readFileSync(new URL('../server/lib/mcp/tools/log-body-stat.js', import.meta.url), 'utf8');

  assert.match(logFoodJs, /dispatchWebhookEvent\(userId, 'meal\.logged'/);
  assert.match(logFoodJs, /checkNutritionGoalCrossing\(/);
  assert.match(logWaterJs, /dispatchWebhookEvent\(userId, 'water\.logged'/);
  assert.match(logWaterJs, /checkWaterGoalCrossing\(/);
  assert.match(logMealJs, /dispatchWebhookEvent\(userId, 'meal\.logged'/);
  assert.match(logMealJs, /checkNutritionGoalCrossing\(/);
  assert.match(logBodyStatJs, /dispatchWebhookEvent\(userId, 'body_stat\.logged'/);
});

test('goal.achieved detection reads targets via getGoalsCore and totals via dailyTotalsCore, not a fresh query', () => {
  assert.match(diaryJs, /import \{ getGoalsCore \} from '\.\.\/lib\/mcp\/tools\/goals\.js'/);
  assert.match(diaryJs, /import \{ dailyTotalsCore \} from '\.\.\/lib\/mcp\/tools\/daily-totals\.js'/);
});
