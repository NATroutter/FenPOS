package fi.natroutter.fenpos.config;

import fi.natroutter.fenpos.config.data.Config;
import fi.natroutter.fenpos.config.data.DeviceSettings;
import fi.natroutter.fenpos.config.data.HttpSettings;
import fi.natroutter.fenpos.config.data.JobSettings;
import fi.natroutter.fenpos.config.data.LimitSettings;
import fi.natroutter.fenpos.config.data.PrintSettings;
import fi.natroutter.fenpos.config.data.ResolvedConfig;
import fi.natroutter.fenpos.config.data.SerialSettings;
import fi.natroutter.fenpos.enums.Codepage;
import fi.natroutter.fenpos.enums.FlowControl;
import fi.natroutter.fenpos.enums.Linefeed;
import fi.natroutter.fenpos.enums.Parity;
import fi.natroutter.fenpos.enums.UnsupportedPolicy;
import fi.natroutter.fenpos.util.Enums;

import java.time.Duration;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Pattern;

/**
 * Checks that a {@link Config} bound from {@code config.yaml} describes a usable system,
 * reporting every defect at once.
 * <p>
 * Validation runs during startup and a failure aborts it. That is deliberate: a printer
 * daemon that starts with a broken device only reveals the problem when someone tries to
 * print, which is the worst possible moment to discover it.
 */
public final class ConfigResolver {

    /**
     * Shortest accepted {@code authKey}. A bearer credential on a network-reachable
     * endpoint is worth brute-forcing, and a short key offers no meaningful resistance.
     */
    private static final int MIN_AUTH_KEY_LENGTH = 16;

    /** Lowest valid TCP port. Port 0 would bind an arbitrary ephemeral port. */
    private static final int MIN_PORT = 1;

    /** Highest valid TCP port. */
    private static final int MAX_PORT = 65535;

    /**
     * Device names are substituted into request paths such as {@code /print/<device>}, so
     * they are restricted to characters that need no escaping and cannot alter the path
     * structure.
     */
    private static final Pattern VALID_DEVICE_NAME = Pattern.compile("[A-Za-z0-9_-]+");

    private ConfigResolver() {
    }

    /**
     * Checks the given configuration.
     *
     * @param config the configuration bound from {@code config.yaml}
     * @throws ConfigurationException if the configuration cannot be used as given; the
     *                                exception carries every problem found, not just the first
     */
    public static ResolvedConfig resolve(Config config) throws ConfigurationException {
        List<ConfigProblem> problems = new ArrayList<>();

        validateHttpServer(config.getHttpServer(), problems);
        validateDevices(config.getDevices(), problems);

        if (!problems.isEmpty()) {
            throw new ConfigurationException(problems);
        }

        LimitSettings globalLimits = resolveLimits(config.getLimits(), LimitSettings.DEFAULTS);
        Map<String, DeviceSettings> devices = new LinkedHashMap<>();
        config.getDevices().forEach((name, device) ->
                devices.put(name, resolveDevice(name, device, globalLimits)));

        return new ResolvedConfig(
                resolveHttp(config.getHttpServer()),
                resolveJobs(config.getJobs()),
                devices);
    }

    // -------------------------------------------------------------------------
    // Resolution
    // -------------------------------------------------------------------------

    private static HttpSettings resolveHttp(Config.HttpServer http) {
        return new HttpSettings(
                http.isEnabled(), http.getHost(), http.getPort(), http.getPublicAddress());
    }

    private static JobSettings resolveJobs(Config.Jobs jobs) {
        JobSettings defaults = JobSettings.DEFAULTS;
        if (jobs == null) {
            return defaults;
        }
        return new JobSettings(
                jobs.getRetentionMinutes() == null
                        ? defaults.retention() : Duration.ofMinutes(jobs.getRetentionMinutes()),
                orDefault(jobs.getMaxRecords(), defaults.maxRecords()),
                jobs.getShutdownGraceSeconds() == null
                        ? defaults.shutdownGrace() : Duration.ofSeconds(jobs.getShutdownGraceSeconds()));
    }

    private static DeviceSettings resolveDevice(String name, Config.Device device, LimitSettings globalLimits) {
        SerialSettings serial = new SerialSettings(
                device.getPort().strip(),
                orDefault(device.getBaudRate(), 9600),
                orDefault(device.getDataBits(), 8),
                orDefault(device.getStopBits(), 1),
                Enums.parse(Parity.class, device.getParity()).orElse(Parity.NONE),
                Enums.parse(FlowControl.class, device.getFlowControl()).orElse(FlowControl.NONE),
                orDefault(device.getAutoConnect(), true),
                orDefault(device.getAutoReconnect(), true),
                Duration.ofSeconds(orDefault(device.getReconnectDelaySeconds(), 5)),
                Duration.ofMillis(orDefault(device.getWriteTimeoutMs(), 5000)));

        PrintSettings print = new PrintSettings(
                device.getColumns(),
                Enums.parse(Codepage.class, device.getCodepage()).orElse(Codepage.CP858),
                Enums.parse(UnsupportedPolicy.class, device.getOnUnsupported()).orElse(UnsupportedPolicy.REJECT),
                orDefault(device.getDefaultWrap(), true),
                Enums.parse(Linefeed.class, device.getDefaultLinefeed()).orElse(Linefeed.LF));

        return new DeviceSettings(
                name, device.getAuthKey(), serial, print,
                resolveLimits(device.getLimits(), globalLimits));
    }

    /**
     * Merges one layer of limits over the layer beneath it, field by field, so a device may
     * override a single limit without restating the rest.
     *
     * @param overrides the more specific layer; {@code null} means "override nothing"
     * @param base      the layer to fall back to for every unset field
     */
    private static LimitSettings resolveLimits(Config.Limits overrides, LimitSettings base) {
        if (overrides == null) {
            return base;
        }
        return new LimitSettings(
                orDefault(overrides.getMaxBodyBytes(), base.maxBodyBytes()),
                orDefault(overrides.getMaxLines(), base.maxLines()),
                orDefault(overrides.getMaxLineChars(), base.maxLineChars()),
                orDefault(overrides.getMaxTotalChars(), base.maxTotalChars()),
                orDefault(overrides.getMaxOutputLines(), base.maxOutputLines()),
                orDefault(overrides.getMaxQueueDepth(), base.maxQueueDepth()));
    }

    private static int orDefault(Integer value, int fallback) {
        return value == null ? fallback : value;
    }

    private static boolean orDefault(Boolean value, boolean fallback) {
        return value == null ? fallback : value;
    }

    private static void validateHttpServer(Config.HttpServer http, List<ConfigProblem> problems) {
        if (http == null) {
            problems.add(new ConfigProblem("httpServer", "Section is required"));
            return;
        }
        if (http.getPort() < MIN_PORT || http.getPort() > MAX_PORT) {
            problems.add(new ConfigProblem("httpServer.port",
                    "Must be between " + MIN_PORT + " and " + MAX_PORT + ", got " + http.getPort()));
        }
        if (isBlank(http.getHost())) {
            problems.add(new ConfigProblem("httpServer.host",
                    "An interface is required; use 0.0.0.0 in a container, 127.0.0.1 otherwise"));
        }
    }

    private static void validateDevices(Map<String, Config.Device> devices, List<ConfigProblem> problems) {
        if (devices == null || devices.isEmpty()) {
            problems.add(new ConfigProblem("devices", "At least one device must be configured"));
            return;
        }

        Map<String, String> deviceNameByAuthKey = new HashMap<>();
        devices.forEach((name, device) -> validateDevice(name, device, deviceNameByAuthKey, problems));
    }

    private static void validateDevice(String name,
                                       Config.Device device,
                                       Map<String, String> deviceNameByAuthKey,
                                       List<ConfigProblem> problems) {
        String base = "devices." + name;

        if (!VALID_DEVICE_NAME.matcher(name).matches()) {
            problems.add(new ConfigProblem(base,
                    "Device names appear in request paths, so they may only contain "
                            + "letters, digits, hyphens and underscores"));
        }

        if (device == null) {
            problems.add(new ConfigProblem(base, "Device has no settings"));
            return;
        }

        if (isBlank(device.getPort())) {
            problems.add(new ConfigProblem(base + ".port",
                    "A serial port is required, such as COM3 or /dev/ttyUSB0"));
        }

        validateAuthKey(base, name, device.getAuthKey(), deviceNameByAuthKey, problems);
        validateColumns(base, device.getColumns(), problems);

        requireKnownConstant(base + ".codepage", Codepage.class, device.getCodepage(), problems);
        requireKnownConstant(base + ".parity", Parity.class, device.getParity(), problems);
        requireKnownConstant(base + ".flowControl", FlowControl.class, device.getFlowControl(), problems);
        requireKnownConstant(base + ".onUnsupported", UnsupportedPolicy.class, device.getOnUnsupported(), problems);
        requireKnownConstant(base + ".defaultLinefeed", Linefeed.class, device.getDefaultLinefeed(), problems);
    }

    private static void validateAuthKey(String base,
                                        String deviceName,
                                        String authKey,
                                        Map<String, String> deviceNameByAuthKey,
                                        List<ConfigProblem> problems) {
        if (isBlank(authKey)) {
            problems.add(new ConfigProblem(base + ".authKey",
                    "A bearer key is required; generate one with the 'keygen' console command"));
            return;
        }
        if (authKey.length() < MIN_AUTH_KEY_LENGTH) {
            problems.add(new ConfigProblem(base + ".authKey",
                    "Must be at least " + MIN_AUTH_KEY_LENGTH + " characters, got " + authKey.length()));
            return;
        }

        String existing = deviceNameByAuthKey.putIfAbsent(authKey, deviceName);
        if (existing != null) {
            problems.add(new ConfigProblem(base + ".authKey",
                    "Key is already used by device '" + existing + "'; each device needs its own"));
        }
    }

    private static void validateColumns(String base, Integer columns, List<ConfigProblem> problems) {
        if (columns == null) {
            problems.add(new ConfigProblem(base + ".columns",
                    "Paper width in characters is required; typically 42 for 80mm or 32 for 58mm"));
            return;
        }
        if (columns < 1) {
            problems.add(new ConfigProblem(base + ".columns",
                    "Must be at least 1, got " + columns));
        }
    }

    /**
     * Reports a problem when {@code value} is present but names no constant of {@code type}.
     * An absent value is accepted here; resolution supplies the documented default.
     */
    private static <E extends Enum<E>> void requireKnownConstant(String path,
                                                                 Class<E> type,
                                                                 String value,
                                                                 List<ConfigProblem> problems) {
        if (isBlank(value)) {
            return;
        }
        if (Enums.parse(type, value).isEmpty()) {
            problems.add(new ConfigProblem(path,
                    "Unknown value '" + value + "'; must be one of: " + Enums.names(type)));
        }
    }

    private static boolean isBlank(String value) {
        return value == null || value.isBlank();
    }
}
