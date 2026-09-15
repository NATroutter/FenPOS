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
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;
import java.util.Set;

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

    /** Dots per QR module when {@code <qr>}'s {@code size} is left off. Mirrors the panel's default. */
    private static final int DEFAULT_QR_MODULE_SIZE = 6;

    /** Largest QR module size, imposed by ESC/POS {@code GS ( k} function 167. */
    private static final int MAX_QR_MODULE_SIZE = 16;

    /** PDF417 error-correction level when {@code <pdf417>}'s {@code level} is left off. */
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

    /** Printed width of {@code <image>} when its {@code width} is left off. */
    private static final int DEFAULT_IMAGE_WIDTH_PERCENT = MAX_IMAGE_WIDTH_PERCENT;

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
        skipIndentation();
        while (index < source.length()) {
            char current = source.charAt(index);
            switch (current) {
                case '<' -> readTag();
                case '&' -> readEntity();
                case '\n' -> {
                    if (block != null) {
                        continueLineInsideBlock();
                    } else {
                        endLine();
                    }
                    skipIndentation();
                }
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
     * {@link Line}. Called for every {@code \n} in the document that is not inside an open content
     * block — see {@link #continueLineInsideBlock()} for that case — and once more after the loop
     * for the final line, which the document does not have to end with a newline to have.
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

    /**
     * Advances past a {@code \n} found while an {@link #block} is open, without ending the
     * printed line the block belongs to.
     * <p>
     * A {@code <qr>}, {@code <barcode>}, {@code <pdf417>} or {@code <image>} that spans several
     * lines of the document still becomes exactly one printed {@link Line} — the one that was
     * current when the block opened, not one per raw line it happens to be written across. The
     * server's renderer feeds the paper once for that line; a blank {@link Line} for each raw
     * line swallowed by the block would feed it once per line instead. So unlike
     * {@link #endLine()}, nothing is flushed and no {@code Line} is snapshotted here — only
     * {@link #line} and {@link #lineStart} move, which is what keeps a problem reported after the
     * block closes, or a tag illegally nested inside it, pointing at the raw document line it is
     * actually on.
     */
    private void continueLineInsideBlock() {
        index++;
        line++;
        lineStart = index;
    }

    /** Returns the 1-based column of {@link #index} within the current line. */
    private int column() {
        return index - lineStart + 1;
    }

    /**
     * Skips whitespace between the start of a line and a tag.
     * <p>
     * Indentation is for whoever reads the markup, not for the paper, and it is skipped here, before
     * {@link #readText} could refuse a tab in it. Only a run that ends at a {@code <} is skipped: a
     * line that starts with text keeps every space, and a tab before text is still a control
     * character.
     */
    private void skipIndentation() {
        int at = index;
        while (at < source.length() && (source.charAt(at) == ' ' || source.charAt(at) == '\t')) {
            at++;
        }
        if (at > index && at < source.length() && source.charAt(at) == '<') {
            index = at;
        }
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
     * Reads one tag, opening or closing, starting at {@link #index}.
     * <p>
     * Ported from the panel's tokenizer: the guard below is a cheap, quote-blind check that some
     * {@code >} exists on the line at all, not a decision about where this tag actually ends — that
     * decision belongs to {@link #readAttributes}, which is the only part of the scan that knows
     * where a quoted value is open. Deciding it here from a plain {@code indexOf} was the bug this
     * replaced: a stray {@code "} inside a bare value could pair with a later one and make the scan
     * treat everything between them, {@code >} included, as still inside the tag.
     */
    private void readTag() throws MarkupException {
        int start = index;
        int startColumn = column();

        int terminator = source.indexOf('>', start);
        if (terminator < 0 || terminator > lineEnd()) {
            throw unterminatedTag();
        }

        int at = start + 1;
        boolean closing = at < source.length() && source.charAt(at) == '/';
        if (closing) {
            at++;
        }

        int nameStart = at;
        while (at < source.length() && isNameChar(source.charAt(at))) {
            at++;
        }
        String name = source.substring(nameStart, at);
        if (name.isEmpty()) {
            throw unterminatedTag();
        }

        if (closing) {
            if (at >= source.length() || source.charAt(at) != '>') {
                throw unterminatedTag();
            }
            index = at + 1;
            closeTag(name, startColumn);
            return;
        }

        requireNotServerTag(name, startColumn);

        Tag tag = Tag.byName(name).orElseThrow(() -> new MarkupException(
                MarkupError.UNKNOWN_TAG, line, startColumn, name,
                "Unknown tag '" + name + "'; write &lt; for a literal '<'"));

        if (block != null) {
            throw insideBlock(tag, startColumn);
        }

        Map<String, Attribute> attributes = readAttributes(tag, at);
        openTag(tag, attributes, startColumn);
    }

    /**
     * Builds the {@code UNKNOWN_TAG} refusal for a tag that never reaches a {@code >} of its own.
     * <p>
     * Callable from anywhere in {@link #readTag} or {@link #readAttributes}: neither ever moves
     * {@link #index} until the tag is fully read, so it still names the opening {@code <} and the
     * text after it however far the scan got.
     */
    private MarkupException unterminatedTag() {
        return new MarkupException(MarkupError.UNKNOWN_TAG, line, column(),
                source.substring(index, lineEnd()),
                "Unterminated tag; write &lt; for a literal '<'");
    }

    private int lineEnd() {
        int end = source.indexOf('\n', index);
        return end < 0 ? source.length() : end;
    }

    private static boolean isNameChar(char value) {
        return (value >= 'a' && value <= 'z') || (value >= 'A' && value <= 'Z')
                || (value >= '0' && value <= '9') || value == '_' || value == '-';
    }

    /** Dispatches an opening tag once its name and attributes have both been read. */
    private void openTag(Tag tag, Map<String, Attribute> attributes, int column) throws MarkupException {
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

    /**
     * Reads the {@code key=value} pairs after a tag's name, exactly as the panel's tokenizer does,
     * then advances {@link #index} past the tag's closing {@code >}.
     * <p>
     * A key is a run of name characters followed by {@code =}; a value is double-quoted and runs to
     * the closing quote, or bare and runs to the next space, tab or {@code >} — so a bare value can
     * never read past the tag it belongs to. Quoting begins only where a value starts, right after a
     * key's {@code =}, and nowhere else in the tag, so a {@code "} inside a bare value cannot make
     * the scanner believe a quote it never opened is still open. Anything at a key's position that
     * cannot start one — the {@code =} of a value written against the tag name, say — is refused with
     * the same generic message the panel gives, so a caller sees one refusal wherever the markup is
     * parsed. A quoted value left open past the end of the line is refused as the tag being
     * unterminated: at that point the scan cannot tell where the author meant the tag to end, so
     * there is no attribute-shaped error to give instead.
     */
    private Map<String, Attribute> readAttributes(Tag tag, int from) throws MarkupException {
        Map<String, Attribute> read = new LinkedHashMap<>();
        int at = from;
        while (at < source.length() && source.charAt(at) != '>') {
            char current = source.charAt(at);
            if (current == '\n') {
                throw unterminatedTag();
            }
            if (current == ' ' || current == '\t') {
                at++;
                continue;
            }
            int keyColumn = at - lineStart + 1;
            int keyStart = at;
            while (at < source.length() && isNameChar(source.charAt(at))) {
                at++;
            }
            String key = source.substring(keyStart, at).toLowerCase(Locale.ROOT);
            if (key.isEmpty() || at >= source.length() || source.charAt(at) != '=') {
                String shown = key.isEmpty() ? source.substring(keyStart, keyStart + 1) : key;
                throw new MarkupException(MarkupError.UNKNOWN_ATTRIBUTE, line, keyColumn, shown,
                        "<" + tag.tagName() + "> attributes are written key=value");
            }
            at++;
            String value;
            if (at < source.length() && source.charAt(at) == '"') {
                int close = source.indexOf('"', at + 1);
                if (close < 0 || close > lineEnd()) {
                    throw unterminatedTag();
                }
                value = source.substring(at + 1, close);
                at = close + 1;
            } else {
                int valueStart = at;
                while (at < source.length() && source.charAt(at) != ' ' && source.charAt(at) != '\t'
                        && source.charAt(at) != '>' && source.charAt(at) != '\n') {
                    at++;
                }
                value = source.substring(valueStart, at);
            }
            for (int i = 0; i < value.length(); i++) {
                if (isControl(value.charAt(i))) {
                    throw new MarkupException(MarkupError.CONTROL_CHARACTER, line, keyColumn, key,
                            "Control characters cannot be printed; use markup tags for formatting");
                }
            }
            if (!tag.attributes().contains(key)) {
                throw new MarkupException(MarkupError.UNKNOWN_ATTRIBUTE, line, keyColumn, key,
                        "<" + tag.tagName() + "> has no attribute '" + key + "'");
            }
            if (read.containsKey(key)) {
                throw new MarkupException(MarkupError.INVALID_ATTRIBUTE, line, keyColumn, key,
                        "<" + tag.tagName() + "> sets '" + key + "' twice");
            }
            read.put(key, new Attribute(value, keyColumn));
        }
        if (at >= source.length() || source.charAt(at) != '>') {
            throw unterminatedTag();
        }
        index = at + 1;
        return read;
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

    /**
     * Applies a tag's effect to the current style.
     *
     * @throws MarkupException if an attribute is malformed or out of range
     */
    private SpanStyle applyStyle(Tag tag, Map<String, Attribute> attributes, int column)
            throws MarkupException {
        return switch (tag) {
            case BOLD -> style.withBold(true);
            case INVERT -> style.withInvert(true);
            case UNDERLINE -> style.withUnderline(optionalInt(tag, attributes, "weight", 1, 2, 1));
            case SIZE -> applySize(attributes, column);
            case TEXT -> applyText(attributes, column);
            case ALIGN, WRAP, NOWRAP, FILL, CUT, FEED, HR, QR, BARCODE, PDF417, IMAGE ->
                    throw new IllegalStateException("Tag " + tag + " does not carry a span style");
        };
    }

    private SpanStyle applySize(Map<String, Attribute> attributes, int column) throws MarkupException {
        if (!attributes.containsKey("width") && !attributes.containsKey("height")) {
            throw new MarkupException(MarkupError.INVALID_ATTRIBUTE, line, column, "width",
                    "<size> needs width or height, or both");
        }
        int width = optionalInt(Tag.SIZE, attributes, "width", 1, MAX_SIZE_MULTIPLIER, 1);
        int height = optionalInt(Tag.SIZE, attributes, "height", 1, MAX_SIZE_MULTIPLIER, 1);
        return style.withSize(width, height);
    }

    /**
     * Selects one of the printer's two faces.
     * <p>
     * A name that is not {@code a} or {@code b} is a stored font, which only the server can draw;
     * refused as such rather than as unknown, so the caller learns which side to send the job to.
     */
    private SpanStyle applyText(Map<String, Attribute> attributes, int column) throws MarkupException {
        Attribute font = require(Tag.TEXT, attributes, "font", column);
        Optional<Font> builtIn = Enums.parse(Font.class, font.value());
        if (builtIn.isEmpty()) {
            throw new MarkupException(MarkupError.SERVER_RENDERED, line, font.column(), "text",
                    "<text font=name> uses a stored font the server renders; the console has a and b");
        }
        Attribute size = attributes.get("size");
        if (size != null) {
            throw new MarkupException(MarkupError.INVALID_ATTRIBUTE, line, size.column(), "size",
                    "<text> size applies to a stored font, not to the printer's own");
        }
        return style.withFont(builtIn.get());
    }

    // -------------------------------------------------------------------------
    // Alignment
    // -------------------------------------------------------------------------

    private void openAlign(Map<String, Attribute> attributes, int column) throws MarkupException {
        if (alignSeen) {
            throw new MarkupException(MarkupError.INVALID_ALIGN_SCOPE, line, column, "align",
                    "Only one <align> is allowed per line");
        }
        requireLineOwnerCanOpen("align", MarkupError.INVALID_ALIGN_SCOPE, column);

        Attribute to = require(Tag.ALIGN, attributes, "to", column);
        align = Enums.parse(Align.class, to.value()).orElseThrow(
                () -> attributeError(Tag.ALIGN, "to", to, "left, center or right"));
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
    private void openBlock(Tag tag, Map<String, Attribute> attributes, int column) throws MarkupException {
        requireInsideLineScope(column);

        int value = switch (tag) {
            case QR -> optionalInt(tag, attributes, "size", 1, MAX_QR_MODULE_SIZE, DEFAULT_QR_MODULE_SIZE);
            case PDF417 -> optionalInt(tag, attributes, "level", 0, MAX_PDF417_ERROR_LEVEL,
                    DEFAULT_PDF417_ERROR_LEVEL);
            case IMAGE -> optionalInt(tag, attributes, "width", MIN_IMAGE_WIDTH_PERCENT,
                    MAX_IMAGE_WIDTH_PERCENT, DEFAULT_IMAGE_WIDTH_PERCENT);
            case BARCODE -> 0;
            default -> throw new IllegalStateException("Tag " + tag + " is not a block");
        };

        BarcodeSystem system = null;
        if (tag == Tag.BARCODE) {
            Attribute type = require(tag, attributes, "type", column);
            system = Enums.parse(BarcodeSystem.class, type.value()).orElseThrow(() -> attributeError(
                    tag, "type", type, "a symbology: " + Enums.names(BarcodeSystem.class)));
        }

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
            case IMAGE -> {
                if (content.startsWith("data:")) {
                    throw new MarkupException(MarkupError.SERVER_RENDERED, line, column, tag.tagName(),
                            "<image> data is decoded by the server; the console prints stored images by name");
                }
                yield syncedImage(content, finished.value(), column);
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

    private void appendDirective(Tag tag, Map<String, Attribute> attributes, int column)
            throws MarkupException {
        requireInsideLineScope(column);
        switch (tag) {
            case CUT -> directives.add(new Directive.Cut(cutMode(attributes)));
            case FEED -> directives.add(new Directive.Feed(
                    requiredInt(Tag.FEED, attributes, "lines", 1, MAX_FEED_LINES, column)));
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
    private void appendFill(Map<String, Attribute> attributes, int column) throws MarkupException {
        requireInsideLineScope(column);

        Attribute written = attributes.get("char");
        String character = written == null ? " " : written.value();
        // Code points, not chars: an astral character is one character and two chars, and measuring
        // chars would refuse a legitimate single character as though it were two.
        if (character.codePointCount(0, character.length()) != 1) {
            throw attributeError(Tag.FILL, "char", written, "a single character");
        }

        flushPending();
        fills.add(new Fill(spans.size(), character, style, column));
    }

    private Directive.Cut.Mode cutMode(Map<String, Attribute> attributes) throws MarkupException {
        Attribute mode = attributes.get("mode");
        if (mode == null || mode.value().equalsIgnoreCase("full")) {
            return Directive.Cut.Mode.FULL;
        }
        if (mode.value().equalsIgnoreCase("partial")) {
            return Directive.Cut.Mode.PARTIAL;
        }
        throw attributeError(Tag.CUT, "mode", mode, "full or partial");
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

    // -------------------------------------------------------------------------
    // Shared checks
    // -------------------------------------------------------------------------

    /** Reads an integer attribute, or {@code fallback} when it was left off. */
    private int optionalInt(Tag tag, Map<String, Attribute> attributes, String key, int min, int max,
                            int fallback) throws MarkupException {
        Attribute attribute = attributes.get(key);
        return attribute == null ? fallback : intValue(tag, key, attribute, min, max);
    }

    /** Reads an integer attribute the tag cannot do without. */
    private int requiredInt(Tag tag, Map<String, Attribute> attributes, String key, int min, int max,
                            int tagColumn) throws MarkupException {
        return intValue(tag, key, require(tag, attributes, key, tagColumn), min, max);
    }

    private Attribute require(Tag tag, Map<String, Attribute> attributes, String key, int tagColumn)
            throws MarkupException {
        Attribute attribute = attributes.get(key);
        if (attribute == null) {
            throw new MarkupException(MarkupError.INVALID_ATTRIBUTE, line, tagColumn, key,
                    "<" + tag.tagName() + "> requires " + key);
        }
        return attribute;
    }

    private int intValue(Tag tag, String key, Attribute attribute, int min, int max)
            throws MarkupException {
        int parsed;
        try {
            parsed = Integer.parseInt(attribute.value().strip());
        } catch (NumberFormatException e) {
            throw attributeError(tag, key, attribute, "a whole number from " + min + " to " + max);
        }
        if (parsed < min || parsed > max) {
            throw attributeError(tag, key, attribute, "a whole number from " + min + " to " + max);
        }
        return parsed;
    }

    private MarkupException attributeError(Tag tag, String key, Attribute attribute, String expected) {
        return new MarkupException(MarkupError.INVALID_ATTRIBUTE, line, attribute.column(), key,
                "<" + tag.tagName() + "> " + key + "=" + attribute.value() + " is not accepted; expected "
                        + expected);
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

    /** One attribute as the author wrote it, and the column its key starts at. */
    private record Attribute(String value, int column) {
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
     * @param value  the tag's attribute, already resolved: a QR module size, a PDF417 error level,
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
