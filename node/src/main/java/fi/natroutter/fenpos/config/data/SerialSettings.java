package fi.natroutter.fenpos.config.data;

import fi.natroutter.fenpos.enums.FlowControl;
import fi.natroutter.fenpos.enums.Parity;

import java.time.Duration;

/**
 * Fully resolved serial port settings for one device.
 * <p>
 * This is everything the serial layer needs and nothing else, so that layer never sees
 * printing or HTTP concerns.
 *
 * @param port            OS port name, such as {@code COM3} or {@code /dev/ttyUSB0}
 * @param baudRate        signalling rate
 * @param dataBits        bits per character
 * @param stopBits        stop bits per character
 * @param parity          parity mode
 * @param flowControl     flow control mode
 * @param autoConnect     whether to open this port during startup
 * @param autoReconnect   whether to keep retrying after the device disappears
 * @param reconnectDelay  wait between reconnect attempts
 * @param writeTimeout    how long one write may take before the job is failed; without this
 *                        a wedged printer would hold its worker thread forever
 */
public record SerialSettings(
        String port,
        int baudRate,
        int dataBits,
        int stopBits,
        Parity parity,
        FlowControl flowControl,
        boolean autoConnect,
        boolean autoReconnect,
        Duration reconnectDelay,
        Duration writeTimeout) {
}
