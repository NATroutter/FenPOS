package fi.natroutter.fenpos.print;

import fi.natroutter.fenpos.device.Device;
import fi.natroutter.fenpos.device.LimitSettings;
import fi.natroutter.fenpos.device.PrintSettings;
import fi.natroutter.fenpos.device.SerialSettings;
import fi.natroutter.fenpos.enums.Codepage;
import fi.natroutter.fenpos.enums.FlowControl;
import fi.natroutter.fenpos.enums.Linefeed;
import fi.natroutter.fenpos.enums.Parity;
import fi.natroutter.fenpos.enums.UnsupportedPolicy;
import fi.natroutter.fenpos.markup.ImageResolver;
import fi.natroutter.fenpos.markup.model.Directive;
import org.junit.jupiter.api.Test;

import java.time.Duration;
import java.util.Optional;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Behavioural tests for {@link BundledImages}.
 * <p>
 * Two properties carry the whole design and both are pinned here. The first is that a bundled
 * raster resolves <b>only at the width it was dithered for</b> — the moment a near width is
 * accepted, something has to resample dots that are already black and white, which is exactly what
 * the encoding design refuses. The second is that the reserved name answers for nothing else, so a
 * bundled image can never stand in front of an operator's own asset.
 * <p>
 * {@link BundledImages#NAME} is a legal asset slug — {@code "fenpos"} matches
 * {@code NAME_PATTERN} in {@code fenpos/lib/domain/naming.ts} just as any operator-chosen name
 * would. Nothing on this side of the link can prove a collision is unreachable any more; that
 * guarantee now lives server-side, where {@code fenpos/lib/assets/asset-service.ts} refuses to
 * create or import an asset called {@code "fenpos"} and is exercised by
 * {@code asset-service.test.ts}.
 */
class BundledImagesTest {

    /** The three widths the generator bundles, as the column counts that produce them. */
    private static final int[] BUNDLED_COLUMNS = {32, 42, 48};

    @Test
    void resolvesTheLogoAtAWidthItWasDitheredFor() {
        Optional<Directive.Image> found = BundledImages.forDevice(device(32))
                .resolve(BundledImages.NAME, 100);

        assertTrue(found.isPresent(), "the 384-dot logo should be bundled");
        Directive.Image logo = found.orElseThrow();
        assertEquals(384, logo.widthDots());
        assertEquals(((logo.widthDots() + 7) / 8) * logo.heightDots(), logo.packed().length);
    }

    /** The claim that 384, 504 and 576 are all present, as a check rather than a comment. */
    @Test
    void bundlesEveryWidthItClaimsTo() {
        for (int columns : BUNDLED_COLUMNS) {
            Optional<Directive.Image> found = BundledImages.forDevice(device(columns))
                    .resolve(BundledImages.NAME, 100);

            assertTrue(found.isPresent(), "no bundled logo for " + columns + " columns");
            assertEquals(columns * 12, found.orElseThrow().widthDots());
        }
    }

    /**
     * A paper width nobody dithered for finds nothing at all.
     * <p>
     * 33 columns is 396 dots, four more than the 384 that is bundled. Answering with the 384-dot
     * raster and stretching it, or letting the printer stretch it, is the failure this exists to
     * make impossible.
     */
    @Test
    void refusesAWidthItWasNotDitheredFor() {
        assertTrue(BundledImages.forDevice(device(33)).resolve(BundledImages.NAME, 100).isEmpty());
    }

    /**
     * {@code <image=50>} finds nothing, for the same reason and on the other axis.
     * <p>
     * Half of a 32-column paper is 192 dots, which is not a width the logo was dithered at. The
     * honest answer is that this agent does not hold that picture; shrinking the 384-dot one would
     * resample its dither noise.
     */
    @Test
    void refusesAFractionOfThePaper() {
        assertTrue(BundledImages.forDevice(device(32)).resolve(BundledImages.NAME, 50).isEmpty());
    }

    /** The bundled logo must never stand in front of an operator's own asset. */
    @Test
    void refusesEveryOtherName() {
        ImageResolver images = BundledImages.forDevice(device(32));

        assertTrue(images.resolve("fenpos-logo", 100).isEmpty());
        assertTrue(images.resolve("logo", 100).isEmpty());
        assertTrue(images.resolve("", 100).isEmpty());
        assertTrue(images.resolve(null, 100).isEmpty());
    }

    private static Device device(int columns) {
        return new Device(
                "kitchen",
                new SerialSettings("COM3", 9600, 8, 1, Parity.NONE, FlowControl.NONE,
                        true, true, Duration.ofSeconds(5), Duration.ofMillis(5000)),
                new PrintSettings(columns, Codepage.CP858, UnsupportedPolicy.REJECT, true, Linefeed.LF),
                new LimitSettings(100, 200, 4000, 200, 100),
                false);
    }
}
