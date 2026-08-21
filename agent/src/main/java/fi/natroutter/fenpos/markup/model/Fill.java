package fi.natroutter.fenpos.markup.model;

/**
 * A pad, waiting for the column count that decides how wide it is.
 * <p>
 * The only member of this model that describes an instruction rather than something printed:
 * {@code FillResolver} replaces it with the span it stands for, and every line from the wrapper
 * onward carries none.
 * <p>
 * Mirrors {@code Fill} in {@code fenpos/lib/markup/model.ts}.
 *
 * @param afterSpans   how many spans precede it; an index into a list {@code CharsetValidator}
 *                     rewrites when it drops a span stripped to nothing
 * @param character    the character to repeat, as exactly one code point
 * @param style        the style in effect where the tag was written
 * @param sourceColumn 1-based column in the original element where the tag was written
 */
public record Fill(int afterSpans, String character, SpanStyle style, int sourceColumn) {

    public Fill {
        if (character == null || character.codePointCount(0, character.length()) != 1) {
            throw new IllegalArgumentException("character must be exactly one code point");
        }
        if (style == null) {
            throw new IllegalArgumentException("style must not be null");
        }
    }

    /** Returns a copy carrying a different character, keeping position and style. */
    public Fill withCharacter(String replacement) {
        return new Fill(afterSpans, replacement, style, sourceColumn);
    }

    /** Returns a copy sitting after a different number of spans, keeping everything else. */
    public Fill withAfterSpans(int replacement) {
        return new Fill(replacement, character, style, sourceColumn);
    }
}
