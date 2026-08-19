package fi.natroutter.fenpos.markup;

import fi.natroutter.fenpos.enums.Align;
import fi.natroutter.fenpos.enums.Font;
import fi.natroutter.fenpos.markup.model.Directive;
import fi.natroutter.fenpos.markup.model.Line;
import fi.natroutter.fenpos.markup.model.Span;
import fi.natroutter.fenpos.markup.model.SpanStyle;
import fi.natroutter.fenpos.util.Enums;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.List;

/**
 * Turns one {@code data} element into a {@link Line} of styled spans and directives.
 * <p>
 * The parser is the boundary that makes the rest of the system safe: markup is the only way
 * a caller can influence printer state, and every byte the printer would read as a command
 * either comes from a recognised tag or is rejected here. A raw control character is never
 * passed through, so a request cannot desynchronise the device.
 * <p>
 * A single left-to-right pass produces spans carrying fully resolved styles. Control
 * characters are detected during that same pass rather than in a separate sweep, so the
 * reported problem is always the earliest one in the element — which is the one a user
 * needs to fix first.
 * <p>
 * Instances are not shared: {@link #parse(String)} creates one per element, so the class
 * carries per-parse state without being thread-unsafe.
 */
public final class MarkupParser {

    /** Highest permitted character multiplier, imposed by ESC/POS {@code GS !}. */
    private static final int MAX_SIZE_MULTIPLIER = 8;

    /** Highest permitted feed distance, imposed by ESC/POS {@code ESC d}. */
    private static final int MAX_FEED_LINES = 255;

    private final String source;

    private final List<Span> spans = new ArrayList<>();
    private final List<Directive> directives = new ArrayList<>();
    private final Deque<OpenTag> open = new ArrayDeque<>();
    private final StringBuilder pending = new StringBuilder();

    private SpanStyle style = SpanStyle.PLAIN;
    private Align align = Align.LEFT;

    /** Whether an alignment tag has been seen; a second one is an error. */
    private boolean alignSeen;

    /** Whether a wrap tag has been seen; {@code <wrap>} and {@code <nowrap>} share one slot. */
    private boolean wrapSeen;

    /** What this line was asked to do about wrapping; null defers to the device. */
    private Boolean wrap;

    /** The line-owning tag that has closed, if any: content after it is out of scope. */
    private String closedOwnerName;
    private MarkupError closedOwnerError;

    /** Column of the rule tag, or 0 if none, used to report a scope violation. */
    private int ruleColumn;

    /** Source column where the text currently accumulating in {@link #pending} began. */
    private int pendingColumn = 1;

    private int index;

    private MarkupParser(String source) {
        this.source = source;
    }

    /**
     * Parses one element of the request's {@code data} array.
     *
     * @param source the element text, as supplied by the client
     * @return the parsed line; a blank element yields a line with no spans
     * @throws MarkupException if the element is malformed, carrying the column at fault
     */
    public static Line parse(String source) throws MarkupException {
        return new MarkupParser(source == null ? "" : source).run();
    }

    private Line run() throws MarkupException {
        while (index < source.length()) {
            char current = source.charAt(index);
            switch (current) {
                case '<' -> readTag();
                case '&' -> readEntity();
                default -> readText(current);
            }
        }

        flushPending();

        if (!open.isEmpty()) {
            OpenTag unclosed = open.peek();
            throw new MarkupException(MarkupError.UNCLOSED_TAG, unclosed.column(),
                    unclosed.tag().tagName(),
                    "Tag <" + unclosed.tag().tagName() + "> was never closed");
        }

        verifyRuleScope();

        return new Line(align, wrap, spans, directives);
    }

    // -------------------------------------------------------------------------
    // Text
    // -------------------------------------------------------------------------

    private void readText(char current) throws MarkupException {
        if (isControl(current)) {
            throw new MarkupException(MarkupError.CONTROL_CHARACTER, index + 1,
                    String.format("U+%04X", (int) current),
                    "Control characters cannot be printed; use markup tags for formatting");
        }
        requireInsideLineScope(index + 1);
        beginPendingAt(index + 1);
        pending.append(current);
        index++;
    }

    /**
     * Decodes {@code &lt;} and {@code &amp;}. Any other ampersand is literal text, because
     * receipts legitimately contain "Fish & Chips" and rejecting that would be surprising.
     */
    private void readEntity() throws MarkupException {
        if (source.startsWith("&lt;", index)) {
            emitEntity('<', 4);
            return;
        }
        if (source.startsWith("&amp;", index)) {
            emitEntity('&', 5);
            return;
        }
        readText('&');
    }

    /**
     * Emits one decoded entity as a span of its own.
     * <p>
     * Isolating it keeps every other span's characters contiguous in the source, which is
     * what lets {@link Span#columnAt(int)} report an exact column: an entity consumes more
     * source characters than it produces, so a span spanning one could not be measured by
     * simple arithmetic.
     *
     * @param decoded       the character the entity stands for
     * @param sourceLength  how many source characters the entity occupies
     */
    private void emitEntity(char decoded, int sourceLength) throws MarkupException {
        requireInsideLineScope(index + 1);
        flushPending();
        spans.add(new Span(String.valueOf(decoded), style, index + 1));
        index += sourceLength;
    }

    /** Records where the current run of text started, if it has not started already. */
    private void beginPendingAt(int column) {
        if (pending.isEmpty()) {
            pendingColumn = column;
        }
    }

    private void flushPending() {
        if (pending.isEmpty()) {
            return;
        }
        spans.add(new Span(pending.toString(), style, pendingColumn));
        pending.setLength(0);
    }

    // -------------------------------------------------------------------------
    // Tags
    // -------------------------------------------------------------------------

    private void readTag() throws MarkupException {
        int startColumn = index + 1;
        int close = source.indexOf('>', index);
        if (close < 0) {
            throw new MarkupException(MarkupError.UNKNOWN_TAG, startColumn,
                    source.substring(index),
                    "Unterminated tag; write &lt; for a literal '<'");
        }

        String body = source.substring(index + 1, close);
        index = close + 1;

        if (body.startsWith("/")) {
            closeTag(body.substring(1), startColumn);
        } else {
            openTag(body, startColumn);
        }
    }

    private void openTag(String body, int column) throws MarkupException {
        int equals = body.indexOf('=');
        String name = equals < 0 ? body : body.substring(0, equals);
        String argument = equals < 0 ? null : body.substring(equals + 1);

        Tag tag = Tag.byName(name).orElseThrow(() -> new MarkupException(
                MarkupError.UNKNOWN_TAG, column, name,
                "Unknown tag '" + name + "'; write &lt; for a literal '<'"));

        requireArgumentPolicy(tag, argument, column);

        if (tag.kind() == Tag.Kind.VOID) {
            appendDirective(tag, argument, column);
            return;
        }

        flushPending();

        if (tag == Tag.ALIGN) {
            openAlign(argument, column);
            return;
        }

        if (tag == Tag.WRAP || tag == Tag.NOWRAP) {
            openWrap(tag, column);
            return;
        }

        requireInsideLineScope(column);
        open.push(new OpenTag(tag, column, style));
        style = applyStyle(tag, argument, column);
    }

    private void closeTag(String name, int column) throws MarkupException {
        Tag tag = Tag.byName(name).orElseThrow(() -> new MarkupException(
                MarkupError.UNKNOWN_TAG, column, name, "Unknown tag '" + name + "'"));

        if (tag.kind() == Tag.Kind.VOID) {
            throw new MarkupException(MarkupError.UNEXPECTED_CLOSE_TAG, column, tag.tagName(),
                    "<" + tag.tagName() + "> stands alone and cannot be closed");
        }

        flushPending();

        if (tag == Tag.ALIGN) {
            closeAlign(column);
            return;
        }

        if (tag == Tag.WRAP || tag == Tag.NOWRAP) {
            closeWrap(tag, column);
            return;
        }

        OpenTag current = open.peek();
        if (current == null || current.tag() != tag) {
            String expected = current == null
                    ? "no tag is open"
                    : "expected </" + current.tag().tagName() + ">";
            throw new MarkupException(MarkupError.UNEXPECTED_CLOSE_TAG, column, tag.tagName(),
                    "</" + tag.tagName() + "> does not match: " + expected);
        }

        open.pop();
        style = current.styleBefore();
    }

    /**
     * Applies a tag's effect to the current style.
     *
     * @throws MarkupException if the argument is malformed or out of range
     */
    private SpanStyle applyStyle(Tag tag, String argument, int column) throws MarkupException {
        return switch (tag) {
            case BOLD -> style.withBold(true);
            case INVERT -> style.withInvert(true);
            case UNDERLINE -> style.withUnderline(
                    argument == null ? 1 : requireInt(argument, 1, 2, tag, column));
            case SIZE -> applySize(argument, column);
            case FONT -> style.withFont(Enums.parse(Font.class, argument).orElseThrow(
                    () -> argumentError(tag, column, "must be 'a' or 'b'")));
            case ALIGN, WRAP, NOWRAP, CUT, FEED, HR -> throw new IllegalStateException(
                    "Tag " + tag + " does not carry a span style");
        };
    }

    private SpanStyle applySize(String argument, int column) throws MarkupException {
        String[] parts = argument.split(",", -1);
        if (parts.length > 2) {
            throw argumentError(Tag.SIZE, column, "expected W or W,H");
        }
        int width = requireInt(parts[0], 1, MAX_SIZE_MULTIPLIER, Tag.SIZE, column);
        int height = parts.length == 1
                ? width
                : requireInt(parts[1], 1, MAX_SIZE_MULTIPLIER, Tag.SIZE, column);
        return style.withSize(width, height);
    }

    // -------------------------------------------------------------------------
    // Alignment
    // -------------------------------------------------------------------------

    private void openAlign(String argument, int column) throws MarkupException {
        if (alignSeen) {
            throw new MarkupException(MarkupError.INVALID_ALIGN_SCOPE, column, "align",
                    "Only one <align> is allowed per line");
        }
        requireLineOwnerCanOpen("align", MarkupError.INVALID_ALIGN_SCOPE, column);

        align = Enums.parse(Align.class, argument).orElseThrow(
                () -> argumentError(Tag.ALIGN, column, "must be 'left', 'center' or 'right'"));
        alignSeen = true;
        open.push(new OpenTag(Tag.ALIGN, column, style));
    }

    private void closeAlign(int column) throws MarkupException {
        OpenTag current = open.peek();
        if (current == null || current.tag() != Tag.ALIGN) {
            throw new MarkupException(MarkupError.UNEXPECTED_CLOSE_TAG, column, "align",
                    "</align> does not match any open <align>");
        }
        open.pop();
        style = current.styleBefore();
        closedOwnerName = "align";
        closedOwnerError = MarkupError.INVALID_ALIGN_SCOPE;
    }

    // -------------------------------------------------------------------------
    // Wrapping
    // -------------------------------------------------------------------------

    /**
     * Opens {@code <wrap>} or {@code <nowrap>}.
     * <p>
     * Both occupy one slot: a line either wraps or it does not, so writing both is a
     * contradiction rather than a refinement.
     */
    private void openWrap(Tag tag, int column) throws MarkupException {
        if (wrapSeen) {
            throw new MarkupException(MarkupError.INVALID_WRAP_SCOPE, column, tag.tagName(),
                    "Only one <wrap> or <nowrap> is allowed per line");
        }
        requireLineOwnerCanOpen(tag.tagName(), MarkupError.INVALID_WRAP_SCOPE, column);

        wrap = tag == Tag.WRAP;
        wrapSeen = true;
        open.push(new OpenTag(tag, column, style));
    }

    private void closeWrap(Tag tag, int column) throws MarkupException {
        OpenTag current = open.peek();
        if (current == null || current.tag() != tag) {
            throw new MarkupException(MarkupError.UNEXPECTED_CLOSE_TAG, column, tag.tagName(),
                    "</" + tag.tagName() + "> does not match any open <" + tag.tagName() + ">");
        }
        open.pop();
        style = current.styleBefore();
        closedOwnerName = tag.tagName();
        closedOwnerError = MarkupError.INVALID_WRAP_SCOPE;
    }

    /**
     * Rejects content appearing after a line-owning tag has closed.
     * <p>
     * Alignment and wrapping both apply to a whole printed line, so text outside the tag would
     * silently inherit a property the author did not write.
     */
    private void requireInsideLineScope(int column) throws MarkupException {
        if (closedOwnerName != null) {
            throw new MarkupException(closedOwnerError, column, closedOwnerName,
                    "<" + closedOwnerName + "> must enclose the whole line, so nothing may follow </"
                            + closedOwnerName + ">");
        }
    }

    /**
     * Rejects a line-owning tag that cannot legally open here.
     * <p>
     * Another line-owning tag may already be open — that is the nesting the language allows,
     * in either order — but text or a directive before it means the tag does not own the
     * line. So does opening inside a styling tag: styling adds nothing to {@code spans} or
     * {@code directives} until it closes, so without this check {@code <bold><nowrap>} would
     * slip past undetected.
     */
    private void requireLineOwnerCanOpen(String name, MarkupError error, int column)
            throws MarkupException {
        requireInsideLineScope(column);
        boolean precededByContent = !spans.isEmpty() || !directives.isEmpty();
        boolean nestedInsideStyling = open.stream().anyMatch(entry -> !isLineOwningTag(entry.tag()));
        if (precededByContent || nestedInsideStyling) {
            throw new MarkupException(error, column, name,
                    "<" + name + "> must enclose the whole line, so nothing may precede it");
        }
    }

    /**
     * Returns whether a tag applies to a whole printed line, as opposed to styling a run of
     * text. {@code <align>}, {@code <wrap>} and {@code <nowrap>} may nest each other in any
     * order; nesting one inside a styling tag is not "enclosing the whole line" and must be
     * refused.
     */
    private static boolean isLineOwningTag(Tag tag) {
        return tag == Tag.ALIGN || tag == Tag.WRAP || tag == Tag.NOWRAP;
    }

    // -------------------------------------------------------------------------
    // Directives
    // -------------------------------------------------------------------------

    private void appendDirective(Tag tag, String argument, int column) throws MarkupException {
        requireInsideLineScope(column);
        switch (tag) {
            case CUT -> directives.add(new Directive.Cut(cutMode(argument, column)));
            case FEED -> directives.add(new Directive.Feed(
                    requireInt(argument, 1, MAX_FEED_LINES, Tag.FEED, column)));
            case HR -> {
                ruleColumn = column;
                directives.add(new Directive.Rule());
            }
            default -> throw new IllegalStateException("Tag " + tag + " is not a directive");
        }
    }

    private Directive.Cut.Mode cutMode(String argument, int column) throws MarkupException {
        if (argument == null || argument.equalsIgnoreCase("full")) {
            return Directive.Cut.Mode.FULL;
        }
        if (argument.equalsIgnoreCase("partial")) {
            return Directive.Cut.Mode.PARTIAL;
        }
        throw argumentError(Tag.CUT, column, "must be 'full' or 'partial'");
    }

    /**
     * Rejects a rule sharing its element with anything else.
     * <p>
     * A rule expands to the full paper width, so combining it with text would overflow the
     * line by construction rather than by accident.
     */
    private void verifyRuleScope() throws MarkupException {
        boolean hasRule = directives.stream().anyMatch(Directive.Rule.class::isInstance);
        if (hasRule && (!spans.isEmpty() || directives.size() > 1)) {
            throw new MarkupException(MarkupError.INVALID_RULE_SCOPE, ruleColumn, "hr",
                    "<hr> fills the paper width and must be alone in its line");
        }
    }

    // -------------------------------------------------------------------------
    // Shared checks
    // -------------------------------------------------------------------------

    private void requireArgumentPolicy(Tag tag, String argument, int column) throws MarkupException {
        boolean supplied = argument != null;
        if (supplied && tag.argument() == Tag.Argument.NONE) {
            throw argumentError(tag, column, "takes no argument");
        }
        if (!supplied && tag.argument() == Tag.Argument.REQUIRED) {
            throw argumentError(tag, column, "requires an argument, written <"
                    + tag.tagName() + "=value>");
        }
        if (supplied && argument.isEmpty()) {
            throw argumentError(tag, column, "has an empty argument");
        }
    }

    private int requireInt(String value, int min, int max, Tag tag, int column)
            throws MarkupException {
        int parsed;
        try {
            parsed = Integer.parseInt(value.strip());
        } catch (NumberFormatException e) {
            throw argumentError(tag, column, "'" + value + "' is not a number");
        }
        if (parsed < min || parsed > max) {
            throw argumentError(tag, column, "must be between " + min + " and " + max
                    + ", got " + parsed);
        }
        return parsed;
    }

    private MarkupException argumentError(Tag tag, int column, String detail) {
        return new MarkupException(MarkupError.INVALID_TAG_ARGUMENT, column, tag.tagName(),
                "<" + tag.tagName() + "> " + detail);
    }

    /**
     * Returns whether a character would be consumed by the printer as a command rather than
     * printed. Covers C0 (including tab, whose behaviour depends on printer-side tab stops
     * that the agent does not manage), DEL, and C1.
     */
    private static boolean isControl(char value) {
        return value < 0x20 || value == 0x7F || (value >= 0x80 && value <= 0x9F);
    }

    /**
     * A paired tag currently open, remembering the style to restore when it closes.
     * Restoring a captured style is what makes nesting work without re-deriving the style
     * from the remaining stack.
     */
    private record OpenTag(Tag tag, int column, SpanStyle styleBefore) {
    }
}
