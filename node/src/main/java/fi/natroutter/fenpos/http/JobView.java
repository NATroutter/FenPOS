package fi.natroutter.fenpos.http;

import fi.natroutter.fenpos.print.PrintJob;

import java.time.Instant;

/**
 * The wire shape of a job record.
 * <p>
 * Kept separate from {@link PrintJob} so the API contract does not drift every time the
 * internal model changes, and so the compiled payload — which is large and of no use to a
 * client — is never serialised.
 *
 * @param id         the job identifier
 * @param device     the device it prints on
 * @param status     current state
 * @param queuedAt   when it was accepted
 * @param startedAt  when printing began, or {@code null}
 * @param finishedAt when it reached a terminal state, or {@code null}
 * @param lines      text lines after wrapping
 * @param bytes      size of the rendered payload
 * @param error      why it failed, or {@code null}
 */
public record JobView(
        String id,
        String device,
        String status,
        Instant queuedAt,
        Instant startedAt,
        Instant finishedAt,
        int lines,
        int bytes,
        String error) {

    /**
     * Builds a view of a job.
     *
     * @param job the job to describe
     */
    public static JobView of(PrintJob job) {
        return new JobView(
                job.id(),
                job.deviceName(),
                job.state().name(),
                job.queuedAt(),
                job.startedAt(),
                job.finishedAt(),
                job.lines(),
                job.bytes(),
                job.failureReason());
    }
}
