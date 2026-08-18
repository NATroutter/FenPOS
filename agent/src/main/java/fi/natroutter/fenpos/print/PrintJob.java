package fi.natroutter.fenpos.print;

import fi.natroutter.fenpos.enums.JobState;

import java.time.Clock;
import java.time.Instant;
import java.util.Objects;

/**
 * One accepted print job and everything known about it.
 * <p>
 * A job is created only after its content has been fully compiled, so it always carries a
 * ready-to-write payload. From that point the only thing that can change is its state.
 * <p>
 * <strong>Threading.</strong> A job is created on an HTTP thread, transitioned by its
 * device's queue worker, read by other HTTP threads polling {@code /jobs/<id>} and by the
 * console. Every transition is guarded by the job's own monitor and returns whether it was
 * applied, so two threads racing to cancel and to start printing cannot both win.
 */
public final class PrintJob {

    private final String id;
    private final String deviceName;
    private final byte[] payload;
    private final int lines;
    private final Instant queuedAt;
    private final Clock clock;
    private final JobListener listener;

    private JobState state = JobState.QUEUED;
    private Instant startedAt;
    private Instant finishedAt;
    private String failureReason;

    /**
     * @param id         short public identifier
     * @param deviceName the device this job prints on
     * @param compiled   the compiled payload
     * @param clock      time source; injected so tests need not sleep
     */
    public PrintJob(String id, String deviceName, CompiledJob compiled, Clock clock) {
        this(id, deviceName, compiled, clock, JobListener.NONE);
    }

    /**
     * @param id         short public identifier
     * @param deviceName the device this job prints on
     * @param compiled   the compiled payload
     * @param clock      time source; injected so tests need not sleep
     * @param listener   notified after every state change
     */
    public PrintJob(String id,
                    String deviceName,
                    CompiledJob compiled,
                    Clock clock,
                    JobListener listener) {
        this.id = Objects.requireNonNull(id, "id");
        this.deviceName = Objects.requireNonNull(deviceName, "deviceName");
        this.payload = Objects.requireNonNull(compiled, "compiled").payload();
        this.lines = compiled.lines();
        this.clock = Objects.requireNonNull(clock, "clock");
        this.listener = Objects.requireNonNull(listener, "listener");
        this.queuedAt = clock.instant();
    }

    /** Returns the short public identifier. */
    public String id() {
        return id;
    }

    /** Returns the name of the device this job prints on. */
    public String deviceName() {
        return deviceName;
    }

    /**
     * Returns the compiled ESC/POS payload.
     * <p>
     * Returned directly rather than copied: this is the hot path to the printer and the
     * array is never modified after compilation.
     */
    public byte[] payload() {
        return payload;
    }

    /** Returns the number of text lines after wrapping. */
    public int lines() {
        return lines;
    }

    /** Returns the payload size in bytes. */
    public int bytes() {
        return payload.length;
    }

    /** Returns when the job was accepted. */
    public Instant queuedAt() {
        return queuedAt;
    }

    /** Returns the current state. */
    public synchronized JobState state() {
        return state;
    }

    /** Returns when printing began, or {@code null} if it has not. */
    public synchronized Instant startedAt() {
        return startedAt;
    }

    /**
     * Returns when the job reached a terminal state, or {@code null} if it has not.
     * <p>
     * Set by {@link #complete()}, {@link #fail(String)} and {@link #cancel()} and by
     * nothing else, so a non-null value is equivalent to {@link #isTerminal()}. Retention
     * relies on that equivalence.
     */
    public synchronized Instant finishedAt() {
        return finishedAt;
    }

    /** Returns why the job failed, or {@code null} if it did not. */
    public synchronized String failureReason() {
        return failureReason;
    }

    /** Returns whether the job can still change state. */
    public synchronized boolean isTerminal() {
        return state.isTerminal();
    }

    // -------------------------------------------------------------------------
    // Transitions
    // -------------------------------------------------------------------------

    /**
     * Moves the job from {@code QUEUED} to {@code PRINTING}.
     *
     * @return {@code true} if the job was still queued and is now printing; {@code false}
     *         if it had already been cancelled, in which case it must not be printed
     */
    public boolean beginPrinting() {
        synchronized (this) {
            if (state != JobState.QUEUED) {
                return false;
            }
            state = JobState.PRINTING;
            startedAt = clock.instant();
        }
        announce(JobState.PRINTING);
        return true;
    }

    /** Records a successful print. */
    public void complete() {
        synchronized (this) {
            state = JobState.COMPLETED;
            finishedAt = clock.instant();
        }
        announce(JobState.COMPLETED);
    }

    /**
     * Records a failure.
     *
     * @param reason why it failed, surfaced in the job record
     */
    public void fail(String reason) {
        synchronized (this) {
            state = JobState.FAILED;
            failureReason = reason;
            finishedAt = clock.instant();
        }
        announce(JobState.FAILED);
    }

    /**
     * Withdraws a job that has not started.
     *
     * @return {@code true} if it was cancelled; {@code false} if it was already printing or
     *         finished, which the caller should report as a conflict rather than a success
     */
    public boolean cancel() {
        synchronized (this) {
            if (state != JobState.QUEUED) {
                return false;
            }
            state = JobState.CANCELLED;
            finishedAt = clock.instant();
        }
        announce(JobState.CANCELLED);
        return true;
    }

    /**
     * Tells the listener the job reached a state.
     * <p>
     * Called with the monitor released, because a listener writes to a socket and holding the
     * job locked across that would block every status read behind the network. A listener that
     * throws is swallowed: the transition has already happened and there is nothing to undo, so
     * propagating would only take down the queue worker that reported it.
     */
    private void announce(JobState reached) {
        try {
            listener.onStateChange(this, reached);
        } catch (RuntimeException ignored) {
            // Reporting is best-effort; the server reconciles on reconnect.
        }
    }

    @Override
    public String toString() {
        return "PrintJob[" + id + " " + deviceName + " " + state() + "]";
    }
}
