// Trace's review cards (propose_quick_calories, propose_food): which tools a
// turn offers, and when a proposal is a card the user already has.

/**
 * The tools Trace offers for one turn. Both review-card tools are offered on
 * every turn, text or photo, because neither writes anything: the user taps
 * Add to Diary or Save to Foods. A photo turn leaves out log_quick_calories,
 * the one write tool that takes a bare number, so an estimate from a photo
 * can only reach the diary through a card.
 */
export function traceToolsForTurn(tools, { image = false } = {}) {
  return image ? tools.filter(t => t.name !== 'log_quick_calories') : [...tools];
}

const _name = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();

const _num = (v) => Math.round(Number(v) || 0);

/**
 * What makes two proposals the same card: the tool, the name, the calories
 * and macros, and the serving and date (a Quick Calories card) or the
 * portion, unit and brand (a food card). The meal isn't in it: the user picks
 * that on the card.
 */
export function cardKey(kind, payload) {
  const n = payload?.nutrition || {};
  const numbers = [n.calories, n.proteins, n.carbohydrates, n.fat].map(_num).join('/');
  const basis = kind === 'food'
    ? `${_num(payload?.portion)}${_name(payload?.unit)}|${_name(payload?.brand)}`
    : `${_num(payload?.serving_grams)}g|${payload?.date || ''}`;
  return `${kind}|${_name(payload?.name)}|${numbers}|${basis}`;
}

/**
 * Whether a proposal repeats a card the user already has: the one on screen,
 * or the last one they answered (added, saved or discarded) until another
 * card is shown. A model that sees its earlier card in the chat can call the
 * tool again on an unrelated question; without this, the card the user is
 * reviewing would reset, and one they already dealt with would come back.
 * A different food, other calories, or the other kind of card is a new card.
 * Returns 'pending', the answered card's action, or ''.
 */
export function repeatedCard(key, { pendingKey = '', answered = null } = {}) {
  if (pendingKey && key === pendingKey) return 'pending';
  if (answered?.key && key === answered.key) return answered.action;
  return '';
}

const _done = (action) => action === 'discarded' ? 'discarded' : action === 'saved' ? 'saved to their Foods' : 'added to their diary';

/** What the model hears back when its proposal repeats a card. */
export function repeatedCardResult(repeat) {
  if (repeat === 'pending') {
    return { already_on_screen: true, message: 'This exact card is already on screen, waiting for the user. Nothing changed. Do not mention it again unless the user asks about it; answer their latest message. The user can change the meal on the card.' };
  }
  return {
    already_answered: repeat,
    message: `The user already ${_done(repeat)} this exact card, so it was not shown again. Do not mention it unless the user asks; answer their latest message. If their latest message asks for it again (another serving, or the card back), propose it with the amount or the name changed to say so.`,
  };
}

/**
 * One line for the system prompt about the card on screen, or the last one
 * the user answered, so the model knows what the user did with it.
 */
export function cardContext({ pending = null, pendingKind = '', answered = null } = {}) {
  if (pending) {
    const what = pendingKind === 'food' ? 'food card (Save to Foods / Save & Add to Diary)' : 'Quick Calories card (Add to Diary)';
    return `A review card is on screen: "${pending.name}", ${Math.round(Number(pending.nutrition?.calories) || 0)} kcal, ${what}, waiting for the user. Do not propose it again. A different food or changed numbers get a new card, which replaces this one.`;
  }
  if (answered) {
    return `The user ${_done(answered.action)} the last review card: "${answered.name}". Do not propose it again unless they ask for it.`;
  }
  return '';
}
