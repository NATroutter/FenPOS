package fi.natroutter.fenpos.markup;

/**
 * Thrown when a {@code data} element cannot be parsed.
 * <p>
 * Carries the column where the problem starts so the caller can tell a client exactly where
 * to look. The line number is deliberately absent: the parser handles one element at a time
 * and does not know its index in the request, so the compile pipeline supplies it.
 */
public class MarkupException extends Exception {

    private final MarkupError error;
    private final int column;
    private final String detail;

    /**
     * @param error   what kind of problem this is
     * @param column  1-based character position within the element where it starts
     * @param detail  the offending token or character, for inclusion in the API response;
     *                may be {@code null} when the error needs no further identification
     * @param message human-readable explanation
     */
    public MarkupException(MarkupError error, int column, String detail, String message) {
        super(message);
        this.error = error;
        this.column = column;
        this.detail = detail;
    }

    /** Returns what kind of problem this is. */
    public MarkupError error() {
        return error;
    }

    /** Returns the 1-based column within the element where the problem starts. */
    public int column() {
        return column;
    }

    /** Returns the offending token or character, or {@code null} if not applicable. */
    public String detail() {
        return detail;
    }
}
