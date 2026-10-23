/**
 * Who may show the app inside a frame. By default only the app itself, so
 * another site can't frame it to trick a click (clickjacking).
 *
 * FRAME_ANCESTORS adds the addresses allowed to frame it, such as a
 * dashboard that embeds it: origins separated by spaces or commas
 * (`https://home.example.com`, `https://*.example.com`, a port allowed).
 * A pasted page address is cut to its origin. With any set, only
 * Content-Security-Policy is sent: X-Frame-Options can name no other site,
 * and a browser that knows frame-ancestors ignores it.
 *
 * Same file in every Trace app: copy it whole.
 */
const MAX_ENTRIES = 32;
const MAX_LENGTH = 4096;
const WILDCARD = /^(https?):\/\/\*\.([a-z0-9-]+(?:\.[a-z0-9-]+)*)(?::(\d{1,5}|\*))?(\/.*)?$/i;

function _port(p) {
  return p === undefined || p === '*' || (/^\d{1,5}$/.test(p) && Number(p) >= 1 && Number(p) <= 65535);
}

/** One entry as a CSP source, or why it can't be one. */
function _source(raw) {
  const t = raw.replace(/^['"]+|['"]+$/g, '');
  const w = WILDCARD.exec(t);
  if (w) {
    const [, scheme, host, port, path] = w;
    if (!host.includes('.')) return { reason: 'too broad' };
    if (!_port(port)) return { reason: 'not an address' };
    const source = `${scheme.toLowerCase()}://*.${host.toLowerCase()}${port ? `:${port}` : ''}`;
    return path && path !== '/' ? { source, note: `has a path: using ${source}` } : { source };
  }
  let anyPort = false, s = t;
  if (/:\*(\/|$)/.test(s)) { anyPort = true; s = s.replace(/:\*(?=\/|$)/, ''); }
  let url;
  try { url = new URL(s); } catch { return { reason: 'not an address' }; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { reason: 'not http or https' };
  // Letters, digits, dots and dashes, or an IPv6 literal: nothing that could
  // end the directive (a `;` is a valid host character to the URL parser).
  if (!/^([a-z0-9-]+(\.[a-z0-9-]+)*|\[[0-9a-f:.]+\])$/.test(url.hostname) || url.username || url.password || url.port === '0') return { reason: 'not an address' };
  const source = anyPort ? `${url.protocol}//${url.host}:*` : url.origin;
  const extra = (url.pathname && url.pathname !== '/') || url.search || url.hash;
  return extra ? { source, note: `has a path: using ${source}` } : { source };
}

/**
 * FRAME_ANCESTORS read: `allowed` (CSP sources, deduped, at most 32 and 4 KB)
 * and `warnings` (each entry dropped or changed, and why).
 */
export function parseFrameAncestors(value) {
  const allowed = [], warnings = [];
  let length = 0;
  for (const token of String(value || '').split(/[\s,]+/).filter(Boolean)) {
    const { source, note, reason } = _source(token);
    if (!source) { warnings.push(`${token}: ${reason}`); continue; }
    if (note) warnings.push(`${token}: ${note}`);
    if (allowed.includes(source)) continue;
    if (allowed.length >= MAX_ENTRIES || length + source.length + 1 > MAX_LENGTH) {
      warnings.push(`${token}: too many addresses, kept the first ${allowed.length}`);
      continue;
    }
    allowed.push(source);
    length += source.length + 1;
  }
  return { allowed, warnings };
}

/** The frame-ancestors directive, for a route that sets its own Content-Security-Policy. */
export function frameAncestorsDirective(value) {
  const { allowed } = parseFrameAncestors(value);
  return `frame-ancestors 'self'${allowed.length ? ` ${allowed.join(' ')}` : ''}`;
}

/** The headers every response carries for FRAME_ANCESTORS. */
export function framingHeaders(value) {
  const directive = frameAncestorsDirective(value);
  if (!parseFrameAncestors(value).allowed.length) {
    return { 'Content-Security-Policy': directive, 'X-Frame-Options': 'SAMEORIGIN' };
  }
  return { 'Content-Security-Policy': directive };
}
