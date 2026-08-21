package fi.natroutter.fenpos.print;

import fi.natroutter.fenpos.enums.Codepage;

/**
 * Thrown when a print request cannot be turned into a printable payload.
 * <p>
 * Carries the stable machine-readable code clients branch on, a human-readable message, and —
 * where the problem has a position — the line, column and offending character.
 * <p>
 * <b>No HTTP status.</b> This agent serves no HTTP: its callers are the console commands and
 * {@code LinkDispatcher}, which report {@link #apiCode()} and the message as text. A status field
 * was carried here from the single-machine daemon that did serve HTTP, hardcoded to 400 at every
 * factory method, and read by nothing. Statuses are the server's to decide — it maps a code to one
 * through {@code API_ERROR_STATUS} in {@code fenpos/lib/errors.ts}, where the mapping is one table
 * rather than a literal at each throw site, and where the content codes are 422 rather than the 400
 * the field here claimed.
 */
public class PrintRequestException extends Exception {

    private final String apiCode;
    private final Integer line;
    private final Integer column;
    private final String character;
    private final String codepage;

    private PrintRequestException(String apiCode,
                                  String message,
                                  Integer line,
                                  Integer column,
                                  String character,
                                  String codepage) {
        super(message);
        this.apiCode = apiCode;
        this.line = line;
        this.column = column;
        this.character = character;
        this.codepage = codepage;
    }

    /**
     * A problem with the request as a whole, with no position in the {@code data} array.
     *
     * @param apiCode stable code for the {@code error} field
     * @param message human-readable explanation
     */
    public static PrintRequestException of(String apiCode, String message) {
        return new PrintRequestException(apiCode, message, null, null, null, null);
    }

    /**
     * A problem attributable to one element of the {@code data} array.
     *
     * @param line 1-based index into {@code data}
     */
    public static PrintRequestException atLine(String apiCode, int line, String message) {
        return new PrintRequestException(apiCode, message, line, null, null, null);
    }

    /**
     * A problem attributable to one character.
     *
     * @param line   1-based index into {@code data}
     * @param column 1-based column within that element
     */
    public static PrintRequestException at(String apiCode, int line, int column, String message) {
        return new PrintRequestException(apiCode, message, line, column, null, null);
    }

    /**
     * A character the device's codepage cannot represent.
     *
     * @param character the whole offending character, surrogate pairs included
     */
    public static PrintRequestException unsupportedCharacter(int line,
                                                             int column,
                                                             String character,
                                                             Codepage codepage,
                                                             String message) {
        return new PrintRequestException("unsupported_character", message,
                line, column, character, codepage.name());
    }

    /** Returns the stable code for the response's {@code error} field. */
    public String apiCode() {
        return apiCode;
    }

    /** Returns the 1-based index into {@code data}, or {@code null} if not positional. */
    public Integer line() {
        return line;
    }

    /** Returns the 1-based column within the element, or {@code null} if not positional. */
    public Integer column() {
        return column;
    }

    /** Returns the offending character, or {@code null} if not applicable. */
    public String character() {
        return character;
    }

    /** Returns the codepage name, or {@code null} if not applicable. */
    public String codepage() {
        return codepage;
    }
}
