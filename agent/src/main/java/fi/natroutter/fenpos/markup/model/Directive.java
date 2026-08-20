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
 * already had its rule expanded to characters. The symbols and the drawer pulse arrive only from
 * the server, because measuring a symbol to charge it against a job's line budget needs an
 * encoder, and the design keeps exactly one of those — on the server, so the budget, the preview
 * and the paper cannot disagree.
 */
public sealed interface Directive {

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

    /** A PDF417 stacked barcode. */
    record Pdf417(String content, int errorLevel) implements Directive {
        public Pdf417 {
            requireContent(content, "PDF417");
            if (errorLevel < 0 || errorLevel > 8) {
                throw new IllegalArgumentException("PDF417 error level must be 0..8, got " + errorLevel);
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

    private static void requireContent(String content, String what) {
        if (content == null || content.isEmpty()) {
            throw new IllegalArgumentException(what + " content must not be empty");
        }
    }
}
