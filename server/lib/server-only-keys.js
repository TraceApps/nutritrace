/**
 * server-only-keys.js — settings keys that must NEVER leak to clients.
 *
 * These are written/read exclusively by server routes (OAuth flows, admin
 * config) and stored in the user_settings table. They must be filtered out
 * of every response that returns settings to the browser/native client, AND
 * rejected on every write path that accepts client-supplied keys.
 *
 * Used by:
 *   - server/routes/settings.js (GET filter, PUT reject)
 *   - server/routes/sync.js     (pull filter, push reject)
 */

export const SERVER_ONLY_KEYS = new Set([
  // Withings OAuth app credentials
  'withings_client_id', 'withings_client_secret', 'withings_redirect_uri',
  // Fitbit OAuth app credentials
  'fitbit_client_id', 'fitbit_client_secret', 'fitbit_redirect_uri',
  // Garmin OAuth app credentials
  'garmin_consumer_key', 'garmin_consumer_secret',
]);

// Pattern fallback so newly added admin keys are auto-protected if they
// follow the naming convention. Better safe than leaking.
export const SERVER_ONLY_PATTERNS = [
  /_client_secret$/i,
  /_consumer_secret$/i,
  /_api_secret$/i,
  /_redirect_uri$/i,
  /_client_id$/i,
];

/** Returns true if the given setting key should never leave the server. */
export function isServerOnlyKey(key) {
  if (SERVER_ONLY_KEYS.has(key)) return true;
  return SERVER_ONLY_PATTERNS.some(p => p.test(key));
}
