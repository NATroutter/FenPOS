package fi.natroutter.fenpos.markup;

import java.util.Optional;

/**
 * The complete set of markup tags.
 * <p>
 * The registry is a closed enum rather than an extensible map so that an unrecognised tag
 * is always a client error with a clear message, and never a silently ignored token that
 * would print as literal text.
 * <p>
 * Mirrors {@code TAGS} in {@code fenpos/lib/markup/tags.ts}, with one deliberate difference:
 * {@code <drawer>} is a tag there and is not one here. Markup parsed on this side comes from the
 * agent's own console and from {@code TestPage}, neither of which has any business firing a cash
 * drawer — a diagnostic print that pops the till is a worse diagnostic. Leaving the tag out is
 * what makes that unreachable rather than merely unwritten. Jobs that legitimately open a drawer
 * are compiled on the server and arrive as a directive over the link, which never passes through
 * this registry.
 */
public enum Tag {

    /** Emphasis. */
    BOLD("bold", Kind.PAIRED, Argument.NONE),

    /** Underline, optionally selecting the printer's second weight. */
    UNDERLINE("underline", Kind.PAIRED, Argument.OPTIONAL),

    /** White on black. */
    INVERT("invert", Kind.PAIRED, Argument.NONE),

    /** Character multipliers, as {@code W,H} or a single value used for both. */
    SIZE("size", Kind.PAIRED, Argument.REQUIRED),

    /** Built-in font selection. */
    FONT("font", Kind.PAIRED, Argument.REQUIRED),

    /** Line justification. Paired, and required to enclose the whole element. */
    ALIGN("align", Kind.PAIRED, Argument.REQUIRED),

    /** Break this line at the paper width. Paired, and required to enclose the whole element. */
    WRAP("wrap", Kind.PAIRED, Argument.NONE),

    /** Print this line as written. Paired, and required to enclose the whole element. */
    NOWRAP("nowrap", Kind.PAIRED, Argument.NONE),

    /**
     * Pad to the paper's width. Argument is the character to repeat, default a space.
     * <p>
     * The one tag whose printed width is not knowable from the element: it stands for however many
     * columns are left over, which is a property of the device. See {@code FillResolver}.
     */
    FILL("fill", Kind.VOID, Argument.OPTIONAL),

    /** Cut the paper, fully by default. */
    CUT("cut", Kind.VOID, Argument.OPTIONAL),

    /** Advance the paper by a number of lines. */
    FEED("feed", Kind.VOID, Argument.REQUIRED),

    /** A full-width horizontal rule. Required to be alone in its element. */
    HR("hr", Kind.VOID, Argument.NONE),

    /** A QR code. Argument is the module size, 1-16. */
    QR("qr", Kind.PAIRED, Argument.OPTIONAL),

    /** A linear barcode. Argument is the symbology. */
    BARCODE("barcode", Kind.PAIRED, Argument.REQUIRED),

    /** A PDF417 symbol. Argument is the error-correction level, 0-8. */
    PDF417("pdf417", Kind.PAIRED, Argument.OPTIONAL),

    /**
     * A stored image. Argument is the printed width as a percentage of the paper, 1-100.
     * <p>
     * Paired rather than {@code <image=logo>} because that is the shape the panel settled on, and
     * the two grammars are ports of each other. There the content may also be an {@code http(s)}
     * URL, which routinely contains {@code =} and may contain {@code >}; here it can only ever
     * name a stored image, because this agent has no fetch path.
     */
    IMAGE("image", Kind.PAIRED, Argument.OPTIONAL);

    /** Whether a tag wraps content or stands alone. */
    public enum Kind {
        /** Opens with {@code <name>} and must be closed with {@code </name>}. */
        PAIRED,
        /** Stands alone; writing {@code </name>} for one is an error. */
        VOID
    }

    /** Whether a tag accepts a {@code =value} argument. */
    public enum Argument {
        /** Supplying one is an error. */
        NONE,
        /** May be supplied; a documented default applies when it is not. */
        OPTIONAL,
        /** Omitting one is an error. */
        REQUIRED
    }

    private final String tagName;
    private final Kind kind;
    private final Argument argument;

    Tag(String tagName, Kind kind, Argument argument) {
        this.tagName = tagName;
        this.kind = kind;
        this.argument = argument;
    }

    /** Returns the lowercase name as written in markup. */
    public String tagName() {
        return tagName;
    }

    /** Returns whether this tag wraps content or stands alone. */
    public Kind kind() {
        return kind;
    }

    /** Returns whether this tag accepts a {@code =value} argument. */
    public Argument argument() {
        return argument;
    }

    /**
     * Returns whether this tag encloses data rather than text to be printed.
     * <p>
     * The block tags are paired like a styling tag but behave nothing like one: what they enclose
     * is the payload of a symbology, or the name of a stored image, so it is captured verbatim
     * into a directive instead of becoming styled spans. Naming the set here keeps the parser's
     * several checks on it in step.
     *
     * @return true when the tag's content is data rather than text
     */
    public boolean isBlock() {
        return this == QR || this == BARCODE || this == PDF417 || this == IMAGE;
    }

    /**
     * Resolves a tag by the name written in markup, ignoring case.
     *
     * @param name candidate tag name
     * @return the tag, or empty if no such tag exists
     */
    public static Optional<Tag> byName(String name) {
        if (name == null || name.isEmpty()) {
            return Optional.empty();
        }
        for (Tag tag : values()) {
            if (tag.tagName.equalsIgnoreCase(name)) {
                return Optional.of(tag);
            }
        }
        return Optional.empty();
    }
}
