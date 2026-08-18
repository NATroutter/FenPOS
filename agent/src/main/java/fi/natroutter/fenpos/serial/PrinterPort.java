package fi.natroutter.fenpos.serial;

import fi.natroutter.fenpos.enums.ConnectionStatus;

/**
 * A destination that accepts a rendered ESC/POS payload.
 * <p>
 * This interface is the seam between the print queue and the hardware. The queue depends on
 * it rather than on {@link SerialHandler}, so queue behaviour — ordering, capacity, failure
 * handling, timeouts — can be tested end to end against a fake with no serial port
 * attached, on any machine, deterministically.
 */
public interface PrinterPort {

    /** Returns the configured device name, for logging and job records. */
    String deviceName();

    /** Returns the current connection state. */
    ConnectionStatus status();

    /** Returns whether the port can accept a write right now. */
    default boolean isOpen() {
        return status().isUsable();
    }

    /**
     * Writes a complete payload to the device.
     * <p>
     * Implementations must not return until the bytes have been handed to the device or the
     * attempt has failed: the queue treats a normal return as proof the job printed.
     *
     * @param payload the rendered ESC/POS bytes
     * @throws PrinterWriteException if the port is closed, the write times out, or fewer
     *                               bytes are accepted than were offered
     */
    void write(byte[] payload) throws PrinterWriteException;
}
