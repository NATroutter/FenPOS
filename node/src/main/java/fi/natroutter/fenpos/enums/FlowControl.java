package fi.natroutter.fenpos.enums;

import com.fazecast.jSerialComm.SerialPort;
import lombok.AllArgsConstructor;
import lombok.Getter;

/**
 * Serial port flow-control modes, mapping each constant to the corresponding
 * jSerialComm {@code SerialPort} constant via {@code bit}.
 */
@AllArgsConstructor
@Getter
public enum FlowControl {

    /**
     * No flow control. Safe for short bursts, but a printer with a small input buffer can
     * drop bytes from a long receipt; use {@link #DTR} or {@link #XONXOFF_OUT} if the
     * hardware supports it.
     */
    NONE(SerialPort.FLOW_CONTROL_DISABLED),
    /** RTS (Request To Send) hardware flow control. */
    RTS(SerialPort.FLOW_CONTROL_RTS_ENABLED),
    /** CTS (Clear To Send) hardware flow control. */
    CTS(SerialPort.FLOW_CONTROL_CTS_ENABLED),
    /** DSR (Data Set Ready) hardware flow control. */
    DSR(SerialPort.FLOW_CONTROL_DSR_ENABLED),
    /** DTR (Data Terminal Ready) hardware flow control. */
    DTR(SerialPort.FLOW_CONTROL_DTR_ENABLED),
    /** XON/XOFF software flow control for incoming data. */
    XONXOFF_IN(SerialPort.FLOW_CONTROL_XONXOFF_IN_ENABLED),
    /** XON/XOFF software flow control for outgoing data. */
    XONXOFF_OUT(SerialPort.FLOW_CONTROL_XONXOFF_OUT_ENABLED);

    /** The jSerialComm integer constant to pass to {@link SerialPort#setFlowControl}. */
    final int bit;
}
