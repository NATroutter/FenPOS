package fi.natroutter.fenpos.link;

import fi.natroutter.foxlib.logger.FoxLogger;
import fi.natroutter.fenpos.store.AgentIdentity;
import fi.natroutter.fenpos.util.Text;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.net.ServerSocket;
import java.net.URI;
import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
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

    /** How long a test waits for something the fake server or the link should produce quickly. */
    private static final Duration PATIENCE = Duration.ofSeconds(10);

    private LinkClient client;
    private FakeLinkServer server;

    @AfterEach
    void stopClient() {
        if (client != null) {
            client.stop("test over");
        }
        if (server != null) {
            server.close();
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

    // The claim this asserts is the whole point of the frame worker. While a handler is busy
    // the receive thread must stay free, or the server's liveness check fires and it closes
    // the link, taking every printer behind this agent offline for one slow write.
    @Test
    void answersAPingWhileAFrameIsStillBeingHandled() throws Exception {
        CountDownLatch handling = new CountDownLatch(1);
        CountDownLatch release = new CountDownLatch(1);

        server = new FakeLinkServer();
        client = new LinkClient(info, frame -> {
            handling.countDown();
            try {
                release.await(20, TimeUnit.SECONDS);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
        }, logger);
        client.start(identityFor(server.uri()));
        assertNotNull(server.awaitFrame(PATIENCE), "no hello arrived");

        server.send("{\"type\":\"config.sync\",\"devices\":[],\"assets\":[]}");
        assertTrue(handling.await(10, TimeUnit.SECONDS), "the handler never ran");

        server.sendPing();

        assertTrue(server.awaitPong(Duration.ofSeconds(10)),
                "no pong while a handler was busy: the receive thread is blocked");
        release.countDown();
    }

    /**
     * The close reason comes from the far end of the socket, which past the handshake is only as
     * trustworthy as whatever answered on it. Unescaped, a newline in one lets the reason forge
     * what reads as a second, unrelated entry: the logger rewrites every real newline it is given
     * into a line break followed by the level's own colour marker, which is indistinguishable from
     * a fresh entry starting once the terminal renders it. {@link Text#safe} closes that off by
     * leaving no real newline character in the string for the logger to find.
     */
    @Test
    void escapesTheServersCloseReasonBeforeLoggingIt() throws Exception {
        server = new FakeLinkServer();
        client = new LinkClient(info, frame -> {
        }, logger);
        client.start(identityFor(server.uri()));
        assertNotNull(server.awaitFrame(PATIENCE), "no hello arrived");

        String reason = "forged\nline {RED}";
        server.close(4000, reason);

        awaitLines("Link lost", 1);
        List<String> lost = matching("Link lost");
        // The whole point of escaping is that no real newline survives into the logged line, so
        // the sequence right after "forged" can never be mistaken for the start of another entry.
        assertFalse(lost.get(0).contains("forged\n"), lost.get(0));
        assertTrue(lost.get(0).contains(Text.safe("forged\nline")), lost.get(0));
        // The colour pass runs over the line on its way to the terminal and substitutes {RED}
        // wherever it appears. Finding the escaped form intact on the other side is what proves
        // it found nothing to substitute: a match would have consumed the readable RED} with it.
        assertTrue(lost.get(0).contains(Text.safe("{RED}")), lost.get(0));
    }

    /**
     * The server has no other way to learn that a job it dispatched is no longer being worked on.
     * A restart empties this agent's job store, and an update lost to a dropped link is never
     * resent, so without this the server holds such a job as queued for ever. Naming what is still
     * outstanding lets it settle the rest.
     */
    @Test
    void namesTheJobsItStillHoldsInItsHello() throws Exception {
        server = new FakeLinkServer();
        client = new LinkClient(info, frame -> {
        }, logger);
        client.outstandingJobs(() -> List.of("job-a", "job-b"));
        client.start(identityFor(server.uri()));

        String hello = server.awaitFrame(PATIENCE);
        assertNotNull(hello, "no hello arrived");
        assertTrue(hello.contains("\"outstanding\":[\"job-a\",\"job-b\"]"), hello);
    }

    /**
     * An agent that cannot answer the question says nothing rather than guessing. An absent field
     * means "no information", which is also what an older agent sends, so the server treats both
     * the same way and settles nothing on the strength of it.
     */
    @Test
    void omitsOutstandingWhenItHasNoAnswer() throws Exception {
        server = new FakeLinkServer();
        client = new LinkClient(info, frame -> {
        }, logger);
        client.outstandingJobs(() -> null);
        client.start(identityFor(server.uri()));

        String hello = server.awaitFrame(PATIENCE);
        assertNotNull(hello, "no hello arrived");
        assertFalse(hello.contains("outstanding"), hello);
    }

    @Test
    void handlesFramesInTheOrderTheyArrived() throws Exception {
        List<String> order = new CopyOnWriteArrayList<>();
        server = new FakeLinkServer();
        client = new LinkClient(info, frame -> order.add(frame.type()), logger);
        client.start(identityFor(server.uri()));
        assertNotNull(server.awaitFrame(PATIENCE));

        server.send("{\"type\":\"config.sync\",\"devices\":[],\"assets\":[]}");
        server.send("{\"type\":\"job.cancel\",\"jobId\":\"j1\"}");
        server.send("{\"type\":\"ports.scan\",\"requestId\":\"r1\"}");

        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(10);
        while (order.size() < 3 && System.nanoTime() < deadline) {
            Thread.sleep(20);
        }
        assertEquals(List.of("config.sync", "job.cancel", "ports.scan"), order);
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

    private static AgentIdentity identityFor(URI uri) {
        return new AgentIdentity(uri.toString(), "agent-1", "test", "token",
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
