package fi.natroutter.fenpos.enums;

/**
 * What to do with a character the device's codepage cannot represent.
 */
public enum UnsupportedPolicy {

    /**
     * Refuse the whole request, naming the offending line, column and character.
     * The default: a receipt silently missing a character is harder to notice than a
     * request that failed.
     */
    REJECT,

    /** Substitute {@code ?} and print anyway. */
    REPLACE,

    /** Drop the character and print anyway. */
    STRIP
}
