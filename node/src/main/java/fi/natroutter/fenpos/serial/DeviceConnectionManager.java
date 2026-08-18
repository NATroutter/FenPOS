package fi.natroutter.fenpos.serial;

import fi.natroutter.foxlib.logger.FoxLogger;
import fi.natroutter.fenpos.config.data.ResolvedConfig;
import fi.natroutter.fenpos.enums.ConnectionStatus;

import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.Set;

/**
 * Owns one {@link SerialHandler} per configured printer.
 * <p>
 * Handlers are keyed by device name because that is the identity the rest of the system
 * uses: request paths, job records and console commands all name a device, never a port.
 * <p>
 * Shutdown is centralised here rather than in each handler. Registering a JVM shutdown hook
 * per handler would leak one hook per device on every configuration reload, and hooks
 * cannot be removed once the JVM is exiting.
 */
public class DeviceConnectionManager {

    private final FoxLogger logger;
    private final Map<String, SerialHandler> handlers = new LinkedHashMap<>();

    /**
     * Creates handlers for every configured device, without opening any port.
     *
     * @param config the resolved configuration
     * @param logger logger passed to each handler
     */
    public DeviceConnectionManager(ResolvedConfig config, FoxLogger logger) {
        this.logger = Objects.requireNonNull(logger, "logger");
        config.devices().forEach((name, device) ->
                handlers.put(name, new SerialHandler(device, logger)));
    }

    /**
     * Opens every device whose {@code autoConnect} is set.
     * <p>
     * A device that fails to open does not stop the others or abort startup: a printer
     * being unplugged is an operational condition, and the remaining printers should still
     * serve. Devices configured to reconnect begin retrying immediately.
     */
    public void connectAutoStartDevices() {
        handlers.forEach((name, handler) -> {
            if (!handler.settings().serial().autoConnect()) {
                return;
            }
            handler.connect();
            if (!handler.status().isUsable()) {
                handler.startReconnectLoop();
            }
        });
    }

    /**
     * Returns the port for a device.
     *
     * @param deviceName the configured device name
     * @return the port, or empty if no such device is configured
     */
    public Optional<PrinterPort> port(String deviceName) {
        return Optional.ofNullable(handlers.get(deviceName));
    }

    /**
     * Returns the handler for a device, for lifecycle operations from the console.
     *
     * @param deviceName the configured device name
     * @return the handler, or empty if no such device is configured
     */
    public Optional<SerialHandler> handler(String deviceName) {
        return Optional.ofNullable(handlers.get(deviceName));
    }

    /**
     * Returns the connection state of a device.
     *
     * @param deviceName the configured device name
     * @return the state, or {@link ConnectionStatus#DISCONNECTED} if unknown
     */
    public ConnectionStatus status(String deviceName) {
        SerialHandler handler = handlers.get(deviceName);
        return handler == null ? ConnectionStatus.DISCONNECTED : handler.status();
    }

    /** Returns every configured device name, in configuration order. */
    public Set<String> deviceNames() {
        return Collections.unmodifiableSet(handlers.keySet());
    }

    /** Closes every port permanently. Called once during shutdown. */
    public void shutdown() {
        handlers.values().forEach(SerialHandler::shutdown);
        logger.info("All serial ports closed");
    }
}
