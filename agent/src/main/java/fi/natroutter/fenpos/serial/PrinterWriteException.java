package fi.natroutter.fenpos.serial;

/**
 * Thrown when a payload could not be delivered to a device.
 * <p>
 * A partial write is a failure rather than a warning: half an ESC/POS stream can leave the
 * printer mid-command, so the job is reported failed and the operator can decide whether to
 * reprint.
 */
public class PrinterWriteException extends Exception {

    /**
     * @param message what went wrong, including the device name
     */
    public PrinterWriteException(String message) {
        super(message);
    }

    /**
     * @param message what went wrong, including the device name
     * @param cause   the underlying failure, preserved for diagnosis
     */
    public PrinterWriteException(String message, Throwable cause) {
        super(message, cause);
    }
}
