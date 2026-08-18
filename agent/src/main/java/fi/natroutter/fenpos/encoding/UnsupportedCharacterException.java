package fi.natroutter.fenpos.encoding;

import fi.natroutter.fenpos.enums.Codepage;

/**
 * Thrown when text contains a character the device's codepage cannot represent and the
 * device's policy is to reject rather than substitute.
 * <p>
 * Carries the offending character itself as well as its position, because the position
 * alone is often not enough: an invisible or unfamiliar character is far easier to act on
 * when the error names it.
 */
public class UnsupportedCharacterException extends Exception {

    /** Stable code placed in the API response's {@code error} field. */
    public static final String API_CODE = "unsupported_character";

    private final String character;
    private final int column;
    private final Codepage codepage;

    /**
     * @param character the whole offending character, including both halves of a surrogate
     *                  pair, so it renders correctly in a client's error message
     * @param column    1-based column within the original element
     * @param codepage  the table that cannot represent it
     */
    public UnsupportedCharacterException(String character, int column, Codepage codepage) {
        super("Character '" + character + "' at column " + column
                + " is not available in codepage " + codepage.name());
        this.character = character;
        this.column = column;
        this.codepage = codepage;
    }

    /** Returns the whole offending character. */
    public String character() {
        return character;
    }

    /** Returns the 1-based column within the original element. */
    public int column() {
        return column;
    }

    /** Returns the codepage that cannot represent the character. */
    public Codepage codepage() {
        return codepage;
    }
}
