package fi.natroutter.fenpos.link;

import fi.natroutter.foxlib.logger.FoxLogger;
import fi.natroutter.fenpos.device.DeviceRegistry;
import fi.natroutter.fenpos.enums.Align;
import fi.natroutter.fenpos.enums.Codepage;
import fi.natroutter.fenpos.enums.FlowControl;
import fi.natroutter.fenpos.enums.Font;
import fi.natroutter.fenpos.enums.JobState;
import fi.natroutter.fenpos.enums.Linefeed;
import fi.natroutter.fenpos.enums.Parity;
import fi.natroutter.fenpos.print.JobSettings;
import fi.natroutter.fenpos.print.PrintService;
import fi.natroutter.fenpos.serial.DeviceConnectionManager;
import fi.natroutter.fenpos.serial.FakePrinterPort;
import fi.natroutter.fenpos.serial.PrinterPort;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;

import java.time.Clock;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Tests for what the agent does with what the server sends.
 * <p>
 * The premise being tested is distrust: a dispatch is checked against this agent's own device
 * set, a job it cannot render is refused, a repeated identifier prints nothing, and every
 * refusal is reported. A dropped job that is never reported leaves the panel showing
 * {@code QUEUED} forever, which looks like a slow printer rather than one that will never print.
 */
class LinkDispatcherTest {

    private final FoxLogger logger = new FoxLogger.Builder()
            .setLoggerName("test")
            .setSaveLogs(false)
            .setConsoleLog(false)
            .build();

    private final DeviceRegistry registry = new DeviceRegistry();
    private final Map<String, PrinterPort> ports = new HashMap<>();
    private final List<Frames.AgentFrame> sent = Collections.synchronizedList(new ArrayList<>());
    private final List<List<Frames.DeviceConfig>> applied = new ArrayList<>();

    private final PrintService printing = new PrintService(
            registry,
            new JobSettings(Duration.ofMinutes(10), 500, Duration.ofMillis(200)),
            name -> Optional.ofNullable(ports.get(name)),
            Clock.systemUTC(),
            logger);

    private final DeviceConnectionManager connections =
            new DeviceConnectionManager(registry, logger);

    private final LinkDispatcher dispatcher =
            new LinkDispatcher(registry, printing, connections, this::applyConfig, logger);

    LinkDispatcherTest() {
        dispatcher.attach(frame -> {
            sent.add(frame);
            return true;
        });
    }

    @AfterEach
    void stopQueues() {
        printing.shutdown(Duration.ofSeconds(2));
        connections.shutdown();
    }

    // -------------------------------------------------------------------------
    // Configuration
    // -------------------------------------------------------------------------

    @Test
    void adoptsADeviceSetTheServerPushes() {
        dispatcher.accept(new Frames.ConfigSync(List.of(device("kitchen")), List.of(), JobSettings.DEFAULTS));

        assertEquals(1, applied.size());
        assertEquals("kitchen", applied.get(0).get(0).name());
        assertEquals(1, registry.size());
    }

    @Test
    void adoptsAnEmptyDeviceSet() {
        dispatcher.accept(new Frames.ConfigSync(List.of(device("kitchen")), List.of(), JobSettings.DEFAULTS));

        dispatcher.accept(new Frames.ConfigSync(List.of(), List.of(), JobSettings.DEFAULTS));

        assertEquals(0, registry.size());
    }

    /**
     * The images are part of the same snapshot, so adopting one adopts both. Without this a job
     * naming a logo would fail on an agent the server had just finished configuring.
     */
    @Test
    void adoptsTheImagesThatArriveWithTheDeviceSet() {
        dispatcher.accept(new Frames.ConfigSync(
                List.of(device("kitchen")),
                List.of(new Frames.AssetRaster("logo", 16, 2, new byte[4])),
                JobSettings.DEFAULTS));

        assertEquals(2, registry.raster("logo", 16).orElseThrow().heightDots());
    }

    @Test
    void survivesAWelcomeFromAServerOnADifferentProtocol() {
        // The server closes the connection over this itself; the agent's job is to say why in
        // its own log rather than to fall over.
        dispatcher.accept(new Frames.Welcome(99, "a1", "Kitchen agent", "2026-08-18T20:00:00Z"));

        assertTrue(updates().isEmpty());
    }

    // -------------------------------------------------------------------------
    // Dispatch
    // -------------------------------------------------------------------------

    @Test
    void printsADispatchedJob() throws Exception {
        FakePrinterPort port = configure("kitchen");

        dispatcher.accept(dispatch("job-1", "kitchen", "Kahvi 2.50"));

        assertTrue(port.awaitWrites(5000));
        assertTrue(new String(port.writes().get(0), "ISO-8859-1").contains("Kahvi 2.50"));
    }

    @Test
    void reportsAJobItPrinted() throws Exception {
        FakePrinterPort port = configure("kitchen");

        dispatcher.accept(dispatch("job-1", "kitchen", "Kahvi"));
        assertTrue(port.awaitWrites(5000));

        Frames.JobUpdate completed = awaitUpdate("job-1", JobState.COMPLETED);
        assertNotNull(completed.lines());
        assertNotNull(completed.bytes());
        assertEquals(1, completed.lines());
    }

    @Test
    void reportsThatItStartedPrinting() throws Exception {
        FakePrinterPort port = configure("kitchen");

        dispatcher.accept(dispatch("job-1", "kitchen", "Kahvi"));
        assertTrue(port.awaitWrites(5000));

        assertNotNull(awaitUpdate("job-1", JobState.PRINTING));
    }

    @Test
    void refusesAJobForADeviceItDoesNotHave() {
        configure("kitchen");

        dispatcher.accept(dispatch("job-1", "bar", "Kahvi"));

        Frames.JobUpdate failed = awaitUpdate("job-1", JobState.FAILED);
        assertEquals("unknown_device", failed.errorCode());
        assertTrue(failed.errorMessage().contains("bar"));
    }

    @Test
    void refusesAJobItCannotRender() {
        configure("kitchen");

        // Past what the render model lets a printer be asked to feed. The codec would have
        // refused it, but a job reaching the dispatcher some other way must still fail cleanly
        // rather than take the print path down.
        Frames.WireLine bad = new Frames.WireLine(
                Align.LEFT, List.of(), List.of(new Frames.WireDirective.Feed(999)));
        dispatcher.accept(new Frames.JobDispatch(
                new Frames.CompiledJob("job-1", "kitchen", Linefeed.LF, List.of(bad))));

        Frames.JobUpdate failed = awaitUpdate("job-1", JobState.FAILED);
        assertEquals("invalid_job", failed.errorCode());
    }

    /**
     * The same outcome for a throw out of the renderer that is not a {@link ProtocolException}.
     * <p>
     * {@code IrRenderer.render} converts an encoder's refusal and wraps a directive's, but a span
     * with an out-of-range multiplier is validated by {@code SpanStyle}'s own constructor, outside
     * either of those — so an {@code IllegalArgumentException} escaped {@code render}, escaped this
     * method, and was swallowed by {@code LinkClient}'s top-level frame handler, which logs and
     * carries on. The job was never reported, so the panel showed QUEUED forever. An
     * {@code UncheckedIOException} out of the byte stream had the same shape.
     * <p>
     * Reported with a generic reason on purpose: an internal exception message is not written for
     * whoever wrote the markup, and the stack that explains it belongs in the agent's log.
     */
    @Test
    void reportsAJobWhoseRenderFailsForAReasonNobodyEnumerated() {
        configure("kitchen");

        // Past what SpanStyle accepts. The codec bounds this too, but a job reaching the dispatcher
        // some other way must still be reported rather than vanish.
        Frames.WireLine bad = new Frames.WireLine(
                Align.LEFT,
                List.of(new Frames.WireSpan("Kahvi", false, 0, false, 99, 1, Font.A)),
                List.of());
        dispatcher.accept(new Frames.JobDispatch(
                new Frames.CompiledJob("job-1", "kitchen", Linefeed.LF, List.of(bad))));

        Frames.JobUpdate failed = awaitUpdate("job-1", JobState.FAILED);
        assertEquals("invalid_job", failed.errorCode());
        assertFalse(failed.errorMessage().contains("widthMult"),
                "an internal exception message must not be reported to the server as the job's reason");
    }

    @Test
    void printsARepeatedJobIdentifierOnlyOnce() throws Exception {
        FakePrinterPort port = configure("kitchen");

        dispatcher.accept(dispatch("job-1", "kitchen", "Kahvi"));
        assertTrue(port.awaitWrites(5000));
        dispatcher.accept(dispatch("job-1", "kitchen", "Kahvi"));

        // A dispatch can arrive twice — a server retry after a close it did not see
        // acknowledged, or a spool replayed on reconnect — and a receipt printed twice costs
        // whoever is holding the paper.
        Thread.sleep(250);
        assertEquals(1, port.writeCount());
    }

    @Test
    void doesNotReportJobsTheServerNeverIssued() throws Exception {
        FakePrinterPort port = configure("kitchen");

        printing.submit(registry.device("kitchen").orElseThrow(), "{\"data\":[\"local\"]}");
        assertTrue(port.awaitWrites(5000));
        Thread.sleep(150);

        // A console job carries an identifier the server never issued. Reporting it would make
        // the server log a warning for a job it has no record of.
        assertTrue(updates().isEmpty(), "expected no job updates, got " + sent);
    }

    @Test
    void reportsAJobTheQueueRefused() throws Exception {
        FakePrinterPort port = new FakePrinterPort(1);
        port.failWrites();
        ports.put("kitchen", port);
        dispatcher.accept(new Frames.ConfigSync(List.of(device("kitchen")), List.of(), JobSettings.DEFAULTS));
        printing.start();

        dispatcher.accept(dispatch("job-1", "kitchen", "Kahvi"));

        Frames.JobUpdate failed = awaitUpdate("job-1", JobState.FAILED);
        assertEquals("print_failed", failed.errorCode());
        assertFalse(failed.errorMessage().isBlank());
    }

    // -------------------------------------------------------------------------
    // Device control
    // -------------------------------------------------------------------------

    @Test
    void answersAScanWithTheSerialPortsItCanSee() {
        dispatcher.accept(new Frames.PortsScan("req-1"));

        Frames.PortsResult result = awaitFrame(Frames.PortsResult.class);
        // The machine running the tests may have no serial ports at all, which is a valid
        // answer; what matters is that the request is answered and correlated.
        assertEquals("req-1", result.requestId());
        assertNotNull(result.ports());
    }

    @Test
    void pausesAndResumesADevice() {
        configure("kitchen");

        dispatcher.accept(command("device.pause", "req-1", "kitchen"));
        assertTrue(printing.queue("kitchen").isPaused());
        assertTrue(awaitFrame(Frames.CommandResult.class).ok());

        sent.clear();
        dispatcher.accept(command("device.resume", "req-2", "kitchen"));
        assertFalse(printing.queue("kitchen").isPaused());
    }

    @Test
    void clearsAQueueAndSaysHowManyItCancelled() {
        FakePrinterPort port = new FakePrinterPort(1);
        ports.put("kitchen", port);
        dispatcher.accept(new Frames.ConfigSync(List.of(device("kitchen")), List.of(), JobSettings.DEFAULTS));
        // Deliberately not started, so submitted jobs stay pending and can be counted.
        dispatcher.accept(dispatch("job-1", "kitchen", "one"));
        dispatcher.accept(dispatch("job-2", "kitchen", "two"));
        sent.clear();

        dispatcher.accept(command("device.clearQueue", "req-1", "kitchen"));

        Frames.CommandResult result = awaitFrame(Frames.CommandResult.class);
        assertTrue(result.ok());
        assertTrue(result.message().contains("2"), result.message());
    }

    @Test
    void printsATestPageOnRequest() throws Exception {
        FakePrinterPort port = configure("kitchen");

        dispatcher.accept(command("device.test", "req-1", "kitchen"));

        assertTrue(port.awaitWrites(5000));
        assertTrue(new String(port.writes().get(0), "ISO-8859-1").contains("FenPOS test page"));
        assertTrue(awaitFrame(Frames.CommandResult.class).ok());
    }

    @Test
    void refusesACommandForADeviceItDoesNotHave() {
        configure("kitchen");
        sent.clear();

        dispatcher.accept(command("device.pause", "req-1", "bar"));

        Frames.CommandResult result = awaitFrame(Frames.CommandResult.class);
        assertFalse(result.ok());
        assertTrue(result.message().contains("bar"));
    }

    @Test
    void correlatesEveryAnswerWithItsRequest() {
        configure("kitchen");
        sent.clear();

        dispatcher.accept(command("device.pause", "the-request", "kitchen"));

        assertEquals("the-request", awaitFrame(Frames.CommandResult.class).requestId());
    }

    // -------------------------------------------------------------------------
    // Status reporting
    // -------------------------------------------------------------------------

    @Test
    void reportsDeviceStateWhenConfigurationArrives() {
        configure("kitchen");

        Frames.StatusReport report = awaitFrame(Frames.StatusReport.class);
        assertEquals(1, report.devices().size());
        assertEquals("kitchen", report.devices().get(0).name());
        assertEquals(0, report.devices().get(0).queueDepth());
    }

    @Test
    void reportsDeviceStateAfterACommandChangesIt() {
        configure("kitchen");
        sent.clear();

        dispatcher.accept(command("device.pause", "req-1", "kitchen"));

        assertTrue(awaitFrame(Frames.StatusReport.class).devices().get(0).paused());
    }

    @Test
    void reportsNoDevicesWhenTheServerRemovesThemAll() {
        configure("kitchen");
        sent.clear();

        dispatcher.accept(new Frames.ConfigSync(List.of(), List.of(), JobSettings.DEFAULTS));

        assertTrue(awaitFrame(Frames.StatusReport.class).devices().isEmpty());
    }

    // -------------------------------------------------------------------------
    // Log forwarding
    // -------------------------------------------------------------------------

    @Test
    void forwardsAJobRefusalToTheServer() {
        configure("kitchen");
        sent.clear();

        dispatcher.accept(dispatch("job-1", "bar", "Kahvi"));

        Frames.LogLine line = awaitFrame(Frames.LogLine.class);
        assertEquals(fi.natroutter.fenpos.enums.LogLevel.WARN, line.level());
        assertTrue(line.message().contains("bar"), line.message());
    }

    @Test
    void forwardsAnAcceptedJobWithItsDevice() throws Exception {
        FakePrinterPort port = configure("kitchen");
        sent.clear();

        dispatcher.accept(dispatch("job-1", "kitchen", "Kahvi"));
        assertTrue(port.awaitWrites(5000));

        Frames.LogLine line = awaitFrame(Frames.LogLine.class);
        assertEquals("kitchen", line.device());
        assertNotNull(line.at());
    }

    @Test
    void forwardsACommandOutcome() {
        configure("kitchen");
        sent.clear();

        dispatcher.accept(command("device.pause", "req-1", "kitchen"));

        Frames.LogLine line = awaitFrame(Frames.LogLine.class);
        assertEquals(fi.natroutter.fenpos.enums.LogLevel.INFO, line.level());
        assertEquals("kitchen", line.device());
    }

    // -------------------------------------------------------------------------
    // Fixtures
    // -------------------------------------------------------------------------

    private static Frames.DeviceCommand command(String type, String requestId, String device) {
        return new Frames.DeviceCommand(type, requestId, device);
    }

    /** Waits for the most recent frame of a kind, failing the test if none arrives. */
    private <T extends Frames.AgentFrame> T awaitFrame(Class<T> kind) {
        long deadline = System.currentTimeMillis() + 5000;
        while (System.currentTimeMillis() < deadline) {
            synchronized (sent) {
                for (int index = sent.size() - 1; index >= 0; index--) {
                    if (kind.isInstance(sent.get(index))) {
                        return kind.cast(sent.get(index));
                    }
                }
            }
            try {
                Thread.sleep(10);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                break;
            }
        }
        throw new AssertionError("no " + kind.getSimpleName() + "; saw " + sent);
    }

    /** Mirrors the bootstrap: registry first, then the serial layer, then the queues. */
    private void applyConfig(List<Frames.DeviceConfig> wire) {
        applied.add(wire);
        registry.apply(wire);
        connections.applyDevices();
        printing.applyDevices();
    }

    /** Registers a port for a device, pushes it as configuration, and starts the queues. */
    private FakePrinterPort configure(String name) {
        FakePrinterPort port = new FakePrinterPort(1);
        ports.put(name, port);
        dispatcher.accept(new Frames.ConfigSync(List.of(device(name)), List.of(), JobSettings.DEFAULTS));
        printing.start();
        return port;
    }

    /** Returns only the job updates sent, since status reports also flow over the same link. */
    private List<Frames.JobUpdate> updates() {
        synchronized (sent) {
            return sent.stream()
                    .filter(frame -> frame instanceof Frames.JobUpdate)
                    .map(frame -> (Frames.JobUpdate) frame)
                    .toList();
        }
    }

    /** Waits for an update reporting a job in a state, failing the test if none arrives. */
    private Frames.JobUpdate awaitUpdate(String jobId, JobState state) {
        long deadline = System.currentTimeMillis() + 5000;
        while (System.currentTimeMillis() < deadline) {
            synchronized (sent) {
                for (Frames.AgentFrame frame : sent) {
                    if (frame instanceof Frames.JobUpdate update
                            && update.jobId().equals(jobId)
                            && update.status() == state) {
                        return update;
                    }
                }
            }
            try {
                Thread.sleep(10);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                break;
            }
        }
        throw new AssertionError("no " + state + " update for " + jobId + "; saw " + sent);
    }

    private static Frames.JobDispatch dispatch(String jobId, String device, String text) {
        Frames.WireLine line = new Frames.WireLine(
                Align.LEFT,
                List.of(new Frames.WireSpan(text, false, 0, false, 1, 1, Font.A)),
                List.of());
        return new Frames.JobDispatch(
                new Frames.CompiledJob(jobId, device, Linefeed.LF, List.of(line)));
    }

    private static Frames.DeviceConfig device(String name) {
        return new Frames.DeviceConfig(
                name, "COM3", 19200, 8, 1, Parity.NONE, FlowControl.NONE,
                5000, false, false, 5, 32, Codepage.CP858, false, 10);
    }
}
