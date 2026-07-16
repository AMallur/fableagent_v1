# ============================================================================
# Single image, three roles (selected by CMD/command in docker-compose or
# your orchestrator): web server, scheduler, and one-shot migration runner.
# No build step — the app runs TypeScript directly via Node's native type
# stripping (see package.json "engines": ">=22.18"), so this is just
# "install prod deps, copy source, run node."
# ============================================================================

FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:22-alpine AS runtime
RUN apk add --no-cache tini \
  && addgroup -S rcm && adduser -S rcm -G rcm
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY scripts ./scripts

# db/migrate.sh + migrations/*.sql are NOT baked into this image — the build
# context is engine/, and ../db is outside it. docker-compose bind-mounts
# the repo's db/ directory read-only for the one-shot migrate service
# instead (see docker-compose.yml), so migrations always run from exactly
# what's checked out, never a stale copy.
RUN mkdir -p var/documents var/ingest && chown -R rcm:rcm /app
USER rcm

EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -q -O- http://localhost:8787/healthz || exit 1

# tini as PID 1 so SIGTERM reaches the Node process (and gets reaped
# correctly) instead of being swallowed — required for the graceful
# shutdown handlers in src/web/main.ts and the scheduler's SIGTERM handler
# to actually run during `docker stop` / a rolling deploy.
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "src/web/main.ts"]

# ----------------------------------------------------------------------------
# Separate, much smaller stage for the one-shot migration runner — needs
# bash + psql, not Node at all. docker-compose bind-mounts the repo's db/
# directory into this at /db (see the note above the runtime stage).
# ----------------------------------------------------------------------------
FROM alpine:3.20 AS migrate
RUN apk add --no-cache bash postgresql16-client
WORKDIR /db
ENTRYPOINT ["bash", "/db/migrate.sh"]
