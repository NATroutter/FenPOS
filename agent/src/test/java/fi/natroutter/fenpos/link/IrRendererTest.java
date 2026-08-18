package fi.natroutter.fenpos.link;

import fi.natroutter.fenpos.device.Device;
import fi.natroutter.fenpos.enums.Align;
import fi.natroutter.fenpos.enums.Codepage;
import fi.natroutter.fenpos.enums.FlowControl;
import fi.natroutter.fenpos.enums.Font;
import fi.natroutter.fenpos.enums.Linefeed;
import fi.natroutter.fenpos.enums.Parity;
import fi.natroutter.fenpos.print.CompiledJob;
import org.junit.jupiter.api.Test;

import java.nio.charset.StandardCharsets;
import java.util.List;

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
                job(line(span("one")), line(span("two")), directiveLine(cut("FULL"))),
                device());

        // A directive-only line emits its command without feeding paper, so it is not a
        // printed line and must not be counted as one against the job's reported total.
        assertEquals(2, rendered.lines());
    }

    @Test
    void rendersAJobThatIsOnlyDirectives() throws Exception {
        CompiledJob rendered = IrRenderer.render(job(directiveLine(cut("FULL"))), device());

        assertEquals(0, rendered.lines());
        assertTrue(rendered.bytes() > 0);
    }

    @Test
    void acceptsBothCutModes() throws Exception {
        assertTrue(IrRenderer.render(job(directiveLine(cut("FULL"))), device()).bytes() > 0);
        assertTrue(IrRenderer.render(job(directiveLine(cut("PARTIAL"))), device()).bytes() > 0);
    }

    @Test
    void acceptsAFeed() throws Exception {
        assertTrue(IrRenderer.render(job(directiveLine(feed(3))), device()).bytes() > 0);
    }

    @Test
    void refusesAnUnknownDirectiveRatherThanDroppingIt() {
        ProtocolException thrown = assertThrows(ProtocolException.class, () ->
                IrRenderer.render(
                        job(directiveLine(new Frames.WireDirective("DRAWER", null, null))),
                        device()));

        assertTrue(thrown.getMessage().contains("DRAWER"));
    }

    @Test
    void refusesAHorizontalRuleBecauseTheServerShouldHaveExpandedIt() {
        // Only the server knows the device's column count at compile time, so it turns a rule
        // into characters. One arriving here means the two sides disagree about that.
        assertThrows(ProtocolException.class, () ->
                IrRenderer.render(
                        job(directiveLine(new Frames.WireDirective("RULE", null, null))),
                        device()));
    }

    @Test
    void refusesAFeedWithNoLineCount() {
        assertThrows(ProtocolException.class, () ->
                IrRenderer.render(
                        job(directiveLine(new Frames.WireDirective("FEED", null, null))),
                        device()));
    }

    @Test
    void refusesAFeedBeyondWhatAPrinterAccepts() {
        assertThrows(ProtocolException.class, () ->
                IrRenderer.render(job(directiveLine(feed(999))), device()));
    }

    @Test
    void refusesAnUnknownCutMode() {
        assertThrows(ProtocolException.class, () ->
                IrRenderer.render(
                        job(directiveLine(new Frames.WireDirective("CUT", "HALFWAY", null))),
                        device()));
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

    private static Frames.WireDirective cut(String mode) {
        return new Frames.WireDirective("CUT", mode, null);
    }

    private static Frames.WireDirective feed(int lines) {
        return new Frames.WireDirective("FEED", null, lines);
    }

    private static Device device() {
        return Device.from(new Frames.DeviceConfig(
                "kitchen", "COM3", 19200, 8, 1, Parity.NONE, FlowControl.NONE,
                5000, false, false, 5, 32, Codepage.CP858, false, 10));
    }
}
