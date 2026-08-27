# syntax=docker/dockerfile:1.7

# ---- dependencies ---------------------------------------------------------
FROM node:22-bookworm-slim AS deps
WORKDIR /build

RUN corepack enable

# Resolved in their own layer so a source-only change does not re-download the
# world on every build.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,target=/pnpm/store pnpm install --frozen-lockfile

# ---- production dependencies ----------------------------------------------
# A second, production-only resolve. The build needs the dev toolchain; the
# running container does not, and shipping it meant carrying Biome, Vitest,
# TypeScript and Tailwind into an image that only ever serves requests.
#
# tsx, prisma and dotenv are production dependencies rather than dev ones,
# because the container genuinely runs them: tsx starts the server, and
# `prisma migrate deploy` reads prisma.config.ts, which imports dotenv.
FROM node:22-bookworm-slim AS prod-deps
WORKDIR /build

RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,target=/pnpm/store pnpm install --prod --frozen-lockfile

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

# No corepack here. The runtime stage never invokes pnpm: doing so made the
# container fetch pnpm from the registry on every start, and pnpm then compared
# node_modules against a lockfile this stage does not carry, decided the tree was
# stale and tried to reinstall — which aborts without a TTY. The binaries in
# node_modules/.bin are called directly instead, so starting needs no network.
# curl is here for the healthcheck and nothing else. node:22-bookworm-slim ships without it,
# so a `curl` probe in compose.yaml would fail every time and hold the container permanently
# unhealthy — the failure looks like a broken app rather than a missing binary.
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --system --create-home --uid 10001 fenpos

WORKDIR /app

# The whole tree rather than a standalone bundle: this process is started by
# `tsx server.ts`, not by Next's own server, because it owns the WebSocket
# upgrade for the agent link. A standalone build has no entry point for that.
#
# Ownership is set by each COPY rather than by a `chown -R` afterwards. A
# recursive chown rewrites every file it touches into a new layer, so the
# thousand-odd megabytes of node_modules were being stored twice — once as
# copied and once as chowned.
COPY --from=prod-deps --chown=fenpos:fenpos /build/node_modules ./node_modules
COPY --from=build --chown=fenpos:fenpos /build/.next ./.next
COPY --from=build --chown=fenpos:fenpos /build/generated ./generated
COPY --from=build --chown=fenpos:fenpos /build/prisma ./prisma
COPY --from=build --chown=fenpos:fenpos /build/package.json ./package.json
COPY --from=build --chown=fenpos:fenpos /build/prisma.config.ts ./prisma.config.ts
# The logs database has its own CLI config, and the start command below migrates through it.
# Without this file that migration fails and the container comes up with nowhere to put a log
# line. It reads lib/database-url.ts, which the lib/ copy further down brings along.
COPY --from=build --chown=fenpos:fenpos /build/prisma-logs.config.ts ./prisma-logs.config.ts
COPY --from=build --chown=fenpos:fenpos /build/server.ts ./server.ts
COPY --from=build --chown=fenpos:fenpos /build/instrumentation.ts ./instrumentation.ts
COPY --from=build --chown=fenpos:fenpos /build/instrumentation-runtime.ts ./instrumentation-runtime.ts
COPY --from=build --chown=fenpos:fenpos /build/next.config.ts ./next.config.ts
COPY --from=build --chown=fenpos:fenpos /build/tsconfig.json ./tsconfig.json
COPY --from=build --chown=fenpos:fenpos /build/lib ./lib
COPY --from=build --chown=fenpos:fenpos /build/app ./app

# The logo, the favicons, and everything else served from the site root. Next serves
# these from the filesystem at run time rather than folding them into `.next`, so
# without this the brand mark and every icon 404 in a built image while working
# perfectly under `next dev`. It is also read as a file rather than served: the
# device test page dithers `fenpos-logo.png` from here, and a missing file fails
# that outright instead of merely leaving a gap in the page.
COPY --from=build --chown=fenpos:fenpos /build/public ./public

# The password is set by running the script in here against the live database, so
# it has to be in the image — without it the documented way to get a first login
# is unavailable exactly where it is needed.
COPY --from=build --chown=fenpos:fenpos /build/scripts ./scripts

RUN mkdir -p /app/data && chown fenpos:fenpos /app /app/data

USER fenpos

ENV NODE_ENV=production \
    PORT=3000 \
    DATABASE_URL="file:/app/data/fenpos.db"

EXPOSE 3000
VOLUME ["/app/data"]

# Migrations run at start rather than in the build, because the database is a
# volume the image has never seen. Deploy rather than dev: it applies what is
# committed and refuses to invent a migration against a production database.
#
# Both databases, in one command, because they are one install. The second is the logs
# database; its URL is derived from DATABASE_URL above, so it lands in the same volume and
# no second path has to be configured. Migrating one and forgetting the other would start a
# server that serves every page and then fails on the first log line it tries to record.
CMD ["sh", "-c", "./node_modules/.bin/prisma migrate deploy && ./node_modules/.bin/prisma migrate deploy --config prisma-logs.config.ts && exec ./node_modules/.bin/tsx server.ts"]
