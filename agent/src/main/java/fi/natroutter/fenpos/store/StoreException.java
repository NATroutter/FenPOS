package fi.natroutter.fenpos.store;

/**
 * The agent's local store could not be opened, read or written.
 *
 * <p>Checked rather than unchecked because every caller has a real decision to make: pairing
 * that cannot be persisted must not report success, and a job that cannot be spooled must not
 * be acknowledged. Making the failure invisible would let the agent claim work it has no record
 * of.
 */
public class StoreException extends Exception {

    /**
     * @param message what failed, safe to log
     * @param cause   the underlying failure, preserved for diagnosis
     */
    public StoreException(String message, Throwable cause) {
        super(message, cause);
    }
}
