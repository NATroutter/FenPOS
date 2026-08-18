package fi.natroutter.fenpos.enums;

/**
 * Severity of a log line forwarded to the server.
 * <p>
 * Mirrors {@code LogLevel} in {@code fenpos/lib/domain/enums.ts}. The two must not drift: a level
 * the agent sends and the server cannot parse costs the operator the line that was probably the
 * one worth reading.
 * <p>
 * Deliberately coarse. These four are what an operator filters by when a printer is misbehaving;
 * finer gradations would be a choice the agent has to make correctly at every call site, and it
 * would make the filter useless rather than more precise.
 */
public enum LogLevel {

    /** Detail useful while diagnosing, not while operating. */
    DEBUG,

    /** Something ordinary happened and someone might want to know it did. */
    INFO,

    /** Something went wrong but the agent carried on. */
    WARN,

    /** Something failed. A job did not print, or a device is unusable. */
    ERROR
}
