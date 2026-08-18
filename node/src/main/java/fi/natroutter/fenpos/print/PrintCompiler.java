package fi.natroutter.fenpos.print;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParseException;
import com.google.gson.JsonParser;
import fi.natroutter.fenpos.config.data.DeviceSettings;
import fi.natroutter.fenpos.config.data.LimitSettings;
import fi.natroutter.fenpos.config.data.PrintSettings;
import fi.natroutter.fenpos.encoding.CharsetValidator;
import fi.natroutter.fenpos.encoding.EscPosRenderer;
import fi.natroutter.fenpos.encoding.UnsupportedCharacterException;
import fi.natroutter.fenpos.enums.Linefeed;
import fi.natroutter.fenpos.markup.LineWrapper;
import fi.natroutter.fenpos.markup.MarkupException;
import fi.natroutter.fenpos.markup.MarkupParser;
import fi.natroutter.fenpos.markup.model.Line;
import fi.natroutter.fenpos.util.Enums;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.util.ArrayList;
import java.util.List;

/**
 * Turns a request body into a printable payload, or explains precisely why it cannot.
 * <p>
 * Every stage runs synchronously, before the request is acknowledged. That is what lets the
 * queue hold finished bytes rather than raw JSON: once a job is accepted it can only fail
 * for hardware reasons, and every content problem has already been reported to the caller
 * with the line and column that caused it.
 * <p>
 * Stages are ordered cheapest-first. Limits are enforced before any element is parsed, so
 * an oversized request is refused without doing the work it was trying to provoke.
 */
public final class PrintCompiler {

    private static final String FIELD_DATA = "data";
    private static final String FIELD_WRAP = "wrap";
    private static final String FIELD_LINEFEED = "linefeed";

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
    public static CompiledJob compile(String body, DeviceSettings device)
            throws PrintRequestException {
        JsonObject root = parseObject(body);
        List<String> elements = readData(root, device.limits());

        boolean wrap = readWrap(root, device.print());
        Linefeed linefeed = readLinefeed(root, device.print());

        List<Line> lines = layOut(elements, device, wrap);
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
     * Reads and limit-checks the {@code data} array.
     * <p>
     * Lengths are measured on the raw strings, before markup is interpreted, so the totals
     * a client computes match the totals enforced here.
     */
    private static List<String> readData(JsonObject root, LimitSettings limits)
            throws PrintRequestException {
        JsonElement data = root.get(FIELD_DATA);
        if (data == null || data.isJsonNull()) {
            throw PrintRequestException.of("missing_field", "'data' is required");
        }
        if (!data.isJsonArray()) {
            throw PrintRequestException.of("invalid_type", "'data' must be an array of strings");
        }

        JsonArray array = data.getAsJsonArray();
        if (array.size() > limits.maxLines()) {
            throw PrintRequestException.of("too_many_lines",
                    "At most " + limits.maxLines() + " lines are allowed, got " + array.size());
        }

        List<String> elements = new ArrayList<>(array.size());
        int total = 0;
        for (int index = 0; index < array.size(); index++) {
            int line = index + 1;
            JsonElement element = array.get(index);
            if (!element.isJsonPrimitive() || !element.getAsJsonPrimitive().isString()) {
                throw PrintRequestException.atLine("invalid_type", line,
                        "Every element of 'data' must be a string");
            }

            String text = element.getAsString();
            if (text.length() > limits.maxLineChars()) {
                throw PrintRequestException.atLine("line_too_long", line,
                        "At most " + limits.maxLineChars() + " characters are allowed per line, got "
                                + text.length());
            }

            total += text.length();
            if (total > limits.maxTotalChars()) {
                throw PrintRequestException.atLine("text_too_large", line,
                        "At most " + limits.maxTotalChars() + " characters are allowed in total");
            }
            elements.add(text);
        }
        return elements;
    }

    private static boolean readWrap(JsonObject root, PrintSettings print)
            throws PrintRequestException {
        JsonElement wrap = root.get(FIELD_WRAP);
        if (wrap == null || wrap.isJsonNull()) {
            return print.defaultWrap();
        }
        if (!wrap.isJsonPrimitive() || !wrap.getAsJsonPrimitive().isBoolean()) {
            throw PrintRequestException.of("invalid_type", "'wrap' must be true or false");
        }
        return wrap.getAsBoolean();
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
     * Parses, validates and wraps each element, translating the positional failures raised
     * by the parser and the encoder into request-level errors carrying the element index.
     */
    private static List<Line> layOut(List<String> elements, DeviceSettings device, boolean wrap)
            throws PrintRequestException {
        PrintSettings print = device.print();
        List<Line> lines = new ArrayList<>(elements.size());

        for (int index = 0; index < elements.size(); index++) {
            int lineNumber = index + 1;
            try {
                Line parsed = MarkupParser.parse(elements.get(index));
                Line checked = CharsetValidator.validate(
                        parsed, print.codepage(), print.onUnsupported());
                lines.addAll(wrap
                        ? LineWrapper.wrap(checked, print.columns())
                        : List.of(checked));
            } catch (MarkupException e) {
                throw PrintRequestException.at(
                        e.error().apiCode(), lineNumber, e.column(), e.getMessage());
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

    /** Counts lines that advance the paper; directive-only lines do not. */
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
        }
    }
}
