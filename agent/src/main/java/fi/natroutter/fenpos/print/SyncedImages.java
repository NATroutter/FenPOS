package fi.natroutter.fenpos.print;

import fi.natroutter.fenpos.device.Device;
import fi.natroutter.fenpos.device.DeviceRegistry;
import fi.natroutter.fenpos.link.Frames;
import fi.natroutter.fenpos.markup.ImageResolver;
import fi.natroutter.fenpos.markup.model.Directive;

import java.util.Optional;

/**
 * The images a device can print: the ones the server dithered and synced to this agent.
 *
 * <p>The whole of the agent's {@code <image>} support, and deliberately a small whole. There is no
 * image decoder here and no fetch path, so a picture can only be printed if its dots already
 * arrived with a {@code config.sync}. That is the same set the link path draws on — see
 * {@code IrRenderer.synced} — which is what stops a logo printing from a job and failing from the
 * console, or the reverse.
 *
 * <p><b>Only the width the raster was dithered at will resolve.</b> The server dithers a stored
 * asset once per paper width, at the full printable width, so an {@code <image=50>} finds nothing
 * even when {@code <image>} finds the logo. Shrinking the raster here is the alternative and is
 * worse: its dots have already been reduced to black and white, and resampling them resamples the
 * dither's own noise. A job that needs some other width is compiled on the server, which carries
 * the dots with it.
 */
public final class SyncedImages {

    /**
     * Horizontal dots per character column at normal width.
     * <p>
     * Mirrors {@code DOTS_PER_COLUMN} in {@code fenpos/lib/markup/blocks.ts}. The two must agree
     * exactly: the server keys a synced raster by the width it computed, and this looks it up by
     * computing the same number. A disagreement is not a slightly wrong picture — it is a lookup
     * that misses and an image the agent reports it does not hold.
     */
    private static final int DOTS_PER_COLUMN = 12;

    /** A width percentage means a share of a hundred. */
    private static final int PERCENT = 100;

    private SyncedImages() {
    }

    /**
     * Builds a resolver over what this agent holds for one device.
     *
     * @param device   the device whose paper width decides how wide a percentage is
     * @param registry this agent's device set, which also holds the synced rasters
     * @return a resolver the markup parser can use
     */
    public static ImageResolver forDevice(Device device, DeviceRegistry registry) {
        int columns = device.print().columns();
        return (name, widthPercent) -> registry
                .raster(name, printedWidthDots(widthPercent, columns))
                .map(SyncedImages::toDirective);
    }

    /**
     * How wide an image prints, in dots.
     * <p>
     * Mirrors {@code printedWidthDots} in {@code fenpos/lib/markup/images.ts}, rounding included:
     * this is a lookup key, and the two sides must produce the same integer.
     *
     * @param widthPercent the tag's argument: the share of the paper's width to print at, 1-100
     * @param columns      the device's width in printer columns
     * @return the printed width in dots, at least one
     */
    private static int printedWidthDots(int widthPercent, int columns) {
        int paper = columns * DOTS_PER_COLUMN;
        return Math.max(1, (int) Math.round((double) paper * widthPercent / PERCENT));
    }

    private static Directive.Image toDirective(Frames.AssetRaster raster) {
        return new Directive.Image(raster.widthDots(), raster.heightDots(), raster.packed());
    }
}
