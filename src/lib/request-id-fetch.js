/**
 * Adds a correlation ID to browser/WebView requests sent to the configured
 * NutriTrace server. In verbose diagnostic mode, app and server logs can then
 * be matched by request_id without logging query strings or request bodies.
 */

const REQUEST_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
let installed = false;

function newRequestId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `nt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

function configuredServerUrl() {
  try { return localStorage.getItem('nt:serverUrl') || ''; } catch { return ''; }
}

export function isNutriTraceApiUrl(rawUrl, pageUrl, serverUrl = configuredServerUrl()) {
  let target;
  try { target = new URL(rawUrl, pageUrl); } catch { return false; }
  const apiPath = /(?:^|\/)api(?:\/|$)/.test(target.pathname);
  if (!apiPath) return false;

  let page;
  try { page = new URL(pageUrl); } catch { return false; }
  if (target.origin === page.origin) return true;

  if (serverUrl) {
    try {
      const server = new URL(serverUrl);
      const serverPath = server.pathname.replace(/\/$/, '');
      return target.origin === server.origin
        && (target.pathname === `${serverPath}/api`
          || target.pathname.startsWith(`${serverPath}/api/`));
    } catch {}
  }
  return false;
}

function verboseLoggingEnabled() {
  try { return localStorage.getItem('nt:verboseLogging') === '1'; } catch { return false; }
}

export function installRequestIdFetch() {
  if (installed || typeof window === 'undefined' || typeof window.fetch !== 'function') return;
  installed = true;
  const originalFetch = window.fetch.bind(window);

  window.fetch = async (input, init = {}) => {
    const rawUrl = input instanceof Request ? input.url : String(input);
    if (!isNutriTraceApiUrl(rawUrl, window.location.href)) return originalFetch(input, init);

    const headers = new Headers(input instanceof Request ? input.headers : undefined);
    new Headers(init.headers || {}).forEach((value, key) => headers.set(key, value));
    let id = headers.get('X-Request-ID');
    if (!id || !REQUEST_ID_RE.test(id)) {
      id = newRequestId();
      headers.set('X-Request-ID', id);
    }

    const method = String(init.method || (input instanceof Request ? input.method : 'GET')).toUpperCase();
    const path = (() => { try { return new URL(rawUrl, window.location.href).pathname; } catch { return '[invalid URL]'; } })();
    const startedAt = Date.now();

    try {
      const response = await originalFetch(input, { ...init, headers });
      const responseId = response.headers.get('X-Request-ID') || id;
      const line = `[http] request_id=${responseId} ${method} ${path} → ${response.status} (${Date.now() - startedAt}ms)`;
      if (!response.ok) console.warn(line);
      else if (verboseLoggingEnabled()) console.debug(line);
      return response;
    } catch (error) {
      console.warn(`[http] request_id=${id} ${method} ${path} → failed (${Date.now() - startedAt}ms): ${error?.message || error}`);
      throw error;
    }
  };
}
