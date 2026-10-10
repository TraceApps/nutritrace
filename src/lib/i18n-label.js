import { get } from 'svelte/store';
import { _, locale } from 'svelte-i18n';

/**
 * Translate `group.id`. `tick` is the current locale, passed from a reactive
 * statement so the labels refresh when the language changes. Missing keys and
 * a locale that is not ready yet fall back to the English label.
 */
export function tr(group, id, fallback, tick) {
  void tick;
  if (!get(locale) || id == null || id === '') return fallback;
  try {
    const t = get(_);
    if (typeof t !== 'function') return fallback;
    const value = t(`${group}.${id}`);
    if (value == null || value === `${group}.${id}`) return fallback;
    return value;
  } catch {
    return fallback;
  }
}
