/**
 * password-strength.js — lazy-loaded zxcvbn-ts wrapper.
 *
 * zxcvbn dictionaries are ~150 KB combined. Loading them up-front bloats
 * the main bundle, but a strength meter is only needed on a few password
 * inputs (Wizard, Profile, AcceptInvite, admin add-user). Dynamic-import
 * keeps them out of the initial chunk and behind a one-shot promise.
 *
 * Usage:
 *   import { estimate } from '../lib/password-strength.js';
 *   const result = await estimate('hunter2');
 *   // result = { score, feedback: { warning, suggestions }, crackTimes, ... }
 */

let _ready = null;
let _zxcvbn = null;

async function _load() {
  if (_zxcvbn) return _zxcvbn;
  if (!_ready) {
    _ready = (async () => {
      const [{ zxcvbnOptions, zxcvbn }, common, en] = await Promise.all([
        import('@zxcvbn-ts/core'),
        import('@zxcvbn-ts/language-common'),
        import('@zxcvbn-ts/language-en'),
      ]);
      zxcvbnOptions.setOptions({
        translations: en.translations,
        dictionary: { ...common.dictionary, ...en.dictionary },
        graphs: common.adjacencyGraphs,
      });
      _zxcvbn = zxcvbn;
      return zxcvbn;
    })();
  }
  return _ready;
}

/**
 * Estimate password strength.
 * @param {string} password
 * @param {string[]} [userInputs] — extra strings (username, email, name) to
 *   bias against. Anything in this list scores worse if echoed in the password.
 * @returns {Promise<{ score:0|1|2|3|4, feedback:{warning:string,suggestions:string[]} }>}
 */
export async function estimate(password, userInputs = []) {
  if (!password) return { score: 0, feedback: { warning: '', suggestions: [] } };
  const fn = await _load();
  return fn(password, userInputs);
}

/** Map score (0-4) → label for UI display. */
export const STRENGTH_LABELS = ['Very weak', 'Weak', 'Fair', 'Strong', 'Very strong'];
export const STRENGTH_COLORS = ['#ef4444', '#f97316', '#f59e0b', '#10b981', '#059669'];

/** Server-enforced minimum score when policy='strong'. zxcvbn 3 = "strong". */
export const STRONG_MIN_SCORE = 3;
