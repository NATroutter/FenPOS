package fi.natroutter.fenpos.encoding;

import fi.natroutter.fenpos.enums.Codepage;
import fi.natroutter.fenpos.enums.UnsupportedPolicy;
import fi.natroutter.fenpos.markup.model.Line;
import fi.natroutter.fenpos.markup.model.Span;

import java.nio.charset.CharsetEncoder;
import java.util.ArrayList;
import java.util.List;

/**
 * Checks that every character of a line can be represented in the device's codepage.
 * <p>
 * A printer interprets each byte through one single-byte table, so Unicode text has to be
 * narrowed to that table before it can be sent. This runs before any text reaches the
 * renderer, because the underlying library encodes with {@code String.getBytes}, which
 * silently substitutes {@code ?} and cannot report which character was lost. Checking here
 * with a {@link CharsetEncoder} is what makes an exact
 * {@code unsupported_character} error possible.
 */
public final class CharsetValidator {

    /** Stand-in emitted by {@link UnsupportedPolicy#REPLACE}. */
    private static final char REPLACEMENT = '?';

    private CharsetValidator() {
    }

    /**
     * Applies the device's unsupported-character policy to a line.
     *
     * @param line     the parsed line
     * @param codepage the table the printer will be switched to
     * @param policy   what to do with a character the table cannot represent
     * @return the line, with substitutions applied when the policy is not to reject
     * @throws UnsupportedCharacterException if the policy is to reject and a character
     *                                       cannot be represented
     */
    public static Line validate(Line line, Codepage codepage, UnsupportedPolicy policy)
            throws UnsupportedCharacterException {
        CharsetEncoder encoder = codepage.charset().newEncoder();

        List<Span> converted = new ArrayList<>(line.spans().size());
        for (Span span : line.spans()) {
            String text = convert(span, encoder, codepage, policy);
            // A span stripped down to nothing is dropped rather than kept as an empty run,
            // so later stages never have to reason about zero-width spans.
            if (!text.isEmpty()) {
                converted.add(span.withText(text));
            }
        }

        return new Line(line.align(), line.wrap(), converted, line.directives());
    }

    /**
     * Applies the policy to one span's text.
     *
     * @return the resulting text, which is the original instance when nothing changed
     * @throws UnsupportedCharacterException under {@link UnsupportedPolicy#REJECT}
     */
    private static String convert(Span span,
                                  CharsetEncoder encoder,
                                  Codepage codepage,
                                  UnsupportedPolicy policy) throws UnsupportedCharacterException {
        String text = span.text();

        // Left null until the first unrepresentable character, so text that needs no
        // conversion — the overwhelmingly common case — allocates nothing.
        StringBuilder rewritten = null;

        int offset = 0;
        while (offset < text.length()) {
            int codePoint = text.codePointAt(offset);
            int width = Character.charCount(codePoint);
            String character = text.substring(offset, offset + width);

            if (encoder.canEncode(character)) {
                if (rewritten != null) {
                    rewritten.append(character);
                }
            } else {
                if (policy == UnsupportedPolicy.REJECT) {
                    throw new UnsupportedCharacterException(
                            character, span.columnAt(offset), codepage);
                }
                if (rewritten == null) {
                    rewritten = new StringBuilder(text.substring(0, offset));
                }
                if (policy == UnsupportedPolicy.REPLACE) {
                    rewritten.append(REPLACEMENT);
                }
            }
            offset += width;
        }

        return rewritten == null ? text : rewritten.toString();
    }
}
