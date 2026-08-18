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

    /** Built-in settings. The server owns the panel-configurable equivalents. */
    public static final JobSettings DEFAULTS =
            new JobSettings(Duration.ofMinutes(10), 500, Duration.ofSeconds(10));
}
