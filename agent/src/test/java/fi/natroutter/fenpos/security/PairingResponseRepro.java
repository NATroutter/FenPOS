package fi.natroutter.fenpos.security;

import com.sun.net.httpserver.HttpServer;
import fi.natroutter.fenpos.link.AgentInfo;
import fi.natroutter.fenpos.pair.PairingClient;
import fi.natroutter.fenpos.pair.PairingException;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.io.OutputStream;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Reproductions for the pairing findings, against a real loopback HTTP server.
 *
 * <p>Loopback is what makes these runnable without a certificate: {@code PairingClient} permits
 * plain http to 127.0.0.1, which is the documented exception.
 */
class PairingResponseRepro {

    /** How large a reply the hostile server sends. The client's stated cap is 8 KiB. */
    private static final int HOSTILE_BODY_BYTES = 32 * 1024 * 1024;

    private HttpServer server;
    private volatile long bytesWritten;

    @BeforeEach
    void start() throws Exception {
        server = HttpServer.create(new InetSocketAddress(InetAddress.getLoopbackAddress(), 0), 0);
        server.start();
    }

    @AfterEach
    void stop() {
        server.stop(0);
    }

    private String base() {
        return "http://127.0.0.1:" + server.getAddress().getPort();
    }

    private static AgentInfo info() {
        return new AgentInfo("audit", "test", "audit-host");
    }

    @Test
    @DisplayName("P-01 the 8 KiB reply cap is applied after the whole body has been buffered")
    void oversizedReplyIsBufferedBeforeItIsRefused() throws Exception {
        server.createContext("/api/pair", exchange -> {
            byte[] chunk = "A".repeat(64 * 1024).getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().add("Content-Type", "application/json");
            exchange.sendResponseHeaders(200, HOSTILE_BODY_BYTES);
            long sent = 0;
            try (OutputStream out = exchange.getResponseBody()) {
                while (sent < HOSTILE_BODY_BYTES) {
                    out.write(chunk);
                    sent += chunk.length;
                }
            }
            bytesWritten = sent;
        });

        PairingException thrown = assertThrows(PairingException.class,
                () -> new PairingClient().redeem(base(), "CODE-1234", info()));

        assertTrue(thrown.getMessage().contains("implausibly large"),
                "the size check ran, which means the body reached it: " + thrown.getMessage());
        assertTrue(bytesWritten >= HOSTILE_BODY_BYTES,
                "the server wrote the whole body and the client accepted all of it");
        System.out.println("P-01 the agent buffered " + (bytesWritten / (1024 * 1024))
                + " MiB into heap before applying its 8 KiB cap");
    }

    @Test
    @DisplayName("P-02 an 8 KiB token with control characters is accepted and stored")
    void hostileGrantFieldsAreAccepted() throws Exception {
        String token = "t".repeat(4000) + "\r\nX-Injected: 1";
        String name = "[2J[H" + "n".repeat(200);
        server.createContext("/api/pair", exchange -> {
            byte[] body = ("{\"agentId\":\"" + "i".repeat(500) + "\",\"agentName\":\"" + name
                    + "\",\"token\":\"" + token + "\",\"protocolVersion\":3}")
                    .getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().add("Content-Type", "application/json");
            exchange.sendResponseHeaders(200, body.length);
            try (OutputStream out = exchange.getResponseBody()) {
                out.write(body);
            }
        });

        var grant = new PairingClient().redeem(base(), "CODE-1234", info());

        assertEquals(500, grant.agentId().length());
        assertTrue(grant.token().contains("\r\n"), "CR LF survived into the stored bearer token");
        assertTrue(grant.agentName().startsWith("["), "an ANSI escape survived into the agent name");
        System.out.println("P-02 accepted agentId of " + grant.agentId().length()
                + " chars, a " + grant.token().length()
                + "-char token containing CR LF, and an agent name beginning with an ANSI escape");
    }

    @Test
    @DisplayName("control: a redirect is not followed, so the credential is not re-sent to another origin")
    void redirectsAreNotFollowed() {
        server.createContext("/api/pair", exchange -> {
            exchange.getResponseHeaders().add("Location", "https://elsewhere.invalid/api/pair");
            exchange.sendResponseHeaders(307, -1);
            exchange.close();
        });

        PairingException thrown = assertThrows(PairingException.class,
                () -> new PairingClient().redeem(base(), "CODE-1234", info()));
        assertTrue(thrown.getMessage().contains("307"),
                "the redirect is surfaced rather than followed: " + thrown.getMessage());
        System.out.println("control: " + thrown.getMessage());
    }

    @Test
    @DisplayName("control: plain http to a non-loopback host is refused before a socket is opened")
    void plainHttpToRoutableHostIsRefused() {
        PairingException thrown = assertThrows(PairingException.class,
                () -> new PairingClient().redeem("http://fenpos.example.com", "CODE-1234", info()));
        assertTrue(thrown.getMessage().contains("requires https"), thrown.getMessage());
        System.out.println("control: " + thrown.getMessage());
    }
}
