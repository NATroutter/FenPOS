package fi.natroutter.fenpos.serial;

import com.fazecast.jSerialComm.SerialPort;
import com.fazecast.jSerialComm.SerialPortInvalidPortException;
import fi.natroutter.foxlib.logger.FoxLogger;
import fi.natroutter.fenpos.device.SerialSettings;
import fi.natroutter.fenpos.enums.ConnectionStatus;

import java.util.Arrays;
import java.util.List;
import java.util.Objects;
import java.util.concurrent.locks.ReentrantLock;

/**
 * Owns the serial port for one printer: opening it, writing to it, and reopening it when
 * the device disappears.
 * <p>
 * A receipt printer is write-only for the agent's purposes, so unlike a general serial
 * device there is no read loop; nothing the printer sends back is interpreted.
 * <p>
 * <strong>Threading.</strong> {@link #write(byte[])} is called by the device's single queue
 * worker, while {@link #connect()} and {@link #disconnect()} can arrive from the console at
 * any moment. All three take the same lock, so the port cannot be closed midway through a
 * write — which would leave the printer holding half an ESC/POS command. {@code status} is
 * volatile so status queries never block behind a slow write.
 */
public class SerialHandler implements PrinterPort {

    private final String name;
    private final SerialSettings serial;
    private final FoxLogger logger;

    /** Guards every operation on {@link #port}, including the write itself. */
    private final ReentrantLock lock = new ReentrantLock();

    private volatile ConnectionStatus status = ConnectionStatus.DISCONNECTED;

    /** Set once {@link #shutdown()} runs; suppresses reconnect attempts during exit. */
    private volatile boolean shuttingDown;

    private SerialPort port;
    private volatile Thread reconnectThread;

    /**
     * How many absent-port attempts pass between warnings.
     *
     * <p>Every attempt used to warn. At the protocol's minimum reconnect delay of one second that
     * is a line a second for as long as a printer stays unplugged, which fills the log volume and
     * buries everything else in it. Going silent is worse, though: a retry loop that says nothing
     * reads exactly like one that died, which is the reason the first version reported every
     * attempt. So the first is reported, and then one in sixty, each carrying the count.
     */
    private static final int ABSENT_PORT_LOG_INTERVAL = 60;

    /** Attempts since this device's port was last seen, for the log interval above. */
    private int absentAttempts;

    /**
     * Identity of the device this handler last opened successfully, captured rather than
     * configured. On reconnect it distinguishes the printer coming back from a different
     * device having taken over the same port name, which on Linux is routine after a
     * reboot.
     */
    private volatile DeviceIdentity knownIdentity;

    /**
     * @param name   the device name this printer answers to
     * @param serial the serial settings the server pushed for it
     * @param logger logger for connection lifecycle messages
     */
    public SerialHandler(String name, SerialSettings serial, FoxLogger logger) {
        this.name = Objects.requireNonNull(name, "name");
        this.serial = Objects.requireNonNull(serial, "serial");
        this.logger = Objects.requireNonNull(logger, "logger");
    }

    @Override
    public String deviceName() {
        return name;
    }

    /** Returns the serial settings this handler was created for. */
    public SerialSettings serial() {
        return serial;
    }

    @Override
    public ConnectionStatus status() {
        return status;
    }

    // -------------------------------------------------------------------------
    // Lifecycle
    // -------------------------------------------------------------------------

    /**
     * Opens the configured port. Does nothing if it is already open.
     * <p>
     * Failure is reported through {@link #status()} rather than by throwing: connecting is
     * routinely attempted against hardware that is not present, and a background reconnect
     * has nowhere to propagate an exception to.
     */
    public void connect() {
        lock.lock();
        try {
            if (status.isUsable()) {
                return;
            }
            if (!isReportedByTheSystem(serial.port())) {
                // The path comes from the server, and jSerialComm opens whatever it is given.
                // On Linux that includes a tty: /dev/tty is the process's own terminal, which
                // both compose files provide, so an unchecked path is a way for a config.sync
                // to write ESC/POS bytes at whoever is attached. The panel builds its picker
                // from a scan, so a real configuration always names something in this list, and
                // isExpectedDevice already walks it on every reconnect.
                status = ConnectionStatus.NO_DEVICE;
                logger.error("[" + deviceName() + "] No such port: " + serial.port());
                return;
            }
            SerialPort candidate;
            try {
                candidate = SerialPort.getCommPort(serial.port());
            } catch (SerialPortInvalidPortException e) {
                status = ConnectionStatus.NO_DEVICE;
                logger.error("[" + deviceName() + "] No such port: " + serial.port());
                return;
            }

            configure(candidate, serial);

            if (!candidate.openPort()) {
                status = ConnectionStatus.FAILED_TO_CONNECT;
                logger.error("[" + deviceName() + "] Could not open " + serial.port()
                        + "; it may be in use by another process");
                return;
            }

            port = candidate;
            knownIdentity = DeviceIdentity.of(candidate);
            status = ConnectionStatus.CONNECTED;
            absentAttempts = 0;
            logger.info("[" + deviceName() + "] Connected to " + serial.port());
        } finally {
            lock.unlock();
        }
    }

    /** Closes the port. Does nothing if it is not open. */
    public void disconnect() {
        lock.lock();
        try {
            closePort();
            status = ConnectionStatus.DISCONNECTED;
            logger.info("[" + deviceName() + "] Disconnected");
        } finally {
            lock.unlock();
        }
    }

    /**
     * Closes the port permanently and stops any reconnect attempts.
     * <p>
     * Called once during shutdown. Unlike {@link #disconnect()} this cannot be undone by a
     * reconnect already in flight.
     */
    public void shutdown() {
        shuttingDown = true;
        Thread reconnect = reconnectThread;
        if (reconnect != null) {
            reconnect.interrupt();
        }
        lock.lock();
        try {
            closePort();
            status = ConnectionStatus.DISCONNECTED;
        } finally {
            lock.unlock();
        }
    }

    private void configure(SerialPort target, SerialSettings serial) {
        target.setBaudRate(serial.baudRate());
        target.setNumDataBits(serial.dataBits());
        target.setNumStopBits(serial.stopBits());
        target.setParity(serial.parity().getBit());
        target.setFlowControl(serial.flowControl().getBit());

        // Blocking writes bounded by the configured timeout: without a bound, a printer
        // that stops asserting flow control would hold this device's worker thread forever
        // and silently stall the queue behind it.
        target.setComPortTimeouts(
                SerialPort.TIMEOUT_WRITE_BLOCKING, 0, (int) serial.writeTimeout().toMillis());
    }

    /** Closes the port if open. Must be called while holding {@link #lock}. */
    private void closePort() {
        if (port != null) {
            if (port.isOpen()) {
                port.closePort();
            }
            port = null;
        }
    }

    // -------------------------------------------------------------------------
    // Writing
    // -------------------------------------------------------------------------

    @Override
    public void write(byte[] payload) throws PrinterWriteException {
        lock.lock();
        try {
            if (port == null || !port.isOpen() || !status.isUsable()) {
                throw new PrinterWriteException(
                        "[" + deviceName() + "] Port is not open");
            }

            int written;
            try {
                written = port.writeBytes(payload, payload.length);
            } catch (RuntimeException e) {
                handleLostDevice("Write failed: " + e.getMessage());
                throw new PrinterWriteException(
                        "[" + deviceName() + "] Write failed", e);
            }

            if (written < 0) {
                handleLostDevice("Device disappeared during write");
                throw new PrinterWriteException(
                        "[" + deviceName() + "] Device disappeared during write");
            }
            if (written != payload.length) {
                // A partial write leaves the printer mid-command, so it is a failure even
                // though some bytes arrived.
                throw new PrinterWriteException("[" + deviceName() + "] Wrote only "
                        + written + " of " + payload.length + " bytes before timing out");
            }
        } finally {
            lock.unlock();
        }
    }

    /** Marks the device lost and starts reconnecting if configured to. Holds {@link #lock}. */
    private void handleLostDevice(String reason) {
        logger.error("[" + deviceName() + "] " + reason);
        closePort();
        status = ConnectionStatus.NO_DEVICE;
        startReconnectLoop();
    }

    // -------------------------------------------------------------------------
    // Reconnect
    // -------------------------------------------------------------------------

    /**
     * Starts retrying the connection in the background, if the device is configured to
     * reconnect and no attempt is already running.
     */
    public void startReconnectLoop() {
        if (shuttingDown || !serial.autoReconnect()) {
            return;
        }
        // The lock is reentrant, so the call from handleLostDevice, which already holds it, is
        // safe. Without it two callers could both see a dead thread and start one each: the
        // duplicate does no harm beyond a leaked thread and doubled log lines, but nothing about
        // this field was safe to read from three threads.
        lock.lock();
        try {
            if (reconnectThread != null && reconnectThread.isAlive()) {
                return;
            }
            long delayMillis = serial.reconnectDelay().toMillis();
            logger.info("[" + deviceName() + "] Retrying every "
                    + serial.reconnectDelay().toSeconds() + "s until the device returns");
            reconnectThread = Thread.ofVirtual()
                    .name("fenpos-agent-reconnect-" + deviceName())
                    .start(() -> reconnectUntilConnected(delayMillis));
        } finally {
            lock.unlock();
        }
    }

    /**
     * Retries until the device answers, saying what each attempt found.
     * <p>
     * The attempt that finds no port at all used to skip in silence, which made an unplugged
     * printer produce one line at the start and then nothing for as long as it stayed unplugged —
     * indistinguishable in the log from a retry loop that had died. {@link #connect()} already
     * reports the attempts where the port exists but will not open, so this only had to cover the
     * case where it is not there.
     */
    private void reconnectUntilConnected(long delayMillis) {
        while (!shuttingDown && !status.isUsable()) {
            try {
                Thread.sleep(delayMillis);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                logger.info("[" + deviceName() + "] Stopped retrying: the agent is shutting down");
                return;
            }
            if (shuttingDown || status.isUsable()) {
                return;
            }
            if (!isExpectedDevice()) {
                // Both reasons for refusing are reported by isExpectedDevice itself, which is the
                // only place that knows which of the two it was.
                continue;
            }
            connect();
        }
    }

    /**
     * Returns whether the port currently carrying this device's name is the same physical
     * device that was last connected.
     * <p>
     * Port names are not stable: {@code /dev/ttyUSB0} can belong to a different adapter
     * after a reboot, and reconnecting blindly would send receipts to whatever hardware
     * happens to answer. Returns {@code true} when nothing has been connected yet, since
     * there is then no identity to contradict.
     * <p>
     * Both ways of saying no are logged here, because this is the only place that knows which one
     * it was, and a caller that skips an attempt without a reason leaves a retry loop looking
     * identical to a stopped one.
     */
    private boolean isExpectedDevice() {
        String portName = serial.port();
        DeviceIdentity expected = knownIdentity;

        for (SerialPort candidate : SerialPort.getCommPorts()) {
            if (!portName.equals(candidate.getSystemPortName())) {
                continue;
            }
            if (expected == null) {
                return true;
            }
            if (expected.matches(candidate)) {
                return true;
            }
            logger.warn("[" + deviceName() + "] Port " + portName
                    + " is now a different device; not reconnecting");
            return false;
        }
        absentAttempts++;
        if (absentAttempts == 1 || absentAttempts % ABSENT_PORT_LOG_INTERVAL == 0) {
            logger.warn("[" + deviceName() + "] Port " + serial.port() + " is not present; still "
                    + "retrying (attempt " + absentAttempts + ")");
        }
        return false;
    }

    /** Whether the operating system currently reports a serial port under this name. */
    private static boolean isReportedByTheSystem(String portName) {
        for (SerialPort candidate : SerialPort.getCommPorts()) {
            if (portName.equals(candidate.getSystemPortName())) {
                return true;
            }
        }
        return false;
    }

    /** Returns every serial port the operating system currently reports. */
    public static List<SerialPort> availablePorts() {
        SerialPort[] ports = SerialPort.getCommPorts();
        return ports.length == 0 ? List.of() : Arrays.asList(ports);
    }

    /**
     * The USB identity of a connected device.
     * <p>
     * Serial number is preferred; many inexpensive USB-serial adapters leave it blank, so
     * vendor and product id are the fallback.
     */
    private record DeviceIdentity(String serialNumber, int vendorId, int productId) {

        static DeviceIdentity of(SerialPort port) {
            return new DeviceIdentity(
                    port.getSerialNumber(), port.getVendorID(), port.getProductID());
        }

        boolean matches(SerialPort candidate) {
            if (serialNumber != null && !serialNumber.isBlank()) {
                return serialNumber.equals(candidate.getSerialNumber());
            }
            return vendorId == candidate.getVendorID() && productId == candidate.getProductID();
        }
    }
}
