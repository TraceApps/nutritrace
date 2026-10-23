/**
 * AI Chat — multi-provider API layer with tool use (function calling)
 * Supports: Anthropic Claude, OpenAI, Google Gemini
 * All calls made client-side using the user's own API key.
 *
 * Tool use flow:
 * 1. Send messages + tool definitions to AI
 * 2. If AI responds with tool_use, execute the tool and send result back
 * 3. Repeat until AI responds with text, up to TOOL_ROUNDS; when they run
 *    out, one last request with the tools off asks for an answer from what
 *    was found
 */
import { NUTRIMENTS } from './nutrition.js';
import { get } from 'svelte/store';
import { _ } from 'svelte-i18n';
import { getOpenAIChatParams, openAIBase } from './openai-chat-params.js';
import { createToolSupportMemory, sendWithToolFallback } from './tool-support.js';
import { geminiToolResponse } from './gemini-tool-response.js';
import { REPLY_MAX_TOKENS, sendWithLengthFallback, stoppedShort, stoppedShortError } from './trace-reply.js';

// A reply that stopped short, said in the app's language (trace-reply.js).
function _inLanguage(e) {
  if (!/^trace_stopped_/.test(e?.code || '')) return e;
  try {
    const t = get(_);
    const said = typeof t === 'function' ? t(`trace_reply.${e.code.slice('trace_'.length)}`) : null;
    if (said && !said.startsWith('trace_reply.')) e.message = said;
  } catch { /* i18n not ready: the English line */ }
  return e;
}
const _stoppedShort = (why) => _inLanguage(stoppedShortError(why));

// The last round's answer, or, when a model gave none at all, why there's none.
function _finalAnswer(text) {
  if (String(text || '').trim()) return text;
  try {
    const said = get(_)('trace_reply.out_of_rounds');
    if (said && !said.startsWith('trace_reply.')) return said;
  } catch { /* i18n not ready: the English line */ }
  return 'That took more steps than one answer allows, and nothing came back. Ask for less at once, such as a shorter date range.';
}

// Nutrition schema for the propose_* tools — generated from the canonical
// NUTRIMENTS list so adding a new nutrient anywhere in the app automatically
// makes it estimable by Trace, without a second place to edit. Mini-class
// models (gpt-4o-mini etc.) read `properties:` as a literal allow-list, so
// listing every NT-tracked key explicitly is what gets them to send
// fiber / sugars / sat-fat / sodium / vitamin-d / iron / calcium / etc.
// instead of just the four headline macros.
const NUTRITION_SCHEMA = (() => {
  const properties = {};
  for (const n of NUTRIMENTS) properties[n.id] = { type: 'number' };
  return {
    type: 'object',
    description:
      'Estimated nutrition values keyed by NutriTrace nutriment ID. All numeric. ' +
      '`calories` is required. ESTIMATE EVERY KEY YOU CAN — fiber, sugars, sodium, ' +
      'saturated fat, cholesterol, vitamins, minerals — anything the food contains ' +
      'in non-trivial amounts. Omit a key only when the value would genuinely be ~0 ' +
      "or you have no basis to estimate it. Don't restrict yourself to the four " +
      'headline macros; the user wants the full nutrition profile.',
    properties,
    required: ['calories'],
    // No `additionalProperties` — Gemini's function-calling schema is a
    // subset of OpenAPI 3.0 and rejects that field with "Unknown name
    // 'additionalProperties'" (issue #56 from @nomad64). JSON Schema
    // default behavior allows extras anyway, so dropping the explicit
    // clause doesn't lose functional capability for Claude / OpenAI /
    // oai-compat providers. NUTRIMENTS already enumerates every
    // supported key in `properties`, so the AI has the full key
    // universe regardless.
  };
})();

// Human-readable list for the system prompt, so the AI knows at a glance
// what nutriment IDs are valid without having to re-read the JSON schema.
const NUTRIMENT_ID_LIST = NUTRIMENTS.map(n => n.id).join(', ');

// ── Tool definitions (shared across all providers) ────────────────────────────
export const TOOLS = [
  {
    name: 'get_wellness_data',
    description: 'Get wellness/fitness metrics for a date range. Returns daily data including steps, calories burned, distance, active minutes, sleep (duration, stages, score, efficiency), heart rate (resting HR, HRV, SpO2), respiratory rate, readiness score, stress score, skin temp, VO2 max, and more. Sources: Fitbit, Garmin, Health Connect.',
    parameters: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'Start date (YYYY-MM-DD)' },
        to:   { type: 'string', description: 'End date (YYYY-MM-DD)' },
      },
      required: ['from', 'to'],
    },
  },
  {
    name: 'get_body_composition',
    description: 'Get body composition data from Withings scale for a date range. Returns weight, body fat %, muscle mass, bone mass, body water %, lean mass, fat mass, visceral fat, vascular age, metabolic age, BMR, nerve health, ECG, and segmental analysis.',
    parameters: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'Start date (YYYY-MM-DD)' },
        to:   { type: 'string', description: 'End date (YYYY-MM-DD)' },
      },
      required: ['from', 'to'],
    },
  },
  {
    name: 'get_diary',
    description: 'Get the food diary for one date, or for every day from `date` to `to` (up to 31 days a call; days with nothing logged are only counted, and next_from says where the rest starts). Use a range to go through days, such as "what did I eat last week" or "which days did I have pizza". Returns meals + food items (portions, quantities, brand, per-item notes), nutrition breakdown (calories, protein, carbs, fat), body stats (with explicit `weight_unit` / `length_unit` so you don\'t guess), water intake (ml), any free-text "day notes" the user wrote (sleep, energy, cravings, context), and any manually-logged activities for that day (name, kcal burned, duration, distance, source). DO NOT use this tool for streak questions, "how many days have I been logging", "when did I start tracking", consecutive-day counts, or any multi-day aggregate: for those use get_logging_streak (streak) or get_diary_averages (averages over a window). This tool is for reading what was logged on the days themselves.',
    parameters: {
      type: 'object',
      properties: {
        date: { type: 'string', description: 'Date (YYYY-MM-DD), or the first day of a range.' },
        to:   { type: 'string', description: 'Optional last day of a range (YYYY-MM-DD), inclusive.' },
      },
      required: ['date'],
    },
  },
  {
    name: 'get_meals',
    description: 'Get the user\'s saved Meals and Recipes from their library. Returns each one with its items (portions, quantities, per-item notes), totals (calories, macros), and any meal-level notes. Useful when the user refers to a saved meal by name ("my usual breakfast") or wants ideas based on meals they\'ve logged before. Returns count (every match) and a page of up to 50; next_offset is where the next page starts (null on the last).',
    parameters: {
      type: 'object',
      properties: {
        query:  { type: 'string', description: 'Optional case-insensitive name filter. Omit for the whole library.' },
        offset: { type: 'integer', description: 'Where the page starts: 0 first, then the next_offset of the page before.' },
      },
    },
  },
  {
    name: 'get_workouts',
    description: 'Get recorded workouts/exercises for a date range. Returns activity name, duration, distance, calories, average/max heart rate, steps, and whether GPS route data is available.',
    parameters: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'Start date (YYYY-MM-DD)' },
        to:   { type: 'string', description: 'End date (YYYY-MM-DD)' },
      },
      required: ['from', 'to'],
    },
  },
  {
    name: 'get_goals',
    description: 'Get the user\'s nutrition and wellness goals. Returns calorie, macro, and other nutrient targets.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'add_activity_entry',
    description: 'Log an exercise/activity entry to the user\'s Diary Activity section. Use this when the user describes a workout or physical activity ("I hiked 10 miles", "did 45 min of yoga"). Each entry offsets the day\'s calorie goal per the user\'s policy. If the user provides a calorie number, pass it as kcal and use source="user_stated". If you estimated kcal from body profile + duration/MET, use source="ai_estimated" and tell the user the estimate so they can correct it. Do NOT call this tool if the activityAutoEstimate setting is off and the user did not supply a calorie number — ask them for one instead. When the activity clearly maps to a standard MET value (running at a known pace, cycling at a known speed, swimming laps, etc.), also pass the met value so the entry participates in the compendium-based auto-calc going forward. Set is_template=true only when the user explicitly asks to save a reusable template (e.g. "save this as my evening bike commute").',
    parameters: {
      type: 'object',
      properties: {
        date:         { type: 'string', description: 'Date the activity happened (YYYY-MM-DD). Defaults to today if omitted.' },
        name:         { type: 'string', description: 'Short label for the activity, e.g. "Morning hike", "Yoga", "Bike commute".' },
        kcal:         { type: 'number', description: 'Calories burned (positive integer).' },
        duration_min: { type: 'number', description: 'Optional duration in minutes.' },
        distance:     { type: 'string', description: 'Optional free-text distance, e.g. "10 mi" or "5 km".' },
        source:       { type: 'string', description: 'Provenance: "user_stated" if the user gave a number, "ai_estimated" if you computed it, "compendium" if you matched a canonical MET-scored activity.' },
        met:          { type: 'number', description: 'Optional 2024 Adult Compendium MET value for the activity. Pass it when the activity clearly maps to a canonical entry (e.g. running 8 km/h = 8.3, cycling 20 km/h = 8.0, yoga hatha = 2.5). Enables deterministic per-day recomputation on weight change. Omit for ambiguous or freeform activities.' },
        is_template:  { type: 'boolean', description: 'Optional. Set true only when the user explicitly asks to save the activity as a reusable template (e.g. "add this as my evening bike commute template"). Default false.' },
      },
      required: ['name', 'kcal'],
    },
  },
  {
    name: 'get_diary_averages',
    description: 'Get the user\'s average daily nutrition intake over the last N days, plus logging consistency. Returns average calories, protein, carbs, fat, water, and other nutrients. Also returns how many days were logged vs total days (consistency %), and weight change over the period if available. Use this to compare actual intake against goals and offer evidence-based goal adjustment suggestions. Also use it to verify a logging streak: if days_logged equals period_days, the user has logged every day in that window; expand the period to find where the streak breaks.',
    parameters: {
      type: 'object',
      properties: {
        days: { type: 'number', description: 'Number of days to average over. Common: 7, 14, 28, 42 for typical averages; 90, 180, 365, 730, 3650 for streak verification or long-history users (e.g. someone who imported years of MyFitnessPal data). Capped at 3650 (10 years).' },
      },
      required: ['days'],
    },
  },
  {
    name: 'get_logging_streak',
    description: 'Get the user\'s current diary-logging streak — the count of consecutive days they have recorded ANY content in the diary (food items, water, body stats, or day notes), walking backward from today (or yesterday if today is not yet logged so an ongoing day isn\'t penalized). Matches what users mean by "I\'ve been tracking for X days in a row" — engagement with the diary, not strictly food entries. Use this for any "how long is my streak", "do I have a streak", "when did my streak start" question. This is the correct tool for streak questions; do NOT abuse get_diary_averages with a huge days argument to infer the streak — the streak walk terminates naturally at the first gap regardless of how long the user has been logging, so this tool is cheaper and authoritative. Returns { streak_days, streak_start, streak_end, today_logged }. streak_days=0 when the most recent logging was 2+ days ago.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'get_fasting_history',
    description: 'Get the user\'s intermittent-fasting history if they have the tracker enabled. Returns the last N completed fasts (start_at, end_at, duration_hours, goal_hours, met_goal), plus summary stats: average duration, longest fast, current daily streak, longest streak, and total count. Use this when the user asks about their fasting performance, streaks, recent fasts, or how their schedule is going. Returns an empty list if fasting is disabled or no fasts are logged.',
    parameters: {
      type: 'object',
      properties: {
        days: { type: 'number', description: 'How many days of history to return (default 30, max 365).' },
      },
    },
  },
  {
    name: 'get_adaptive_tdee',
    description: 'Get the user\'s learned/adaptive TDEE (Total Daily Energy Expenditure) if they have enough history. Adaptive TDEE is computed from 35 days of weight trend × calorie intake using linear regression. Returns { ready, tdee, trendKgPerWeek, confidence, weightSource, daysAvailable, daysRequired }. When ready is false, the user doesn\'t yet have enough logged days (returns daysAvailable / daysRequired so you can tell them how close they are). Use this when the user asks about their actual calorie burn, learned/adjusted TDEE, weight trend, or whether their fixed goal is still right for them.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'log_food',
    description: 'Log a REAL FOOD entry to the user\'s diary with full nutrition (protein, carbs, fat, fiber, sodium, vitamins, etc. — NOT just calories). USE THIS — not log_quick_calories — whenever the user NAMES a food they want to log. Typical phrasings: "add an apple to lunch", "log a banana to today\'s snacks", "add 200g of chicken to dinner", "I had Greek yogurt for breakfast", "two slices of bread for lunch".\n\nSEARCH ORDER: (1) the user\'s local food catalog first (their saved/scanned foods); (2) Open Food Facts if nothing local matches. If the user has the local OFF mirror enabled, OFF goes through that. USDA is NOT searched here (use a separate barcode/manual flow for USDA).\n\nRETURN SHAPES — branch on these:\n- {ok: true, meal_name, food_name, kcal, source, ...} — logged. Use meal_name (the actual name, not just an index) when you confirm to the user; do NOT assume the meal name from the index you passed.\n- {candidates: [...]} — multiple plausible matches. Show the names back to the user and ask which one. Then call again with the chosen name as the food field.\n- {no_match: true, suggestion}: nothing found. Say so, and offer to estimate it on a review card (propose_food) or to add it via the Foods tab (barcode scan or manual entry).\n- {no_nutrition: true, food_name, as_prepared_only, message}: Open Food Facts has the product but no \"as sold\" values, so nothing was logged. Relay the message; do not log it another way (such as quick calories) to force it in.\n- {error: "..."} — something else went wrong. Relay verbatim.\n\nDO NOT CALL THIS TOOL when the user wants a food SAVED rather than LOGGED ("create a food called X", "add it to my foods", "save it but don\'t log it", "don\'t add it to my diary"). This tool always writes a diary entry. Use propose_food instead: its card has a Save to Foods button that creates the food and touches nothing else.',
    parameters: {
      type: 'object',
      properties: {
        food:     { type: 'string', description: 'The food name as the user said it. Plain natural language: "apple", "Greek yogurt", "Honey Nut Cheerios", "chicken breast", "olive oil". Brand can be included if mentioned ("Chobani Greek yogurt").' },
        meal:     { type: 'number', description: 'Meal index per the YOUR MEALS list in the system prompt. NEVER hardcode 0=breakfast/1=lunch/etc — that\'s only correct for the default meal layout. Match the user\'s named meal to its position in YOUR MEALS and pass that index. If the user did not name a meal and it isn\'t clearly implied, ASK them which meal.' },
        portion:  { type: 'number', description: 'OPTIONAL portion amount. If omitted, the food\'s stored serving size is used (100g for fresh OFF lookups). Pass when the user specifies an amount: 200 for "200g of chicken", 150 for "150ml of milk", 1 for "1 cup of cereal".' },
        unit:     { type: 'string', description: 'OPTIONAL portion unit (g, ml, oz, cup, tbsp, slice, piece). Defaults to the food\'s stored unit. Only pass if the user specified a unit DIFFERENT from grams.' },
        quantity: { type: 'number', description: 'OPTIONAL number of servings, defaults to 1. Use for "two apples" (quantity=2) or "half a banana" (quantity=0.5). Most asks use the default; portion+unit handles grams/ml directly.' },
        date:     { type: 'string', description: 'Optional YYYY-MM-DD; defaults to today.' },
      },
      required: ['food', 'meal'],
    },
  },
  {
    name: 'log_quick_calories',
    description: 'Log a Fitbit/MFP-style "Quick Calories" entry to the user\'s diary — a row with ONLY a calorie number (and optionally protein/carbs/fat), no food, no portion. Use this STRICTLY when the user gives a kcal number WITHOUT naming a food: "log 200 calories for lunch", "add 1200 kJ to dinner", "punch in 350 quick calories", "log 240 kcal with 20g protein for snack". If the user names a food ("add an apple", "log Greek yogurt", "two slices of bread") use log_food INSTEAD — that path stores full nutrition and creates a reusable food row. If the user gives kJ, convert to kcal yourself (1 kcal = 4.184 kJ). The kcal and any macros must be numbers the user stated: NEVER pass a number you estimated or looked up. An estimate goes on a review card (propose_food, or propose_quick_calories when the user asks for quick calories) so the user confirms it. Returns { error } if the user has disabled Quick Calories in Settings → Diary.',
    parameters: {
      type: 'object',
      properties: {
        meal:      { type: 'number', description: 'Meal index per YOUR MEALS in the system prompt. NEVER hardcode 0=breakfast etc — that\'s only correct for the default meal layout.' },
        kcal:      { type: 'number', description: 'Calories as a positive integer in kcal. If the user said kJ, convert: kcal = kj / 4.184.' },
        name:      { type: 'string', description: 'Optional short label (max 60 chars). Defaults to "Quick Calories" when omitted.' },
        protein_g: { type: 'number', description: 'OPTIONAL protein in grams. Only pass if the user explicitly mentioned a protein number; do not estimate from calories.' },
        carbs_g:   { type: 'number', description: 'OPTIONAL carbohydrates in grams. Only pass if the user explicitly mentioned a carbs number; do not estimate.' },
        fat_g:     { type: 'number', description: 'OPTIONAL fat in grams. Only pass if the user explicitly mentioned a fat number; do not estimate.' },
        date:      { type: 'string', description: 'Optional YYYY-MM-DD; defaults to today.' },
      },
      required: ['kcal'],
    },
  },
  {
    name: 'propose_quick_calories',
    description: 'Propose a Quick Calories entry for the user to REVIEW before anything is written to the diary. This tool DOES NOT WRITE to the diary, DOES NOT CREATE a food, and DOES NOT LOG anything — it ONLY displays an estimate card with Discard / Add to Diary buttons for the user to confirm. Treat the tool returning `ok: true` as "the card was shown to the user", NOT as "the food was logged". After calling this tool you MUST NOT say things like "I\'ve added X" or "Logged X to your diary" — the user has not yet confirmed. Instead say something like "Here\'s my estimate — tap Add to Diary to log it." Use this for a kcal-style entry whose numbers YOU estimated: a meal photo the user wants logged ("log this", "throw this in for lunch"), or, with or without a photo, when the user asks for quick calories ("add this as quick calories", "just kcal it"). Only kcal, protein, carbs and fat are kept when they tap Add. Do NOT use it for a kcal number the user gave you (log_quick_calories), for a named food the user has not asked you to estimate (log_food searches first), or for a question that only asks for the numbers (answer in text). For any other estimate the user wants logged, and for a reusable food, use propose_food. If this returns that Quick Calories is turned off, use propose_food. Proposing the card that is already on screen again does nothing.',
    parameters: {
      type: 'object',
      properties: {
        name:        { type: 'string',  description: 'Short descriptive name for what you see (e.g. "Grilled chicken sandwich + fries", "Bowl of oatmeal with berries"). Max 60 chars.' },
        meal:          { type: 'number', description: 'Meal index the entry will be filed under: 0=breakfast, 1=lunch, 2=dinner, 3=snacks. Defaults to 3 if you cannot tell from context. The user can change this on the card before committing.' },
        date:          { type: 'string', description: 'Optional YYYY-MM-DD; defaults to today.' },
        serving_grams: { type: 'number', description: 'STRONGLY RECOMMENDED for photo estimates. Estimated weight of the food in the photo, in grams. Lets the user sanity-check the basis of the nutrition estimate ("if you think this is 350 g, but it\'s actually 500 g, scale the calories up"). Provide this whenever the food has a sensible weight; omit only for things that don\'t weigh meaningfully on their own (e.g. a glass of water).' },
        serving_size:  { type: 'string', description: 'Optional plain-language serving description ("1 plate", "medium bowl", "1 slice"). Use ALONGSIDE serving_grams to add useful context, or INSTEAD of it for items where grams aren\'t meaningful.' },
        nutrition:     NUTRITION_SCHEMA,
      },
      required: ['name', 'nutrition'],
    },
  },
  {
    name: 'propose_food',
    description: 'Propose a reusable FOOD entry for the user to REVIEW before anything is created. This tool DOES NOT WRITE to the Foods library, DOES NOT WRITE to the diary — it ONLY displays a review card so the user can decide to (a) Save to Foods only, (b) Save & Add to Diary, or (c) Discard. Treat the tool returning `ok: true` as "the card was shown", NOT as "the food was saved" or "added to diary". After calling this tool you MUST NOT say things like "I\'ve added X to your Foods" or "Added X to your diary" — the user has not yet confirmed. Say something like "Here\'s my estimate — pick Save to Foods if you just want to keep it for later, or Save & Add to Diary to also add it to today." Use this when the user wants a REUSABLE food (not a one-off kcal entry): "add this to my foods", "save this as a food", "remember this for later", "create a food entry for this". ALSO USE THIS as the manual-estimate bypass for log_food: when the user explicitly asks you to estimate a named food without searching the database ("don\'t search, just estimate a currywurst", "you estimate it and log it"), or log_food found nothing and the user wants your estimate, pass your best-guess nutrition here so the user reviews the numbers on the card and picks Save & Add to Diary (the full nutrition is kept). Nutrition values are per the portion you specify (default 100 g if you cannot tell).\n\nThis is the ONLY tool that can create a food, and it works with or without a photo. When the user asks for a food to be created and says not to log it, this is the tool, and the answer is to point them at the card\'s Save to Foods button.',
    parameters: {
      type: 'object',
      properties: {
        name:      { type: 'string', description: 'Short food name (e.g. "Chicken Pot Pie", "Grilled Salmon Bowl"). Max 60 chars.' },
        brand:     { type: 'string', description: 'Optional brand name if it looks like packaged food.' },
        portion:   { type: 'number', description: 'STRONGLY RECOMMENDED: estimated weight in grams of the photographed portion (e.g. 250 for a typical chicken pot pie slice). The nutrition values you pass are PER this portion. Falls back to 100 (per 100 g/ml) only if you have no basis to estimate.' },
        unit:      { type: 'string', description: 'Portion unit, defaults to "g". Common: g, ml, piece, slice, cup, oz. Prefer "g" for solid foods so the user can correct it numerically.' },
        nutrition: NUTRITION_SCHEMA,
        notes:     { type: 'string', description: 'OPTIONAL human-friendly serving descriptor saved to the food\'s Notes field (e.g. "14 chips", "1/4 cup uncooked", "1 medium slice", "approx 1 cup cooked"). Lets the user see what the per-portion weight actually corresponds to in everyday terms. Shown in the diary when "Show item notes" is enabled in Settings. Skip when the portion + unit already says everything that needs saying.' },
      },
      required: ['name', 'nutrition'],
    },
  },
  {
    name: 'get_activity_log',
    description: 'Get the user\'s manually-logged activity entries from the Diary\'s Activity section (separate from wearable-synced workouts — use get_workouts for those). Each entry has name, kcal burned, duration_min, distance, source, date. Use this when the user asks about manual workouts they logged, exercise they typed in, or activities not synced from a wearable.',
    parameters: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'Start date YYYY-MM-DD (inclusive).' },
        to:   { type: 'string', description: 'End date YYYY-MM-DD (inclusive).' },
      },
      required: ['from', 'to'],
    },
  },
];

/**
 * fetch() to a provider from this browser. Its "Failed to fetch" says
 * nothing: the browser gives it when the address can't be reached, and when
 * the answer doesn't allow this site to read it (CORS), which is what a proxy
 * that adds CORS headers only to successful answers does to every error,
 * such as a model refusing tools (TraceApps/notetrace#18). Say what to check.
 */
export async function fetchProvider(url, init) {
  try {
    return await fetch(url, init);
  } catch (err) {
    // Only a network failure is reworded (Chrome: "Failed to fetch", Firefox:
    // "NetworkError when attempting to fetch resource.", Safari: "Load
    // failed"). A cancelled request, or one fetch refused to send (a header
    // it can't carry, say), stays as it was.
    if (!(err instanceof TypeError) || !/failed to fetch|networkerror|load failed/i.test(err.message || '')) throw err;
    let host = '';
    try { host = new URL(url).host; } catch { /* not a URL */ }
    host = host || String(url);
    const page = typeof location !== 'undefined' ? location : null;
    const official = /(^|\.)(openai\.com|anthropic\.com|googleapis\.com)$/i.test(host);
    // An https page can't call a plain-http address (localhost aside). The
    // Android app can (allowMixedContent), so there it's the usual advice.
    const native = !!globalThis.Capacitor?.isNativePlatform?.();
    const insecure = !native && page?.protocol === 'https:' && /^http:/i.test(String(url)) && !/^(localhost|127\.|\[::1\])/i.test(host);
    const key = official ? 'unreachable_official' : insecure ? 'unreachable_insecure' : 'unreachable';
    let message = `Couldn't get an answer from ${host}.`;
    try {
      const t = get(_);
      if (typeof t === 'function') message = t(`trace.${key}`, { values: { host, origin: page?.origin || 'this site' } });
    } catch { /* i18n not ready: the plain line above */ }
    const e = new Error(message);
    e.cause = err;
    // Not "you're offline": this says what it is.
    e.offline = false;
    throw e;
  }
}

// ── Main entry point ─────────────────────────────────────────────────────────

// onToolsUnsupported runs when the model can't use tools and answered
// without them (TraceApps/nutritrace#259).
export async function callAI({ provider, apiKey, model, messages, systemPrompt, tools, onToolCall, onToolsUnsupported, baseUrl }) {
  // The 'oai-compat' provider points at any /v1/chat/completions endpoint
  // (Ollama, LM Studio, LocalAI, vLLM, DeepSeek, Groq, Together AI, etc.)
  // Local endpoints don't need an API key; cloud ones do. Other providers
  // still require a key.
  if (!apiKey && provider !== 'oai-compat') {
    throw new Error('No API key configured. Add one in Settings → AI Assistant.');
  }
  switch (provider) {
    case 'claude':     return _callClaudeWithTools(apiKey, model, messages, systemPrompt, tools, onToolCall);
    case 'openai':     return _callOpenAIWithTools(apiKey, renamedModel(model), messages, systemPrompt, tools, onToolCall, 'https://api.openai.com', onToolsUnsupported);
    case 'gemini':     return _callGeminiWithTools(apiKey, model, messages, systemPrompt, tools, onToolCall);
    case 'oai-compat': {
      const base = openAIBase(baseUrl);
      if (!base)  throw new Error('OpenAI Compatible provider needs a Base URL. Set one in Settings → AI Assistant.');
      if (!model) throw new Error('OpenAI Compatible provider needs a model name. Set one in Settings → AI Assistant.');
      return _callOpenAIWithTools(apiKey || 'no-key', model, messages, systemPrompt, tools, onToolCall, base, onToolsUnsupported);
    }
    default: throw new Error(`Unknown AI provider: ${provider}`);
  }
}

/**
 * Server-side proxy call — used when AI config is env-locked.
 *
 * The API key stays on the server; only messages + systemPrompt + tool
 * schemas are sent. Wire format is OpenAI-shape (the server adapts to
 * Claude / Gemini at the proxy boundary), so messages going in must use
 * `image_url` for images and `tool_calls` / `role:'tool'` for tool use.
 *
 * Tool execution stays client-side — tools touch local DB + UI state the
 * server doesn't have. This function runs the multi-round loop: send
 * messages → if proxy returns toolCalls, execute them locally, append
 * the assistant message + tool result messages, loop. Up to TOOL_ROUNDS,
 * as the direct calls, then one last request with the tools off.
 *
 * Auth: PWA uses cookies + CSRF; native server mode uses a Bearer token
 * (cookies don't persist across the Android WebView's reloads). Matches
 * the pattern in api.js#_fetch — without the Bearer header, env-locked
 * AI calls from Android return 401 even though the chat path looks fine.
 */
export async function callAIProxy({ messages, systemPrompt, tools, onToolCall, onToolsUnsupported }) {
  const { apiUrl, isNative, getServerUrl, getAuthToken } = await import('./platform.js');

  let currentMessages = [...messages];
  const startBytes = _bytes(currentMessages);
  const dropped = [];

  for (let round = 0; round <= TOOL_ROUNDS; round++) {
    // The server takes 60 messages in one request: Trace wraps up while a
    // round of several tool calls still fits (PROXY_WRAP_MESSAGES).
    const last = _lastRound(round, currentMessages, startBytes) || (round > 0 && currentMessages.length > PROXY_WRAP_MESSAGES);
    const headers = { 'Content-Type': 'application/json' };
    if (isNative && getServerUrl()) {
      const token = getAuthToken();
      if (token) headers['Authorization'] = `Bearer ${token}`;
    } else {
      const csrf = localStorage.getItem('nt:csrf');
      if (csrf) headers['X-CSRF-Token'] = csrf;
    }
    const res = await fetch(apiUrl('/api/ai/chat'), {
      method: 'POST',
      credentials: 'include',
      headers,
      // Out of rounds: told to answer in the system prompt, and the server
      // turns the tools off (one that doesn't yet still gets the prompt).
      body: JSON.stringify(last && tools?.length
        ? { messages: currentMessages, systemPrompt: `${systemPrompt}\n\n${OUT_OF_ROUNDS}${dropped.length ? `\n\n${TOOLS_DROPPED} ${dropped.join(', ')}.` : ''}`, tools, toolChoice: 'none' }
        : { messages: currentMessages, systemPrompt, tools }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (res.status === 401) throw new Error('Not signed in — sign in again to use AI features.');
      throw _inLanguage(Object.assign(new Error(data.error || `AI proxy error ${res.status}`), { code: data.code }));
    }

    // No tools fired — final reply, return it.
    // The server's model can't use tools and answered without them.
    if (data.toolsUnsupported) onToolsUnsupported?.({ routed: !!data.toolsRouted });
    // A server or model that still asks for a tool: its text, if any, is the answer.
    if (last && tools?.length) return _finalAnswer(data.text || data.assistantMessage?.content);
    if (!data.toolCalls || data.toolCalls.length === 0) {
      return data.text || '';
    }

    // Tools fired: append assistant message verbatim, execute each tool
    // locally, append tool result messages, loop for next round. Calls past
    // what the next request can hold are dropped from it; the model sees
    // what came back and can ask again.
    const room = PROXY_MAX_MESSAGES - currentMessages.length - 1;
    if (room < 1) return _finalAnswer(data.text || data.assistantMessage?.content);
    const toolCalls = data.toolCalls.slice(0, room);
    // Cut by position (the server keeps both lists in the same order), so a
    // server that sends no ids or the same id twice still pairs up.
    const assistant = toolCalls.length < data.toolCalls.length && Array.isArray(data.assistantMessage?.tool_calls)
      ? { ...data.assistantMessage, tool_calls: data.assistantMessage.tool_calls.slice(0, toolCalls.length) }
      : data.assistantMessage;
    // Calls left out are named in the next (last) request, so the model
    // doesn't say they ran.
    dropped.push(...data.toolCalls.slice(room).map(tc => tc.name));
    // Measured before the model's own message: only what the tools answer
    // counts, so calls whose arguments are already sent aren't skipped for nothing.
    const budget = _budget(currentMessages, startBytes);
    currentMessages.push(assistant);
    for (const tc of toolCalls) {
      if (onToolCall) onToolCall(tc.name);
      const result = await _runTool(tc.name, tc.args || {}, budget);
      currentMessages.push({
        role: 'tool',
        tool_call_id: tc.id,
        // Gemini's adapter needs the original tool name to construct a
        // functionResponse part; OpenAI + Claude ignore the name field.
        name: tc.name,
        content: JSON.stringify(result),
      });
    }
  }

  return _finalAnswer(''); // not reached: the last round always answers
}

// ── Default models per provider ───────────────────────────────────────────────
export const AI_PROVIDERS = [
  { value: 'claude',     label: 'Anthropic Claude' },
  { value: 'openai',     label: 'OpenAI'           },
  { value: 'gemini',     label: 'Google Gemini'    },
  { value: 'oai-compat', label: 'OpenAI Compatible' },
];

// Checked against the vendors' model and deprecation pages on 2026-10-09
// (platform.claude.com, developers.openai.com, ai.google.dev). Labels compare
// list prices within each provider. A saved model that is no longer listed
// (Gemini 2.5 is open to existing users only) keeps working: the picker
// shows it as a custom model.
export const AI_MODELS = {
  claude: [
    { value: 'claude-haiku-5-5',  label: 'Claude Haiku 5.5 (fast, cheapest)'  },
    { value: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5 (balanced)'       },
    { value: 'claude-opus-5-5',   label: 'Claude Opus 5.5 (smarter)'          },
    { value: 'claude-fable-5-1',  label: 'Claude Fable 5.1 (most capable)'    },
    { value: 'claude-sonnet-5',   label: 'Claude Sonnet 5 (previous)'         },
    { value: 'claude-opus-5',     label: 'Claude Opus 5 (previous)'           },
    { value: 'claude-fable-5',    label: 'Claude Fable 5 (previous)'          },
    { value: 'claude-opus-4-8',   label: 'Claude Opus 4.8 (previous)'         },
    { value: '__custom__',        label: 'Custom…'                            },
  ],
  // GPT-6.1 Sol and GPT-6 Astra are left out: Trace calls tools through
  // Chat Completions, which those two don't support (only the Responses
  // API does, per their model pages).
  openai: [
    { value: 'gpt-6-luna',    label: 'GPT-6 Luna (fast, cheapest)'   },
    { value: 'gpt-5.6-terra', label: 'GPT-5.6 Terra (balanced)'      },
    { value: 'gpt-5.6-sol',   label: 'GPT-5.6 Sol (most capable)'    },
    { value: 'gpt-5.6-luna',  label: 'GPT-5.6 Luna (previous)'       },
    { value: 'gpt-4o-mini',   label: 'GPT-4o mini (previous)'        },
    { value: 'gpt-4o',        label: 'GPT-4o (previous)'             },
    { value: '__custom__',    label: 'Custom…'                       },
  ],
  gemini: [
    { value: 'gemini-3.1-flash-lite',  label: 'Gemini 3.1 Flash Lite (cheapest)'      },
    { value: 'gemini-3.5-flash-lite',  label: 'Gemini 3.5 Flash Lite (cheap)'         },
    { value: 'gemini-3.8-flash',       label: 'Gemini 3.8 Flash (fast)'               },
    { value: 'gemini-3.1-pro-preview', label: 'Gemini 3.1 Pro Preview (most capable)' },
    { value: 'gemini-3.6-flash',       label: 'Gemini 3.6 Flash (previous)'           },
    { value: '__custom__',             label: 'Custom…'                               },
  ],
};

// Used when no model is chosen. Someone who picked a model keeps it.
export const AI_DEFAULT_MODELS = {
  claude: 'claude-haiku-5-5',
  openai: 'gpt-5.6-luna',
  gemini: 'gemini-3.8-flash',
};

// Model IDs that changed name: a saved old name is sent as the new one.
// gemini-3.1-pro never existed (only the preview does), and Google points
// the shut-down gemini-3-pro-preview at it. gpt-5.6 is the alias of
// gpt-5.6-sol, which the picker now names.
export const AI_MODEL_RENAMES = {
  'gemini-3.1-pro': 'gemini-3.1-pro-preview',
  'gemini-3-pro-preview': 'gemini-3.1-pro-preview',
  'gpt-5.6': 'gpt-5.6-sol',
};
export const renamedModel = (model) => AI_MODEL_RENAMES[model] || model;

// ── Anthropic Claude (with tool use) ─────────────────────────────────────────

async function _callClaudeWithTools(apiKey, model, messages, systemPrompt, tools, onToolCall) {
  const claudeTools = (tools || []).map(t => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters,
  }));

  let currentMessages = [...messages];
  const startBytes = _bytes(currentMessages);

  for (let round = 0; round <= TOOL_ROUNDS; round++) {
    const last = _lastRound(round, currentMessages, startBytes);
    const body = {
      model: model || AI_DEFAULT_MODELS.claude,
      max_tokens: REPLY_MAX_TOKENS,
      // Out of rounds: told to answer in the system prompt, so the
      // conversation itself stays in the order the provider expects.
      system: last ? `${systemPrompt}\n\n${OUT_OF_ROUNDS}` : systemPrompt,
      messages: currentMessages,
    };
    if (claudeTools.length) body.tools = claudeTools;
    // The tools stay declared (the history has tool calls in it), but can't be called.
    if (last && claudeTools.length) body.tool_choice = { type: 'none' };

    // A model that can't write that many is asked again as before (trace-reply.js).
    const res = await sendWithLengthFallback(body, async (b) => {
      const r = await fetchProvider('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true',
        },
        body: JSON.stringify(b),
      });
      return { ok: r.ok, status: r.status, data: await r.json() };
    });
    const data = res.data;
    if (!res.ok) throw new Error(data.error?.message || `Claude API error ${res.status}`);
    const short = stoppedShort('claude', data);
    if (short) throw _stoppedShort(short);

    // Check if response contains tool use
    const toolUses = (data.content || []).filter(b => b.type === 'tool_use');
    const textBlocks = (data.content || []).filter(b => b.type === 'text');
    if (last) return _finalAnswer(textBlocks.map(b => b.text).join('\n'));

    if (toolUses.length === 0 || data.stop_reason !== 'tool_use') {
      // No tool calls — return text
      return textBlocks.map(b => b.text).join('\n') || '';
    }

    // Execute tool calls
    const budget = _budget(currentMessages, startBytes); // before the model's message (see callAIProxy)
    currentMessages.push({ role: 'assistant', content: data.content });
    const toolResults = [];
    for (const tu of toolUses) {
      if (onToolCall) onToolCall(tu.name);
      const result = await _runTool(tu.name, tu.input, budget);
      toolResults.push({ type: 'tool_result', tool_use_id: tu.id, content: JSON.stringify(result) });
    }
    currentMessages.push({ role: 'user', content: toolResults });
  }

  return _finalAnswer(''); // not reached: the last round always answers
}

// ── OpenAI (with function calling) ──────────────────────────────────────────

// Models found unable to use tools, by base URL and model (#259).
const toolSupport = createToolSupportMemory();

async function _callOpenAIWithTools(apiKey, model, messages, systemPrompt, tools, onToolCall, baseUrl = 'https://api.openai.com', onToolsUnsupported) {
  const openaiTools = (tools || []).map(t => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));

  let currentMessages = [
    { role: 'system', content: systemPrompt },
    ...messages,
  ];
  const startBytes = _bytes(currentMessages);

  for (let round = 0; round <= TOOL_ROUNDS; round++) {
    const last = _lastRound(round, currentMessages, startBytes);
    const selectedModel = model || AI_DEFAULT_MODELS.openai;
    const body = {
      model: selectedModel,
      // Out of rounds: told to answer in the system prompt (see Claude above).
      messages: last ? [{ role: 'system', content: `${systemPrompt}\n\n${OUT_OF_ROUNDS}` }, ...currentMessages.slice(1)] : currentMessages,
      ...getOpenAIChatParams({
        baseUrl,
        model: selectedModel,
        hasTools: openaiTools.length > 0,
        maxTokens: REPLY_MAX_TOKENS,
      }),
    };
    if (openaiTools.length) body.tools = openaiTools;
    if (last && openaiTools.length) body.tool_choice = 'none';

    // Some self-hosted endpoints (Ollama in particular) reject the
    // Authorization header when it carries a placeholder key. Only send
    // the header when we actually have a key.
    const headers = { 'Content-Type': 'application/json', 'Accept': 'application/json' };
    if (apiKey && apiKey !== 'no-key') headers['Authorization'] = `Bearer ${apiKey}`;

    // A server that won't take the longer reply is asked again as before.
    const send = (body) => sendWithLengthFallback(body, async (b) => {
      const res = await fetchProvider(`${baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify(b),
      });
      return { ok: res.ok, status: res.status, data: await res.json() };
    });
    // A model that can't use tools gets the request again without them.
    let sent = await sendWithToolFallback(body, send, { memory: toolSupport, baseUrl, model: selectedModel });
    // A server that refuses tool_choice "none" is asked once more without it.
    if (last && !sent.ok && (sent.status === 400 || sent.status === 422) && body.tool_choice) {
      delete body.tool_choice;
      sent = await sendWithToolFallback(body, send, { memory: toolSupport, baseUrl, model: selectedModel });
    }
    const { ok, status, data, toolsDropped, toolsRouted } = sent;
    if (!ok) throw new Error(data.error?.message || `AI API error ${status}`);
    if (toolsDropped) onToolsUnsupported?.({ routed: toolsRouted });
    // Cut off, an answer would be half of one and a tool call half its arguments.
    const short = stoppedShort('openai', data);
    if (short) throw _stoppedShort(short);

    const choice = data.choices[0];
    const msg = choice.message;
    // A server that ignores tool_choice may still ask for a tool on the last
    // round: its text, if any, is the answer.
    if (last) return _finalAnswer(msg.content);

    if (!msg.tool_calls || msg.tool_calls.length === 0) {
      return msg.content || '';
    }

    // Execute tool calls
    const budget = _budget(currentMessages, startBytes); // before the model's message (see callAIProxy)
    currentMessages.push(msg);
    for (const tc of msg.tool_calls) {
      if (onToolCall) onToolCall(tc.function.name);
      const args = JSON.parse(tc.function.arguments || '{}');
      const result = await _runTool(tc.function.name, args, budget);
      currentMessages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(result) });
    }
  }

  return _finalAnswer(''); // not reached: the last round always answers
}

// ── Google Gemini (with function calling) ────────────────────────────────────

// Models Google has shut down or scheduled for shutdown. Saved selections
// pointing at any of these are quietly remapped to the current default so
// users who never opened Settings don't suddenly start hitting 404 / quota=0
// errors. The dropdown auto-migration in SettingsTrace handles the visible
// case; this is the fallback for the no-visit path.
// Shut down per ai.google.dev/gemini-api/docs/deprecations (2026-10-09).
export const GEMINI_RETIRED = new Set([
  'gemini-1.5-flash', 'gemini-1.5-pro',
  'gemini-2.0-flash', 'gemini-2.0-flash-001', 'gemini-2.0-flash-lite', 'gemini-2.0-flash-lite-001',
  'gemini-2.0-flash-lite-preview', 'gemini-2.0-flash-lite-preview-02-05',
  'gemini-2.5-pro-preview-03-25', 'gemini-2.5-pro-preview-05-06', 'gemini-2.5-pro-preview-06-05',
  'gemini-2.5-flash-preview-05-20', 'gemini-2.5-flash-preview-09-25', 'gemini-2.5-flash-lite-preview-09-2025',
  'gemini-3.1-flash-lite-preview',
]);
/** The Gemini model to call for a saved one: renamed ones by their new name, shut-down ones by the default. */
export function geminiModelFor(model) {
  const m = renamedModel(model || AI_DEFAULT_MODELS.gemini);
  return GEMINI_RETIRED.has(m) ? AI_DEFAULT_MODELS.gemini : m;
}

async function _callGeminiWithTools(apiKey, model, messages, systemPrompt, tools, onToolCall) {
  const m = geminiModelFor(model);
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent?key=${apiKey}`;

  const geminiTools = (tools || []).length ? [{
    functionDeclarations: tools.map(t => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    })),
  }] : undefined;

  let contents = messages.map(msg => {
    const parts = [];
    if (msg._image) {
      parts.push({ inlineData: { mimeType: msg._image.mimeType, data: msg._image.base64 } });
    }
    parts.push({ text: typeof msg.content === 'string' ? msg.content : (msg.content || '') });
    return { role: msg.role === 'assistant' ? 'model' : 'user', parts };
  });

  const startBytes = _bytes(contents);

  for (let round = 0; round <= TOOL_ROUNDS; round++) {
    const last = _lastRound(round, contents, startBytes);
    const body = {
      // Out of rounds: told to answer in the system prompt (see Claude above).
      systemInstruction: { parts: [{ text: last ? `${systemPrompt}\n\n${OUT_OF_ROUNDS}` : systemPrompt }] },
      contents,
    };
    if (geminiTools) body.tools = geminiTools;
    if (last && geminiTools) body.toolConfig = { functionCallingConfig: { mode: 'NONE' } };

    const res = await fetchProvider(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error?.message || `Gemini API error ${res.status}`);
    const short = stoppedShort('gemini', data);
    if (short) throw _stoppedShort(short);

    const candidate = data.candidates?.[0];
    const parts = candidate?.content?.parts || [];
    const functionCalls = parts.filter(p => p.functionCall);
    const textParts = parts.filter(p => p.text);
    if (last) return _finalAnswer(textParts.map(p => p.text).join('\n'));

    if (functionCalls.length === 0) {
      return textParts.map(p => p.text).join('\n') || '';
    }

    // Execute function calls
    const budget = _budget(contents, startBytes); // before the model's message (see callAIProxy)
    contents.push({ role: 'model', parts });
    const responseParts = [];
    for (const fc of functionCalls) {
      if (onToolCall) onToolCall(fc.functionCall.name);
      const result = await _runTool(fc.functionCall.name, fc.functionCall.args || {}, budget);
      responseParts.push({ functionResponse: { name: fc.functionCall.name, response: geminiToolResponse(result) } });
    }
    contents.push({ role: 'user', parts: responseParts });
  }

  return _finalAnswer(''); // not reached: the last round always answers
}

// ── Tool execution ───────────────────────────────────────────────────────────

// Rounds of tool calls in one answer. Going through a month of diary days,
// a meals library or a client's weeks takes more than a handful
// (TraceApps/notetrace#34), coaching drafts included; a model that loops
// forever still stops.
export const TOOL_ROUNDS = 12;
// Said to the model when the rounds run out: the answer comes from what it has.
export const OUT_OF_ROUNDS = "You can't call more tools for this request. Answer now from what you found. If you couldn't go through everything you needed to, say so plainly: what you covered and what's left, so the user can ask for the rest or narrow it down.";
// What the tool calls and their answers may add to the conversation, in
// bytes, before Trace wraps up early the same way: in tokens about what a
// 128k-token model can hold, Japanese or Chinese included. A photo the user
// attached is already there and doesn't count.
export const HISTORY_MAX_BYTES = 300000;
const _bytes = (x) => new TextEncoder().encode(JSON.stringify(x)).length;
// The last request: out of rounds, or the tools have added as much as they should.
const _lastRound = (round, history, start) => round === TOOL_ROUNDS || (round > 0 && _bytes(history) - start > HISTORY_MAX_BYTES);
// Said for a tool call left unrun because one round's answers already passed
// HISTORY_MAX_BYTES: a model that asks for many at once can't pass it by much.
export const TOOL_SKIPPED = "Not run: this answer has already gathered as much as it can hold. Answer from what you have, and say what's left.";
// Said in the last request for calls left out to stay under the server's 60 messages.
export const TOOLS_DROPPED = "These tool calls you asked for weren't run, for lack of room:";
const _budget = (history, start) => ({ left: HISTORY_MAX_BYTES - (_bytes(history) - start) });
async function _runTool(name, args, budget) {
  if (budget.left <= 0) return { error: TOOL_SKIPPED };
  const result = await _executeTool(name, args);
  budget.left -= _bytes(JSON.stringify(result)); // as it's sent: a JSON string inside the request
  return result;
}
// The server takes 60 messages in one request (AI_MAX_MESSAGES in
// server/routes/ai.js). A round adds the model's message and one per tool it
// calls, so Trace wraps up past 48, and runs only the calls that fit when a
// model asks for more at once.
const PROXY_MAX_MESSAGES = 60;
const PROXY_WRAP_MESSAGES = 48;

let _toolHandler = null;

/** Register the tool handler (called from Trace.svelte) */
export function setToolHandler(handler) { _toolHandler = handler; }

async function _executeTool(name, args) {
  if (!_toolHandler) return { error: 'Tool handler not registered' };
  try {
    return await _toolHandler(name, args);
  } catch (e) {
    return { error: e.message || 'Tool execution failed' };
  }
}
