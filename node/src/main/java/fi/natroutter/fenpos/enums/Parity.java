package fi.natroutter.fenpos.enums;

import com.fazecast.jSerialComm.SerialPort;
import lombok.AllArgsConstructor;
import lombok.Getter;

/**
 * Serial port parity modes, mapping each constant to the corresponding
 * jSerialComm {@code SerialPort} constant via {@code bit}.
 */
@Getter
@AllArgsConstructor
public enum Parity {

    /** No parity bit. The default for ESC/POS printers. */
    NONE(SerialPort.NO_PARITY),
    /** Odd parity. */
    ODD(SerialPort.ODD_PARITY),
    /** Even parity. */
    EVEN(SerialPort.EVEN_PARITY),
    /** Mark parity (parity bit always 1). */
    MARK(SerialPort.MARK_PARITY),
    /** Space parity (parity bit always 0). */
    SPACE(SerialPort.SPACE_PARITY);

    /** The jSerialComm integer constant to pass to {@link SerialPort#setParity}. */
    final int bit;
}
