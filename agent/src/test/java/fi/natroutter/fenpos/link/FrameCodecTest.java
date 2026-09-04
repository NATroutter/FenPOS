package fi.natroutter.fenpos.link;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import fi.natroutter.fenpos.AgentSettings;
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
import fi.natroutter.fenpos.print.JobSettings;
import org.junit.jupiter.api.Test;

import java.time.Duration;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
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
        var frame = codec.read("{\"type\":\"config.sync\",\"devices\":[],\"assets\":[]}");

        assertEquals(0, assertInstanceOf(ConfigSync.class, frame).devices().size());
    }

    @Test
    void readsADeviceSnapshot() throws Exception {
        var frame = codec.read("""
                {"type":"config.sync","devices":[{"name":"kitchen","port":"COM3","baudRate":9600,
                 "dataBits":8,"stopBits":1,"parity":"NONE","flowControl":"NONE","writeTimeoutMs":5000,
                 "autoConnect":true,"autoReconnect":true,"reconnectDelaySeconds":5,"columns":42,
                 "codepage":"CP858","paused":false,"maxQueueDepth":100}],"assets":[]}""");

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
                "{\"type\":\"PDF417\",\"content\":\"ORDER-42\",\"errorLevel\":0,\"columns\":5}").getAsJsonObject();

        WireDirective.Pdf417 pdf417 = assertInstanceOf(
                WireDirective.Pdf417.class, FrameCodec.readDirective(json));
        assertEquals(0, pdf417.errorLevel());
        assertEquals(5, pdf417.columns());
    }

    /**
     * A symbol whose layout was never stated is a symbol the server could not have charged a line
     * budget for, so the column count is required rather than defaulted. Zero is refused for the
     * same reason and not merely because it is out of range: zero is exactly the value function 65
     * reads as "printer decides".
     */
    @Test
    void refusesAPdf417WithNoColumnCount() {
        assertThrows(ProtocolException.class, () -> codec.read(
                dispatch("", "{\"type\":\"PDF417\",\"content\":\"x\",\"errorLevel\":1}")));
        assertThrows(ProtocolException.class, () -> codec.read(
                dispatch("", "{\"type\":\"PDF417\",\"content\":\"x\",\"errorLevel\":1,\"columns\":0}")));
        assertThrows(ProtocolException.class, () -> codec.read(
                dispatch("", "{\"type\":\"PDF417\",\"content\":\"x\",\"errorLevel\":1,\"columns\":31}")));
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

    // -----------------------------------------------------------------
    // Reading: images
    //
    // A 16x2 raster is four bytes — 0x80 0x01 0x00 0xFF — which is "gAEA/w==" in base64. Small
    // enough to read by eye, asymmetric enough that a reordering would show.
    // -----------------------------------------------------------------

    private static final String DOTS = "gAEA/w==";

    @Test
    void decodesAnImageNamingASyncedRaster() throws Exception {
        JsonObject json = JsonParser.parseString(
                "{\"type\":\"IMAGE\",\"source\":{\"kind\":\"REF\",\"ref\":\"logo\",\"widthDots\":384}}")
                .getAsJsonObject();

        WireDirective.StoredImage stored =
                assertInstanceOf(WireDirective.StoredImage.class, FrameCodec.readDirective(json));

        assertEquals("logo", stored.name());
        assertEquals(384, stored.widthDots());
    }

    @Test
    void decodesAnImageCarryingItsOwnDots() throws Exception {
        JsonObject json = JsonParser.parseString(
                "{\"type\":\"IMAGE\",\"source\":{\"kind\":\"INLINE\",\"widthDots\":16,\"heightDots\":2,"
                        + "\"data\":\"" + DOTS + "\"}}").getAsJsonObject();

        WireDirective.InlineImage inline =
                assertInstanceOf(WireDirective.InlineImage.class, FrameCodec.readDirective(json));

        assertEquals(16, inline.widthDots());
        assertArrayEquals(new byte[]{(byte) 0x80, 0x01, 0x00, (byte) 0xFF}, inline.packed());
    }

    /**
     * The check this codec exists for. {@code GS v 0} declares how many bytes follow and the
     * printer reads exactly that many, so a raster short of its declared rectangle does not print
     * a short image — the printer swallows the rest of the job looking for dots, and comes back
     * only after a power cycle.
     */
    @Test
    void refusesInlineDotsThatDoNotFillTheStatedRectangle() {
        JsonObject json = JsonParser.parseString(
                "{\"type\":\"IMAGE\",\"source\":{\"kind\":\"INLINE\",\"widthDots\":16,\"heightDots\":3,"
                        + "\"data\":\"" + DOTS + "\"}}").getAsJsonObject();

        ProtocolException thrown = assertThrows(ProtocolException.class, () -> FrameCodec.readDirective(json));
        assertTrue(thrown.getMessage().contains("16x3"), thrown.getMessage());
    }

    /** A row is padded to a whole byte, so nine dots across is two bytes and not one and an eighth. */
    @Test
    void countsARowsPaddingWhenCheckingTheRectangle() throws Exception {
        String twoRowsOfNine = "gACAAA=="; // 0x80 0x00 0x80 0x00

        JsonObject json = JsonParser.parseString(
                "{\"type\":\"IMAGE\",\"source\":{\"kind\":\"INLINE\",\"widthDots\":9,\"heightDots\":2,"
                        + "\"data\":\"" + twoRowsOfNine + "\"}}").getAsJsonObject();

        assertEquals(9, assertInstanceOf(
                WireDirective.InlineImage.class, FrameCodec.readDirective(json)).widthDots());
    }

    @Test
    void refusesDotsThatAreNotBase64() {
        JsonObject json = JsonParser.parseString(
                "{\"type\":\"IMAGE\",\"source\":{\"kind\":\"INLINE\",\"widthDots\":16,\"heightDots\":2,"
                        + "\"data\":\"not base64 at all\"}}").getAsJsonObject();

        assertThrows(ProtocolException.class, () -> FrameCodec.readDirective(json));
    }

    /**
     * A name that fails to resolve is quoted back in the job's failure message, and the server caps
     * that message at 512 characters — so an unbounded name would make the update reporting the
     * failure a frame the server rejects, losing the report along with the job.
     */
    @Test
    void refusesAnImageNameLongerThanANameCanBe() {
        JsonObject json = JsonParser.parseString(
                "{\"type\":\"IMAGE\",\"source\":{\"kind\":\"REF\",\"ref\":\"" + "x".repeat(65)
                        + "\",\"widthDots\":384}}").getAsJsonObject();

        assertThrows(ProtocolException.class, () -> FrameCodec.readDirective(json));
    }

    @Test
    void refusesAnImageSourceOfNeitherKind() {
        JsonObject json = JsonParser.parseString(
                "{\"type\":\"IMAGE\",\"source\":{\"kind\":\"SOMEDAY\",\"ref\":\"logo\"}}").getAsJsonObject();

        assertThrows(ProtocolException.class, () -> FrameCodec.readDirective(json));
    }

    @Test
    void readsTheRastersASnapshotCarries() throws Exception {
        var frame = codec.read("""
                {"type":"config.sync","devices":[],"assets":[
                 {"name":"logo","widthDots":16,"heightDots":2,"data":"%s"}]}""".formatted(DOTS));

        var raster = assertInstanceOf(ConfigSync.class, frame).assets().getFirst();
        assertEquals("logo", raster.name());
        assertEquals(2, raster.heightDots());
        assertArrayEquals(new byte[]{(byte) 0x80, 0x01, 0x00, (byte) 0xFF}, raster.packed());
    }

    @Test
    void refusesASyncedRasterThatDoesNotFillItsRectangle() {
        assertThrows(ProtocolException.class, () -> codec.read("""
                {"type":"config.sync","devices":[],"assets":[
                 {"name":"logo","widthDots":16,"heightDots":9,"data":"%s"}]}""".formatted(DOTS)));
    }

    /**
     * A snapshot with no {@code assets} field is a server this agent cannot serve: it would mean
     * every stored image silently missing from every receipt. Refused rather than defaulted to
     * none, which is the same stance every other field on this frame takes.
     */
    @Test
    void refusesASnapshotThatCarriesNoAssetsFieldAtAll() {
        assertThrows(ProtocolException.class,
                () -> codec.read("{\"type\":\"config.sync\",\"devices\":[]}"));
    }

    // -----------------------------------------------------------------
    // Reading: job settings
    // -----------------------------------------------------------------

    @Test
    void readsJobSettingsFromConfigSync() throws Exception {
        String json = """
                {"type":"config.sync","devices":[],"assets":[],
                 "jobs":{"retentionMinutes":1440,"maxRecords":10000,"shutdownGraceSeconds":30}}
                """;

        ConfigSync sync = assertInstanceOf(ConfigSync.class, codec.read(json));

        assertEquals(Duration.ofMinutes(1440), sync.jobs().retention());
        assertEquals(10000, sync.jobs().maxRecords());
        assertEquals(Duration.ofSeconds(30), sync.jobs().shutdownGrace());
    }

    @Test
    void fallsBackToDefaultsWhenConfigSyncOmitsJobSettings() throws Exception {
        String json = """
                {"type":"config.sync","devices":[],"assets":[]}
                """;

        ConfigSync sync = assertInstanceOf(ConfigSync.class, codec.read(json));

        assertEquals(JobSettings.DEFAULTS, sync.jobs());
    }

    @Test
    void refusesJobSettingsOutsideTheirBounds() {
        String json = """
                {"type":"config.sync","devices":[],"assets":[],
                 "jobs":{"retentionMinutes":0,"maxRecords":10000,"shutdownGraceSeconds":30}}
                """;

        assertThrows(ProtocolException.class, () -> codec.read(json));
    }

    @Test
    void refusesAConfigSyncWhoseJobSettingsAreNotAnObject() {
        // A ClassCastException here would escape LinkClient's ProtocolException catch and
        // close the socket, taking every printer behind this agent offline for one bad field.
        for (String value : new String[] {"[]", "\"x\"", "7", "true"}) {
            assertThrows(ProtocolException.class, () -> codec.read(
                    "{\"type\":\"config.sync\",\"devices\":[],\"assets\":[],\"jobs\":" + value + "}"),
                    "jobs:" + value);
        }
    }

    @Test
    void fallsBackToDefaultsWhenConfigSyncJobSettingsAreExplicitlyNull() throws Exception {
        // Explicit null means the server chose not to send job settings, not that it sent a
        // wrong-typed value; refusing it would drop the link over a field the server omitted.
        String json = """
                {"type":"config.sync","devices":[],"assets":[],"jobs":null}
                """;

        ConfigSync sync = assertInstanceOf(ConfigSync.class, codec.read(json));

        assertEquals(JobSettings.DEFAULTS, sync.jobs());
    }

    // -----------------------------------------------------------------
    // Reading: agent settings
    // -----------------------------------------------------------------

    @Test
    void readsAgentSettingsFromConfigSync() throws Exception {
        String json = """
                {"type":"config.sync","devices":[],"assets":[],
                 "agent":{"statusIntervalSeconds":45,"evictionIntervalSeconds":120,"queuePollMs":250}}
                """;

        ConfigSync sync = assertInstanceOf(ConfigSync.class, codec.read(json));

        assertEquals(Duration.ofSeconds(45), sync.agent().statusInterval());
        assertEquals(Duration.ofSeconds(120), sync.agent().evictionInterval());
        assertEquals(Duration.ofMillis(250), sync.agent().queuePoll());
    }

    @Test
    void fallsBackToDefaultsWhenConfigSyncOmitsAgentSettings() throws Exception {
        String json = """
                {"type":"config.sync","devices":[],"assets":[]}
                """;

        ConfigSync sync = assertInstanceOf(ConfigSync.class, codec.read(json));

        assertEquals(AgentSettings.DEFAULTS, sync.agent());
    }

    @Test
    void refusesAgentSettingsOutsideTheirBounds() {
        String json = """
                {"type":"config.sync","devices":[],"assets":[],
                 "agent":{"statusIntervalSeconds":4,"evictionIntervalSeconds":120,"queuePollMs":250}}
                """;

        assertThrows(ProtocolException.class, () -> codec.read(json));
    }

    @Test
    void refusesAConfigSyncWhoseAgentSettingsAreNotAnObject() {
        for (String value : new String[] {"[]", "\"x\"", "7", "true"}) {
            assertThrows(ProtocolException.class, () -> codec.read(
                    "{\"type\":\"config.sync\",\"devices\":[],\"assets\":[],\"agent\":" + value + "}"),
                    "agent:" + value);
        }
    }

    @Test
    void fallsBackToDefaultsWhenConfigSyncAgentSettingsAreExplicitlyNull() throws Exception {
        // Explicit null means the server chose not to send agent settings, not that it sent a
        // wrong-typed value; refusing it would drop the link over a field the server omitted.
        String json = """
                {"type":"config.sync","devices":[],"assets":[],"agent":null}
                """;

        ConfigSync sync = assertInstanceOf(ConfigSync.class, codec.read(json));

        assertEquals(AgentSettings.DEFAULTS, sync.agent());
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
                dispatch("", "{\"type\":\"PDF417\",\"content\":\"\",\"errorLevel\":1,\"columns\":5}")));
        assertThrows(ProtocolException.class, () -> codec.read(
                dispatch("", "{\"type\":\"BARCODE\",\"system\":\"CODE128\",\"content\":\"\"}")));
    }

    /**
     * The agent's library builds the symbol's store-data command with a length counted in
     * characters while writing UTF-8 bytes, so one character above U+007F makes the printer read
     * a truncated payload as a valid symbol. It scans, and it scans wrongly, which is worse than
     * a job that fails. The server refuses the same content at compile time; this is the backstop.
     */
    @Test
    void refusesNonAsciiSymbolContentItCannotSizeCorrectly() {
        assertThrows(ProtocolException.class, () -> codec.read(
                dispatch("", "{\"type\":\"QR\",\"content\":\"kahvi ä\",\"size\":6}")));
        assertThrows(ProtocolException.class, () -> codec.read(
                dispatch("", "{\"type\":\"PDF417\",\"content\":\"kahvi ä\",\"errorLevel\":1,\"columns\":5}")));
    }

    @Test
    void acceptsTheAsciiRangeInFull() {
        // The bound is ASCII, not "letters and digits": a URL's punctuation must survive it.
        assertDoesNotThrow(() -> codec.read(
                dispatch("", "{\"type\":\"QR\",\"content\":\"https://x.test/a?b=1&c=~\",\"size\":6}")));
    }

    @Test
    void refusesASymbologyThisAgentDoesNotHave() {
        assertThrows(ProtocolException.class, () -> codec.read(
                dispatch("", "{\"type\":\"BARCODE\",\"system\":\"QR\",\"content\":\"x\"}")));
    }

    @Test
    void refusesAPdf417ErrorLevelOutsideTheEscPosRange() {
        assertThrows(ProtocolException.class, () -> codec.read(
                dispatch("", "{\"type\":\"PDF417\",\"content\":\"x\",\"errorLevel\":9,\"columns\":5}")));
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
                 "codepage":"CP999","paused":false,"maxQueueDepth":100}],"assets":[]}"""));
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
    void refusesSpanTextCarryingBytesThePrinterWouldReadAsACommand() {
        // The markup parser on both sides refuses control characters, so no legitimate job
        // carries one. Without this check the link path bypasses that rule entirely: the
        // renderer writes span text to the port verbatim, so an ESC in a span is a command,
        // outside the size cap and the warning line that wrap a raw write.
        for (String escaped : new String[] {"\\u001b", "\\u001d", "\\u0000", "\\u0009",
                "\\u007f", "\\u009b"}) {
            String span = span("").replace("Kahvi", "ab" + escaped + "cd");
            assertThrows(ProtocolException.class, () -> codec.read(dispatch(span, "")), escaped);
        }
    }

    @Test
    void acceptsTheCharactersAReceiptActuallyContains() {
        String span = span("").replace("Kahvi", "Kahvi 2,50 EUR - Aamiainen");
        assertDoesNotThrow(() -> codec.read(dispatch(span, "")));
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
    void readsTheJobIdATestPageCommandCarries() {
        Frames.ServerFrame frame = assertDoesNotThrow(() -> codec.read(
                "{\"type\":\"device.test\",\"requestId\":\"r\",\"device\":\"kitchen\",\"jobId\":\"job-7\"}"));

        assertEquals("job-7", assertInstanceOf(Frames.DeviceCommand.class, frame).jobId());
    }

    @Test
    void readsACommandWithoutAJobIdAsCarryingNone() {
        Frames.ServerFrame frame = assertDoesNotThrow(() -> codec.read(
                "{\"type\":\"device.test\",\"requestId\":\"r\",\"device\":\"kitchen\"}"));

        assertEquals(null, assertInstanceOf(Frames.DeviceCommand.class, frame).jobId());
    }

    @Test
    void refusesAJobIdThatIsNotAString() {
        assertThrows(ProtocolException.class, () -> codec.read(
                "{\"type\":\"device.test\",\"requestId\":\"r\",\"device\":\"kitchen\",\"jobId\":7}"));
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

    // -----------------------------------------------------------------
    // Identifier and name bounds
    // -----------------------------------------------------------------

    /** The device snapshot used below, with one field swapped by each test. */
    private static String deviceSnapshot(String name, String port) {
        return """
            {"type":"config.sync","devices":[{"name":%s,"port":%s,"baudRate":9600,"dataBits":8,\
            "stopBits":1,"parity":"NONE","flowControl":"NONE","writeTimeoutMs":1000,\
            "autoConnect":false,"autoReconnect":false,"reconnectDelaySeconds":5,"columns":42,\
            "codepage":"CP858","paused":false,"maxQueueDepth":100}],"assets":[]}"""
                .formatted(name, port);
    }

    @Test
    void refusesADeviceNameThatIsNotASlug() {
        // Names reach log lines, console output and the status report the server validates.
        // protocol.ts restricts them so no consumer has to escape them; this is that rule.
        for (String name : new String[] {
                "\"Kitchen\"", "\"kitchen printer\"", "\"-kitchen\"", "\"_kitchen\"",
                "\"kitchen\\n[2J\"", "\"kitchen{RED}\"", "\"\"", "\"" + "k".repeat(65) + "\""}) {
            assertThrows(ProtocolException.class,
                    () -> codec.read(deviceSnapshot(name, "\"/dev/ttyUSB0\"")), name);
        }
    }

    @Test
    void acceptsTheSlugShapesTheServerCanSend() throws Exception {
        for (String name : new String[] {"\"kitchen\"", "\"bar-2\"", "\"till_3\"", "\"a\"",
                "\"" + "k".repeat(64) + "\""}) {
            assertDoesNotThrow(() -> codec.read(deviceSnapshot(name, "\"/dev/ttyUSB0\"")), name);
        }
    }

    @Test
    void refusesAPortOutsideItsLengthBound() {
        assertThrows(ProtocolException.class,
                () -> codec.read(deviceSnapshot("\"kitchen\"", "\"\"")));
        assertThrows(ProtocolException.class,
                () -> codec.read(deviceSnapshot("\"kitchen\"", "\"" + "x".repeat(257) + "\"")));
    }

    @Test
    void acceptsAPortAtItsMaximumLength() {
        assertDoesNotThrow(() ->
                codec.read(deviceSnapshot("\"kitchen\"", "\"" + "x".repeat(256) + "\"")));
    }

    @Test
    void refusesAnIdentifierOutsideItsLengthBound() {
        assertThrows(ProtocolException.class, () -> codec.read(
                "{\"type\":\"job.cancel\",\"jobId\":\"" + "j".repeat(65) + "\"}"));
        assertThrows(ProtocolException.class, () -> codec.read(
                "{\"type\":\"job.cancel\",\"jobId\":\"\"}"));
        assertThrows(ProtocolException.class, () -> codec.read(
                "{\"type\":\"ports.scan\",\"requestId\":\"\"}"));
        assertThrows(ProtocolException.class, () -> codec.read(
                "{\"type\":\"device.pause\",\"requestId\":\"r\",\"device\":\"\"}"));
    }

    @Test
    void refusesAWelcomeWhoseIdentifiersAreOutsideTheirBounds() {
        assertThrows(ProtocolException.class, () -> codec.read("""
                {"type":"welcome","protocolVersion":3,"agentId":"%s","agentName":"n",\
                "serverTime":"2026-09-04T10:00:00Z"}""".formatted("a".repeat(65))));
        assertThrows(ProtocolException.class, () -> codec.read("""
                {"type":"welcome","protocolVersion":3,"agentId":"a","agentName":"%s",\
                "serverTime":"2026-09-04T10:00:00Z"}""".formatted("n".repeat(129))));
    }

    @Test
    void acceptsAWelcomeAgentNameAtItsMaximumLength() {
        assertDoesNotThrow(() -> codec.read("""
                {"type":"welcome","protocolVersion":3,"agentId":"a","agentName":"%s",\
                "serverTime":"2026-09-04T10:00:00Z"}""".formatted("n".repeat(128))));
    }
}
