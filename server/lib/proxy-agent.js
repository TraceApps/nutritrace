/**
 * proxy-agent.js — forward-proxy support for outbound fetches (#177).
 *
 * Node's built-in fetch (undici under the hood) does NOT honor the
 * standard HTTP_PROXY / HTTPS_PROXY / NO_PROXY environment variables
 * by default, so self-hosters routing outbound traffic through a
 * corporate / homelab proxy have no way to steer the app's
 * outbound HTTP requests.
 *
 * This module installs an undici EnvHttpProxyAgent as the global fetch
 * dispatcher whenever any of the standard proxy env vars is set. When
 * no proxy vars are set, it's a no-op — the built-in fetch behavior is
 * unchanged, no dep cost at runtime.
 *
 * Env vars honored (standard *nix / curl / requests convention):
 *   HTTP_PROXY   http://proxy.example:3128
 *   HTTPS_PROXY  http://proxy.example:3128    (typically same as HTTP_PROXY)
 *   NO_PROXY     localhost,127.0.0.1,.internal,off-mirror.local
 *
 * Lowercase variants (http_proxy, https_proxy, no_proxy) are ALSO
 * honored — EnvHttpProxyAgent checks both cases.
 *
 * Imported from server/index.js right after `dotenv/config` so any
 * subsequent module-init outbound fetch already sees the dispatcher.
 */

import { fetch as undiciFetch, setGlobalDispatcher, EnvHttpProxyAgent } from 'undici';

const _upper = process.env.HTTP_PROXY || process.env.HTTPS_PROXY || process.env.NO_PROXY;
const _lower = process.env.http_proxy || process.env.https_proxy || process.env.no_proxy;

if (_upper || _lower) {
  try {
    setGlobalDispatcher(new EnvHttpProxyAgent());
    // Node's built-in `fetch` uses the runtime's INTERNAL undici, which
    // has its own dispatcher slot separate from the userland `undici`
    // package's slot. `setGlobalDispatcher` above only affects userland
    // undici. To make existing `await fetch(...)` calls across the
    // codebase route through the proxy without rewriting every call
    // site to import from 'undici' explicitly, swap globalThis.fetch to
    // point at undici.fetch. Then the dispatcher we set applies.
    globalThis.fetch = undiciFetch;
    const active = {
      HTTP_PROXY:  process.env.HTTP_PROXY  || process.env.http_proxy  || '(unset)',
      HTTPS_PROXY: process.env.HTTPS_PROXY || process.env.https_proxy || '(unset)',
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
      console.warn('[server] proxy-agent install failed:', msg);
    }
  }
}
