// Tool results on their way to a provider. The same file in NutriTrace and
// LiftTrace: change one, change both.
//
// The app echoes each tool's name on its `role: 'tool'` messages, because
// Gemini answers a tool call by name. OpenAI's tool messages have no `name`
// (role, content, tool_call_id), and strict OpenAI-compatible endpoints
// refuse it (TraceApps/nutritrace#259), so it comes off before the messages
// go to one. Gemini gets the name through its own translator instead.

/** The messages as an OpenAI-compatible endpoint accepts them. */
export function toolMessagesForOpenAI(messages) {
  return messages.map(m => {
    if (m?.role !== 'tool' || !('name' in m)) return m;
    const { name: _name, ...rest } = m;
    return rest;
  });
}

/**
 * The tool's name for a `role: 'tool'` message: the name it carries, else
 * the name on the assistant's tool call it answers.
 */
export function toolNameFor(message, toolCallNames) {
  return message.name || toolCallNames.get(message.tool_call_id) || '';
}

/** Remember the names of the tool calls in an assistant message, by id. */
export function rememberToolCalls(message, toolCallNames) {
  for (const tc of message?.tool_calls || []) {
    if (tc?.id && tc.function?.name) toolCallNames.set(tc.id, tc.function.name);
  }
}
