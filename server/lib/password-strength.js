/**
 * password-strength.js — server-side zxcvbn-ts wrapper.
 *
 * Mirrors the client-side helper at src/lib/password-strength.js so server
 * and client agree on what counts as "strong". Used by validatePassword()
 * when password_policy === 'strong'.
 *
 * zxcvbn 3 = "strong" (years to crack at 10k guesses/sec). 4 = "very strong".
 * Policy 'strong' enforces score >= STRONG_MIN_SCORE (3).
 */

import { zxcvbnOptions, zxcvbn } from '@zxcvbn-ts/core';
import * as common from '@zxcvbn-ts/language-common';
import * as en from '@zxcvbn-ts/language-en';

zxcvbnOptions.setOptions({
  translations: en.translations,
  dictionary: { ...common.dictionary, ...en.dictionary },
  graphs: common.adjacencyGraphs,
});

export const STRONG_MIN_SCORE = 3;

/**
 * @param {string} password
 * @param {string[]} [userInputs] extra strings (username/email) to penalize echoes of
 * @returns {{ score:0|1|2|3|4, feedback:{warning:string,suggestions:string[]} }}
 */
export function estimate(password, userInputs = []) {
  if (!password) return { score: 0, feedback: { warning: '', suggestions: [] } };
  return zxcvbn(password, userInputs);
}
