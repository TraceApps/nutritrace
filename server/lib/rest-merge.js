/**
 * A save through the REST API that says which fields it changed
 * (`changed_fields` in its body: the web's editors, the Android app online)
 * changes only those, or the groups they're in (lib/sync-fields.js): a form
 * opened before an edit made elsewhere doesn't put back that edit's fields.
 * The save is made now, so each field it changed is its newest edit. A save
 * that doesn't say writes every field it sends, as before. Either way the
 * triggers in db.js stamp what changed (lib/field-sync.js).
 */
import { mergeEdit } from './field-sync.js';
import { SYNC_FIELDS, SYNC_GROUPS, SYNC_JSON } from './sync-fields.js';
import { changedList } from './body-stats-merge.js';

/**
 * `next`: the row's synced fields as the route would write them (stored
 * forms). Returns `next` with the fields the save didn't change put back
 * to the row's own.
 */
export function onlyChanged(table, existing, next, changedFields) {
  const said = changedList(changedFields);
  if (!said || !existing) return next;
  const fields = SYNC_FIELDS[table].filter(f => f in next);
  const values = {};
  for (const f of fields) values[f] = next[f];
  const m = mergeEdit({
    existing, values, fields, groups: SYNC_GROUPS[table], json: SYNC_JSON[table],
    changed: said.filter(f => fields.includes(f)), at: Date.now(), times: {},
  });
  return { ...next, ...m.row };
}
