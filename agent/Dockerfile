# syntax=docker/dockerfile:1.7

# ---- build ----------------------------------------------------------------
# Pinned to the builder's own architecture. The jar is portable — jSerialComm carries its
# native libraries for every platform inside it — so there is nothing to gain from compiling
# it again under emulation for each target, and a great deal of time to lose.
FROM --platform=$BUILDPLATFORM maven:3.9-eclipse-temurin-25 AS build
WORKDIR /build

# Dependencies resolve in their own layer so a source-only change does not
# re-download the world on every build.
COPY pom.xml .
RUN --mount=type=cache,target=/root/.m2 mvn -B dependency:go-offline

COPY src ./src
RUN --mount=type=cache,target=/root/.m2 mvn -B package \
 && mv target/fenpos-agent-*.jar target/fenpos-agent.jar

# ---- runtime --------------------------------------------------------------
# Debian rather than Alpine: jSerialComm ships native libraries per platform and
# the glibc builds are the well-trodden path. Chasing a musl variant to save
# ~40 MB on a service that talks to a printer is a poor trade.
FROM eclipse-temurin:25-jre-noble

LABEL org.opencontainers.image.title="FenPOS Agent" \
      org.opencontainers.image.description="Printer agent for FenPOS: drives serial ESC/POS printers" \
      org.opencontainers.image.source="https://github.com/NATroutter/FenPOS" \
      org.opencontainers.image.licenses="MIT"

# No curl. It was here for a healthcheck against the agent's own HTTP API, and
# the agent no longer has one — it dials the server and never listens. Dropping
# it removes a package, a layer, and a tool an attacker would otherwise find
# waiting in a container that talks to hardware.
RUN useradd --system --create-home --uid 10001 fenpos-agent

WORKDIR /app
COPY --from=build /build/target/fenpos-agent.jar /app/fenpos-agent.jar
# Only the two directories the agent writes to. The jar stays root-owned and read-only to the
# process, so a foothold in the agent cannot rewrite what runs on the next restart, and cannot
# create the lib/ directory the manifest used to name.
RUN mkdir -p /app/logs /app/data && chown -R fenpos-agent:fenpos-agent /app/logs /app/data

# Never root: device access comes from a supplementary group instead (see
# compose.yaml). A fixed uid keeps bind-mounted log ownership predictable.
USER fenpos-agent

# No EXPOSE and no HEALTHCHECK. The agent dials the server and never listens, so
# there is no port to publish and nothing to probe from inside the container.
# Whether it is reachable is a question only the server can answer, and the
# Agents tab does.
#
# /app/data holds the agent's identity — the server address and the credential
# issued at pairing. Losing it means re-pairing with a fresh code.
VOLUME ["/app/logs", "/app/data"]

# MaxRAMPercentage rather than -Xmx so the heap tracks the container limit, which
# makes mem_limit the single place memory is configured.
#
# --enable-native-access silences JLine's native-loader warning on Java 25. It is
# not cosmetic: restricted native access is scheduled to become an error in a
# later JDK, which would stop the console loading at all.
ENTRYPOINT ["java", \
            "-XX:MaxRAMPercentage=75.0", \
            "--enable-native-access=ALL-UNNAMED", \
            "-jar", "/app/fenpos-agent.jar"]
