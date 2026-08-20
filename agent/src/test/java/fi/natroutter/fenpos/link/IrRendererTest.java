package fi.natroutter.fenpos.link;

import fi.natroutter.fenpos.device.Device;
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
        CompiledJob rendered = IrRenderer.render(job(line(span("Kahvi 2.50"))), device());

        assertTrue(new String(rendered.payload(), StandardCharsets.ISO_8859_1).contains("Kahvi 2.50"));
        assertEquals(1, rendered.lines());
    }

    @Test
    void countsOnlyLinesThatAdvanceThePaper() throws Exception {
        CompiledJob rendered = IrRenderer.render(
                job(line(span("one")), line(span("two")), directiveLine(cut(CutMode.FULL))),
                device());

        // A directive-only line emits its command without feeding paper, so it is not a
        // printed line and must not be counted as one against the job's reported total.
        assertEquals(2, rendered.lines());
    }

    @Test
    void rendersAJobThatIsOnlyDirectives() throws Exception {
        CompiledJob rendered = IrRenderer.render(job(directiveLine(cut(CutMode.FULL))), device());

        assertEquals(0, rendered.lines());
        assertTrue(rendered.bytes() > 0);
    }

    @Test
    void acceptsBothCutModes() throws Exception {
        assertTrue(IrRenderer.render(job(directiveLine(cut(CutMode.FULL))), device()).bytes() > 0);
        assertTrue(IrRenderer.render(job(directiveLine(cut(CutMode.PARTIAL))), device()).bytes() > 0);
    }

    @Test
    void acceptsAFeed() throws Exception {
        assertTrue(IrRenderer.render(job(directiveLine(feed(3))), device()).bytes() > 0);
    }

    @Test
    void rendersAQrCode() throws Exception {
        CompiledJob rendered = IrRenderer.render(
                job(directiveLine(new Frames.WireDirective.Qr("https://fenpos.test", 6))), device());

        // GS ( k, the two-dimensional symbol command, with the content stored verbatim.
        assertTrue(contains(rendered.payload(), new byte[]{0x1D, '(', 'k'}));
        assertTrue(new String(rendered.payload(), StandardCharsets.ISO_8859_1)
                .contains("https://fenpos.test"));
        assertEquals(0, rendered.lines());
    }

    @Test
    void rendersALinearBarcode() throws Exception {
        CompiledJob rendered = IrRenderer.render(
                job(directiveLine(new Frames.WireDirective.Barcode(
                        BarcodeSystem.EAN13, "4006381333931"))), device());

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
                        BarcodeSystem.CODE128, "ORDER-42"))), device()));

        assertTrue(new String(rendered.payload(), StandardCharsets.ISO_8859_1).contains("{BORDER-42"));
    }

    @Test
    void keepsACode128CodeSetTheCallerChose() {
        CompiledJob rendered = assertDoesNotThrow(() -> IrRenderer.render(
                job(directiveLine(new Frames.WireDirective.Barcode(
                        BarcodeSystem.CODE128, "{C123456"))), device()));

        String payload = new String(rendered.payload(), StandardCharsets.ISO_8859_1);
        assertTrue(payload.contains("{C123456"));
        assertTrue(!payload.contains("{B"), payload);
    }

    @Test
    void rendersPdf417() throws Exception {
        CompiledJob rendered = IrRenderer.render(
                job(directiveLine(new Frames.WireDirective.Pdf417("ORDER-42", 3))), device());

        assertTrue(new String(rendered.payload(), StandardCharsets.ISO_8859_1).contains("ORDER-42"));
    }

    @Test
    void pulsesTheDrawerOnEitherPin() throws Exception {
        // ESC p m t1 t2, matching the sequences the panel's raw-byte tool catalogues, so an
        // operator can fire the drawer from either place and compare what went down the wire.
        assertTrue(contains(
                IrRenderer.render(job(directiveLine(new Frames.WireDirective.Drawer(2))), device()).payload(),
                new byte[]{0x1B, 0x70, 0x00, 0x19, (byte) 0xFA}));
        assertTrue(contains(
                IrRenderer.render(job(directiveLine(new Frames.WireDirective.Drawer(5))), device()).payload(),
                new byte[]{0x1B, 0x70, 0x01, 0x19, (byte) 0xFA}));
    }

    @Test
    void chargesADrawerPulseNoLinesBecauseItPrintsNothing() throws Exception {
        CompiledJob rendered = IrRenderer.render(
                job(line(span("Thanks")), directiveLine(new Frames.WireDirective.Drawer(2))), device());

        assertEquals(1, rendered.lines());
    }

    @Test
    void refusesAFeedBeyondWhatAPrinterAccepts() {
        assertThrows(ProtocolException.class, () ->
                IrRenderer.render(job(directiveLine(feed(999))), device()));
    }

    @Test
    void refusesContentTheSymbologyCannotEncodeRatherThanPrintingAStripe() {
        // The server's format rules are looser than the encoder's in places — here an odd digit
        // count, which interleaved 2 of 5 cannot pair up. The encoder's complaint must come back
        // as a failed job, not as an unchecked exception off the print path.
        ProtocolException thrown = assertThrows(ProtocolException.class, () ->
                IrRenderer.render(
                        job(directiveLine(new Frames.WireDirective.Barcode(BarcodeSystem.ITF, "12345"))),
                        device()));

        assertTrue(thrown.getMessage() != null && !thrown.getMessage().isBlank(),
                "the encoder's own words are all the operator has to go on");
    }

    @Test
    void rendersAnEmptyJobWithoutFailing() throws Exception {
        CompiledJob rendered = IrRenderer.render(
                new Frames.CompiledJob("j1", "kitchen", Linefeed.LF, List.of()), device());

        assertEquals(0, rendered.lines());
    }

    // -------------------------------------------------------------------------
    // Fixtures
    // -------------------------------------------------------------------------

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

    /** Whether {@code payload} contains {@code needle}, so a command can be located by its bytes. */
    private static boolean contains(byte[] payload, byte[] needle) {
        outer:
        for (int start = 0; start + needle.length <= payload.length; start++) {
            for (int offset = 0; offset < needle.length; offset++) {
                if (payload[start + offset] != needle[offset]) {
                    continue outer;
                }
            }
            return true;
        }
        return false;
    }

    private static Device device() {
        return Device.from(new Frames.DeviceConfig(
                "kitchen", "COM3", 19200, 8, 1, Parity.NONE, FlowControl.NONE,
                5000, false, false, 5, 32, Codepage.CP858, false, 10));
    }
}
