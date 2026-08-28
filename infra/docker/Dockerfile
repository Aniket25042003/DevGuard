# syntax=docker/dockerfile:1
# DevGuard modular-monolith role image (C100).
#
# One application artifact, three runtime roles. ROLE is one of:
#   api    -> node apps/api/dist/main.js   (REST/SSE/webhooks)
#   worker -> node apps/worker/dist/main.js (queue consumers, no ingress)
#   web    -> node apps/web/dist/index.js   (UI/server rendering, no DB/provider secrets)
#
# The web role intentionally receives NO database, Redis, GitHub App private
# key, or TrueForge API key. Worker has no public ingress. Migration is a
# one-shot job run against the same image (see compose.deploy.yml) that only
# touches PostgreSQL.
ARG ROLE=api

# ---- build: install the pnpm monorepo and typecheck/build every package ----
FROM node:22-alpine AS build
WORKDIR /srv
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json tsconfig.json ./
COPY packages ./packages
COPY apps ./apps
# Reproducible: frozen lockfile, no postinstall scripts, no network at runtime.
RUN pnpm install --frozen-lockfile --ignore-scripts && pnpm build

# ---- runtime: lean, non-root, read-only where the framework permits ----
FROM node:22-alpine AS runtime
WORKDIR /srv
ENV NODE_ENV=production
COPY --from=build /srv ./
# Non-root; no Docker socket; no host network; secrets injected at runtime only.
USER node
# ROLE selects the entrypoint baked into the same artifact.
CMD ["sh", "-c", "case \"$ROLE\" in api) exec node apps/api/dist/main.js ;; worker) exec node apps/worker/dist/main.js ;; web) exec node apps/web/dist/index.js ;; *) echo \"unknown ROLE=$ROLE\" >&2; exit 1 ;; esac"]