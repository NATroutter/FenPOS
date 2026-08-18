package fi.natroutter.fenpos.serial;

import fi.natroutter.foxlib.logger.FoxLogger;
import fi.natroutter.fenpos.device.Device;
import fi.natroutter.fenpos.device.DeviceRegistry;
import fi.natroutter.fenpos.device.SerialSettings;
import fi.natroutter.fenpos.enums.ConnectionStatus;

import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.Set;

/**
 * Owns one {@link SerialHandler} per device the server has told this agent about.
 * <p>
 * Handlers are keyed by device name because that is the identity the rest of the system
 * uses: dispatched jobs, job records and console commands all name a device, never a port.
 * <p>
 * Shutdown is centralised here rather than in each handler. Registering a JVM shutdown hook
 * per handler would leak one hook per device on every {@code config.sync}, and hooks cannot
 * be removed once the JVM is exiting.
 */
public class DeviceConnectionManager {

    private final DeviceRegistry devices;
    private final FoxLogger logger;
    private final Map<String, SerialHandler> handlers = new LinkedHashMap<>();

    /**
     * Creates a manager holding no handlers. Ports open only once
     * {@link #applyDevices()} runs against a device set the server has pushed.
     *
     * @param devices the device set to reconcile against
     * @param logger  logger passed to each handler
     */
    public DeviceConnectionManager(DeviceRegistry devices, FoxLogger logger) {
        this.devices = Objects.requireNonNull(devices, "devices");
        this.logger = Objects.requireNonNull(logger, "logger");
    }

    /**
     * Brings the open ports into line with the registry.
     * <p>
     * A device whose serial settings are unchanged keeps its handler, and therefore its open
     * port, untouched. That matters because the server sends a whole snapshot on every
     * reconnect: rebuilding wholesale would drop every printer's connection each time the
     * link so much as blipped, interrupting jobs for a configuration that did not change.
     * <p>
     * A device that fails to open does not stop the others: a printer being unplugged is an
     * operational condition, and the remaining printers should still serve. Devices
     * configured to reconnect begin retrying immediately.
     */
    public synchronized void applyDevices() {
        List<Device> current = List.copyOf(devices.all());
        Set<String> wanted = new LinkedHashSet<>();
        current.forEach(device -> wanted.add(device.name()));

        List<String> gone = new ArrayList<>(handlers.keySet());
        gone.removeAll(wanted);
        for (String name : gone) {
            handlers.remove(name).shutdown();
            logger.info("[" + name + "] Removed; port closed");
        }

        for (Device device : current) {
            SerialHandler existing = handlers.get(device.name());
            if (existing != null && existing.serial().equals(device.serial())) {
                continue;
            }
            if (existing != null) {
                // Settings that reach the driver — baud rate, parity, flow control — can only
                // be applied by reopening, so a changed port is a new handler rather than a
                // mutated one.
                existing.shutdown();
                logger.info("[" + device.name() + "] Serial settings changed; reopening");
            }
            open(device);
        }
    }

    /** Creates a handler for a device and connects it if it is set to open on its own. */
    private void open(Device device) {
        SerialSettings serial = device.serial();
        SerialHandler handler = new SerialHandler(device.name(), serial, logger);
        handlers.put(device.name(), handler);
        if (!serial.autoConnect()) {
            return;
        }
        handler.connect();
        if (!handler.status().isUsable()) {
            handler.startReconnectLoop();
        }
    }

    /**
     * Returns the port for a device.
     *
     * @param deviceName the device name
     * @return the port, or empty if this agent has no such device
     */
    public synchronized Optional<PrinterPort> port(String deviceName) {
        return Optional.ofNullable(handlers.get(deviceName));
    }

    /**
     * Returns the handler for a device, for lifecycle operations from the console.
     *
     * @param deviceName the device name
     * @return the handler, or empty if this agent has no such device
     */
    public synchronized Optional<SerialHandler> handler(String deviceName) {
        return Optional.ofNullable(handlers.get(deviceName));
    }

    /**
     * Returns the connection state of a device.
     *
     * @param deviceName the device name
     * @return the state, or {@link ConnectionStatus#DISCONNECTED} if unknown
     */
    public synchronized ConnectionStatus status(String deviceName) {
        SerialHandler handler = handlers.get(deviceName);
        return handler == null ? ConnectionStatus.DISCONNECTED : handler.status();
    }

    /** Returns every device name that currently has a handler. */
    public synchronized Set<String> deviceNames() {
        return Collections.unmodifiableSet(new LinkedHashSet<>(handlers.keySet()));
    }

    /** Closes every port permanently. Called once during shutdown. */
    public synchronized void shutdown() {
        handlers.values().forEach(SerialHandler::shutdown);
        handlers.clear();
        logger.info("All serial ports closed");
    }
}
