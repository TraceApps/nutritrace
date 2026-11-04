/**
 * Trace's review cards showed up only now and then.
 *
 * Two things in the turn setup kept them away. On a text turn
 * propose_quick_calories was always taken out of the tools, so asking Trace
 * to estimate a food and log it could only ever produce text. And while a card
 * was still waiting on the user, propose_food went too, so no new card could
 * appear until they tapped the old one.
 *
 * Both card tools are now offered on every turn. What the strip was for, a
 * model calling the tool again for the card it already showed, is caught where
 * the card is made: the same card again (the one on screen, or the one the
 * user discarded) leaves everything as it was.
 *
 * Runs the turn setup and the card handlers from Trace.svelte itself.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { TOOLS } from '../src/lib/aiChat.js';
import * as cards from '../src/lib/trace-cards.js';

const trace = readFileSync(new URL('../src/components/ai/Trace.svelte', import.meta.url), 'utf8');

// The statement that picks the tools for a turn.
const toolsStmt = (() => {
  const i = trace.indexOf('const toolsForRound');
  return trace.slice(i, trace.indexOf(';\n', i) + 1);
})();

function toolsFor({ image = false, pending = null, pendingFood = null } = {}) {
  const ctx = {
    TOOLS, image, _coaching: {}, coachingTools: () => [],
    _pendingProposal: pending, _pendingFoodProposal: pendingFood,
    // dev computed this just before the statement
    _cardAwaitingUser: !!pending || !!pendingFood,
    ...cards,
  };
  // eslint-disable-next-line no-new-func
  return new Function('ctx', `with (ctx) { ${toolsStmt} return toolsForRound.map(t => t.name); }`)(ctx);
}

// A block of Trace.svelte from its opening line to the closing brace at the same indent.
function block(opening) {
  const i = trace.indexOf(opening);
  assert.ok(i >= 0, `${opening} is in Trace.svelte`);
  const indent = trace.slice(trace.lastIndexOf('\n', i) + 1, i);
  const end = trace.indexOf(`\n${indent}}\n`, i);
  return trace.slice(i + opening.length, end);
}

/** A Trace session: the card state, the propose handlers and the card buttons. */
function session() {
  const state = {
    DB: { getSetting: (_k, d) => d },
    NUTRIMENTS: ['calories', 'proteins', 'carbohydrates', 'fat', 'fiber'].map(id => ({ id })),
    localDateStr: () => '2026-10-17',
    _pendingProposal: null, _proposalCommitted: false, _proposalCommittedKcal: 0,
    _pendingFoodProposal: null, _foodProposalCommitted: false, _foodProposalCommittedKind: '', _foodProposalCommittedMealIdx: null,
    _answeredCard: null, _cardOffer: null, _turnCardOffer: null,
    // the diary and the server, stubbed; onSave runs while a save is in flight
    onSave: async () => {},
    addQuickCalories: async () => { await state.onSave(); },
    _saveProposedFood: async () => { await state.onSave(); return { id: 7 }; },
    showError: (m) => { state.errors.push(m); }, errors: [], $_: (k) => k,
    tick: async () => {}, _scrollBottom: () => {},
    ...cards,
  };
  const helper = (name) => trace.includes(`function ${name}(`) ? `function ${name}(${block(`function ${name}(`)}\n}` : '';
  const helpers = ['_pendingCardKey', '_replacedCard', '_showCard'].map(helper).join('\n');
  const run = (src) => new Function('ctx', `with (ctx) { ${helpers}\n return (async () => {${src}\n})(); }`);
  const quick = run(`const args = ctx.args; ${block("case 'propose_quick_calories': {")}`);
  const food = run(`const args = ctx.args; ${block("case 'propose_food': {")}`);
  const discard = run(block('function _discardProposal() {'));
  const discardFood = run(block('function _discardFoodProposal() {'));
  // Add to Diary, with the diary write stubbed out
  const commit = run(block('async function _commitProposal() {')
    .replace("const { addQuickCalories } = await import('../../stores/diary.js');", ''));
  const saveFood = run(block('async function _commitFoodCatalogOnly() {'));
  // what send() does with answered cards when the next message goes out
  const i = trace.indexOf('    if (_proposalCommitted)     {');
  const nextMessage = run(trace.slice(i, trace.indexOf('\n', trace.indexOf('\n', i) + 1)));
  // #309: the reply the turn's repeat hangs its button under, and the button
  const fn = (name) => trace.includes(`function ${name}(`) ? run(block(`function ${name}(`).replace(/^[^)]*\)\s*\{/, '')) : null;
  const attach = fn('_attachCardOffer');
  const again = fn('_showCardAgain');
  return {
    state,
    reply: (msg = { role: 'assistant', content: 'ok' }) => { assert.ok(attach, '_attachCardOffer is in Trace.svelte'); state.reply = msg; return attach(state).then(() => msg); },
    showAgain: () => { assert.ok(again, '_showCardAgain is in Trace.svelte'); return again(state); },
    saveFood: () => saveFood(state),
    nextMessage: () => nextMessage(state),
    quick: (args) => { state.args = args; return quick(state); },
    food: (args) => { state.args = args; return food(state); },
    discard: () => discard(state),
    discardFood: () => discardFood(state),
    commit: () => commit(state),
  };
}

const lasagna = { name: 'Homemade lasagna', meal: 1, serving_grams: 300, nutrition: { calories: 480, proteins: 28, carbohydrates: 40, fat: 22 } };
const banana = { name: 'Banana with peanut butter', meal: 3, nutrition: { calories: 290, proteins: 8, carbohydrates: 30, fat: 16 } };

test('a text turn offers both review cards', () => {
  const names = toolsFor();
  assert.ok(names.includes('propose_quick_calories'), 'a text estimate can get the Quick Calories card');
  assert.ok(names.includes('propose_food'));
  assert.ok(names.includes('log_quick_calories'), 'a number the user gave still logs straight away');
});

test('a card on screen does not take the card tools away', () => {
  const names = toolsFor({ pending: lasagna });
  assert.ok(names.includes('propose_quick_calories'));
  assert.ok(names.includes('propose_food'), 'a second food needs its own card');
  assert.ok(toolsFor({ pendingFood: banana }).includes('propose_quick_calories'));
});

test('a photo turn offers both cards and no bare-number write', () => {
  const names = toolsFor({ image: true });
  assert.ok(names.includes('propose_quick_calories'));
  assert.ok(names.includes('propose_food'));
  assert.ok(!names.includes('log_quick_calories'), 'a photo estimate reaches the diary only through a card');
});

test('a second, different food replaces the card on screen', async () => {
  const s = session();
  assert.equal((await s.quick(lasagna)).ok, true);
  const r = await s.quick(banana);
  assert.equal(r.ok, true);
  assert.equal(s.state._pendingProposal.name, 'Banana with peanut butter');
  // the other kind of card for the same food is a new card too ("save it as a food instead")
  assert.equal((await s.food(banana)).ok, true);
  assert.equal(s.state._pendingFoodProposal.name, 'Banana with peanut butter');
  assert.equal(s.state._pendingProposal, null);
});

test('the same card again leaves the one on screen as it is', async () => {
  const s = session();
  await s.quick(lasagna);
  s.state._pendingProposal.meal = 2; // the user picked Dinner on the card
  const r = await s.quick({ ...lasagna, name: '  homemade  Lasagna ' });
  assert.equal(r.ok, undefined, 'not reported as a new card');
  assert.equal(r.already_on_screen, true);
  assert.equal(s.state._pendingProposal.meal, 2, 'the meal the user picked is kept');
  // changed numbers are a new card
  assert.equal((await s.quick({ ...lasagna, nutrition: { ...lasagna.nutrition, calories: 960 } })).ok, true);
});

test('a discarded card does not come back on the next question', async () => {
  const s = session();
  await s.quick(lasagna);
  await s.discard();
  assert.equal(s.state._pendingProposal, null);
  assert.equal(s.state._answeredCard.action, 'discarded');
  const r = await s.quick(lasagna);
  assert.equal(r.already_answered, 'discarded');
  assert.equal(r.ok, undefined);
  assert.equal(s.state._pendingProposal, null, 'still gone');
  // a different food gets its card, and after that the old one may be asked for again
  assert.equal((await s.quick(banana)).ok, true);
  assert.equal(s.state._answeredCard, null);

  const f = session();
  await f.food(banana);
  await f.discardFood();
  assert.equal((await f.food(banana)).already_answered, 'discarded');
  assert.equal(f.state._pendingFoodProposal, null);
});

test('an added card does not come back either, and another serving can be asked for', async () => {
  const s = session();
  await s.quick(lasagna);
  await s.commit();
  assert.equal(s.state._proposalCommitted, true);
  assert.equal(s.state._answeredCard.action, 'added');
  await s.nextMessage(); // clears the "Logged" line
  assert.equal(s.state._pendingProposal, null);
  const r = await s.quick(lasagna);
  assert.equal(r.already_answered, 'added');
  assert.equal(s.state._pendingProposal, null);
  assert.equal((await s.quick({ ...lasagna, name: 'Homemade lasagna, 2nd slice' })).ok, true);
});

test('the system prompt tells the model about the card on screen', () => {
  assert.match(trace, /\+ \(cardLine \? `\\n\\nREVIEW CARD: \$\{cardLine\}` : ''\)/);
  const line = cards.cardContext({ pending: lasagna, pendingKind: 'quick' });
  assert.match(line, /"Homemade lasagna", 480 kcal/);
  assert.match(cards.cardContext({ answered: { name: 'Homemade lasagna', action: 'discarded' } }), /discarded/);
  assert.match(cards.cardContext({ answered: { name: 'X', action: 'added' } }), /added to their diary the last review card: "X"/);
  assert.equal(cards.cardContext({}), '');
});

test('a card that replaces a waiting one says which, so the model knows it is gone', async () => {
  const s = session();
  assert.equal((await s.quick(lasagna)).replaced, undefined);
  const r = await s.quick(banana); // e.g. a second call in the same Gemini answer
  assert.equal(r.ok, true);
  assert.equal(r.replaced, 'Homemade lasagna');
  assert.equal((await s.food(lasagna)).replaced, 'Banana with peanut butter');
});

test('a correction with the same calories is a new card', async () => {
  const s = session();
  await s.quick(lasagna);
  const yesterday = await s.quick({ ...lasagna, date: '2026-10-16' });
  assert.equal(yesterday.ok, true, 'another date');
  assert.equal(s.state._pendingProposal.date, '2026-10-16');
  assert.equal((await s.quick({ ...lasagna, date: '2026-10-16', nutrition: { ...lasagna.nutrition, proteins: 40 } })).ok, true, 'other protein');
  assert.equal((await s.quick({ ...lasagna, date: '2026-10-16', nutrition: { ...lasagna.nutrition, proteins: 40 }, meal: 0 })).already_on_screen, true,
    'the meal alone is picked on the card');
});

test('a card that arrives while the last one saves is not marked as saved', async () => {
  const s = session();
  await s.food(banana);
  s.state.onSave = async () => { await s.quick(lasagna); };
  await s.saveFood();
  assert.deepEqual(s.state.errors, [], 'no false "save failed"');
  assert.equal(s.state._foodProposalCommitted, false);
  assert.equal(s.state._pendingProposal.name, 'Homemade lasagna', 'the new card stays reviewable');
  assert.equal(s.state._answeredCard.name, 'Banana with peanut butter');

  const q = session();
  await q.quick(lasagna);
  q.state.onSave = async () => { await q.quick(banana); };
  await q.commit();
  assert.equal(q.state._proposalCommitted, false, 'the banana card was not logged');
  assert.equal(q.state._pendingProposal.name, 'Banana with peanut butter');
});

test('the routing keeps search first and sends estimates to a card', () => {
  const prompt = trace.slice(trace.indexOf('LOGGING A REAL FOOD'), trace.indexOf('CRITICAL RULES for propose_quick_calories'));
  assert.match(prompt, /REVIEW CARDS \(text or photo\)/);
  assert.match(prompt, /A named food the user just wants logged, without asking you to estimate, goes to log_food first/);
  assert.match(prompt, /no_match\\`, nothing was found\. Say so in one sentence and offer to estimate it on a review card.*If they want your estimate, call propose_food\./);
  assert.match(prompt, /MANUAL ESTIMATE PATH: .*skip log_food and use propose_food instead/, '#163 keeps the full-nutrition card');
  assert.match(prompt, /log_quick_calories is ONLY for kcal-number asks/);
  assert.match(prompt, /The kcal \(and any macros\) must be numbers the user gave you\. Never pass a number you estimated/);
  assert.match(prompt, /1\. INFO ONLY .*do NOT call any propose_\* or log_\* tool/);
  assert.match(prompt, /If propose_quick_calories says Quick Calories is turned off, use propose_food instead/);
  assert.match(prompt, /put them on one card with a combined name and totals/);
  const desc = (n) => TOOLS.find(t => t.name === n).description;
  assert.match(desc('log_quick_calories'), /NEVER pass a number you estimated/);
  assert.match(desc('propose_quick_calories'), /with or without a photo, when the user asks for quick calories/);
  assert.match(desc('propose_quick_calories'), /log_food searches first/);
  assert.match(desc('propose_food'), /manual-estimate bypass for log_food/);
  assert.match(desc('log_food'), /offer to estimate it on a review card \(propose_food\)/);
});

// #292: "save it" typed while a card is pending gets the button to tap, not a
// vague answer or a claim that it was saved.
test('a pending card tells the model only its buttons save it', async () => {
  for (const [kind, button] of [['food', /Save to Foods or Save & Add to Diary/], ['quick', /Add to Diary/]]) {
    const line = cards.cardContext({ pending: lasagna, pendingKind: kind });
    assert.match(line, /Only the buttons on the card save it: you cannot/);
    assert.match(line, button);
    assert.match(line, /never say it was saved or added/);
  }
  const s = session();
  await s.food(banana);
  const r = await s.food(banana);
  assert.equal(r.already_on_screen, true);
  assert.match(r.message, /tell them to tap Save to Foods/);
  assert.match(r.message, /never say it was saved or added/);
});

// #309: an answered card asked for again was refused with nothing on screen,
// and the only way back the model was given (change the amount or the name)
// put wrong numbers on the card or never happened at all.
test('a discarded food card comes back with Show Card Again, and saves', async () => {
  const s = session();
  await s.food(banana);
  await s.discardFood();
  const r = await s.food(banana); // "give me the card again"
  assert.equal(r.already_answered, 'discarded');
  assert.equal(s.state._pendingFoodProposal, null, 'not on screen by itself (#292)');
  const msg = await s.reply();
  assert.equal(s.state._cardOffer.msg, msg, 'the button sits under this reply');
  assert.equal(s.state._cardOffer.kind, 'food');
  await s.showAgain();
  assert.equal(s.state._pendingFoodProposal.name, 'Banana with peanut butter');
  assert.deepEqual(s.state._pendingFoodProposal.nutrition, banana.nutrition, 'the same numbers, nothing changed');
  assert.equal(s.state._foodProposalCommitted, false);
  assert.equal(s.state._foodProposalCommittedMealIdx, null, 'starts at Don\'t Log, like any new card');
  assert.equal(s.state._answeredCard, null, 'cleared as a new card would');
  assert.equal(s.state._cardOffer, null, 'the button is used up');
  await s.saveFood();
  assert.equal(s.state._foodProposalCommitted, true);
  assert.equal(s.state._answeredCard.action, 'saved');
});

test('an added Quick Calories card comes back for another serving', async () => {
  const s = session();
  await s.quick(lasagna);
  await s.commit();
  await s.nextMessage();
  assert.equal((await s.quick(lasagna)).already_answered, 'added');
  await s.reply();
  assert.equal(s.state._cardOffer.kind, 'quick');
  await s.showAgain();
  assert.equal(s.state._pendingProposal.name, 'Homemade lasagna');
  assert.equal(s.state._proposalCommitted, false);
  assert.equal(s.state._pendingFoodProposal, null);
  await s.commit();
  assert.equal(s.state._proposalCommitted, true, 'Add to Diary works on it');
});

test('the model hears the card was not shown and where the button is', async () => {
  for (const kind of ['food', 'quick']) {
    for (const action of ['discarded', 'saved', 'added']) {
      const m = cards.repeatedCardResult(action, kind).message;
      assert.match(m, /was not shown/);
      assert.match(m, /Show Card Again button for it is under your reply, unless you show another card/);
      assert.match(m, /Never say this card was created, shown, saved or added/);
      assert.doesNotMatch(m, /amount or the name/, 'no advice to change the card to get it back');
      // another serving of a saved food is logged, not saved as a second food
      assert.equal(/log it with log_food/.test(m), kind === 'food' && action !== 'discarded', `${kind} ${action}`);
    }
  }
  assert.match(trace, /return repeatedCardResult\(repeat, 'quick'\);/);
  assert.match(trace, /return repeatedCardResult\(repeat, 'food'\);/);
});

test('a card still on screen gets no Show Card Again button', async () => {
  const s = session();
  await s.food(banana);
  assert.equal((await s.food(banana)).already_on_screen, true);
  await s.reply();
  assert.equal(s.state._cardOffer, null);
});

test('#292 still holds: an accidental repeat brings back no card, and another card retires the button', async () => {
  const s = session();
  await s.food(banana);
  await s.discardFood();
  // an unrelated question, and the model calls the tool again anyway
  assert.equal((await s.food(banana)).already_answered, 'discarded');
  await s.reply();
  assert.equal(s.state._pendingFoodProposal, null);
  assert.equal(s.state._pendingProposal, null);
  // a newer repeat moves the button to the newest reply: one at a time
  await s.food(banana);
  const second = await s.reply({ role: 'assistant', content: 'second' });
  assert.equal(s.state._cardOffer.msg, second);
  // a different card shown retires it, so it can't bring back an outdated card
  assert.equal((await s.quick(lasagna)).ok, true);
  assert.equal(s.state._cardOffer, null);
  // and a turn that shows a card after a repeat leaves no button behind
  await s.discard();
  await s.food(lasagna);
  await s.quick(lasagna); // repeat of the discarded quick card
  await s.food(banana); // then a new card in the same answer
  await s.reply();
  assert.equal(s.state._cardOffer, null);
  assert.equal(s.state._pendingFoodProposal.name, 'Banana with peanut butter');
});

test('the button lives only on the reply on screen, never in the saved chat', () => {
  const en = JSON.parse(readFileSync(new URL('../src/i18n/en.json', import.meta.url), 'utf8'));
  assert.equal(en.trace.show_card_again, 'Show Card Again');
  assert.match(trace, /\{#if _cardOffer && _cardOffer\.msg === msg\}/);
  assert.match(trace, /\$_\('trace\.show_card_again'\)/);
  // a transcript loaded again from the server drops it, and so does Clear
  const refetch = block('async function _refetchChatHistory(e) {');
  assert.match(refetch, /messages = next;\s*_cardOffer = null;/);
  assert.match(block('async function clearChat() {'), /_cardOffer = null;/);
  // a turn that errors leaves nothing for the next reply to pick up
  assert.match(block('async function send() {'), /loading {2}= true;\s*_turnCardOffer = null;/);
  // nothing about it is posted to the history
  assert.doesNotMatch(trace, /api\/ai\/history', \{[^}]*_cardOffer/);
});
