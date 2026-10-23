const OPENAI_API_ORIGIN = 'https://api.openai.com';
// GPT-6 Luna has the same rule (its model page, 2026-10-09).
const GPT_56_MODEL = /^(?:gpt-5\.6|gpt-6-luna)(?:-|$)/;

/**
 * Return the token/reasoning parameters supported by the target
 * Chat Completions endpoint.
 *
 * OpenAI's current API uses max_completion_tokens. Keep max_tokens for
 * third-party OpenAI-compatible endpoints, many of which have not adopted
 * the newer field.
 *
 * `stream: false` is OpenAI's default, but some compatible gateways stream
 * when the field is missing, and the reply then fails to parse as JSON
 * (TraceApps/nutritrace#258). Every caller reads one JSON reply, so say so.
 */
/**
 * The address /v1/chat/completions goes after. A provider's docs (and
 * OpenAI's own SDKs) often give it ending in /v1, or as the whole endpoint;
 * either way the part before it is used, so /v1 isn't doubled
 * (TraceApps/notetrace#18).
 */
export function openAIBase(url) {
  return String(url || '').trim()
    .replace(/\/+$/, '')
    .replace(/\/chat\/completions$/i, '')
    .replace(/\/v1$/i, '');
}

export function getOpenAIChatParams({ baseUrl, model, hasTools, maxTokens = 4096 }) {
  const isOfficialOpenAI = openAIBase(baseUrl) === OPENAI_API_ORIGIN;
  if (!isOfficialOpenAI) return { stream: false, max_tokens: maxTokens };

  const params = { stream: false, max_completion_tokens: maxTokens };
  // GPT-5.6 (and GPT-6 Luna) Chat Completions requires effective reasoning "none" when
  // function tools are present. This does not disable tools: the supplied
  // tools remain available and tool_choice keeps its default "auto" behavior.
  if (hasTools && GPT_56_MODEL.test(model || '')) {
    params.reasoning_effort = 'none';
  }
  return params;
}
