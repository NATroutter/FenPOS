package fi.natroutter.fenpos.print;

import fi.natroutter.fenpos.device.Device;
import fi.natroutter.fenpos.device.DeviceRegistry;
import fi.natroutter.fenpos.device.LimitSettings;
import fi.natroutter.fenpos.device.PrintSettings;
import fi.natroutter.fenpos.device.SerialSettings;
import fi.natroutter.fenpos.enums.Codepage;
import fi.natroutter.fenpos.enums.FlowControl;
import fi.natroutter.fenpos.enums.Linefeed;
import fi.natroutter.fenpos.enums.Parity;
import fi.natroutter.fenpos.enums.UnsupportedPolicy;
import fi.natroutter.fenpos.link.Frames;
import fi.natroutter.fenpos.markup.ImageResolver;
import fi.natroutter.fenpos.markup.model.Directive;
import org.junit.jupiter.api.Test;

import java.time.Duration;
import java.util.List;
import java.util.Optional;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Behavioural tests for {@link PrintImages}.
 * <p>
 * The composition has one job: one resolver answers for both the images the server synced and the
 * one the agent ships, so the test page's presence check and the compile that follows it are asking
 * the same question of the same object.
 */
class PrintImagesTest {

    /** The paper the test device prints on: 32 columns of twelve dots. */
    private static final int PAPER_DOTS = 384;

    /** A single inked row, the smallest raster a 384-dot lookup can legally hold. */
    private static final byte[] ONE_ROW = oneRow();

    @Test
    void resolvesASyncedAsset() {
        DeviceRegistry registry = registryHolding("receipt-logo");

        Optional<Directive.Image> found =
                PrintImages.forDevice(device(), registry).resolve("receipt-logo", 100);

        assertTrue(found.isPresent());
        assertArrayEquals(ONE_ROW, found.orElseThrow().packed());
    }

    @Test
    void resolvesTheBundledLogo() {
        Optional<Directive.Image> found = PrintImages.forDevice(device(), new DeviceRegistry())
                .resolve(BundledImages.NAME, 100);

        assertTrue(found.isPresent());
        assertEquals(PAPER_DOTS, found.orElseThrow().widthDots());
    }

    /**
     * A synced raster under the reserved name does not displace the bundled one.
     * <p>
     * Unreachable in practice — {@code fenpos/lib/assets/asset-service.ts} refuses to create or
     * import an asset called {@link BundledImages#NAME}, so nothing legitimate ever arrives over
     * the link under it — so this is the second lock rather than the first. It states the
     * precedence rule as behaviour: the test page prints the logo this agent was built with,
     * whatever arrives over the link.
     */
    @Test
    void prefersTheBundledLogoOverAnythingSyncedUnderItsName() {
        DeviceRegistry registry = registryHolding(BundledImages.NAME);

        Optional<Directive.Image> found =
                PrintImages.forDevice(device(), registry).resolve(BundledImages.NAME, 100);

        assertTrue(found.isPresent());
        assertEquals(PAPER_DOTS, found.orElseThrow().heightDots(),
                "the one-row impostor from the link won over the bundled logo");
    }

    @Test
    void holdsNothingElse() {
        ImageResolver images = PrintImages.forDevice(device(), new DeviceRegistry());

        assertTrue(images.resolve("never-uploaded", 100).isEmpty());
    }

    private static byte[] oneRow() {
        byte[] row = new byte[PAPER_DOTS / 8];
        row[0] = (byte) 0x80;
        return row;
    }

    private static DeviceRegistry registryHolding(String name) {
        DeviceRegistry registry = new DeviceRegistry();
        registry.applyRasters(List.of(new Frames.AssetRaster(name, PAPER_DOTS, 1, ONE_ROW)));
        return registry;
    }

    private static Device device() {
        return new Device(
                "kitchen",
                new SerialSettings("COM3", 9600, 8, 1, Parity.NONE, FlowControl.NONE,
                        true, true, Duration.ofSeconds(5), Duration.ofMillis(5000)),
                new PrintSettings(32, Codepage.CP858, UnsupportedPolicy.REJECT, true, Linefeed.LF),
                new LimitSettings(100, 200, 4000, 200, 100),
                false);
    }
}
