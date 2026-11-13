/**
 * account-generation.js: which account's copy the app is writing for.
 *
 * Moves on every change of account (another one signing in, connecting to a
 * server, going local, signing out). A sync or a queued write started under
 * one generation stops instead of writing into the next account's copy
 * (lib/local-account.js, lib/sync.js, stores/settings.js).
 *
 * A module of its own so code that must not pull the native database into
 * the browser bundle (stores/settings.js) can read it without a cycle.
 */
let _generation = 0;
export const accountGeneration = () => _generation;
export function bumpAccountGeneration() { _generation++; }
