/**
 * A save through the REST API that says which fields it changed
 * (`changed_fields` in its body: the web's editors, the Android app online)
 * changes only those, or the groups they're in (lib/sync-fields.js): a form
 * opened before an edit made elsewhere doesn't put back that edit's fields.
 * The save is made now, so each field it changed is its newest edit. A save
 * that doesn't say writes every field it sends, as before. Either way the
 * triggers in db.js stamp what changed (lib/field-sync.js).
 *
 * A save of a row deleted elsewhere (deletedSave) is made now, so it follows
 * the rule a push of the same change follows: it brings the row back when it
 * changes something, and not when it changes nothing or comes in the second
 * the row was deleted. The refusal is `goneBody`, answered 410 as
 * LiftTrace answers a save made before a delete.
 */
import { mergeEdit, editRevives, sameValue } from './field-sync.js';
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

/** What a refused save of a deleted row is answered with (410). */
export const goneBody = { error: 'Deleted elsewhere, so this change was not saved', gone: true };

/**
 * Whether a save of a row deleted here (`existing`) brings it back: it
 * changes one of the table's synced fields and was made after the delete
 * (lib/field-sync.js editRevives: a tie goes to the delete). `next`: the
 * synced fields as the route would write them (stored forms). A save is made
 * now (`at`). Columns written their own way (visibility) don't decide it:
 * a push never carries them, and a form sends them whether changed or not.
 */
export function deletedSave(table, existing, next, at = Date.now()) {
  const json = SYNC_JSON[table] || [];
  const changes = SYNC_FIELDS[table].some(f => f in next && !sameValue(next[f], existing[f], json.includes(f)));
  return changes && editRevives({ existing, at });
}
