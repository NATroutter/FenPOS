package fi.natroutter.fenpos.link;

import fi.natroutter.fenpos.enums.Align;
import fi.natroutter.fenpos.enums.JobState;
import fi.natroutter.fenpos.enums.Linefeed;
import fi.natroutter.fenpos.link.Frames.ConfigSync;
import fi.natroutter.fenpos.link.Frames.Hello;
import fi.natroutter.fenpos.link.Frames.JobDispatch;
import fi.natroutter.fenpos.link.Frames.JobUpdate;
import fi.natroutter.fenpos.link.Frames.Welcome;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertInstanceOf;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Tests for the link codec, weighted heavily toward what it <em>refuses</em>.
 *
 * <p>Authenticating a connection establishes who the peer is, not that what it sends is sane.
 * A frame that parses when it should not is how a compromised or simply buggy server reaches
 * the print path, so the rejections matter more here than the happy path does.
 */
class FrameCodecTest {

    private final FrameCodec codec = new FrameCodec();

    private static String dispatch(String spans, String directives) {
        return """
                {"type":"job.dispatch","job":{"jobId":"job-1","device":"kitchen","linefeed":"LF",
                 "lines":[{"align":"LEFT","spans":[%s],"directives":[%s]}]}}"""
                .formatted(spans, directives);
    }

    private static String span(String overrides) {
        return """
                {"text":"Kahvi","bold":false,"underline":0,"invert":false,
                 "widthMult":1,"heightMult":1,"font":"A"%s}""".formatted(overrides);
    }

    // -----------------------------------------------------------------
    // Writing
    // -----------------------------------------------------------------

    @Test
    void writesHelloWithItsDiscriminator() {
        String json = codec.write(new Hello(Frames.PROTOCOL_VERSION, "1.0.0", "linux-x64", "kitchen-pi"));

        assertTrue(json.contains("\"type\":\"hello\""), json);
        assertTrue(json.contains("\"hostname\":\"kitchen-pi\""), json);
    }

    @Test
    void omitsAbsentOptionalMetrics() {
        String json = codec.write(JobUpdate.of("job-1", JobState.QUEUED, "2026-08-18T10:00:00Z"));

        // Absent rather than null: the server's schema treats the field as optional, and a
        // literal null would fail its validation.
        assertTrue(json.contains("\"type\":\"job.update\""), json);
        assertTrue(!json.contains("\"lines\""), json);
        assertTrue(!json.contains("\"errorCode\""), json);
    }

    @Test
    void writesMetricsWhenPresent() {
        String json = codec.write(new JobUpdate("job-1", JobState.COMPLETED, "2026-08-18T10:00:00Z", 12, 418, null, null));

        assertTrue(json.contains("\"lines\":12"), json);
        assertTrue(json.contains("\"bytes\":418"), json);
    }

    // -----------------------------------------------------------------
    // Reading: accepted
    // -----------------------------------------------------------------

    @Test
    void readsWelcome() throws Exception {
        var frame = codec.read("""
                {"type":"welcome","protocolVersion":1,"agentId":"a1","agentName":"kitchen",
                 "serverTime":"2026-08-18T10:00:00Z"}""");

        Welcome welcome = assertInstanceOf(Welcome.class, frame);
        assertEquals("kitchen", welcome.agentName());
        assertEquals(1, welcome.protocolVersion());
    }

    @Test
    void readsAnEmptyConfigSnapshot() throws Exception {
        var frame = codec.read("{\"type\":\"config.sync\",\"devices\":[]}");

        assertEquals(0, assertInstanceOf(ConfigSync.class, frame).devices().size());
    }

    @Test
    void readsADeviceSnapshot() throws Exception {
        var frame = codec.read("""
                {"type":"config.sync","devices":[{"name":"kitchen","port":"COM3","baudRate":9600,
                 "dataBits":8,"stopBits":1,"parity":"NONE","flowControl":"NONE","writeTimeoutMs":5000,
                 "autoConnect":true,"autoReconnect":true,"reconnectDelaySeconds":5,"columns":42,
                 "codepage":"CP858","paused":false,"maxQueueDepth":100}]}""");

        var device = assertInstanceOf(ConfigSync.class, frame).devices().getFirst();
        assertEquals("kitchen", device.name());
        assertEquals(42, device.columns());
    }

    @Test
    void readsADispatch() throws Exception {
        var frame = codec.read(dispatch(span(""), "{\"type\":\"CUT\",\"mode\":\"FULL\"}"));

        JobDispatch parsed = assertInstanceOf(JobDispatch.class, frame);
        assertEquals("job-1", parsed.job().jobId());
        assertEquals(Linefeed.LF, parsed.job().linefeed());
        assertEquals(Align.LEFT, parsed.job().lines().getFirst().align());
        assertEquals("Kahvi", parsed.job().lines().getFirst().spans().getFirst().text());
    }

    @Test
    void readsADirectiveOnlyLine() throws Exception {
        var frame = codec.read(dispatch("", "{\"type\":\"FEED\",\"lines\":3}"));

        var line = assertInstanceOf(JobDispatch.class, frame).job().lines().getFirst();
        assertTrue(line.spans().isEmpty());
        assertEquals(3, line.directives().getFirst().lines());
    }

    // -----------------------------------------------------------------
    // Reading: refused
    // -----------------------------------------------------------------

    @Test
    void refusesAFrameOverTheSizeLimit() {
        // The cap must bite before parsing, or the oversized frame is already an object graph
        // in memory by the time it is rejected.
        String oversized = "{\"type\":\"welcome\",\"pad\":\"" + "x".repeat(FrameCodec.MAX_FRAME_BYTES) + "\"}";

        assertThrows(ProtocolException.class, () -> codec.read(oversized));
    }

    @Test
    void refusesMalformedJson() {
        assertThrows(ProtocolException.class, () -> codec.read("{ not json"));
    }

    @Test
    void refusesAJsonValueThatIsNotAnObject() {
        assertThrows(ProtocolException.class, () -> codec.read("[]"));
        assertThrows(ProtocolException.class, () -> codec.read("\"welcome\""));
    }

    @Test
    void refusesNull() {
        assertThrows(ProtocolException.class, () -> codec.read(null));
    }

    @Test
    void refusesAnUnknownFrameType() {
        assertThrows(ProtocolException.class, () -> codec.read("{\"type\":\"shell.exec\",\"cmd\":\"rm -rf /\"}"));
    }

    @Test
    void refusesAFrameTheAgentItselfWouldSend() {
        // The agent must not act on its own frame shape echoed back at it.
        assertThrows(ProtocolException.class, () -> codec.read("{\"type\":\"hello\",\"protocolVersion\":1}"));
    }

    @Test
    void refusesAMissingField() {
        assertThrows(ProtocolException.class, () -> codec.read("{\"type\":\"welcome\",\"protocolVersion\":1}"));
    }

    @Test
    void refusesAFieldOfTheWrongType() {
        assertThrows(ProtocolException.class, () -> codec.read("""
                {"type":"welcome","protocolVersion":"one","agentId":"a1","agentName":"k",
                 "serverTime":"2026-08-18T10:00:00Z"}"""));
    }

    @Test
    void refusesAFractionalIntegerRatherThanTruncating() {
        assertThrows(ProtocolException.class, () -> codec.read("""
                {"type":"welcome","protocolVersion":1.5,"agentId":"a1","agentName":"k",
                 "serverTime":"2026-08-18T10:00:00Z"}"""));
    }

    @Test
    void refusesAValueOutsideAnEnum() {
        assertThrows(ProtocolException.class, () -> codec.read("""
                {"type":"config.sync","devices":[{"name":"k","port":"COM3","baudRate":9600,
                 "dataBits":8,"stopBits":1,"parity":"NONE","flowControl":"NONE","writeTimeoutMs":5000,
                 "autoConnect":true,"autoReconnect":true,"reconnectDelaySeconds":5,"columns":42,
                 "codepage":"CP999","paused":false,"maxQueueDepth":100}]}"""));
    }

    @Test
    void refusesASizeMultiplierThePrinterCannotRender() {
        assertThrows(ProtocolException.class, () -> codec.read(dispatch(span("").replace("\"widthMult\":1", "\"widthMult\":9"), "")));
    }

    @Test
    void refusesAnUnderlineWeightOutsideTheEscPosRange() {
        assertThrows(ProtocolException.class,
                () -> codec.read(dispatch(span("").replace("\"underline\":0", "\"underline\":3"), "")));
    }

    @Test
    void refusesASpanLongerThanTheLimit() {
        String long_ = span("").replace("Kahvi", "x".repeat(513));

        assertThrows(ProtocolException.class, () -> codec.read(dispatch(long_, "")));
    }

    @Test
    void refusesAFeedBeyondOneByte() {
        assertThrows(ProtocolException.class, () -> codec.read(dispatch("", "{\"type\":\"FEED\",\"lines\":256}")));
    }

    @Test
    void refusesAnUnknownDirective() {
        assertThrows(ProtocolException.class, () -> codec.read(dispatch("", "{\"type\":\"DRAWER\"}")));
    }

    @Test
    void refusesAnInvalidCutMode() {
        assertThrows(ProtocolException.class,
                () -> codec.read(dispatch("", "{\"type\":\"CUT\",\"mode\":\"HALF\"}")));
    }

    // -----------------------------------------------------------------
    // Device control
    // -----------------------------------------------------------------

    @Test
    void readsAPortScanRequest() {
        Frames.ServerFrame frame = assertDoesNotThrow(() ->
                codec.read("{\"type\":\"ports.scan\",\"requestId\":\"req-1\"}"));

        assertEquals("req-1", assertInstanceOf(Frames.PortsScan.class, frame).requestId());
    }

    @Test
    void refusesAPortScanWithNoRequestId() {
        assertThrows(ProtocolException.class, () -> codec.read("{\"type\":\"ports.scan\"}"));
    }

    @Test
    void readsEveryDeviceCommand() {
        for (String type : new String[] {
                "device.connect", "device.disconnect", "device.pause",
                "device.resume", "device.clearQueue", "device.test"}) {
            Frames.ServerFrame frame = assertDoesNotThrow(() -> codec.read(
                    "{\"type\":\"" + type + "\",\"requestId\":\"r\",\"device\":\"kitchen\"}"));

            Frames.DeviceCommand command = assertInstanceOf(Frames.DeviceCommand.class, frame);
            assertEquals(type, command.type());
            assertEquals("kitchen", command.device());
        }
    }

    @Test
    void refusesADeviceCommandWithNoDevice() {
        assertThrows(ProtocolException.class, () ->
                codec.read("{\"type\":\"device.pause\",\"requestId\":\"r\"}"));
    }

    @Test
    void refusesACommandTypeThatIsNotOneOfTheKnownActions() {
        // An unrecognised action must fail where an unrecognised frame does, so there is no
        // second vocabulary that could quietly diverge from the server's.
        assertThrows(ProtocolException.class, () -> codec.read(
                "{\"type\":\"device.explode\",\"requestId\":\"r\",\"device\":\"kitchen\"}"));
    }

    @Test
    void writesAPortsResultWithItsDiscriminator() {
        String json = codec.write(new Frames.PortsResult("req-1", java.util.List.of(
                new Frames.SerialPort("COM3", "USB Serial", 0x1a86, 0x7523, "ABC123"))));

        assertTrue(json.contains("\"type\":\"ports.result\""), json);
        assertTrue(json.contains("\"requestId\":\"req-1\""), json);
        assertTrue(json.contains("COM3"), json);
    }

    @Test
    void writesACommandResult() {
        String json = codec.write(new Frames.CommandResult("req-1", false, "Could not open COM3"));

        assertTrue(json.contains("\"type\":\"command.result\""), json);
        assertTrue(json.contains("\"ok\":false"), json);
        assertTrue(json.contains("Could not open COM3"), json);
    }

    @Test
    void omitsAnAbsentCommandMessageRatherThanWritingNull() {
        String json = codec.write(new Frames.CommandResult("req-1", true, null));

        assertTrue(!json.contains("message"), json);
    }

    @Test
    void writesAStatusReport() {
        String json = codec.write(new Frames.StatusReport(java.util.List.of(
                new Frames.DeviceStatus(
                        "kitchen", fi.natroutter.fenpos.enums.ConnectionStatus.CONNECTED, false, 3))));

        assertTrue(json.contains("\"type\":\"status.report\""), json);
        assertTrue(json.contains("\"connection\":\"CONNECTED\""), json);
        assertTrue(json.contains("\"queueDepth\":3"), json);
    }

    @Test
    void refusesALineCountBeyondTheLimit() {
        String line = "{\"align\":\"LEFT\",\"spans\":[],\"directives\":[]}";
        String many = String.join(",", java.util.Collections.nCopies(1001, line));

        assertThrows(ProtocolException.class, () -> codec.read(
                "{\"type\":\"job.dispatch\",\"job\":{\"jobId\":\"j\",\"device\":\"k\",\"linefeed\":\"LF\",\"lines\":["
                        + many + "]}}"));
    }
}
