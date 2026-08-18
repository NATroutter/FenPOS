package fi.natroutter.fenpos.enums;

/**
 * Lifecycle of a print job.
 * <pre>
 * QUEUED ──▶ PRINTING ──▶ COMPLETED
 *   │            │
 *   │            └──────▶ FAILED
 *   └──────────────────▶ CANCELLED
 * </pre>
 * A job can only be cancelled before it starts. Once bytes are going down the wire the
 * paper is already moving, so there is nothing left to cancel.
 */
public enum JobState {

    /** Accepted and waiting for the device. */
    QUEUED,

    /** Currently being written to the device. */
    PRINTING,

    /** Written in full. */
    COMPLETED,

    /** Could not be written; the record carries the reason. */
    FAILED,

    /** Withdrawn before printing started. */
    CANCELLED;

    /** Returns whether this state can still change. */
    public boolean isTerminal() {
        return this == COMPLETED || this == FAILED || this == CANCELLED;
    }
}
