/**
 * local-address.js: may an app talk plain http:// to this server address?
 *
 * Only when the address can't be on the public internet:
 *   - a private IPv4 address (10/8, 172.16/12, 192.168/16);
 *   - Tailscale/CGNAT 100.64/10, loopback 127/8 or link-local 169.254/16;
 *   - IPv6 unique local fc00::/7, link-local fe80::/10 or ::1;
 *   - a bare one-word name, such as `nutritrace` in http://nutritrace:3001;
 *   - a name ending in .local, .home.arpa, .internal or .lan.
 * Every other http:// address (public names, public IPs, IPv4-mapped IPv6)
 * is refused. https:// is always fine.
 *
 * The address is read with the URL parser, the same one the app's requests
 * use, so the host checked is the host connected to: 192.168.1.1.example.com
 * and http://192.168.1.5@evil.com are public names, and the decimal, hex and
 * octal forms of an IPv4 address are read as the address they stand for.
 *
 * No imports and nothing app-specific, so the same file can serve each
 * TraceApps app. The Android worker's Kotlin copy (LocalAddress.kt) is held
 * to the same cases: scripts/fixtures/local-address-cases.json.
 */

const LOCAL_SUFFIXES = ['.local', '.home.arpa', '.internal', '.lan'];

/**
 * What kind of server address `raw` is:
 *   'https'   - https://, always allowed;
 *   'local'   - http:// to an address on the person's own network;
 *   'public'  - http:// to anything else, refused;
 *   'invalid' - not an http:// or https:// URL.
 */
export function classifyServerAddress(raw) {
  let url;
  try { url = new URL(String(raw ?? '')); } catch { return 'invalid'; }
  if (url.protocol === 'https:') return 'https';
  if (url.protocol !== 'http:') return 'invalid';
  return isLocalHostname(url.hostname) ? 'local' : 'public';
}

/** The origin (scheme, host, port) of `raw` as the URL parser reads it, or null. */
export function addressOrigin(raw) {
  try {
    const url = new URL(String(raw ?? ''));
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.origin : null;
  } catch { return null; }
}

/**
 * Whether a host, as the URL parser leaves it (`new URL(x).hostname`:
 * lowercase, IPv4 as four decimal numbers, IPv6 in brackets), is on the
 * person's own network.
 */
export function isLocalHostname(hostname) {
  const host = String(hostname || '').toLowerCase();
  if (!host) return false;
  if (host.startsWith('[') && host.endsWith(']')) {
    const v6 = parseIPv6(host.slice(1, -1));
    return !!v6 && isLocalIPv6(v6);
  }
  const v4 = parseIPv4(host);
  if (v4) return isLocalIPv4(v4);
  // A bare one-word name is looked up on the local network. With a trailing
  // dot ("nutritrace.") it is a top-level name instead, so it isn't one.
  if (!host.includes('.')) return true;
  const name = host.endsWith('.') ? host.slice(0, -1) : host;
  return LOCAL_SUFFIXES.some(s => name.length > s.length && name.endsWith(s));
}

function parseIPv4(host) {
  const parts = host.split('.');
  if (parts.length !== 4) return null;
  const nums = [];
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const n = Number(p);
    if (n > 255) return null;
    nums.push(n);
  }
  return nums;
}

function isLocalIPv4([a, b]) {
  return a === 10                              // 10.0.0.0/8
    || (a === 172 && b >= 16 && b <= 31)       // 172.16.0.0/12
    || (a === 192 && b === 168)                // 192.168.0.0/16
    || (a === 100 && b >= 64 && b <= 127)      // 100.64.0.0/10 (Tailscale, CGNAT)
    || a === 127                               // 127.0.0.0/8 loopback
    || (a === 169 && b === 254);               // 169.254.0.0/16 link-local
}

// Eight 16-bit pieces, or null. Takes "::" and a dotted IPv4 tail.
function parseIPv6(text) {
  if (!text || /[^0-9a-f:.]/.test(text)) return null;
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const side = s => (s ? s.split(':') : []);
  const head = side(halves[0]);
  const tail = side(halves[1] ?? '');
  const pieces = [];
  const all = halves.length === 2 ? [...head, ...tail] : head;
  for (let i = 0; i < all.length; i++) {
    const p = all[i];
    if (p.includes('.')) {
      if (i !== all.length - 1) return null;
      const v4 = parseIPv4(p);
      if (!v4) return null;
      pieces.push((v4[0] << 8) | v4[1], (v4[2] << 8) | v4[3]);
    } else {
      if (!/^[0-9a-f]{1,4}$/.test(p)) return null;
      pieces.push(parseInt(p, 16));
    }
  }
  if (halves.length === 2) {
    if (pieces.length > 7) return null;
    const headCount = head.reduce((n, p) => n + (p.includes('.') ? 2 : 1), 0);
    pieces.splice(headCount, 0, ...new Array(8 - pieces.length).fill(0));
  }
  return pieces.length === 8 ? pieces : null;
}

function isLocalIPv6(p) {
  if ((p[0] & 0xfe00) === 0xfc00) return true;   // fc00::/7 unique local
  if ((p[0] & 0xffc0) === 0xfe80) return true;   // fe80::/10 link-local
  return p.slice(0, 7).every(x => x === 0) && p[7] === 1; // ::1
}
