package fi.natroutter.fenpos.device;

import fi.natroutter.fenpos.link.Frames;

import java.util.Collection;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.Set;

/**
 * The device set the server last pushed, and the agent's only answer to "what printers are
 * there".
 * <p>
 * Replaces the resolved YAML configuration this agent used to boot from. The difference that
 * matters is timing: the old configuration existed before anything else was constructed and
 * never changed, whereas this starts empty and is replaced whenever a
 * {@link Frames.ConfigSync} arrives. Everything downstream therefore has to cope with devices
 * appearing and disappearing while it runs.
 * <p>
 * {@code config.sync} is always a whole snapshot rather than a delta, so {@link #apply} is a
 * wholesale replacement and is idempotent — an agent that missed changes while disconnected
 * converges on reconnect without either side tracking what the other has seen.
 * <p>
 * <strong>Threading.</strong> The map reference is volatile and every replacement builds a new
 * immutable map, so readers on the console and print threads never see a half-applied
 * snapshot and never block behind the link thread applying one.
 */
public class DeviceRegistry {

    private volatile Map<String, Device> devices = Map.of();

    /**
     * Replaces the whole device set.
     *
     * @param wire the devices as the server described them, in the order it sent them
     */
    public void apply(List<Frames.DeviceConfig> wire) {
        Objects.requireNonNull(wire, "wire");
        Map<String, Device> replacement = new LinkedHashMap<>();
        for (Frames.DeviceConfig config : wire) {
            Device device = Device.from(config);
            replacement.put(device.name(), device);
        }
        devices = Collections.unmodifiableMap(replacement);
    }

    /** Empties the device set, as when the agent is unpaired. */
    public void clear() {
        devices = Map.of();
    }

    /**
     * Looks up a device by name.
     *
     * @param name device name; may be {@code null}, which yields an empty result
     * @return the device, or empty if this agent has no device under that name
     */
    public Optional<Device> device(String name) {
        return name == null ? Optional.empty() : Optional.ofNullable(devices.get(name));
    }

    /** Returns every device, in the order the server sent them. */
    public Collection<Device> all() {
        return devices.values();
    }

    /** Returns every device name, in the order the server sent them. */
    public Set<String> names() {
        return devices.keySet();
    }

    /** Returns how many devices this agent knows about. */
    public int size() {
        return devices.size();
    }
}
