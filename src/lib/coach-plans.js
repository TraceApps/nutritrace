/**
 * coach-plans.js: a coach's day plan, what each item is and how it is logged.
 *
 * Shared by the server (it checks what a coach sends) and the app (the
 * builder, the client's card, logging). No imports: the server's Docker
 * image copies this one file.
 *
 * A day plan is a recommendation of kind 'day_plan' for one date. Its payload:
 *   { meals: [{ meal, items: [item, ...] }, ...] }
 * `meal` is the slot in the client's own meal names (0 = their first meal).
 * Each item is a copy, so a later edit of where it came from never changes a
 * plan already sent:
 *   { name, brand, portion, unit, quantity, nutrition, barcode, source }
 * `nutrition` is for one `portion` (as on a food); `quantity` is how many.
 * `source` says where it came from: { kind, id }, kind one of
 *   client_food, client_recipe (the client's own, by its id),
 *   coach_food, coach_recipe (the coach's, by its id),
 *   off (Open Food Facts, by its barcode).
 *
 * Logged, an item is an ordinary diary item, made the way the Foods page
 * makes one (planDiaryItem), with `source` = 'coach:plan:<id>:<meal>.<n>'
 * (the provenance field MCP's log tools use too): the plan, and which of its
 * items. That is how each item, and so each meal, is known to be logged;
 * deleting it from the Diary brings Log This back for the rest.
 */

export const PLAN_SOURCES = ['client_food', 'client_recipe', 'coach_food', 'coach_recipe', 'off'];
export const PLAN_LIMITS = { meals: 12, itemsPerMeal: 30, items: 120, dates: 31 };
const NAME_MAX = 200, UNIT_MAX = 20;
const NUTRIENT_KEY = /^[a-z][a-z0-9_-]{0,39}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const BARCODE_RE = /^[0-9]{4,20}$/;

const num = (v) => (typeof v === 'number' ? v : typeof v === 'string' && /^\s*\d+(\.\d+)?\s*$/.test(v) ? Number(v) : NaN);
const text = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

export const isPlanDate = (d) => typeof d === 'string' && DATE_RE.test(d) && !Number.isNaN(Date.parse(d + 'T00:00:00Z'));

function _cleanItem(it) {
  if (!it || typeof it !== 'object') return { error: 'A plan item is missing.', code: 'plan_item_missing' };
  const name = text(it.name, NAME_MAX);
  if (!name) return { error: 'Every item needs a name.', code: 'plan_item_name' };
  const portion = num(it.portion), quantity = num(it.quantity ?? 1);
  if (!(Number.isFinite(portion) && portion > 0 && portion <= 100000)) return { error: `"${name}" needs an amount.`, code: 'plan_item_amount', params: { name } };
  if (!(Number.isFinite(quantity) && quantity > 0 && quantity <= 100)) return { error: `"${name}" needs a number of servings.`, code: 'plan_item_servings', params: { name } };
  const unit = text(it.unit, UNIT_MAX) || 'g';
  const n = it.nutrition && typeof it.nutrition === 'object' && !Array.isArray(it.nutrition) ? it.nutrition : null;
  if (!n) return { error: `"${name}" needs its nutrition.`, code: 'plan_item_nutrition', params: { name } };
  const nutrition = {};
  for (const [k, v] of Object.entries(n)) {
    if (k === '_derived' || v === null || v === undefined || v === '') continue;
    const x = num(v);
    if (!NUTRIENT_KEY.test(k) || !Number.isFinite(x) || x < 0 || x > 100000) return { error: `"${name}" has a nutrition value out of range.`, code: 'plan_item_nutrition_range', params: { name } };
    nutrition[k] = x;
    if (Object.keys(nutrition).length > 80) return { error: `"${name}" has too many nutrition values.`, code: 'plan_item_nutrition_many', params: { name } };
  }
  const src = it.source && typeof it.source === 'object' ? it.source : {};
  if (!PLAN_SOURCES.includes(src.kind)) return { error: `"${name}" needs to say where it came from.`, code: 'plan_item_source', params: { name } };
  const barcode = it.barcode == null || it.barcode === '' ? null : String(it.barcode).trim();
  if (barcode !== null && !BARCODE_RE.test(barcode)) return { error: `"${name}" has a barcode that isn't one.`, code: 'plan_item_barcode', params: { name } };
  const source = { kind: src.kind };
  if (src.kind === 'off') {
    if (!barcode) return { error: `"${name}" needs its barcode.`, code: 'plan_item_needs_barcode', params: { name } };
  } else {
    const id = num(src.id);
    if (!(Number.isInteger(id) && id > 0)) return { error: `"${name}" needs to say where it came from.`, code: 'plan_item_source', params: { name } };
    source.id = id;
  }
  const brand = text(it.brand, NAME_MAX);
  return { item: { name, brand: brand || null, portion, unit, quantity, nutrition, barcode, source } };
}

/**
 * Check and tidy a plan from a coach. Returns { payload } or { error }.
 * Empty meals are left out; a plan needs at least one item.
 */
export function cleanPlanPayload(input) {
  const src = input && typeof input === 'object' ? input : {};
  if (!Array.isArray(src.meals)) return { error: 'A plan needs its meals.', code: 'plan_meals_missing' };
  const bySlot = new Map();
  let total = 0;
  for (const m of src.meals) {
    if (!m || typeof m !== 'object') return { error: 'A plan meal is missing.', code: 'plan_meal_missing' };
    const slot = num(m.meal);
    if (!(Number.isInteger(slot) && slot >= 0 && slot < PLAN_LIMITS.meals)) return { error: 'A plan meal is not one of the meals.', code: 'plan_meal_unknown' };
    if (bySlot.has(slot)) return { error: 'A meal is in the plan twice.', code: 'plan_meal_twice' };
    const items = Array.isArray(m.items) ? m.items : [];
    if (items.length > PLAN_LIMITS.itemsPerMeal) return { error: `A meal can hold up to ${PLAN_LIMITS.itemsPerMeal} items.`, code: 'plan_meal_too_many', params: { max: PLAN_LIMITS.itemsPerMeal } };
    const clean = [];
    for (const it of items) {
      const r = _cleanItem(it);
      if (r.error) return r;
      clean.push(r.item);
    }
    total += clean.length;
    if (clean.length) bySlot.set(slot, clean);
  }
  if (!total) return { error: 'Add something to the plan first.', code: 'plan_empty' };
  if (total > PLAN_LIMITS.items) return { error: `A plan can hold up to ${PLAN_LIMITS.items} items.`, code: 'plan_too_many', params: { max: PLAN_LIMITS.items } };
  return { payload: { meals: [...bySlot.entries()].sort((a, b) => a[0] - b[0]).map(([meal, items]) => ({ meal, items })) } };
}

/** The dates a plan goes to: one, or several (Copy to Other Days). */
export function cleanPlanDates(body) {
  const list = Array.isArray(body?.dates) ? body.dates : [body?.date];
  const dates = [...new Set(list.map(d => String(d ?? '')))];
  if (!dates.length || !dates.every(isPlanDate)) return { error: 'A plan needs a date.', code: 'plan_date_missing' };
  if (dates.length > PLAN_LIMITS.dates) return { error: `A plan can go to up to ${PLAN_LIMITS.dates} days at once.`, code: 'plan_too_many_dates', params: { max: PLAN_LIMITS.dates } };
  return { dates: dates.sort() };
}

const MACROS = ['calories', 'proteins', 'carbohydrates', 'fat'];

/** One item's calories and macros (its nutrition times its servings). */
export function itemTotals(item) {
  const q = Number(item?.quantity) || 1;
  const n = item?.nutrition || {};
  return Object.fromEntries(MACROS.map(k => [k, (Number(n[k]) || 0) * q]));
}
const _sum = (list) => list.reduce((t, x) => { for (const k of MACROS) t[k] += x[k]; return t; }, Object.fromEntries(MACROS.map(k => [k, 0])));
export const mealTotals = (meal) => _sum((meal?.items || []).map(itemTotals));
export const planTotals = (payload) => _sum((payload?.meals || []).map(mealTotals));

/** A logged item's provenance: this plan, and which of its items. */
export const planMark = (id, slot, index) => `coach:plan:${id}:${slot}.${index}`;
export const itemKey = (slot, index) => `${slot}.${index}`;

/** The plan's items logged on its day ("<meal>.<n>"), from that day's diary items. */
export function loggedItems(diaryItems, planId) {
  const prefix = `coach:plan:${planId}:`;
  const out = new Set();
  for (const it of diaryItems || []) {
    if (it && typeof it.source === 'string' && it.source.startsWith(prefix)) out.add(it.source.slice(prefix.length));
  }
  return out;
}

/** The plan's meals with every item logged. */
export function loggedMeals(diaryItems, rec) {
  const items = loggedItems(diaryItems, rec?.id);
  const out = new Set();
  for (const m of rec?.payload?.meals || []) {
    if (m.items?.length && m.items.every((_, i) => items.has(itemKey(m.meal, i)))) out.add(m.meal);
  }
  return out;
}

/**
 * What a recommendation shows: a day plan still waiting past its date is
 * Expired (worked out from the date; nothing changes it on the server).
 * `today` is the viewer's own date (YYYY-MM-DD).
 */
export function shownStatus(rec, today) {
  if (rec?.kind === 'day_plan' && rec.status === 'pending' && rec.date && today && rec.date < today) return 'expired';
  return rec?.status;
}

/** A food's server id, on the web (its id) and on Android (server_id). */
export const serverIdOf = (f) => (f && 'server_id' in f ? f.server_id : (typeof f?.id === 'number' ? f.id : null));
/**
 * A saved meal's ingredient's food, by its server id: food_server_id, else
 * the food row's own (a meal saved on Android keeps the phone's id in `id`
 * and the server's in `server_id`).
 */
export const ingredientFoodId = (ing) => ing?.food_server_id ?? serverIdOf(ing);

/**
 * How a copy made from a plan remembers where it came from: a coach's food
 * or recipe, or one of the client's own that they deleted since (copied
 * once, then found again by this).
 */
export function coachSource(item) {
  const s = item?.source;
  if (s?.kind === 'coach_food') return { source_app: 'coach', source_external_id: `food:${s.id}` };
  if (s?.kind === 'coach_recipe') return { source_app: 'coach', source_external_id: `recipe:${s.id}` };
  if (s?.kind === 'client_food') return { source_app: 'coach', source_external_id: `own-food:${s.id}` };
  if (s?.kind === 'client_recipe') return { source_app: 'coach', source_external_id: `own-recipe:${s.id}` };
  return null;
}

/**
 * The client's own food or recipe for a plan item, if they have it: their
 * own by id, a copy of the coach's made before, or one with its barcode.
 */
export function findOwn(item, { foods = [], recipes = [] } = {}) {
  const s = item?.source || {};
  if (s.kind === 'client_food') { const f = foods.find(x => serverIdOf(x) === s.id); if (f) return f; }
  if (s.kind === 'client_recipe') { const r = recipes.find(x => serverIdOf(x) === s.id); if (r) return r; }
  const cs = coachSource(item);
  if (cs) {
    const f = foods.find(x => x.source_app === cs.source_app && x.source_external_id === cs.source_external_id && !x.deleted_at);
    if (f) return f;
  }
  if (item?.barcode) { const f = foods.find(x => x.barcode && String(x.barcode) === String(item.barcode) && !x.deleted_at); if (f) return f; }
  return null;
}

/** A new food for the client's catalog from a plan item they don't have. */
export function foodFromPlanItem(item) {
  return {
    name: item.name,
    brand: item.brand || null,
    portion: item.portion,
    unit: item.unit || 'g',
    nutrition: { ...(item.nutrition || {}) },
    barcode: item.barcode || null,
    ...(coachSource(item) || {}),
  };
}

/**
 * The diary item for a plan item, made as the Foods page makes one when
 * adding a food (the food, at the plan's amount and nutrition), marked with
 * the plan it came from. addDiaryItem gives it its uuid, meal and time.
 */
export function planDiaryItem(item, food, planId, slot, index) {
  return {
    ...food,
    portion: item.portion,
    unit: item.unit || 'g',
    quantity: item.quantity || 1,
    nutrition: { ...(item.nutrition || {}) },
    source: planMark(planId, slot, index),
  };
}

/** A plan item from a food, a recipe or an Open Food Facts product. */
export function planItemFrom(food, kind) {
  const id = kind === 'off' ? undefined : serverIdOf(food);
  return {
    name: String(food?.name || '').slice(0, NAME_MAX),
    brand: food?.brand || null,
    portion: Number(food?.portion) || 100,
    unit: food?.unit || 'g',
    quantity: 1,
    nutrition: Object.fromEntries(Object.entries(food?.nutrition || {}).filter(([k, v]) => k !== '_derived' && Number.isFinite(Number(v)) && v !== '' && v !== null).map(([k, v]) => [k, Number(v)])),
    barcode: food?.barcode && BARCODE_RE.test(String(food.barcode)) ? String(food.barcode) : null,
    source: kind === 'off' ? { kind } : { kind, id },
  };
}

/**
 * A saved meal's ingredients as plan items (as the Diary adds a meal: each
 * ingredient on its own). `whose` is 'client' or 'coach'.
 */
export function planItemsFromMeal(meal, whose) {
  return (meal?.items || []).map(ing => {
    const id = Number(ingredientFoodId(ing));
    const known = Number.isInteger(id) && id > 0;
    // An ingredient with no food behind it any more: by its barcode, if any.
    const kind = known ? (whose === 'coach' ? 'coach_food' : 'client_food') : 'off';
    const base = planItemFrom({ ...ing, id: known ? id : null }, kind);
    return { ...base, quantity: Number(ing.quantity) || 1 };
  }).filter(it => it.source.kind !== 'off' || it.barcode);
}
