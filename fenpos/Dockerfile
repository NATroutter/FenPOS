# syntax=docker/dockerfile:1.7

# ---- dependencies ---------------------------------------------------------
FROM node:22-bookworm-slim AS deps
WORKDIR /build

RUN corepack enable

# Resolved in their own layer so a source-only change does not re-download the
# world on every build.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,target=/pnpm/store pnpm install --frozen-lockfile

# ---- build ----------------------------------------------------------------
FROM node:22-bookworm-slim AS build
WORKDIR /build

RUN corepack enable

COPY --from=deps /build/node_modules ./node_modules
COPY . .

# Prisma's client is generated code, not a package, so it has to be produced
# before the type checker or the bundler can see it.
RUN pnpm db:generate

# A build-time value only. Next validates the environment at build, and the real
# database is not reachable from a build container — nothing here touches it.
ENV DATABASE_URL="file:./data/build.db"
RUN pnpm build

# ---- runtime --------------------------------------------------------------
FROM node:22-bookworm-slim

LABEL org.opencontainers.image.title="FenPOS" \
      org.opencontainers.image.description="Print server and admin panel for ESC/POS receipt printers" \
      org.opencontainers.image.source="https://github.com/NATroutter/FenPOS" \
      org.opencontainers.image.licenses="MIT"

RUN corepack enable \
 && useradd --system --create-home --uid 10001 fenpos

WORKDIR /app

# The whole tree rather than a standalone bundle: this process is started by
# `tsx server.ts`, not by Next's own server, because it owns the WebSocket
# upgrade for the agent link. A standalone build has no entry point for that.
COPY --from=build /build/node_modules ./node_modules
COPY --from=build /build/.next ./.next
COPY --from=build /build/generated ./generated
COPY --from=build /build/prisma ./prisma
COPY --from=build /build/package.json ./package.json
COPY --from=build /build/prisma.config.ts ./prisma.config.ts
COPY --from=build /build/server.ts ./server.ts
COPY --from=build /build/instrumentation.ts ./instrumentation.ts
COPY --from=build /build/instrumentation-runtime.ts ./instrumentation-runtime.ts
COPY --from=build /build/next.config.ts ./next.config.ts
COPY --from=build /build/tsconfig.json ./tsconfig.json
COPY --from=build /build/lib ./lib
COPY --from=build /build/app ./app

RUN mkdir -p /app/data && chown -R fenpos:fenpos /app

USER fenpos

ENV NODE_ENV=production \
    PORT=3000 \
    DATABASE_URL="file:/app/data/fenpos.db"

EXPOSE 3000
VOLUME ["/app/data"]

# Migrations run at start rather than in the build, because the database is a
# volume the image has never seen. Deploy rather than dev: it applies what is
# committed and refuses to invent a migration against a production database.
CMD ["sh", "-c", "pnpm db:deploy && pnpm start"]
