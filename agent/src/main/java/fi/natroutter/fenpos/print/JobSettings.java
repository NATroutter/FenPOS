package fi.natroutter.fenpos.print;

import java.time.Duration;

/**
 * Job retention and shutdown settings.
 *
 * @param retention      how long a finished job stays readable before eviction
 * @param maxRecords     hard cap on retained records, evicting oldest finished jobs first;
 *                       bounds memory when jobs arrive faster than retention expires
 * @param shutdownGrace  how long shutdown waits for an in-flight print before failing it
 */
public record JobSettings(
        Duration retention,
        int maxRecords,
        Duration shutdownGrace) {

    /**
     * Settings used before the first {@code config.sync} arrives, and by an agent talking to a
     * server old enough not to send them.
     *
     * <p>These are deliberately smaller than the server's defaults. An agent that has not been told
     * what to keep should keep little: this is memory on a machine in a shop, and the server is the
     * one with a disk and an operator looking at it.
     */
    public static final JobSettings DEFAULTS =
            new JobSettings(Duration.ofMinutes(10), 500, Duration.ofSeconds(10));
}
