/**
 * What the Add Activity sheet offers (#321): recent names and templates.
 *
 * A template is a logged activity saved with "Save as template". Templates
 * never expire, and each offers its newest saved version (duration,
 * distance, MET). Past entries are names used since `since` (YYYY-MM-DD),
 * newest first. Both are deduplicated by name, ignoring case.
 */
export function activitySuggestions(rows, { since = '', maxNames = 50, maxTemplates = 12 } = {}) {
  const newest = (Array.isArray(rows) ? rows : [])
    .filter(r => r && String(r.name || '').trim())
    .sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')) || (Number(b.id) || 0) - (Number(a.id) || 0));
  const pick = (list, max) => {
    const seen = new Set();
    return list.filter(r => {
      const k = String(r.name).trim().toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    }).slice(0, max);
  };
  return {
    pastNames: pick(newest.filter(r => String(r.date || '') >= since), maxNames).map(r => String(r.name).trim()),
    templates: pick(newest.filter(r => r.is_template), maxTemplates),
  };
}
