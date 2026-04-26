# Contributing to NutriTrace

Thanks for your interest in NutriTrace.

## Reporting bugs

- Open an issue at [github.com/traceapps/nutritrace/issues](https://github.com/traceapps/nutritrace/issues).
- Include your version (Settings → About), what you expected, and what you saw.
- For sync issues, include whether you're on PWA or native Android, and your server version.
- Don't paste server logs publicly without redacting — `LOG_LEVEL=debug` includes personal health data (HRV, RHR, sleep) and any tokens that happened to be in flight.

## Suggesting features

- Open an issue describing the use case before writing code — it helps avoid building something that won't get merged.
- Check [FUTURE.md](FUTURE.md) first; the feature may already be planned or intentionally deferred.

## Pull requests

- Keep changes focused — one concern per PR.
- Match the existing code style (Svelte 4, no TypeScript).
- For server changes, ensure all SQL is parameterized and every new route has appropriate `requireAuth` / `requireAdmin` middleware.
- Update `CHANGELOG.md` under the unreleased section if your change is user-visible.
- The Android shell lives in `android/`; if you change web assets the maintainer will run `npx cap sync android` and rebuild the APK.
- No DCO or CLA required.

## Screenshots

README screenshots live in `docs/screenshots/` (numbered prefix for sort order). If your PR meaningfully changes the UI shown in any of them, please replace the affected screenshot at the same dimensions and theme (dark) so the README stays accurate.

## License

By contributing you agree that your contribution is licensed under [AGPL-3.0](LICENSE), the same license as the rest of the server and PWA code.
