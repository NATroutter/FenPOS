package fi.natroutter.fenpos.enums;

import java.nio.charset.Charset;

/**
 * Single-byte character tables a printer can be switched to.
 * <p>
 * A thermal printer holds one active table at a time and interprets every byte it receives
 * through it, so the choice fixes which characters a device can physically print.
 * {@code CP858} is the usual choice in Europe: it is the only IBM table here carrying both
 * {@code €} and the Nordic vowels.
 * <p>
 * Each constant names a JDK {@link Charset} that maps Unicode onto that table. The charset
 * is what makes precise validation possible — its encoder reports exactly which character
 * cannot be represented, which is the basis of the {@code unsupported_character} error.
 */
public enum Codepage {

    /** USA and standard Europe. No {@code €}. */
    CP437("IBM437"),

    /** Multilingual Latin-1. No {@code €}. */
    CP850("IBM850"),

    /** Latin-2, Central European. */
    CP852("IBM852"),

    /** Turkish. */
    CP857("IBM857"),

    /** Latin-1 with {@code €}. The recommended default in the Eurozone. */
    CP858("IBM00858"),

    /** Portuguese. */
    CP860("IBM860"),

    /** Canadian French. */
    CP863("IBM863"),

    /** Nordic. */
    CP865("IBM865"),

    /** Cyrillic. */
    CP866("IBM866"),

    /** Windows Central European. */
    CP1250("windows-1250"),

    /** Windows Cyrillic. */
    CP1251("windows-1251"),

    /** Windows Latin-1. */
    CP1252("windows-1252"),

    /** Greek. */
    ISO8859_7("ISO-8859-7");

    private final Charset charset;

    /**
     * @param charsetName JDK charset name; resolved eagerly so a wrong name fails at class
     *                    initialisation rather than on the first print request
     */
    Codepage(String charsetName) {
        this.charset = Charset.forName(charsetName);
    }

    /** Returns the JDK charset mapping Unicode onto this printer table. */
    public Charset charset() {
        return charset;
    }
}
