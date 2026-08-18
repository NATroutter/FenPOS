package fi.natroutter.fenpos.markup.model;

/**
 * A run of characters sharing one style.
 *
 * @param text         the characters, with entities already decoded and no markup remaining
 * @param style        the style applying to every character in {@link #text()}
 * @param sourceColumn 1-based column in the original element where {@link #text()} begins
 */
public record Span(String text, SpanStyle style, int sourceColumn) {

    public Span {
        if (text == null) {
            throw new IllegalArgumentException("text must not be null");
        }
        if (style == null) {
            throw new IllegalArgumentException("style must not be null");
        }
    }

    /**
     * Returns the 1-based source column of the character at {@code offset} within this span.
     * <p>
     * Exact only while the span is as the parser produced it: the parser starts a new span
     * at every entity, so a span's characters are always contiguous in the source. After
     * wrapping has split spans the value becomes approximate, which is acceptable because
     * every error that reports a column is raised before wrapping runs.
     *
     * @param offset 0-based index into {@link #text()}
     * @return the corresponding 1-based column in the original element
     */
    public int columnAt(int offset) {
        return sourceColumn + offset;
    }

    /**
     * Returns the printed width of this span in character columns.
     * <p>
     * Double-width text occupies two columns per character, so this is what wrapping must
     * measure rather than {@code text.length()}.
     *
     * @return the number of columns this span occupies when printed
     */
    public int columns() {
        return text.length() * style.widthMult();
    }

    /** Returns a copy of this span carrying different text, keeping style and provenance. */
    public Span withText(String replacement) {
        return new Span(replacement, style, sourceColumn);
    }
}
