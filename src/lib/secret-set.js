/**
 * What the server sends for a token it keeps to itself (the ntfy and Gotify
 * tokens): set, never shown. Saving it back leaves the token as it is
 * (server/lib/secret-settings.js, TraceApps/cooktrace#92).
 */
export const SECRET_SET = '••••••••';

/** Focus on a saved token's placeholder selects it, so typing replaces it. */
export const selectSecret = e => { if (e.currentTarget.value === SECRET_SET) e.currentTarget.select(); };
