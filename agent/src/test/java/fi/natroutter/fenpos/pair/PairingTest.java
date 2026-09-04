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
import static org.junit.jupiter.api.Assertions.assertFalse;
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
    void refusesPlainHttpToANameThatMerelyBeginsLikeALoopbackAddress() {
        // A prefix is not an address. Every one of these is a name someone can register, and
        // the reply to this request carries the bearer token, so admitting one of them sends
        // the credential across the internet in cleartext.
        for (String host : new String[] {
                "127.0.0.1.evil.example", "127.attacker.example", "127.example.com",
                "localhost.evil.example"}) {
            PairingException thrown = assertThrows(PairingException.class,
                    () -> pairing.pair("http://" + host, "AG7K-2M9P"), host);
            assertTrue(thrown.getMessage().contains("https"), host + ": " + thrown.getMessage());
        }
    }

    @Test
    void stillAllowsPlainHttpToTheAddressesThatAreActuallyLoopback() throws Exception {
        // Nothing reaches a network interface, which is the whole basis of the exception. These
        // must keep working or a single-machine install cannot be brought up without a
        // certificate. The port is one nothing listens on, so the failure is a connection
        // refused rather than a scheme refusal, which is what proves the check passed.
        for (String host : new String[] {"127.0.0.1", "127.0.0.2", "[::1]", "localhost", "LOCALHOST"}) {
            PairingException thrown = assertThrows(PairingException.class,
                    () -> pairing.pair("http://" + host + ":1", "AG7K-2M9P"), host);
            assertFalse(thrown.getMessage().contains("requires https"),
                    host + " must pass the scheme check: " + thrown.getMessage());
        }
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

    /**
     * A 502 from a proxy is the failure that started all of this: the agent never reached the
     * server at all, and the proxy's own page is the only thing that says so. Quoting it is the
     * difference between "HTTP 502" and knowing which hop answered.
     */
    @Test
    void quotesAnErrorBodyThatIsNotTheServersJson() {
        status = 502;
        responseBody = "<html><head><title>502 Bad Gateway</title></head>\n"
                + "<body><center><h1>502 Bad Gateway</h1></center><hr><center>nginx</center></body>"
                + "</html>";

        PairingException thrown = assertThrows(PairingException.class, () ->
                pairing.pair(baseUrl(), "AG7K-2M9P"));

        assertTrue(thrown.getMessage().contains("502"), thrown.getMessage());
        assertTrue(thrown.getMessage().contains("nginx"), thrown.getMessage());
        // Flattened to one line, so a whole error page cannot wrap the console prompt.
        assertFalse(thrown.getMessage().contains("\n"), thrown.getMessage());
    }

    @Test
    void trimsALongErrorBodyRatherThanPrintingTheWholePage() {
        status = 503;
        responseBody = "x".repeat(5_000);

        PairingException thrown = assertThrows(PairingException.class, () ->
                pairing.pair(baseUrl(), "AG7K-2M9P"));

        assertTrue(thrown.getMessage().length() < 400, "message was " + thrown.getMessage().length());
        assertTrue(thrown.getMessage().endsWith("…"), thrown.getMessage());
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

    @Test
    void refusesAReplyLargerThanTheCapWithoutBufferingIt() throws Exception {
        // ofString buffers everything before the check can run, so a hostile endpoint chose how
        // much heap this allocated. 4 MiB is enough to prove the read is bounded without making
        // the suite slow.
        respondWith(200, "A".repeat(4 * 1024 * 1024));

        PairingException thrown = assertThrows(PairingException.class,
                () -> pairing.pair(baseUrl(), "AG7K-2M9P"));

        assertTrue(thrown.getMessage().contains("implausibly large"), thrown.getMessage());
    }

    @Test
    void refusesATokenThatCouldNotGoInAHeader() {
        // The token is put in an Authorization header on every connection. A carriage return in
        // it fails the header build, and because the identity is persisted first, the agent then
        // retries once a minute forever and ignores FENPOS_PAIR_CODE on every later boot.
        for (String token : new String[] {"abc\r\ndef", "abc def", "abc\u0000", "", "t".repeat(129)}) {
            respondWithGrant("agent-1", "Kitchen", token);
            assertThrows(PairingException.class, () -> pairing.pair(baseUrl(), "AG7K-2M9P"), token);
        }
    }

    @Test
    void refusesAGrantWhoseIdentifiersAreOutsideTheirBounds() {
        respondWithGrant("a".repeat(65), "Kitchen", "abc");
        assertThrows(PairingException.class, () -> pairing.pair(baseUrl(), "AG7K-2M9P"));

        respondWithGrant("agent-1", "n".repeat(129), "abc");
        assertThrows(PairingException.class, () -> pairing.pair(baseUrl(), "AG7K-2M9P"));
    }

    @Test
    void acceptsTheTokenTheServerActuallyIssues() throws Exception {
        // randomBytes(32).toString("base64url"), which is what lib/auth/secrets.ts mints.
        respondWithGrant("agent-1", "Kitchen", "dGhpcy1pcy1hLWJhc2U2NHVybC10b2tlbi1zYW1wbGUtb2s");

        assertEquals("Kitchen", pairing.pair(baseUrl(), "AG7K-2M9P").agentName());
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
        respondWithGrant("agent-1", "Kitchen agent", "secret-token");
    }

    private void respondWithGrant(String agentId, String agentName, String token) {
        status = 200;
        JsonObject json = new JsonObject();
        json.addProperty("agentId", agentId);
        json.addProperty("agentName", agentName);
        json.addProperty("token", token);
        json.addProperty("protocolVersion", Frames.PROTOCOL_VERSION);
        responseBody = json.toString();
    }

    private void respondWith(int status, String body) {
        this.status = status;
        this.responseBody = body;
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
