package fi.natroutter.fenpos.markup;

import fi.natroutter.fenpos.enums.Align;
import fi.natroutter.fenpos.enums.BarcodeSystem;
import fi.natroutter.fenpos.enums.Font;
import fi.natroutter.fenpos.markup.model.Directive;
import fi.natroutter.fenpos.markup.model.Fill;
import fi.natroutter.fenpos.markup.model.Line;
import fi.natroutter.fenpos.markup.model.Span;
import fi.natroutter.fenpos.markup.model.SpanStyle;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.List;
import java.util.Locale;
import java.util.Optional;
import java.util.Set;
import java.util.regex.Pattern;

/**
 * Turns the request's {@code data} string into one {@link Line} per line of the document.
 * <p>
 * The parser is the boundary that makes the rest of the system safe: markup is the only way
 * a caller can influence printer state, and every byte the printer would read as a command
 * either comes from a recognised tag or is rejected here. A raw control character is never
 * passed through, so a request cannot desynchronise the device.
 * <p>
 * The document is read in two passes, as the panel reads it. {@link MarkupTokenizer} reads the whole
 * document first and makes every refusal about how markup is written; this class then builds one
 * {@link Line} per line of the document from those tokens, making every refusal about what the markup
 * means. A tag such as {@code <bold>} or {@code <align>} may open on one line and close on a later
 * one, in which case every line it covers carries its effect.
 * <p>
 * Instances are not shared: {@link #parseDocument(String)} creates one per document, so the
 * class carries per-parse state without being thread-unsafe.
 * <p>
 * A port of {@code fenpos/lib/markup/parser.ts}, and the two must not drift — a tag the panel
 * accepts and this refuses is a job that previews cleanly and then fails behind a printer. Three
 * differences are deliberate. {@code <drawer>} exists there and not here, so nothing printed from
 * this agent's console can fire a till. The tags the server draws into a raster, and a {@code <text>}
 * naming a stored font, are refused as server-rendered, so a caller learns which side to send the job
 * to. And a block tag here is emitted rather than measured:
 * there is no symbol encoder and no image decoder on this side, which is why an {@code <image>}
 * resolves only against rasters the server already synced, and why {@code PrintCompiler} charges
 * a symbol nothing against its line budget. Each is documented where it bites.
 */
public final class MarkupParser {

    /** Dots per QR module when {@code <qr>}'s {@code size} is left off. Mirrors the panel's default. */
    private static final int DEFAULT_QR_MODULE_SIZE = 6;

    /** PDF417 error-correction level when {@code <pdf417>}'s {@code level} is left off. */
    private static final int DEFAULT_PDF417_ERROR_LEVEL = 1;

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

    /** Printed width of {@code <image>} when its {@code width} is left off: the whole printable width. */
    private static final int DEFAULT_IMAGE_WIDTH_PERCENT = 100;

    /** What a stored font's name may look like. Mirrors {@code NAME_PATTERN} in {@code lib/domain/naming.ts}. */
    private static final Pattern FONT_NAME = Pattern.compile("[a-z0-9][a-z0-9_-]*");

    /**
     * Highest code point a symbol's payload may contain.
     * <p>
     * The renderer declares a symbol's length in characters and sends it as UTF-8 bytes, so a
     * payload outside ASCII encodes to more bytes than were declared and prints as a symbol that
     * scans wrongly. Refused here, at a column, rather than on paper.
     */
    private static final int SYMBOL_MAX_CODE_POINT = 0x7F;

    /**
     * Tags the server draws into a raster rather than sends as printer commands.
     * <p>
     * None of these are in {@link Tag}: this agent has no table, chart or symbol layout engine,
     * so there is nothing for them to mean here. Checked ahead of {@link Tag#byName} so the
     * refusal names what the tag actually is, rather than reporting it as merely unknown.
     */
    private static final Set<String> SERVER_TAGS =
            Set.of("box", "table", "row", "cell", "chart", "series", "labels", "bar");

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

    /** 1-based document line of the token being handled. */
    private int line = 1;

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
        for (MarkupToken token : MarkupTokenizer.tokenize(source)) {
            line = token.line();
            switch (token) {
                case MarkupToken.Text text -> appendText(text);
                case MarkupToken.Open opening -> openTag(opening);
                case MarkupToken.Close closing -> closeTag(closing.name(), closing.column());
                case MarkupToken.Break ignored -> {
                    // A block spanning several lines of the document is still one printed line: the
                    // server feeds the paper once for it, so only a break outside a block ends a line.
                    if (block == null) {
                        endLine();
                    }
                }
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
     * {@link Line}. Called for every line break outside an open content block, and once more after
     * the loop for the final line, which the document does not have to end with a newline to have.
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
    }

    // -------------------------------------------------------------------------
    // Text
    // -------------------------------------------------------------------------

    /**
     * Adds printable text to the line, or to the open block's payload.
     * <p>
     * A decoded entity becomes a span of its own, which keeps every other span's characters contiguous
     * in the source and so lets {@link Span#columnAt(int)} report an exact column. Inside a block it
     * joins the payload instead: {@code &amp;} is the only way to write an ampersand a symbology is
     * meant to carry.
     */
    private void appendText(MarkupToken.Text text) throws MarkupException {
        requireInsideLineScope(text.column());
        if (block != null) {
            block.content().append(text.text());
            return;
        }
        if (text.entity()) {
            flushPending();
            spans.add(new Span(text.text(), style, text.column()));
            return;
        }
        beginPendingAt(text.column());
        pending.append(text.text());
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

    /**
     * Rejects a tag by name that the server draws into a raster rather than sends as printer
     * commands, before {@link Tag#byName} has a chance to report it as merely unknown.
     */
    private void requireNotServerTag(String name, int column) throws MarkupException {
        if (name != null && SERVER_TAGS.contains(name.toLowerCase(Locale.ROOT))) {
            throw new MarkupException(MarkupError.SERVER_RENDERED, line, column, name,
                    "<" + name + "> is drawn by the server into a raster; the console prints text only");
        }
    }

    /**
     * Opens a tag, in the order the panel's tree does: its name, then whether it may appear here at
     * all, then its attributes, then its own rules.
     */
    private void openTag(MarkupToken.Open opening) throws MarkupException {
        String name = opening.name();
        int column = opening.column();

        requireNotServerTag(name, column);

        Tag tag = Tag.byName(name).orElseThrow(() -> new MarkupException(
                MarkupError.UNKNOWN_TAG, line, column, name,
                "Unknown tag '" + name + "'; write &lt; for a literal '<'"));

        if (block != null) {
            throw insideBlock(tag, column);
        }

        Attributes attributes = AttributeReader.read(tag.tagName(), opening.attributes(), tag.attributes(),
                line, column);

        // Void, but not a directive: a fill is a position in the text rather than a printer action,
        // so it never reaches appendDirective.
        if (tag == Tag.FILL) {
            appendFill(attributes, column);
            return;
        }

        if (tag.kind() == Tag.Kind.VOID) {
            appendDirective(tag, attributes, column);
            return;
        }

        flushPending();

        if (tag == Tag.ALIGN) {
            openAlign(attributes, column);
            return;
        }

        if (tag == Tag.WRAP || tag == Tag.NOWRAP) {
            openWrap(tag, column);
            return;
        }

        if (tag.isBlock()) {
            openBlock(tag, attributes, column);
            return;
        }

        requireInsideLineScope(column);
        open.push(new OpenTag(tag, column, style, line));
        style = applyStyle(tag, attributes, column);
    }

    private void closeTag(String name, int column) throws MarkupException {
        requireNotServerTag(name, column);

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

    /** Applies a tag's effect to the current style. */
    private SpanStyle applyStyle(Tag tag, Attributes attributes, int column) throws MarkupException {
        return switch (tag) {
            case BOLD -> style.withBold(true);
            case INVERT -> style.withInvert(true);
            case UNDERLINE -> style.withUnderline(attributes.integer("weight", 1));
            case SIZE -> applySize(attributes, column);
            case TEXT -> applyText(attributes);
            case ALIGN, WRAP, NOWRAP, FILL, CUT, FEED, HR, QR, BARCODE, PDF417, IMAGE ->
                    throw new IllegalStateException("Tag " + tag + " does not carry a span style");
        };
    }

    private SpanStyle applySize(Attributes attributes, int column) throws MarkupException {
        if (!attributes.has("width") && !attributes.has("height")) {
            throw new MarkupException(MarkupError.INVALID_ATTRIBUTE, line, column, "width",
                    "<size> needs width or height, or both");
        }
        return style.withSize(attributes.integer("width", 1), attributes.integer("height", 1));
    }

    /**
     * Selects one of the printer's two faces.
     * <p>
     * Checked as the panel checks it: a letter is a built-in face and takes no size; anything else must
     * look like a stored font's name. A stored font is refused as server-rendered rather than as
     * unknown, so the caller learns which side to send the job to.
     */
    private SpanStyle applyText(Attributes attributes) throws MarkupException {
        String font = attributes.string("font");
        Font builtIn = font.equalsIgnoreCase("a") ? Font.A : font.equalsIgnoreCase("b") ? Font.B : null;

        if (builtIn != null) {
            if (attributes.has("size")) {
                throw new MarkupException(MarkupError.INVALID_ATTRIBUTE, line, attributes.column("size"), "size",
                        "<text> size applies to a stored font, not to the printer's own");
            }
            return style.withFont(builtIn);
        }

        if (!FONT_NAME.matcher(font).matches()) {
            throw new MarkupException(MarkupError.INVALID_ATTRIBUTE, line, attributes.column("font"), "font",
                    "<text> font '" + font + "' is not a built-in font or a font name");
        }

        throw new MarkupException(MarkupError.SERVER_RENDERED, line, attributes.column("font"), "text",
                "<text font=name> uses a stored font the server renders; the console has a and b");
    }

    // -------------------------------------------------------------------------
    // Alignment
    // -------------------------------------------------------------------------

    private void openAlign(Attributes attributes, int column) throws MarkupException {
        if (alignSeen) {
            throw new MarkupException(MarkupError.INVALID_ALIGN_SCOPE, line, column, "align",
                    "Only one <align> is allowed per line");
        }
        requireLineOwnerCanOpen("align", MarkupError.INVALID_ALIGN_SCOPE, column);

        align = Align.valueOf(attributes.string("to"));
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
     * Its attributes are resolved here rather than when the block closes, so a bad one is refused at
     * the position it was written and before the rest of the element has been scanned.
     */
    private void openBlock(Tag tag, Attributes attributes, int column) throws MarkupException {
        requireInsideLineScope(column);

        int value = switch (tag) {
            case QR -> attributes.integer("size", DEFAULT_QR_MODULE_SIZE);
            case PDF417 -> attributes.integer("level", DEFAULT_PDF417_ERROR_LEVEL);
            case IMAGE -> attributes.integer("width", DEFAULT_IMAGE_WIDTH_PERCENT);
            case BARCODE -> 0;
            default -> throw new IllegalStateException("Tag " + tag + " is not a block");
        };

        BarcodeSystem system = tag == Tag.BARCODE ? BarcodeSystem.valueOf(attributes.string("type")) : null;

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
            throw switch (tag) {
                case QR -> symbolError(finished, "QR code content must not be empty");
                case PDF417 -> symbolError(finished, "PDF417 content must not be empty");
                case IMAGE -> argumentError(finished, "must enclose the name of a stored image");
                default -> argumentError(finished, "must enclose the content to encode");
            };
        }

        Directive directive = switch (tag) {
            case QR -> {
                requireSymbolAscii(finished, "QR code", content);
                yield new Directive.Qr(content, finished.value());
            }
            case PDF417 -> {
                requireSymbolAscii(finished, "PDF417", content);
                yield new Directive.Pdf417(content, finished.value(), PDF417_DATA_COLUMNS);
            }
            case BARCODE -> new Directive.Barcode(finished.system(), content);
            case IMAGE -> {
                if (content.startsWith("data:")) {
                    throw new MarkupException(MarkupError.SERVER_RENDERED, finished.line(), column, tag.tagName(),
                            "<image> data is decoded by the server; the console prints stored images by name");
                }
                yield syncedImage(finished, content);
            }
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
    private Directive syncedImage(OpenBlock finished, String name) throws MarkupException {
        int widthPercent = finished.value();
        Optional<Directive.Image> found = images.resolve(name, widthPercent);
        if (found.isEmpty()) {
            throw argumentError(finished, "cannot print '" + name + "' at " + widthPercent
                    + "% of the paper: this agent holds no such image at that width. Only images"
                    + " the server has synced can be printed from here, at the width they were"
                    + " synced for.");
        }
        return found.get();
    }

    /**
     * Rejects a symbol payload outside ASCII, with the panel's message.
     * <p>
     * The renderer declares a symbol's length in characters and writes it as UTF-8 bytes, so anything
     * wider encodes to more bytes than were declared and prints as a symbol that scans wrongly.
     */
    private void requireSymbolAscii(OpenBlock finished, String kind, String content) throws MarkupException {
        if (content.chars().anyMatch(codePoint -> codePoint > SYMBOL_MAX_CODE_POINT)) {
            throw symbolError(finished, kind + " content must be ASCII; the agent declares the symbol's length"
                    + " in characters but sends it as UTF-8 bytes, so anything else prints as a symbol that"
                    + " scans wrongly");
        }
    }

    /** A refusal of what a symbol encloses, at the tag that opened it, as the panel reports one. */
    private MarkupException symbolError(OpenBlock finished, String message) {
        return new MarkupException(MarkupError.INVALID_TAG_ARGUMENT, finished.line(), finished.column(),
                finished.tag().tagName(), message);
    }

    /**
     * The same refusal, phrased about the tag rather than about what it encodes.
     * <p>
     * A block's content runs to its closing tag and may be written across several lines, so the
     * position reported is the tag that opened it: that is where an author reading the error has to
     * look, and it is the position the panel reports.
     */
    private MarkupException argumentError(OpenBlock finished, String detail) {
        String name = finished.tag().tagName();
        return new MarkupException(MarkupError.INVALID_TAG_ARGUMENT, finished.line(), finished.column(), name,
                "<" + name + "> " + detail);
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

    private void appendDirective(Tag tag, Attributes attributes, int column)
            throws MarkupException {
        requireInsideLineScope(column);
        switch (tag) {
            case CUT -> directives.add(new Directive.Cut(
                    "partial".equals(attributes.string("mode")) ? Directive.Cut.Mode.PARTIAL : Directive.Cut.Mode.FULL));
            case FEED -> directives.add(new Directive.Feed(attributes.integer("lines", 1)));
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
    private void appendFill(Attributes attributes, int column) throws MarkupException {
        requireInsideLineScope(column);

        String character = attributes.has("char") ? attributes.string("char") : " ";

        flushPending();
        fills.add(new Fill(spans.size(), character, style, column));
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
        // Fills count towards sharing even though they produce no span yet. `<hr><fill char=.>` would
        // otherwise print a line of dots, feed, and then the rule — one element, two lines of paper.
        if (spans.isEmpty() && fills.isEmpty() && directives.size() == 1) {
            return;
        }
        throw new MarkupException(soleOccupant.error(), soleOccupant.line(), soleOccupant.column(),
                soleOccupant.name(),
                "<" + soleOccupant.name() + "> takes a whole line and must be alone on its line");
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
     * @param value  the tag's attribute, already checked: a QR module size, a PDF417 error level, or
     *               an image's width percentage. Unused for a barcode, which carries a
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
