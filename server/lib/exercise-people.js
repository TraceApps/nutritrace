/** People tags on an exercise + person key on each daily log. */

export function normalizePerson(raw) {
  return String(raw == null ? '' : raw).trim().slice(0, 80);
}

export function parsePeople(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return normalizePeople(raw);
  if (typeof raw === 'string') {
    const s = raw.trim();
    if (!s) return [];
    try {
      const v = JSON.parse(s);
      if (Array.isArray(v)) return normalizePeople(v);
    } catch { /* plain name */ }
    return [s.slice(0, 80)];
  }
  return [];
}

function normalizePeople(arr) {
  const out = [];
  const seen = new Set();
  for (const p of arr || []) {
    const n = normalizePerson(p);
    if (!n) continue;
    const key = n.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(n);
  }
  return out;
}

export function serializePeople(arr) {
  const list = parsePeople(arr);
  return list.length ? JSON.stringify(list) : null;
}
