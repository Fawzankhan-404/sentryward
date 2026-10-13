# Production image: the API (which also serves the built client) and the
# worker, from one image. Build from the repository root:
#   docker build -f docker/Dockerfile -t sentryward .
# The development setup (docker-compose.yml) uses server/ and client/ instead.

FROM node:24-slim AS client

WORKDIR /client
COPY client/package.json client/package-lock.json ./
RUN npm ci
COPY client/ ./
RUN npm run build

FROM node:24-slim AS server

RUN apt-get update && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY server/package.json server/package-lock.json ./
# tsx and the Prisma CLI are runtime dependencies: the server runs TypeScript
# directly and applies migrations on start.
RUN npm ci --omit=dev && npm cache clean --force
COPY server/prisma.config.ts ./
COPY server/prisma ./prisma
COPY server/src ./src
RUN ./node_modules/.bin/prisma generate

FROM node:24-slim

RUN apt-get update && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    PORT=4000 \
    STATIC_DIR=/app/public

WORKDIR /app
# Owned by root and read-only to the app user: nothing is written at runtime.
COPY --from=server /app ./
COPY --from=client /client/dist ./public

USER node
EXPOSE 4000

# Migrations run before the API listens; the worker service waits for the API
# to be healthy, so it never sees an unmigrated schema.
CMD ["sh", "-c", "./node_modules/.bin/prisma migrate deploy && exec node --import tsx src/index.ts"]
