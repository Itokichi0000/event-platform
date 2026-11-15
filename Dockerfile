# syntax=docker/dockerfile:1
# Two images from one build: `server` (API) and `web` (Caddy serving the PWA + proxying /api).

FROM node:22-slim AS build
WORKDIR /app
RUN corepack enable
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/core/package.json packages/core/
COPY packages/messaging/package.json packages/messaging/
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm --filter @kamen/web build && pnpm --filter @kamen/server build

FROM node:22-slim AS server
WORKDIR /app
ENV NODE_ENV=production
# better-sqlite3 ships prebuilt native binaries inside the npm package.
RUN npm init -y >/dev/null && npm install --omit=dev --no-audit --no-fund better-sqlite3@13.2.0
COPY --from=build /app/apps/server/dist ./dist
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
ENV DATABASE_PATH=/data/kamen.sqlite PORT=8787
EXPOSE 8787
CMD ["node", "dist/main.mjs"]

FROM caddy:2.10-alpine AS web
COPY deploy/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /app/apps/web/dist /srv
