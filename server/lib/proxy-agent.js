/**
 * proxy-agent.js: the server's outbound fetch, and forward-proxy support (#177).
 *
 * Every fetch the server makes goes through the undici package, not the
 * copy built into Node: that one (undici 7 in Node 24) crashes the whole
 * process when a site closes the connection while a reply waits to be
 * read (TraceApps/cooktrace#96, nodejs/undici#5360), and undici 8 doesn't.
 * FormData comes along, as undici's fetch only takes its own (Node's would
 * go out as the text "[object FormData]"). Request, Response and Headers
 * stay Node's: undici's fetch takes Node's Headers, and the MCP server
 * builds on Node's Request and Response.
 *
 * Node's fetch doesn't honor the standard HTTP_PROXY / HTTPS_PROXY /
 * NO_PROXY environment variables, so when any is set an undici
 * EnvHttpProxyAgent becomes the global dispatcher. With none set, fetches
 * go straight out.
 *
 * Env vars honored (standard *nix / curl / requests convention):
 *   HTTP_PROXY   http://proxy.example:3128
 *   HTTPS_PROXY  http://proxy.example:3128    (typically same as HTTP_PROXY)
 *   NO_PROXY     localhost,127.0.0.1,.internal,off-mirror.local
 *
 * Lowercase variants (http_proxy, https_proxy, no_proxy) are ALSO
 * honored: EnvHttpProxyAgent checks both cases.
 *
 * Imported from server/index.js right after `dotenv/config` so any
 * subsequent module-init outbound fetch already uses it.
 */

import { fetch as undiciFetch, FormData as UndiciFormData, setGlobalDispatcher, EnvHttpProxyAgent } from 'undici';
import { redactUrl } from './redact-url.js';

globalThis.fetch = undiciFetch;
globalThis.FormData = UndiciFormData;

const _upper = process.env.HTTP_PROXY || process.env.HTTPS_PROXY || process.env.NO_PROXY;
const _lower = process.env.http_proxy || process.env.https_proxy || process.env.no_proxy;

if (_upper || _lower) {
  try {
    setGlobalDispatcher(new EnvHttpProxyAgent());
    const active = {
      // A proxy address often carries user:password@: never logged.
      HTTP_PROXY:  redactUrl(process.env.HTTP_PROXY  || process.env.http_proxy  || '(unset)'),
      HTTPS_PROXY: redactUrl(process.env.HTTPS_PROXY || process.env.https_proxy || '(unset)'),
      NO_PROXY:    process.env.NO_PROXY    || process.env.no_proxy    || '(unset)',
    };
    console.log('[server] forward-proxy env vars detected, undici EnvHttpProxyAgent installed:', active);
  } catch (e) {
    const msg = e?.message || String(e);
    // undici's EnvHttpProxyAgent throws a bare 'Invalid URL' when the
    // env value is missing a scheme (e.g. `user:pass@host:3128` instead
    // of `http://user:pass@host:3128`). Nudge users toward the fix
    // rather than making them chase what "Invalid URL" refers to.
    // Reported by @yoyo-san on #177.
    if (/invalid url/i.test(msg)) {
      console.warn(
        '[server] proxy-agent install failed: Invalid URL. HTTP_PROXY / HTTPS_PROXY must include a scheme like ' +
        '"http://user:pass@proxy.host:3128". Bare "host:port" or "user:pass@host:port" is not accepted. ' +
        'See https://traceapps.github.io/docs/self-hosting/env-vars/#value-format'
      );
    } else {
      console.warn('[server] proxy-agent install failed:', redactUrl(msg));
    }
  }
}
