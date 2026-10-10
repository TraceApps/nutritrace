// Models that can't use tools, on OpenAI-compatible endpoints
// (TraceApps/nutritrace#259). The same file in src/lib and server/lib of
// every Trace app that has it: change one, change them all.
//
// Trace sends its tools with every chat request. A model without tool
// support makes the endpoint refuse the whole request, so the user got an
// error instead of an answer. When the refusal says so, the same request
// goes once more without tools, and the model is remembered as tool-less
// for a short while so the next messages skip the doomed first attempt.

// The refusals real servers send, checked against their source, a running
// server or published reports (2026-10-10). Each one names tools, so an
// unrelated 400 never matches.
const TOOL_WORDS = '(?:tools?|tool use|tool calls?|tool calling|tool messages|functions?|function calls?|function calling)';
const TOOLS_UNSUPPORTED = [
  // The reporter's gateway: {"error_type":"TOOL_USE_NOT_SUPPORTED", "message":
  // "invalid request: tool use is not supported by the provided model: ..."}
  /tool_use_not_supported/,
  // OpenAI: "Unsupported parameter: 'tools' is not supported with this model."
  // Mistral: "Function calling is not enabled for this model."
  // Also "Tool messages are not supported", "Functions are not supported".
  new RegExp(`\\b${TOOL_WORDS}\\W{0,3}\\s+(?:is|are)\\s+not\\s+(?:supported|enabled|available)\\b`),
  // Ollama: "registry.ollama.ai/library/gemma3:270m does not support tools".
  // Also DeepSeek and SambaNova ("does not support tool use").
  new RegExp(`\\bdoes\\s+not\\s+support\\s+${TOOL_WORDS}\\b`),
  // LiteLLM: "<provider> does not support parameters: ['tools', 'tool_choice'], for model=..."
  /does not support parameters:[^\]]*\btools\b/,
  // Azure OpenAI: "Unrecognized request argument supplied: tools"
  /unrecognized request arguments? supplied:[^.]*\btools\b/,
  // vLLM started without a tool parser: "\"auto\" tool choice requires
  // --enable-auto-tool-choice and --tool-call-parser to be set"
  /tool choice requires --enable-auto-tool-choice/,
  // OpenRouter, when no provider of the model takes tools (a 404).
  /no endpoints found that support tool use/,
  // A strict server that forbids the field (pydantic, as text):
  // [{'type': 'extra_forbidden', 'loc': ('body', 'tools'), ...}]
  /extra_forbidden['"]?\s*,\s*['"]loc['"]\s*:\s*[([]\s*['"]body['"]\s*,\s*['"]tools['"]/,
];
// The ones that are certain enough to trust with any 5xx too: the status
// the reporter's gateway answers with is not known, and llama.cpp started
// without --jinja answers with a 500.
const TOOLS_UNSUPPORTED_5XX = [
  /tool_use_not_supported/,
  /\bdoes\s+not\s+support\s+tools\b/,
  /tools param requires --jinja/,
];

// The model a refusal names, when it names one.
const NAMED_MODEL = [
  /provided model:\s*([^\s"'\\,;)}\]]+)/,
  /for model=([^\s"'\\,;)}\]]+?)\.?(?=[\s"'\\,;)}\]]|$)/,
  new RegExp(`([\\w.:/@-]+)\\s+does\\s+not\\s+support\\s+${TOOL_WORDS}\\b`),
];

// Echoes of the request (a validation error that repeats what was sent)
// are left out, so a user's own words can never look like a refusal.
const ECHOES = [
  /input_value=(?:'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|\[[^\]]*\]|\{[^}]*\}|[^,\]]*)/g,
  /\\?['"]input\\?['"]\s*:\s*(?:\\?'(?:[^'\\]|\\.)*?\\?'|\\?"(?:[^"\\]|\\.)*?\\?"|\[[^\]]*\]|\{[^}]*\}|[^,}\]]*)/g,
];

/** The texts of an error body that explain it, echoes left out. */
function _errorTexts(body) {
  const out = [];
  const add = (v) => { if (typeof v === 'string' && v) out.push(v); };
  if (typeof body === 'string') add(body);
  else if (body && typeof body === 'object') {
    const err = body.error;
    if (typeof err === 'string') add(err);
    else if (err && typeof err === 'object') { add(err.message); add(err.code); add(err.type); }
    add(body.message);
    add(body.error_type);
    add(body.code);
    if (typeof body.detail === 'string') add(body.detail);
    else if (Array.isArray(body.detail)) for (const d of body.detail) add(d?.msg);
    // Nothing that explains it: the body itself, as a last resort.
    if (!out.length) { try { add(JSON.stringify(body)); } catch { /* not JSON */ } }
  }
  return out.map(t => ECHOES.reduce((s, re) => s.replace(re, ''), t.toLowerCase()));
}

// A strict server that forbids the field (pydantic/FastAPI, as JSON):
// {"detail": [{"type": "extra_forbidden", "loc": ["body", "tools"], ...}]}
function _toolsForbidden(body) {
  return Array.isArray(body?.detail) && body.detail.some(d =>
    Array.isArray(d?.loc) && d.loc.includes('tools') && /^(?:extra_forbidden|value_error\.extra)$/.test(String(d.type || '')));
}

/**
 * Whether a failed Chat Completions response says the model can't use
 * tools, and which model it names (null when it names none). `body` is the
 * parsed error body (or its text). Null when it is not such a refusal.
 */
export function toolsRefusal(status, body) {
  const fivexx = status >= 500 && status <= 599;
  if (![400, 404, 422].includes(status) && !fivexx) return null;
  const texts = _errorTexts(body);
  const err = body && typeof body === 'object' ? body.error : null;
  const found = fivexx
    ? texts.some(t => TOOLS_UNSUPPORTED_5XX.some(re => re.test(t)))
    : (err && typeof err === 'object' && err.param === 'tools' && /unsupported/.test(String(err.code || err.type || '')))
      || _toolsForbidden(body)
      || texts.some(t => TOOLS_UNSUPPORTED.some(re => re.test(t)));
  if (!found) return null;
  for (const t of texts) {
    for (const re of NAMED_MODEL) {
      const name = re.exec(t)?.[1];
      // "This model does not support tools" names no model.
      if (name && /[\d:/._-]/.test(name)) return { model: name };
    }
  }
  return { model: null };
}

/** Whether a failed Chat Completions response says the model can't use tools. */
export function isToolsUnsupported(status, body) {
  return toolsRefusal(status, body) !== null;
}

// Ollama names "registry.ollama.ai/library/gemma3:latest" for "gemma3".
const _modelKey = (m) => String(m || '').toLowerCase().split('/').pop().replace(/:latest$/, '');

/**
 * Whether the refusal names a model other than the one asked for: a
 * gateway that routes one name to many models (a combo) refused for one of
 * them, and the next request may well go to one that takes tools.
 */
export function isOtherModel(named, asked) {
  return !!named && !!asked && _modelKey(named) !== _modelKey(asked);
}

// How long a model counts as tool-less. Short on purpose: a gateway that
// picks a model per request can send the next request to a model that
// takes tools, and that one should get them back soon. A doomed first
// attempt costs one quick refusal (0.3 s in the report), so remembering
// longer saves little.
export const TOOLLESS_TTL_MS = 5 * 60_000;
const TOOLLESS_MAX = 32;

/** Tool-less models by base URL and model, in memory, expiring, bounded. */
export function createToolSupportMemory({ ttlMs = TOOLLESS_TTL_MS, max = TOOLLESS_MAX, now = () => Date.now() } = {}) {
  const until = new Map();
  const key = (baseUrl, model) => `${String(baseUrl || '').replace(/\/+$/, '')} ${model || ''}`;
  return {
    remember(baseUrl, model) {
      const k = key(baseUrl, model);
      until.delete(k);
      until.set(k, now() + ttlMs);
      while (until.size > max) until.delete(until.keys().next().value);
    },
    isToolless(baseUrl, model) {
      const k = key(baseUrl, model);
      const t = until.get(k);
      if (t === undefined) return false;
      if (t > now()) return true;
      until.delete(k);
      return false;
    },
    get size() { return until.size; },
  };
}

/**
 * OpenAI-shape messages with earlier tool rounds written out as plain text,
 * for a model that is sent no tools: a tool call becomes a line in the
 * assistant's message, and its results a user message, so the model still
 * sees what was looked up.
 */
export function withoutToolHistory(messages) {
  if (!Array.isArray(messages) || !messages.some(m => m?.role === 'tool' || m?.tool_calls?.length)) return messages;
  const names = new Map();
  const out = [];
  for (const m of messages) {
    if (m?.role === 'assistant' && m.tool_calls?.length) {
      const lines = [];
      if (typeof m.content === 'string' && m.content) lines.push(m.content);
      for (const tc of m.tool_calls) {
        if (tc?.id && tc.function?.name) names.set(tc.id, tc.function.name);
        lines.push(`[Called ${tc?.function?.name || 'a tool'} with ${tc?.function?.arguments || '{}'}]`);
      }
      out.push({ role: 'assistant', content: lines.join('\n') });
      continue;
    }
    if (m?.role === 'tool') {
      const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? null);
      const line = `[Result of ${m.name || names.get(m.tool_call_id) || 'a tool'}: ${content}]`;
      const last = out[out.length - 1];
      if (last?._toolResults) last.content += `\n${line}`;
      else out.push({ role: 'user', content: line, _toolResults: true });
      continue;
    }
    out.push(m);
  }
  return out.map(m => {
    if (!m._toolResults) return m;
    const { _toolResults: _r, ...rest } = m;
    return rest;
  });
}

// The system prompt asks for tools; without them a model could claim it
// logged or looked up something that never happened.
export const NO_TOOLS_NOTE = "No tools are available for this request: don't say you logged, saved, changed or looked anything up; answer from what's above.";

function _withNoToolsNote(messages) {
  const list = Array.isArray(messages) ? messages : [];
  const i = list.findIndex(m => m?.role === 'system');
  if (i < 0) return [{ role: 'system', content: NO_TOOLS_NOTE }, ...list];
  const m = list[i];
  const content = typeof m.content === 'string' && m.content ? `${m.content}\n\n${NO_TOOLS_NOTE}`
    : Array.isArray(m.content) ? [...m.content, { type: 'text', text: NO_TOOLS_NOTE }]
    : NO_TOOLS_NOTE;
  return list.map((x, j) => (j === i ? { ...m, content } : x));
}

/**
 * A Chat Completions request body without tools: no tools or tool_choice,
 * tool history as text, and a line in the system prompt that says so.
 */
export function withoutTools(body) {
  const { tools: _t, tool_choice: _c, parallel_tool_calls: _p, ...rest } = body;
  return { ...rest, messages: _withNoToolsNote(withoutToolHistory(rest.messages)) };
}

/**
 * Send a Chat Completions request through `send(body)`, which resolves to
 * `{ ok, status, data }`. A request with tools to a model that can't use
 * them is sent again without them (or straight away without them, while
 * the model is remembered as tool-less). `toolsDropped` says the answer
 * came without tools; `toolsRouted` says the refusal named another model
 * than the one asked for (a gateway routing one name to many models),
 * which is then not remembered.
 */
export async function sendWithToolFallback(body, send, { memory, baseUrl, model }) {
  if (!Array.isArray(body.tools) || body.tools.length === 0) return { ...(await send(body)), toolsDropped: false, toolsRouted: false };
  if (memory.isToolless(baseUrl, model)) return { ...(await send(withoutTools(body))), toolsDropped: true, toolsRouted: false };
  const first = await send(body);
  const refusal = first.ok ? null : toolsRefusal(first.status, first.data);
  if (!refusal) return { ...first, toolsDropped: false, toolsRouted: false };
  const routed = isOtherModel(refusal.model, body.model || model);
  const second = await send(withoutTools(body));
  if (second.ok && !routed) memory.remember(baseUrl, model);
  return { ...second, toolsDropped: true, toolsRouted: routed };
}

// ── In the conversation ─────────────────────────────────────────────────

export const TOOLS_NOTE = 'tools-unsupported';

/**
 * Says once per conversation that the model can't use tools, as a note in
 * the conversation (role 'note': shown to the person, never sent to a
 * model). reset() when the conversation is cleared.
 */
export function createToolsNotice() {
  let shown = false;
  return {
    add(messages, content) {
      if (shown || messages.some(m => m?.note === TOOLS_NOTE)) { shown = true; return messages; }
      shown = true;
      return [...messages, { role: 'note', note: TOOLS_NOTE, content }];
    },
    reset() { shown = false; },
    get shown() { return shown; },
  };
}

/** The messages a model is sent: notes are for the person, not the model. */
export function forModel(messages) {
  return messages.filter(m => m?.role !== 'note');
}
