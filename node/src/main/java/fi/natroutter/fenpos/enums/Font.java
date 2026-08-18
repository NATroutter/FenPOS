package fi.natroutter.fenpos.enums;

/**
 * Built-in printer font.
 * <p>
 * Font B is physically narrower than font A, so a device fits more columns in it. ThermAPI
 * wraps against the device's configured {@code columns}, which describes font A, so text in
 * font B wraps earlier than it strictly needs to rather than risking overflow.
 */
public enum Font {

    /** The default font. */
    A,

    /** The narrow font. */
    B
}
