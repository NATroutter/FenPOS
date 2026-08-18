package fi.natroutter.fenpos.print;

import fi.natroutter.fenpos.enums.Codepage;

/**
 * Thrown when a print request cannot be turned into a printable payload.
 * <p>
 * Carries everything the HTTP layer needs to build the error response, without depending on
 * that layer: the stable machine-readable code clients branch on, a human-readable message,
 * and — where the problem has a position — the line, column and offending character.
 * <p>
 * The status code lives here too because only the compile stage knows whether a failure is
 * the caller's fault, an oversized payload, or a limit being exceeded.
 */
public class PrintRequestException extends Exception {

    private final String apiCode;
    private final int status;
    private final Integer line;
    private final Integer column;
    private final String character;
    private final String codepage;

    private PrintRequestException(String apiCode,
                                  int status,
                                  String message,
                                  Integer line,
                                  Integer column,
                                  String character,
                                  String codepage) {
        super(message);
        this.apiCode = apiCode;
        this.status = status;
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
        return new PrintRequestException(apiCode, 400, message, null, null, null, null);
    }

    /**
     * A problem with the request as a whole, reported with a status other than 400.
     *
     * @param status HTTP status to return, such as 413 for an oversized body
     */
    public static PrintRequestException of(String apiCode, int status, String message) {
        return new PrintRequestException(apiCode, status, message, null, null, null, null);
    }

    /**
     * A problem attributable to one element of the {@code data} array.
     *
     * @param line 1-based index into {@code data}
     */
    public static PrintRequestException atLine(String apiCode, int line, String message) {
        return new PrintRequestException(apiCode, 400, message, line, null, null, null);
    }

    /**
     * A problem attributable to one character.
     *
     * @param line   1-based index into {@code data}
     * @param column 1-based column within that element
     */
    public static PrintRequestException at(String apiCode, int line, int column, String message) {
        return new PrintRequestException(apiCode, 400, message, line, column, null, null);
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
        return new PrintRequestException("unsupported_character", 400, message,
                line, column, character, codepage.name());
    }

    /** Returns the stable code for the response's {@code error} field. */
    public String apiCode() {
        return apiCode;
    }

    /** Returns the HTTP status to respond with. */
    public int status() {
        return status;
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
