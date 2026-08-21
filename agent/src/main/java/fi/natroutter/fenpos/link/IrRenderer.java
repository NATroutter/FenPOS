package fi.natroutter.fenpos.link;

import fi.natroutter.fenpos.device.Device;
import fi.natroutter.fenpos.device.DeviceRegistry;
import fi.natroutter.fenpos.encoding.EscPosRenderer;
import fi.natroutter.fenpos.encoding.SymbolEncodingException;
import fi.natroutter.fenpos.enums.CutMode;
import fi.natroutter.fenpos.markup.model.Directive;
import fi.natroutter.fenpos.markup.model.Line;
import fi.natroutter.fenpos.markup.model.Span;
import fi.natroutter.fenpos.markup.model.SpanStyle;
import fi.natroutter.fenpos.print.CompiledJob;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.util.ArrayList;
import java.util.List;

/**
 * Turns a job the server compiled into the bytes a printer takes.
 * <p>
 * This is the agent's half of the intermediate representation seam. The server did the work
 * that needs to fail loudly and synchronously — parsing markup, enforcing limits, wrapping to
 * the paper width, checking every character against the codepage — so by the time a job arrives
 * here it is printable or the hardware is broken. What remains is mechanical: map the wire
 * shapes onto the render model and let {@link EscPosRenderer} emit.
 * <p>
 * The mapping exists rather than the renderer reading wire types directly because the two
 * models are deliberately separate. The render model carries a source column used to point at
 * the exact character a codepage rejected, which is meaningful only while parsing markup — a
 * concern that now lives on the server and has no representation on the wire.
 */
public final class IrRenderer {

    /**
     * Source column recorded for spans that came off the wire.
     * <p>
     * Zero rather than a guess: there is no source text on this side to have a column in, and a
     * fabricated number would be worse than an obviously absent one if it ever reached a
     * diagnostic.
     */
    private static final int NO_SOURCE_COLUMN = 0;

    private IrRenderer() {
    }

    /**
     * Renders a dispatched job for a device.
     *
     * @param job      the compiled job, as received
     * @param device   the device it prints on, which supplies the codepage and paper width
     * @param registry this agent's device set, which also holds the images the server synced
     * @return the payload to write to the port
     * @throws ProtocolException when the job carries something this agent cannot render
     */
    public static CompiledJob render(Frames.CompiledJob job, Device device, DeviceRegistry registry)
            throws ProtocolException {
        List<Line> lines = new ArrayList<>(job.lines().size());
        for (Frames.WireLine wire : job.lines()) {
            lines.add(toLine(wire, registry));
        }

        try {
            byte[] payload = EscPosRenderer.render(
                    lines, device.print().codepage(), job.linefeed(), device.print().columns());
            return new CompiledJob(payload, countTextLines(lines));
        } catch (IOException e) {
            // The renderer writes to an in-memory buffer, so this cannot arise from I/O.
            // Surfacing it unchanged would mislabel a genuine bug as a transport failure.
            throw new UncheckedIOException("Rendering to an in-memory buffer failed", e);
        } catch (SymbolEncodingException e) {
            // A symbol encoder refusing its content, which the server's format rules do not
            // catch in every case — a check digit it cannot verify, a symbology whose alphabet
            // is narrower there than here. The job is reported failed with the encoder's own
            // words rather than taking the print thread down with it. Only this one type is
            // caught: an IllegalArgumentException from anywhere else in the renderer is a bug
            // in this agent, and reporting it as a bad job would blame the server for it.
            throw new ProtocolException(e.getMessage(), e);
        }
    }

    private static Line toLine(Frames.WireLine wire, DeviceRegistry registry) throws ProtocolException {
        List<Span> spans = new ArrayList<>(wire.spans().size());
        for (Frames.WireSpan span : wire.spans()) {
            spans.add(new Span(
                    span.text(),
                    new SpanStyle(
                            span.bold(),
                            span.underline(),
                            span.invert(),
                            span.widthMult(),
                            span.heightMult(),
                            span.font()),
                    NO_SOURCE_COLUMN));
        }

        List<Directive> directives = new ArrayList<>(wire.directives().size());
        for (Frames.WireDirective directive : wire.directives()) {
            directives.add(toDirective(directive, registry));
        }

        // A fill is resolved on the server, so a line off the wire never carries one.
        return new Line(wire.align(), null, spans, List.of(), directives);
    }

    /**
     * Maps a wire directive onto the render model.
     * <p>
     * There is no unknown case to reject: {@link FrameCodec#readDirective} is where a type this
     * agent cannot render is refused, and the wire type is sealed, so what reaches here is one
     * of the kinds below. The horizontal rule the markup grammar offers is not among them by design —
     * only the server knows a device's column count at compile time, so it expands the rule to
     * characters and what arrives is text.
     * <p>
     * What can still be wrong is a value: the codec bounds each field against the server's own
     * limits, and the render model bounds them again against what a printer accepts. A server
     * that sends past the second is refused rather than clamped.
     * <p>
     * The two image shapes converge here into one {@link Directive.Image}, because from the
     * renderer's point of view they are the same thing: a rectangle of dots. All that differs is
     * where the dots were — a stored image's came with the configuration, and the rest came with
     * the job.
     */
    private static Directive toDirective(Frames.WireDirective directive, DeviceRegistry registry)
            throws ProtocolException {
        try {
            return switch (directive) {
                case Frames.WireDirective.Cut cut -> new Directive.Cut(cutMode(cut.mode()));
                case Frames.WireDirective.Feed feed -> new Directive.Feed(feed.lines());
                case Frames.WireDirective.Qr qr -> new Directive.Qr(qr.content(), qr.size());
                case Frames.WireDirective.Barcode barcode ->
                        new Directive.Barcode(barcode.system(), barcode.content());
                case Frames.WireDirective.Pdf417 pdf417 ->
                        new Directive.Pdf417(pdf417.content(), pdf417.errorLevel(), pdf417.columns());
                case Frames.WireDirective.Drawer drawer -> new Directive.Drawer(drawer.pin());
                case Frames.WireDirective.StoredImage stored -> synced(stored, registry);
                case Frames.WireDirective.InlineImage inline ->
                        new Directive.Image(inline.widthDots(), inline.heightDots(), inline.packed());
            };
        } catch (IllegalArgumentException e) {
            throw new ProtocolException(e.getMessage());
        }
    }

    /**
     * Finds the dots for an image the server said this agent already holds.
     * <p>
     * It usually does: the rasters arrive with every {@code config.sync}, and a job is only
     * dispatched to an agent the server believes it has configured. The gap is real all the same —
     * an image uploaded while a job was in flight, or one the server had to leave out of a full
     * configuration frame — and the job is then failed by name rather than printed with a blank
     * space where the logo was. A receipt quietly missing its logo is the worse outcome: nobody
     * finds out until a customer is holding it.
     *
     * @param stored   the reference, naming an image and a printed width
     * @param registry this agent's device set, which holds what the server synced
     * @return the image as the renderer takes it
     * @throws ProtocolException when no raster was synced under that name and width
     */
    private static Directive synced(Frames.WireDirective.StoredImage stored, DeviceRegistry registry)
            throws ProtocolException {
        Frames.AssetRaster raster = registry.raster(stored.name(), stored.widthDots())
                .orElseThrow(() -> new ProtocolException("This agent has no image called '"
                        + stored.name() + "' at " + stored.widthDots()
                        + " dots wide; it may not have been synced yet"));

        return new Directive.Image(raster.widthDots(), raster.heightDots(), raster.packed());
    }

    private static Directive.Cut.Mode cutMode(CutMode mode) {
        return switch (mode) {
            case FULL -> Directive.Cut.Mode.FULL;
            case PARTIAL -> Directive.Cut.Mode.PARTIAL;
        };
    }

    /** Counts lines that advance the paper; directive-only lines do not. */
    private static int countTextLines(List<Line> lines) {
        return (int) lines.stream().filter(line -> !line.isDirectiveOnly()).count();
    }
}
