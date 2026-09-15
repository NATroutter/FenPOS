package fi.natroutter.fenpos.markup;

import fi.natroutter.fenpos.enums.Align;
import fi.natroutter.fenpos.enums.BarcodeSystem;

import java.util.Map;
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
    BOLD("bold", Kind.PAIRED, Map.of()),

    /** Underline; {@code weight} selects the printer's second, heavier one. */
    UNDERLINE("underline", Kind.PAIRED, AttributeSpec.table("weight", AttributeSpec.integer(1, 2))),

    /** White on black. */
    INVERT("invert", Kind.PAIRED, Map.of()),

    /** Character multipliers, {@code width} and {@code height}; either alone leaves the other at 1. */
    SIZE("size", Kind.PAIRED, AttributeSpec.table(
            "width", AttributeSpec.integer(1, 8),
            "height", AttributeSpec.integer(1, 8))),

    /** A face: one of the printer's own by letter. A stored font is the server's to draw. */
    TEXT("text", Kind.PAIRED, AttributeSpec.table(
            "font", AttributeSpec.markRequired(AttributeSpec.text(64)),
            "size", AttributeSpec.integer(8, 4096))),

    /** Line justification, {@code to}. Paired, and required to enclose the whole line. */
    ALIGN("align", Kind.PAIRED, AttributeSpec.table("to", AttributeSpec.markRequired(AttributeSpec.oneOf(Align.class)))),

    /** Break this line at the paper width. Paired, and required to enclose the whole line. */
    WRAP("wrap", Kind.PAIRED, Map.of()),

    /** Print this line as written. Paired, and required to enclose the whole line. */
    NOWRAP("nowrap", Kind.PAIRED, Map.of()),

    /**
     * Pad to the paper's width with {@code char}, a space when it is left off.
     * <p>
     * The one tag whose printed width is not knowable from the line: it stands for however many
     * columns are left over, which is a property of the device. See {@code FillResolver}.
     */
    FILL("fill", Kind.VOID, AttributeSpec.table("char", AttributeSpec.character())),

    /** Cut the paper, fully unless {@code mode} says partial. */
    CUT("cut", Kind.VOID, AttributeSpec.table("mode", AttributeSpec.oneOf("full", "partial"))),

    /** Advance the paper by {@code lines}. */
    FEED("feed", Kind.VOID, AttributeSpec.table("lines", AttributeSpec.markRequired(AttributeSpec.integer(1, 255)))),

    /** A full-width horizontal rule. Required to be alone on its line. */
    HR("hr", Kind.VOID, Map.of()),

    /** A QR code; {@code size} is dots per module. */
    QR("qr", Kind.PAIRED, AttributeSpec.table("size", AttributeSpec.integer(1, 16))),

    /** A linear barcode of the symbology {@code type} names. */
    BARCODE("barcode", Kind.PAIRED, AttributeSpec.table(
            "type", AttributeSpec.markRequired(AttributeSpec.oneOf(BarcodeSystem.class)))),

    /** A PDF417 symbol; {@code level} is the error-correction level. */
    PDF417("pdf417", Kind.PAIRED, AttributeSpec.table("level", AttributeSpec.integer(0, 8))),

    /**
     * A stored image, printed {@code width} percent of the paper wide.
     * <p>
     * The name is the content rather than an attribute because that is the shape the panel settled
     * on, and the two grammars are ports of each other. There the content may also be an
     * {@code http(s)} URL, which routinely contains {@code =} and may contain {@code >}; here it can
     * only ever name a stored image, because this agent has no fetch path.
     */
    IMAGE("image", Kind.PAIRED, AttributeSpec.table("width", AttributeSpec.integer(1, 100)));

    /** Whether a tag wraps content or stands alone. */
    public enum Kind {
        /** Opens with {@code <name>} and must be closed with {@code </name>}. */
        PAIRED,
        /** Stands alone; writing {@code </name>} for one is an error. */
        VOID
    }

    private final String tagName;
    private final Kind kind;
    private final Map<String, AttributeSpec> attributes;

    Tag(String tagName, Kind kind, Map<String, AttributeSpec> attributes) {
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

    /** Returns what each attribute this tag accepts takes, by lowercase name, in declaration order. */
    public Map<String, AttributeSpec> attributes() {
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
