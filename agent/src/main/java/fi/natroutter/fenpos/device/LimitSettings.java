package fi.natroutter.fenpos.device;

/**
 * Bounds the agent enforces on one device's work.
 * <p>
 * The server enforces its own limits before compiling a job, but the agent does not take that
 * on trust: a compromised or simply buggy server must not be able to exhaust this process's
 * memory or monopolise a printer. Only {@link #maxQueueDepth()} is configurable from the
 * panel; the rest are fixed ceilings the agent applies to anything it composes or receives.
 *
 * @param maxLines        most elements allowed in a job
 * @param maxLineChars    most characters allowed in one element
 * @param maxTotalChars   most characters allowed across all elements combined
 * @param maxOutputLines  most text lines allowed after wrapping
 * @param maxQueueDepth   most jobs allowed to be pending for the device at once
 */
public record LimitSettings(
        int maxLines,
        int maxLineChars,
        int maxTotalChars,
        int maxOutputLines,
        int maxQueueDepth) {

    /** Built-in ceilings, applied to every device. */
    public static final LimitSettings DEFAULTS = new LimitSettings(200, 256, 16384, 300, 100);

    /**
     * Returns these limits with a different queue depth, which is the one value the panel sets.
     *
     * @param depth pending jobs beyond which dispatches are refused
     * @return the adjusted limits
     */
    public LimitSettings withMaxQueueDepth(int depth) {
        return new LimitSettings(maxLines, maxLineChars, maxTotalChars, maxOutputLines, depth);
    }
}
