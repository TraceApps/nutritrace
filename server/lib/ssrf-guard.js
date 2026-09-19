/**
 * server/lib/ssrf-guard.js
 *
 * Shared SSRF guard for any code path that fetches a user-supplied URL
 * server-side. New in NutriTrace (no prior SSRF-guard code existed
 * anywhere in this codebase to extract from, unlike CookTrace's
 * image-localizer.js). Ported from LiftTrace's server/lib/ssrf-guard.js
 * so outgoing webhooks have the same protection LiftTrace's do.
 *
 * Tiered defaults:
 *   - Link-local / IPv6 link-local / cloud-metadata (169.254.169.254):
 *     ALWAYS blocked. Never legitimate for any caller.
 *   - Loopback + RFC1918 + IPv6 ULA: blocked by default; each caller
 *     passes its own `allowPrivate` flag (webhooks: ALLOW_PRIVATE_WEBHOOK_URLS)
 *     so a self-hoster can opt in independently per feature.
 */
import dns from 'dns/promises';
import net from 'net';

export function isLinkLocalOrCloudMeta(ip) {
  if (net.isIPv4(ip)) return ip.startsWith('169.254.');
  if (net.isIPv6(ip)) {
    const lo = ip.toLowerCase();
    // fe80::/10 = fe80..febf in the first hextet
    if (/^fe[89ab]/.test(lo)) return true;
    // IPv4-mapped link-local (e.g. ::ffff:169.254.169.254)
    if (lo.startsWith('::ffff:169.254.')) return true;
  }
  return false;
}

export function isPrivateOrLoopback(ip) {
  if (net.isIPv4(ip)) {
    if (ip === '0.0.0.0') return true;
    if (ip.startsWith('127.')) return true;
    if (ip.startsWith('10.')) return true;
    if (ip.startsWith('192.168.')) return true;
    if (ip.startsWith('172.')) {
      const second = parseInt(ip.split('.')[1], 10);
      if (second >= 16 && second <= 31) return true;
    }
    return false;
  }
  if (net.isIPv6(ip)) {
    const lo = ip.toLowerCase();
    if (lo === '::1' || lo === '::' || lo === '0:0:0:0:0:0:0:1') return true;
    // Unique-local addresses fc00::/7 = fc00..fdff
    if (/^f[cd]/.test(lo)) return true;
    // IPv4-mapped private
    if (/^::ffff:(127|10|192\.168|172\.(1[6-9]|2[0-9]|3[01]))\./i.test(lo)) return true;
  }
  return false;
}

/**
 * Resolve the URL's hostname and reject anything that lands on a blocked
 * IP. Returns a parsed URL on success; throws Error with a friendly
 * message on failure. Caller should map to 400 / silent-skip as
 * appropriate.
 *
 * `allowPrivate` (default false) governs whether a loopback/RFC1918/ULA
 * address is permitted: pass the calling feature's own opt-in flag.
 * `allowPrivateEnvHint` is used only in the error message so a self-
 * hoster knows which env var to set: callers pass their own var name.
 *
 * Note on DNS rebinding: this function resolves once. A determined
 * attacker could DNS-rebind between this lookup and the fetch that
 * follows it. Accepted as residual risk here; webhook delivery
 * re-validates via this same function immediately before every send
 * attempt (not just once at creation time), which narrows but does
 * not eliminate the window.
 */
export async function assertSafeUrl(url, { allowPrivate = false, allowPrivateEnvHint = 'ALLOW_PRIVATE_URLS' } = {}) {
  let parsed;
  try { parsed = new URL(url); }
  catch { throw new Error('Invalid URL'); }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('Only http and https URLs are allowed');
  }
  let address;
  try {
    const r = await dns.lookup(parsed.hostname, { all: false });
    address = r.address;
  } catch {
    throw new Error('Could not resolve host');
  }
  if (isLinkLocalOrCloudMeta(address)) {
    throw new Error('Link-local / cloud-metadata addresses are not allowed');
  }
  if (!allowPrivate && isPrivateOrLoopback(address)) {
    throw new Error(`Private / loopback addresses are blocked. Set ${allowPrivateEnvHint}=1 to enable LAN targets.`);
  }
  return parsed;
}
