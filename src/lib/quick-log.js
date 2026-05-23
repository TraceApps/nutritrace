/**
 * quick-log.js — natural language food logging.
 *
 * Pipeline:
 *   1. parseInput(text)         → AI parses input into [{name, quantity, unit}, ...]
 *   2. matchItems(parsedItems)  → for each item, search local DB → OFF → AI estimate
 *   3. (user reviews + edits in confirmation modal)
 *   4. saveItems(matchedItems, mealSlot) → writes to diary
 *
 * Uses the same AI provider configured for the AI Assistant. Setting `quickLogEnabled`
 * gates the feature; `aiEnabled` + a valid `aiApiKey` are required.
 */

import { get } from 'svelte/store';
import { DB } from './db.js';
import { API, NtApi } from './api.js';
import { callAI, callAIProxy } from './aiChat.js';
import { envLocks } from '../stores/settings.js';

// ── Step 1: AI parses the input string into structured items ──────────────

/**
 * Build the parser prompt dynamically with the user's actual meal names so
 * the AI can target custom slots like "Pre-workout", "Snack 1", "Late Snack",
 * not just the default Breakfast/Lunch/Dinner/Snacks.
 */
function _buildParsePrompt(userMealNames, waterContainers) {
  const names = Array.isArray(userMealNames) && userMealNames.length > 0
    ? userMealNames
    : ['Breakfast', 'Lunch', 'Dinner', 'Snacks'];
  const namesQuoted = names.map(n => '"' + n + '"').join(', ');

  // Build container hint — include user's custom container names so the AI
  // can match "my protein shaker" → the right container name.
  const containerHint = Array.isArray(waterContainers) && waterContainers.length > 0
    ? `\nThe user's water containers are: ${waterContainers.map(c => `"${c.name}" (${c.volumeMl}ml)`).join(', ')}.`
    : '';

  return `You are a food and water parser for a nutrition tracking app. Extract food/water items AND the target meal from the user's input and return them as JSON.

The user's configured meal slots are: [${namesQuoted}]${containerHint}

Rules:
- Return ONLY valid JSON, no commentary, no markdown fences.
- Top-level shape: { "meal": <slot name from the list above, or null>, "items": [ ... ] }
- Each item has: name (string), quantity (number, default 1), unit (string or null), kind ("food" | "meal" | "recipe" | "yesterday" | "water").

ITEM KIND — figure out what the user is referring to:
- "food" (default): a single food, ingredient, or branded product. e.g. "2 eggs", "a slice of toast", "Greek yogurt"
- "meal": the user references a SAVED MEAL by name. Trigger phrases include "my X meal", "the meal called X", "my saved X", "X meal", "for breakfast I had my morning bowl meal".
- "recipe": the user references a SAVED RECIPE by name. Trigger phrases include "my X recipe", "the recipe X", "from my X recipe", "recipe called X".
- "yesterday": the user wants to repeat something from yesterday's diary. Trigger phrases include "same as yesterday", "yesterday's lunch", "what I had for breakfast yesterday", "repeat yesterday's dinner". For these items, set "name" to the meal slot from yesterday they want to repeat (e.g. "Lunch", "Breakfast"), quantity 1, unit null.
- "water": the user drank water or a beverage that counts as water intake. Trigger words: "water", "drank", "glass of water", "bottle of water", or a container name from the list above. Set "name" to the container name if one matches (e.g. "protein shaker"), otherwise set name to the unit word (e.g. "glass", "bottle"). Set "quantity" to the number of containers/glasses and "unit" to "ml", "oz", "L", or the container name.

Other rules:
- Use common units: "slice", "cup", "tbsp", "tsp", "oz", "g", "ml", "piece", "bowl", "can", "bottle".
- If no unit is specified for a countable item (eggs, bananas, apples), set unit to null.
- Words like "a", "an", "one" mean quantity 1. "couple" or "few" means 2. "some" means 1.
- Split compound items: "eggs and toast" → two items.
- The meal slot field at the top level is INDEPENDENT from the item kind. e.g. "for breakfast I had my chicken stir fry recipe" → meal="Breakfast", items=[{kind:"recipe", name:"chicken stir fry"}].
- For the meal field:
  * Match the user's input to one of their configured meal slots EXACTLY as written above (preserve case).
  * Use common sense: "this morning" / "for breakfast" → the breakfast-like slot. "tonight" / "for dinner" → the dinner-like slot. "as a snack" → the closest snack slot.
  * If the user has numbered slots (Snack 1/2/3) and doesn't specify, pick the FIRST.
  * If no meal is mentioned, set meal to null.
- Ignore filler words: "ate", "had", "I just had".

EXAMPLES:
Input: "for breakfast I had 2 eggs and toast"
Output: {"meal":"Breakfast","items":[{"name":"eggs","quantity":2,"unit":null,"kind":"food"},{"name":"toast","quantity":1,"unit":"slice","kind":"food"}]}

Input: "for lunch I had my chicken caesar salad meal"
Output: {"meal":"Lunch","items":[{"name":"chicken caesar salad","quantity":1,"unit":null,"kind":"meal"}]}

Input: "made my pasta carbonara recipe for dinner"
Output: {"meal":"Dinner","items":[{"name":"pasta carbonara","quantity":1,"unit":null,"kind":"recipe"}]}

Input: "same as yesterday for lunch"
Output: {"meal":"Lunch","items":[{"name":"Lunch","quantity":1,"unit":null,"kind":"yesterday"}]}

Input: "had my pre-workout meal and a banana"
Output: {"meal":null,"items":[{"name":"pre-workout","quantity":1,"unit":null,"kind":"meal"},{"name":"banana","quantity":1,"unit":null,"kind":"food"}]}

Input: "drank a glass of water"
Output: {"meal":null,"items":[{"name":"glass","quantity":1,"unit":"glass","kind":"water"}]}

Input: "500ml of water"
Output: {"meal":null,"items":[{"name":"water","quantity":500,"unit":"ml","kind":"water"}]}

Input: "had my protein shaker"
Output: {"meal":null,"items":[{"name":"protein shaker","quantity":1,"unit":"protein shaker","kind":"water"}]}`;
}

/**
 * Parse a free-form input string into structured food items + a target meal name.
 * The meal returned is one of the user's configured meal slot names (case-preserved),
 * not a generic canonical name — so custom meal slots like "Pre-workout" work.
 *
 * @param {string} text — user input
 * @param {string[]} userMealNames — current user's mealNames array
 * @returns {{ meal: string|null, items: [{name, quantity, unit}, ...] }}
 */
export async function parseInput(text, userMealNames) {
  if (!text || !text.trim()) return { meal: null, items: [] };
  const provider = DB.getSetting('aiProvider', 'claude');
  const apiKey   = DB.getSetting('aiApiKey', '');
  const model    = DB.getSetting('aiModel', '');
  const baseUrl  = DB.getSetting('aiBaseUrl', '');
  // When AI is configured via server env vars (AI_PROVIDER + AI_API_KEY), the
  // proxy handles auth and no per-user key is needed. Read the current envLocks
  // snapshot rather than the apiKey setting alone.
  const locks = get(envLocks) || {};
  const envLocked = !!locks.ai;
  // OpenAI-compatible endpoints (Ollama etc.) don't need an API key.
  if (!apiKey && provider !== 'oai-compat' && !envLocked) {
    throw new Error('AI provider not configured. Set up the AI Assistant in Settings first.');
  }

  const waterContainers = DB.getSetting('waterContainers', []);

  const systemPrompt = _buildParsePrompt(userMealNames, waterContainers);
  const messages = [{ role: 'user', content: text.trim() }];
  const reply = envLocked
    ? await callAIProxy({ messages, systemPrompt, tools: [] })
    : await callAI({
        provider, apiKey, model, baseUrl,
        messages, systemPrompt, tools: [],
      });

  // Defensive JSON parse — strip markdown fences if the model added them
  let jsonText = String(reply || '').trim();
  const fenceMatch = jsonText.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fenceMatch) jsonText = fenceMatch[1].trim();

  try {
    const parsed = JSON.parse(jsonText);
    const rawItems = Array.isArray(parsed.items) ? parsed.items : [];
    const VALID_KINDS = new Set(['food', 'meal', 'recipe', 'yesterday', 'water']);
    const items = rawItems
      .filter(it => it && typeof it === 'object' && it.name)
      .map(it => ({
        name: String(it.name).trim(),
        quantity: Number(it.quantity) > 0 ? Number(it.quantity) : 1,
        unit: it.unit ? String(it.unit).trim() : null,
        kind: VALID_KINDS.has(it.kind) ? it.kind : 'food',
      }));
    // Meal can be any of the user's slot names (free string, validated downstream)
    const meal = parsed.meal && typeof parsed.meal === 'string' ? parsed.meal.trim() : null;
    return { meal, items };
  } catch (e) {
    console.warn('[quick-log] AI returned non-JSON:', jsonText.slice(0, 200));
    throw new Error('AI parser returned invalid JSON. Try rephrasing your input.');
  }
}

/**
 * Resolve a meal name string from the AI to an index in the user's configured
 * mealNames array.
 *
 * The user may have:
 *   - Custom slot names ("Pre-workout", "Late Snack", "Brunch")
 *   - Numbered duplicates ("Snack 1", "Snack 2", "Snack 3")
 *   - Renamed defaults ("Morning Bowl" instead of "Breakfast")
 *   - Removed defaults entirely (no "Snacks" slot at all)
 *
 * Strategy (in priority order):
 *   1. EXACT case-insensitive match against the user's configured names.
 *      The AI is told to use the user's exact slot names, so this is the
 *      common case.
 *   2. Substring match where one fully contains the other. Prefers shorter
 *      user slot names so "Pre-workout meal" → "Pre-workout".
 *   3. Canonical-word alias: if the AI returned a generic word like
 *      "breakfast" / "snack", find the FIRST user slot whose name contains
 *      one of the canonical aliases. Numbered duplicates like "Snack 1, 2, 3"
 *      will pick "Snack 1" — the user can change it in the review modal.
 *   4. If nothing matches, return null and the caller falls back to its
 *      default meal slot.
 */
export function resolveMealSlot(mealName, mealNames) {
  if (!mealName || !Array.isArray(mealNames) || mealNames.length === 0) return null;
  const target = String(mealName).toLowerCase().trim();
  if (!target) return null;

  // 1. Exact case-insensitive match
  const direct = mealNames.findIndex(n => String(n).toLowerCase() === target);
  if (direct >= 0) return direct;

  // 2. Substring match — prefer the SHORTEST matching slot name to avoid
  //    "Pre-workout snack" matching "Snack 1" when "Pre-workout" exists.
  let bestSubstr = -1;
  let bestSubstrLen = Infinity;
  for (let i = 0; i < mealNames.length; i++) {
    const ln = String(mealNames[i]).toLowerCase();
    if (ln === target) return i; // double-check exact (shouldn't reach here but safe)
    if (ln.includes(target) || target.includes(ln)) {
      if (ln.length < bestSubstrLen) {
        bestSubstr = i;
        bestSubstrLen = ln.length;
      }
    }
  }
  if (bestSubstr >= 0) return bestSubstr;

  // 3. Canonical-word fuzzy fallback
  const aliases = {
    breakfast: ['breakfast', 'morning', 'am', 'wake', 'first'],
    lunch:     ['lunch', 'noon', 'midday'],
    dinner:    ['dinner', 'supper', 'evening', 'night'],
    snack:     ['snack', 'snacks'],
  };
  const aliasList = aliases[target] || [];
  if (aliasList.length > 0) {
    // First pass: find a slot whose lowercase name STARTS WITH any alias
    // (handles "Snack 1" picking up "snack" as a prefix). Returns the first
    // such slot which is typically the user's "first" snack.
    for (let i = 0; i < mealNames.length; i++) {
      const ln = String(mealNames[i]).toLowerCase();
      if (aliasList.some(a => ln.startsWith(a))) return i;
    }
    // Second pass: any substring match (e.g. "Mid-afternoon Snack")
    for (let i = 0; i < mealNames.length; i++) {
      const ln = String(mealNames[i]).toLowerCase();
      if (aliasList.some(a => ln.includes(a))) return i;
    }
  }

  return null;
}

// ── Step 2: Match parsed items to real records ────────────────────────────

/**
 * Match a single parsed item to a real record. Dispatches based on the
 * `kind` field set by the AI parser:
 *   - 'food'      → searches local foods, then OFF (existing behavior)
 *   - 'meal'      → searches saved meals
 *   - 'recipe'    → searches saved recipes
 *   - 'yesterday' → pulls items from yesterday's diary for the named meal slot
 *
 * Returns { item, candidates, best, source } where:
 *   - source ∈ 'local' | 'off' | 'meal' | 'recipe' | 'yesterday' | 'unknown'
 *   - For 'meal' / 'recipe': best is the meal record (with .items[] inside)
 *   - For 'yesterday': best is a synthetic { name, items: [...yesterday's foods] }
 *     where the inner items are full food records ready to write to today's diary
 */
export async function matchItem(parsedItem) {
  const kind = parsedItem.kind || 'food';
  if (kind === 'meal') return _matchMeal(parsedItem, false);
  if (kind === 'recipe') return _matchMeal(parsedItem, true);
  if (kind === 'yesterday') return _matchYesterday(parsedItem);
  if (kind === 'water') return _matchWater(parsedItem);
  return _matchFood(parsedItem);
}

/** Match all parsed items in parallel. */
export async function matchItems(parsedItems) {
  return Promise.all(parsedItems.map(matchItem));
}

// ── _matchFood: existing food search (local + OFF) ────────────────────────
async function _matchFood(parsedItem) {
  const out = { item: parsedItem, candidates: [], best: null, source: 'unknown' };
  const query = parsedItem.name;

  // ── 1. Local foods ──────────────────────────────────────────────────────
  try {
    const allFoods = await NtApi.getFoods();
    const ql = query.toLowerCase();
    const matches = (allFoods || []).filter(f => {
      const n = (f.name || '').toLowerCase();
      const b = (f.brand || '').toLowerCase();
      return ql.split(/\s+/).every(tok => n.includes(tok) || b.includes(tok));
    });

    if (matches.length > 0) {
      let freqMap = {};
      try {
        const allDiary = await NtApi.getAllDiary();
        for (const day of allDiary) {
          for (const it of (day.items || [])) {
            const key = it.id || it.foodId || it.name;
            if (key) freqMap[key] = (freqMap[key] || 0) + 1;
          }
        }
      } catch {}
      const ranked = [...matches].sort((a, b) => {
        const fa = freqMap[a.id || a.name] || 0;
        const fb = freqMap[b.id || b.name] || 0;
        if (fb !== fa) return fb - fa;
        const ea = (a.name || '').toLowerCase() === ql ? 1 : 0;
        const eb = (b.name || '').toLowerCase() === ql ? 1 : 0;
        if (eb !== ea) return eb - ea;
        return (a.name || '').length - (b.name || '').length;
      });
      out.candidates = ranked.slice(0, 8);
      out.best = ranked[0];
      out.source = 'local';
      return out;
    }
  } catch (e) {
    console.warn('[quick-log] local food search failed:', e.message);
  }

  // ── 2. OFF fallback ─────────────────────────────────────────────────────
  try {
    const offResults = await API.searchByName(query, 1);
    if (Array.isArray(offResults) && offResults.length > 0) {
      out.candidates = offResults.slice(0, 5);
      out.best = offResults[0];
      out.source = 'off';
      return out;
    }
  } catch (e) {
    console.warn('[quick-log] OFF search failed:', e.message);
  }

  return out;
}

// ── _matchMeal: search saved meals or recipes ─────────────────────────────
// `isRecipe` flag distinguishes the two — they share the same data shape but
// live in separate API endpoints (meals vs meals?recipes=1).
async function _matchMeal(parsedItem, isRecipe) {
  const out = { item: parsedItem, candidates: [], best: null, source: isRecipe ? 'recipe' : 'meal' };
  const query = (parsedItem.name || '').toLowerCase();
  if (!query) return out;

  try {
    const all = isRecipe ? await NtApi.getRecipes() : await NtApi.getMeals();
    const matches = (all || []).filter(m => {
      const n = (m.name || '').toLowerCase();
      return query.split(/\s+/).every(tok => n.includes(tok));
    });
    if (matches.length === 0) {
      // No exact-token match — fall back to substring on the full query
      const fuzzy = (all || []).filter(m => (m.name || '').toLowerCase().includes(query));
      if (fuzzy.length > 0) {
        out.candidates = fuzzy.slice(0, 5);
        out.best = fuzzy[0];
        return out;
      }
      // Still nothing — leave source as meal/recipe but best=null so the
      // modal shows "not found" and the user can swap or remove
      return out;
    }
    // Sort by exact-name boost, then shortest name (most specific match)
    const ranked = [...matches].sort((a, b) => {
      const ea = (a.name || '').toLowerCase() === query ? 1 : 0;
      const eb = (b.name || '').toLowerCase() === query ? 1 : 0;
      if (eb !== ea) return eb - ea;
      return (a.name || '').length - (b.name || '').length;
    });
    out.candidates = ranked.slice(0, 5);
    out.best = ranked[0];
  } catch (e) {
    console.warn(`[quick-log] ${isRecipe ? 'recipe' : 'meal'} search failed:`, e.message);
  }
  return out;
}

// ── _matchYesterday: pull items from yesterday's diary ────────────────────
// The AI sets `name` to the meal slot name they want to repeat (e.g. "Lunch").
// We resolve that to a slot index, fetch yesterday's diary, and return all
// items in that slot as a synthetic "meal" so saveItems can expand them.
async function _matchYesterday(parsedItem) {
  const out = { item: parsedItem, candidates: [], best: null, source: 'yesterday' };
  try {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const yDateStr = yesterday.toLocaleDateString('sv-SE');
    const entry = await NtApi.getDiaryDate(yDateStr);
    if (!entry || !entry.items || entry.items.length === 0) return out;

    // Resolve the requested meal slot from the user's mealNames
    const { mealNames } = await import('../stores/settings.js');
    let names = ['Breakfast', 'Lunch', 'Dinner', 'Snacks'];
    mealNames.subscribe(v => { if (v) names = v; })();
    const slot = resolveMealSlot(parsedItem.name, names);
    if (slot == null) return out;

    // Filter yesterday's items to that meal slot
    const yesterdayItems = entry.items.filter(it => Number(it.meal ?? 0) === slot);
    if (yesterdayItems.length === 0) return out;

    // Build a synthetic meal-like record so the modal renders it nicely
    out.best = {
      name: `Yesterday's ${names[slot]}`,
      items: yesterdayItems,
      _yesterdaySlot: slot,
      _yesterdayDate: yDateStr,
      // Aggregated nutrition is informational only — saveItems re-uses the
      // individual item nutrition when expanding.
      nutrition: yesterdayItems.reduce((acc, it) => {
        const n = it.nutrition || {};
        acc.calories = (acc.calories || 0) + (n.calories || 0) * ((it.quantity || 1));
        return acc;
      }, {}),
    };
    out.candidates = [out.best];
  } catch (e) {
    console.warn('[quick-log] yesterday lookup failed:', e.message);
  }
  return out;
}

// ── _matchWater: resolve water amount in ml ───────────────────────────────
// Generic container defaults (ml) for when the user says "a glass" etc.
const _WATER_DEFAULTS = {
  glass: 240, cup: 240, mug: 350, bottle: 500,
  'water bottle': 500, 'small bottle': 330, 'large bottle': 750,
  jug: 1000, pitcher: 1000, sip: 30, gulp: 60, can: 355,
};

async function _matchWater(parsedItem) {
  const out = { item: parsedItem, candidates: [], best: null, source: 'water' };
  const name = (parsedItem.name || '').toLowerCase().trim();
  const qty  = Number(parsedItem.quantity) > 0 ? Number(parsedItem.quantity) : 1;
  const unit = (parsedItem.unit || '').toLowerCase().trim();

  let amountMl = 0;

  // 1. Check user's configured containers by name
  const containers = DB.getSetting('waterContainers', []);
  if (Array.isArray(containers) && containers.length > 0) {
    const match = containers.find(c =>
      (c.name || '').toLowerCase() === name ||
      (c.name || '').toLowerCase() === unit
    ) || containers.find(c =>
      name.includes((c.name || '').toLowerCase()) ||
      (c.name || '').toLowerCase().includes(name)
    );
    if (match) {
      amountMl = Math.round((match.volumeMl || 250) * qty);
      out.best = { _waterMl: amountMl, _containerName: match.name, name: match.name };
      out.candidates = [out.best];
      return out;
    }
  }

  // 2. Explicit ml/oz/L amount
  if (unit === 'ml' || unit === 'milliliter' || unit === 'milliliters') {
    amountMl = Math.round(qty);
  } else if (unit === 'oz' || unit === 'fl oz' || unit === 'fluid ounce') {
    amountMl = Math.round(qty * 29.5735);
  } else if (unit === 'l' || unit === 'liter' || unit === 'liters') {
    amountMl = Math.round(qty * 1000);
  } else if (unit === 'cl' || unit === 'centiliter') {
    amountMl = Math.round(qty * 10);
  }

  // 3. Generic container word
  if (!amountMl) {
    const defaultMl = _WATER_DEFAULTS[name] || _WATER_DEFAULTS[unit] || 250;
    amountMl = Math.round(defaultMl * qty);
  }

  out.best = { _waterMl: amountMl, name: name || 'water' };
  out.candidates = [out.best];
  return out;
}

// ── Step 3: Save matched items to diary ──────────────────────────────────

/**
 * Save the user's confirmed items to the diary for the given date + meal slot.
 *
 * Handles four item kinds based on the matched record's `source`:
 *   - 'local' / 'off' / 'unknown' (single food) → 1 diary entry, m.quantity is grams
 *   - 'recipe' (saved recipe)                   → 1 diary entry treating the recipe
 *                                                  as a single food, m.quantity is grams
 *   - 'meal' (saved meal)                       → expand meal.items[] into N diary entries
 *   - 'yesterday' (synthetic from yesterday)    → copy items[] from yesterday into N diary entries
 *
 * Each "matched item" should have:
 *   - food: the matched record
 *   - quantity: portion size in grams (foods + recipes)
 *   - mealSlot: 0..n meal index
 */
export async function saveItems(matchedList, { date, defaultMealSlot = 0 }) {
  if (!Array.isArray(matchedList) || matchedList.length === 0) return { saved: 0 };
  const { addDiaryItem, addWaterLog } = await import('../stores/diary.js');

  let saved = 0;
  for (const m of matchedList) {
    if (!m || !m.food) continue;
    const slot = m.mealSlot != null ? Number(m.mealSlot) : defaultMealSlot;

    // ── Water: add to water log ──────────────────────────────────────────
    if (m.source === 'water' && m.food?._waterMl) {
      try {
        await addWaterLog(m.food._waterMl, date);
        saved++;
      } catch (e) {
        console.warn('[quick-log] add water failed:', e.message);
      }
      continue;
    }

    // ── Meal / Yesterday: expand .items[] into multiple diary entries ──
    // (Recipes are explicitly NOT in this branch — they're added as a
    // single diary entry below, just like a regular food.)
    if ((m.source === 'meal' || m.source === 'yesterday') &&
        Array.isArray(m.food.items)) {
      for (const sub of m.food.items) {
        try {
          await addDiaryItem(
            { ...sub, quantity: sub.quantity || 1 },
            slot,
            date
          );
          saved++;
        } catch (e) {
          console.warn('[quick-log] add expanded meal item failed:', e.message);
        }
      }
      continue;
    }

    // ── Single food / recipe (local / off / unknown / recipe) ────────────
    let food = m.food;

    // If the food came from OFF, persist it to the local foods table first so
    // future quick-log calls find it via the local-search fast path.
    if (m.source === 'off' && !food.id) {
      try {
        const created = await NtApi.createFood(food);
        if (created && created.id) food = created;
      } catch (e) {
        console.warn('[quick-log] failed to save OFF food locally:', e.message);
      }
    }

    // Match Foods.svelte behavior (confirmQtyPrompt): scale the nutrition
    // object by (newPortion / originalPortion) so the diary item carries
    // PRE-SCALED nutrition values. Diary's Nutrition.calculate then
    // multiplies by quantity=1 → correct totals.
    //
    // Why: nutrition values are stored "per food.portion grams" (typically
    // per 100g). If the user wants to log 250g of a recipe whose portion
    // is 100g, we need to multiply nutrition by 2.5 BEFORE writing the
    // diary entry — diary doesn't do this conversion automatically.
    const newPortion = Number(m.quantity) > 0 ? Number(m.quantity) : (food.portion || 100);
    const origPortion = Number(food.portion) > 0 ? Number(food.portion) : 100;
    const portionFactor = newPortion / origPortion;
    const scaledNutrition = food.nutrition && portionFactor !== 1
      ? Object.fromEntries(
          Object.entries(food.nutrition).map(([k, v]) => [k, (parseFloat(v) || 0) * portionFactor])
        )
      : food.nutrition;

    const item = {
      ...food,
      portion: newPortion,
      unit: food.unit || 'g',
      nutrition: scaledNutrition,
      quantity: 1,
      meal: slot,
    };
    try {
      await addDiaryItem(item, item.meal, date);
      saved++;
    } catch (e) {
      console.warn('[quick-log] add to diary failed:', e.message);
    }
  }
  return { saved };
}
