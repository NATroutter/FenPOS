package fi.natroutter.fenpos.pair;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import fi.natroutter.foxlib.logger.FoxLogger;
import fi.natroutter.fenpos.link.AgentInfo;
import fi.natroutter.fenpos.link.Frames;
import fi.natroutter.fenpos.store.AgentIdentity;
import fi.natroutter.fenpos.store.AgentStore;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.util.HashMap;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Tests for pairing, end to end over a real socket and into a real database.
 * <p>
 * The redemption call is the one moment this agent's long-lived credential crosses a network, so
 * the transport rules are asserted as behaviour rather than trusted to review: plain HTTP to a
 * named host is refused before a socket is opened, and the only exception is an address that
 * cannot leave the machine.
 */
class PairingTest {

    private final FoxLogger logger = new FoxLogger.Builder()
            .setLoggerName("test")
            .setSaveLogs(false)
            .setConsoleLog(false)
            .build();

    private final AgentInfo info = new AgentInfo("1.0.0-test", "TestOS x64", "test-host");

    private HttpServer server;
    private AgentStore store;
    private PairingService pairing;

    /** The body the stub server last received, so the request shape can be asserted. */
    private final AtomicReference<String> lastRequest = new AtomicReference<>();

    /** What the stub server answers with, set per test. */
    private volatile int status = 200;
    private volatile String responseBody = "";

    @BeforeEach
    void startServer(@TempDir Path directory) throws Exception {
        server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/api/pair", this::handle);
        server.start();

        store = AgentStore.open(directory.resolve("agent.db"));
        pairing = new PairingService(store, new PairingClient(), info);
    }

    @AfterEach
    void stopServer() {
        if (server != null) {
            server.stop(0);
        }
        if (store != null) {
            store.close();
        }
    }

    // -------------------------------------------------------------------------
    // Transport security
    // -------------------------------------------------------------------------

    @Test
    void refusesPlainHttpToANamedHost() {
        PairingException thrown = assertThrows(PairingException.class, () ->
                pairing.pair("http://fenpos.example.com", "AG7K-2M9P"));

        // The reply carries the credential. Over http anyone on the path can read it, so this
        // must fail before a socket is opened rather than warn and proceed.
        assertTrue(thrown.getMessage().contains("https"), thrown.getMessage());
    }

    @Test
    void allowsPlainHttpToLoopbackBecauseNothingCanObserveIt() throws Exception {
        respondWithGrant();

        AgentIdentity identity = pairing.pair(baseUrl(), "AG7K-2M9P");

        assertEquals("Kitchen agent", identity.agentName());
    }

    @Test
    void refusesAnAddressWithNoScheme() {
        PairingException thrown = assertThrows(PairingException.class, () ->
                pairing.pair("fenpos.example.com", "AG7K-2M9P"));

        assertTrue(thrown.getMessage().contains("scheme"), thrown.getMessage());
    }

    @Test
    void refusesAnEmptyAddress() {
        assertThrows(PairingException.class, () -> pairing.pair("  ", "AG7K-2M9P"));
    }

    @Test
    void refusesAnEmptyCodeWithoutCallingTheServer() {
        assertThrows(PairingException.class, () -> pairing.pair(baseUrl(), " "));

        assertNull(lastRequest.get());
    }

    // -------------------------------------------------------------------------
    // Redemption
    // -------------------------------------------------------------------------

    @Test
    void sendsTheCodeTheProtocolVersionAndItsOwnDescription() throws Exception {
        respondWithGrant();

        pairing.pair(baseUrl(), "  AG7K-2M9P  ");

        JsonObject sent = JsonParser.parseString(lastRequest.get()).getAsJsonObject();
        assertEquals("AG7K-2M9P", sent.get("code").getAsString());
        assertEquals(Frames.PROTOCOL_VERSION, sent.get("protocolVersion").getAsInt());
        assertEquals("1.0.0-test", sent.get("agentVersion").getAsString());
        assertEquals("test-host", sent.get("hostname").getAsString());
    }

    @Test
    void persistsTheCredentialAsPartOfPairing() throws Exception {
        respondWithGrant();

        pairing.pair(baseUrl(), "AG7K-2M9P");

        // A grant issued but not stored is the worst outcome available: the server has marked
        // the code consumed and the agent has nothing.
        Optional<AgentIdentity> stored = store.identity();
        assertTrue(stored.isPresent());
        assertEquals("agent-1", stored.get().agentId());
        assertEquals("secret-token", stored.get().token());
    }

    @Test
    void storesTheAddressWithoutATrailingSlash() throws Exception {
        respondWithGrant();

        AgentIdentity identity = pairing.pair(baseUrl() + "/", "AG7K-2M9P");

        assertEquals(baseUrl(), identity.serverUrl());
    }

    @Test
    void reportsARefusedCodeInTermsTheOperatorCanActOn() {
        status = 401;
        responseBody = "{\"error\":\"invalid_key\",\"message\":\"That pairing code is not valid.\"}";

        PairingException thrown = assertThrows(PairingException.class, () ->
                pairing.pair(baseUrl(), "WRONG-CODE"));

        // The server answers wrong, expired and already-used identically so the endpoint is not
        // an oracle. The agent reflects that honestly instead of asserting a reason.
        assertTrue(thrown.getMessage().contains("mistyped"), thrown.getMessage());
        assertTrue(thrown.getMessage().contains("expired"), thrown.getMessage());
    }

    @Test
    void reportsRateLimitingSeparatelyFromARefusal() {
        status = 429;
        responseBody = "{\"error\":\"rate_limited\"}";

        PairingException thrown = assertThrows(PairingException.class, () ->
                pairing.pair(baseUrl(), "AG7K-2M9P"));

        assertTrue(thrown.getMessage().contains("rate limiting"), thrown.getMessage());
    }

    @Test
    void refusesAServerOnADifferentProtocolVersion() {
        status = 200;
        responseBody = "{\"agentId\":\"a1\",\"agentName\":\"n\",\"token\":\"t\",\"protocolVersion\":99}";

        PairingException thrown = assertThrows(PairingException.class, () ->
                pairing.pair(baseUrl(), "AG7K-2M9P"));

        assertTrue(thrown.getMessage().contains("99"), thrown.getMessage());
    }

    @Test
    void refusesAReplyThatIsMissingTheCredential() {
        status = 200;
        responseBody = "{\"agentId\":\"a1\",\"agentName\":\"n\"}";

        assertThrows(PairingException.class, () -> pairing.pair(baseUrl(), "AG7K-2M9P"));
    }

    @Test
    void refusesAReplyThatIsNotJson() {
        status = 200;
        responseBody = "<html>not a fenpos server</html>";

        PairingException thrown = assertThrows(PairingException.class, () ->
                pairing.pair(baseUrl(), "AG7K-2M9P"));

        assertTrue(thrown.getMessage().contains("FenPOS server"), thrown.getMessage());
    }

    // -------------------------------------------------------------------------
    // Unpairing
    // -------------------------------------------------------------------------

    @Test
    void unpairingClearsTheStoredCredential() throws Exception {
        respondWithGrant();
        pairing.pair(baseUrl(), "AG7K-2M9P");

        Optional<AgentIdentity> cleared = pairing.unpair();

        assertTrue(cleared.isPresent());
        assertTrue(store.identity().isEmpty());
    }

    @Test
    void unpairingWhenNotPairedReportsNothingToClear() throws Exception {
        assertTrue(pairing.unpair().isEmpty());
    }

    // -------------------------------------------------------------------------
    // Environment bootstrap
    // -------------------------------------------------------------------------

    @Test
    void pairsFromTheEnvironmentOnFirstBoot() {
        respondWithGrant();

        Optional<AgentIdentity> identity = environment(Map.of(
                EnvironmentPairing.SERVER_VARIABLE, baseUrl(),
                EnvironmentPairing.CODE_VARIABLE, "AG7K-2M9P")).resolve();

        assertTrue(identity.isPresent());
        assertEquals("Kitchen agent", identity.get().agentName());
    }

    @Test
    void ignoresTheCodeOnceAlreadyPaired() throws Exception {
        respondWithGrant();
        pairing.pair(baseUrl(), "AG7K-2M9P");
        lastRequest.set(null);

        Optional<AgentIdentity> identity = environment(Map.of(
                EnvironmentPairing.SERVER_VARIABLE, baseUrl(),
                EnvironmentPairing.CODE_VARIABLE, "A-DIFFERENT-CODE")).resolve();

        // Leaving the code in compose.yaml is expected — it is single use and already spent —
        // so a stored identity must win rather than the agent re-pairing on every restart.
        assertTrue(identity.isPresent());
        assertNull(lastRequest.get());
    }

    @Test
    void idlesWhenThereIsNeitherAnIdentityNorACode() {
        assertTrue(environment(Map.of()).resolve().isEmpty());
    }

    @Test
    void idlesWhenOnlyOneOfTheTwoVariablesIsSet() {
        assertTrue(environment(Map.of(EnvironmentPairing.SERVER_VARIABLE, baseUrl()))
                .resolve().isEmpty());
        assertTrue(environment(Map.of(EnvironmentPairing.CODE_VARIABLE, "AG7K-2M9P"))
                .resolve().isEmpty());
    }

    @Test
    void treatsABlankVariableAsAbsent() {
        assertTrue(environment(Map.of(
                EnvironmentPairing.SERVER_VARIABLE, "   ",
                EnvironmentPairing.CODE_VARIABLE, "   ")).resolve().isEmpty());
    }

    @Test
    void doesNotStopTheAgentWhenTheCodeIsRefused() {
        status = 401;
        responseBody = "{\"error\":\"invalid_key\"}";

        Optional<AgentIdentity> identity = environment(Map.of(
                EnvironmentPairing.SERVER_VARIABLE, baseUrl(),
                EnvironmentPairing.CODE_VARIABLE, "EXPIRED")).resolve();

        // An agent that exits on an expired code just restart-loops in Docker and buries the
        // reason. It reports and idles instead.
        assertTrue(identity.isEmpty());
    }

    // -------------------------------------------------------------------------
    // Fixtures
    // -------------------------------------------------------------------------

    private EnvironmentPairing environment(Map<String, String> values) {
        Map<String, String> copy = new HashMap<>(values);
        return new EnvironmentPairing(pairing, logger, copy::get);
    }

    private void respondWithGrant() {
        status = 200;
        responseBody = "{\"agentId\":\"agent-1\",\"agentName\":\"Kitchen agent\","
                + "\"token\":\"secret-token\",\"protocolVersion\":" + Frames.PROTOCOL_VERSION + "}";
    }

    private String baseUrl() {
        return "http://127.0.0.1:" + server.getAddress().getPort();
    }

    private void handle(HttpExchange exchange) throws IOException {
        try (exchange) {
            lastRequest.set(new String(
                    exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8));

            byte[] body = responseBody.getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().add("Content-Type", "application/json");
            exchange.sendResponseHeaders(status, body.length);
            exchange.getResponseBody().write(body);
        }
    }

}
