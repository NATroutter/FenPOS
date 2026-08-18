package fi.natroutter.fenpos.print;

import fi.natroutter.foxlib.logger.FoxLogger;
import fi.natroutter.fenpos.device.DeviceRegistry;
import fi.natroutter.fenpos.enums.Codepage;
import fi.natroutter.fenpos.enums.FlowControl;
import fi.natroutter.fenpos.enums.Parity;
import fi.natroutter.fenpos.link.Frames;
import fi.natroutter.fenpos.serial.FakePrinterPort;
import fi.natroutter.fenpos.serial.PrinterPort;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;

import java.time.Clock;
import java.time.Duration;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotSame;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Tests that the print queues follow the device set the server pushes.
 * <p>
 * Ports are fakes registered by name, standing in for the serial layer that would have
 * reconciled first. What these pin down is which queues survive a snapshot: a queue that is
 * rebuilt loses the jobs waiting in it, so keeping an unchanged one is the difference between
 * a link blip being invisible and it dropping receipts.
 */
class PrintServiceTest {

    private final FoxLogger logger = new FoxLogger.Builder()
            .setLoggerName("test")
            .setSaveLogs(false)
            .setConsoleLog(false)
            .build();

    private final DeviceRegistry registry = new DeviceRegistry();
    private final Map<String, PrinterPort> ports = new HashMap<>();
    private final PrintService service = new PrintService(
            registry,
            new JobSettings(Duration.ofMinutes(10), 500, Duration.ofMillis(200)),
            name -> Optional.ofNullable(ports.get(name)),
            Clock.systemUTC(),
            logger);

    @AfterEach
    void stopQueues() {
        service.shutdown(Duration.ofSeconds(2));
    }

    @Test
    void holdsNoQueuesUntilTheServerPushesDevices() {
        assertTrue(service.findQueue("kitchen").isEmpty());
        assertThrows(IllegalArgumentException.class, () -> service.queue("kitchen"));
    }

    @Test
    void buildsAQueueForEachDeviceWithAPort() {
        port("kitchen");

        apply(device("kitchen", 10, false));

        assertEquals(10, service.queue("kitchen").capacity());
    }

    @Test
    void skipsADeviceWithNoPortRatherThanFailingTheWholeSnapshot() {
        port("kitchen");

        apply(device("bar", 10, false), device("kitchen", 10, false));

        assertTrue(service.findQueue("bar").isEmpty());
        assertTrue(service.findQueue("kitchen").isPresent());
    }

    @Test
    void keepsTheQueueWhenTheSnapshotRepeatsUnchanged() {
        port("kitchen");
        apply(device("kitchen", 10, false));
        PrintQueue first = service.queue("kitchen");

        apply(device("kitchen", 10, false));

        assertSame(first, service.queue("kitchen"));
    }

    @Test
    void rebuildsTheQueueWhenTheDepthChanges() {
        port("kitchen");
        apply(device("kitchen", 10, false));
        PrintQueue first = service.queue("kitchen");

        apply(device("kitchen", 3, false));

        assertNotSame(first, service.queue("kitchen"));
        assertEquals(3, service.queue("kitchen").capacity());
    }

    @Test
    void dropsQueuesForDevicesTheServerNoLongerLists() {
        port("bar");
        port("kitchen");
        apply(device("bar", 10, false), device("kitchen", 10, false));

        apply(device("kitchen", 10, false));

        assertTrue(service.findQueue("bar").isEmpty());
    }

    @Test
    void appliesThePausedFlagFromTheSnapshot() {
        port("kitchen");

        apply(device("kitchen", 10, true));

        assertTrue(service.queue("kitchen").isPaused());
    }

    @Test
    void resumesAQueueTheOperatorUnpaused() {
        port("kitchen");
        apply(device("kitchen", 10, true));

        apply(device("kitchen", 10, false));

        assertFalse(service.queue("kitchen").isPaused());
    }

    @Test
    void startsQueuesThatArriveAfterTheServiceIsRunning() throws Exception {
        service.start();
        FakePrinterPort port = port("kitchen");
        apply(device("kitchen", 10, false));

        service.submit(registry.device("kitchen").orElseThrow(), "{\"data\":[\"hello\"]}");

        assertTrue(port.awaitWrites(5000));
    }

    private FakePrinterPort port(String name) {
        FakePrinterPort port = new FakePrinterPort(1);
        ports.put(name, port);
        return port;
    }

    private void apply(Frames.DeviceConfig... devices) {
        registry.apply(List.of(devices));
        service.applyDevices();
    }

    private static Frames.DeviceConfig device(String name, int maxQueueDepth, boolean paused) {
        return new Frames.DeviceConfig(
                name,
                "COM3",
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
                paused,
                maxQueueDepth);
    }
}
