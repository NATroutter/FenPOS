package fi.natroutter.fenpos.http.endpoints;

import fi.natroutter.fenpos.FenPOS;
import fi.natroutter.fenpos.http.Route;
import io.javalin.http.Context;

import java.time.Duration;
import java.time.Instant;

/**
 * {@code GET /status} — an unauthenticated liveness probe.
 * <p>
 * Deliberately open, and deliberately uninformative: it reveals only that the process is
 * running, which is what a reverse proxy or a container healthcheck needs and nothing an
 * attacker can use. Per-device detail requires a key and lives at
 * {@code /status/<device>}.
 */
public class Status extends Route {

    private final Instant startedAt;

    /**
     * @param startedAt when the process started, used to report uptime
     */
    public Status(Instant startedAt) {
        super("status");
        this.startedAt = startedAt;
    }

    @Override
    public void get(Context ctx) {
        ctx.json(new Health(
                "ok",
                FenPOS.getVERSION(),
                Duration.between(startedAt, Instant.now()).toSeconds()));
    }

    /**
     * @param status        always {@code ok}; the response failing to arrive is the signal
     * @param version       build version
     * @param uptimeSeconds seconds since startup
     */
    private record Health(String status, String version, long uptimeSeconds) {
    }
}
