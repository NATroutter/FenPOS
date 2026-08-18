package fi.natroutter.fenpos.serial;

import fi.natroutter.foxlib.logger.FoxLogger;
import fi.natroutter.fenpos.device.DeviceRegistry;
import fi.natroutter.fenpos.enums.Codepage;
import fi.natroutter.fenpos.enums.FlowControl;
import fi.natroutter.fenpos.enums.Parity;
import fi.natroutter.fenpos.link.Frames;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotSame;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Tests that the serial layer follows the device set the server pushes.
 * <p>
 * Every device here has {@code autoConnect} off, so no port is ever opened and the tests say
 * nothing about hardware — what they pin down is which handlers survive a snapshot, which is
 * the property that decides whether a reconnect interrupts printing.
 */
class DeviceConnectionManagerTest {

    private final FoxLogger logger = new FoxLogger.Builder()
            .setLoggerName("test")
            .setSaveLogs(false)
            .setConsoleLog(false)
            .build();

    private final DeviceRegistry registry = new DeviceRegistry();
    private final DeviceConnectionManager connections =
            new DeviceConnectionManager(registry, logger);

    @AfterEach
    void closePorts() {
        connections.shutdown();
    }

    @Test
    void holdsNoHandlersUntilTheServerPushesDevices() {
        assertTrue(connections.deviceNames().isEmpty());
        assertTrue(connections.handler("kitchen").isEmpty());
        assertTrue(connections.port("kitchen").isEmpty());
    }

    @Test
    void createsAHandlerForEachDeviceInTheSnapshot() {
        apply(device("bar", "COM1"), device("kitchen", "COM3"));

        assertEquals(List.of("bar", "kitchen"), List.copyOf(connections.deviceNames()));
        assertEquals("COM3", connections.handler("kitchen").orElseThrow().serial().port());
    }

    @Test
    void keepsTheHandlerWhenTheSnapshotRepeatsUnchanged() {
        apply(device("kitchen", "COM3"));
        SerialHandler first = connections.handler("kitchen").orElseThrow();

        apply(device("kitchen", "COM3"));

        // The server sends a whole snapshot on every reconnect. Replacing the handler would
        // close a working port, so an unchanged device must come through untouched.
        assertSame(first, connections.handler("kitchen").orElseThrow());
    }

    @Test
    void replacesTheHandlerWhenSerialSettingsChange() {
        apply(device("kitchen", "COM3"));
        SerialHandler first = connections.handler("kitchen").orElseThrow();

        apply(device("kitchen", "COM9"));

        SerialHandler replacement = connections.handler("kitchen").orElseThrow();
        assertNotSame(first, replacement);
        assertEquals("COM9", replacement.serial().port());
    }

    @Test
    void leavesOtherDevicesAloneWhenOneChanges() {
        apply(device("bar", "COM1"), device("kitchen", "COM3"));
        SerialHandler bar = connections.handler("bar").orElseThrow();

        apply(device("bar", "COM1"), device("kitchen", "COM9"));

        assertSame(bar, connections.handler("bar").orElseThrow());
    }

    @Test
    void dropsHandlersForDevicesTheServerNoLongerLists() {
        apply(device("bar", "COM1"), device("kitchen", "COM3"));

        apply(device("kitchen", "COM3"));

        assertTrue(connections.handler("bar").isEmpty());
        assertEquals(List.of("kitchen"), List.copyOf(connections.deviceNames()));
    }

    @Test
    void dropsEveryHandlerWhenTheSnapshotIsEmpty() {
        apply(device("kitchen", "COM3"));

        apply();

        assertTrue(connections.deviceNames().isEmpty());
    }

    private void apply(Frames.DeviceConfig... devices) {
        registry.apply(List.of(devices));
        connections.applyDevices();
    }

    private static Frames.DeviceConfig device(String name, String port) {
        return new Frames.DeviceConfig(
                name,
                port,
                19200,
                8,
                1,
                Parity.NONE,
                FlowControl.NONE,
                5000,
                false,
                false,
                5,
                32,
                Codepage.CP858,
                false,
                10);
    }
}
