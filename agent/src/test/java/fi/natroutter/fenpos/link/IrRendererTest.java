package fi.natroutter.fenpos.link;

import fi.natroutter.fenpos.device.Device;
import fi.natroutter.fenpos.device.DeviceRegistry;
import fi.natroutter.fenpos.encoding.SymbolEncodingException;
import fi.natroutter.fenpos.enums.Align;
import fi.natroutter.fenpos.enums.BarcodeSystem;
import fi.natroutter.fenpos.enums.Codepage;
import fi.natroutter.fenpos.enums.CutMode;
import fi.natroutter.fenpos.enums.FlowControl;
import fi.natroutter.fenpos.enums.Font;
import fi.natroutter.fenpos.enums.Linefeed;
import fi.natroutter.fenpos.enums.Parity;
import fi.natroutter.fenpos.print.CompiledJob;
import org.junit.jupiter.api.Test;

import java.nio.charset.StandardCharsets;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertInstanceOf;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Tests for the agent's half of the intermediate representation seam.
 * <p>
 * The server compiles a job and this renders it. What is asserted here is that the wire shapes
 * reach the printer intact, and that a job carrying something this agent cannot render is
 * refused rather than partially printed — the agent does not assume the server validated.
 */
class IrRendererTest {

    @Test
    void rendersTextIntoThePayload() throws Exception {
        CompiledJob rendered = IrRenderer.render(job(line(span("Kahvi 2.50"))), device(), registry);

        assertTrue(new String(rendered.payload(), StandardCharsets.ISO_8859_1).contains("Kahvi 2.50"));
        assertEquals(1, rendered.lines());
    }

    @Test
    void countsOnlyLinesThatAdvanceThePaper() throws Exception {
        CompiledJob rendered = IrRenderer.render(
                job(line(span("one")), line(span("two")), directiveLine(cut(CutMode.FULL))),
                device(), registry);

        // A directive-only line emits its command without feeding paper, so it is not a
        // printed line and must not be counted as one against the job's reported total.
        assertEquals(2, rendered.lines());
    }

    @Test
    void rendersAJobThatIsOnlyDirectives() throws Exception {
        CompiledJob rendered = IrRenderer.render(job(directiveLine(cut(CutMode.FULL))), device(), registry);

        assertEquals(0, rendered.lines());
        assertTrue(rendered.bytes() > 0);
    }

    @Test
    void acceptsBothCutModes() throws Exception {
        assertTrue(IrRenderer.render(job(directiveLine(cut(CutMode.FULL))), device(), registry).bytes() > 0);
        assertTrue(IrRenderer.render(job(directiveLine(cut(CutMode.PARTIAL))), device(), registry).bytes() > 0);
    }

    @Test
    void acceptsAFeed() throws Exception {
        assertTrue(IrRenderer.render(job(directiveLine(feed(3))), device(), registry).bytes() > 0);
    }

    @Test
    void rendersAQrCode() throws Exception {
        CompiledJob rendered = IrRenderer.render(
                job(directiveLine(new Frames.WireDirective.Qr("https://fenpos.test", 6))), device(), registry);

        // GS ( k, the two-dimensional symbol command, with the content stored verbatim.
        assertTrue(contains(rendered.payload(), new byte[]{0x1D, '(', 'k'}));
        assertTrue(new String(rendered.payload(), StandardCharsets.ISO_8859_1)
                .contains("https://fenpos.test"));
        assertEquals(0, rendered.lines());
    }

    /**
     * The size off the wire is the size the server budgeted and previewed, so it has to be the
     * size on the paper. Asserted as the byte in function 067 — {@code GS ( k 03 00 49 67 n} —
     * because a hardcoded {@code setSize(3)} would satisfy every other assertion in this class.
     */
    @Test
    void sendsTheQrModuleSizeItWasGiven() throws Exception {
        for (int size : new int[] {1, 6, 16}) {
            CompiledJob rendered = IrRenderer.render(
                    job(directiveLine(new Frames.WireDirective.Qr("x", size))), device(), registry);

            assertTrue(contains(rendered.payload(),
                            new byte[]{0x1D, '(', 'k', 0x03, 0x00, 49, 67, (byte) size}),
                    "module size " + size + " should reach function 067");
        }
    }

    /**
     * Likewise the error correction level, asserted as the byte in function 069 —
     * {@code GS ( k 04 00 48 69 48 n}, where n is 48 + the level. Walked across the whole range
     * because the mapping is nine hand-written cases and an off-by-one in any of them would
     * silently change how much damage a printed symbol survives.
     */
    @Test
    void sendsThePdf417ErrorLevelItWasGiven() throws Exception {
        for (int level = 0; level <= 8; level++) {
            CompiledJob rendered = IrRenderer.render(
                    job(directiveLine(new Frames.WireDirective.Pdf417("x", level, 5))), device(), registry);

            assertTrue(contains(rendered.payload(),
                            new byte[]{0x1D, '(', 'k', 0x04, 0x00, 48, 69, 48, (byte) (48 + level)}),
                    "error level " + level + " should reach function 069");
        }
    }

    @Test
    void rendersALinearBarcode() throws Exception {
        CompiledJob rendered = IrRenderer.render(
                job(directiveLine(new Frames.WireDirective.Barcode(
                        BarcodeSystem.EAN13, "4006381333931"))), device(), registry);

        // GS k 2: print barcode, function A, JAN/EAN-13.
        assertTrue(contains(rendered.payload(), new byte[]{0x1D, 'k', 0x02}));
        assertTrue(new String(rendered.payload(), StandardCharsets.ISO_8859_1).contains("4006381333931"));
    }

    @Test
    void suppliesACode128CodeSetWhenTheContentDoesNot() {
        // The ESC/POS command has no code set field; the selector is the first two characters of
        // the data. Content that arrives without one would otherwise be refused by the encoder.
        CompiledJob rendered = assertDoesNotThrow(() -> IrRenderer.render(
                job(directiveLine(new Frames.WireDirective.Barcode(
                        BarcodeSystem.CODE128, "ORDER-42"))), device(), registry));

        assertEquals("{BORDER-42", code128Data(rendered));
    }

    /**
     * A brace in Code 128 data is an escape, so a literal one is written twice. Without this the
     * printer reads the caller's own text as a mid-stream code set switch and drops it: content
     * {@code A{B} would print as {@code A}, scanning cleanly and saying the wrong thing.
     */
    @Test
    void doublesABraceInsideCode128Content() {
        CompiledJob rendered = assertDoesNotThrow(() -> IrRenderer.render(
                job(directiveLine(new Frames.WireDirective.Barcode(
                        BarcodeSystem.CODE128, "A{B"))), device(), registry));

        assertEquals("{BA{{B", code128Data(rendered));
    }

    /**
     * Content that happens to begin with what looks like a code set selector is data like any
     * other. There is no pass-through branch to be fooled: {@code {Barcode} is a caller who
     * wants a brace printed, not one switching to code set B.
     */
    @Test
    void treatsContentThatLooksLikeACodeSetAsLiteralData() {
        CompiledJob rendered = assertDoesNotThrow(() -> IrRenderer.render(
                job(directiveLine(new Frames.WireDirective.Barcode(
                        BarcodeSystem.CODE128, "{Barcode"))), device(), registry));

        assertEquals("{B{{Barcode", code128Data(rendered));
    }

    /** A brace followed by no defined escape is data too, not a dangling escape. */
    @Test
    void escapesABraceThatNamesNoCodeSet() {
        CompiledJob rendered = assertDoesNotThrow(() -> IrRenderer.render(
                job(directiveLine(new Frames.WireDirective.Barcode(
                        BarcodeSystem.CODE128, "{X"))), device(), registry));

        assertEquals("{B{{X", code128Data(rendered));
    }

    /**
     * The column count, asserted as the byte in function 065 — {@code GS ( k 03 00 48 65 n}.
     * <p>
     * The whole point of carrying it. Left unset the library sends {@code n = 0}, which the printer
     * reads as "lay the symbol out however you like" — while the server has already charged a line
     * budget against its own layout, so the same data prints a different number of rows from the
     * number that was counted. Several counts are walked so that a renderer sending a constant, or
     * sending the error level here by mistake, fails rather than passing on one lucky value.
     */
    @Test
    void sendsThePdf417ColumnCountItWasGiven() throws Exception {
        for (int columns : new int[] {1, 2, 5, 14, 30}) {
            CompiledJob rendered = IrRenderer.render(
                    job(directiveLine(new Frames.WireDirective.Pdf417("ORDER-42", 3, columns))), device(), registry);

            assertTrue(contains(rendered.payload(),
                            new byte[]{0x1D, '(', 'k', 0x03, 0x00, 48, 65, (byte) columns}),
                    "column count " + columns + " should reach function 065");
        }
    }

    @Test
    void rendersPdf417() throws Exception {
        CompiledJob rendered = IrRenderer.render(
                job(directiveLine(new Frames.WireDirective.Pdf417("ORDER-42", 3, 5))), device(), registry);

        assertTrue(new String(rendered.payload(), StandardCharsets.ISO_8859_1).contains("ORDER-42"));
    }

    @Test
    void pulsesTheDrawerOnEitherPin() throws Exception {
        // ESC p m t1 t2, matching the sequences the panel's raw-byte tool catalogues, so an
        // operator can fire the drawer from either place and compare what went down the wire.
        assertTrue(contains(
                IrRenderer.render(job(directiveLine(new Frames.WireDirective.Drawer(2))), device(), registry).payload(),
                new byte[]{0x1B, 0x70, 0x00, 0x19, (byte) 0xFA}));
        assertTrue(contains(
                IrRenderer.render(job(directiveLine(new Frames.WireDirective.Drawer(5))), device(), registry).payload(),
                new byte[]{0x1B, 0x70, 0x01, 0x19, (byte) 0xFA}));
    }

    @Test
    void chargesADrawerPulseNoLinesBecauseItPrintsNothing() throws Exception {
        CompiledJob rendered = IrRenderer.render(
                job(line(span("Thanks")), directiveLine(new Frames.WireDirective.Drawer(2))), device(), registry);

        assertEquals(1, rendered.lines());
    }

    @Test
    void refusesAFeedBeyondWhatAPrinterAccepts() {
        assertThrows(ProtocolException.class, () ->
                IrRenderer.render(job(directiveLine(feed(999))), device(), registry));
    }

    @Test
    void refusesContentTheSymbologyCannotEncodeRatherThanPrintingAStripe() {
        // The server's format rules are looser than the encoder's in places — here an odd digit
        // count, which interleaved 2 of 5 cannot pair up. The encoder's complaint must come back
        // as a failed job, not as an unchecked exception off the print path.
        ProtocolException thrown = assertThrows(ProtocolException.class, () ->
                IrRenderer.render(
                        job(directiveLine(new Frames.WireDirective.Barcode(BarcodeSystem.ITF, "12345"))),
                        device(), registry));

        assertTrue(thrown.getMessage() != null && !thrown.getMessage().isBlank(),
                "the encoder's own words are all the operator has to go on");
        // Kept rather than discarded: the operator gets the sentence, the local log gets the
        // stack that says which encoder produced it.
        assertInstanceOf(SymbolEncodingException.class, thrown.getCause());
    }

    @Test
    void rendersAnEmptyJobWithoutFailing() throws Exception {
        CompiledJob rendered = IrRenderer.render(
                new Frames.CompiledJob("j1", "kitchen", Linefeed.LF, List.of()), device(), registry);

        assertEquals(0, rendered.lines());
    }

    // -------------------------------------------------------------------------
    // Images
    //
    // Two shapes, one rendered result. A stored image names dots that arrived with the
    // configuration; anything else brings its own.
    // -------------------------------------------------------------------------

    @Test
    void printsTheDotsSyncedForAStoredImage() throws Exception {
        CompiledJob rendered = IrRenderer.render(
                job(directiveLine(new Frames.WireDirective.StoredImage("logo", 16))), device(), registry);

        // GS v 0 m xL xH yL yH, then the dots as they were synced.
        assertTrue(contains(rendered.payload(),
                new byte[]{0x1D, 'v', '0', 0x00, 0x02, 0x00, 0x02, 0x00,
                        (byte) 0x80, 0x01, 0x00, (byte) 0xFF}));
    }

    @Test
    void printsTheDotsAJobCarriesForItself() throws Exception {
        CompiledJob rendered = IrRenderer.render(
                job(directiveLine(new Frames.WireDirective.InlineImage(16, 2, LOGO_DOTS))),
                device(),
                new DeviceRegistry());

        assertTrue(contains(rendered.payload(),
                new byte[]{0x1D, 'v', '0', 0x00, 0x02, 0x00, 0x02, 0x00,
                        (byte) 0x80, 0x01, 0x00, (byte) 0xFF}));
    }

    /**
     * An image is a block of dots rather than a printed line, and the raster command feeds the
     * paper itself, so a line carrying only one must not also be counted as text.
     */
    @Test
    void chargesAnImageNoTextLines() throws Exception {
        CompiledJob rendered = IrRenderer.render(
                job(line(span("Thanks")), directiveLine(new Frames.WireDirective.StoredImage("logo", 16))),
                device(),
                registry);

        assertEquals(1, rendered.lines());
    }

    /**
     * The gap this closes: an image uploaded while a job was in flight, or one the server had to
     * leave out of a full configuration frame. Failing the job by name is worth far more than
     * printing a receipt with a blank space where the logo was, which nobody notices until a
     * customer is holding it.
     */
    @Test
    void refusesAStoredImageThisAgentWasNeverSent() {
        ProtocolException thrown = assertThrows(ProtocolException.class, () ->
                IrRenderer.render(
                        job(directiveLine(new Frames.WireDirective.StoredImage("stamp", 16))),
                        device(),
                        registry));

        assertTrue(thrown.getMessage().contains("stamp"), thrown.getMessage());
    }

    /**
     * A raster is dithered for one printed width and is not a picture at another, so the width is
     * half of the key. Asking for a width that was not synced is a miss, not a resize.
     */
    @Test
    void refusesAStoredImageAtAWidthThatWasNotSynced() {
        ProtocolException thrown = assertThrows(ProtocolException.class, () ->
                IrRenderer.render(
                        job(directiveLine(new Frames.WireDirective.StoredImage("logo", 24))),
                        device(),
                        registry));

        assertTrue(thrown.getMessage().contains("24"), thrown.getMessage());
    }

    // -------------------------------------------------------------------------
    // Fixtures
    // -------------------------------------------------------------------------

    /**
     * A 16x2 raster with a bit in each corner of interest.
     * <p>
     * Two bytes a row, and deliberately asymmetric: {@code 0x80} is the leftmost dot of the top
     * row and {@code 0x01} the rightmost of that row's first byte, so a payload that emerged
     * mirrored or with its rows reordered cannot match.
     */
    private static final byte[] LOGO_DOTS = {(byte) 0x80, 0x01, 0x00, (byte) 0xFF};

    /** This agent as a {@code config.sync} carrying one image would have left it. */
    private final DeviceRegistry registry = syncedWith(new Frames.AssetRaster("logo", 16, 2, LOGO_DOTS));

    private static DeviceRegistry syncedWith(Frames.AssetRaster... rasters) {
        DeviceRegistry registry = new DeviceRegistry();
        registry.applyRasters(List.of(rasters));
        return registry;
    }

    private static Frames.CompiledJob job(Frames.WireLine... lines) {
        return new Frames.CompiledJob("j1", "kitchen", Linefeed.LF, List.of(lines));
    }

    private static Frames.WireLine line(Frames.WireSpan... spans) {
        return new Frames.WireLine(Align.LEFT, List.of(spans), List.of());
    }

    private static Frames.WireLine directiveLine(Frames.WireDirective... directives) {
        return new Frames.WireLine(Align.LEFT, List.of(), List.of(directives));
    }

    private static Frames.WireSpan span(String text) {
        return new Frames.WireSpan(text, false, 0, false, 1, 1, Font.A);
    }

    private static Frames.WireDirective cut(CutMode mode) {
        return new Frames.WireDirective.Cut(mode);
    }

    private static Frames.WireDirective feed(int lines) {
        return new Frames.WireDirective.Feed(lines);
    }

    /**
     * The exact data bytes of the Code 128 command in a payload.
     * <p>
     * Read out of the command rather than searched for as a substring, because the point of
     * these tests is what the printer is told the data <em>is</em> — the length prefix and the
     * bytes it counts. {@code GS k 73 n d1..dn}, function B.
     */
    private static String code128Data(CompiledJob rendered) {
        byte[] payload = rendered.payload();
        int command = indexOf(payload, new byte[]{0x1D, 'k', 73});
        assertTrue(command >= 0, "payload carries no Code 128 command");

        int length = payload[command + 3] & 0xFF;
        return new String(payload, command + 4, length, StandardCharsets.ISO_8859_1);
    }

    /** Whether {@code payload} contains {@code needle}, so a command can be located by its bytes. */
    private static boolean contains(byte[] payload, byte[] needle) {
        return indexOf(payload, needle) >= 0;
    }

    private static int indexOf(byte[] payload, byte[] needle) {
        outer:
        for (int start = 0; start + needle.length <= payload.length; start++) {
            for (int offset = 0; offset < needle.length; offset++) {
                if (payload[start + offset] != needle[offset]) {
                    continue outer;
                }
            }
            return start;
        }
        return -1;
    }

    private static Device device() {
        return Device.from(new Frames.DeviceConfig(
                "kitchen", "COM3", 19200, 8, 1, Parity.NONE, FlowControl.NONE,
                5000, false, false, 5, 32, Codepage.CP858, false, 10));
    }
}
