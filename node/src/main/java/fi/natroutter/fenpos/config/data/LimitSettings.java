package fi.natroutter.fenpos.config.data;

/**
 * Fully resolved request limits for one device.
 * <p>
 * Every limit exists to bound work a caller can cause: without them a single request could
 * consume unbounded memory, monopolise a printer, or exhaust a paper roll. Character counts
 * are measured on the raw JSON strings before markup parsing, so the number a client
 * computes matches the number enforced here.
 *
 * @param maxBodyBytes    largest accepted request body, in bytes
 * @param maxLines        most elements allowed in the {@code data} array
 * @param maxLineChars    most characters allowed in one {@code data} element
 * @param maxTotalChars   most characters allowed across all elements combined
 * @param maxOutputLines  most text lines allowed after wrapping
 * @param maxQueueDepth   most jobs allowed to be pending for the device at once
 */
public record LimitSettings(
        int maxBodyBytes,
        int maxLines,
        int maxLineChars,
        int maxTotalChars,
        int maxOutputLines,
        int maxQueueDepth) {

    /** Built-in limits, used when neither the device nor the global section sets a value. */
    public static final LimitSettings DEFAULTS = new LimitSettings(65536, 200, 256, 16384, 300, 100);
}
