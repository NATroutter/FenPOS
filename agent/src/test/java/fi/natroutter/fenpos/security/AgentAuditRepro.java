package fi.natroutter.fenpos.security;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import fi.natroutter.fenpos.device.Device;
import fi.natroutter.fenpos.enums.Align;
import fi.natroutter.fenpos.enums.BarcodeSystem;
import fi.natroutter.fenpos.enums.Codepage;
import fi.natroutter.fenpos.enums.FlowControl;
import fi.natroutter.fenpos.enums.Font;
import fi.natroutter.fenpos.enums.Linefeed;
import fi.natroutter.fenpos.enums.Parity;
import fi.natroutter.fenpos.device.DeviceRegistry;
import fi.natroutter.fenpos.link.FrameCodec;
import fi.natroutter.fenpos.link.Frames;
import fi.natroutter.fenpos.link.IrRenderer;
import fi.natroutter.fenpos.print.CompiledJob;
import fi.natroutter.fenpos.print.JobSettings;
import fi.natroutter.fenpos.print.JobStore;
import fi.natroutter.fenpos.print.PrintJob;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.lang.reflect.Method;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.List;
import java.util.Optional;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Reproductions for the findings in {@code docs/security/reports/2026-09-03-agent-audit.md}.
 *
 * <p>Every test here asserts the behaviour as it is today, not as it should be. They are evidence,
 * not regression guards: a test that goes red after a fix is the fix being confirmed.
 */
class AgentAuditRepro {

    private static final FrameCodec CODEC = new FrameCodec();

    // ------------------------------------------------------------------
    // A-01  config.sync with a wrong-typed `jobs`/`agent` escapes as an
    //       unchecked ClassCastException instead of a ProtocolException.
    // ------------------------------------------------------------------

    @Test
    @DisplayName("A-01 config.sync with a non-object 'jobs' throws ClassCastException, not ProtocolException")
    void configSyncWrongTypedJobsThrowsUnchecked() {
        String frame = "{\"type\":\"config.sync\",\"devices\":[],\"assets\":[],\"jobs\":[]}";
        ClassCastException thrown = assertThrows(ClassCastException.class, () -> CODEC.read(frame));
        System.out.println("A-01 jobs=[]    -> " + thrown);

        String agentFrame = "{\"type\":\"config.sync\",\"devices\":[],\"assets\":[],\"agent\":\"x\"}";
        ClassCastException agentThrown = assertThrows(ClassCastException.class, () -> CODEC.read(agentFrame));
        System.out.println("A-01 agent=\"x\"  -> " + agentThrown);

        String nullFrame = "{\"type\":\"config.sync\",\"devices\":[],\"assets\":[],\"jobs\":null}";
        ClassCastException nullThrown = assertThrows(ClassCastException.class, () -> CODEC.read(nullFrame));
        System.out.println("A-01 jobs=null  -> " + nullThrown);
    }

    // ------------------------------------------------------------------
    // A-02  Identifier and name bounds from protocol.ts are not enforced.
    // ------------------------------------------------------------------

    @Test
    @DisplayName("A-02 device name and port ignore protocol.ts bounds (name 1..64 + slug regex, port 1..256)")
    void deviceNameAndPortAreUnbounded() throws Exception {
        String hostileName = "A".repeat(4096) + "\n[2J";
        String hostilePort = "/dev/" + "x".repeat(9000);

        JsonObject device = new JsonObject();
        device.addProperty("name", hostileName);
        device.addProperty("port", hostilePort);
        device.addProperty("baudRate", 9600);
        device.addProperty("dataBits", 8);
        device.addProperty("stopBits", 1);
        device.addProperty("parity", "NONE");
        device.addProperty("flowControl", "NONE");
        device.addProperty("writeTimeoutMs", 1000);
        device.addProperty("autoConnect", false);
        device.addProperty("autoReconnect", false);
        device.addProperty("reconnectDelaySeconds", 5);
        device.addProperty("columns", 42);
        device.addProperty("codepage", "CP858");
        device.addProperty("paused", false);
        device.addProperty("maxQueueDepth", 100);

        JsonObject root = new JsonObject();
        root.addProperty("type", "config.sync");
        root.add("devices", JsonParser.parseString("[" + device + "]"));
        root.add("assets", JsonParser.parseString("[]"));

        Frames.ConfigSync sync = (Frames.ConfigSync) CODEC.read(root.toString());
        Frames.DeviceConfig accepted = sync.devices().getFirst();

        assertEquals(hostileName.length(), accepted.name().length());
        assertEquals(hostilePort.length(), accepted.port().length());
        assertTrue(accepted.name().contains("\n"), "a newline survived into the device name");
        assertTrue(accepted.name().contains(""), "an ANSI escape survived into the device name");
        System.out.println("A-02 accepted device name of " + accepted.name().length()
                + " chars containing LF and ESC; port of " + accepted.port().length() + " chars");
    }

    @Test
    @DisplayName("A-02 jobId, requestId and empty device names ignore protocol.ts bounds")
    void identifiersAreUnbounded() throws Exception {
        String hugeId = "j".repeat(70_000);
        Frames.JobCancel cancel = (Frames.JobCancel)
                CODEC.read("{\"type\":\"job.cancel\",\"jobId\":\"" + hugeId + "\"}");
        assertEquals(70_000, cancel.jobId().length());

        Frames.PortsScan scan = (Frames.PortsScan)
                CODEC.read("{\"type\":\"ports.scan\",\"requestId\":\"\"}");
        assertEquals("", scan.requestId(), "an empty requestId is accepted; protocol.ts requires min 1");

        Frames.DeviceCommand command = (Frames.DeviceCommand) CODEC.read(
                "{\"type\":\"device.connect\",\"requestId\":\"" + "r".repeat(5000)
                        + "\",\"device\":\"\"}");
        assertEquals(5000, command.requestId().length());
        assertEquals("", command.device());

        System.out.println("A-02 jobId 70000 chars, requestId 5000 chars, empty requestId and device all accepted");
    }

    // ------------------------------------------------------------------
    // A-03  Symbol payloads are unbounded, and escpos-coffee encodes their
    //       length in one byte (GS k function B) or two (GS ( k).
    // ------------------------------------------------------------------

    @Test
    @DisplayName("A-03 a 300-character CODE128 barcode overflows the GS k length byte")
    void code128LengthByteOverflows() throws Exception {
        String content = "A".repeat(300);
        byte[] payload = renderDirective(barcodeDirective(BarcodeSystem.CODE128, content));

        // GS k 73  <len>  {B AAAA...
        int marker = indexOf(payload, new byte[]{0x1D, 'k', 73});
        assertTrue(marker >= 0, "the GS k function-B command was emitted");
        int declared = payload[marker + 3] & 0xFF;
        int actual = content.length() + 2; // the renderer prepends the "{B" code-set selector

        assertNotEquals(actual, declared,
                "the declared length should differ from the real one, which is the bug");
        assertEquals(actual & 0xFF, declared);
        System.out.println("A-03 CODE128: " + actual + " data bytes follow, the command declares "
                + declared + "; " + (actual - declared)
                + " trailing bytes are read by the printer as commands");
    }

    @Test
    @DisplayName("A-03 a 65533-character QR payload wraps GS ( k pL/pH to zero")
    void qrStoreDataLengthWraps() throws Exception {
        String content = "A".repeat(65_533);
        byte[] payload = renderDirective(new Frames.WireDirective.Qr(content, 3));

        // The store-data call is GS ( k pL pH 49 80 48, i.e. function 080.
        int marker = indexOf(payload, new byte[]{0x1D, '(', 'k'}, 0, true, (byte) 80);
        assertTrue(marker >= 0, "the GS ( k function-080 store-data command was emitted");
        int pL = payload[marker + 3] & 0xFF;
        int pH = payload[marker + 4] & 0xFF;
        int declared = pL + (pH << 8);

        assertEquals(0, declared, "65533 + 3 wraps to 0 in the two length bytes");
        System.out.println("A-03 QR: " + content.length()
                + " payload bytes follow, the command declares " + declared);
    }

    @Test
    @DisplayName("A-03 FrameCodec puts no length bound on QR, BARCODE or PDF417 content")
    void symbolContentIsUnboundedInTheCodec() throws Exception {
        String content = "A".repeat(200_000);
        JsonObject qr = new JsonObject();
        qr.addProperty("type", "QR");
        qr.addProperty("content", content);
        qr.addProperty("size", 3);

        Method readDirective = FrameCodec.class.getDeclaredMethod("readDirective", JsonObject.class);
        readDirective.setAccessible(true);
        Frames.WireDirective.Qr parsed = (Frames.WireDirective.Qr) readDirective.invoke(null, qr);

        assertEquals(200_000, parsed.content().length());
        System.out.println("A-03 FrameCodec.readDirective accepted a QR payload of "
                + parsed.content().length() + " characters");
    }

    // ------------------------------------------------------------------
    // A-04  Span text from the link reaches the printer unescaped.
    // ------------------------------------------------------------------

    @Test
    @DisplayName("A-04 span text carrying ESC/GS reaches the ESC/POS payload byte for byte")
    void spanTextCarriesControlBytesThrough() throws Exception {
        // ESC @ (reset), GS V 0 (full cut), ESC p 0 25 250 (drawer kick)
        String injected = "@V p ú";
        // Rebuilt from code points so the bytes are unambiguous in source:
        //   ESC @ | GS V NUL | ESC p NUL EM U+00B7   (U+00B7 is 0xFA in CP858, the device's table)
        injected = new String(new char[]{
                0x1B, '@', 0x1D, 'V', 0x00, 0x1B, 'p', 0x00, 0x19, 0x00B7});
        Frames.WireSpan span = new Frames.WireSpan(injected, false, 0, false, 1, 1, Font.A);
        Frames.CompiledJob job = new Frames.CompiledJob(
                "job", "printer", Linefeed.LF,
                List.of(new Frames.WireLine(Align.LEFT, List.of(span), List.of())));

        CompiledJob rendered = IrRenderer.render(job, device(), new DeviceRegistry());
        byte[] out = rendered.payload();

        assertTrue(indexOf(out, new byte[]{0x1B, 0x40, 0x1D, 'V', 0x00}) >= 0,
                "the injected reset and cut sequence appears verbatim in the payload");
        assertTrue(indexOf(out, new byte[]{0x1B, 0x70, 0x00, 0x19, (byte) 0xFA}) >= 0,
                "the injected drawer-kick sequence appears verbatim in the payload");
        System.out.println("A-04 span text injected " + injected.length()
                + " ESC/POS command bytes into a rendered job; CharsetValidator never runs on this path");
    }

    // ------------------------------------------------------------------
    // A-05  Dispatch deduplication expires with the job record.
    // ------------------------------------------------------------------

    @Test
    @DisplayName("A-05 the same jobId is adopted a second time once its record is evicted")
    void dedupExpiresWithRetention() {
        MutableClock clock = new MutableClock(Instant.parse("2026-09-03T10:00:00Z"));
        JobSettings settings = new JobSettings(Duration.ofMinutes(1), 100, Duration.ofSeconds(10));
        JobStore store = new JobStore(settings, clock, logger());

        CompiledJob compiled = new CompiledJob(new byte[]{0x41}, 1);

        Optional<PrintJob> first = store.adopt("srv-job-1", "printer", compiled);
        assertTrue(first.isPresent());
        first.get().complete();

        assertTrue(store.adopt("srv-job-1", "printer", compiled).isEmpty(),
                "while the record is held, a repeat dispatch is refused");

        clock.advance(Duration.ofMinutes(2));
        store.evictExpired();

        Optional<PrintJob> second = store.adopt("srv-job-1", "printer", compiled);
        assertTrue(second.isPresent(),
                "after eviction the same server job id is accepted again and would print again");
        System.out.println("A-05 job 'srv-job-1' printed, expired after retention, and was accepted"
                + " for printing a second time under the same id");
    }

    @Test
    @DisplayName("A-05 the record cap also drops finished ids, reopening the dedup window")
    void dedupExpiresWithTheRecordCap() {
        MutableClock clock = new MutableClock(Instant.parse("2026-09-03T10:00:00Z"));
        // 100 is the smallest maxRecords the protocol allows a server to push.
        JobStore store = new JobStore(
                new JobSettings(Duration.ofDays(28), 100, Duration.ofSeconds(10)), clock, logger());
        CompiledJob compiled = new CompiledJob(new byte[]{0x41}, 1);

        store.adopt("victim", "printer", compiled).orElseThrow().complete();
        for (int i = 0; i < 200; i++) {
            clock.advance(Duration.ofSeconds(1));
            store.adopt("filler-" + i, "printer", compiled).orElseThrow().complete();
        }

        assertTrue(store.find("victim").isEmpty(), "the oldest finished record was dropped by the cap");
        assertTrue(store.adopt("victim", "printer", compiled).isPresent(),
                "and the id is now printable again");
        System.out.println("A-05 200 dispatches at maxRecords=100 evicted the earlier id and reopened it");
    }

    // ------------------------------------------------------------------
    // A-06  The loopback exception to the https rule matches on a prefix.
    // ------------------------------------------------------------------

    @Test
    @DisplayName("A-06 isLoopback accepts any DNS name beginning '127.'")
    void loopbackPrefixMatchesRoutableHostnames() throws Exception {
        Class<?> client = Class.forName("fi.natroutter.fenpos.pair.PairingClient");
        Method isLoopback = client.getDeclaredMethod("isLoopback", String.class);
        isLoopback.setAccessible(true);

        String[] shouldBeRefused = {
                "127.0.0.1.evil.example", "127.attacker.example", "127.example.com",
        };
        for (String host : shouldBeRefused) {
            assertTrue((boolean) isLoopback.invoke(null, host),
                    host + " is treated as loopback today");
            System.out.println("A-06 isLoopback(\"" + host + "\") = true  -> plain http accepted");
        }

        // For contrast, the ones it does refuse.
        for (String host : new String[]{"localhost.evil.example", "0177.0.0.1", "2130706433",
                "0.0.0.0", "::ffff:127.0.0.1", "localhost."}) {
            assertFalse((boolean) isLoopback.invoke(null, host), host + " is refused");
            System.out.println("A-06 isLoopback(\"" + host + "\") = false");
        }

        // And the ones it accepts on purpose.
        for (String host : new String[]{"localhost", "LOCALHOST", "127.0.0.1", "127.1", "[::1]", "::1"}) {
            assertTrue((boolean) isLoopback.invoke(null, host), host + " is accepted");
        }
    }

    // ------------------------------------------------------------------
    // A-07  requireInt saturates a double cast rather than refusing the value.
    // ------------------------------------------------------------------

    @Test
    @DisplayName("A-07 an out-of-int number saturates to Integer.MAX_VALUE before the bound check")
    void hugeNumbersSaturate() throws Exception {
        Method requireInt = FrameCodec.class.getDeclaredMethod("requireInt", JsonObject.class, String.class);
        requireInt.setAccessible(true);

        JsonObject json = JsonParser.parseString("{\"v\":1e18}").getAsJsonObject();
        int value = (int) requireInt.invoke(null, json, "v");
        assertEquals(Integer.MAX_VALUE, value);
        System.out.println("A-07 requireInt(1e18) = " + value + " (saturated, not refused)");

        // welcome.protocolVersion goes through requireInt with no bound at all.
        Frames.Welcome welcome = (Frames.Welcome) CODEC.read(
                "{\"type\":\"welcome\",\"protocolVersion\":1e18,\"agentId\":\"a\","
                        + "\"agentName\":\"n\",\"serverTime\":\"not-a-timestamp\"}");
        assertEquals(Integer.MAX_VALUE, welcome.protocolVersion());
        assertEquals("not-a-timestamp", welcome.serverTime());
        System.out.println("A-07 welcome accepted protocolVersion=" + welcome.protocolVersion()
                + " and serverTime=\"" + welcome.serverTime() + "\" (never parsed as a datetime)");
    }

    // ------------------------------------------------------------------
    // Controls that do hold, asserted so the report's claims are evidenced.
    // ------------------------------------------------------------------

    @Test
    @DisplayName("control: an unknown frame type is a ProtocolException, which the link logs and ignores")
    void unknownFrameTypeIsRefusedNotFatal() {
        assertThrows(fi.natroutter.fenpos.link.ProtocolException.class,
                () -> CODEC.read("{\"type\":\"totally.unknown\"}"));
        assertThrows(fi.natroutter.fenpos.link.ProtocolException.class,
                () -> CODEC.read("{\"nope\":1}"));
        assertThrows(fi.natroutter.fenpos.link.ProtocolException.class,
                () -> CODEC.read("[1,2,3]"));
        assertThrows(fi.natroutter.fenpos.link.ProtocolException.class,
                () -> CODEC.read("not json at all"));
    }

    @Test
    @DisplayName("control: a raster whose bits do not fill its rectangle is refused before it reaches a printer")
    void rasterRectangleIsChecked() {
        String tooShort = "{\"type\":\"config.sync\",\"devices\":[],\"assets\":["
                + "{\"name\":\"logo\",\"widthDots\":16,\"heightDots\":8,\"data\":\"AAAA\"}]}";
        assertThrows(fi.natroutter.fenpos.link.ProtocolException.class, () -> CODEC.read(tooShort));

        String notBase64 = "{\"type\":\"config.sync\",\"devices\":[],\"assets\":["
                + "{\"name\":\"logo\",\"widthDots\":8,\"heightDots\":1,\"data\":\"!!\"}]}";
        assertThrows(fi.natroutter.fenpos.link.ProtocolException.class, () -> CODEC.read(notBase64));
    }

    @Test
    @DisplayName("control: a frame over 256 KiB is refused by the codec")
    void oversizedFrameIsRefused() {
        String big = "{\"type\":\"job.cancel\",\"jobId\":\"" + "x".repeat(300_000) + "\"}";
        assertThrows(fi.natroutter.fenpos.link.ProtocolException.class, () -> CODEC.read(big));
    }

    @Test
    @DisplayName("control: deep JSON nesting does not overflow the stack inside the frame cap")
    void deepNestingIsSurvivable() {
        int depth = 60_000;
        String nested = "{\"type\":\"job.dispatch\",\"job\":" + "[".repeat(depth) + "]".repeat(depth) + "}";
        assertTrue(nested.getBytes(java.nio.charset.StandardCharsets.UTF_8).length < 256 * 1024);
        assertThrows(fi.natroutter.fenpos.link.ProtocolException.class, () -> CODEC.read(nested));
        System.out.println("control: " + depth + " levels of nesting parsed and refused without a StackOverflowError");
    }

    // ------------------------------------------------------------------
    // Helpers
    // ------------------------------------------------------------------

    private static Frames.WireDirective barcodeDirective(BarcodeSystem system, String content) {
        return new Frames.WireDirective.Barcode(system, content);
    }

    private static byte[] renderDirective(Frames.WireDirective directive) throws Exception {
        Frames.CompiledJob job = new Frames.CompiledJob(
                "job", "printer", Linefeed.LF,
                List.of(new Frames.WireLine(Align.LEFT, List.of(), List.of(directive))));
        return IrRenderer.render(job, device(), new DeviceRegistry()).payload();
    }

    private static Device device() {
        return Device.from(new Frames.DeviceConfig(
                "printer", "/dev/null", 9600, 8, 1, Parity.NONE, FlowControl.NONE,
                1000, false, false, 5, 42, Codepage.CP858, false, 100));
    }

    private static int indexOf(byte[] haystack, byte[] needle) {
        return indexOf(haystack, needle, 0, false, (byte) 0);
    }

    /**
     * Finds {@code needle}, optionally requiring a further byte at {@code needle.length + 3}
     * (the function selector of a {@code GS ( k} command, which sits after pL, pH and cn).
     */
    private static int indexOf(byte[] haystack, byte[] needle, int from, boolean withFunction, byte function) {
        outer:
        for (int index = from; index <= haystack.length - needle.length; index++) {
            for (int offset = 0; offset < needle.length; offset++) {
                if (haystack[index + offset] != needle[offset]) {
                    continue outer;
                }
            }
            if (withFunction) {
                int functionAt = index + needle.length + 3;
                if (functionAt >= haystack.length || haystack[functionAt] != function) {
                    continue;
                }
            }
            return index;
        }
        return -1;
    }

    private static fi.natroutter.foxlib.logger.FoxLogger logger() {
        return new fi.natroutter.foxlib.logger.FoxLogger.Builder()
                .setLoggerName("audit")
                .setPrintter(message -> {
                })
                .build();
    }

    /** A clock the retention tests move forward by hand. */
    private static final class MutableClock extends Clock {

        private Instant now;

        private MutableClock(Instant start) {
            this.now = start;
        }

        void advance(Duration amount) {
            now = now.plus(amount);
        }

        @Override
        public java.time.ZoneId getZone() {
            return ZoneOffset.UTC;
        }

        @Override
        public Clock withZone(java.time.ZoneId zone) {
            return this;
        }

        @Override
        public Instant instant() {
            return now;
        }
    }
}
