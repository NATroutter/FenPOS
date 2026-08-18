package fi.natroutter.fenpos.config.data;

import lombok.Getter;
import lombok.Setter;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Mutable object graph bound directly to {@code config.yaml} by SnakeYAML.
 * <p>
 * This type is the deserialization boundary and nothing more. Fields are permissive by
 * design: numeric settings are boxed so that {@code null} can mean "inherit", and
 * enum-valued settings are held as {@code String} so an unknown value produces a reported
 * configuration problem instead of a parse failure with no context.
 * <p>
 * Application code never consumes this type. {@link fi.natroutter.fenpos.config.ConfigValidator}
 * converts it once at startup into the immutable
 * {@link fi.natroutter.fenpos.config.data.ResolvedConfig}, which carries real types and
 * fully resolved defaults.
 */
@Getter
@Setter
public class Config {

    /** HTTP listener settings. */
    private HttpServer httpServer;

    /** Global request limits, overridable per device. */
    private Limits limits;

    /** Job retention and shutdown settings. */
    private Jobs jobs;

    /** Configured printers, keyed by the device name used in URLs. */
    private Map<String, Device> devices = new LinkedHashMap<>();

    /** HTTP listener settings. */
    @Getter
    @Setter
    public static class HttpServer {

        /** Whether the HTTP listener starts at all. */
        private boolean enabled = true;

        /**
         * Interface to bind. {@code 127.0.0.1} suits a bare-JVM install; containers must
         * use {@code 0.0.0.0}, because a published port maps to the container's external
         * interface rather than its loopback.
         */
        private String host = "127.0.0.1";

        /** TCP port to bind. */
        private int port = 8080;

        /** Base URL used only to render absolute route URLs in the startup log. */
        private String publicAddress;
    }

    /**
     * Request limits. Every field is boxed: {@code null} means "not set here", which at the
     * global level selects the built-in default and at the device level inherits the global
     * value.
     */
    @Getter
    @Setter
    public static class Limits {

        /** Maximum accepted request body size in bytes. */
        private Integer maxBodyBytes;

        /** Maximum number of elements in the {@code data} array. */
        private Integer maxLines;

        /** Maximum characters in a single {@code data} element. */
        private Integer maxLineChars;

        /** Maximum summed characters across all {@code data} elements. */
        private Integer maxTotalChars;

        /** Maximum text lines remaining after wrapping. */
        private Integer maxOutputLines;

        /** Maximum jobs pending for one device before new requests are rejected. */
        private Integer maxQueueDepth;
    }

    /** Job retention and shutdown settings. */
    @Getter
    @Setter
    public static class Jobs {

        /** How long a finished job record remains readable over HTTP. */
        private Integer retentionMinutes;

        /** Hard cap on retained job records, evicting oldest finished jobs first. */
        private Integer maxRecords;

        /** How long shutdown waits for an in-flight print before failing it. */
        private Integer shutdownGraceSeconds;
    }

    /** A single configured printer. */
    @Getter
    @Setter
    public static class Device {

        /** Serial port name, such as {@code COM3} or {@code /dev/ttyUSB0}. */
        private String port;

        /** Serial baud rate. */
        private Integer baudRate;

        /** Serial data bits. */
        private Integer dataBits;

        /** Serial stop bits. */
        private Integer stopBits;

        /** Parity mode, naming a {@link fi.natroutter.fenpos.enums.Parity} constant. */
        private String parity;

        /** Flow control mode, naming a {@link fi.natroutter.fenpos.enums.FlowControl} constant. */
        private String flowControl;

        /** Whether to open this port during startup. */
        private Boolean autoConnect;

        /** Whether to retry the connection after the device disappears. */
        private Boolean autoReconnect;

        /** Delay between reconnect attempts, in seconds. */
        private Integer reconnectDelaySeconds;

        /** How long a single write may take before the job is failed, in milliseconds. */
        private Integer writeTimeoutMs;

        /** Printable character columns; typically 42 for 80 mm paper and 32 for 58 mm. */
        private Integer columns;

        /** Codepage name, naming a {@link fi.natroutter.fenpos.enums.Codepage} constant. */
        private String codepage;

        /**
         * What to do with a character the codepage cannot represent, naming an
         * {@link fi.natroutter.fenpos.enums.UnsupportedPolicy} constant.
         */
        private String onUnsupported;

        /** Default for the request's {@code wrap} field when it is omitted. */
        private Boolean defaultWrap;

        /**
         * Default for the request's {@code linefeed} field when it is omitted, naming a
         * {@link fi.natroutter.fenpos.enums.Linefeed} constant.
         */
        private String defaultLinefeed;

        /** Bearer credential accepted for this device. Never logged. */
        private String authKey;

        /** Per-device limit overrides; any unset field inherits the global value. */
        private Limits limits;
    }
}
