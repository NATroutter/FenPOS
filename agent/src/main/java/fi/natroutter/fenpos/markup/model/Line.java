package fi.natroutter.fenpos.markup.model;

import fi.natroutter.fenpos.enums.Align;

import java.util.List;

/**
 * One printed line: styled text plus any printer actions attached to it.
 * <p>
 * Produced by the parser from a single element of the request's {@code data} array, and
 * possibly split into several lines by the wrapper. Alignment sits here rather than on a
 * span because ESC/POS justifies whole lines.
 *
 * @param align       justification for the whole line
 * @param wrap        whether this line is broken to the paper width; null defers to the device setting
 * @param spans       styled text, in printing order; empty for a directive-only line
 * @param directives  actions emitted after the text, in the order they appeared
 */
public record Line(Align align, Boolean wrap, List<Span> spans, List<Directive> directives) {

    public Line {
        if (align == null) {
            throw new IllegalArgumentException("align must not be null");
        }
        spans = List.copyOf(spans);
        directives = List.copyOf(directives);
    }

    /** Returns an empty left-aligned line, which prints as a blank line feed. */
    public static Line empty() {
        return new Line(Align.LEFT, null, List.of(), List.of());
    }

    /**
     * Returns {@code true} when this line carries only printer actions.
     * <p>
     * Such a line must not emit a line feed: {@code "<cut>"} should cut the paper, not also
     * advance a blank line before doing so.
     */
    public boolean isDirectiveOnly() {
        return spans.isEmpty() && !directives.isEmpty();
    }

    /** Returns the printed width of the text on this line, in character columns. */
    public int columns() {
        return spans.stream().mapToInt(Span::columns).sum();
    }

    /** Returns the visible text with all styling discarded, for logging and diagnostics. */
    public String plainText() {
        StringBuilder text = new StringBuilder();
        spans.forEach(span -> text.append(span.text()));
        return text.toString();
    }
}
