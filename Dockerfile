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
FROM node:20-alpine
RUN apk add --no-cache python3 make g++
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
