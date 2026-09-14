package fi.natroutter.fenpos.print;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParseException;
import com.google.gson.JsonParser;
import fi.natroutter.fenpos.device.Device;
import fi.natroutter.fenpos.device.LimitSettings;
import fi.natroutter.fenpos.device.PrintSettings;
import fi.natroutter.fenpos.encoding.CharsetValidator;
import fi.natroutter.fenpos.encoding.EscPosRenderer;
import fi.natroutter.fenpos.encoding.SymbolEncodingException;
import fi.natroutter.fenpos.encoding.UnsupportedCharacterException;
import fi.natroutter.fenpos.enums.Linefeed;
import fi.natroutter.fenpos.markup.FillResolver;
import fi.natroutter.fenpos.markup.ImageResolver;
import fi.natroutter.fenpos.markup.LineWrapper;
import fi.natroutter.fenpos.markup.MarkupException;
import fi.natroutter.fenpos.markup.MarkupParser;
import fi.natroutter.fenpos.markup.model.Line;
import fi.natroutter.fenpos.util.Enums;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.util.ArrayList;
import java.util.List;
import java.util.Set;

/**
 * Turns a job body into a printable payload, or explains precisely why it cannot.
 * <p>
 * Every stage runs synchronously, before the job is queued. That is what lets the queue hold
 * finished bytes rather than raw JSON: once a job is accepted it can only fail for hardware
 * reasons, and every content problem has already been reported with the line and column that
 * caused it.
 * <p>
 * Jobs arriving over the link do not pass through here: the server compiles those, which is what
 * lets a bad request be refused with a diagnostic before it ever reaches an agent. This pipeline
 * serves the console, where a job is composed locally and there is no server in the path.
 * <p>
 * Stages are ordered cheapest-first. Limits are enforced before any line is parsed, so an
 * oversized job is refused without doing the work it was trying to provoke.
 * <p>
 * <b>{@code maxLineChars} is measured on the raw line, content tags included.</b> The server's
 * compiler can afford to look inside a {@code <qr>} or a {@code <barcode>} and charge its payload
 * against a separate budget, because it already has to parse the tag to measure the symbol it
 * produces. This side has no such measurement to piggyback on, so a line carrying a long symbol
 * payload is simply charged for every character it is written with, tag markup included. The
 * practical effect is that a line wrapped only because of an unusually long symbol argument reads
 * the same limit differently here than on the server — worth knowing, not worth a second parser
 * pass to fix.
 */
public final class PrintCompiler {

    private static final String FIELD_DATA = "data";
    private static final String FIELD_LINEFEED = "linefeed";

    /** The only keys a request body may carry. */
    private static final Set<String> ALLOWED_FIELDS = Set.of("data", "linefeed");

    private PrintCompiler() {
    }

    /**
     * Compiles a request body for the given device.
     *
     * @param body   the raw JSON request body
     * @param device the target device's resolved settings
     * @return the rendered payload
     * @throws PrintRequestException if the request cannot be printed as given
     */
    public static CompiledJob compile(String body, Device device)
            throws PrintRequestException {
        return compile(body, device, ImageResolver.NONE);
    }

    /**
     * Compiles a request body for the given device.
     *
     * @param body   the raw JSON request body
     * @param device the target device's resolved settings
     * @param images where an {@code <image>} tag's dots come from, usually
     *               {@link SyncedImages#forDevice}
     * @return the rendered payload
     * @throws PrintRequestException if the request cannot be printed as given
     */
    public static CompiledJob compile(String body, Device device, ImageResolver images)
            throws PrintRequestException {
        JsonObject root = parseObject(body);
        requireKnownFields(root);

        String data = readData(root, device.limits());
        Linefeed linefeed = readLinefeed(root, device.print());

        List<Line> lines = layOut(data, device, images);
        requireOutputWithinLimit(lines, device.limits());

        return new CompiledJob(render(lines, device.print(), linefeed), countTextLines(lines));
    }

    // -------------------------------------------------------------------------
    // Request shape
    // -------------------------------------------------------------------------

    private static JsonObject parseObject(String body) throws PrintRequestException {
        try {
            JsonElement parsed = JsonParser.parseString(body == null ? "" : body);
            if (!parsed.isJsonObject()) {
                throw PrintRequestException.of("invalid_json", "Body must be a JSON object");
            }
            return parsed.getAsJsonObject();
        } catch (JsonParseException e) {
            throw PrintRequestException.of("invalid_json", "Body is not valid JSON");
        }
    }

    /**
     * Reads and limit-checks the {@code data} document.
     * <p>
     * Lengths are measured on the raw lines, before markup is interpreted, so the totals a
     * client computes match the totals enforced here. Line endings are normalised the same way
     * {@link MarkupParser} normalises them, so the line a limit is reported against is the same
     * line the parser would later report an error against.
     */
    private static String readData(JsonObject root, LimitSettings limits)
            throws PrintRequestException {
        JsonElement data = root.get(FIELD_DATA);
        if (data == null || data.isJsonNull()) {
            throw PrintRequestException.of("missing_field", "'data' is required");
        }
        if (data.isJsonArray()) {
            throw PrintRequestException.of("invalid_type", "'data' is no longer an array of "
                    + "lines. Send one string, with a newline between lines.");
        }
        if (!data.isJsonPrimitive() || !data.getAsJsonPrimitive().isString()) {
            throw PrintRequestException.of("invalid_type", "'data' must be a string");
        }

        String text = data.getAsString();
        String[] lines = text.replace("\r\n", "\n").split("\n", -1);
        if (lines.length > limits.maxLines()) {
            throw PrintRequestException.of("too_many_lines",
                    "At most " + limits.maxLines() + " lines are allowed, got " + lines.length);
        }

        int total = 0;
        for (int index = 0; index < lines.length; index++) {
            int lineNumber = index + 1;
            String raw = lines[index];
            if (raw.length() > limits.maxLineChars()) {
                throw PrintRequestException.atLine("line_too_long", lineNumber,
                        "At most " + limits.maxLineChars() + " characters are allowed per line, got "
                                + raw.length());
            }

            total += raw.length();
            if (total > limits.maxTotalChars()) {
                throw PrintRequestException.atLine("text_too_large", lineNumber,
                        "At most " + limits.maxTotalChars() + " characters are allowed in total");
            }
        }
        return text;
    }

    /**
     * Rejects a body carrying anything but {@code data} and {@code linefeed}.
     * <p>
     * Checked rather than ignored because {@code wrap} changed behaviour when it was removed: a
     * caller still sending it would otherwise get silently wrapped output and no way to find out
     * why.
     */
    private static void requireKnownFields(JsonObject root) throws PrintRequestException {
        for (String key : root.keySet()) {
            if (!ALLOWED_FIELDS.contains(key)) {
                throw PrintRequestException.of("unknown_field", "wrap".equals(key)
                        ? "'wrap' is no longer a request field. Use the <wrap> and <nowrap> tags, "
                                + "which apply to one line."
                        : "Unknown field '" + key + "'; this request accepts 'data' and 'linefeed'");
            }
        }
    }

    private static Linefeed readLinefeed(JsonObject root, PrintSettings print)
            throws PrintRequestException {
        JsonElement linefeed = root.get(FIELD_LINEFEED);
        if (linefeed == null || linefeed.isJsonNull()) {
            return print.defaultLinefeed();
        }
        if (!linefeed.isJsonPrimitive() || !linefeed.getAsJsonPrimitive().isString()) {
            throw PrintRequestException.of("invalid_type", "'linefeed' must be a string");
        }
        String value = linefeed.getAsString();
        return Enums.parse(Linefeed.class, value).orElseThrow(() ->
                PrintRequestException.of("invalid_linefeed",
                        "Unknown linefeed '" + value + "'; must be one of: "
                                + Enums.names(Linefeed.class)));
    }

    // -------------------------------------------------------------------------
    // Content
    // -------------------------------------------------------------------------

    /**
     * Parses the whole document, then validates and wraps each parsed line, translating the
     * positional failures raised by the encoder into request-level errors carrying the line
     * number. A markup failure already carries its own line, from the parser; an encoder failure
     * does not, so it is attributed by the position of the parsed line it came from instead —
     * the same number the parser would have used had the problem been its to report.
     */
    private static List<Line> layOut(String data, Device device, ImageResolver images)
            throws PrintRequestException {
        PrintSettings print = device.print();

        List<Line> parsed;
        try {
            parsed = MarkupParser.parseDocument(data, images);
        } catch (MarkupException e) {
            throw PrintRequestException.at(e.error().apiCode(), e.line(), e.column(), e.getMessage());
        }

        List<Line> lines = new ArrayList<>(parsed.size());
        for (int index = 0; index < parsed.size(); index++) {
            int lineNumber = index + 1;
            try {
                Line checked = CharsetValidator.validate(
                        parsed.get(index), print.codepage(), print.onUnsupported());
                // After this line no fill remains, which is what lets the wrapper and the renderer
                // stay ignorant of the tag. It runs after the charset check so that an unprintable
                // fill character is reported once, at the column the caller wrote it.
                Line filled = FillResolver.resolve(checked, print.columns());
                boolean wrap = filled.wrap() == null ? print.defaultWrap() : filled.wrap();
                lines.addAll(wrap
                        ? LineWrapper.wrap(filled, print.columns())
                        : List.of(filled));
            } catch (UnsupportedCharacterException e) {
                throw PrintRequestException.unsupportedCharacter(
                        lineNumber, e.column(), e.character(), e.codepage(), e.getMessage());
            }
        }
        return lines;
    }

    private static void requireOutputWithinLimit(List<Line> lines, LimitSettings limits)
            throws PrintRequestException {
        int printed = countTextLines(lines);
        if (printed > limits.maxOutputLines()) {
            throw PrintRequestException.of("too_many_output_lines",
                    "Wrapping produced " + printed + " lines, more than the limit of "
                            + limits.maxOutputLines());
        }
    }

    /**
     * Counts lines that advance the paper; directive-only lines do not.
     * <p>
     * <b>A symbol or an image is counted as zero lines, and it is not.</b> A QR code, a barcode, a
     * PDF417 symbol and a picture each occupy a directive-only line here and are charged nothing
     * against {@code maxOutputLines}, while on paper they are a block of dots several lines tall.
     * A job printed from this agent's console can therefore exceed the line budget the panel would
     * have enforced on the same markup — by the height of whatever symbols it contains.
     * <p>
     * <b>This is deliberate, not an oversight.</b> Charging a symbol correctly means knowing how
     * tall it comes out, which means encoding it, which means a symbol-geometry encoder in Java
     * alongside the one the server already has. Two encoders that must agree exactly is a worse
     * failure mode than an undercharged budget: they would drift, and the drift would show up as a
     * job the panel accepted and the printer laid out differently. The design keeps exactly one
     * encoder, on the server, and the server remains the authority on the line budget. This path
     * exists for the console and for {@code TestPage} — a convenience for whoever is standing at
     * the machine — where the cost of getting it wrong is some extra paper.
     * <p>
     * If that ever stops being acceptable, the fix is not a second encoder: it is to stop
     * accepting block tags from the console, or to charge each one a fixed pessimistic height.
     */
    private static int countTextLines(List<Line> lines) {
        return (int) lines.stream().filter(line -> !line.isDirectiveOnly()).count();
    }

    private static byte[] render(List<Line> lines, PrintSettings print, Linefeed linefeed)
            throws PrintRequestException {
        try {
            return EscPosRenderer.render(lines, print.codepage(), linefeed, print.columns());
        } catch (IOException e) {
            // The renderer writes to an in-memory buffer, so this cannot arise from I/O.
            // Surfacing it unchanged would mislabel a genuine bug as a transport failure.
            throw new UncheckedIOException("Rendering to an in-memory buffer failed", e);
        } catch (SymbolEncodingException e) {
            // A symbol encoder refusing its content. The parser checks what it can without an
            // encoder — that there is content, and that a symbol's is ASCII — and leaves each
            // symbology's own alphabet and check digits to the encoder that computes them. So
            // this is the caller's mistake arriving late rather than a fault in this agent, and
            // it is reported as a bad request. Only this type is caught: an
            // IllegalArgumentException from anywhere else in the renderer is a bug here, and
            // reporting it as bad markup would hide it.
            throw PrintRequestException.of("invalid_tag_argument", e.getMessage());
        }
    }
}
