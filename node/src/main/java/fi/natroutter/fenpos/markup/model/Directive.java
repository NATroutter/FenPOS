package fi.natroutter.fenpos.markup.model;

/**
 * A printer action attached to a line rather than a piece of styled text.
 * <p>
 * Directives occupy no columns and so are invisible to wrapping. The hierarchy is sealed
 * because the renderer must handle every kind exhaustively — a new directive with no
 * emitter would otherwise be silently dropped, producing a receipt missing a cut.
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
}
