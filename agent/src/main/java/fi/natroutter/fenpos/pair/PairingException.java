package fi.natroutter.fenpos.pair;

/**
 * A pairing attempt that did not produce a credential.
 * <p>
 * Every message here is written to be read by whoever is standing at the printer, because
 * that is the only person who can act on it. "Connection refused" tells them to check the
 * address; "That pairing code is not valid" tells them to generate a new one.
 */
public class PairingException extends Exception {

    /**
     * @param message what went wrong, phrased for the operator
     */
    public PairingException(String message) {
        super(message);
    }

    /**
     * @param message what went wrong, phrased for the operator
     * @param cause   the underlying failure
     */
    public PairingException(String message, Throwable cause) {
        super(message, cause);
    }
}
