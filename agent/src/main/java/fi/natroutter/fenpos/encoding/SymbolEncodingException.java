package fi.natroutter.fenpos.encoding;

/**
 * A symbol encoder refused the content it was given.
 *
 * <p>Exists so that callers can tell this apart from a bug in the renderer. Both arrive as
 * unchecked exceptions out of {@link EscPosRenderer}, and both are {@link IllegalArgumentException}
 * at source, but they mean opposite things: this one says the job asked for something no barcode
 * of that symbology can express, and belongs in front of whoever wrote the markup. A plain
 * {@code IllegalArgumentException} from anywhere else in the renderer says this code is wrong,
 * and must keep its stack trace and reach a log rather than being reported as a bad job.
 *
 * <p>Unchecked because the console print path shares this renderer and cannot produce a symbol
 * at all, so a checked exception would make every caller handle a case only one of them has.
 */
public class SymbolEncodingException extends RuntimeException {

    /**
     * @param message the encoder's own account of what it could not encode
     * @param cause   the encoder's exception, kept for the local log
     */
    public SymbolEncodingException(String message, Throwable cause) {
        super(message, cause);
    }
}
