/**
 * AI Chat — multi-provider API layer with tool use (function calling)
 * Supports: Anthropic Claude, OpenAI, Google Gemini
 * All calls made client-side using the user's own API key.
 *
 * Tool use flow:
 * 1. Send messages + tool definitions to AI
 * 2. If AI responds with tool_use, execute the tool and send result back
 * 3. Repeat until AI responds with text (max 5 tool rounds)
 */

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
    description: 'Get the food diary for ONE specific date only. Returns meals + food items (portions, quantities, brand, per-item notes), nutrition breakdown (calories, protein, carbs, fat), body stats (with explicit `weight_unit` / `length_unit` so you don\'t guess), water intake (ml), any free-text "day notes" the user wrote (sleep, energy, cravings, context), and any manually-logged activities for that day (name, kcal burned, duration, distance, source). DO NOT use this tool for streak questions, "how many days have I been logging", "when did I start tracking", consecutive-day counts, or any multi-day aggregate — for those use get_logging_streak (streak) or get_diary_averages (averages over a window). This tool is for a single calendar date only.',
    parameters: {
      type: 'object',
      properties: {
        date: { type: 'string', description: 'Date (YYYY-MM-DD)' },
      },
      required: ['date'],
    },
  },
  {
    name: 'get_meals',
    description: 'Get the user\'s saved Meals and Recipes from their library. Returns each one with its items (portions, quantities, per-item notes), totals (calories, macros), and any meal-level notes. Useful when the user refers to a saved meal by name ("my usual breakfast") or wants ideas based on meals they\'ve logged before.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Optional case-insensitive name filter. Omit to return all (capped at 50).' },
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
    description: 'Log an exercise/activity entry to the user\'s Diary Activity section. Use this when the user describes a workout or physical activity ("I hiked 10 miles", "did 45 min of yoga"). Each entry offsets the day\'s calorie goal per the user\'s policy. If the user provides a calorie number, pass it as kcal and use source="user_stated". If you estimated kcal from body profile + duration/MET, use source="ai_estimated" and tell the user the estimate so they can correct it. Do NOT call this tool if the activityAutoEstimate setting is off and the user did not supply a calorie number — ask them for one instead.',
    parameters: {
      type: 'object',
      properties: {
        date:         { type: 'string', description: 'Date the activity happened (YYYY-MM-DD). Defaults to today if omitted.' },
        name:         { type: 'string', description: 'Short label for the activity, e.g. "Morning hike", "Yoga", "Bike commute".' },
        kcal:         { type: 'number', description: 'Calories burned (positive integer).' },
        duration_min: { type: 'number', description: 'Optional duration in minutes.' },
        distance:     { type: 'string', description: 'Optional free-text distance, e.g. "10 mi" or "5 km".' },
        source:       { type: 'string', description: 'Provenance: "user_stated" if the user gave a number, "ai_estimated" if you computed it.' },
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
    name: 'log_quick_calories',
    description: 'Log a Fitbit/MFP-style "Quick Calories" entry to the user\'s diary — a row with calories and optionally protein/carbs/fat, but no food, no portion. Use this when the user says something like "log 200 calories for lunch", "add 1200 kJ to dinner", "punch in 350 quick calories", or "log 240 kcal with 20g protein and 30g carbs for snack". Only the calorie value is required; macros are optional and only stored when the user explicitly mentions them. Optional short name (e.g. "Office snack") helps the user remember the entry later. If the user gives kJ, convert to kcal yourself (1 kcal = 4.184 kJ) and pass the kcal number. Returns { error } if the user has disabled Quick Calories in Settings → Diary.',
    parameters: {
      type: 'object',
      properties: {
        meal:      { type: 'number', description: 'Meal index: 0=breakfast, 1=lunch, 2=dinner, 3=snacks (or whatever custom meal names the user has set, by position). Defaults to 3 (snacks) if not clearly stated.' },
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

// ── Main entry point ─────────────────────────────────────────────────────────

export async function callAI({ provider, apiKey, model, messages, systemPrompt, tools, onToolCall, baseUrl }) {
  // The 'oai-compat' provider points at any /v1/chat/completions endpoint
  // (Ollama, LM Studio, LocalAI, vLLM, DeepSeek, Groq, Together AI, etc.)
  // Local endpoints don't need an API key; cloud ones do. Other providers
  // still require a key.
  if (!apiKey && provider !== 'oai-compat') {
    throw new Error('No API key configured. Add one in Settings → AI Assistant.');
  }
  switch (provider) {
    case 'claude':     return _callClaudeWithTools(apiKey, model, messages, systemPrompt, tools, onToolCall);
    case 'openai':     return _callOpenAIWithTools(apiKey, model, messages, systemPrompt, tools, onToolCall, 'https://api.openai.com');
    case 'gemini':     return _callGeminiWithTools(apiKey, model, messages, systemPrompt, tools, onToolCall);
    case 'oai-compat': {
      if (!baseUrl) throw new Error('OpenAI Compatible provider needs a Base URL. Set one in Settings → AI Assistant.');
      if (!model)   throw new Error('OpenAI Compatible provider needs a model name. Set one in Settings → AI Assistant.');
      return _callOpenAIWithTools(apiKey || 'no-key', model, messages, systemPrompt, tools, onToolCall, baseUrl.replace(/\/+$/, ''));
    }
    default: throw new Error(`Unknown AI provider: ${provider}`);
  }
}

/**
 * Server-side proxy call — used when AI config is env-locked.
 * The API key stays on the server; only messages + systemPrompt are sent.
 *
 * Auth: PWA uses cookies + CSRF; native server mode uses a Bearer token
 * (cookies don't persist across the Android WebView's reloads). Matches the
 * pattern in api.js#_fetch — without the Bearer header, env-locked AI calls
 * from Android return 401 even though the chat path looks fine in the UI.
 */
export async function callAIProxy({ messages, systemPrompt }) {
  const { apiUrl, isNative, getServerUrl, getAuthToken } = await import('./platform.js');
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
    body: JSON.stringify({ messages, systemPrompt }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401) throw new Error('Not signed in — sign in again to use AI features.');
    throw new Error(data.error || `AI proxy error ${res.status}`);
  }
  return data.text;
}

// ── Default models per provider ───────────────────────────────────────────────
export const AI_PROVIDERS = [
  { value: 'claude',     label: 'Anthropic Claude' },
  { value: 'openai',     label: 'OpenAI'           },
  { value: 'gemini',     label: 'Google Gemini'    },
  { value: 'oai-compat', label: 'OpenAI Compatible' },
];

export const AI_MODELS = {
  claude: [
    { value: 'claude-haiku-4-5-20251001', label: 'Claude Haiku (fast, cheap)' },
    { value: 'claude-sonnet-4-6',         label: 'Claude Sonnet (smarter)'    },
  ],
  openai: [
    { value: 'gpt-4o-mini', label: 'GPT-4o mini (fast, cheap)' },
    { value: 'gpt-4o',      label: 'GPT-4o (smarter)'          },
  ],
  gemini: [
    { value: 'gemini-2.5-flash-lite', label: 'Gemini 2.5 Flash Lite (cheapest)' },
    { value: 'gemini-2.5-flash',      label: 'Gemini 2.5 Flash (fast, cheap)'   },
    { value: 'gemini-2.5-pro',        label: 'Gemini 2.5 Pro (smarter)'         },
  ],
};

export const AI_DEFAULT_MODELS = {
  claude: 'claude-haiku-4-5-20251001',
  openai: 'gpt-4o-mini',
  gemini: 'gemini-2.5-flash',
};

// ── Anthropic Claude (with tool use) ─────────────────────────────────────────

async function _callClaudeWithTools(apiKey, model, messages, systemPrompt, tools, onToolCall) {
  const claudeTools = (tools || []).map(t => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters,
  }));

  let currentMessages = [...messages];
  const MAX_ROUNDS = 5;

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const body = {
      model: model || AI_DEFAULT_MODELS.claude,
      max_tokens: 4096,
      system: systemPrompt,
      messages: currentMessages,
    };
    if (claudeTools.length) body.tools = claudeTools;

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error?.message || `Claude API error ${res.status}`);

    // Check if response contains tool use
    const toolUses = (data.content || []).filter(b => b.type === 'tool_use');
    const textBlocks = (data.content || []).filter(b => b.type === 'text');

    if (toolUses.length === 0 || data.stop_reason !== 'tool_use') {
      // No tool calls — return text
      return textBlocks.map(b => b.text).join('\n') || '';
    }

    // Execute tool calls
    currentMessages.push({ role: 'assistant', content: data.content });
    const toolResults = [];
    for (const tu of toolUses) {
      if (onToolCall) onToolCall(tu.name);
      const result = await _executeTool(tu.name, tu.input);
      toolResults.push({ type: 'tool_result', tool_use_id: tu.id, content: JSON.stringify(result) });
    }
    currentMessages.push({ role: 'user', content: toolResults });
  }

  throw new Error('Too many tool call rounds');
}

// ── OpenAI (with function calling) ──────────────────────────────────────────

async function _callOpenAIWithTools(apiKey, model, messages, systemPrompt, tools, onToolCall, baseUrl = 'https://api.openai.com') {
  const openaiTools = (tools || []).map(t => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));

  let currentMessages = [
    { role: 'system', content: systemPrompt },
    ...messages,
  ];
  const MAX_ROUNDS = 5;

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const body = {
      model: model || AI_DEFAULT_MODELS.openai,
      max_tokens: 4096,
      messages: currentMessages,
    };
    if (openaiTools.length) body.tools = openaiTools;

    // Some self-hosted endpoints (Ollama in particular) reject the
    // Authorization header when it carries a placeholder key. Only send
    // the header when we actually have a key.
    const headers = { 'Content-Type': 'application/json' };
    if (apiKey && apiKey !== 'no-key') headers['Authorization'] = `Bearer ${apiKey}`;

    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error?.message || `AI API error ${res.status}`);

    const choice = data.choices[0];
    const msg = choice.message;

    if (!msg.tool_calls || msg.tool_calls.length === 0) {
      return msg.content || '';
    }

    // Execute tool calls
    currentMessages.push(msg);
    for (const tc of msg.tool_calls) {
      if (onToolCall) onToolCall(tc.function.name);
      const args = JSON.parse(tc.function.arguments || '{}');
      const result = await _executeTool(tc.function.name, args);
      currentMessages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(result) });
    }
  }

  throw new Error('Too many tool call rounds');
}

// ── Google Gemini (with function calling) ────────────────────────────────────

// Models Google has shut down or scheduled for shutdown. Saved selections
// pointing at any of these are quietly remapped to the current default so
// users who never opened Settings don't suddenly start hitting 404 / quota=0
// errors. The dropdown auto-migration in SettingsTrace handles the visible
// case; this is the fallback for the no-visit path.
const GEMINI_RETIRED = new Set([
  'gemini-1.5-flash', 'gemini-1.5-pro',
  'gemini-2.0-flash', 'gemini-2.0-flash-lite',
]);

async function _callGeminiWithTools(apiKey, model, messages, systemPrompt, tools, onToolCall) {
  let m = model || AI_DEFAULT_MODELS.gemini;
  if (GEMINI_RETIRED.has(m)) m = AI_DEFAULT_MODELS.gemini;
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

  const MAX_ROUNDS = 5;

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const body = {
      systemInstruction: { parts: [{ text: systemPrompt }] },
      contents,
    };
    if (geminiTools) body.tools = geminiTools;

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error?.message || `Gemini API error ${res.status}`);

    const candidate = data.candidates?.[0];
    const parts = candidate?.content?.parts || [];
    const functionCalls = parts.filter(p => p.functionCall);
    const textParts = parts.filter(p => p.text);

    if (functionCalls.length === 0) {
      return textParts.map(p => p.text).join('\n') || '';
    }

    // Execute function calls
    contents.push({ role: 'model', parts });
    const responseParts = [];
    for (const fc of functionCalls) {
      if (onToolCall) onToolCall(fc.functionCall.name);
      const result = await _executeTool(fc.functionCall.name, fc.functionCall.args || {});
      responseParts.push({ functionResponse: { name: fc.functionCall.name, response: result } });
    }
    contents.push({ role: 'user', parts: responseParts });
  }

  throw new Error('Too many tool call rounds');
}

// ── Tool execution ───────────────────────────────────────────────────────────

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
