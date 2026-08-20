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
 * <p>Unchecked because it can arise from anywhere a symbol is written, and a checked exception
 * would push the handling onto every caller of the renderer rather than onto the two that turn it
 * into an answer: {@code IrRenderer} fails the dispatched job, and {@code PrintCompiler} refuses
 * the console's request with {@code invalid_tag_argument}.
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
