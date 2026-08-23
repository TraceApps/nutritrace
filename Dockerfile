# ── Stage 1: Build Svelte frontend ──────────────────────────────────────────
FROM --platform=$BUILDPLATFORM node:20-alpine AS build
WORKDIR /app
COPY package*.json ./
# scripts/postinstall.cjs is referenced by the "postinstall" npm hook, so it
# must exist before npm install runs. Copy it explicitly here so we don't
# bust the rest of the source-code Docker layer cache on every change.
COPY scripts/ ./scripts/
RUN npm install
COPY . .
RUN npm run build

# ── Stage 2: Express server + static frontend ────────────────────────────────
# Debian-slim base (not Alpine) — the @duckdb/node-bindings-linux-* native
# libraries used by the OFF mirror feature are glibc-linked and won't load
# on musl-based images. On Alpine, DuckDB fails with "Error loading shared
# library ld-linux-*.so.2: No such file or directory" because the glibc
# dynamic linker isn't present. DuckDB does not ship a musl variant of
# those node bindings, so a glibc base is required.
#
# Multi-arch note: this image builds for both linux/amd64 and linux/arm64
# (Raspberry Pi 4 / 5). npm picks the right @duckdb/node-bindings-linux-<arch>
# automatically during install based on the build platform.
FROM node:20-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 build-essential \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY server/package*.json ./
RUN npm install --omit=dev
COPY server/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh
COPY server/ .
COPY --from=build /app/dist ./dist
# The MCP daily-totals tool reuses the shared Nutrition module that also
# powers the Svelte frontend (source of truth for exploded-recipe / legacy
# item summing). Its relative import climbs out of /app/lib/mcp/tools to
# /src/lib/nutrition.js — mirror that path in the container so local dev
# and Docker resolve the same file without a re-export shim.
COPY src/lib/nutrition.js /src/lib/nutrition.js
# Also ship the root package.json so the server can read APP_VERSION from
# it at runtime when TRACEAPPS_APP_VERSION isn't injected via ARG below.
# Keeps versioning working even for builds that don't pass the build-arg.
COPY --from=build /app/package.json ./package.json
# Bake the app version into the image so the in-app updates checker can
# report the running server version. CI can pass `--build-arg
# APP_VERSION=$(node -p 'require("./package.json").version')`; falls
# back to reading /app/package.json at runtime.
ARG APP_VERSION=""
ENV TRACEAPPS_APP_VERSION=${APP_VERSION}
EXPOSE 3001
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "index.js"]
