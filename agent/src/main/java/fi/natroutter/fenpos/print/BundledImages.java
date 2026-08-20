package fi.natroutter.fenpos.print;

import fi.natroutter.fenpos.device.Device;
import fi.natroutter.fenpos.markup.ImageResolver;
import fi.natroutter.fenpos.markup.model.Directive;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;
import java.util.Base64;
import java.util.Optional;

/**
 * The one image this agent ships with: the application's own logo, for the device test page.
 *
 * <p><b>Why it is not an asset.</b> The test page printed the logo out of the operator's asset
 * library once, and that was wrong twice over — the library is meant to hold the operator's own
 * content, and deleting a row from the Assets tab quietly broke a diagnostic that has nothing to do
 * with assets. The logo belongs to the application, so it ships inside the jar.
 *
 * <p><b>Why this is not a hole in "the server owns all encoding".</b> There is still no ditherer
 * here and no decoder, and nothing on this side ever resamples a raster. What the design refuses is
 * deriving one raster from another: dots already reduced to black and white cannot be rescaled
 * without resampling the dither's own noise. Holding <i>several</i> rasters was never the problem.
 * So {@code fenpos/scripts/bundle-logo-rasters.ts} dithers the logo once per bundled paper width
 * using the server's own {@code ditherToRaster}, and this picks the one whose width matches
 * <b>exactly</b>. The bundled bits are what the server would have synced for the same picture, so
 * the logo on a test page and a logo an operator uploads come off one algorithm.
 *
 * <p><b>No exact width, no image.</b> A device on paper nobody bundled for gets {@link
 * Optional#empty()}, and so does {@code <image=50>}: half a paper width is not a width the logo was
 * dithered at. Never the nearest width, never a scaled one. {@code TestPage} asks before it writes
 * the tag and simply prints one block fewer.
 *
 * @see PrintImages for how this sits alongside the images the server synced
 * @see SyncedImages
 */
public final class BundledImages {

    /**
     * What markup calls the bundled logo.
     *
     * <p>Chosen so that a collision with an operator's own asset is not unlikely but impossible.
     * Asset names are validated against {@code NAME_PATTERN} in {@code fenpos/lib/domain/naming.ts}
     * — {@code ^[a-z0-9][a-z0-9_-]*$} — and the slash is outside it, so no asset can ever be stored
     * under this name and no lookup here can ever be an operator's picture. It is not a URL either:
     * the panel's resolver tests for {@code ://}, so this reaches the asset path and is refused
     * there by name, which is the true answer for the panel to give.
     *
     * <p>{@code TestPage} and {@code markup-tool.tsx} both write this string; the three are meant to
     * be read together.
     */
    public static final String NAME = "fenpos/logo";

    /** Where the rasters live on the classpath. Written by {@code pnpm agent:bundle-logo}. */
    private static final String DIRECTORY = "/bundled/";

    /** The basename every bundled raster shares, before its width in dots. */
    private static final String PREFIX = "fenpos-logo-";

    /** The extension every bundled raster has. */
    private static final String SUFFIX = ".raster";

    /**
     * The first line of a bundled raster, identifying the format and its version.
     *
     * <p>The format is three parts:
     *
     * <pre>
     * FPR1
     * &lt;widthDots&gt; &lt;heightDots&gt;
     * &lt;base64 of the packed dots, wrapped over as many lines as it takes&gt;
     * </pre>
     *
     * <p>The dots are exactly what {@code Frames.AssetRaster} carries: one bit per dot, most
     * significant bit leftmost, each row padded to a whole byte, a set bit meaning ink.
     *
     * <p><b>Text rather than binary, and not by preference.</b> {@code agent/pom.xml} filters the
     * whole of {@code src/main/resources} so that {@code build.properties} can pick up the project
     * version, which copies every resource through the property substituter as text; a binary
     * resource would be corrupted by it. The repository also normalises every tracked file to LF.
     * Base64 is immune to both: its alphabet contains neither of Maven's {@code ${…}} and
     * {@code @…@} delimiters, and it means the same under every ASCII-compatible encoding the
     * filter might choose. Stating the width and height rather than inferring them from the packed
     * length is what lets the reader check the file against itself.
     */
    private static final String MAGIC = "FPR1";

    /** Horizontal dots per character column at normal width. Mirrors {@link SyncedImages}. */
    private static final int DOTS_PER_COLUMN = 12;

    /** A width percentage means a share of a hundred. */
    private static final int PERCENT = 100;

    private BundledImages() {
    }

    /**
     * Builds a resolver over what this agent ships, for one device.
     *
     * @param device the device whose paper width decides how wide a percentage is
     * @return a resolver answering only for {@link #NAME}, and only at a bundled width
     */
    public static ImageResolver forDevice(Device device) {
        int columns = device.print().columns();
        return (name, widthPercent) -> NAME.equals(name)
                ? load(printedWidthDots(widthPercent, columns))
                : Optional.empty();
    }

    /**
     * Reads the raster bundled for one printed width, if there is one.
     *
     * <p>Read on demand rather than held: the test page is the only caller, it runs when somebody
     * presses a button, and keeping a megabit of dots resident for the rest of the process's life
     * to save a classpath read is the wrong trade on a machine that is mostly a serial port.
     *
     * @param widthDots the printed width asked for
     * @return the image, or empty when nothing was bundled at exactly that width
     * @throws UncheckedIOException if a bundled raster exists but cannot be read or is malformed,
     *         which is a broken build rather than a missing image and must not be mistaken for one
     */
    private static Optional<Directive.Image> load(int widthDots) {
        String resource = DIRECTORY + PREFIX + widthDots + SUFFIX;
        try (InputStream stream = BundledImages.class.getResourceAsStream(resource)) {
            if (stream == null) {
                return Optional.empty();
            }
            return Optional.of(parse(stream, resource));
        } catch (IOException e) {
            throw new UncheckedIOException("bundled raster " + resource + " could not be read", e);
        }
    }

    /**
     * Parses one bundled raster.
     *
     * <p>Every failure here is a build that shipped a file this code cannot read, so each one
     * throws rather than returning empty. An empty result means "this agent does not hold that
     * picture", which is a thing {@code TestPage} acts on; a corrupt resource is not that.
     *
     * @param stream   the resource
     * @param resource its path, for the message
     * @return the image
     * @throws IOException if the stream cannot be read
     */
    private static Directive.Image parse(InputStream stream, String resource) throws IOException {
        BufferedReader reader =
                new BufferedReader(new InputStreamReader(stream, StandardCharsets.UTF_8));

        String magic = reader.readLine();
        if (!MAGIC.equals(magic)) {
            throw new IOException(resource + " does not start with " + MAGIC);
        }

        String[] size = String.valueOf(reader.readLine()).trim().split(" ");
        if (size.length != 2) {
            throw new IOException(resource + " does not state a width and a height");
        }
        int widthDots = parseSize(size[0], resource);
        int heightDots = parseSize(size[1], resource);

        StringBuilder base64 = new StringBuilder();
        for (String line = reader.readLine(); line != null; line = reader.readLine()) {
            base64.append(line.trim());
        }

        byte[] packed;
        try {
            packed = Base64.getDecoder().decode(base64.toString());
        } catch (IllegalArgumentException e) {
            throw new IOException(resource + " does not hold base64 dots", e);
        }

        // Directive.Image checks the packed length against the size for itself, and a raster that
        // fails that check would leave a printer consuming the rest of a job as image data — so
        // letting it construct is the check, rather than repeating it here.
        try {
            return new Directive.Image(widthDots, heightDots, packed);
        } catch (IllegalArgumentException e) {
            throw new IOException(resource + " is not a whole raster", e);
        }
    }

    private static int parseSize(String value, String resource) throws IOException {
        try {
            return Integer.parseInt(value);
        } catch (NumberFormatException e) {
            throw new IOException(resource + " states a size that is not a number: " + value, e);
        }
    }

    /**
     * How wide an image prints, in dots.
     *
     * <p>Mirrors {@code SyncedImages.printedWidthDots}, rounding included, and for the same reason:
     * this is a lookup key and every side must produce the same integer.
     *
     * @param widthPercent the tag's argument: the share of the paper's width to print at, 1-100
     * @param columns      the device's width in printer columns
     * @return the printed width in dots, at least one
     */
    private static int printedWidthDots(int widthPercent, int columns) {
        int paper = columns * DOTS_PER_COLUMN;
        return Math.max(1, (int) Math.round((double) paper * widthPercent / PERCENT));
    }
}
