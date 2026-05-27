# ── Stage 1: Build Svelte frontend ──────────────────────────────────────────
FROM node:20-alpine AS build
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
# Debian-slim base (not Alpine) — the @duckdb/node-bindings-linux-x64 native
# library used by the OFF mirror feature is glibc-linked and won't load on
# musl-based images. On Alpine, DuckDB fails with "Error loading shared
# library ld-linux-x86-64.so.2: No such file or directory" because the
# glibc dynamic linker isn't present. DuckDB does not ship a musl variant
# of those node bindings, so a glibc base is required.
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
EXPOSE 3001
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "index.js"]
