package fi.natroutter.fenpos.markup;

import java.util.Optional;
import java.util.Set;

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
    BOLD("bold", Kind.PAIRED, Set.of()),

    /** Underline; {@code weight} selects the printer's second, heavier one. */
    UNDERLINE("underline", Kind.PAIRED, Set.of("weight")),

    /** White on black. */
    INVERT("invert", Kind.PAIRED, Set.of()),

    /** Character multipliers, {@code width} and {@code height}; either alone leaves the other at 1. */
    SIZE("size", Kind.PAIRED, Set.of("width", "height")),

    /** A face: one of the printer's own by letter. A stored font is the server's to draw. */
    TEXT("text", Kind.PAIRED, Set.of("font", "size")),

    /** Line justification, {@code to}. Paired, and required to enclose the whole line. */
    ALIGN("align", Kind.PAIRED, Set.of("to")),

    /** Break this line at the paper width. Paired, and required to enclose the whole line. */
    WRAP("wrap", Kind.PAIRED, Set.of()),

    /** Print this line as written. Paired, and required to enclose the whole line. */
    NOWRAP("nowrap", Kind.PAIRED, Set.of()),

    /**
     * Pad to the paper's width with {@code char}, a space when it is left off.
     * <p>
     * The one tag whose printed width is not knowable from the line: it stands for however many
     * columns are left over, which is a property of the device. See {@code FillResolver}.
     */
    FILL("fill", Kind.VOID, Set.of("char")),

    /** Cut the paper, fully unless {@code mode} says partial. */
    CUT("cut", Kind.VOID, Set.of("mode")),

    /** Advance the paper by {@code lines}. */
    FEED("feed", Kind.VOID, Set.of("lines")),

    /** A full-width horizontal rule. Required to be alone on its line. */
    HR("hr", Kind.VOID, Set.of()),

    /** A QR code; {@code size} is dots per module, 1-16. */
    QR("qr", Kind.PAIRED, Set.of("size")),

    /** A linear barcode of the symbology {@code type} names. */
    BARCODE("barcode", Kind.PAIRED, Set.of("type")),

    /** A PDF417 symbol; {@code level} is the error-correction level, 0-8. */
    PDF417("pdf417", Kind.PAIRED, Set.of("level")),

    /**
     * A stored image, printed {@code width} percent of the paper wide, 1-100.
     * <p>
     * The name is the content rather than an attribute because that is the shape the panel settled
     * on, and the two grammars are ports of each other. There the content may also be an
     * {@code http(s)} URL, which routinely contains {@code =} and may contain {@code >}; here it can
     * only ever name a stored image, because this agent has no fetch path.
     */
    IMAGE("image", Kind.PAIRED, Set.of("width"));

    /** Whether a tag wraps content or stands alone. */
    public enum Kind {
        /** Opens with {@code <name>} and must be closed with {@code </name>}. */
        PAIRED,
        /** Stands alone; writing {@code </name>} for one is an error. */
        VOID
    }

    private final String tagName;
    private final Kind kind;
    private final Set<String> attributes;

    Tag(String tagName, Kind kind, Set<String> attributes) {
        this.tagName = tagName;
        this.kind = kind;
        this.attributes = attributes;
    }

    /** Returns the lowercase name as written in markup. */
    public String tagName() {
        return tagName;
    }

    /** Returns whether this tag wraps content or stands alone. */
    public Kind kind() {
        return kind;
    }

    /** Returns the attribute names this tag accepts, lowercase; empty for a tag that takes none. */
    public Set<String> attributes() {
        return attributes;
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
