// The paths NutriTrace's CookTrace and Mealie proxies forward: only the
// parts of each API the app reads, and nothing that climbs out of them.

/**
 * `path` as sent ("/api/v1/recipes?q=..."), or null unless its path part is
 * one of `prefixes` (or under one). No "." or ".." segment, no backslash,
 * and no encoded slash or backslash a server might decode into one; the
 * query (a search term) may hold anything.
 */
export function apiPathFor(prefixes, path) {
  const p = String(path || '');
  // URL parsing drops tabs and line breaks (".\t." would become ".."), so
  // no control character or space at all.
  if (/[\u0000-\u0020\u007f]/.test(p)) return null;
  if (!p.startsWith('/') || p.startsWith('//') || p.includes('#')) return null;
  const pathOnly = p.split('?')[0];
  if (/\\|%2f|%5c|(^|\/)(\.|%2e){1,2}(\/|$)/i.test(pathOnly)) return null;
  if (!prefixes.some(a => pathOnly === a || pathOnly.startsWith(a + '/'))) return null;
  // And the path a URL parser makes of it must still be the one checked.
  let parsed;
  try { parsed = new URL(p, 'http://x').pathname; } catch { return null; }
  return parsed === pathOnly ? p : null;
}

export const COOKTRACE_API = ['/api/v1/recipes', '/api/v1/pantry', '/api/v1/me'];
export const MEALIE_API = ['/api/recipes'];
