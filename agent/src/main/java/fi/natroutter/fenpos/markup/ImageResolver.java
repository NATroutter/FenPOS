package fi.natroutter.fenpos.markup;

import fi.natroutter.fenpos.markup.model.Directive;

import java.util.Optional;

/**
 * Finds the dots for an image an {@code <image>} tag names.
 *
 * <p>The parser needs this because {@link Directive.Image} carries a rectangle of dots rather than
 * a reference: there is no image decoder on this side and deliberately none, so the only pictures
 * that can be printed are the ones the server already dithered and synced with the device
 * configuration. Resolution therefore happens while parsing, and an image that was never synced is
 * a markup error at the tag's own column rather than a failure behind a printer.
 *
 * <p>Taken as an interface rather than a {@code DeviceRegistry} so the parser keeps knowing nothing
 * about devices, and so its tests can supply a raster without one. The width is a percentage rather
 * than dots for the same reason — turning a share of the paper into dots needs the device's column
 * count, which is the implementation's business.
 *
 * @see fi.natroutter.fenpos.print.SyncedImages
 */
@FunctionalInterface
public interface ImageResolver {

    /**
     * A resolver holding nothing, for parses with no device in hand.
     *
     * <p>Refusing every name rather than throwing: an element naming an image still gets the
     * ordinary "this agent has no image called …" refusal, with a column, instead of an
     * unhandled fault.
     */
    ImageResolver NONE = (name, widthPercent) -> Optional.empty();

    /**
     * Finds a synced image.
     *
     * @param name         the image's name, exactly as written between the tags
     * @param widthPercent the share of the paper's width to print at, 1-100
     * @return the image as the renderer takes it, or empty when nothing was synced for that name
     *         at that printed width
     */
    Optional<Directive.Image> resolve(String name, int widthPercent);
}
