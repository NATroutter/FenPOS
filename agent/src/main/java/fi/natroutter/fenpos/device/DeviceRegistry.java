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
 * there" — along with the images those printers may be asked to draw.
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
     * The images the server dithered for this agent, keyed by name and printed width.
     *
     * <p>Held here rather than fetched per job, which is the whole reason they travel with the
     * configuration: a logo repeated on every receipt of the day is transferred once. Keyed by
     * width as well as name because a raster is dithered for one paper width and is not a
     * picture on another, so an agent with an 80mm and a 58mm printer holds two of each.
     *
     * <p>Replaced wholesale alongside the device set, for the same reason and with the same
     * threading: {@code config.sync} is a snapshot, so adopting one cannot leave a stale raster
     * behind, and a reader on the print thread sees either the old map or the new one.
     */
    private volatile Map<String, Frames.AssetRaster> rasters = Map.of();

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

    /**
     * Replaces the whole set of synced images.
     *
     * <p>Separate from {@link #apply} because the two have different consequences: adopting
     * devices reopens serial ports and rebuilds print queues, while adopting rasters is a map
     * swap. Both are driven by the same frame and neither is a delta.
     *
     * <p>A later entry for a name and width wins over an earlier one. The server sends each pair
     * once, so this only decides what a malformed snapshot does, and taking the last is
     * consistent with reading the frame in order.
     *
     * @param wire every raster the server sent, in the order it sent them
     */
    public void applyRasters(List<Frames.AssetRaster> wire) {
        Objects.requireNonNull(wire, "wire");
        Map<String, Frames.AssetRaster> replacement = new LinkedHashMap<>();
        for (Frames.AssetRaster raster : wire) {
            replacement.put(key(raster.name(), raster.widthDots()), raster);
        }
        rasters = Collections.unmodifiableMap(replacement);
    }

    /**
     * Looks up a synced image.
     *
     * @param name      the image's name, as the job referred to it
     * @param widthDots the printed width the job asked for
     * @return the raster, or empty when this agent was not sent one for that name and width
     */
    public Optional<Frames.AssetRaster> raster(String name, int widthDots) {
        return name == null ? Optional.empty() : Optional.ofNullable(rasters.get(key(name, widthDots)));
    }

    /** Returns how many synced images this agent holds, counting each width separately. */
    public int rasterCount() {
        return rasters.size();
    }

    /** Empties the device set and the images with it, as when the agent is unpaired. */
    public void clear() {
        devices = Map.of();
        rasters = Map.of();
    }

    /** The key a raster is held under: a name is a slug, so it cannot contain the separator. */
    private static String key(String name, int widthDots) {
        return name + "@" + widthDots;
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
