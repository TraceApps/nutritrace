/**
 * People attached to an exercise, plus the person key on each daily log.
 * Names are stored as a JSON array on exercises.people and as a TEXT
 * column on exercise_logs.person ('' = unlabeled / solo).
 */

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

export function normalizePeople(arr) {
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

export function exerciseMetricKey(id, person) {
  const p = normalizePerson(person);
  return p ? `ex_${id}::${p}` : `ex_${id}`;
}

export function parseExerciseMetric(metric) {
  if (typeof metric !== 'string' || !metric.startsWith('ex_')) return null;
  const rest = metric.slice(3);
  const sep = rest.indexOf('::');
  if (sep < 0) return { exerciseId: parseInt(rest, 10), person: '' };
  return {
    exerciseId: parseInt(rest.slice(0, sep), 10),
    person: rest.slice(sep + 2),
  };
}

/** Keep the current person if they're still attached; otherwise the first. */
export function pickLogPerson(people, current = '') {
  const list = parsePeople(people);
  if (!list.length) return '';
  const cur = normalizePerson(current);
  if (cur) {
    const match = list.find(p => p.toLowerCase() === cur.toLowerCase());
    if (match) return match;
  }
  return list[0];
}

