package fi.natroutter.fenpos.print;

import fi.natroutter.fenpos.device.Device;
import fi.natroutter.fenpos.device.DeviceRegistry;
import fi.natroutter.fenpos.markup.ImageResolver;
import fi.natroutter.fenpos.markup.model.Directive;

import java.util.Optional;

/**
 * Every image this agent can print: the ones the server synced, and the one it was built with.
 *
 * <p>One object rather than two because the compile path takes one {@link ImageResolver}, and
 * because {@code TestPage} has to ask exactly what the compile will ask. When the page's presence
 * check and the compile that follows it consult different resolvers, the page can write a tag that
 * then fails to resolve — a diagnostic that refuses to print, for a reason having nothing to do
 * with the printer.
 *
 * <p><b>Precedence: bundled first, synced second.</b> The two sets cannot actually overlap —
 * {@link BundledImages#NAME} is not a name an asset can be stored under, which
 * {@code BundledImagesTest} pins against the server's own pattern — so the order decides nothing
 * today. It is stated anyway, and in this direction, because the failure it forecloses is the
 * unpleasant one: something arriving over the link under the reserved name and silently replacing
 * the picture on the test page. The reverse ordering has no such argument for it. What the order
 * does <i>not</i> do is let the bundled logo stand in front of an operator's asset — it answers for
 * one name and refuses every other, so any other name falls straight through to the synced set.
 *
 * @see BundledImages
 * @see SyncedImages
 */
public final class PrintImages {

    private PrintImages() {
    }

    /**
     * Builds the resolver the compile path uses for one device.
     *
     * @param device   the device whose paper width decides how wide a percentage is
     * @param registry this agent's device set, which also holds the synced rasters
     * @return a resolver over both sets
     */
    public static ImageResolver forDevice(Device device, DeviceRegistry registry) {
        ImageResolver bundled = BundledImages.forDevice(device);
        ImageResolver synced = SyncedImages.forDevice(device, registry);
        return (name, widthPercent) -> {
            Optional<Directive.Image> own = bundled.resolve(name, widthPercent);
            return own.isPresent() ? own : synced.resolve(name, widthPercent);
        };
    }
}
