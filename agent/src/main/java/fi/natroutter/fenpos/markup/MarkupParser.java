package fi.natroutter.fenpos.markup;

import fi.natroutter.fenpos.enums.Align;
import fi.natroutter.fenpos.enums.BarcodeSystem;
import fi.natroutter.fenpos.enums.Font;
import fi.natroutter.fenpos.markup.model.Directive;
import fi.natroutter.fenpos.markup.model.Fill;
import fi.natroutter.fenpos.markup.model.Line;
import fi.natroutter.fenpos.markup.model.Span;
import fi.natroutter.fenpos.markup.model.SpanStyle;
import fi.natroutter.fenpos.util.Enums;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.List;
import java.util.Optional;

/**
 * Turns the request's {@code data} string into one {@link Line} per line of the document.
 * <p>
 * The parser is the boundary that makes the rest of the system safe: markup is the only way
 * a caller can influence printer state, and every byte the printer would read as a command
 * either comes from a recognised tag or is rejected here. A raw control character is never
 * passed through, so a request cannot desynchronise the device.
 * <p>
 * A single left-to-right pass over the whole document produces spans carrying fully resolved
 * styles, splitting a new {@link Line} at every {@code \n}. Control characters are detected
 * during that same pass rather than in a separate sweep, so the reported problem is always
 * the earliest one in the document — which is the one a user needs to fix first. A tag such
 * as {@code <bold>} or {@code <align>} may open on one line and close on a later one, in which
 * case every line it covers carries its effect.
 * <p>
 * Instances are not shared: {@link #parseDocument(String)} creates one per document, so the
 * class carries per-parse state without being thread-unsafe.
 * <p>
 * A port of {@code fenpos/lib/markup/parser.ts}, and the two must not drift — a tag the panel
 * accepts and this refuses is a job that previews cleanly and then fails behind a printer. Two
 * differences are deliberate. {@code <drawer>} exists there and not here, so nothing printed from
 * this agent's console can fire a till. And a block tag here is emitted rather than measured:
 * there is no symbol encoder and no image decoder on this side, which is why an {@code <image>}
 * resolves only against rasters the server already synced, and why {@code PrintCompiler} charges
 * a symbol nothing against its line budget. Both are documented where they bite.
 */
public final class MarkupParser {

    /** Highest permitted character multiplier, imposed by ESC/POS {@code GS !}. */
    private static final int MAX_SIZE_MULTIPLIER = 8;

    /** Highest permitted feed distance, imposed by ESC/POS {@code ESC d}. */
    private static final int MAX_FEED_LINES = 255;

    /** Dots per QR module when {@code <qr>} carries no argument. Mirrors the panel's default. */
    private static final int DEFAULT_QR_MODULE_SIZE = 6;

    /** Largest QR module size, imposed by ESC/POS {@code GS ( k} function 167. */
    private static final int MAX_QR_MODULE_SIZE = 16;

    /** PDF417 error-correction level when {@code <pdf417>} carries no argument. */
    private static final int DEFAULT_PDF417_ERROR_LEVEL = 1;

    /** Highest PDF417 error-correction level, imposed by ESC/POS {@code GS ( k} function 069. */
    private static final int MAX_PDF417_ERROR_LEVEL = 8;

    /**
     * Data columns every PDF417 written in this parser's markup is laid out with.
     * <p>
     * A fixed number rather than a measured one, and that is the compromise this side accepts.
     * {@link Directive.Pdf417} must state a column count — leaving it at zero lets the firmware
     * pick a layout, which is the drift the field was added to close — but working out the layout
     * an encoder would choose means running one, and there is no PDF417 encoder here by design.
     * <p>
     * Three is the widest layout that fits the narrowest paper this system prints on: a row of
     * {@code n} data columns is {@code 17 * (n + 4) + 1} modules across at three dots each, so
     * three columns is 360 dots and 58mm paper has 384. Content longer than three columns hold
     * prints as more rows rather than being refused, which costs paper and never correctness.
     * <p>
     * The consequence to know about: the same markup previewed on the panel and printed from here
     * can produce symbols of different shapes — the panel measures what its encoder chose, which
     * for short content is usually fewer columns and more rows. Both encode the same string and
     * both scan to it. The panel measures the real layout and sends it, so a job compiled there is
     * unaffected.
     */
    private static final int PDF417_DATA_COLUMNS = 3;

    /** Narrowest image this system will print, as a percentage of the paper. */
    private static final int MIN_IMAGE_WIDTH_PERCENT = 1;

    /** Widest an image may be printed: the whole printable width, which the paper cannot exceed. */
    private static final int MAX_IMAGE_WIDTH_PERCENT = 100;

    /** Printed width of {@code <image>} when it carries no argument. */
    private static final int DEFAULT_IMAGE_WIDTH_PERCENT = MAX_IMAGE_WIDTH_PERCENT;

    /**
     * Highest code point a symbol's payload may contain.
     * <p>
     * The renderer declares a symbol's length in characters and sends it as UTF-8 bytes, so a
     * payload outside ASCII encodes to more bytes than were declared and prints as a symbol that
     * scans wrongly. Refused here, at a column, rather than on paper.
     */
    private static final int SYMBOL_MAX_CODE_POINT = 0x7F;

    private final String source;

    /** Where the dots for an {@code <image>} come from; holds nothing when there is no device. */
    private final ImageResolver images;

    private List<Span> spans = new ArrayList<>();
    private List<Fill> fills = new ArrayList<>();
    private List<Directive> directives = new ArrayList<>();
    private final Deque<OpenTag> open = new ArrayDeque<>();
    private final StringBuilder pending = new StringBuilder();

    /** Every line finished so far, in document order. */
    private final List<Line> lines = new ArrayList<>();

    /** 1-based line of the document the scanner is currently reading. */
    private int line = 1;

    /** Index into {@link #source} where the current line began, for {@link #column()}. */
    private int lineStart = 0;

    private SpanStyle style = SpanStyle.PLAIN;
    private Align align = Align.LEFT;

    /**
     * Whether an alignment tag is currently open; a second one while this is true is an error.
     * Cleared the moment the open one closes — not at the end of the line — so a later line may
     * open its own. A second {@code <align>} written later on the same line it closed on is still
     * refused, just by {@link #requireLineOwnerCanOpen}'s {@code closedOwnerName} check instead
     * of this one.
     */
    private boolean alignSeen;

    /**
     * Whether a wrap tag is currently open; {@code <wrap>} and {@code <nowrap>} share one slot.
     * Cleared and refused exactly as {@link #alignSeen} is.
     */
    private boolean wrapSeen;

    /** What this line was asked to do about wrapping; null defers to the device. */
    private Boolean wrap;

    /** Whether {@link #align} must fall back to {@link Align#LEFT} once the current line ends. */
    private boolean pendingAlignReset;

    /** Whether {@link #wrap} must fall back to {@code null} once the current line ends. */
    private boolean pendingWrapReset;

    /** The line-owning tag that has closed, if any: content after it is out of scope. */
    private String closedOwnerName;
    private MarkupError closedOwnerError;

    /**
     * The block tag currently open, or null when the scanner is reading ordinary text.
     * <p>
     * Its presence is what diverts characters away from {@link #pending}, so it is checked by
     * every path that would otherwise produce a span.
     */
    private OpenBlock block;

    /**
     * The first directive that must occupy its printed line alone, used to report a violation.
     * <p>
     * The first rather than the last, matching this parser's habit of naming the earliest problem
     * in the element. The error kind travels with it because {@code <hr>} and the blocks report
     * different ones, both of which are frozen parts of the API contract.
     */
    private SoleOccupant soleOccupant;

    /** Source column where the text currently accumulating in {@link #pending} began. */
    private int pendingColumn = 1;

    private int index;

    private MarkupParser(String source, ImageResolver images) {
        // \r\n is normalised to \n before anything else sees it, so a line boundary is always
        // exactly one character and every column computed downstream of it is exact.
        this.source = (source == null ? "" : source).replace("\r\n", "\n");
        this.images = images;
    }

    /**
     * Parses the request's {@code data} document, with no images available.
     * <p>
     * An {@code <image>} tag is still recognised and still checked; it simply cannot resolve, and
     * says so. Callers holding a device should use {@link #parseDocument(String, ImageResolver)}.
     *
     * @param source the document text, as supplied by the client: one printed line per line
     * @return the parsed lines, one per line of the document; a blank document yields a single
     *         line with no spans
     * @throws MarkupException if the document is malformed, carrying the line and column at fault
     */
    public static List<Line> parseDocument(String source) throws MarkupException {
        return parseDocument(source, ImageResolver.NONE);
    }

    /**
     * Parses the request's {@code data} document.
     *
     * @param source the document text, as supplied by the client: one printed line per line
     * @param images where an {@code <image>} tag's dots come from
     * @return the parsed lines, one per line of the document; a blank document yields a single
     *         line with no spans
     * @throws MarkupException if the document is malformed, carrying the line and column at fault
     */
    public static List<Line> parseDocument(String source, ImageResolver images)
            throws MarkupException {
        return new MarkupParser(source, images).run();
    }

    /**
     * Parses one line of markup, with no images available.
     *
     * @param source one printed line, as supplied by the client
     * @return the parsed line; a blank line yields a line with no spans
     * @throws MarkupException         if the line is malformed, carrying the column at fault
     * @throws IllegalArgumentException if {@code source} holds more than one line
     */
    public static Line parse(String source) throws MarkupException {
        return parse(source, ImageResolver.NONE);
    }

    /**
     * Parses one line of markup.
     *
     * @param source one printed line, as supplied by the client
     * @param images where an {@code <image>} tag's dots come from
     * @return the parsed line; a blank line yields a line with no spans
     * @throws MarkupException         if the line is malformed, carrying the column at fault
     * @throws IllegalArgumentException if {@code source} holds more than one line
     */
    public static Line parse(String source, ImageResolver images) throws MarkupException {
        String normalised = (source == null ? "" : source).replace("\r\n", "\n");
        if (normalised.indexOf('\n') >= 0) {
            throw new IllegalArgumentException("parse takes one line; use parseDocument");
        }
        return parseDocument(normalised, images).get(0);
    }

    private List<Line> run() throws MarkupException {
        while (index < source.length()) {
            char current = source.charAt(index);
            switch (current) {
                case '<' -> readTag();
                case '&' -> readEntity();
                case '\n' -> endLine();
                default -> readText(current);
            }
        }

        if (!open.isEmpty()) {
            OpenTag unclosed = open.peek();
            throw new MarkupException(MarkupError.UNCLOSED_TAG, unclosed.line(), unclosed.column(),
                    unclosed.tag().tagName(),
                    "Tag <" + unclosed.tag().tagName() + "> was never closed");
        }

        endLine();

        return List.copyOf(lines);
    }

    /**
     * Closes out the current line: flushes any pending text, checks that a rule, a symbol or an
     * image did not have to share this line with anything else, and records the finished
     * {@link Line}. Called for every {@code \n} in the document, and once more after the loop for
     * the final line, which the document does not have to end with a newline to have.
     * <p>
     * Resets the state that is local to one printed line — the accumulated spans, fills and
     * directives, and the "something already claimed this line" trackers — but keeps whatever a
     * still-open tag is doing: {@link #open}, {@link #style}, {@link #block}, and {@link #align}
     * or {@link #wrap} while their owning tag has not closed yet. A close only schedules a
     * fallback to the default, applied here, after the line it closed on has been recorded with
     * the value that was actually in effect on it.
     */
    private void endLine() throws MarkupException {
        flushPending();
        verifyBlockScope();
        lines.add(new Line(align, wrap, spans, fills, directives));

        spans = new ArrayList<>();
        fills = new ArrayList<>();
        directives = new ArrayList<>();
        soleOccupant = null;
        closedOwnerName = null;
        closedOwnerError = null;
        pendingColumn = 1;

        if (pendingAlignReset) {
            align = Align.LEFT;
            pendingAlignReset = false;
        }
        if (pendingWrapReset) {
            wrap = null;
            pendingWrapReset = false;
        }

        index++;
        line++;
        lineStart = index;
    }

    /** Returns the 1-based column of {@link #index} within the current line. */
    private int column() {
        return index - lineStart + 1;
    }

    // -------------------------------------------------------------------------
    // Text
    // -------------------------------------------------------------------------

    private void readText(char current) throws MarkupException {
        if (isControl(current)) {
            throw new MarkupException(MarkupError.CONTROL_CHARACTER, line, column(),
                    String.format("U+%04X", (int) current),
                    "Control characters cannot be printed; use markup tags for formatting");
        }
        requireInsideLineScope(column());
        if (block != null) {
            block.content().append(current);
            index++;
            return;
        }
        beginPendingAt(column());
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
     * <p>
     * Inside a block the decoded character joins the payload instead. {@code &amp;} is the only
     * way to write an ampersand a symbology is meant to carry, so the entity has to survive into
     * the encoded content rather than into a span.
     *
     * @param decoded       the character the entity stands for
     * @param sourceLength  how many source characters the entity occupies
     */
    private void emitEntity(char decoded, int sourceLength) throws MarkupException {
        requireInsideLineScope(column());
        if (block != null) {
            block.content().append(decoded);
            index += sourceLength;
            return;
        }
        flushPending();
        spans.add(new Span(String.valueOf(decoded), style, column()));
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
        int startColumn = column();
        int close = source.indexOf('>', index);
        if (close < 0) {
            throw new MarkupException(MarkupError.UNKNOWN_TAG, line, startColumn,
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
                MarkupError.UNKNOWN_TAG, line, column, name,
                "Unknown tag '" + name + "'; write &lt; for a literal '<'"));

        if (block != null) {
            throw insideBlock(tag, column);
        }

        requireArgumentPolicy(tag, argument, column);

        // Void, but not a directive: a fill is a position in the text rather than a printer action,
        // so it never reaches appendDirective.
        if (tag == Tag.FILL) {
            appendFill(argument, column);
            return;
        }

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

        if (tag.isBlock()) {
            openBlock(tag, argument, column);
            return;
        }

        requireInsideLineScope(column);
        open.push(new OpenTag(tag, column, style, line));
        style = applyStyle(tag, argument, column);
    }

    private void closeTag(String name, int column) throws MarkupException {
        Tag tag = Tag.byName(name).orElseThrow(() -> new MarkupException(
                MarkupError.UNKNOWN_TAG, line, column, name, "Unknown tag '" + name + "'"));

        if (block != null && block.tag() != tag) {
            throw insideBlock(tag, column);
        }

        if (tag.kind() == Tag.Kind.VOID) {
            throw new MarkupException(MarkupError.UNEXPECTED_CLOSE_TAG, line, column, tag.tagName(),
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
            throw new MarkupException(MarkupError.UNEXPECTED_CLOSE_TAG, line, column, tag.tagName(),
                    "</" + tag.tagName() + "> does not match: " + expected);
        }

        open.pop();
        style = current.styleBefore();

        if (block != null) {
            closeBlock(block);
        }
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
            case ALIGN, WRAP, NOWRAP, FILL, CUT, FEED, HR, QR, BARCODE, PDF417, IMAGE ->
                    throw new IllegalStateException(
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
            throw new MarkupException(MarkupError.INVALID_ALIGN_SCOPE, line, column, "align",
                    "Only one <align> is allowed per line");
        }
        requireLineOwnerCanOpen("align", MarkupError.INVALID_ALIGN_SCOPE, column);

        align = Enums.parse(Align.class, argument).orElseThrow(
                () -> argumentError(Tag.ALIGN, column, "must be 'left', 'center' or 'right'"));
        alignSeen = true;
        open.push(new OpenTag(Tag.ALIGN, column, style, line));
    }

    private void closeAlign(int column) throws MarkupException {
        OpenTag current = open.peek();
        if (current == null || current.tag() != Tag.ALIGN) {
            throw new MarkupException(MarkupError.UNEXPECTED_CLOSE_TAG, line, column, "align",
                    "</align> does not match any open <align>");
        }
        open.pop();
        style = current.styleBefore();
        closedOwnerName = "align";
        closedOwnerError = MarkupError.INVALID_ALIGN_SCOPE;
        alignSeen = false;
        pendingAlignReset = true;
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
            throw new MarkupException(MarkupError.INVALID_WRAP_SCOPE, line, column, tag.tagName(),
                    "Only one <wrap> or <nowrap> is allowed per line");
        }
        requireLineOwnerCanOpen(tag.tagName(), MarkupError.INVALID_WRAP_SCOPE, column);

        wrap = tag == Tag.WRAP;
        wrapSeen = true;
        open.push(new OpenTag(tag, column, style, line));
    }

    private void closeWrap(Tag tag, int column) throws MarkupException {
        OpenTag current = open.peek();
        if (current == null || current.tag() != tag) {
            throw new MarkupException(MarkupError.UNEXPECTED_CLOSE_TAG, line, column, tag.tagName(),
                    "</" + tag.tagName() + "> does not match any open <" + tag.tagName() + ">");
        }
        open.pop();
        style = current.styleBefore();
        closedOwnerName = tag.tagName();
        closedOwnerError = MarkupError.INVALID_WRAP_SCOPE;
        wrapSeen = false;
        pendingWrapReset = true;
    }

    /**
     * Rejects content appearing after a line-owning tag has closed.
     * <p>
     * Alignment and wrapping both apply to a whole printed line, so text outside the tag would
     * silently inherit a property the author did not write.
     */
    private void requireInsideLineScope(int column) throws MarkupException {
        if (closedOwnerName != null) {
            throw new MarkupException(closedOwnerError, line, column, closedOwnerName,
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
     * <p>
     * Unlike {@link #requireInsideLineScope}, a tag already closed on this same line is reported
     * under {@code error}/{@code name} — the tag being opened — rather than the one that closed:
     * {@code <wrap>x</wrap><nowrap>} names {@code nowrap} as the problem, which is the one thing
     * a caller reading the error can still do something about.
     */
    private void requireLineOwnerCanOpen(String name, MarkupError error, int column)
            throws MarkupException {
        if (closedOwnerName != null) {
            throw new MarkupException(error, line, column, name,
                    "<" + closedOwnerName + "> must enclose the whole line, so nothing may follow </"
                            + closedOwnerName + ">");
        }
        boolean precededByContent = !spans.isEmpty() || !directives.isEmpty();
        boolean nestedInsideStyling = open.stream().anyMatch(entry -> !isLineOwningTag(entry.tag()));
        if (precededByContent || nestedInsideStyling) {
            throw new MarkupException(error, line, column, name,
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
    // Blocks
    // -------------------------------------------------------------------------

    /**
     * Opens {@code <qr>}, {@code <barcode>}, {@code <pdf417>} or {@code <image>}.
     * <p>
     * Pushed onto the same tag stack as any other paired tag, so an unclosed block is reported by
     * the same check that catches an unclosed {@code <bold>}. What differs is the parallel
     * {@link #block} field: while it is set the scanner writes into the block's content instead of
     * into a span.
     * <p>
     * The argument is resolved here rather than when the block closes, so a bad one is refused at
     * the position it was written and before the rest of the element has been scanned.
     */
    private void openBlock(Tag tag, String argument, int column) throws MarkupException {
        requireInsideLineScope(column);

        int value = switch (tag) {
            case QR -> argument == null
                    ? DEFAULT_QR_MODULE_SIZE
                    : requireInt(argument, 1, MAX_QR_MODULE_SIZE, tag, column);
            case PDF417 -> argument == null
                    ? DEFAULT_PDF417_ERROR_LEVEL
                    : requireInt(argument, 0, MAX_PDF417_ERROR_LEVEL, tag, column);
            case IMAGE -> argument == null
                    ? DEFAULT_IMAGE_WIDTH_PERCENT
                    : requireInt(argument, MIN_IMAGE_WIDTH_PERCENT, MAX_IMAGE_WIDTH_PERCENT,
                            tag, column);
            case BARCODE -> 0;
            default -> throw new IllegalStateException("Tag " + tag + " is not a block");
        };

        BarcodeSystem system = tag == Tag.BARCODE
                ? Enums.parse(BarcodeSystem.class, argument).orElseThrow(() -> argumentError(
                        tag, column, "must name a symbology: " + Enums.names(BarcodeSystem.class)))
                : null;

        open.push(new OpenTag(tag, column, style, line));
        block = new OpenBlock(tag, column, value, system, new StringBuilder(), line);
    }

    /**
     * Closes a block, turning the content it captured into a directive.
     * <p>
     * Validation happens here, where the whole payload is finally known, and reports the opening
     * tag's column: the content runs to the end of the block, so the tag that says how it will be
     * encoded is the more useful thing to point a caller at.
     * <p>
     * What is checked is only what can be checked without an encoder — that there is content, and
     * that a symbol's content is ASCII. A symbology's own alphabet is not checked here, unlike on
     * the panel: the renderer's encoder refuses that content and {@code PrintCompiler} turns the
     * refusal into a request error, so the caller is told either way rather than the rule being
     * written out twice and drifting.
     * <p>
     * The content is stripped before it is checked. A block may span several lines, and a line
     * other than its first is written at column one on the page — indentation that has nothing to
     * do with the payload and would otherwise become leading whitespace in a QR code or the name
     * of an image.
     */
    private void closeBlock(OpenBlock finished) throws MarkupException {
        String content = finished.content().toString().strip();
        Tag tag = finished.tag();
        int column = finished.column();

        if (content.isEmpty()) {
            throw argumentError(tag, column, tag == Tag.IMAGE
                    ? "must enclose the name of a stored image"
                    : "must enclose the content to encode");
        }

        Directive directive = switch (tag) {
            case QR -> {
                requireSymbolAscii(tag, column, content);
                yield new Directive.Qr(content, finished.value());
            }
            case PDF417 -> {
                requireSymbolAscii(tag, column, content);
                yield new Directive.Pdf417(content, finished.value(), PDF417_DATA_COLUMNS);
            }
            case BARCODE -> new Directive.Barcode(finished.system(), content);
            case IMAGE -> syncedImage(content, finished.value(), column);
            default -> throw new IllegalStateException("Tag " + tag + " is not a block");
        };

        claimLine(tag.tagName(), column, MarkupError.INVALID_BLOCK_SCOPE);
        directives.add(directive);
        block = null;
    }

    /**
     * Finds the dots for a named image, or explains that this agent does not hold them.
     * <p>
     * The refusal is a markup error rather than a fault because it is genuinely about the line:
     * the name may be wrong, or the image may be one the server has not synced yet. Either way the
     * caller can see which tag, and at which column.
     */
    private Directive syncedImage(String name, int widthPercent, int column)
            throws MarkupException {
        Optional<Directive.Image> found = images.resolve(name, widthPercent);
        if (found.isEmpty()) {
            throw argumentError(Tag.IMAGE, column, "cannot print '" + name + "' at " + widthPercent
                    + "% of the paper: this agent holds no such image at that width. Only images"
                    + " the server has synced can be printed from here, at the width they were"
                    + " synced for.");
        }
        return found.get();
    }

    /**
     * Rejects a symbol payload outside ASCII.
     * <p>
     * The renderer declares a symbol's length in characters and writes it as UTF-8 bytes, so
     * anything wider encodes to more bytes than were declared and prints as a symbol that scans
     * wrongly. Refusing beats printing something that looks right and is not.
     */
    private void requireSymbolAscii(Tag tag, int column, String content) throws MarkupException {
        if (content.chars().anyMatch(codePoint -> codePoint > SYMBOL_MAX_CODE_POINT)) {
            throw argumentError(tag, column, "content must be ASCII; the symbol's length is"
                    + " declared in characters and sent as UTF-8 bytes, so anything else prints as"
                    + " a symbol that scans wrongly");
        }
    }

    /**
     * Rejects a tag written inside an open block.
     * <p>
     * A block encloses the payload of a symbology, or the name of an image, not markup — so a tag
     * nested in one would have no effect on what is printed. Refusing says so, rather than
     * discarding it silently.
     */
    private MarkupException insideBlock(Tag tag, int column) {
        return new MarkupException(MarkupError.INVALID_BLOCK_SCOPE, line, column, tag.tagName(),
                "<" + block.tag().tagName() + "> encloses data rather than markup, so <"
                        + tag.tagName() + "> cannot appear inside it");
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
                claimLine("hr", column, MarkupError.INVALID_RULE_SCOPE);
                directives.add(new Directive.Rule());
            }
            default -> throw new IllegalStateException("Tag " + tag + " is not a directive");
        }
    }

    /**
     * Records a pad, to be expanded when the column count is known.
     * <p>
     * {@link #flushPending()} first is load-bearing. {@link #pending} holds text that has not become
     * a span yet, so without it {@code Coffee<fill>2.50} would record {@code afterSpans = 0} and pad
     * the wrong side of the word.
     */
    private void appendFill(String argument, int column) throws MarkupException {
        requireInsideLineScope(column);

        String character = argument == null ? " " : argument;
        // Code points, not chars: an astral character is one character and two chars, and measuring
        // chars would refuse a legitimate single character as though it were two.
        if (character.codePointCount(0, character.length()) != 1) {
            throw argumentError(Tag.FILL, column, "takes a single character, written <fill=x>");
        }

        flushPending();
        fills.add(new Fill(spans.size(), character, style, column));
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

    /** Records a directive that must be the only thing printed on its line. */
    private void claimLine(String name, int column, MarkupError error) {
        if (soleOccupant == null) {
            soleOccupant = new SoleOccupant(name, column, error, line);
        }
    }

    /**
     * Rejects a rule, a symbol or an image sharing its element with anything else.
     * <p>
     * A rule expands to the full paper width, and a symbol or an image is a block of dots several
     * lines tall, so either combined with text would overflow its line by construction rather than
     * by accident.
     * <p>
     * Mirrors the panel's check of the same name, minus its exemption for {@code <drawer>}: that
     * tag prints nothing and so may sit beside anything, and it does not exist on this side at
     * all. Every directive this parser can produce costs paper.
     */
    private void verifyBlockScope() throws MarkupException {
        if (soleOccupant == null) {
            return;
        }
        // Fills count towards sharing even though they produce no span yet. `<hr><fill=.>` would
        // otherwise print a line of dots, feed, and then the rule — one element, two lines of paper.
        if (spans.isEmpty() && fills.isEmpty() && directives.size() == 1) {
            return;
        }
        throw new MarkupException(soleOccupant.error(), soleOccupant.line(), soleOccupant.column(),
                soleOccupant.name(),
                "<" + soleOccupant.name() + "> takes a whole line and must be alone in its element");
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
        return new MarkupException(MarkupError.INVALID_TAG_ARGUMENT, line, column, tag.tagName(),
                "<" + tag.tagName() + "> " + detail);
    }

    /**
     * Returns whether a character would be consumed by the printer as a command rather than
     * printed. Covers C0 (including tab, whose behaviour depends on printer-side tab stops
     * that the agent does not manage), DEL, and C1. {@code \n} is excluded: it is how one line of
     * the document ends and the next begins, handled by {@link #endLine()} rather than refused.
     */
    private static boolean isControl(char value) {
        return (value < 0x20 && value != '\n') || value == 0x7F || (value >= 0x80 && value <= 0x9F);
    }

    /**
     * A paired tag currently open, remembering the style to restore when it closes, and the
     * document line it was opened on, for an unclosed-tag report at end of document — by then
     * {@link #line} has moved on to wherever parsing stopped, so the tag has to carry its own.
     */
    private record OpenTag(Tag tag, int column, SpanStyle styleBefore, int line) {
    }

    /**
     * The block tag currently open, and what is being built inside it.
     * <p>
     * {@code content} accumulates the block's text as the scanner passes over it, which is what
     * keeps that text out of {@link #spans}: a line carrying a symbol or an image has to stay
     * directive-only, because such a line advances the paper by a picture's worth of dots rather
     * than by one line of type. A block may span several lines of the document; the newlines
     * between them are never appended here, so {@code content} holds only what was written
     * between the tags, one line's worth run into the next.
     *
     * @param value  the tag's argument, already resolved: a QR module size, a PDF417 error level,
     *               or an image's width percentage. Unused for a barcode, which carries a
     *               {@code system} instead.
     * @param system the symbology, for {@code <barcode>} only; null for every other block
     * @param line   the document line the block was opened on
     */
    private record OpenBlock(Tag tag, int column, int value, BarcodeSystem system,
                             StringBuilder content, int line) {
    }

    /**
     * A directive that must be the only thing printed on its line, remembered so the refusal
     * can name it and point at the line and column it was written on.
     */
    private record SoleOccupant(String name, int column, MarkupError error, int line) {
    }
}
