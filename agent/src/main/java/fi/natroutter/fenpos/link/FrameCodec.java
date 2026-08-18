package fi.natroutter.fenpos.link;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParseException;
import com.google.gson.JsonParser;
import fi.natroutter.fenpos.enums.Align;
import fi.natroutter.fenpos.enums.Codepage;
import fi.natroutter.fenpos.enums.FlowControl;
import fi.natroutter.fenpos.enums.Font;
import fi.natroutter.fenpos.enums.Linefeed;
import fi.natroutter.fenpos.enums.Parity;
import fi.natroutter.fenpos.link.Frames.AgentFrame;
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

import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;

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
                    requireString(root, "agentId"),
                    requireString(root, "agentName"),
                    requireString(root, "serverTime"));
            case "config.sync" -> readConfigSync(root);
            case "job.dispatch" -> new JobDispatch(readCompiledJob(requireObject(root, "job")));
            case "job.cancel" -> new JobCancel(requireString(root, "jobId"));
            case "raw.write" -> readRawWrite(root);
            case "ports.scan" -> new PortsScan(requireString(root, "requestId"));
            case "device.connect", "device.disconnect", "device.pause", "device.resume",
                 "device.clearQueue", "device.test" -> new DeviceCommand(
                    type,
                    requireString(root, "requestId"),
                    requireString(root, "device"));
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
                requireString(root, "requestId"),
                requireString(root, "device"),
                bytes);
    }

    private ConfigSync readConfigSync(JsonObject root) throws ProtocolException {
        var array = requireArray(root, "devices", MAX_DEVICES);
        List<DeviceConfig> devices = new ArrayList<>(array.size());

        for (JsonElement element : array) {
            JsonObject device = asObject(element, "device");
            devices.add(new DeviceConfig(
                    requireString(device, "name"),
                    requireString(device, "port"),
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

        return new ConfigSync(devices);
    }

    private CompiledJob readCompiledJob(JsonObject job) throws ProtocolException {
        var array = requireArray(job, "lines", MAX_LINES);
        List<WireLine> lines = new ArrayList<>(array.size());

        for (JsonElement element : array) {
            lines.add(readLine(asObject(element, "line")));
        }

        return new CompiledJob(
                requireString(job, "jobId"),
                requireString(job, "device"),
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

    private WireDirective readDirective(JsonObject directive) throws ProtocolException {
        String type = requireString(directive, "type");

        return switch (type) {
            case "CUT" -> {
                String mode = requireString(directive, "mode");
                if (!mode.equals("FULL") && !mode.equals("PARTIAL")) {
                    throw new ProtocolException("cut mode must be FULL or PARTIAL, got '" + mode + "'");
                }
                yield new WireDirective("CUT", mode, null);
            }
            // Bounded to one byte because that is what the ESC/POS feed command encodes;
            // a larger value would be silently truncated by the printer.
            case "FEED" -> new WireDirective("FEED", null, requireBoundedInt(directive, "lines", 1, 255));
            default -> throw new ProtocolException("unknown directive type '" + type + "'");
        };
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
