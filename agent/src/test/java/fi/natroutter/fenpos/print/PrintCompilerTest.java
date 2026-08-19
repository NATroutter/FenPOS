package fi.natroutter.fenpos.print;

import fi.natroutter.fenpos.device.Device;
import fi.natroutter.fenpos.device.LimitSettings;
import fi.natroutter.fenpos.device.PrintSettings;
import fi.natroutter.fenpos.device.SerialSettings;
import fi.natroutter.fenpos.enums.Codepage;
import fi.natroutter.fenpos.enums.FlowControl;
import fi.natroutter.fenpos.enums.Linefeed;
import fi.natroutter.fenpos.enums.Parity;
import fi.natroutter.fenpos.enums.UnsupportedPolicy;
import org.junit.jupiter.api.Test;

import java.time.Duration;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Behavioural tests for {@link PrintCompiler}, the stage that turns a request body into a
 * printable payload or an error a client can act on.
 */
class PrintCompilerTest {

    @Test
    void compilesAValidRequestIntoAPayload() throws Exception {
        CompiledJob job = compile("""
                {"data": ["Kahvi 2.50", "<bold>Yht</bold>"]}
                """);

        assertEquals(2, job.lines());
        assertTrue(job.bytes() > 0);
        assertNotNull(job.payload());
    }

    // -------------------------------------------------------------------------
    // Request shape
    // -------------------------------------------------------------------------

    @Test
    void rejectsMalformedJson() {
        assertEquals("invalid_json", error("{\"data\": [").apiCode());
    }

    @Test
    void rejectsBodyThatIsNotAnObject() {
        assertEquals("invalid_json", error("[1,2,3]").apiCode());
    }

    @Test
    void rejectsMissingData() {
        assertEquals("missing_field", error("{}").apiCode());
    }

    @Test
    void rejectsDataThatIsNotAnArray() {
        assertEquals("invalid_type", error("{\"data\": \"one line\"}").apiCode());
    }

    @Test
    void rejectsNonStringElementAndNamesItsLine() {
        PrintRequestException thrown = error("{\"data\": [\"ok\", 42]}");

        assertEquals("invalid_type", thrown.apiCode());
        assertEquals(2, thrown.line());
    }

    @Test
    void rejectsUnknownLinefeed() {
        assertEquals("invalid_linefeed",
                error("{\"data\": [\"x\"], \"linefeed\": \"CR\"}").apiCode());
    }

    // -------------------------------------------------------------------------
    // Limits
    // -------------------------------------------------------------------------

    @Test
    void rejectsTooManyElements() {
        String data = "\"x\",".repeat(6);
        assertEquals("too_many_lines",
                error("{\"data\": [" + data.substring(0, data.length() - 1) + "]}").apiCode());
    }

    @Test
    void rejectsAnElementLongerThanTheLimit() {
        PrintRequestException thrown = error("{\"data\": [\"ok\", \"" + "a".repeat(21) + "\"]}");

        assertEquals("line_too_long", thrown.apiCode());
        assertEquals(2, thrown.line());
    }

    @Test
    void rejectsTotalTextLargerThanTheLimit() {
        String line = "\"" + "a".repeat(20) + "\"";
        assertEquals("text_too_large",
                error("{\"data\": [" + (line + ",").repeat(2) + line + "]}").apiCode());
    }

    /**
     * Wrapping multiplies lines, so the cap has to apply afterwards; checking only the
     * submitted count would let a short request produce an unbounded receipt.
     */
    @Test
    void rejectsTooManyLinesAfterWrapping() {
        // Each element is within every input limit, but wraps to two lines at width 10,
        // so only the post-wrap count can catch this.
        PrintRequestException thrown = error("{\"data\": [\"ab ab ab ab\", \"cd cd cd cd\"]}");

        assertEquals("too_many_output_lines", thrown.apiCode());
    }

    // -------------------------------------------------------------------------
    // Content
    // -------------------------------------------------------------------------

    @Test
    void reportsMarkupErrorWithLineAndColumn() {
        PrintRequestException thrown = error("{\"data\": [\"ok\", \"a <blink>b</blink>\"]}");

        assertEquals("unknown_tag", thrown.apiCode());
        assertEquals(2, thrown.line());
        assertEquals(3, thrown.column());
    }

    @Test
    void reportsUnsupportedCharacterWithEverythingNeededToFixIt() {
        PrintRequestException thrown = error("{\"data\": [\"ok\", \"Hello 😎\"]}");

        assertEquals("unsupported_character", thrown.apiCode());
        assertEquals(2, thrown.line());
        assertEquals(7, thrown.column());
        assertEquals("😎", thrown.character());
        assertEquals("CP858", thrown.codepage());
    }

    @Test
    void reportsControlCharacterWithPosition() {
        PrintRequestException thrown = error("{\"data\": [\"a\\tb\"]}");

        assertEquals("control_character", thrown.apiCode());
        assertEquals(1, thrown.line());
        assertEquals(2, thrown.column());
    }

    // -------------------------------------------------------------------------
    // Wrapping and defaults
    // -------------------------------------------------------------------------

    @Test
    void wrapsByDefaultAccordingToTheDeviceWidth() throws Exception {
        CompiledJob job = compile("{\"data\": [\"" + "ab ".repeat(4) + "\"]}");

        assertEquals(2, job.lines(), "11 columns of text should wrap at width 10");
    }

    /**
     * Limits are checked before content: a request that is both oversized and malformed
     * should be refused for the cheaper reason, without parsing megabytes of markup first.
     */
    @Test
    void checksLimitsBeforeParsingContent() {
        String tooLong = "a".repeat(21) + "<blink>";
        assertEquals("line_too_long", error("{\"data\": [\"" + tooLong + "\"]}").apiCode());
    }

    // -------------------------------------------------------------------------
    // Fixtures
    // -------------------------------------------------------------------------

    private static CompiledJob compile(String body) throws PrintRequestException {
        return PrintCompiler.compile(body, device());
    }

    private static PrintRequestException error(String body) {
        return assertThrows(PrintRequestException.class, () -> compile(body));
    }

    /** A deliberately tiny device, so limits can be crossed with readable fixtures. */
    private static Device device() {
        return new Device(
                "kitchen",
                new SerialSettings("COM3", 9600, 8, 1, Parity.NONE, FlowControl.NONE,
                        true, true, Duration.ofSeconds(5), Duration.ofMillis(5000)),
                new PrintSettings(10, Codepage.CP858, UnsupportedPolicy.REJECT, true, Linefeed.LF),
                new LimitSettings(5, 20, 50, 3, 100),
                false);
    }

    /**
     * The ten-column fixture with room for a tagged element.
     *
     * {@link #device()} caps a line at twenty characters, which a tag plus its text exceeds —
     * the request would be refused before wrapping was reached, testing the wrong thing.
     */
    private static Device wrappingDevice(boolean defaultWrap) {
        return new Device(
                "kitchen",
                new SerialSettings("COM3", 9600, 8, 1, Parity.NONE, FlowControl.NONE,
                        true, true, Duration.ofSeconds(5), Duration.ofMillis(5000)),
                new PrintSettings(10, Codepage.CP858, UnsupportedPolicy.REJECT, defaultWrap, Linefeed.LF),
                new LimitSettings(5, 60, 200, 6, 100),
                false);
    }

    // -------------------------------------------------------------------------
    // wrap / nowrap tags
    // -------------------------------------------------------------------------

    @Test
    void leavesANowrapLineIntactWhileNeighboursWrap() throws Exception {
        // At width 10, "ab ab ab ab" wraps to two lines; the tagged twin stays one.
        CompiledJob job = PrintCompiler.compile(
                "{\"data\":[\"ab ab ab ab\",\"<nowrap>ab ab ab ab</nowrap>\"]}", wrappingDevice(true));

        assertEquals(3, job.lines());
    }

    @Test
    void wrapsAWrapLineWhenTheDeviceDefaultIsOff() throws Exception {
        CompiledJob job = PrintCompiler.compile(
                "{\"data\":[\"<wrap>ab ab ab ab</wrap>\"]}", wrappingDevice(false));

        assertEquals(2, job.lines());
    }

    @Test
    void followsTheDeviceDefaultWhenNoTagIsPresent() throws Exception {
        assertEquals(1, PrintCompiler.compile(
                "{\"data\":[\"ab ab ab ab\"]}", wrappingDevice(false)).lines());
        assertEquals(2, PrintCompiler.compile(
                "{\"data\":[\"ab ab ab ab\"]}", wrappingDevice(true)).lines());
    }

    @Test
    void rejectsTheRemovedWrapField() {
        PrintRequestException failure = assertThrows(PrintRequestException.class,
                () -> PrintCompiler.compile("{\"data\":[\"x\"],\"wrap\":false}", device()));

        assertEquals("unknown_field", failure.apiCode());
        assertTrue(failure.getMessage().contains("<nowrap>"));
    }

    @Test
    void rejectsAMisspelledField() {
        assertEquals("unknown_field", assertThrows(PrintRequestException.class,
                () -> PrintCompiler.compile("{\"data\":[\"x\"],\"linefeeed\":\"LF\"}", device()))
                .apiCode());
    }
}
