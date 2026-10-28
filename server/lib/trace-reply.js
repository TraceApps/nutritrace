/**
 * trace-reply.js: how long Trace's replies may be, and telling one that
 * stopped short (TraceApps/notetrace#23). The same file in every Trace app,
 * in src/lib and server/lib; scripts/trace-reply.test.js keeps the two alike.
 */

// Room for a long rewrite, and for a reasoning model's thinking before it
// (the thinking counts toward the limit). 4,096 cut both off: a reasoning
// model could spend it all thinking and give no answer. Every current model
// allows this many, and a provider bills only what the reply uses.
export const REPLY_MAX_TOKENS = 16384;
// What it was before, and what a server is asked again with when it won't
// take that many: vLLM before 0.32 refuses a request whose prompt and reply
// together don't fit its context, and an older model refuses more than it
// can write (Claude 3 Haiku, GPT-4 Turbo: 4,096).
export const FALLBACK_MAX_TOKENS = 4096;

// Words a refusal of the reply length uses: vLLM ("'max_tokens' ... is too
// large"; "you requested 16384 output tokens"; "N in the completion";
// "max_output_tokens=... cannot be greater"), OpenAI ("supports at most 4096
// completion tokens"), Anthropic ("max_tokens: 16384 > 4096"), TGI and
// Together ("max_new_tokens"). Others repeat the number asked for (OpenRouter:
// "16384 in the output"). A prompt that's too long on its own ("maximum
// context length is 8192 tokens") is neither: a shorter reply wouldn't help.
const LENGTH_REFUSED = /max_tokens|max_completion_tokens|max_new_tokens|max_output_tokens|output tokens|completion tokens|in the completion/i;
// A per-minute token limit that counts the reply asked for before it's
// written, smaller than the request (Groq's free tier: "tokens per minute
// (TPM): Limit 6000, Requested 17191", as 413 or 429).
const PER_MINUTE = /tokens per min/i;

/** Did the server refuse the reply length that was asked for (`asked`, when known)? */
export function lengthRefused(status, data, asked) {
  const code = Number(status);
  if (![400, 413, 422, 429].includes(code)) return false;
  const e = data?.error ?? data?.detail ?? data?.message;
  const text = String(typeof e === 'string' ? e : (e?.message ?? JSON.stringify(e ?? '')));
  if (PER_MINUTE.test(text)) return true;
  if (code === 429) return false;
  return LENGTH_REFUSED.test(text) || (Number(asked) > 0 && new RegExp(`\\b${Number(asked)}\\b`).test(text));
}

/**
 * Send a request with `send(body)` ({ ok, status, data }). One that asked
 * for more than 4,096 (max_tokens, or OpenAI's max_completion_tokens) and
 * was refused for it goes once more with 4,096, as it was before.
 */
export async function sendWithLengthFallback(body, send) {
  const first = await send(body);
  if (first.ok) return first;
  const key = body?.max_completion_tokens != null ? 'max_completion_tokens' : 'max_tokens';
  const asked = Number(body?.[key]);
  if (!(asked > FALLBACK_MAX_TOKENS) || !lengthRefused(first.status, first.data, asked)) return first;
  return send({ ...body, [key]: FALLBACK_MAX_TOKENS });
}

/**
 * Send a request with `send(body)` ({ ok, status, data }), and once more,
 * the same request, when the reply came back with no words and no tool call
 * (TraceApps/nutritrace#286). Only this one request goes again: a tool that
 * ran earlier in the turn never runs twice. A second try that fails or
 * throws (a cancel aside) gives the first reply back, so the caller says it
 * was empty.
 */
export async function resendIfEmpty(format, body, send) {
  const first = await send(body);
  if (!first.ok || stoppedShort(format, first.data) !== 'empty') return first;
  let again;
  try { again = await send(body); } catch (e) {
    if (e?.name === 'AbortError') throw e; // stopped by the person: not an empty answer
    return first;
  }
  return again.ok ? again : first;
}

/** One request for a reply: the reply length as above, and an empty reply asked for once more. */
export function sendForReply(format, body, send) {
  return sendWithLengthFallback(body, (b) => resendIfEmpty(format, b, send));
}

// ── The same tool call again (TraceApps/nutritrace#287) ──────────────────
// A stuck model can ask for one tool with the same arguments round after
// round until the rounds run out. A call that changes nothing (a read, a
// name that isn't a tool) gets the answer it already has the second time,
// and the third time the next request is the last, with the tools off. A
// tool that writes (logs, changes) runs every time: two of the same item can
// be meant.

/** A tool call as text: its name and its arguments as JSON with every object's keys in order. */
export function toolCallKey(name, args) {
  let a = args;
  if (typeof a === 'string') { try { a = JSON.parse(a); } catch { /* compared as it came */ } }
  const sorted = (v) => (Array.isArray(v) ? v.map(sorted)
    : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sorted(v[k])])) : v);
  return `${name}\n${JSON.stringify(sorted(a ?? {}))}`;
}

// The answer for a call not run again because it was already made this turn.
export const TOOL_REPEATED = "Not run again: you already made this exact call earlier in this answer, and its result is above. Answer from that result, or call something different.";

/** Said in the last request when a model kept making the same call. */
export function toolStuckNote(name) {
  return `You asked for the same ${name} call with the same arguments three times, so the tools are off now. Answer from what you have, and tell the user you got stuck repeating ${name}, so they can ask another way.`;
}

/**
 * One answer's tool calls. `check(name, args)` is 'run' for a call to make,
 * 'repeat' for the second time the same call comes (answer it with
 * TOOL_REPEATED instead), and 'stuck' from the third time on (the same, and
 * `stuck` names the tool, so the next request is the last). Only calls
 * `readOnly(name)` says change nothing are counted; any other runs every time
 * and starts the count over, since what was read may have changed.
 * `forget(name, args)`: a call that failed (offline, say) can be made once
 * more; one that fails again counts as before.
 */
export function createRepeatGuard(readOnly) {
  const seen = new Map();
  const retried = new Set();
  let stuck = null;
  return {
    check(name, args) {
      if (!readOnly(name)) { seen.clear(); return 'run'; }
      const key = toolCallKey(name, args);
      const times = (seen.get(key) || 0) + 1;
      seen.set(key, times);
      if (times === 1) return 'run';
      if (times === 2) return 'repeat';
      if (!stuck) stuck = name;
      return 'stuck';
    },
    forget(name, args) {
      const key = toolCallKey(name, args);
      if (retried.has(key)) return;
      retried.add(key);
      seen.delete(key);
    },
    get stuck() { return stuck; },
  };
}

// Words, not just spaces: OpenAI's content is a string, or a list of parts.
const hasWords = (text) => typeof text === 'string' && text.trim() !== '';
const contentWords = (content) => Array.isArray(content)
  ? content.some(p => hasWords(typeof p === 'string' ? p : p?.text))
  : hasWords(content);

/**
 * Why a reply stopped short, or null: 'length' when it reached its limit
 * before the end, 'thinking' when a reasoning model gave its reasoning and
 * no answer, 'empty' when it came back with no words and no tool call.
 * `format` is the reply's: 'openai', 'claude' or 'gemini'.
 */
export function stoppedShort(format, data) {
  if (format === 'claude') {
    if (data?.stop_reason === 'max_tokens') return 'length';
    const blocks = Array.isArray(data?.content) ? data.content : [];
    return blocks.some(b => b?.type === 'tool_use' || (b?.type === 'text' && hasWords(b.text))) ? null : 'empty';
  }
  if (format === 'gemini') {
    const candidate = data?.candidates?.[0];
    if (candidate?.finishReason === 'MAX_TOKENS') return 'length';
    const parts = Array.isArray(candidate?.content?.parts) ? candidate.content.parts : [];
    return parts.some(p => p?.functionCall || hasWords(p?.text)) ? null : 'empty';
  }
  const choice = data?.choices?.[0];
  const msg = choice?.message || {};
  if (!contentWords(msg.content) && !msg.tool_calls?.length && (msg.reasoning_content || msg.reasoning)) return 'thinking';
  if (/^(length|max_tokens)$/i.test(String(choice?.finish_reason || ''))) return 'length';
  return msg.tool_calls?.length || contentWords(msg.content) ? null : 'empty';
}

const SAID = {
  length: "The reply was cut off before the end, so it wasn't used. Try again, or ask for less at once.",
  thinking: 'The model gave its reasoning but no answer. Try again, or turn its reasoning down.',
  empty: "The model sent back an empty answer. Anything Trace already did this turn is kept, so check before asking again.",
};

/** The error for a reply that stopped short; its `code` lets the app say it in its own language. */
export function stoppedShortError(why) {
  const e = new Error(SAID[why] || SAID.length);
  e.code = `trace_stopped_${why}`;
  return e;
}
