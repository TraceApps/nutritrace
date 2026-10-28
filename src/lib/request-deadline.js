/**
 * request-deadline.js: how long the web app waits for its server where it
 * has an offline answer of its own (a kept copy to read, an account kept on
 * this device).
 *
 * With no connection a request fails at once and the kept copy answers. A
 * server that takes the connection and never answers (a captive portal, a
 * dead link, a host gone quiet behind a VPN) fails nothing: the request waits
 * on the browser for minutes, and the screen with it. Past these deadlines it
 * counts as no connection, so the same copy takes over within seconds. Once
 * one has run out, the server has gone quiet: reads wait less, and changes
 * go to the outbox without being sent, until anything from the server
 * arrives again or the quiet spell is over.
 *
 * Reads get a deadline unless the app names them slow (the server asks
 * another service, or builds a whole account's export): those wait as long
 * as they take. A read the app names heavy (a whole list, a summary over
 * months) gets longer, for a small server with a big account. A change that
 * is sent waits as long as it takes, as before: one cut off might have
 * landed, and sending it again could make it twice.
 * Same file in all four Trace apps.
 */

/** A read with a kept copy to show instead. */
export const READ_MS = 4000;
/**
 * A read the server works hard for (every note or food, months of stats): a
 * Raspberry Pi with years of data can take several seconds to start
 * answering, and this is long enough for that without leaving a dead
 * connection on screen for long.
 */
export const HEAVY_READ_MS = 10000;
/** A read while the server has just gone quiet. */
export const QUIET_READ_MS = 1500;
/** Who is signed in, when an account is kept on this device to open with. */
export const SIGN_IN_CHECK_MS = 3000;
/** How long the server counts as quiet after a request ran out of time. */
export const QUIET_FOR_MS = 20000;

let _quietAt = 0;

/**
 * A request ran out of time: the server has gone quiet. Not again while it
 * already is, so a server that answers in two seconds, missed once, is asked
 * at full length again when the quiet spell is over instead of never.
 */
export function noteQuiet(now = Date.now()) { if (!isQuiet(now)) _quietAt = now; }
/** Something came back from the server: not quiet. */
export function noteAnswered() { _quietAt = 0; }
export function isQuiet(now = Date.now()) { return _quietAt > 0 && now - _quietAt < QUIET_FOR_MS; }

let _changesOut = 0;
/**
 * A change on its way to the server, counted until it is answered or fails.
 * Sent changes have no deadline, so one can still be waiting when the
 * server is noted quiet.
 */
export async function sendingChange(send) {
  _changesOut++;
  try { return await send(); } finally { _changesOut--; }
}
/**
 * Whether a change goes to the outbox without being sent: while the server
 * is quiet, unless one sent before it is still waiting. Queued past that
 * one, it would land first, and the older one, queued when it fails, would
 * land last over it.
 */
export function queueUnsent(now = Date.now()) { return isQuiet(now) && _changesOut === 0; }
/** How long a read with a kept copy waits right now. */
export function readDeadlineMs(now = Date.now()) { return isQuiet(now) ? QUIET_READ_MS : READ_MS; }
/**
 * The same for a read the app has named: 'slow' waits as long as it takes
 * (null), 'heavy' gets HEAVY_READ_MS, anything else READ_MS. While the server
 * is quiet, all but slow ones get QUIET_READ_MS.
 */
export function readDeadlineFor(kind, now = Date.now()) {
  if (kind === 'slow') return null;
  if (isQuiet(now)) return QUIET_READ_MS;
  return kind === 'heavy' ? HEAVY_READ_MS : READ_MS;
}

/**
 * The signal for a request that may wait `ms`, cut short by the caller's own
 * signal too. Without `ms`, or in a browser that can't time a request, the
 * caller's signal as it was.
 */
export function deadlineSignal(ms, signal) {
  if (!ms || typeof AbortSignal === 'undefined' || typeof AbortSignal.timeout !== 'function') return signal;
  const timer = AbortSignal.timeout(ms);
  if (!signal) return timer;
  return typeof AbortSignal.any === 'function' ? AbortSignal.any([signal, timer]) : signal;
}

/**
 * A deadline for the server's first answer only, for the API layers: once
 * the answer starts (`done()`, called when fetch resolves), a long body still
 * downloads at its own pace on a slow connection. Cut short by the caller's
 * own signal too. Without `ms`, the caller's signal as it was.
 */
export function startDeadline(ms, signal) {
  if (!ms || typeof AbortController === 'undefined') return { signal, done() {} };
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(new DOMException('The server did not answer in time.', 'TimeoutError')), ms);
  // The caller's own stop, until the answer starts: then the listener goes,
  // so a signal kept for many requests doesn't gather one per request.
  const stop = () => { clearTimeout(timer); ctl.abort(signal.reason); };
  const done = () => { clearTimeout(timer); signal?.removeEventListener('abort', stop); };
  if (signal?.aborted) stop();
  else signal?.addEventListener('abort', stop, { once: true });
  return { signal: ctl.signal, done };
}

/**
 * fetch(url, init) with a deadline for its first answer (startDeadline). Any
 * answer means the server is there (noteAnswered); one that ran out of time
 * throws as no connection (noAnswerError).
 */
export async function fetchWithDeadline(send, url, init = {}, ms = null) {
  const deadline = startDeadline(ms, init.signal);
  const isChange = !['GET', 'HEAD', 'OPTIONS'].includes(String(init.method || 'GET').toUpperCase());
  const go = () => send(url, deadline.signal ? { ...init, signal: deadline.signal } : init);
  try {
    const res = await (isChange ? sendingChange(go) : go());
    noteAnswered();
    return res;
  } catch (err) {
    throw noAnswerError(err);
  } finally {
    deadline.done();
  }
}

/** A request stopped by its deadline (not by its caller, which is an AbortError). */
export function isDeadlineError(err) {
  return err?.name === 'TimeoutError';
}

/**
 * The error to throw for a failed request: one that ran out of time is no
 * connection (`offline`), and the server is noted as quiet.
 */
export function noAnswerError(err, now = Date.now()) {
  if (!isDeadlineError(err)) return err;
  noteQuiet(now);
  const e = new Error('Your server did not answer in time.');
  e.name = 'TimeoutError';
  e.offline = true;
  e.cause = err;
  return e;
}
