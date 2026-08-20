package fi.natroutter.fenpos.encoding;

import fi.natroutter.fenpos.enums.Align;
import fi.natroutter.fenpos.enums.BarcodeSystem;
import fi.natroutter.fenpos.enums.Codepage;
import fi.natroutter.fenpos.enums.Linefeed;
import fi.natroutter.fenpos.markup.MarkupParser;
import fi.natroutter.fenpos.markup.model.Directive;
import fi.natroutter.fenpos.markup.model.Line;
import org.junit.jupiter.api.Test;

import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertInstanceOf;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Behavioural tests for {@link EscPosRenderer}.
 * <p>
 * Assertions target specific command sequences rather than whole golden byte arrays. The
 * style preamble emitted by the underlying library is an implementation detail of that
 * library and would change with a version bump; the commands asserted here are the ESC/POS
 * guarantees the agent actually makes.
 */
class EscPosRendererTest {

    private static final byte[] INITIALIZE = {0x1B, 0x40};
    private static final byte[] SELECT_CP858 = {0x1B, 0x74, 0x13};
    private static final byte[] BOLD_ON = {0x1B, 0x45, 0x01};
    private static final byte[] BOLD_OFF = {0x1B, 0x45, 0x00};
    private static final byte[] CUT_FULL = {0x1D, 0x56, 0x30};
    private static final byte[] CUT_PARTIAL = {0x1D, 0x56, 0x31};
    private static final byte[] CENTRE_JUSTIFY = {0x1B, 0x61, 0x31};
    private static final byte[] DRAWER_PIN_2 = {0x1B, 0x70, 0x00, 0x19, (byte) 0xFA};
    private static final byte[] DRAWER_PIN_5 = {0x1B, 0x70, 0x01, 0x19, (byte) 0xFA};

    /**
     * Jobs share a device, so a job that left the printer bold would corrupt the next
     * receipt. Every job therefore starts from a known state.
     */
    @Test
    void startsEveryJobByResettingThePrinterAndSelectingTheCodepage() throws Exception {
        byte[] output = render("hi", Codepage.CP858, Linefeed.LF);

        assertEquals(0, indexOf(output, INITIALIZE), "job must begin with ESC @");
        assertEquals(2, indexOf(output, SELECT_CP858), "codepage must be selected up front");
    }

    @Test
    void emitsTextFollowedByTheLinefeed() throws Exception {
        byte[] output = render("hi", Codepage.CP858, Linefeed.LF);

        assertTrue(endsWith(output, new byte[]{'h', 'i', 0x0A}));
    }

    @Test
    void crlfPolicyEmitsCarriageReturnBeforeLinefeed() throws Exception {
        assertTrue(endsWith(render("hi", Codepage.CP858, Linefeed.CRLF),
                new byte[]{'h', 'i', 0x0D, 0x0A}));
    }

    @Test
    void nonePolicyEmitsNoLineTerminator() throws Exception {
        assertTrue(endsWith(render("hi", Codepage.CP858, Linefeed.NONE), new byte[]{'h', 'i'}));
    }

    @Test
    void encodesTextInTheDeviceCodepage() throws Exception {
        byte[] output = render("€", Codepage.CP858, Linefeed.NONE);

        assertTrue(contains(output, new byte[]{(byte) 0xD5}), "euro sign is 0xD5 in CP858");
    }

    @Test
    void emitsBoldOnAndOffAroundABoldSpan() throws Exception {
        byte[] output = render("<bold>a</bold>b", Codepage.CP858, Linefeed.LF);

        assertTrue(contains(output, BOLD_ON));
        assertTrue(contains(output, BOLD_OFF));
    }

    /**
     * The reason the renderer tracks style itself: the library re-sends the whole preamble
     * on every write, which on a 9600 baud link costs real printing time.
     */
    @Test
    void emitsStyleConfigOnlyOnceForConsecutiveSpansOfEqualStyle() throws Exception {
        Line line = MarkupParser.parse("a&lt;b");
        assertEquals(3, line.spans().size(), "fixture must supply separate same-style spans");

        byte[] output = EscPosRenderer.render(List.of(line), Codepage.CP858, Linefeed.LF, 42);

        assertEquals(1, count(output, BOLD_OFF),
                "the shared style preamble should be written once, not once per span");
    }

    @Test
    void directiveOnlyLineEmitsNoLinefeed() throws Exception {
        byte[] output = render("<cut>", Codepage.CP858, Linefeed.LF);

        assertTrue(contains(output, CUT_FULL));
        assertFalse(contains(output, new byte[]{0x0A}), "a cut must not also advance paper");
    }

    @Test
    void partialCutEmitsThePartialCutCommand() throws Exception {
        assertTrue(contains(render("<cut=partial>", Codepage.CP858, Linefeed.LF), CUT_PARTIAL));
    }

    /**
     * Asserted as a contiguous run rather than a byte count: the underline-off command is
     * {@code 1B 2D 30}, whose middle byte is itself {@code '-'}, so counting bare bytes
     * would include one that is part of a command.
     */
    @Test
    void ruleFillsTheConfiguredWidth() throws Exception {
        byte[] output = EscPosRenderer.render(
                List.of(MarkupParser.parse("<hr>")), Codepage.CP858, Linefeed.LF, 12);

        assertTrue(contains(output, "-".repeat(12).getBytes(StandardCharsets.US_ASCII)),
                "rule should span the full configured width");
        assertFalse(contains(output, "-".repeat(13).getBytes(StandardCharsets.US_ASCII)),
                "rule should not exceed the configured width");
    }

    /**
     * The library's feed emits a default style preamble of its own, silently resetting the
     * printer. Text after a feed must therefore have its style restated.
     */
    @Test
    void restatesStyleAfterAFeedBecauseFeedResetsThePrinter() throws Exception {
        List<Line> lines = List.of(
                MarkupParser.parse("<bold>a</bold>"),
                MarkupParser.parse("<feed=2>"),
                MarkupParser.parse("<bold>b</bold>"));

        byte[] output = EscPosRenderer.render(lines, Codepage.CP858, Linefeed.LF, 42);

        assertEquals(2, count(output, BOLD_ON),
                "bold must be re-sent after the feed reset the printer");
    }

    // -------------------------------------------------------------------------
    // Blocks
    //
    // These reach the renderer only from the link, never from markup this agent parses, so the
    // fixtures build lines directly rather than going through the parser.
    // -------------------------------------------------------------------------

    /**
     * Each symbol command carries its own justification, so the line's alignment has to reach
     * the block rather than being left to whatever the last span set.
     */
    @Test
    void takesASymbolsJustificationFromItsLine() throws Exception {
        byte[] output = EscPosRenderer.render(
                List.of(directiveLine(Align.CENTER, new Directive.Qr("x", 3))),
                Codepage.CP858, Linefeed.LF, 42);

        assertTrue(contains(output, CENTRE_JUSTIFY));
    }

    /**
     * A symbol's own preamble leaves the printer in a state the renderer's cached style no
     * longer describes, exactly as a feed does. Text after one must have its style restated.
     */
    @Test
    void restatesStyleAfterASymbolBecauseTheSymbolWritesItsOwnPreamble() throws Exception {
        List<Line> lines = List.of(
                MarkupParser.parse("<bold>a</bold>"),
                directiveLine(Align.LEFT, new Directive.Qr("x", 3)),
                MarkupParser.parse("<bold>b</bold>"));

        byte[] output = EscPosRenderer.render(lines, Codepage.CP858, Linefeed.LF, 42);

        assertEquals(2, count(output, BOLD_ON),
                "bold must be re-sent after the symbol wrote its own preamble");
    }

    @Test
    void emitsTheDrawerPulseForEitherPin() throws Exception {
        assertTrue(contains(
                EscPosRenderer.render(List.of(directiveLine(Align.LEFT, new Directive.Drawer(2))),
                        Codepage.CP858, Linefeed.LF, 42),
                DRAWER_PIN_2));
        assertTrue(contains(
                EscPosRenderer.render(List.of(directiveLine(Align.LEFT, new Directive.Drawer(5))),
                        Codepage.CP858, Linefeed.LF, 42),
                DRAWER_PIN_5));
    }

    /**
     * The pulse is electrical: it writes no style of its own, so unlike a symbol it leaves the
     * cached style still describing the printer and must not cost a needless preamble.
     */
    @Test
    void keepsTheCachedStyleAcrossADrawerPulse() throws Exception {
        List<Line> lines = List.of(
                MarkupParser.parse("<bold>a</bold>"),
                directiveLine(Align.LEFT, new Directive.Drawer(2)),
                MarkupParser.parse("<bold>b</bold>"));

        byte[] output = EscPosRenderer.render(lines, Codepage.CP858, Linefeed.LF, 42);

        assertEquals(1, count(output, BOLD_ON),
                "a pulse changes no style, so the preamble should not be re-sent");
    }

    // -------------------------------------------------------------------------
    // Images
    //
    // The dots are decided on the server and this renderer must not touch them. escpos-coffee
    // does not take a bitmap: it asks a CoffeeImage for pixels and a Bitonal for ink-or-paper,
    // then packs the answers most significant bit first with each row padded to a whole byte.
    // These tests are what pins that the packing it produces is the packing that arrived — a bit
    // order that came out reversed would print a plausible-looking mirrored logo.
    // -------------------------------------------------------------------------

    /**
     * A 16x2 raster, two bytes a row and deliberately asymmetric.
     * <p>
     * {@code 0x80} is the leftmost dot of the top row and {@code 0x01} the rightmost dot of that
     * row's first byte. Reversing the bit order within a byte, or swapping the rows, gives a
     * different sequence — which is the whole point of choosing these values.
     */
    private static final byte[] ASYMMETRIC_DOTS = {(byte) 0x80, 0x01, 0x00, (byte) 0xFF};

    @Test
    void emitsTheRasterCommandWithTheDotsExactlyAsTheyArrived() throws Exception {
        byte[] output = EscPosRenderer.render(
                List.of(directiveLine(Align.LEFT, new Directive.Image(16, 2, ASYMMETRIC_DOTS))),
                Codepage.CP858, Linefeed.LF, 42);

        // GS v 0 m, then the width in bytes and the height in dots, each little-endian.
        assertTrue(contains(output, new byte[]{0x1D, 'v', '0', 0x00, 0x02, 0x00, 0x02, 0x00,
                (byte) 0x80, 0x01, 0x00, (byte) 0xFF}),
                "the raster command must carry the packed dots unchanged");
    }

    /**
     * A row is a whole number of bytes even when the dots do not fill it. Nine dots across is two
     * bytes with seven bits of paper on the end, and the command counts bytes — so a renderer that
     * packed rows tightly would declare the same width and hand the printer a picture sheared one
     * dot further left on every row.
     */
    @Test
    void countsARowsPaddingAsPartOfTheRaster() throws Exception {
        // Nine dots wide, three rows: 0x80,0x00 is one dot at the left of each row.
        byte[] dots = {(byte) 0x80, 0x00, (byte) 0x80, 0x00, (byte) 0x80, 0x00};

        byte[] output = EscPosRenderer.render(
                List.of(directiveLine(Align.LEFT, new Directive.Image(9, 3, dots))),
                Codepage.CP858, Linefeed.LF, 42);

        assertTrue(contains(output, new byte[]{0x1D, 'v', '0', 0x00, 0x02, 0x00, 0x03, 0x00,
                (byte) 0x80, 0x00, (byte) 0x80, 0x00, (byte) 0x80, 0x00}),
                "two bytes a row, three rows, padding included");
    }

    /** A raster taller than one byte's worth of height is still one command, not a stack of bands. */
    @Test
    void emitsOneCommandForATallRaster() throws Exception {
        byte[] dots = new byte[300];
        Arrays.fill(dots, (byte) 0xA5);

        byte[] output = EscPosRenderer.render(
                List.of(directiveLine(Align.LEFT, new Directive.Image(8, 300, dots))),
                Codepage.CP858, Linefeed.LF, 42);

        assertEquals(1, count(output, new byte[]{0x1D, 'v', '0'}));
        // 300 dots of height is 0x012C, low byte first.
        assertTrue(contains(output, new byte[]{0x1D, 'v', '0', 0x00, 0x01, 0x00, 0x2C, 0x01}));
    }

    @Test
    void takesAnImagesJustificationFromItsLine() throws Exception {
        byte[] output = EscPosRenderer.render(
                List.of(directiveLine(Align.CENTER, new Directive.Image(16, 2, ASYMMETRIC_DOTS))),
                Codepage.CP858, Linefeed.LF, 42);

        assertTrue(contains(output, CENTRE_JUSTIFY));
    }

    /**
     * The raster command writes its own justification, exactly as a symbol does, so the cached
     * style no longer describes the printer and text after an image must have its style restated.
     */
    @Test
    void restatesStyleAfterAnImageBecauseTheRasterWritesItsOwnPreamble() throws Exception {
        List<Line> lines = List.of(
                MarkupParser.parse("<bold>a</bold>"),
                directiveLine(Align.LEFT, new Directive.Image(16, 2, ASYMMETRIC_DOTS)),
                MarkupParser.parse("<bold>b</bold>"));

        byte[] output = EscPosRenderer.render(lines, Codepage.CP858, Linefeed.LF, 42);

        assertEquals(2, count(output, BOLD_ON),
                "bold must be re-sent after the raster wrote its own preamble");
    }

    /**
     * A symbology refusing its content must arrive as {@link SymbolEncodingException} and carry
     * the encoder's own words, so callers can tell it apart from a bug in this class. An
     * {@link IllegalArgumentException} escaping raw would be reported as a bad job and blame the
     * server for something this code got wrong.
     */
    @Test
    void reportsAnEncoderRefusalAsAnEncodingFailureCarryingItsCause() {
        SymbolEncodingException thrown = assertThrows(SymbolEncodingException.class, () ->
                EscPosRenderer.render(
                        List.of(directiveLine(Align.LEFT,
                                new Directive.Barcode(BarcodeSystem.EAN8, "not-digits"))),
                        Codepage.CP858, Linefeed.LF, 42));

        assertTrue(thrown.getMessage().contains("EAN8"), thrown.getMessage());
        assertInstanceOf(IllegalArgumentException.class, thrown.getCause());
    }

    // -------------------------------------------------------------------------
    // Helpers
    // -------------------------------------------------------------------------

    private static byte[] render(String markup, Codepage codepage, Linefeed linefeed)
            throws Exception {
        return EscPosRenderer.render(
                List.of(MarkupParser.parse(markup)), codepage, linefeed, 42);
    }

    private static Line directiveLine(Align align, Directive directive) {
        return new Line(align, null, List.of(), List.of(directive));
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

    private static boolean contains(byte[] haystack, byte[] needle) {
        return indexOf(haystack, needle) >= 0;
    }

    private static int count(byte[] haystack, byte[] needle) {
        int found = 0;
        for (int start = 0; start + needle.length <= haystack.length; start++) {
            boolean match = true;
            for (int offset = 0; offset < needle.length && match; offset++) {
                match = haystack[start + offset] == needle[offset];
            }
            if (match) {
                found++;
            }
        }
        return found;
    }

    private static boolean endsWith(byte[] haystack, byte[] suffix) {
        if (suffix.length > haystack.length) {
            return false;
        }
        int start = haystack.length - suffix.length;
        for (int offset = 0; offset < suffix.length; offset++) {
            if (haystack[start + offset] != suffix[offset]) {
                return false;
            }
        }
        return true;
    }
}
