package fi.natroutter.fenpos.markup.model;

import fi.natroutter.fenpos.enums.Font;

/**
 * The complete visual style of a run of characters, with every markup tag already resolved.
 * <p>
 * A span carries its finished style rather than a position in a tag stack. That is what
 * lets the wrapper measure width without interpreting markup — it multiplies character
 * count by {@link #widthMult()} — and lets the renderer emit only the differences between
 * one span and the next.
 *
 * @param bold        emphasis
 * @param underline   underline thickness: 0 for none, 1 or 2 for the printer's two weights
 * @param invert      white on black
 * @param widthMult   horizontal character multiplier, 1 to 8
 * @param heightMult  vertical character multiplier, 1 to 8
 * @param font        built-in font selection
 */
public record SpanStyle(
        boolean bold,
        int underline,
        boolean invert,
        int widthMult,
        int heightMult,
        Font font) {

    /** Unstyled text: the state a line starts and ends in. */
    public static final SpanStyle PLAIN = new SpanStyle(false, 0, false, 1, 1, Font.A);

    public SpanStyle {
        if (underline < 0 || underline > 2) {
            throw new IllegalArgumentException("underline must be 0..2, got " + underline);
        }
        if (widthMult < 1 || widthMult > 8) {
            throw new IllegalArgumentException("widthMult must be 1..8, got " + widthMult);
        }
        if (heightMult < 1 || heightMult > 8) {
            throw new IllegalArgumentException("heightMult must be 1..8, got " + heightMult);
        }
    }

    /** Returns a copy with emphasis set. */
    public SpanStyle withBold(boolean value) {
        return new SpanStyle(value, underline, invert, widthMult, heightMult, font);
    }

    /** Returns a copy with the given underline thickness. */
    public SpanStyle withUnderline(int thickness) {
        return new SpanStyle(bold, thickness, invert, widthMult, heightMult, font);
    }

    /** Returns a copy with inversion set. */
    public SpanStyle withInvert(boolean value) {
        return new SpanStyle(bold, underline, value, widthMult, heightMult, font);
    }

    /** Returns a copy with the given character multipliers. */
    public SpanStyle withSize(int width, int height) {
        return new SpanStyle(bold, underline, invert, width, height, font);
    }

    /** Returns a copy using the given font. */
    public SpanStyle withFont(Font value) {
        return new SpanStyle(bold, underline, invert, widthMult, heightMult, value);
    }
}
