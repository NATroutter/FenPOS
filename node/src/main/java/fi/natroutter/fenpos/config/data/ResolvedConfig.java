package fi.natroutter.fenpos.config.data;

import java.util.Map;
import java.util.Optional;

/**
 * The whole configuration, validated and resolved.
 * <p>
 * Produced once at startup by {@link fi.natroutter.fenpos.config.ConfigResolver} and
 * treated as immutable thereafter, which is what lets it be shared freely across the HTTP
 * threads, the per-device print workers and the console without synchronisation.
 *
 * @param http     HTTP listener settings
 * @param jobs     job retention and shutdown settings
 * @param devices  configured printers, keyed by the name used in request paths
 */
public record ResolvedConfig(
        HttpSettings http,
        JobSettings jobs,
        Map<String, DeviceSettings> devices) {

    /**
     * Defensively copies {@code devices} so the resolved configuration cannot be mutated
     * through the map reference handed to the constructor.
     */
    public ResolvedConfig {
        devices = Map.copyOf(devices);
    }

    /**
     * Looks up a device by the name used in a request path.
     *
     * @param name device name; may be {@code null}, which yields an empty result
     * @return the device, or empty if no device is configured under that name
     */
    public Optional<DeviceSettings> device(String name) {
        return name == null ? Optional.empty() : Optional.ofNullable(devices.get(name));
    }
}
