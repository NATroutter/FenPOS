package fi.natroutter.fenpos.link;

/**
 * A frame could not be understood.
 *
 * <p>Thrown rather than returned because a caller cannot sensibly continue with a frame it
 * failed to parse. Callers on the receive path catch it, log it, and keep the connection open:
 * one malformed frame must not take a working printer offline.
 */
public class ProtocolException extends Exception {

    /**
     * @param message what was wrong with the frame, safe to log
     */
    public ProtocolException(String message) {
        super(message);
    }

    /**
     * @param message what was wrong with the frame, safe to log
     * @param cause   the underlying parse failure, preserved for diagnosis
     */
    public ProtocolException(String message, Throwable cause) {
        super(message, cause);
    }
}
