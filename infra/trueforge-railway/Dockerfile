# TrueForge hosted mode for Railway (Postgres + Redis wired via env vars).
FROM node:24-slim

WORKDIR /app

ENV NODE_ENV=production \
    STANDALONE=false \
    HOST=0.0.0.0

ARG APP_VERSION=0.1.4
RUN npm install --omit=dev "@truefoundry/trueforge@${APP_VERSION}" \
  && npm cache clean --force \
  && groupadd --gid 10001 trueforge \
  && useradd --uid 10001 --gid trueforge --shell /usr/sbin/nologin trueforge

USER 10001:10001

EXPOSE 8790

CMD ["node", "node_modules/@truefoundry/trueforge/dist/main.js"]
