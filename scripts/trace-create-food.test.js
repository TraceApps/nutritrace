/**
 * Trace could not create a food without also writing a diary entry.
 *
 * propose_food is the only tool that creates a food row, and its card is the
 * only place "Save to Foods" exists. It was stripped from the schema on every
 * text-only turn, so "create a food called X, don't log it" left the model
 * with log_food as the nearest match, and the user got the diary entry they
 * had just refused.
 *
 * The strip existed for a real reason: a mini model that saw a propose_* call
 * in chat history re-called it on the next text question and the card looked
 * like it kept coming back. That case is now the only one it covers.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { TOOLS } from '../src/lib/aiChat.js';

const trace = readFileSync(new URL('../src/components/ai/Trace.svelte', import.meta.url), 'utf8');
const toolFilter = trace.slice(trace.indexOf('const _cardAwaitingUser'), trace.indexOf('const reply = aiEnvLocked'));
const desc = (name) => TOOLS.find(t => t.name === name).description;

test('propose_food is still the only tool that creates a food', () => {
  const creators = TOOLS.filter(t => /create|save/i.test(t.description) && /food/i.test(t.name));
  assert.ok(creators.some(t => t.name === 'propose_food'));
  // log_food and log_quick_calories both write to the diary; neither is a
  // catalogue-only path, so removing propose_food leaves no way to create one.
  assert.equal(TOOLS.filter(t => t.name === 'propose_food').length, 1);
});

test('a text-only turn keeps propose_food in the schema', () => {
  assert.match(toolFilter, /t\.name !== 'propose_quick_calories'/, 'the photo estimate path still goes');
  assert.doesNotMatch(toolFilter, /t\.name !== 'propose_food'/,
    'propose_food must not be stripped unconditionally on a text turn');
});

test('propose_food is stripped only while a card is waiting on the user', () => {
  assert.match(toolFilter, /const _cardAwaitingUser = !!_pendingProposal \|\| !!_pendingFoodProposal;/);
  assert.match(toolFilter, /!\(t\.name === 'propose_food' && _cardAwaitingUser\)/);
});

test('a photo turn still loses the silent-write tool', () => {
  assert.match(toolFilter, /image\s*\?\s*TOOLS\.filter\(t => t\.name !== 'log_quick_calories'\)/);
});

test('log_food tells the model to stay out of save-only asks', () => {
  const d = desc('log_food');
  assert.match(d, /DO NOT CALL THIS TOOL when the user wants a food SAVED rather than LOGGED/);
  assert.match(d, /Use propose_food instead/);
});

test('propose_food says it is the food-creating tool, photo or not', () => {
  const d = desc('propose_food');
  assert.match(d, /ONLY tool that can create a food, and it works with or without a photo/);
  assert.match(d, /Save to Foods/);
});

test('the system prompt routes a no-photo "create a food" ask to propose_food', () => {
  assert.match(trace, /CREATING A FOOD WITHOUT LOGGING IT \(no photo\)/);
  const section = trace.slice(trace.indexOf('CREATING A FOOD WITHOUT LOGGING IT'));
  const body = section.slice(0, section.indexOf('PHOTO MEAL HANDLING'));
  assert.match(body, /call propose_food/);
  assert.match(body, /Do NOT call log_food afterwards/,
    'the refusal case is the one that went wrong, so it is spelled out');
});

test('the catalogue-only commit path does not touch the diary', () => {
  const fn = trace.slice(trace.indexOf('async function _commitFoodCatalogOnly'));
  const body = fn.slice(0, fn.indexOf('\n  }\n'));
  assert.doesNotMatch(body, /addDiaryItem/, 'Save to Foods writes the food row and nothing else');
  assert.match(body, /_saveProposedFood\(\)/);
});
