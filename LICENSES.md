# Licenses & Data Sources

NutriTrace's source code is licensed under [AGPL-3.0](LICENSE). Some of the
integrations and data sources it can talk to are covered by separate licenses.
This file lists them so operators and contributors know what applies to what.

## Code

- **NutriTrace** — AGPL-3.0 (see [LICENSE](LICENSE)). Applies to the entire
  codebase in this repository including the Android app source.

## Data sources

NutriTrace does not bundle any food database inside the Docker image. All
food data is either created by the user or queried live from the source's
own public endpoint. The table below covers each source and its license.

| Source                       | License                          | How NutriTrace uses it                                                                                                         |
| ---------------------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| **Open Food Facts**          | [ODbL 1.0][odbl]                 | Live queries against the OFF public API. Only foods the user actually searches are cached locally in that user's own SQLite.   |
| **Open Food Facts (mirror)** | [ODbL 1.0][odbl]                 | Opt-in via `OFF_LOCAL_DB` env var. Server downloads OFF's own public snapshot ([Hugging Face][hf-off]) to the operator's disk. |
| **USDA FoodData Central**    | Public Domain (US Government)    | Live queries with the user's own [api.data.gov][usda] key. No license restrictions.                                            |
| **Mealie (per user)**        | User-owned; Mealie itself is MIT | Live queries against the user's own Mealie instance (user provides URL + API token).                                           |
| **Local Foods**              | Owned by the self-hoster         | User-created via the app UI or CSV import.                                                                                     |

[odbl]: https://opendatacommons.org/licenses/odbl/1-0/
[hf-off]: https://huggingface.co/datasets/openfoodfacts/product-database
[usda]: https://api.data.gov/

## Notes for operators

### Open Food Facts (default live API)

Individual per-request records are queried on demand. Only a small per-user
cache of foods actually searched accumulates in each user's local SQLite. No
substantial derived database is redistributed by NutriTrace, so ODbL's
share-alike terms don't apply to the default configuration.

### Open Food Facts local mirror (`OFF_LOCAL_DB`)

Opt-in. When enabled, the NutriTrace server downloads OFF's own publicly
published snapshot (Parquet format from Hugging Face by default) to the
operator's disk and queries it locally. The Docker image itself never contains
OFF data; the download happens on the operator's volume at runtime.

**ODbL share-alike does apply to operators who run a multi-user or public
NutriTrace instance with the local mirror enabled.** Because operators are
running a service against a derived-database query engine, they inherit
OFF's ODbL obligations for their operation. In practice this is straightforward
to comply with: OFF's source data is already publicly available at the
Hugging Face URL above under ODbL, so pointing users at that link satisfies
the "source available" requirement. If an operator projects, restructures,
or extends the OFF data beyond straight lookups, they may need to make that
derived database available under ODbL as well.

Single-user self-hosters running the mirror for their own use don't have
public-facing obligations.

### USDA FoodData Central

Public domain data from the US Department of Agriculture. No attribution is
legally required, but it's still nice to mention.

### Mealie

Each user brings their own Mealie instance and API token. The recipes and
data pulled from Mealie belong to whoever owns that Mealie instance.
NutriTrace acts only as a client.

## Bundled assets

| Asset | License | Where |
| ----- | ------- | ----- |
| **Inter** (UI typeface) | [SIL Open Font License 1.1][ofl] | `public/fonts/inter-*.woff2` |
| **Material Symbols Rounded** (icons) | [Apache License 2.0][apache] | `public/fonts/material-symbols-rounded.woff2` |

Fonts are served by your own instance, never from a CDN. One file per script
subset, so a browser downloads only the scripts a page needs. Regenerate them
with `scripts/fetch-fonts.mjs`.

[ofl]: https://openfontlicense.org/
[apache]: https://www.apache.org/licenses/LICENSE-2.0

## Third-party code dependencies

Bundled Node.js dependencies (Express, better-sqlite3, DuckDB bindings,
Svelte, Capacitor plugins, etc.) each ship under their own permissive
licenses (MIT / Apache-2.0 / BSD variants). See `package.json` and
`server/package.json` for the full dependency lists; run `npm ls --long`
or `npx license-checker` in either directory for machine-readable output.

## Questions

If any of the above needs clarification or you spot something worth
correcting, open an issue on the [GitHub repository][repo] and it'll get
looked at.

[repo]: https://github.com/TraceApps/nutritrace/issues
