package fi.natroutter.fenpos.util;

/**
 * Renders text this agent did not choose so that it cannot act on whatever reads it.
 *
 * <p>Most foreign strings on this agent are slugs by the time they arrive: {@code FrameCodec}
 * restricts every device and asset name to {@code ^[a-z0-9][a-z0-9_-]*$}, which is exactly what
 * lets the rest of the system interpolate them without thinking. Two are not, and cannot be.
 * A USB device's descriptor strings are chosen by whoever made the device, and the name a
 * pairing reply carries is chosen by whoever answered the request.
 *
 * <p>Two characters are dangerous, and both because of what the logger does with them. A
 * newline forges a log line: {@code FoxLogger} rewrites every one as a line break followed by
 * the level's colour, so a description containing one produces an entry that reads exactly
 * like a real one. A brace forges a colour: {@code TermColor.parse} substitutes {@code {RED}}
 * and thirty-two other tokens anywhere in a message, which is what would let a device name
 * drive real escape sequences at an operator's terminal.
 *
 * <p>Both are neutralised the same way, by replacing the character with its escape. Doubling
 * the brace instead would not work: {@code TermColor.parse} is a plain substring replace, and
 * {@code {{RED}} still contains the token it looks for. Removing the character is what makes
 * the substitution impossible.
 */
public final class Text {

    private Text() {
    }

    /**
     * Returns text safe to put in a log line or write to a terminal.
     *
     * @param value the text, which may be null
     * @return the same text with control characters and opening braces rendered as
     *         {@code \\uXXXX}, or an empty string when {@code value} is null
     */
    public static String safe(String value) {
        if (value == null) {
            return "";
        }
        StringBuilder safe = new StringBuilder(value.length());
        for (int index = 0; index < value.length(); index++) {
            char character = value.charAt(index);
            boolean control = character < 0x20 || character == 0x7F
                    || (character >= 0x80 && character <= 0x9F);
            if (control || character == '{') {
                safe.append(String.format("\\u%04X", (int) character));
            } else {
                safe.append(character);
            }
        }
        return safe.toString();
    }
}
