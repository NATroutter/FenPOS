package fi.natroutter.fenpos.markup.model;

import fi.natroutter.fenpos.enums.BarcodeSystem;

/**
 * A printer action attached to a line rather than a piece of styled text.
 * <p>
 * Directives occupy no columns and so are invisible to wrapping. The hierarchy is sealed
 * because the renderer must handle every kind exhaustively — a new directive with no
 * emitter would otherwise be silently dropped, producing a receipt missing a cut.
 * <p>
 * Not every kind has a source in every pipeline, and that asymmetry is deliberate. {@link Rule}
 * arrives only from markup the agent parses itself, because a job compiled by the server has
 * already had its rule expanded to characters. {@link Drawer} arrives only from the server,
 * because the markup this agent parses has no tag for it — a console or a test page that could
 * pop the till is a surprise nobody wants.
 * <p>
 * The symbols and {@link Image} arrive from both, but not on equal terms. Measuring a symbol to
 * charge it against a job's line budget needs an encoder, and turning a picture into dots needs a
 * dithering engine, and the design keeps exactly one of each — on the server — so that the budget,
 * the preview and the paper cannot disagree. What that leaves this side is a symbol it can emit
 * but not measure, and an image it can print only if the dots were already synced to it. See
 * {@code PrintCompiler.countTextLines} for what the first costs, and {@code SyncedImages} for the
 * second.
 */
public sealed interface Directive {

    /** Widest image accepted, in dots — far beyond the paper any of these printers takes. */
    int MAX_WIDTH_DOTS = 4_096;

    /** Tallest image accepted, in dots: what the raster command declares in its two height bytes. */
    int MAX_HEIGHT_DOTS = 65_535;

    /** Advances the paper by a fixed number of lines. */
    record Feed(int lines) implements Directive {
        public Feed {
            if (lines < 1 || lines > 255) {
                throw new IllegalArgumentException("feed lines must be 1..255, got " + lines);
            }
        }
    }

    /** Cuts the paper. */
    record Cut(Mode mode) implements Directive {

        /** How completely the paper is severed. */
        public enum Mode {
            /** Severs the paper completely. */
            FULL,
            /** Leaves a small tab so the receipt stays attached until torn off. */
            PARTIAL
        }

        public Cut {
            if (mode == null) {
                throw new IllegalArgumentException("cut mode must not be null");
            }
        }
    }

    /**
     * A horizontal rule spanning the full paper width. Rendered as repeated hyphens rather
     * than a graphic, so it costs no image data and works on every ESC/POS device.
     */
    record Rule() implements Directive {
    }

    /**
     * A QR code, drawn by the printer's own encoder from the data and a module size.
     * <p>
     * How tall the symbol comes out is the printer's arithmetic, not this record's: the
     * version it picks depends on how much data fits at the chosen error correction level.
     * The server measured that already to charge the job's line budget.
     */
    record Qr(String content, int size) implements Directive {
        public Qr {
            requireContent(content, "QR");
            if (size < 1 || size > 16) {
                throw new IllegalArgumentException("QR module size must be 1..16, got " + size);
            }
        }
    }

    /** A linear barcode in one of the printer's supported symbologies. */
    record Barcode(BarcodeSystem system, String content) implements Directive {
        public Barcode {
            if (system == null) {
                throw new IllegalArgumentException("barcode symbology must not be null");
            }
            requireContent(content, "barcode");
        }
    }

    /**
     * A PDF417 stacked barcode, laid out in a stated number of data columns.
     * <p>
     * The column count is not the printer's to choose here. {@code GS ( k} function 65 treats zero
     * as "lay it out however you like", and the server has already charged a line budget against
     * one particular layout — so a symbol whose columns were left unstated could print a different
     * number of rows from the number that was counted.
     */
    record Pdf417(String content, int errorLevel, int columns) implements Directive {
        public Pdf417 {
            requireContent(content, "PDF417");
            if (errorLevel < 0 || errorLevel > 8) {
                throw new IllegalArgumentException("PDF417 error level must be 0..8, got " + errorLevel);
            }
            if (columns < 1 || columns > 30) {
                throw new IllegalArgumentException("PDF417 column count must be 1..30, got " + columns);
            }
        }
    }

    /**
     * A cash drawer kick on pin 2 or 5.
     * <p>
     * Electrical rather than printed: the pulse fires the solenoid in the drawer and never
     * touches the paper, so unlike every other kind here it costs no lines.
     */
    record Drawer(int pin) implements Directive {
        public Drawer {
            if (pin != 2 && pin != 5) {
                throw new IllegalArgumentException("drawer pin must be 2 or 5, got " + pin);
            }
        }
    }

    /**
     * A picture, already reduced to dots.
     *
     * <p>Unlike every other kind here this carries its own geometry, because there is nothing to
     * derive it from: a rectangle of bits cannot be read back into rows without knowing how wide
     * it is. The dots themselves were decided on the server — the design keeps one dithering
     * engine, so that the panel's preview and the paper agree speckle for speckle, and so that
     * this agent needs no image decoder.
     *
     * <p>{@code packed} is one bit per dot, most significant bit first, each row padded to a whole
     * byte, a set bit meaning ink. That is the layout ESC/POS {@code GS v 0} takes, so the bytes
     * pass through the renderer unrearranged.
     *
     * <p>Arrives from the link, and from the agent's own markup for the narrow case where the dots
     * are already here: {@code <image>} resolves against the rasters that came with the device
     * configuration and against nothing else. There is no decoder and no fetch path on this side,
     * so an image the server has not synced cannot be printed from here at all.
     *
     * @param widthDots  width in printer dots
     * @param heightDots height in printer dots
     * @param packed     the dots
     */
    record Image(int widthDots, int heightDots, byte[] packed) implements Directive {
        public Image {
            if (widthDots < 1 || heightDots < 1) {
                throw new IllegalArgumentException(
                        "an image must have dots, not " + widthDots + "x" + heightDots);
            }
            // Bounded here rather than only at the wire, so that every way an image is built is
            // bounded — including the rasters shipped inside this jar, which reach the renderer
            // without passing the codec. The raster command declares its height in two bytes and
            // the printer reads exactly that many rows, so a taller image wraps the field and the
            // printer consumes the rest of the job as image data.
            if (widthDots > MAX_WIDTH_DOTS || heightDots > MAX_HEIGHT_DOTS) {
                throw new IllegalArgumentException("an image may be at most " + MAX_WIDTH_DOTS + "x"
                        + MAX_HEIGHT_DOTS + " dots, not " + widthDots + "x" + heightDots);
            }
            if (packed == null) {
                throw new IllegalArgumentException("image dots must not be null");
            }
            int expected = ((widthDots + 7) / 8) * heightDots;
            if (packed.length != expected) {
                // Not a formality. The printer reads exactly as many bytes as the command
                // declares, so a short raster leaves it consuming the rest of the job as image
                // data and needing a power cycle.
                throw new IllegalArgumentException("a " + widthDots + "x" + heightDots
                        + " image is " + expected + " bytes of dots, got " + packed.length);
            }
            packed = packed.clone();
        }
    }

    private static void requireContent(String content, String what) {
        if (content == null || content.isEmpty()) {
            throw new IllegalArgumentException(what + " content must not be empty");
        }
    }
}
