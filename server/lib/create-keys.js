/**
 * create-keys.js: a new row sent twice is made once.
 *
 * The Android app gives every row it makes a stable key (its install and
 * its own row id), sent with the create: Connect > Upload, and the sync
 * push for rows the server hasn't seen. A retry, or an answer lost on the
 * way back, sends the same key again, and gets the row made the first
 * time instead of a second one. Kept in client_key (db.js), per account.
 */
import db from '../db.js';

export function cleanCreateKey(v) {
  return typeof v === 'string' && v.trim() ? v.trim().slice(0, 128) : null;
}

/** The account's row made with this key before, or null. */
export function findByCreateKey(table, userId, key) {
  if (!key) return null;
  return db.prepare(`SELECT * FROM ${table} WHERE client_key = ? AND user_id IS ?`).get(key, userId ?? null) || null;
}

export function setCreateKey(table, id, key) {
  if (key) db.prepare(`UPDATE ${table} SET client_key = ? WHERE id = ?`).run(key, id);
}
