package fi.natroutter.fenpos.link;

import fi.natroutter.fenpos.device.Device;
import fi.natroutter.fenpos.encoding.EscPosRenderer;
import fi.natroutter.fenpos.markup.model.Directive;
import fi.natroutter.fenpos.markup.model.Line;
import fi.natroutter.fenpos.markup.model.Span;
import fi.natroutter.fenpos.markup.model.SpanStyle;
import fi.natroutter.fenpos.print.CompiledJob;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

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
     * @param job    the compiled job, as received
     * @param device the device it prints on, which supplies the codepage and paper width
     * @return the payload to write to the port
     * @throws ProtocolException when the job carries something this agent cannot render
     */
    public static CompiledJob render(Frames.CompiledJob job, Device device)
            throws ProtocolException {
        List<Line> lines = new ArrayList<>(job.lines().size());
        for (Frames.WireLine wire : job.lines()) {
            lines.add(toLine(wire));
        }

        try {
            byte[] payload = EscPosRenderer.render(
                    lines, device.print().codepage(), job.linefeed(), device.print().columns());
            return new CompiledJob(payload, countTextLines(lines));
        } catch (IOException e) {
            // The renderer writes to an in-memory buffer, so this cannot arise from I/O.
            // Surfacing it unchanged would mislabel a genuine bug as a transport failure.
            throw new UncheckedIOException("Rendering to an in-memory buffer failed", e);
        }
    }

    private static Line toLine(Frames.WireLine wire) throws ProtocolException {
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
            directives.add(toDirective(directive));
        }

        return new Line(wire.align(), null, spans, directives);
    }

    /**
     * Maps a wire directive onto the render model.
     * <p>
     * The horizontal rule the markup grammar offers is absent here by design: only the server
     * knows a device's column count at compile time, so it expands the rule to characters and
     * what arrives is text. A rule appearing on the wire would mean the two sides disagree
     * about that, which is worth refusing rather than rendering as nothing.
     */
    private static Directive toDirective(Frames.WireDirective directive) throws ProtocolException {
        String type = directive.type() == null
                ? ""
                : directive.type().toUpperCase(Locale.ROOT);

        return switch (type) {
            case "CUT" -> new Directive.Cut(cutMode(directive.mode()));
            case "FEED" -> feed(directive.lines());
            default -> throw new ProtocolException("unknown directive type '" + directive.type() + "'");
        };
    }

    private static Directive.Cut.Mode cutMode(String mode) throws ProtocolException {
        String value = mode == null ? "" : mode.toUpperCase(Locale.ROOT);
        return switch (value) {
            case "FULL" -> Directive.Cut.Mode.FULL;
            case "PARTIAL" -> Directive.Cut.Mode.PARTIAL;
            default -> throw new ProtocolException("unknown cut mode '" + mode + "'");
        };
    }

    private static Directive feed(Integer lines) throws ProtocolException {
        if (lines == null) {
            throw new ProtocolException("a FEED directive carried no line count");
        }
        try {
            return new Directive.Feed(lines);
        } catch (IllegalArgumentException e) {
            // The bound is the render model's, and it is the authority on what the printer can
            // be asked to do. A server that sends past it is refused rather than clamped.
            throw new ProtocolException(e.getMessage());
        }
    }

    /** Counts lines that advance the paper; directive-only lines do not. */
    private static int countTextLines(List<Line> lines) {
        return (int) lines.stream().filter(line -> !line.isDirectiveOnly()).count();
    }
}
