package fi.natroutter.fenpos.enums;

/**
 * Horizontal justification of a printed line.
 * <p>
 * ESC/POS applies justification to a whole line rather than to a run of characters, which
 * is why alignment is a property of a line and not of a span.
 */
public enum Align {

    /** Flush left. The printer default. */
    LEFT,

    /** Centred within the paper width. */
    CENTER,

    /** Flush right. */
    RIGHT
}
