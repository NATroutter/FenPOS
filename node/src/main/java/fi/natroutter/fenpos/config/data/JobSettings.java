package fi.natroutter.fenpos.config.data;

import java.time.Duration;

/**
 * Fully resolved job retention and shutdown settings.
 *
 * @param retention      how long a finished job stays readable over HTTP before eviction
 * @param maxRecords     hard cap on retained records, evicting oldest finished jobs first;
 *                       bounds memory when a client polls faster than retention expires
 * @param shutdownGrace  how long shutdown waits for an in-flight print before failing it
 */
public record JobSettings(
        Duration retention,
        int maxRecords,
        Duration shutdownGrace) {

    /** Built-in settings, used when the {@code jobs} section is absent or incomplete. */
    public static final JobSettings DEFAULTS =
            new JobSettings(Duration.ofMinutes(10), 500, Duration.ofSeconds(10));
}
