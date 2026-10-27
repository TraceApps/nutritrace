// A clone is a new meal or recipe, so it leaves behind what ties a saved row
// to its original: the id, the key a resend is matched by (rows made through
// Android sync carry one), and the source id a re-import updates in place.
// Sent with those, the server hands back or overwrites the original (#299).
export function cloneOf(item, name) {
  const { id: _id, client_key: _key, source_external_id: _sourceId, ...rest } = item;
  return { ...rest, name, created_at: new Date().toISOString() };
}
