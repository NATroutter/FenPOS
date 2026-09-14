package fi.natroutter.fenpos.markup;

/**
 * Thrown when a {@code data} document cannot be parsed.
 * <p>
 * Carries the 1-based line of the document and the column within that line, so the caller
 * can tell a client exactly where to look. Both are known directly: the parser reads the
 * whole document in one pass and counts lines as it goes, rather than being handed one line
 * at a time by a caller that would otherwise have to supply the number itself.
 */
public class MarkupException extends Exception {

    private final MarkupError error;
    private final int line;
    private final int column;
    private final String detail;

    /**
     * @param error   what kind of problem this is
     * @param line    1-based line of the document on which the problem starts
     * @param column  1-based character position within that line where it starts
     * @param detail  the offending token or character, for inclusion in the API response;
     *                may be {@code null} when the error needs no further identification
     * @param message human-readable explanation
     */
    public MarkupException(MarkupError error, int line, int column, String detail, String message) {
        super(message);
        this.error = error;
        this.line = line;
        this.column = column;
        this.detail = detail;
    }

    /** Returns what kind of problem this is. */
    public MarkupError error() {
        return error;
    }

    /** Returns the 1-based line of the document on which the problem starts. */
    public int line() {
        return line;
    }

    /** Returns the 1-based column within that line where the problem starts. */
    public int column() {
        return column;
    }

    /** Returns the offending token or character, or {@code null} if not applicable. */
    public String detail() {
        return detail;
    }
}
