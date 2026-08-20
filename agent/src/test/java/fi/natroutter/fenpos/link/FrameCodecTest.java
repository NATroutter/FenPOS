package fi.natroutter.fenpos.link;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import fi.natroutter.fenpos.enums.Align;
import fi.natroutter.fenpos.enums.BarcodeSystem;
import fi.natroutter.fenpos.enums.CutMode;
import fi.natroutter.fenpos.enums.JobState;
import fi.natroutter.fenpos.enums.Linefeed;
import fi.natroutter.fenpos.link.Frames.ConfigSync;
import fi.natroutter.fenpos.link.Frames.Hello;
import fi.natroutter.fenpos.link.Frames.JobDispatch;
import fi.natroutter.fenpos.link.Frames.JobUpdate;
import fi.natroutter.fenpos.link.Frames.Welcome;
import fi.natroutter.fenpos.link.Frames.WireDirective;
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
        assertEquals(3, assertInstanceOf(WireDirective.Feed.class, line.directives().getFirst()).lines());
    }

    // -----------------------------------------------------------------
    // Reading: the block directives
    //
    // Each variant carries only its own fields, so a directive that parses is one the
    // renderer can emit without asking whether an optional field happens to be present.
    // -----------------------------------------------------------------

    @Test
    void decodesACutDirective() throws Exception {
        JsonObject json = JsonParser.parseString("{\"type\":\"CUT\",\"mode\":\"PARTIAL\"}").getAsJsonObject();

        WireDirective directive = FrameCodec.readDirective(json);

        assertEquals(CutMode.PARTIAL, assertInstanceOf(WireDirective.Cut.class, directive).mode());
    }

    @Test
    void decodesAQrDirective() throws Exception {
        JsonObject json = JsonParser.parseString(
                "{\"type\":\"QR\",\"content\":\"https://x.test\",\"size\":6}").getAsJsonObject();

        WireDirective directive = FrameCodec.readDirective(json);

        assertInstanceOf(WireDirective.Qr.class, directive);
        assertEquals(6, ((WireDirective.Qr) directive).size());
    }

    @Test
    void decodesABarcodeDirective() throws Exception {
        JsonObject json = JsonParser.parseString(
                "{\"type\":\"BARCODE\",\"system\":\"EAN13\",\"content\":\"4006381333931\"}").getAsJsonObject();

        WireDirective.Barcode barcode =
                assertInstanceOf(WireDirective.Barcode.class, FrameCodec.readDirective(json));

        assertEquals(BarcodeSystem.EAN13, barcode.system());
        assertEquals("4006381333931", barcode.content());
    }

    @Test
    void decodesAPdf417Directive() throws Exception {
        JsonObject json = JsonParser.parseString(
                "{\"type\":\"PDF417\",\"content\":\"ORDER-42\",\"errorLevel\":0}").getAsJsonObject();

        assertEquals(0, assertInstanceOf(
                WireDirective.Pdf417.class, FrameCodec.readDirective(json)).errorLevel());
    }

    @Test
    void decodesBothDrawerPins() throws Exception {
        for (int pin : new int[] {2, 5}) {
            JsonObject json = JsonParser.parseString(
                    "{\"type\":\"DRAWER\",\"pin\":" + pin + "}").getAsJsonObject();

            assertEquals(pin, assertInstanceOf(
                    WireDirective.Drawer.class, FrameCodec.readDirective(json)).pin());
        }
    }

    @Test
    void rejectsAnUnknownDirectiveType() {
        JsonObject json = JsonParser.parseString("{\"type\":\"NOPE\"}").getAsJsonObject();

        assertThrows(ProtocolException.class, () -> FrameCodec.readDirective(json));
    }

    @Test
    void refusesAQrModuleSizeThePrinterCannotSet() {
        assertThrows(ProtocolException.class, () -> codec.read(
                dispatch("", "{\"type\":\"QR\",\"content\":\"x\",\"size\":17}")));
        assertThrows(ProtocolException.class, () -> codec.read(
                dispatch("", "{\"type\":\"QR\",\"content\":\"x\",\"size\":0}")));
    }

    @Test
    void refusesASymbolWithNoContentToEncode() {
        // An empty symbol is not a smaller symbol; there is nothing for the encoder to lay out,
        // so it is refused here rather than handed to the library to fail on.
        assertThrows(ProtocolException.class, () -> codec.read(
                dispatch("", "{\"type\":\"QR\",\"content\":\"\",\"size\":6}")));
        assertThrows(ProtocolException.class, () -> codec.read(
                dispatch("", "{\"type\":\"PDF417\",\"content\":\"\",\"errorLevel\":1}")));
        assertThrows(ProtocolException.class, () -> codec.read(
                dispatch("", "{\"type\":\"BARCODE\",\"system\":\"CODE128\",\"content\":\"\"}")));
    }

    @Test
    void refusesASymbologyThisAgentDoesNotHave() {
        assertThrows(ProtocolException.class, () -> codec.read(
                dispatch("", "{\"type\":\"BARCODE\",\"system\":\"QR\",\"content\":\"x\"}")));
    }

    @Test
    void refusesAPdf417ErrorLevelOutsideTheEscPosRange() {
        assertThrows(ProtocolException.class, () -> codec.read(
                dispatch("", "{\"type\":\"PDF417\",\"content\":\"x\",\"errorLevel\":9}")));
    }

    @Test
    void refusesADrawerPinTheHardwareDoesNotHave() {
        // The connector has two pins, not a range: 3 is not a smaller 5.
        assertThrows(ProtocolException.class, () -> codec.read(
                dispatch("", "{\"type\":\"DRAWER\",\"pin\":3}")));
    }

    @Test
    void refusesADrawerPulseWithNoPin() {
        assertThrows(ProtocolException.class, () -> codec.read(dispatch("", "{\"type\":\"DRAWER\"}")));
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
        // RULE in particular: the server expands a horizontal rule to characters because only it
        // knows the paper width, so one arriving here means the two sides disagree about that.
        assertThrows(ProtocolException.class, () -> codec.read(dispatch("", "{\"type\":\"RULE\"}")));
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
