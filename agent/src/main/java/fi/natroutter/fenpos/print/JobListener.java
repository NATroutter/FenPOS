package fi.natroutter.fenpos.print;

import fi.natroutter.fenpos.enums.JobState;

/**
 * Notified whenever a job changes state.
 * <p>
 * Exists so reporting to the server is driven by the transition itself rather than by the code
 * that caused it. A job can be cancelled from the console, drained at shutdown, or failed by a
 * write error deep in the queue worker, and every one of those has to reach the panel. Hanging
 * the notification off the state change means none of those callers has to remember.
 * <p>
 * <strong>Threading.</strong> Called on whichever thread performed the transition — a queue
 * worker, the console, or the shutdown hook — and never while the job's monitor is held, so an
 * implementation may block. It must not throw; the job has already changed state and there is
 * nothing to roll back.
 */
@FunctionalInterface
public interface JobListener {

    /** A listener that does nothing, for a store whose jobs nobody is reporting on. */
    JobListener NONE = (job, state) -> {
    };

    /**
     * @param job   the job that changed
     * @param state the state it reached
     */
    void onStateChange(PrintJob job, JobState state);
}
