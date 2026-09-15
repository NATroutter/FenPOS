package fi.natroutter.fenpos.markup;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

/**
 * Reads a whole document into tokens before anything is parsed.
 * <p>
 * A port of {@code fenpos/lib/markup/tokenizer.ts}, and the two must not drift. Every refusal about
 * how markup is written — an unterminated tag, a malformed attribute, a control character — is made
 * here, over the whole document, before any tag means anything. That order is what makes a syntax
 * error on a later line win over a value error on an earlier one, on both sides.
 * <p>
 * The panel's tokenizer also substitutes variables. This agent has none, so a brace is ordinary text,
 * which is what the panel does for a request without variables.
 */
final class MarkupTokenizer {

    /** The escapes the language knows, each with what it stands for. Any other ampersand is text. */
    private static final String[][] ENTITIES = {
            {"&lt;", "<"},
            {"&amp;", "&"},
            {"&lbrace;", "{"},
            {"&quot;", "\""},
    };

    private static final String CONTROL_MESSAGE =
            "Control characters cannot be printed; use markup tags for formatting";

    private static final String UNTERMINATED_MESSAGE = "Unterminated tag; write &lt; for a literal '<'";

    private final String source;
    private final List<MarkupToken> tokens = new ArrayList<>();
    private final StringBuilder pending = new StringBuilder();
    private int index;
    private int line = 1;
    private int lineStart;
    private int pendingColumn = 1;

    private MarkupTokenizer(String source) {
        this.source = source;
    }

    /**
     * Reads a document into tokens.
     *
     * @param source the document, with {@code \r\n} already normalised to {@code \n}
     * @return the tokens in document order
     * @throws MarkupException if the markup is malformed, at the first place it is
     */
    static List<MarkupToken> tokenize(String source) throws MarkupException {
        return new MarkupTokenizer(source).run();
    }

    /**
     * Replaces each entity in an attribute value with the character it stands for.
     * <p>
     * Runs after the value's extent is known, so an entity never decides where a value ends: none of
     * them contains a space, a {@code >} or a {@code "}. Any {@code &} that begins no entity is kept.
     */
    static String decodeEntities(String value) {
        if (value.indexOf('&') < 0) {
            return value;
        }
        StringBuilder decoded = new StringBuilder(value.length());
        int at = 0;
        while (at < value.length()) {
            String[] entity = value.charAt(at) == '&' ? entityAt(value, at) : null;
            if (entity != null) {
                decoded.append(entity[1]);
                at += entity[0].length();
            } else {
                decoded.append(value.charAt(at));
                at++;
            }
        }
        return decoded.toString();
    }

    private static String[] entityAt(String text, int at) {
        for (String[] entity : ENTITIES) {
            if (text.startsWith(entity[0], at)) {
                return entity;
            }
        }
        return null;
    }

    private List<MarkupToken> run() throws MarkupException {
        skipIndentation();
        while (index < source.length()) {
            char current = source.charAt(index);
            if (current == '\n') {
                endLine();
            } else if (current == '<') {
                readTag();
            } else if (current == '&') {
                readEntity();
            } else {
                readText(current);
            }
        }
        flush();
        return List.copyOf(tokens);
    }

    private int column() {
        return index - lineStart + 1;
    }

    private void endLine() {
        flush();
        tokens.add(new MarkupToken.Break(line, column()));
        index++;
        line++;
        lineStart = index;
        skipIndentation();
    }

    /**
     * Skips whitespace between the start of a line and a tag.
     * <p>
     * Indentation is for whoever reads the markup, not for the paper. Only a run that ends at a
     * {@code <} is skipped, so a line that starts with text keeps every space, and a tab before text
     * is still refused as the control character it is.
     */
    private void skipIndentation() {
        int at = index;
        while (at < source.length() && isSpace(source.charAt(at))) {
            at++;
        }
        if (at > index && at < source.length() && source.charAt(at) == '<') {
            index = at;
        }
    }

    private void readText(char current) throws MarkupException {
        if (isControl(current)) {
            throw new MarkupException(MarkupError.CONTROL_CHARACTER, line, column(),
                    String.format("U+%04X", (int) current), CONTROL_MESSAGE);
        }
        if (pending.isEmpty()) {
            pendingColumn = column();
        }
        pending.append(current);
        index++;
    }

    private void flush() {
        if (!pending.isEmpty()) {
            tokens.add(new MarkupToken.Text(pending.toString(), false, line, pendingColumn));
            pending.setLength(0);
        }
    }

    private void readEntity() throws MarkupException {
        String[] entity = entityAt(source, index);
        if (entity == null) {
            readText('&');
            return;
        }
        flush();
        tokens.add(new MarkupToken.Text(entity[1], true, line, column()));
        index += entity[0].length();
    }

    private void readTag() throws MarkupException {
        int start = index;
        int column = column();
        flush();

        // A tag with no `>` left on its line is unterminated, whatever the rest of it looks like, so
        // `<bold x` is reported as the unterminated tag it is rather than as a malformed attribute.
        int terminator = source.indexOf('>', start);
        if (terminator < 0 || terminator > lineEnd()) {
            throw unterminated(start, column);
        }

        int at = start + 1;
        boolean closing = at < source.length() && source.charAt(at) == '/';
        if (closing) {
            at++;
        }

        int nameStart = at;
        while (at < source.length() && isNameChar(source.charAt(at))) {
            at++;
        }
        // Kept as written: a refusal echoes the author's spelling, and resolving a tag ignores case.
        String name = source.substring(nameStart, at);
        if (name.isEmpty()) {
            throw unterminated(start, column);
        }

        if (closing) {
            if (at >= source.length() || source.charAt(at) != '>') {
                throw unterminated(start, column);
            }
            tokens.add(new MarkupToken.Close(name, line, column));
            index = at + 1;
            return;
        }

        List<RawAttribute> attributes = new ArrayList<>();
        while (at < source.length() && source.charAt(at) != '>') {
            char current = source.charAt(at);
            if (current == '\n') {
                throw unterminated(start, column);
            }
            if (isSpace(current)) {
                at++;
                continue;
            }
            int keyColumn = at - lineStart + 1;
            int keyStart = at;
            while (at < source.length() && isNameChar(source.charAt(at))) {
                at++;
            }
            String key = source.substring(keyStart, at).toLowerCase(Locale.ROOT);
            if (key.isEmpty() || at >= source.length() || source.charAt(at) != '=') {
                String shown = key.isEmpty() ? source.substring(keyStart, keyStart + 1) : key;
                throw new MarkupException(MarkupError.UNKNOWN_ATTRIBUTE, line, keyColumn, shown,
                        "<" + name + "> attributes are written key=value");
            }
            at++;
            String value;
            if (at < source.length() && source.charAt(at) == '"') {
                int close = source.indexOf('"', at + 1);
                if (close < 0 || close > lineEnd()) {
                    throw unterminated(start, column);
                }
                value = source.substring(at + 1, close);
                at = close + 1;
            } else {
                int valueStart = at;
                while (at < source.length() && !isSpace(source.charAt(at)) && source.charAt(at) != '>'
                        && source.charAt(at) != '\n') {
                    at++;
                }
                value = source.substring(valueStart, at);
            }
            for (int i = 0; i < value.length(); i++) {
                if (isControl(value.charAt(i))) {
                    throw new MarkupException(MarkupError.CONTROL_CHARACTER, line, keyColumn, key,
                            CONTROL_MESSAGE);
                }
            }
            attributes.add(new RawAttribute(key, decodeEntities(value), keyColumn));
        }
        if (at >= source.length() || source.charAt(at) != '>') {
            throw unterminated(start, column);
        }

        tokens.add(new MarkupToken.Open(name, List.copyOf(attributes), line, column));
        index = at + 1;
    }

    private MarkupException unterminated(int start, int column) {
        return new MarkupException(MarkupError.UNKNOWN_TAG, line, column, source.substring(start, lineEnd()),
                UNTERMINATED_MESSAGE);
    }

    private int lineEnd() {
        int end = source.indexOf('\n', index);
        return end < 0 ? source.length() : end;
    }

    private static boolean isSpace(char value) {
        return value == ' ' || value == '\t';
    }

    private static boolean isNameChar(char value) {
        return (value >= 'a' && value <= 'z') || (value >= 'A' && value <= 'Z')
                || (value >= '0' && value <= '9') || value == '_' || value == '-';
    }

    /**
     * Returns whether a character would be consumed by the printer as a command rather than printed:
     * C0 (tab included, whose effect depends on tab stops the agent does not manage), DEL and C1.
     * {@code \n} is not one; it ends a line.
     */
    private static boolean isControl(char value) {
        return (value < 0x20 && value != '\n') || (value >= 0x7F && value <= 0x9F);
    }
}
