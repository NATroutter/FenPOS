package fi.natroutter.fenpos.http;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import fi.natroutter.foxlib.logger.FoxLogger;
import fi.natroutter.fenpos.config.data.DeviceSettings;
import fi.natroutter.fenpos.config.data.HttpSettings;
import fi.natroutter.fenpos.config.data.JobSettings;
import fi.natroutter.fenpos.config.data.LimitSettings;
import fi.natroutter.fenpos.config.data.PrintSettings;
import fi.natroutter.fenpos.config.data.ResolvedConfig;
import fi.natroutter.fenpos.config.data.SerialSettings;
import fi.natroutter.fenpos.enums.Codepage;
import fi.natroutter.fenpos.enums.FlowControl;
import fi.natroutter.fenpos.enums.Linefeed;
import fi.natroutter.fenpos.enums.Parity;
import fi.natroutter.fenpos.enums.UnsupportedPolicy;
import fi.natroutter.fenpos.http.endpoints.Jobs;
import fi.natroutter.fenpos.http.endpoints.Print;
import fi.natroutter.fenpos.print.PrintService;
import fi.natroutter.fenpos.serial.FakePrinterPort;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.net.ServerSocket;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Clock;
import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Optional;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Exercises the HTTP API against a real listener, from request to printed bytes.
 * <p>
 * The device is a {@link FakePrinterPort}, which is the only reason this is possible: the
 * accepted-then-printed path is the one thing unit tests cannot reach on their own, and it
 * would otherwise need a serial printer plugged into whatever machine runs the build.
 */
class HttpApiIntegrationTest {

    private static final String KEY = "f3a9c1d84b7e2065a1cf93be7d240c58";

    private final FoxLogger logger = new FoxLogger.Builder()
            .setLoggerName("test")
            .setSaveLogs(false)
            .setConsoleLog(false)
            .build();

    private final HttpClient client = HttpClient.newHttpClient();

    private FakePrinterPort port;
    private PrintService printing;
    private HttpServer server;
    private int boundPort;

    @BeforeEach
    void startServer() throws IOException {
        boundPort = freePort();
        port = new FakePrinterPort(1);

        ResolvedConfig config = config(boundPort);
        // Workers are started per test rather than here: a test that needs a job to sit
        // queued cannot use pause() for that, because a paused device refuses submissions.
        printing = new PrintService(config, name -> Optional.of(port), Clock.systemUTC(), logger);

        DeviceAuthenticator authenticator = new DeviceAuthenticator(config);
        server = new HttpServer(config, logger);
        server.register(
                new Print(printing, authenticator),
                new Jobs(printing, authenticator));
        server.start();
    }

    @AfterEach
    void stopServer() {
        if (server != null) {
            server.stop();
        }
        if (printing != null) {
            printing.shutdown(Duration.ofSeconds(2));
        }
    }

    @Test
    void acceptsAJobPrintsItAndReportsItAsCompleted() throws Exception {
        printing.start();
        HttpResponse<String> accepted = post("/print/kitchen",
                "{\"data\":[\"Kahvi 2.50\",\"<bold>Yhteensa</bold>\"]}");

        assertEquals(202, accepted.statusCode());
        JsonObject body = JsonParser.parseString(accepted.body()).getAsJsonObject();
        String id = body.get("id").getAsString();
        assertEquals("QUEUED", body.get("status").getAsString());
        assertTrue(id.matches("[0-9a-f]{8}"));

        assertTrue(port.awaitWrites(5000), "the job should reach the port");

        JsonObject job = awaitTerminalJob(id);
        assertEquals("COMPLETED", job.get("status").getAsString());
        assertEquals("kitchen", job.get("device").getAsString());
        assertEquals(2, job.get("lines").getAsInt());
        assertTrue(job.get("bytes").getAsInt() > 0);
    }

    /**
     * The whole point of compiling before acknowledging: the bytes handed to the device are
     * a complete ESC/POS stream, beginning with the reset and codepage selection.
     */
    @Test
    void writesAWellFormedEscPosStreamToTheDevice() throws Exception {
        printing.start();
        post("/print/kitchen", "{\"data\":[\"hi\"]}");
        assertTrue(port.awaitWrites(5000));

        byte[] written = port.writes().getFirst();
        assertEquals(0x1B, written[0], "stream should start with ESC");
        assertEquals(0x40, written[1], "followed by @, resetting the printer");
        assertEquals(0x1B, written[2]);
        assertEquals(0x74, written[3], "then ESC t, selecting the codepage");
        assertEquals(0x13, written[4], "CP858 is table 19");
    }

    @Test
    void aJobCanBeCancelledBeforeItPrints() throws Exception {
        String id = JsonParser.parseString(post("/print/kitchen", "{\"data\":[\"x\"]}").body())
                .getAsJsonObject().get("id").getAsString();

        HttpResponse<String> cancelled = delete("/jobs/" + id);

        assertEquals(200, cancelled.statusCode());
        assertEquals("CANCELLED",
                JsonParser.parseString(cancelled.body()).getAsJsonObject()
                        .get("status").getAsString());
    }

    @Test
    void cancellingAFinishedJobIsAConflict() throws Exception {
        printing.start();
        String id = JsonParser.parseString(post("/print/kitchen", "{\"data\":[\"x\"]}").body())
                .getAsJsonObject().get("id").getAsString();
        assertTrue(port.awaitWrites(5000));
        awaitTerminalJob(id);

        HttpResponse<String> response = delete("/jobs/" + id);

        assertEquals(409, response.statusCode());
        assertEquals("job_not_cancellable",
                JsonParser.parseString(response.body()).getAsJsonObject()
                        .get("error").getAsString());
    }

    /** A key is scoped to its own device's jobs, and cannot even confirm others exist. */
    @Test
    void aJobIsInvisibleToAnotherDevicesKey() throws Exception {
        String id = JsonParser.parseString(post("/print/kitchen", "{\"data\":[\"x\"]}").body())
                .getAsJsonObject().get("id").getAsString();

        HttpResponse<String> response = client.send(
                HttpRequest.newBuilder(uri("/jobs/" + id))
                        .header("Authorization", "Bearer " + "0f1e2d3c4b5a69788796a5b4c3d2e1f0")
                        .GET().build(),
                HttpResponse.BodyHandlers.ofString());

        assertEquals(404, response.statusCode());
    }

    /** Non-ASCII survives the whole path: HTTP decoding, validation, and encoding. */
    @Test
    void printsNordicTextAndTheEuroSign() throws Exception {
        printing.start();
        HttpResponse<String> response =
                post("/print/kitchen", "{\"data\":[\"Hyvää päivää €10\"]}");

        assertEquals(202, response.statusCode());
        assertTrue(port.awaitWrites(5000));

        byte[] written = port.writes().getFirst();
        assertTrue(indexOf(written, new byte[]{(byte) 0xD5}) > 0,
                "euro sign should encode to 0xD5 in CP858");
    }

    // -------------------------------------------------------------------------
    // Helpers
    // -------------------------------------------------------------------------

    private HttpResponse<String> post(String path, String body) throws Exception {
        return client.send(
                HttpRequest.newBuilder(uri(path))
                        .header("Authorization", "Bearer " + KEY)
                        .header("Content-Type", "application/json")
                        .POST(HttpRequest.BodyPublishers.ofString(body, StandardCharsets.UTF_8))
                        .build(),
                HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
    }

    private HttpResponse<String> delete(String path) throws Exception {
        return client.send(
                HttpRequest.newBuilder(uri(path))
                        .header("Authorization", "Bearer " + KEY)
                        .DELETE().build(),
                HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
    }

    private URI uri(String path) {
        return URI.create("http://127.0.0.1:" + boundPort + path);
    }

    /** Polls the job endpoint until the record reaches a terminal state. */
    private JsonObject awaitTerminalJob(String id) throws Exception {
        long deadline = System.nanoTime() + Duration.ofSeconds(5).toNanos();
        while (System.nanoTime() < deadline) {
            HttpResponse<String> response = client.send(
                    HttpRequest.newBuilder(uri("/jobs/" + id))
                            .header("Authorization", "Bearer " + KEY)
                            .GET().build(),
                    HttpResponse.BodyHandlers.ofString());
            JsonObject job = JsonParser.parseString(response.body()).getAsJsonObject();
            String status = job.get("status").getAsString();
            if (!status.equals("QUEUED") && !status.equals("PRINTING")) {
                return job;
            }
        }
        throw new AssertionError("job " + id + " never reached a terminal state");
    }

    private static int freePort() throws IOException {
        try (ServerSocket socket = new ServerSocket(0)) {
            return socket.getLocalPort();
        }
    }

    private static int indexOf(byte[] haystack, byte[] needle) {
        outer:
        for (int start = 0; start + needle.length <= haystack.length; start++) {
            for (int offset = 0; offset < needle.length; offset++) {
                if (haystack[start + offset] != needle[offset]) {
                    continue outer;
                }
            }
            return start;
        }
        return -1;
    }

    private static ResolvedConfig config(int httpPort) {
        Map<String, DeviceSettings> devices = new LinkedHashMap<>();
        devices.put("kitchen", device("kitchen", KEY));
        devices.put("bar", device("bar", "0f1e2d3c4b5a69788796a5b4c3d2e1f0"));
        return new ResolvedConfig(
                new HttpSettings(true, "127.0.0.1", httpPort, null),
                new JobSettings(Duration.ofMinutes(10), 500, Duration.ofSeconds(5)),
                devices);
    }

    private static DeviceSettings device(String name, String key) {
        return new DeviceSettings(name, key,
                new SerialSettings("COM3", 9600, 8, 1, Parity.NONE, FlowControl.NONE,
                        false, false, Duration.ofSeconds(5), Duration.ofMillis(5000)),
                new PrintSettings(42, Codepage.CP858, UnsupportedPolicy.REJECT, true, Linefeed.LF),
                LimitSettings.DEFAULTS);
    }
}
