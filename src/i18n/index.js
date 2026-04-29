import { register, init, getLocaleFromNavigator } from 'svelte-i18n';

// Languages with a dedicated locale file. As contributors add translations,
// register them here and add an entry to AVAILABLE_LOCALES so the language
// picker in Settings → Appearance shows the new option.
register('en', () => import('./en.json'));

export const AVAILABLE_LOCALES = [
  { code: 'en', label: 'English' },
];

export function initI18n(initialLocale) {
  init({
    fallbackLocale: 'en',
    initialLocale: initialLocale || pickInitialLocale(),
    // Log missing-key warnings to the browser console only in dev — in
    // production builds they'd spam the console for users running a locale
    // that isn't fully translated yet.
    warnOnMissingMessages: !!import.meta.env.DEV,
  });
}

function pickInitialLocale() {
  const nav = getLocaleFromNavigator();
  if (!nav) return 'en';
  const short = nav.split('-')[0];
  return AVAILABLE_LOCALES.some(l => l.code === short) ? short : 'en';
}
