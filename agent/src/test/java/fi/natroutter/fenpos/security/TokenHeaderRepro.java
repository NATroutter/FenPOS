package fi.natroutter.fenpos.security;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.WebSocket;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertThrows;

/**
 * What the JDK does with a bearer token carrying CR LF, which {@code PairingClient} accepts and
 * {@code LinkClient} then puts into the {@code Authorization} header of every connection attempt.
 *
 * <p>This decides the severity of the finding: a synchronous throw out of {@code connect()} would
 * kill the thread that called it, while a failed future is absorbed by the existing
 * {@code whenComplete} handler and becomes an endless reconnect loop instead.
 */
class TokenHeaderRepro {

    @Test
    @DisplayName("P-03 a token with CR LF fails the WebSocket build rather than injecting a header")
    void controlCharactersInTheTokenFailTheHandshake() throws Exception {
        HttpClient http = HttpClient.newHttpClient();
        String hostileToken = "Bearer abc\r\nX-Injected: 1";

        // The important question: does buildAsync throw here, or return a failed future?
        boolean threwSynchronously;
        CompletableFuture<WebSocket> future = null;
        try {
            future = http.newWebSocketBuilder()
                    .header("Authorization", hostileToken)
                    .buildAsync(URI.create("ws://127.0.0.1:1/api/agent-link"), new WebSocket.Listener() {
                    });
            threwSynchronously = false;
        } catch (RuntimeException e) {
            threwSynchronously = true;
            System.out.println("P-03 buildAsync threw synchronously: " + e);
        }

        if (!threwSynchronously) {
            assertNotNull(future);
            CompletableFuture<WebSocket> pending = future;
            ExecutionException failure = assertThrows(ExecutionException.class,
                    () -> pending.get(10, TimeUnit.SECONDS));
            System.out.println("P-03 buildAsync returned a failed future: " + failure.getCause());
            System.out.println("P-03 -> LinkClient's whenComplete absorbs this and reconnects forever;"
                    + " the stored credential is never usable and never cleared");
        }
    }
}
