# syntax=docker/dockerfile:1.7

# ---- build ----------------------------------------------------------------
FROM maven:3.9-eclipse-temurin-25 AS build
WORKDIR /build

# Dependencies resolve in their own layer so a source-only change does not
# re-download the world on every build.
COPY pom.xml .
RUN --mount=type=cache,target=/root/.m2 mvn -B dependency:go-offline

COPY src ./src
RUN --mount=type=cache,target=/root/.m2 mvn -B package \
 && mv target/ThermAPI-*.jar target/thermapi.jar

# ---- runtime --------------------------------------------------------------
# Debian rather than Alpine: jSerialComm ships native libraries per platform and
# the glibc builds are the well-trodden path. Chasing a musl variant to save
# ~40 MB on a service that talks to a printer is a poor trade.
FROM eclipse-temurin:25-jre-noble

LABEL org.opencontainers.image.title="ThermAPI" \
      org.opencontainers.image.description="HTTP API for serial ESC/POS receipt printers" \
      org.opencontainers.image.source="https://github.com/NATroutter/ThermAPI" \
      org.opencontainers.image.licenses="MIT"

# curl is used by the compose healthcheck, which runs inside this container
# wherever it is declared, and doubles as the obvious tool for poking at the API
# from a docker exec shell.
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --system --create-home --uid 10001 thermapi

WORKDIR /app
COPY --from=build /build/target/thermapi.jar /app/thermapi.jar
RUN mkdir -p /app/logs && chown -R thermapi:thermapi /app

# Never root: device access comes from a supplementary group instead (see
# compose.yaml). A fixed uid keeps bind-mounted log ownership predictable.
USER thermapi

EXPOSE 8080
VOLUME ["/app/logs"]

# MaxRAMPercentage rather than -Xmx so the heap tracks the container limit, which
# makes mem_limit the single place memory is configured.
#
# --enable-native-access silences JLine's native-loader warning on Java 25. It is
# not cosmetic: restricted native access is scheduled to become an error in a
# later JDK, which would stop the console loading at all.
ENTRYPOINT ["java", \
            "-XX:MaxRAMPercentage=75.0", \
            "--enable-native-access=ALL-UNNAMED", \
            "-jar", "/app/thermapi.jar"]
