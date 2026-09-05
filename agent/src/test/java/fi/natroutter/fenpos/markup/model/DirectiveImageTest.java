package fi.natroutter.fenpos.markup.model;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * What an image may claim to be.
 *
 * <p>The raster command states its height in two bytes and the printer then reads exactly that many
 * rows. A taller image wraps that field, and the printer consumes the rest of the job as image data
 * rather than printing a short picture — which ends in a power cycle, not a failed job. The codec
 * bounds this for anything arriving over the link; stating it here bounds it for every other way an
 * image is built, which today means the rasters shipped inside the jar.
 */
class DirectiveImageTest {

    @Test
    void refusesARectangleTallerThanTheCommandCanDeclare() {
        int width = 8;
        int height = 65_536;

        IllegalArgumentException refusal = assertThrows(IllegalArgumentException.class,
                () -> new Directive.Image(width, height, new byte[width / 8 * height]));
        assertTrue(refusal.getMessage().contains("65535"), refusal.getMessage());
    }

    @Test
    void refusesARectangleWiderThanAnyPaper() {
        int width = 4_097;
        int height = 1;

        assertThrows(IllegalArgumentException.class,
                () -> new Directive.Image(width, height, new byte[(width + 7) / 8 * height]));
    }

    @Test
    void acceptsARectangleAtTheLimits() {
        assertDoesNotThrow(() -> new Directive.Image(4_096, 1, new byte[512]));
    }
}
