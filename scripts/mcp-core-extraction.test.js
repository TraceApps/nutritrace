/**
 * Static-analysis test guarding the MCP core-extraction refactor (issue
 * "webhooks + general REST API" Part 0). A narrow subset of MCP tools
 * had their query/write logic pulled into a standalone exported `xCore`
 * function so the new public REST API and the webhook detection logic
 * can call the exact same implementation instead of duplicating it.
 * This only checks the export exists in source text, no db.js import,
 * so it runs without a compiled better-sqlite3 native binding.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const TOOLS_DIR = new URL('../server/lib/mcp/tools/', import.meta.url);

const EXPECTED_CORE_EXPORTS = {
  'list-diary.js':        'listDiaryCore',
  'daily-totals.js':      'dailyTotalsCore',
  'goals.js':             'getGoalsCore',
  'search-meals.js':      'searchMealsCore',
  'recent-meals.js':      'recentMealsCore',
  'get-meal-details.js':  'getMealDetailsCore',
  'log-food.js':          'logFoodCore',
  'log-water.js':         'logWaterCore',
  'log-meal.js':          'logMealCore',
  'log-body-stat.js':     'logBodyStatCore',
};

for (const [file, exportName] of Object.entries(EXPECTED_CORE_EXPORTS)) {
  test(`${file} exports ${exportName}`, () => {
    const src = readFileSync(new URL(file, TOOLS_DIR), 'utf8');
    assert.match(src, new RegExp(`export function ${exportName}\\(`));
    assert.match(src, new RegExp(exportName + '\\('), `register wrapper in ${file} should call ${exportName}`);
  });
}

const NOT_EXTRACTED = ['create-food.js', 'delete-diary-entry.js', 'edit-diary-entry.js', 'search-foods.js', 'recent-foods.js'];

for (const file of NOT_EXTRACTED) {
  test(`${file} is intentionally NOT extracted (destroy-tier, or redundant with an existing federation route)`, () => {
    const src = readFileSync(new URL(file, TOOLS_DIR), 'utf8');
    assert.doesNotMatch(src, /export function \w+Core\(/);
  });
}
