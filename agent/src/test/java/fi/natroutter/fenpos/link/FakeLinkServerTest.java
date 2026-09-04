package fi.natroutter.fenpos.link;

import fi.natroutter.foxlib.logger.FoxLogger;
import fi.natroutter.fenpos.store.AgentIdentity;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;

import java.time.Duration;
import java.time.Instant;

import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * The harness has to be trustworthy before anything is concluded from it, so this proves the
 * handshake completes and a real {@link LinkClient} talks to it in both directions.
 */
class FakeLinkServerTest {

    private static final Duration PATIENCE = Duration.ofSeconds(10);

    private FakeLinkServer server;
    private LinkClient client;

    @AfterEach
    void stop() {
        if (client != null) {
            client.stop("test over");
        }
        if (server != null) {
            server.close();
        }
    }

    @Test
    void completesTheHandshakeAndReceivesTheAgentsHello() throws Exception {
        server = new FakeLinkServer();
        client = new LinkClient(info(), frame -> {
        }, logger());

        client.start(new AgentIdentity(server.uri().toString(), "agent-1", "Kitchen", "token",
                Instant.parse("2026-09-04T10:00:00Z")));

        String hello = server.awaitFrame(PATIENCE);
        assertNotNull(hello, "no hello arrived");
        assertTrue(hello.contains("\"type\":\"hello\""), hello);
        assertTrue(hello.contains("\"protocolVersion\":3"), hello);
    }

    @Test
    void deliversAFrameFromTheServerToTheHandler() throws Exception {
        java.util.concurrent.LinkedBlockingQueue<Frames.ServerFrame> handled =
                new java.util.concurrent.LinkedBlockingQueue<>();
        server = new FakeLinkServer();
        client = new LinkClient(info(), handled::add, logger());
        client.start(new AgentIdentity(server.uri().toString(), "agent-1", "Kitchen", "token",
                Instant.parse("2026-09-04T10:00:00Z")));
        server.awaitFrame(PATIENCE);

        server.send("{\"type\":\"config.sync\",\"devices\":[],\"assets\":[]}");

        Frames.ServerFrame frame = handled.poll(PATIENCE.toMillis(),
                java.util.concurrent.TimeUnit.MILLISECONDS);
        assertNotNull(frame, "no frame reached the handler");
        assertTrue(frame instanceof Frames.ConfigSync, frame.type());
    }

    private static AgentInfo info() {
        return new AgentInfo("1.0.0-test", "TestOS x64", "test-host");
    }

    private static FoxLogger logger() {
        return new FoxLogger.Builder().setLoggerName("test").setSaveLogs(false)
                .setPrintter(line -> {
                }).build();
    }
}
