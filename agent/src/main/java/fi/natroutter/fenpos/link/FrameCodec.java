package fi.natroutter.fenpos.link;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParseException;
import com.google.gson.JsonParser;
import fi.natroutter.fenpos.AgentSettings;
import fi.natroutter.fenpos.enums.Align;
import fi.natroutter.fenpos.enums.BarcodeSystem;
import fi.natroutter.fenpos.enums.Codepage;
import fi.natroutter.fenpos.enums.CutMode;
import fi.natroutter.fenpos.enums.FlowControl;
import fi.natroutter.fenpos.enums.Font;
import fi.natroutter.fenpos.enums.Linefeed;
import fi.natroutter.fenpos.enums.Parity;
import fi.natroutter.fenpos.link.Frames.AgentFrame;
import fi.natroutter.fenpos.link.Frames.AssetRaster;
import fi.natroutter.fenpos.link.Frames.CompiledJob;
import fi.natroutter.fenpos.link.Frames.ConfigSync;
import fi.natroutter.fenpos.link.Frames.DeviceCommand;
import fi.natroutter.fenpos.link.Frames.DeviceConfig;
import fi.natroutter.fenpos.link.Frames.JobCancel;
import fi.natroutter.fenpos.link.Frames.JobDispatch;
import fi.natroutter.fenpos.link.Frames.PortsScan;
import fi.natroutter.fenpos.link.Frames.RawWrite;
import fi.natroutter.fenpos.link.Frames.ServerFrame;
import fi.natroutter.fenpos.link.Frames.Welcome;
import fi.natroutter.fenpos.link.Frames.WireDirective;
import fi.natroutter.fenpos.link.Frames.WireLine;
import fi.natroutter.fenpos.link.Frames.WireSpan;
import fi.natroutter.fenpos.print.JobSettings;

import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Base64;
import java.util.List;
import java.util.regex.Pattern;

/**
 * Reads and writes link frames.
 *
 * <p>This is the boundary at which the agent stops trusting the server. Authenticating a
 * connection establishes who the peer is, not that everything it sends is sane: a compromised
 * or simply buggy server must not be able to drive this process into an unbounded allocation
 * or hand a printer bytes it cannot render. Every field is therefore checked here, with the
 * same bounds the server applies on its side.
 *
 * <p>Deserialisation is written by hand rather than delegated to a reflective binder. A
 * reflective mapper silently accepts a missing field as null and an unknown field as noise,
 * which is precisely the behaviour a protocol boundary must not have.
 */
public final class FrameCodec {

    /**
     * Largest frame accepted, in bytes.
     *
     * <p>Matches MAX_FRAME_BYTES on the server. Checked before parsing, so an oversized frame
     * is rejected without being turned into an object graph first.
     */
    public static final int MAX_FRAME_BYTES = 256 * 1024;

    /** Printed lines in one job. */
    private static final int MAX_LINES = 1000;

    /** Styled runs within one line. */
    private static final int MAX_SPANS_PER_LINE = 64;

    /** Characters in one span. */
    private static final int MAX_SPAN_CHARS = 512;

    /** Directives attached to one line. */
    private static final int MAX_DIRECTIVES_PER_LINE = 8;

    /** Devices in one configuration snapshot. */
    private static final int MAX_DEVICES = 256;

    /** Longest base64 payload accepted for a raw write. Mirrors the server's own cap. */
    private static final int MAX_RAW_CHARS = 16_384;

    /** Rasters one configuration snapshot may carry. Mirrors IMAGE_LIMITS on the server. */
    private static final int MAX_SYNCED_RASTERS = 32;

    /** Longest base64 payload accepted for one raster, synced or carried in a job. */
    private static final int MAX_RASTER_CHARS = 128 * 1024;

    /** Widest raster accepted, in dots — far beyond the ~576 of the widest common paper. */
    private static final int MAX_RASTER_WIDTH_DOTS = 4096;

    /** Tallest raster accepted, in dots: what {@code GS v 0} encodes in its two vertical bytes. */
    private static final int MAX_RASTER_HEIGHT_DOTS = 65_535;

    /** Longest identifier accepted. Mirrors idSchema and requestIdSchema on the server. */
    private static final int MAX_ID_CHARS = 64;

    /** Longest serial port path accepted. Mirrors deviceConfigSchema.port. */
    private static final int MAX_PORT_CHARS = 256;

    /**
     * Longest agent name accepted. Mirrors the maximum {@code welcomeSchema.agentName} declares on
     * the server; that field has no minimum there, so there is none to mirror here.
     */
    private static final int MAX_AGENT_NAME_CHARS = 128;

    /**
     * The shape every device and asset name takes. Mirrors deviceNameSchema on the server.
     *
     * <p>Restricting the shape here is what lets every consumer downstream stop escaping: a name
     * that cannot contain a newline, an escape or a brace cannot forge a log line, cannot retitle
     * an operator's terminal, and cannot be refused by the server when it comes back on a status
     * report.
     */
    private static final Pattern SLUG = Pattern.compile("^[a-z0-9][a-z0-9_-]*$");

    /** Serialises outgoing frames. Nulls are omitted so optional fields are simply absent. */
    private final Gson gson = new GsonBuilder().create();

    /**
     * Serialises a frame for transmission.
     *
     * @param frame the frame to send
     * @return the JSON text to write to the socket
     */
    public String write(AgentFrame frame) {
        JsonObject json = gson.toJsonTree(frame).getAsJsonObject();
        // The discriminator is derived from the type rather than stored on it, so it cannot
        // disagree with the record that carries it.
        json.addProperty("type", frame.type());
        return gson.toJson(json);
    }

    /**
     * Parses a frame received from the server.
     *
     * @param raw the frame as received
     * @return the parsed frame
     * @throws ProtocolException when the frame is oversized, malformed, or fails validation
     */
    public ServerFrame read(String raw) throws ProtocolException {
        if (raw == null) {
            throw new ProtocolException("frame was null");
        }
        int size = raw.getBytes(StandardCharsets.UTF_8).length;
        if (size > MAX_FRAME_BYTES) {
            throw new ProtocolException("frame of " + size + " bytes exceeds the " + MAX_FRAME_BYTES + " byte limit");
        }

        JsonObject root;
        try {
            JsonElement parsed = JsonParser.parseString(raw);
            if (!parsed.isJsonObject()) {
                throw new ProtocolException("frame was not a JSON object");
            }
            root = parsed.getAsJsonObject();
        } catch (JsonParseException e) {
            throw new ProtocolException("frame was not valid JSON", e);
        }

        String type = requireString(root, "type");

        return switch (type) {
            case "welcome" -> new Welcome(
                    requireInt(root, "protocolVersion"),
                    requireId(root, "agentId"),
                    requireBounded(root, "agentName", 0, MAX_AGENT_NAME_CHARS),
                    requireString(root, "serverTime"));
            case "config.sync" -> readConfigSync(root);
            case "job.dispatch" -> new JobDispatch(readCompiledJob(requireObject(root, "job")));
            case "job.cancel" -> new JobCancel(requireId(root, "jobId"));
            case "raw.write" -> readRawWrite(root);
            case "ports.scan" -> new PortsScan(requireId(root, "requestId"));
            case "device.connect", "device.disconnect", "device.pause", "device.resume",
                 "device.clearQueue", "device.test" -> new DeviceCommand(
                    type,
                    requireId(root, "requestId"),
                    requireSlug(root, "device"),
                    optionalId(root, "jobId"));
            // An unknown type is not an error to crash on: a newer server may send frames this
            // agent has no need to understand. The caller logs and ignores it.
            default -> throw new ProtocolException("unknown frame type '" + type + "'");
        };
    }

    /**
     * Reads a raw write, bounding the payload before it is decoded.
     *
     * <p>The cap is applied to the encoded text rather than the decoded bytes, so an oversized
     * payload is refused without allocating the array it was asking for.
     */
    private RawWrite readRawWrite(JsonObject root) throws ProtocolException {
        String bytes = requireString(root, "bytes");
        if (bytes.length() > MAX_RAW_CHARS) {
            throw new ProtocolException("raw write of " + bytes.length()
                    + " encoded characters exceeds the " + MAX_RAW_CHARS + " limit");
        }
        return new RawWrite(
                requireId(root, "requestId"),
                requireSlug(root, "device"),
                bytes);
    }

    private ConfigSync readConfigSync(JsonObject root) throws ProtocolException {
        var array = requireArray(root, "devices", MAX_DEVICES);
        List<DeviceConfig> devices = new ArrayList<>(array.size());

        for (JsonElement element : array) {
            JsonObject device = asObject(element, "device");
            devices.add(new DeviceConfig(
                    requireSlug(device, "name"),
                    requireBounded(device, "port", 1, MAX_PORT_CHARS),
                    requireBoundedInt(device, "baudRate", 50, 4_000_000),
                    requireBoundedInt(device, "dataBits", 5, 8),
                    requireBoundedInt(device, "stopBits", 1, 2),
                    requireEnum(device, "parity", Parity.class),
                    requireEnum(device, "flowControl", FlowControl.class),
                    requireBoundedInt(device, "writeTimeoutMs", 100, 120_000),
                    requireBoolean(device, "autoConnect"),
                    requireBoolean(device, "autoReconnect"),
                    requireBoundedInt(device, "reconnectDelaySeconds", 1, 3600),
                    requireBoundedInt(device, "columns", 1, 255),
                    requireEnum(device, "codepage", Codepage.class),
                    requireBoolean(device, "paused"),
                    requireBoundedInt(device, "maxQueueDepth", 1, 10_000)));
        }

        var assetArray = requireArray(root, "assets", MAX_SYNCED_RASTERS);
        List<AssetRaster> assets = new ArrayList<>(assetArray.size());
        for (JsonElement element : assetArray) {
            JsonObject asset = asObject(element, "asset");
            Raster raster = readRaster(asset);
            assets.add(new AssetRaster(
                    requireSlug(asset, "name"), raster.widthDots(), raster.heightDots(), raster.packed()));
        }

        JsonObject jobsObject = optionalObject(root, "jobs");
        JobSettings jobs = jobsObject == null ? JobSettings.DEFAULTS : readJobSettings(jobsObject);

        JsonObject agentObject = optionalObject(root, "agent");
        AgentSettings agent = agentObject == null ? AgentSettings.DEFAULTS : readAgentSettings(agentObject);

        return new ConfigSync(devices, assets, jobs, agent);
    }

    /**
     * Reads the job settings a {@code config.sync} carries, restating the server's own bounds.
     *
     * <p>The object is optional on the wire — {@link #readConfigSync} supplies
     * {@link JobSettings#DEFAULTS} when it is absent — but once present every field within it is
     * required and bounded the same way every other field on this frame is: a receiver that
     * trusts the sender's validation has not validated anything.
     *
     * @param jobs the {@code jobs} object of a {@code config.sync} frame
     * @return the settings it describes
     * @throws ProtocolException when a field is missing or out of range
     */
    private static JobSettings readJobSettings(JsonObject jobs) throws ProtocolException {
        return new JobSettings(
                Duration.ofMinutes(requireBoundedInt(jobs, "retentionMinutes", 1, 40_320)),
                requireBoundedInt(jobs, "maxRecords", 100, 1_000_000),
                Duration.ofSeconds(requireBoundedInt(jobs, "shutdownGraceSeconds", 1, 300)));
    }

    /**
     * Reads the agent-side timing settings a {@code config.sync} carries, restating the
     * server's own bounds.
     *
     * <p>The object is optional on the wire — {@link #readConfigSync} supplies
     * {@link AgentSettings#DEFAULTS} when it is absent — but once present every field within it
     * is required and bounded the same way every other field on this frame is: a receiver that
     * trusts the sender's validation has not validated anything.
     *
     * @param agent the {@code agent} object of a {@code config.sync} frame
     * @return the settings it describes
     * @throws ProtocolException when a field is missing or out of range
     */
    private static AgentSettings readAgentSettings(JsonObject agent) throws ProtocolException {
        return new AgentSettings(
                Duration.ofSeconds(requireBoundedInt(agent, "statusIntervalSeconds", 5, 300)),
                Duration.ofSeconds(requireBoundedInt(agent, "evictionIntervalSeconds", 10, 3_600)),
                Duration.ofMillis(requireBoundedInt(agent, "queuePollMs", 20, 2_000)));
    }

    /**
     * Reads a raster: its rectangle, and the bits that fill it.
     *
     * <p>The size check is the one that matters. ESC/POS {@code GS v 0} declares how many bytes
     * follow and the printer then reads exactly that many, so a raster whose bits fall short of
     * its declared rectangle does not print a short image — the printer waits for bytes that never
     * arrive and consumes the rest of the job as image data, which ends in a power cycle rather
     * than a failed job. Checking the count here is what keeps that impossible, and it is why this
     * is worth doing at the boundary rather than trusting the server to have got it right.
     *
     * <p>The encoded length is capped before the array is decoded, so an oversized payload is
     * refused without allocating what it was asking for — the same order {@code readRawWrite} uses.
     *
     * @param raster the object carrying {@code widthDots}, {@code heightDots} and {@code data}
     * @return the rectangle and its bits
     * @throws ProtocolException when a field is missing, out of range, not base64, or the bits do
     *         not fill the rectangle
     */
    private static Raster readRaster(JsonObject raster) throws ProtocolException {
        int widthDots = requireBoundedInt(raster, "widthDots", 1, MAX_RASTER_WIDTH_DOTS);
        int heightDots = requireBoundedInt(raster, "heightDots", 1, MAX_RASTER_HEIGHT_DOTS);

        String data = requireString(raster, "data");
        if (data.length() > MAX_RASTER_CHARS) {
            throw new ProtocolException("raster of " + data.length()
                    + " encoded characters exceeds the " + MAX_RASTER_CHARS + " limit");
        }

        byte[] packed;
        try {
            packed = Base64.getDecoder().decode(data);
        } catch (IllegalArgumentException e) {
            throw new ProtocolException("field 'data' was not valid base64", e);
        }

        int expected = ((widthDots + 7) / 8) * heightDots;
        if (packed.length != expected) {
            throw new ProtocolException("a " + widthDots + "x" + heightDots + " raster is " + expected
                    + " bytes of one bit per dot, but " + packed.length + " arrived");
        }

        return new Raster(widthDots, heightDots, packed);
    }

    /** A raster as {@link #readRaster} read it, before it is put into the frame it belongs to. */
    private record Raster(int widthDots, int heightDots, byte[] packed) {
    }

    private CompiledJob readCompiledJob(JsonObject job) throws ProtocolException {
        var array = requireArray(job, "lines", MAX_LINES);
        List<WireLine> lines = new ArrayList<>(array.size());

        for (JsonElement element : array) {
            lines.add(readLine(asObject(element, "line")));
        }

        return new CompiledJob(
                requireId(job, "jobId"),
                requireSlug(job, "device"),
                requireEnum(job, "linefeed", Linefeed.class),
                lines);
    }

    private WireLine readLine(JsonObject line) throws ProtocolException {
        var spanArray = requireArray(line, "spans", MAX_SPANS_PER_LINE);
        List<WireSpan> spans = new ArrayList<>(spanArray.size());
        for (JsonElement element : spanArray) {
            JsonObject span = asObject(element, "span");
            String text = requireString(span, "text");
            if (text.length() > MAX_SPAN_CHARS) {
                throw new ProtocolException("span of " + text.length() + " characters exceeds " + MAX_SPAN_CHARS);
            }
            spans.add(new WireSpan(
                    text,
                    requireBoolean(span, "bold"),
                    requireBoundedInt(span, "underline", 0, 2),
                    requireBoolean(span, "invert"),
                    requireBoundedInt(span, "widthMult", 1, 8),
                    requireBoundedInt(span, "heightMult", 1, 8),
                    requireEnum(span, "font", Font.class)));
        }

        var directiveArray = requireArray(line, "directives", MAX_DIRECTIVES_PER_LINE);
        List<WireDirective> directives = new ArrayList<>(directiveArray.size());
        for (JsonElement element : directiveArray) {
            directives.add(readDirective(asObject(element, "directive")));
        }

        return new WireLine(requireEnum(line, "align", Align.class), spans, directives);
    }

    /**
     * Reads one directive, refusing any type this agent cannot render.
     *
     * <p>The refusal is what {@link Frames#PROTOCOL_VERSION} exists to prevent reaching: a server
     * speaking a newer protocol would otherwise send a directive this agent fails the job on,
     * receipt by receipt, instead of being turned away once at the handshake.
     *
     * @param directive the directive object as received
     * @return the parsed directive
     * @throws ProtocolException when the type is unknown or a field is missing or out of range
     */
    static WireDirective readDirective(JsonObject directive) throws ProtocolException {
        String type = requireString(directive, "type");

        return switch (type) {
            case "CUT" -> new WireDirective.Cut(requireEnum(directive, "mode", CutMode.class));
            // Bounded to one byte because that is what the ESC/POS feed command encodes;
            // a larger value would be silently truncated by the printer.
            case "FEED" -> new WireDirective.Feed(requireBoundedInt(directive, "lines", 1, 255));
            // Sizes and error levels are bounded to what the ESC/POS commands encode. The
            // server applies the same bounds; repeating them is what makes this a boundary
            // rather than a place that trusts the server got it right.
            case "QR" -> new WireDirective.Qr(
                    requireAsciiContent(directive),
                    requireBoundedInt(directive, "size", 1, 16));
            case "BARCODE" -> new WireDirective.Barcode(
                    requireEnum(directive, "system", BarcodeSystem.class),
                    requireContent(directive));
            // The column count is bounded 1..30 rather than 0..30: zero is what function 65 reads
            // as "printer decides", and a server that meant to say that would be sending a symbol
            // it could not have charged a line budget for.
            case "PDF417" -> new WireDirective.Pdf417(
                    requireAsciiContent(directive),
                    requireBoundedInt(directive, "errorLevel", 0, 8),
                    requireBoundedInt(directive, "columns", 1, 30));
            case "DRAWER" -> new WireDirective.Drawer(requireDrawerPin(directive));
            case "IMAGE" -> readImage(requireObject(directive, "source"));
            default -> throw new ProtocolException("unknown directive type '" + type + "'");
        };
    }

    /**
     * Reads an image, which arrives as one of two shapes.
     *
     * <p>Whether the dots are already here or come with the job is a property of the image rather
     * than of the tag: a stored image at one of this agent's paper widths was synced, and a URL or
     * an unusual width could not have been. The server has already decided, so this only has to
     * read what it decided — the two shapes are distinct records, so nothing downstream can meet a
     * reference and a raster in the same object and have to guess which is real.
     *
     * @param source the {@code source} object of an {@code IMAGE} directive
     * @return the directive
     * @throws ProtocolException when the kind is unknown or a field is missing or out of range
     */
    private static WireDirective readImage(JsonObject source) throws ProtocolException {
        String kind = requireString(source, "kind");

        return switch (kind) {
            case "REF" -> new WireDirective.StoredImage(
                    requireSlug(source, "ref"),
                    requireBoundedInt(source, "widthDots", 1, MAX_RASTER_WIDTH_DOTS));
            case "INLINE" -> {
                Raster raster = readRaster(source);
                yield new WireDirective.InlineImage(raster.widthDots(), raster.heightDots(), raster.packed());
            }
            default -> throw new ProtocolException("unknown image source '" + kind + "'");
        };
    }

    /**
     * Reads a symbol's payload, refusing an empty one.
     *
     * <p>An empty symbol is not a smaller symbol: there is nothing for the encoder to lay out,
     * and the library would fail on it further down where the message names a regex rather than
     * the job.
     */
    private static String requireContent(JsonObject directive) throws ProtocolException {
        String content = requireString(directive, "content");
        if (content.isEmpty()) {
            throw new ProtocolException("field 'content' must not be empty");
        }
        return content;
    }

    /**
     * Reads a two-dimensional symbol's payload, refusing anything outside ASCII.
     *
     * <p>Not a preference: escpos-coffee assembles the {@code GS ( k} store-data command with a
     * length taken from {@code String.length()} — a count of characters — while writing the
     * string's UTF-8 bytes. One character above U+007F makes the two disagree, and the printer
     * reads a truncated payload as a valid symbol. It scans, and it scans as the wrong thing.
     *
     * <p>Refused here because this is the last point at which the job can still be reported as
     * failed. The server refuses the same content at compile time, where the caller gets a line
     * and column; this is the backstop for a server that did not. The linear symbologies need no
     * equivalent — the library's own alphabets are ASCII-only, so they refuse it themselves.
     */
    private static String requireAsciiContent(JsonObject directive) throws ProtocolException {
        String content = requireContent(directive);
        for (int index = 0; index < content.length(); index++) {
            if (content.charAt(index) > 0x7F) {
                throw new ProtocolException("field 'content' must be ASCII; '"
                        + content.charAt(index) + "' at index " + index
                        + " cannot be encoded into a symbol this agent can size correctly");
            }
        }
        return content;
    }

    /**
     * Reads a cash drawer pin.
     *
     * <p>A pair rather than a range: the connector has two pins, and 3 is not a smaller 5.
     */
    private static int requireDrawerPin(JsonObject directive) throws ProtocolException {
        int pin = requireInt(directive, "pin");
        if (pin != 2 && pin != 5) {
            throw new ProtocolException("field 'pin' must be 2 or 5, got " + pin);
        }
        return pin;
    }

    // ---------------------------------------------------------------------
    // Field readers. Each states what was missing rather than yielding null.
    // ---------------------------------------------------------------------

    private static JsonObject requireObject(JsonObject parent, String field) throws ProtocolException {
        JsonElement element = parent.get(field);
        if (element == null || !element.isJsonObject()) {
            throw new ProtocolException("field '" + field + "' must be an object");
        }
        return element.getAsJsonObject();
    }

    /**
     * Reads an object the frame may leave out.
     *
     * <p>Absent and JSON null both read as null; a value of any other type is refused, so an
     * optional field cannot become a way to slip a wrong-typed value past the codec. Written
     * because {@code JsonObject.getAsJsonObject(String)} is an unchecked cast: it threw a
     * {@code ClassCastException} straight past this class's contract, and the caller on the
     * receive path only catches {@link ProtocolException}, so one bad optional field closed
     * the socket.
     */
    private static JsonObject optionalObject(JsonObject parent, String field) throws ProtocolException {
        JsonElement element = parent.get(field);
        if (element == null || element.isJsonNull()) {
            return null;
        }
        return requireObject(parent, field);
    }

    private static JsonObject asObject(JsonElement element, String what) throws ProtocolException {
        if (element == null || !element.isJsonObject()) {
            throw new ProtocolException(what + " must be an object");
        }
        return element.getAsJsonObject();
    }

    private static com.google.gson.JsonArray requireArray(JsonObject parent, String field, int max)
            throws ProtocolException {
        JsonElement element = parent.get(field);
        if (element == null || !element.isJsonArray()) {
            throw new ProtocolException("field '" + field + "' must be an array");
        }
        var array = element.getAsJsonArray();
        if (array.size() > max) {
            throw new ProtocolException("field '" + field + "' has " + array.size() + " entries, limit is " + max);
        }
        return array;
    }

    private static String requireString(JsonObject parent, String field) throws ProtocolException {
        JsonElement element = parent.get(field);
        if (element == null || !element.isJsonPrimitive() || !element.getAsJsonPrimitive().isString()) {
            throw new ProtocolException("field '" + field + "' must be a string");
        }
        return element.getAsString();
    }

    /**
     * Reads a string of a bounded length.
     *
     * @param min shortest accepted, which is 1 wherever the server writes {@code min(1)}
     * @param max longest accepted
     */
    private static String requireBounded(JsonObject parent, String field, int min, int max)
            throws ProtocolException {
        String value = requireString(parent, field);
        if (value.length() < min || value.length() > max) {
            throw new ProtocolException("field '" + field + "' must be " + min + ".." + max
                    + " characters, got " + value.length());
        }
        return value;
    }

    /** Reads an identifier: 1..64 characters, the bound every id on this protocol shares. */
    private static String requireId(JsonObject parent, String field) throws ProtocolException {
        return requireBounded(parent, field, 1, MAX_ID_CHARS);
    }

    /** Reads an identifier the frame may leave out, bounded the same way when it is present. */
    private static String optionalId(JsonObject parent, String field) throws ProtocolException {
        JsonElement element = parent.get(field);
        if (element == null || element.isJsonNull()) {
            return null;
        }
        return requireId(parent, field);
    }

    /** Reads a name: an identifier that is also a slug. */
    private static String requireSlug(JsonObject parent, String field) throws ProtocolException {
        String value = requireId(parent, field);
        if (!SLUG.matcher(value).matches()) {
            throw new ProtocolException("field '" + field + "' must be lowercase alphanumeric with "
                    + "dashes or underscores, got '" + value + "'");
        }
        return value;
    }

    private static boolean requireBoolean(JsonObject parent, String field) throws ProtocolException {
        JsonElement element = parent.get(field);
        if (element == null || !element.isJsonPrimitive() || !element.getAsJsonPrimitive().isBoolean()) {
            throw new ProtocolException("field '" + field + "' must be a boolean");
        }
        return element.getAsBoolean();
    }

    private static int requireInt(JsonObject parent, String field) throws ProtocolException {
        JsonElement element = parent.get(field);
        if (element == null || !element.isJsonPrimitive() || !element.getAsJsonPrimitive().isNumber()) {
            throw new ProtocolException("field '" + field + "' must be a number");
        }
        double value = element.getAsDouble();
        if (value != Math.floor(value) || Double.isInfinite(value)) {
            throw new ProtocolException("field '" + field + "' must be a whole number");
        }
        return (int) value;
    }

    private static int requireBoundedInt(JsonObject parent, String field, int min, int max)
            throws ProtocolException {
        int value = requireInt(parent, field);
        if (value < min || value > max) {
            throw new ProtocolException("field '" + field + "' must be " + min + ".." + max + ", got " + value);
        }
        return value;
    }

    private static <E extends Enum<E>> E requireEnum(JsonObject parent, String field, Class<E> type)
            throws ProtocolException {
        String raw = requireString(parent, field);
        for (E constant : type.getEnumConstants()) {
            if (constant.name().equals(raw)) {
                return constant;
            }
        }
        throw new ProtocolException("field '" + field + "' has no value '" + raw + "' in " + type.getSimpleName());
    }
}
