package fi.natroutter.fenpos.enums;

/**
 * Byte sequence written after each rendered line.
 * <p>
 * Most ESC/POS printers advance on a bare {@code LF}, but some serial firmware expects
 * {@code CRLF}, and a caller composing an exact byte stream may want no terminator at all.
 */
public enum Linefeed {

    /** A single {@code 0x0A}. The usual choice. */
    LF(new byte[]{0x0A}),

    /** {@code 0x0D 0x0A}, for firmware that requires an explicit carriage return. */
    CRLF(new byte[]{0x0D, 0x0A}),

    /** No terminator; lines run together unless the content advances the paper itself. */
    NONE(new byte[0]);

    private final byte[] bytes;

    Linefeed(byte[] bytes) {
        this.bytes = bytes;
    }

    /**
     * Returns the terminator bytes.
     *
     * @return a fresh copy, so a caller cannot mutate the shared constant
     */
    public byte[] bytes() {
        return bytes.clone();
    }
}
