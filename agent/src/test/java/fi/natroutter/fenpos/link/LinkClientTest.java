package fi.natroutter.fenpos.link;

import fi.natroutter.foxlib.logger.FoxLogger;
import fi.natroutter.fenpos.store.AgentIdentity;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.net.ServerSocket;
import java.time.Instant;
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * What the link says while it cannot connect.
 * <p>
 * This is asserted as behaviour rather than left to review because it regressed once already, in
 * the direction that is hardest to notice: the client used to report the first five failures and
 * then go quiet, which read in the container log as an agent that had given up. An operator
 * diagnosing an outage is reading exactly this stretch of log, and a missing line there costs more
 * than a repeated one.
 */
class LinkClientTest {

    /** Every line the client logged, in order. Written from the link's own threads. */
    private final List<String> lines = new CopyOnWriteArrayList<>();

    private final FoxLogger logger = new FoxLogger.Builder()
            .setLoggerName("test")
            .setSaveLogs(false)
            .setConsoleLog(true)
            .setPrintter(lines::add)
            .build();

    private final AgentInfo info = new AgentInfo("1.0.0-test", "TestOS x64", "test-host");

    private LinkClient client;

    @AfterEach
    void stopClient() {
        if (client != null) {
            client.stop("test over");
        }
    }

    /**
     * How far past the old cutoff to run. The throttle this replaced reported the first five
     * failures and then one in thirty, so a run that stops at five would pass against the very
     * behaviour being guarded against.
     */
    private static final int ATTEMPTS_TO_PROVE = 10;

    /**
     * Reports failure after failure, past the point the old throttle would have gone quiet.
     * <p>
     * Driven by a backoff that does not wait, because at the real delays the tenth attempt is
     * several minutes away and this would have to be tested by inspection instead.
     */
    @Test
    void reportsEveryFailedAttemptRatherThanFallingSilent() throws Exception {
        client = new LinkClient(info, frame -> {
        }, logger, impatient());
        client.start(identityFor(deadPort()));

        awaitLines("Could not connect", ATTEMPTS_TO_PROVE);

        List<String> failures = matching("Could not connect");
        // Each one names which attempt it was, so a reader can see the sequence progressing
        // rather than wondering whether the same line is being repeated — and so that a gap in
        // the middle is visible here rather than hidden by a total that happens to add up.
        for (int attempt = 1; attempt <= ATTEMPTS_TO_PROVE; attempt++) {
            String line = failures.get(attempt - 1);
            assertTrue(line.contains("attempt " + attempt + " since the last success"), line);
        }
    }

    /** The wait between attempts is stated, so a quiet minute is never unexplained. */
    @Test
    void saysHowLongItWillWaitBeforeTheNextAttempt() throws Exception {
        client = new LinkClient(info, frame -> {
        }, logger, impatient());
        client.start(identityFor(deadPort()));

        awaitLines("Next connection attempt in", ATTEMPTS_TO_PROVE);

        assertTrue(matching("Next connection attempt in").size() >= ATTEMPTS_TO_PROVE);
    }

    /** A frame that cannot go anywhere is recorded rather than dropped on the floor. */
    @Test
    void reportsAFrameItCouldNotSendBecauseTheLinkIsDown() {
        client = new LinkClient(info, frame -> {
        }, logger);

        boolean sent = client.send(new Frames.StatusReport(List.of()));

        assertFalse(sent);
        assertTrue(matching("Dropped status.report").size() == 1, lines.toString());
    }

    // -------------------------------------------------------------------------
    // Helpers
    // -------------------------------------------------------------------------

    /** A retry sequence with the waiting taken out, so ten attempts take milliseconds. */
    private static Backoff impatient() {
        return new Backoff(java.time.Duration.ofMillis(1), java.time.Duration.ofMillis(1));
    }

    /** A port nothing is listening on, so every attempt is refused immediately. */
    private static int deadPort() throws IOException {
        try (ServerSocket socket = new ServerSocket(0)) {
            return socket.getLocalPort();
        }
    }

    private static AgentIdentity identityFor(int port) {
        return new AgentIdentity("http://127.0.0.1:" + port, "agent-1", "test", "token",
                Instant.parse("2026-09-03T10:00:00Z"));
    }

    /** Waits until the log holds at least {@code count} lines containing {@code fragment}. */
    private void awaitLines(String fragment, int count) throws InterruptedException {
        long deadline = System.nanoTime() + java.util.concurrent.TimeUnit.SECONDS.toNanos(20);
        while (System.nanoTime() < deadline) {
            if (matching(fragment).size() >= count) {
                return;
            }
            Thread.sleep(50);
        }
        throw new AssertionError("timed out waiting for " + count + " lines containing '"
                + fragment + "'; saw " + lines);
    }

    private List<String> matching(String fragment) {
        return lines.stream().filter(line -> line.contains(fragment)).toList();
    }
}
