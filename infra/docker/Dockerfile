# syntax=docker/dockerfile:1
# DevGuard modular-monolith role image (C100).
#
# One application artifact, three runtime roles. ROLE is one of:
#   api    -> node apps/api/dist/main.js   (REST/SSE/webhooks)
#   worker -> node apps/worker/dist/main.js (queue consumers, no ingress)
#   web    -> next start in apps/web       (UI; no DB/provider secrets)
#
# Migration is a one-shot job: node scripts/deploy/migrate.mjs
ARG ROLE=api

# ---- build: install the pnpm monorepo and typecheck/build every package ----
FROM node:26-alpine AS build
WORKDIR /srv
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json tsconfig.json ./
COPY packages ./packages
COPY apps ./apps
COPY scripts ./scripts
RUN pnpm install --frozen-lockfile --ignore-scripts && pnpm build

# ---- runtime: lean, non-root; curl for compose healthchecks ----
FROM node:26-alpine AS runtime
WORKDIR /srv
RUN apk add --no-cache curl
ENV NODE_ENV=production
COPY --from=build /srv ./
USER node
CMD ["sh", "-c", "case \"$ROLE\" in api) exec node apps/api/dist/main.js ;; worker) exec node apps/worker/dist/main.js ;; web) exec pnpm --filter @devguard/web start ;; *) echo \"unknown ROLE=$ROLE\" >&2; exit 1 ;; esac"]
