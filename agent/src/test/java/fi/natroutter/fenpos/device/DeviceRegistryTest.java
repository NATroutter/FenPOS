package fi.natroutter.fenpos.device;

import fi.natroutter.fenpos.enums.Codepage;
import fi.natroutter.fenpos.enums.FlowControl;
import fi.natroutter.fenpos.enums.Parity;
import fi.natroutter.fenpos.link.Frames;
import org.junit.jupiter.api.Test;

import java.time.Duration;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Tests for the translation from the wire's device set to the agent's, which is the seam the
 * YAML configuration used to occupy.
 */
class DeviceRegistryTest {

    @Test
    void translatesTheWireUnitsIntoDurations() {
        Device device = Device.from(wire("kitchen", "COM3", 100, 7500));

        assertEquals(Duration.ofSeconds(100), device.serial().reconnectDelay());
        assertEquals(Duration.ofMillis(7500), device.serial().writeTimeout());
    }

    @Test
    void carriesEverySerialSettingThroughUnchanged() {
        Device device = Device.from(wire("kitchen", "/dev/ttyUSB0", 5, 5000));

        SerialSettings serial = device.serial();
        assertEquals("/dev/ttyUSB0", serial.port());
        assertEquals(19200, serial.baudRate());
        assertEquals(8, serial.dataBits());
        assertEquals(1, serial.stopBits());
        assertEquals(Parity.NONE, serial.parity());
        assertEquals(FlowControl.NONE, serial.flowControl());
        assertTrue(serial.autoConnect());
        assertTrue(serial.autoReconnect());
    }

    @Test
    void takesOnlyTheQueueDepthFromTheWireAndKeepsItsOwnCeilings() {
        Device device = Device.from(wire("kitchen", "COM3", 5, 5000));

        assertEquals(7, device.limits().maxQueueDepth());
        assertEquals(LimitSettings.DEFAULTS.maxLines(), device.limits().maxLines());
        assertEquals(LimitSettings.DEFAULTS.maxLineChars(), device.limits().maxLineChars());
        assertEquals(LimitSettings.DEFAULTS.maxTotalChars(), device.limits().maxTotalChars());
        assertEquals(LimitSettings.DEFAULTS.maxOutputLines(), device.limits().maxOutputLines());
    }

    @Test
    void startsEmptySoAnUnpairedAgentHasNoDevices() {
        DeviceRegistry registry = new DeviceRegistry();

        assertEquals(0, registry.size());
        assertTrue(registry.all().isEmpty());
        assertTrue(registry.device("kitchen").isEmpty());
    }

    @Test
    void keepsTheOrderTheServerSentAndIndexesByName() {
        DeviceRegistry registry = new DeviceRegistry();

        registry.apply(List.of(
                wire("bar", "COM1", 5, 5000),
                wire("kitchen", "COM3", 5, 5000)));

        assertEquals(List.of("bar", "kitchen"), List.copyOf(registry.names()));
        assertEquals("COM3", registry.device("kitchen").orElseThrow().serial().port());
    }

    @Test
    void replacesTheWholeSetRatherThanMergingIntoIt() {
        DeviceRegistry registry = new DeviceRegistry();
        registry.apply(List.of(wire("bar", "COM1", 5, 5000), wire("kitchen", "COM3", 5, 5000)));

        registry.apply(List.of(wire("kitchen", "COM9", 5, 5000)));

        assertEquals(1, registry.size());
        assertTrue(registry.device("bar").isEmpty());
        assertEquals("COM9", registry.device("kitchen").orElseThrow().serial().port());
    }

    @Test
    void applyingTheSameSnapshotTwiceProducesEqualDevices() {
        DeviceRegistry registry = new DeviceRegistry();
        List<Frames.DeviceConfig> snapshot = List.of(wire("kitchen", "COM3", 5, 5000));

        registry.apply(snapshot);
        Device first = registry.device("kitchen").orElseThrow();
        registry.apply(snapshot);

        // Equality is what lets the serial layer tell a genuine change from a repeated
        // snapshot, and therefore what stops a reconnect from bouncing every open port.
        assertEquals(first, registry.device("kitchen").orElseThrow());
    }

    @Test
    void clearingLeavesNoDevices() {
        DeviceRegistry registry = new DeviceRegistry();
        registry.apply(List.of(wire("kitchen", "COM3", 5, 5000)));

        registry.clear();

        assertEquals(0, registry.size());
    }

    // -------------------------------------------------------------------------
    // Synced images
    //
    // Held here so a logo crosses the link once per configuration change rather than once per
    // receipt, and keyed by width because a raster dithered for one paper width is not a picture
    // on another.
    // -------------------------------------------------------------------------

    @Test
    void holdsARasterUnderItsNameAndWidth() {
        DeviceRegistry registry = new DeviceRegistry();

        registry.applyRasters(List.of(raster("logo", 384), raster("logo", 504)));

        assertEquals(384, registry.raster("logo", 384).orElseThrow().widthDots());
        assertEquals(504, registry.raster("logo", 504).orElseThrow().widthDots());
    }

    /** A width nobody synced is a miss rather than something to resize, which would be mud. */
    @Test
    void hasNoRasterForAWidthItWasNotSent() {
        DeviceRegistry registry = new DeviceRegistry();
        registry.applyRasters(List.of(raster("logo", 384)));

        assertTrue(registry.raster("logo", 252).isEmpty());
        assertTrue(registry.raster("stamp", 384).isEmpty());
    }

    @Test
    void replacesTheWholeImageSetRatherThanMergingIntoIt() {
        DeviceRegistry registry = new DeviceRegistry();
        registry.applyRasters(List.of(raster("logo", 384), raster("stamp", 384)));

        registry.applyRasters(List.of(raster("logo", 384)));

        assertEquals(1, registry.rasterCount());
        assertTrue(registry.raster("stamp", 384).isEmpty());
    }

    /** Unpairing releases the printers; the pictures they were going to print go with them. */
    @Test
    void clearingLeavesNoImagesEither() {
        DeviceRegistry registry = new DeviceRegistry();
        registry.applyRasters(List.of(raster("logo", 384)));

        registry.clear();

        assertEquals(0, registry.rasterCount());
        assertTrue(registry.raster("logo", 384).isEmpty());
    }

    /** One raster of the given width, one dot tall: enough to be found, small enough to read. */
    private static Frames.AssetRaster raster(String name, int widthDots) {
        return new Frames.AssetRaster(name, widthDots, 1, new byte[(widthDots + 7) / 8]);
    }

    @Test
    void rejectsAMissingSnapshotRatherThanEmptyingItself() {
        DeviceRegistry registry = new DeviceRegistry();
        registry.apply(List.of(wire("kitchen", "COM3", 5, 5000)));

        assertThrows(NullPointerException.class, () -> registry.apply(null));
        assertEquals(1, registry.size());
    }

    @Test
    void carriesThePausedFlagTheOperatorSet() {
        assertFalse(Device.from(wire("kitchen", "COM3", 5, 5000)).paused());
    }

    private static Frames.DeviceConfig wire(
            String name, String port, int reconnectDelaySeconds, int writeTimeoutMs) {
        return new Frames.DeviceConfig(
                name,
                port,
                19200,
                8,
                1,
                Parity.NONE,
                FlowControl.NONE,
                writeTimeoutMs,
                true,
                true,
                reconnectDelaySeconds,
                32,
                Codepage.CP858,
                false,
                7);
    }
}
