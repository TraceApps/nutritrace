const OPENAI_API_ORIGIN = 'https://api.openai.com';
const GPT_56_MODEL = /^gpt-5\.6(?:-|$)/;

/**
 * Return the token/reasoning parameters supported by the target
 * Chat Completions endpoint.
 *
 * OpenAI's current API uses max_completion_tokens. Keep max_tokens for
 * third-party OpenAI-compatible endpoints, many of which have not adopted
 * the newer field.
 */
export function getOpenAIChatParams({ baseUrl, model, hasTools, maxTokens = 4096 }) {
  const isOfficialOpenAI = baseUrl?.replace(/\/+$/, '') === OPENAI_API_ORIGIN;
  if (!isOfficialOpenAI) return { max_tokens: maxTokens };

  const params = { max_completion_tokens: maxTokens };
  // GPT-5.6 Chat Completions requires effective reasoning "none" when
  // function tools are present. This does not disable tools: the supplied
  // tools remain available and tool_choice keeps its default "auto" behavior.
  if (hasTools && GPT_56_MODEL.test(model || '')) {
    params.reasoning_effort = 'none';
  }
  return params;
}
