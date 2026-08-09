# Contributing to NutriTrace

Thanks for your interest in NutriTrace.

## Reporting bugs

- Open an issue at [github.com/traceapps/nutritrace/issues](https://github.com/traceapps/nutritrace/issues).
- Include your version (Settings → About), what you expected, and what you saw.
- For sync issues, include whether you're on PWA or native Android, and your server version.
- Don't paste server logs publicly without redacting — debug output can contain personal health data, and trace request bodies can contain diary entries, notes, or other private content despite credential redaction.

## Suggesting features

- Open an issue describing the use case before writing code — it helps avoid building something that won't get merged.
- Check [FUTURE.md](FUTURE.md) first; the feature may already be planned or intentionally deferred.

## Pull requests

- **Target the `dev` branch, not `main`.** All work lands on `dev` first, gets tested there, and is bundled into `main` at release time. PRs opened against `main` will be asked to retarget.
- Keep changes focused — one concern per PR.
- Match the existing code style (Svelte 4, no TypeScript).
- For server changes, ensure all SQL is parameterized and every new route has appropriate `requireAuth` / `requireAdmin` middleware.
- Update `CHANGELOG.md` under the unreleased section if your change is user-visible.
- The Android shell lives in `android/`; if you change web assets the maintainer will run `npx cap sync android` and rebuild the APK.
- No DCO or CLA required.

## Translations

NutriTrace uses [svelte-i18n](https://github.com/kaisermann/svelte-i18n) with one JSON file per locale in `src/i18n/`. The English file at `src/i18n/en.json` is the source of truth.

### Preferred: Weblate (no code required)

The easiest way to contribute translations is via [Weblate](https://hosted.weblate.org/projects/nutritrace/) — a browser-based translation platform that syncs directly with this repo. Pick a language, translate strings inline, and commits land as PRs automatically. No git, no JSON syntax, no code. You can also request a new language from within Weblate; the maintainer will register it in `src/i18n/index.js` and add it to the Settings language picker after the first batch of strings comes in.

[![Translation status](https://hosted.weblate.org/widget/nutritrace/multi-auto.svg)](https://hosted.weblate.org/engage/nutritrace/)

### Alternative: adding a new language via PR

If you'd rather bootstrap a language locally and open a PR directly:

1. Copy `src/i18n/en.json` to `src/i18n/<code>.json` where `<code>` is the BCP-47 short code (`fr`, `de`, `nl`, `es`, `pt`, `ja`, etc.).
2. Translate the values. Leave the keys exactly as they are. Keep `{placeholder}` tokens and any HTML tags (`<strong>`, `<code>`, `<br>`) intact and in the right grammatical position for your language.
3. In `src/i18n/index.js`, register the new locale and add it to `AVAILABLE_LOCALES`:
   ```js
   register('fr', () => import('./fr.json'));
   // ...
   export const AVAILABLE_LOCALES = [
     { code: 'en', label: 'English' },
     { code: 'fr', label: 'Français' },
   ];
   ```
   The label is what shows in the Settings → Regional & Units → Language picker. Use the language's native name (e.g. `Français` not `French`).
4. Run `npm run i18n:check` to confirm no keys are missing or orphaned.
5. Open a PR.

### Updating an existing language

If new keys land in `en.json` between releases, your locale file will report them as "missing" in `npm run i18n:check`. The app will fall back to English for those strings until you translate them. There is no urgency — translate at your own pace.

The English source text may also change occasionally without renaming the key. We do not have automatic stale-translation detection, so a quick diff of `en.json` against the version you originally translated from is the most reliable way to catch these.

### Translation guidance

- **Domain conventions matter.** For nutrition labels, use the regulatory terms used on food packaging in your country (e.g. French food labels say `Glucides` / `Lipides` / `Protéines`, not the literal translations of the English words).
- **Match the tone.** NutriTrace's English copy is informal and direct ("How did today feel?"). Try to keep that register rather than translating to a more formal style.
- **Length awareness.** Some buttons are tight on small screens. If your translation is significantly longer than the English, test on a phone-sized viewport.
- **Do not translate proper nouns or product names** — `NutriTrace`, `OFF`, `USDA`, `Mealie`, `Trace` (the AI assistant), `Open Food Facts` stay as-is.

### For code contributors — instrumenting new strings

Every user-facing string added to the app should be extracted into `en.json` and rendered through `svelte-i18n`'s `$_()` helper. Hardcoded English literals in templates are the reason translation coverage lags the codebase — please prevent them at PR time rather than retrofit them later.

The pattern:

```svelte
<script>
  import { _ } from 'svelte-i18n';
</script>

<h1>{$_('routes.diary.title')}</h1>
<input placeholder={$_('routes.foods.search_placeholder')} />
```

Then in `src/i18n/en.json`:

```json
"routes": {
  "diary": {
    "title": "Diary"
  },
  "foods": {
    "search_placeholder": "Search foods…"
  }
}
```

Guidelines:

- **Group by area**, not by page. `settings.notifications.section` is better than `settings_notifications_section`.
- **Only add English** in your PR. Do not machine-translate or hand-translate into other languages you don't natively speak — that misrepresents contributor work. The `en.json` addition is enough; translators fill in their locale files in follow-up PRs. `svelte-i18n`'s `fallbackLocale: 'en'` renders English until a translation lands.
- **Skip developer-facing strings** — error stacks, log messages, JSON payload keys, class names. Only pull out what a user reads on screen.
- **Interpolation** uses `{$_('key', { values: { name: user.name } })}` and `{name}` in the JSON value. Prefer this over string concatenation so translators can reorder words.
- **Run `npm run i18n:check`** before opening the PR. It flags orphaned keys and missing translations across every locale file, catching typos and stale entries.

If you're adding a section that has a lot of copy, group all the new keys under one namespace in `en.json` so they can be reviewed together.

### On putting words in a contributor's mouth

Do not add translations for locales you don't natively speak, and do not merge machine-translated content into a contributor's locale file. If a section can't be translated at code-write time (nobody on the PR speaks the language), extract to `en.json`, open a follow-up "Translations wanted" issue linking the new keys, and let a native speaker fill them in. `svelte-i18n`'s English fallback keeps the app fully functional in the meantime.

### What's translatable today vs not

The full client-side string surface is extracted as of v1.1.0 — navigation, all Settings sections, Diary, Foods, Wellness, Goals, Statistics, the wizard, auth flow, the AI assistant, action sheets, toasts, dialog copy. Any new user-facing string added to the app is expected to land as a key in `en.json` in the same commit (see instrumenting guidance above); hardcoded English literals get flagged in review. `npm run i18n:check` runs against every locale file to catch missing translations and orphaned keys.

Server-side strings (email subject lines, push notification bodies, AI system prompts) are not currently translatable and stay English.

## Screenshots

README screenshots live in `docs/screenshots/` (numbered prefix for sort order). If your PR meaningfully changes the UI shown in any of them, please replace the affected screenshot at the same dimensions and theme (dark) so the README stays accurate.

## License

By contributing you agree that your contribution is licensed under [AGPL-3.0](LICENSE), the same license as the rest of the server and PWA code.
