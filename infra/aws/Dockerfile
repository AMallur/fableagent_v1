# Build from the repository root:
#   docker build -f infra/aws/Dockerfile --target runtime .
FROM node:22.18.0-alpine AS deps
WORKDIR /app
COPY engine/package.json engine/package-lock.json ./
RUN npm ci --omit=dev

FROM node:22.18.0-alpine AS runtime
RUN apk add --no-cache tini \
  && addgroup -S fable && adduser -S fable -G fable
WORKDIR /app
ENV NODE_ENV=production PORT=8787
COPY --from=deps /app/node_modules ./node_modules
COPY engine/package.json ./
COPY engine/src ./src
COPY engine/scripts ./scripts
RUN mkdir -p var/documents var/ingest && chown -R fable:fable /app
USER fable
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -q -O- http://localhost:8787/healthz || exit 1
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "src/web/main.ts"]

FROM alpine:3.20 AS migrate
RUN apk add --no-cache bash postgresql16-client ca-certificates
COPY db /db
ENTRYPOINT ["bash", "/db/bootstrap_aws.sh"]
