package fi.natroutter.fenpos.enums;

import lombok.AllArgsConstructor;
import lombok.Getter;

/**
 * State of a device's serial connection.
 * <p>
 * Only {@link #CONNECTED} accepts print jobs. The three failure states are kept distinct
 * rather than collapsed into one because they call for different responses: a missing
 * device usually means an unplugged cable, while a failed open usually means the port is
 * held by another process.
 */
@AllArgsConstructor
@Getter
public enum ConnectionStatus {

    /** The port is open and ready to accept writes. */
    CONNECTED("Connected"),

    /** Closed deliberately, or never opened in this session. */
    DISCONNECTED("Disconnected"),

    /** The configured port is not present; usually an unplugged or renamed device. */
    NO_DEVICE("Device not found"),

    /** The port exists but could not be opened; usually held by another process. */
    FAILED_TO_CONNECT("Connection failed");

    /** Human-readable label for console output and the status endpoint. */
    private final String label;

    /** Returns whether the device can currently accept a print job. */
    public boolean isUsable() {
        return this == CONNECTED;
    }
}
