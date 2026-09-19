/**
 * default-field.js: which box the add and edit sheets put the cursor in.
 *
 * #170 made these sheets focus a number box on open so you can type
 * straight away; it always picked the first one, Serving Size. People who
 * mostly change the number of servings then needed an extra tap every time
 * (#224), so Settings, Diary, Default Field chooses between the two.
 *
 * The sheets mark their boxes with data-field="portion" (Serving Size) and
 * data-field="servings" (Number of Servings). A sheet without the preferred
 * box (Quick Calories, say) falls back to its first number box, as before.
 */

export const DEFAULT_FIELDS = ['servings', 'portion'];

/** The box to focus inside `root`, or null when there's nothing to focus. */
export function defaultFieldInput(root, preference) {
  if (!root || typeof root.querySelector !== 'function') return null;
  const field = DEFAULT_FIELDS.includes(preference) ? preference : 'servings';
  return root.querySelector(`input[data-field="${field}"]`)
    || root.querySelector('input[inputmode="numeric"], input[inputmode="decimal"]');
}

/** Focus the preferred box and select its value, so typing replaces it. */
export function focusDefaultField(root, preference) {
  const input = defaultFieldInput(root, preference);
  if (!input) return null;
  input.focus();
  if (typeof input.select === 'function') input.select();
  return input;
}
