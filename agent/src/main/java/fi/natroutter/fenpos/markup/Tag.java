package fi.natroutter.fenpos.markup;

import java.util.Optional;

/**
 * The complete set of markup tags.
 * <p>
 * The registry is a closed enum rather than an extensible map so that an unrecognised tag
 * is always a client error with a clear message, and never a silently ignored token that
 * would print as literal text.
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

    /** Cut the paper, fully by default. */
    CUT("cut", Kind.VOID, Argument.OPTIONAL),

    /** Advance the paper by a number of lines. */
    FEED("feed", Kind.VOID, Argument.REQUIRED),

    /** A full-width horizontal rule. Required to be alone in its element. */
    HR("hr", Kind.VOID, Argument.NONE);

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
