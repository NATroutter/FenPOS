package fi.natroutter.fenpos.http;

import fi.natroutter.fenpos.print.PrintRequestException;

/**
 * The single error shape returned by every non-2xx response.
 * <p>
 * Clients branch on {@link #error()} alone; it is a stable identifier and part of the API
 * contract. {@link #message()} is for humans and may be reworded at any time.
 * <p>
 * Positional fields are populated only when they mean something. Gson omits null fields, so
 * an error with no position simply has no {@code line} or {@code column} rather than
 * carrying misleading zeroes.
 *
 * @param error     stable machine-readable code
 * @param message   human-readable explanation
 * @param line      1-based index into the request's {@code data} array, when applicable
 * @param column    1-based column within that element, when applicable
 * @param character the offending character, when applicable
 * @param codepage  the codepage that could not represent it, when applicable
 */
public record ApiError(
        String error,
        String message,
        Integer line,
        Integer column,
        String character,
        String codepage) {

    /**
     * Builds an error with no position.
     *
     * @param error   stable machine-readable code
     * @param message human-readable explanation
     */
    public static ApiError of(String error, String message) {
        return new ApiError(error, message, null, null, null, null);
    }

    /**
     * Builds an error from a compile failure, carrying whatever position it knows.
     *
     * @param failure the compile failure
     */
    public static ApiError from(PrintRequestException failure) {
        return new ApiError(
                failure.apiCode(),
                failure.getMessage(),
                failure.line(),
                failure.column(),
                failure.character(),
                failure.codepage());
    }
}
